// Redistribution & Imbalance Detection service (FR-43–FR-47, BR-08, BR-10, BR-13, BR-15, D-16, D-18, D-19).
// Acyclic imports: core/*, types/*, and hubs/hubs.metrics.ts ONLY (never reservations, charging, incidents, or monitoring).

import type {
  Prisma,
  RedistributionTask as PrismaRedistributionTask,
} from '@prisma/client';
import { audit } from '../../core/audit';
import { config } from '../../core/config';
import { db, lockRow, type DbClient, type Tx } from '../../core/db';
import { badRequest, conflict, notFound } from '../../core/errors';
import { events } from '../../core/events';
import { encodeCursor, type ListCursor } from '../../core/pagination';
import { assertTransition } from '../../core/stateMachine';
import type {
  RedistributionOrigin,
  RedistributionStatus,
  RentalVehicleType,
  Role,
  VehicleClass,
} from '../../types/enums';
import type {
  Imbalance,
  ImbalanceState,
  RedistributionPreview,
  RedistributionTask,
  RedistributionTaskList,
} from '../../types/redistribution';
import { isDegraded, roundTo1 } from '../hubs/hubs.metrics';

export const MAX_REASON_LENGTH = 1000;

export interface RedistributionActor {
  id: string;
  role: Role;
}

export interface PreviewRedistributionQuery {
  sourceHubId: string;
  destHubId: string;
  vehicleClass: VehicleClass;
  vehicleType?: RentalVehicleType;
  count: number;
}

export interface CreateRedistributionInput extends PreviewRedistributionQuery {
  override?: boolean;
  reason?: string;
}

export interface CreateRedistributionOptions {
  tx?: Tx;
  origin?: RedistributionOrigin;
  recommendationId?: string | null;
  now?: Date;
}

export interface ListRedistributionFilters {
  status?: RedistributionStatus;
}

export interface ListPageOptions {
  limit: number;
  cursor: ListCursor | null;
}

interface DestFleetCapacity {
  usable: number;
  free: number;
  used: number;
  rawPredicted: number;
  predictedDestOccupancyPct: number;
}

function toTaskDto(
  row: PrismaRedistributionTask & { vehicles?: Array<{ rentalVehicleId: string }> },
): RedistributionTask {
  const vehicleIds = (row.vehicles ?? [])
    .map((v) => v.rentalVehicleId)
    .sort((a, b) => a.localeCompare(b));

  return {
    id: row.id,
    status: row.status,
    sourceHubId: row.sourceHubId,
    destHubId: row.destHubId,
    vehicleClass: row.vehicleClass,
    vehicleType: row.vehicleType ?? null,
    count: row.count,
    override: row.override,
    reason: row.reason ?? null,
    origin: row.origin,
    recommendationId: row.recommendationId ?? null,
    vehicleIds,
    createdById: row.createdById,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function validateReason(
  raw: string | undefined,
  required: boolean,
): string | null {
  if (raw === undefined) {
    if (required) {
      throw badRequest('reason is required.', 'reason');
    }
    return null;
  }
  const trimmed = raw.trim();
  if (required && trimmed.length === 0) {
    throw badRequest('reason must not be empty.', 'reason');
  }
  if (trimmed.length > MAX_REASON_LENGTH) {
    throw badRequest(`reason must be at most ${MAX_REASON_LENGTH} characters.`, 'reason');
  }
  return trimmed.length > 0 ? trimmed : null;
}

async function validateHubPair(
  client: DbClient,
  sourceHubId: string,
  destHubId: string,
): Promise<void> {
  if (sourceHubId === destHubId) {
    throw badRequest('destHubId must differ from sourceHubId.', 'destHubId');
  }
  const hubs = await client.hub.findMany({
    where: { id: { in: [sourceHubId, destHubId] } },
    select: { id: true },
  });
  const found = new Set(hubs.map((h) => h.id));
  if (!found.has(sourceHubId)) {
    throw badRequest(`Unknown source Hub "${sourceHubId}".`, 'sourceHubId');
  }
  if (!found.has(destHubId)) {
    throw badRequest(`Unknown destination Hub "${destHubId}".`, 'destHubId');
  }
}

/**
 * FR-45, BR-08, D-18: Count eligible AVAILABLE rental vehicles at sourceHubId
 * (battery >= MIN_RENTAL_BATTERY_PCT, unreserved, not currently CHARGING/SCHEDULED).
 * Uses read-only Prisma queries so redistribution never imports reservations or charging.
 */
async function countEligibleSourceVehicles(
  client: DbClient,
  params: {
    sourceHubId: string;
    vehicleClass: VehicleClass;
    vehicleType?: RentalVehicleType;
  },
): Promise<number> {
  return client.rentalVehicle.count({
    where: {
      hubId: params.sourceHubId,
      vehicleClass: params.vehicleClass,
      status: 'AVAILABLE',
      batteryPct: { gte: config.MIN_RENTAL_BATTERY_PCT },
      ...(params.vehicleType ? { type: params.vehicleType } : {}),
      vehicleReservations: {
        none: { status: { in: ['CONFIRMED', 'ACTIVE'] } },
      },
      chargingRequests: {
        none: { status: { in: ['CHARGING', 'SCHEDULED'] } },
      },
    },
  });
}

/**
 * FR-46, BR-08, D-16: Compute destination FLEET parking capacity for a vehicle class.
 */
async function computeDestFleetCapacity(
  client: DbClient,
  destHubId: string,
  vehicleClass: VehicleClass,
  count: number,
): Promise<DestFleetCapacity> {
  const spaces = await client.parkingSpace.findMany({
    where: {
      hubId: destHubId,
      vehicleClass,
      pool: 'FLEET',
      status: { not: 'UNAVAILABLE' },
    },
    select: { status: true },
  });

  const usable = spaces.length;
  let free = 0;
  let used = 0;
  for (const s of spaces) {
    if (s.status === 'FREE') free++;
    else if (s.status === 'OCCUPIED' || s.status === 'RESERVED') used++;
  }

  const rawPredicted = usable === 0 ? 100 : ((used + count) / usable) * 100;
  return {
    usable,
    free,
    used,
    rawPredicted,
    predictedDestOccupancyPct: roundTo1(rawPredicted),
  };
}

/**
 * FR-43, BR-15, UC-24: Evaluate vehicle imbalance for a single Hub.
 * Returns [] if the Hub does not exist or is DEGRADED (UC-24 E1).
 */
export async function detectImbalance(
  hubId: string,
  now: Date = new Date(),
  client: DbClient = db,
): Promise<Imbalance[]> {
  const hub = await client.hub.findUnique({
    where: { id: hubId },
    select: { id: true, lastTelemetryAt: true },
  });
  if (!hub) return [];

  if (
    isDegraded(
      hub.lastTelemetryAt,
      now,
      config.STALLED_FEED_INTERVALS,
      config.TELEMETRY_INTERVAL_SEC,
    )
  ) {
    return [];
  }

  const thresholds = await client.hubThreshold.findMany({
    where: { hubId },
    orderBy: { vehicleClass: 'asc' },
  });

  const thresholdMap = new Map<VehicleClass, { min: number; max: number }>();
  for (const t of thresholds) {
    thresholdMap.set(t.vehicleClass, { min: t.minAvailable, max: t.maxAvailable });
  }
  // Ensure MOTORCYCLE is always evaluated (fallback to SPEC §3 defaults).
  if (!thresholdMap.has('MOTORCYCLE')) {
    thresholdMap.set('MOTORCYCLE', {
      min: config.IMBALANCE_MIN_DEFAULT,
      max: config.IMBALANCE_MAX_DEFAULT,
    });
  }

  const classes = Array.from(thresholdMap.keys()).sort((a, b) => a.localeCompare(b));
  const results: Imbalance[] = [];

  for (const vc of classes) {
    const bounds = thresholdMap.get(vc)!;
    // Matches hubs.listHubs and D-18: AVAILABLE, battery >= MIN_RENTAL_BATTERY_PCT, not CHARGING.
    const available = await client.rentalVehicle.count({
      where: {
        hubId,
        vehicleClass: vc,
        status: 'AVAILABLE',
        batteryPct: { gte: config.MIN_RENTAL_BATTERY_PCT },
        chargingRequests: {
          none: { status: 'CHARGING' },
        },
      },
    });

    let state: ImbalanceState = 'OK';
    let amount = 0;
    if (available < bounds.min) {
      state = 'SHORTAGE';
      amount = bounds.min - available;
    } else if (available > bounds.max) {
      state = 'SURPLUS';
      amount = available - bounds.max;
    }

    results.push({
      hubId,
      vehicleClass: vc,
      available,
      min: bounds.min,
      max: bounds.max,
      state,
      amount,
    });
  }

  return results;
}

/**
 * FR-43, CONTRACTS §12: List imbalances across all non-degraded Hubs ordered by hubId ASC, vehicleClass ASC.
 */
export async function listImbalances(
  now: Date = new Date(),
  client: DbClient = db,
): Promise<Imbalance[]> {
  const hubs = await client.hub.findMany({
    orderBy: { id: 'asc' },
    select: { id: true },
  });

  const all: Imbalance[] = [];
  for (const hub of hubs) {
    const items = await detectImbalance(hub.id, now, client);
    all.push(...items);
  }
  return all;
}

/**
 * FR-45, FR-46, BR-08, CONTRACTS §12: Preview eligibility and destination FLEET capacity.
 */
export async function previewRedistribution(
  query: PreviewRedistributionQuery,
  _now: Date = new Date(),
  client: DbClient = db,
): Promise<RedistributionPreview> {
  await validateHubPair(client, query.sourceHubId, query.destHubId);

  const [eligibleAtSource, cap] = await Promise.all([
    countEligibleSourceVehicles(client, {
      sourceHubId: query.sourceHubId,
      vehicleClass: query.vehicleClass,
      vehicleType: query.vehicleType,
    }),
    computeDestFleetCapacity(client, query.destHubId, query.vehicleClass, query.count),
  ]);

  const problems: string[] = [];
  if (eligibleAtSource < query.count) {
    problems.push(
      `Only ${eligibleAtSource} eligible vehicle(s) available at source Hub "${query.sourceHubId}" (requested ${query.count}).`,
    );
  }
  if (query.count > cap.free) {
    problems.push(
      `Requested count (${query.count}) exceeds free destination FLEET spaces (${cap.free}) at Hub "${query.destHubId}".`,
    );
  } else if (cap.rawPredicted > config.REDISTRIBUTION_DEST_LIMIT_PCT) {
    problems.push(
      `Predicted destination FLEET occupancy (${cap.predictedDestOccupancyPct}%) exceeds the ${config.REDISTRIBUTION_DEST_LIMIT_PCT}% limit; override with reason required.`,
    );
  }

  const enoughVehicles = eligibleAtSource >= query.count;
  const fitsPhysically = query.count <= cap.free;
  const withinLimit = cap.rawPredicted <= config.REDISTRIBUTION_DEST_LIMIT_PCT;

  return {
    eligibleAtSource,
    destFreeFleetSpaces: cap.free,
    predictedDestOccupancyPct: cap.predictedDestOccupancyPct,
    ok: enoughVehicles && fitsPhysically && withinLimit,
    needsOverride: enoughVehicles && fitsPhysically && !withinLimit,
    problems,
  };
}

/**
 * FR-44, FR-45, FR-46, BR-08, D-19: Create a PROPOSED redistribution task.
 * Checks counts only (holds no vehicles or spaces until start). Supports caller `tx` for T-29 Simulation apply.
 */
export async function createRedistributionTask(
  actor: RedistributionActor,
  input: CreateRedistributionInput,
  opts: CreateRedistributionOptions = {},
): Promise<RedistributionTask> {
  const override = input.override ?? false;
  const reason = validateReason(input.reason, override);
  const origin: RedistributionOrigin = opts.origin ?? 'MANUAL';
  const recommendationId = opts.recommendationId ?? null;
  const now = opts.now ?? new Date();

  const run = async (tx: Tx): Promise<RedistributionTask> => {
    await validateHubPair(tx, input.sourceHubId, input.destHubId);

    const [eligibleAtSource, cap] = await Promise.all([
      countEligibleSourceVehicles(tx, {
        sourceHubId: input.sourceHubId,
        vehicleClass: input.vehicleClass,
        vehicleType: input.vehicleType,
      }),
      computeDestFleetCapacity(tx, input.destHubId, input.vehicleClass, input.count),
    ]);

    if (eligibleAtSource < input.count) {
      throw conflict(
        'NOT_ELIGIBLE',
        `Only ${eligibleAtSource} eligible vehicle(s) available at Hub "${input.sourceHubId}" (requested ${input.count}).`,
        {
          nextActions: ['Reduce the count or choose another source Hub.'],
          details: { eligibleAtSource, requested: input.count },
        },
      );
    }

    // BR-08 / Conflict 2: never exceed 100% physical free FLEET spaces, even with override.
    if (input.count > cap.free) {
      throw conflict(
        'CAPACITY_EXCEEDED',
        `Destination Hub "${input.destHubId}" only has ${cap.free} free FLEET ${input.vehicleClass} space(s) (requested ${input.count}).`,
        {
          nextActions: ['Reduce the count or choose another destination Hub.'],
          details: {
            destFreeFleetSpaces: cap.free,
            requested: input.count,
            predictedDestOccupancyPct: cap.predictedDestOccupancyPct,
            canOverride: false,
          },
        },
      );
    }

    if (cap.rawPredicted > config.REDISTRIBUTION_DEST_LIMIT_PCT && !override) {
      throw conflict(
        'CAPACITY_EXCEEDED',
        `Predicted destination FLEET occupancy (${cap.predictedDestOccupancyPct}%) exceeds ${config.REDISTRIBUTION_DEST_LIMIT_PCT}%.`,
        {
          nextActions: [
            'Reduce the count, or resubmit with override: true and a reason (BR-08).',
          ],
          details: {
            predictedDestOccupancyPct: cap.predictedDestOccupancyPct,
            limitPct: config.REDISTRIBUTION_DEST_LIMIT_PCT,
            canOverride: true,
          },
        },
      );
    }

    const created = await tx.redistributionTask.create({
      data: {
        sourceHubId: input.sourceHubId,
        destHubId: input.destHubId,
        vehicleClass: input.vehicleClass,
        vehicleType: input.vehicleType ?? null,
        count: input.count,
        status: 'PROPOSED',
        override,
        reason,
        origin,
        recommendationId,
        createdById: actor.id,
        createdAt: now,
      },
      include: { vehicles: { select: { rentalVehicleId: true } } },
    });

    await audit(tx, {
      actorId: actor.id,
      actorRole: actor.role,
      action: 'REDISTRIBUTION_CREATED',
      entityType: 'redistribution_task',
      entityIds: [created.id],
      reason: reason ?? undefined,
      details: {
        sourceHubId: created.sourceHubId,
        destHubId: created.destHubId,
        vehicleClass: created.vehicleClass,
        vehicleType: created.vehicleType,
        count: created.count,
        override: created.override,
        origin: created.origin,
      },
    });

    return toTaskDto(created);
  };

  if (opts.tx) {
    return run(opts.tx);
  }
  return db.$transaction(run);
}

/**
 * FR-47, CONTRACTS §12: List redistribution tasks with optional status filter and cursor pagination.
 */
export async function listRedistributionTasks(
  filters: ListRedistributionFilters,
  page: ListPageOptions,
): Promise<RedistributionTaskList> {
  const where: Prisma.RedistributionTaskWhereInput = {
    ...(filters.status ? { status: filters.status } : {}),
    ...(page.cursor
      ? {
          OR: [
            { createdAt: { lt: page.cursor.createdAt } },
            { createdAt: page.cursor.createdAt, id: { lt: page.cursor.id } },
          ],
        }
      : {}),
  };

  const rows = await db.redistributionTask.findMany({
    where,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: page.limit + 1,
    include: { vehicles: { select: { rentalVehicleId: true } } },
  });

  const hasMore = rows.length > page.limit;
  const pageRows = hasMore ? rows.slice(0, page.limit) : rows;
  const lastRow = pageRows[pageRows.length - 1];
  const nextCursor = hasMore && lastRow ? encodeCursor(lastRow) : null;

  return {
    items: pageRows.map(toTaskDto),
    nextCursor,
  };
}

/**
 * FR-47, CONTRACTS §12: Get a single redistribution task by ID (404 if missing).
 */
export async function getRedistributionTask(id: string): Promise<RedistributionTask> {
  const row = await db.redistributionTask.findUnique({
    where: { id },
    include: { vehicles: { select: { rentalVehicleId: true } } },
  });
  if (!row) {
    throw notFound('Redistribution task');
  }
  return toTaskDto(row);
}

/**
 * FR-47, D-19: Approve a PROPOSED redistribution task (holds zero resources until start).
 */
export async function approveRedistributionTask(
  actor: RedistributionActor,
  id: string,
  now: Date = new Date(),
): Promise<RedistributionTask> {
  return db.$transaction(async (tx) => {
    await lockRow(tx, 'redistribution_task', id);
    const task = await tx.redistributionTask.findUniqueOrThrow({
      where: { id },
      include: { vehicles: { select: { rentalVehicleId: true } } },
    });

    assertTransition('redistributionTask', task.status, 'APPROVED');

    const updated = await tx.redistributionTask.update({
      where: { id: task.id },
      data: { status: 'APPROVED', approvedAt: now },
      include: { vehicles: { select: { rentalVehicleId: true } } },
    });

    await audit(tx, {
      actorId: actor.id,
      actorRole: actor.role,
      action: 'REDISTRIBUTION_APPROVED',
      entityType: 'redistribution_task',
      entityIds: [task.id],
      details: {
        sourceHubId: task.sourceHubId,
        destHubId: task.destHubId,
        count: task.count,
      },
    });

    return toTaskDto(updated);
  });
}

/**
 * FR-45, FR-46, FR-47, BR-08, BR-10, D-19: Start an APPROVED redistribution task.
 *
 * Total lock order (deadlock-free against telemetry ingestion, vehicleReservations, and competing tasks):
 *   1. redistribution_task (id)
 *   2. hub (destHubId) — serializes destination FLEET 85%/100% capacity checks across competing starts
 *   3. source rental_vehicle rows (ORDER BY id ASC FOR UPDATE OF rv SKIP LOCKED)
 *   4. source parking_space rows (asc id)
 *   5. dest FLEET parking_space rows (ORDER BY id ASC FOR UPDATE OF ps SKIP LOCKED)
 */
export async function startRedistributionTask(
  actor: RedistributionActor,
  id: string,
  now: Date = new Date(),
): Promise<RedistributionTask> {
  const result = await db.$transaction(async (tx) => {
    // 1. Lock task & verify APPROVED -> IN_PROGRESS
    await lockRow(tx, 'redistribution_task', id);
    const task = await tx.redistributionTask.findUniqueOrThrow({ where: { id } });
    assertTransition('redistributionTask', task.status, 'IN_PROGRESS');

    // 2. Lock destination Hub to serialize destination FLEET occupancy checks across competing starts
    await lockRow(tx, 'hub', task.destHubId);

    // 3. Pick & lock eligible source vehicles (branch query when vehicleType is null to avoid untyped null casts)
    const pickedVehicles =
      task.vehicleType !== null
        ? await tx.$queryRaw<Array<{ id: string; parkingSpaceId: string | null }>>`
            SELECT rv.id, rv."parkingSpaceId"
            FROM rental_vehicle rv
            WHERE rv."hubId" = ${task.sourceHubId}
              AND rv."vehicleClass" = ${task.vehicleClass}::"VehicleClass"
              AND rv.status = 'AVAILABLE'::"RentalVehicleStatus"
              AND rv."batteryPct" >= ${config.MIN_RENTAL_BATTERY_PCT}
              AND rv.type = ${task.vehicleType}::"RentalVehicleType"
              AND NOT EXISTS (
                SELECT 1 FROM vehicle_reservation vr
                WHERE vr."rentalVehicleId" = rv.id
                  AND vr.status IN ('CONFIRMED'::"ReservationStatus", 'ACTIVE'::"ReservationStatus")
              )
              AND NOT EXISTS (
                SELECT 1 FROM charging_request cr
                WHERE cr."rentalVehicleId" = rv.id
                  AND cr.status IN ('CHARGING'::"ChargingRequestStatus", 'SCHEDULED'::"ChargingRequestStatus")
              )
            ORDER BY rv.id ASC
            LIMIT ${task.count}
            FOR UPDATE OF rv SKIP LOCKED
          `
        : await tx.$queryRaw<Array<{ id: string; parkingSpaceId: string | null }>>`
            SELECT rv.id, rv."parkingSpaceId"
            FROM rental_vehicle rv
            WHERE rv."hubId" = ${task.sourceHubId}
              AND rv."vehicleClass" = ${task.vehicleClass}::"VehicleClass"
              AND rv.status = 'AVAILABLE'::"RentalVehicleStatus"
              AND rv."batteryPct" >= ${config.MIN_RENTAL_BATTERY_PCT}
              AND NOT EXISTS (
                SELECT 1 FROM vehicle_reservation vr
                WHERE vr."rentalVehicleId" = rv.id
                  AND vr.status IN ('CONFIRMED'::"ReservationStatus", 'ACTIVE'::"ReservationStatus")
              )
              AND NOT EXISTS (
                SELECT 1 FROM charging_request cr
                WHERE cr."rentalVehicleId" = rv.id
                  AND cr.status IN ('CHARGING'::"ChargingRequestStatus", 'SCHEDULED'::"ChargingRequestStatus")
              )
            ORDER BY rv.id ASC
            LIMIT ${task.count}
            FOR UPDATE OF rv SKIP LOCKED
          `;

    if (pickedVehicles.length < task.count) {
      throw conflict(
        'NOT_ELIGIBLE',
        `Only ${pickedVehicles.length} eligible vehicle(s) available to lock at Hub "${task.sourceHubId}" (requested ${task.count}).`,
        {
          nextActions: ['Wait for vehicles to become available or cancel this task.'],
          details: { eligibleLocked: pickedVehicles.length, requested: task.count },
        },
      );
    }

    // 4. Lock non-null source parking spaces in ascending id order
    const sourceSpaceIds = Array.from(
      new Set(
        pickedVehicles
          .map((v) => v.parkingSpaceId)
          .filter((sid): sid is string => sid !== null),
      ),
    ).sort((a, b) => a.localeCompare(b));

    for (const spaceId of sourceSpaceIds) {
      await lockRow(tx, 'parking_space', spaceId);
    }

    // 5. Recompute destination FLEET capacity & pick free dest FLEET spaces
    const cap = await computeDestFleetCapacity(tx, task.destHubId, task.vehicleClass, task.count);

    const pickedDestSpaces = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT ps.id
      FROM parking_space ps
      WHERE ps."hubId" = ${task.destHubId}
        AND ps."vehicleClass" = ${task.vehicleClass}::"VehicleClass"
        AND ps.pool = 'FLEET'::"ParkingPool"
        AND ps.status = 'FREE'::"ParkingSpaceStatus"
      ORDER BY ps.id ASC
      LIMIT ${task.count}
      FOR UPDATE OF ps SKIP LOCKED
    `;

    if (pickedDestSpaces.length < task.count) {
      throw conflict(
        'CAPACITY_EXCEEDED',
        `Destination Hub "${task.destHubId}" only has ${pickedDestSpaces.length} free FLEET ${task.vehicleClass} space(s) available to reserve (requested ${task.count}).`,
        {
          nextActions: ['Wait for destination FLEET spaces to free up or cancel this task.'],
          details: { freeLocked: pickedDestSpaces.length, requested: task.count },
        },
      );
    }

    if (!task.override && (cap.usable === 0 || cap.rawPredicted > config.REDISTRIBUTION_DEST_LIMIT_PCT)) {
      throw conflict(
        'CAPACITY_EXCEEDED',
        `Destination Hub "${task.destHubId}" predicted FLEET occupancy (${cap.predictedDestOccupancyPct}%) exceeds ${config.REDISTRIBUTION_DEST_LIMIT_PCT}%.`,
        {
          nextActions: ['Cancel this task or create a new task with override: true and a reason.'],
          details: {
            predictedDestOccupancyPct: cap.predictedDestOccupancyPct,
            limitPct: config.REDISTRIBUTION_DEST_LIMIT_PCT,
            canOverride: true,
          },
        },
      );
    }

    // 6. Apply writes
    const vehicleIds = pickedVehicles.map((v) => v.id);
    const destSpaceIds = pickedDestSpaces.map((s) => s.id);

    for (const v of pickedVehicles) {
      assertTransition('rentalVehicle', 'AVAILABLE', 'IN_TRANSIT');
      await tx.rentalVehicle.update({
        where: { id: v.id },
        data: { status: 'IN_TRANSIT', parkingSpaceId: null },
      });
    }

    if (sourceSpaceIds.length > 0) {
      const sourceSpaces = await tx.parkingSpace.findMany({
        where: { id: { in: sourceSpaceIds } },
        select: { id: true, status: true },
      });
      for (const s of sourceSpaces) {
        if (s.status === 'OCCUPIED') {
          assertTransition('parkingSpace', s.status, 'FREE');
          await tx.parkingSpace.update({
            where: { id: s.id },
            data: { status: 'FREE' },
          });
        }
      }
    }

    await tx.redistributionTaskVehicle.createMany({
      data: vehicleIds.map((rentalVehicleId) => ({
        taskId: task.id,
        rentalVehicleId,
      })),
    });

    for (const spaceId of destSpaceIds) {
      assertTransition('parkingSpace', 'FREE', 'RESERVED');
      await tx.parkingSpace.update({
        where: { id: spaceId },
        data: { status: 'RESERVED', reservedForTaskId: task.id },
      });
    }

    const updated = await tx.redistributionTask.update({
      where: { id: task.id },
      data: { status: 'IN_PROGRESS', startedAt: now },
      include: { vehicles: { select: { rentalVehicleId: true } } },
    });

    await audit(tx, {
      actorId: actor.id,
      actorRole: actor.role,
      action: 'REDISTRIBUTION_STARTED',
      entityType: 'redistribution_task',
      entityIds: [task.id, ...vehicleIds],
      details: {
        sourceHubId: task.sourceHubId,
        destHubId: task.destHubId,
        count: task.count,
        destSpaceIds,
      },
    });

    return toTaskDto(updated);
  });

  // Post-commit events (ARCHITECTURE §4.6)
  events.emit('RESERVATION_CHANGED', { hubId: result.sourceHubId });
  events.emit('RESERVATION_CHANGED', { hubId: result.destHubId });

  return result;
}

/**
 * FR-47: Complete an IN_PROGRESS redistribution task.
 * Moves IN_TRANSIT vehicles to AVAILABLE at destHubId, parking each in a reserved (or replacement FREE) FLEET space.
 */
export async function completeRedistributionTask(
  actor: RedistributionActor,
  id: string,
  now: Date = new Date(),
): Promise<RedistributionTask> {
  const result = await db.$transaction(async (tx) => {
    await lockRow(tx, 'redistribution_task', id);
    const task = await tx.redistributionTask.findUniqueOrThrow({
      where: { id },
      include: { vehicles: { select: { rentalVehicleId: true } } },
    });

    assertTransition('redistributionTask', task.status, 'COMPLETED');

    const linkedVehicleIds = task.vehicles
      .map((v) => v.rentalVehicleId)
      .sort((a, b) => a.localeCompare(b));

    for (const vid of linkedVehicleIds) {
      await lockRow(tx, 'rental_vehicle', vid);
    }

    const reservedSpaces = await tx.parkingSpace.findMany({
      where: { reservedForTaskId: task.id },
      orderBy: { id: 'asc' },
      select: { id: true },
    });
    for (const sp of reservedSpaces) {
      await lockRow(tx, 'parking_space', sp.id);
    }

    const vehicles = await tx.rentalVehicle.findMany({
      where: { id: { in: linkedVehicleIds } },
      orderBy: { id: 'asc' },
      select: { id: true, status: true },
    });
    const currentReservedSpaces = await tx.parkingSpace.findMany({
      where: { reservedForTaskId: task.id },
      orderBy: { id: 'asc' },
      select: { id: true, status: true },
    });

    // Separate usable reserved spaces from any that became UNAVAILABLE via an incident mid-transit
    const usableReserved: Array<{ id: string; status: 'RESERVED' | 'FREE' }> = [];
    for (const sp of currentReservedSpaces) {
      if (sp.status === 'RESERVED' || sp.status === 'FREE') {
        usableReserved.push({ id: sp.id, status: sp.status });
      } else {
        // Space became UNAVAILABLE mid-transit: detach reservation link
        await tx.parkingSpace.update({
          where: { id: sp.id },
          data: { reservedForTaskId: null },
        });
      }
    }

    let spaceIdx = 0;
    const parkedSpaceIds: string[] = [];

    for (const v of vehicles) {
      if (v.status !== 'IN_TRANSIT') {
        // Vehicle became FAULTY (or otherwise changed) mid-transit: skip moving it
        continue;
      }

      let targetSpace: { id: string; status: 'RESERVED' | 'FREE' } | undefined =
        usableReserved[spaceIdx];
      if (targetSpace) {
        spaceIdx++;
      } else {
        // Replacement FREE FLEET space if a reserved space became UNAVAILABLE mid-transit
        const replacement = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT ps.id
          FROM parking_space ps
          WHERE ps."hubId" = ${task.destHubId}
            AND ps."vehicleClass" = ${task.vehicleClass}::"VehicleClass"
            AND ps.pool = 'FLEET'::"ParkingPool"
            AND ps.status = 'FREE'::"ParkingSpaceStatus"
          ORDER BY ps.id ASC
          LIMIT 1
          FOR UPDATE OF ps SKIP LOCKED
        `;
        if (replacement.length === 0) {
          throw conflict(
            'CAPACITY_EXCEEDED',
            `No free replacement FLEET space available at destination Hub "${task.destHubId}" to complete redistribution.`,
            {
              nextActions: ['Resolve space incidents at the destination Hub or fail this task.'],
              details: { destHubId: task.destHubId, vehicleId: v.id },
            },
          );
        }
        targetSpace = { id: replacement[0]!.id, status: 'FREE' };
      }

      assertTransition('parkingSpace', targetSpace.status, 'OCCUPIED');
      await tx.parkingSpace.update({
        where: { id: targetSpace.id },
        data: { status: 'OCCUPIED', reservedForTaskId: null },
      });

      assertTransition('rentalVehicle', 'IN_TRANSIT', 'AVAILABLE');
      await tx.rentalVehicle.update({
        where: { id: v.id },
        data: {
          status: 'AVAILABLE',
          hubId: task.destHubId,
          parkingSpaceId: targetSpace.id,
        },
      });
      parkedSpaceIds.push(targetSpace.id);
    }

    // Release any leftover reserved spaces (e.g. if a vehicle became FAULTY mid-transit)
    while (spaceIdx < usableReserved.length) {
      const leftover = usableReserved[spaceIdx++]!;
      if (leftover.status === 'RESERVED') {
        assertTransition('parkingSpace', 'RESERVED', 'FREE');
      }
      await tx.parkingSpace.update({
        where: { id: leftover.id },
        data: { status: 'FREE', reservedForTaskId: null },
      });
    }

    const updated = await tx.redistributionTask.update({
      where: { id: task.id },
      data: { status: 'COMPLETED', completedAt: now },
      include: { vehicles: { select: { rentalVehicleId: true } } },
    });

    await audit(tx, {
      actorId: actor.id,
      actorRole: actor.role,
      action: 'REDISTRIBUTION_COMPLETED',
      entityType: 'redistribution_task',
      entityIds: [task.id, ...linkedVehicleIds],
      details: {
        sourceHubId: task.sourceHubId,
        destHubId: task.destHubId,
        parkedSpaceIds,
      },
    });

    return toTaskDto(updated);
  });

  events.emit('RESERVATION_CHANGED', { hubId: result.sourceHubId });
  events.emit('RESERVATION_CHANGED', { hubId: result.destHubId });

  return result;
}

/**
 * FR-47: Fail an IN_PROGRESS redistribution task (requires reason).
 * Releases destination reserved spaces and returns IN_TRANSIT vehicles to sourceHubId.
 */
export async function failRedistributionTask(
  actor: RedistributionActor,
  id: string,
  rawReason: string | undefined,
  now: Date = new Date(),
): Promise<RedistributionTask> {
  const reason = validateReason(rawReason, true)!;

  const result = await db.$transaction(async (tx) => {
    await lockRow(tx, 'redistribution_task', id);
    const task = await tx.redistributionTask.findUniqueOrThrow({
      where: { id },
      include: { vehicles: { select: { rentalVehicleId: true } } },
    });

    assertTransition('redistributionTask', task.status, 'FAILED');

    const linkedVehicleIds = task.vehicles
      .map((v) => v.rentalVehicleId)
      .sort((a, b) => a.localeCompare(b));

    for (const vid of linkedVehicleIds) {
      await lockRow(tx, 'rental_vehicle', vid);
    }

    const reservedSpaces = await tx.parkingSpace.findMany({
      where: { reservedForTaskId: task.id },
      orderBy: { id: 'asc' },
      select: { id: true },
    });
    for (const sp of reservedSpaces) {
      await lockRow(tx, 'parking_space', sp.id);
    }

    const currentReservedSpaces = await tx.parkingSpace.findMany({
      where: { reservedForTaskId: task.id },
      orderBy: { id: 'asc' },
      select: { id: true, status: true },
    });

    // Release every destination reserved space
    for (const sp of currentReservedSpaces) {
      if (sp.status === 'RESERVED') {
        assertTransition('parkingSpace', 'RESERVED', 'FREE');
        await tx.parkingSpace.update({
          where: { id: sp.id },
          data: { status: 'FREE', reservedForTaskId: null },
        });
      } else {
        await tx.parkingSpace.update({
          where: { id: sp.id },
          data: { reservedForTaskId: null },
        });
      }
    }

    const vehicles = await tx.rentalVehicle.findMany({
      where: { id: { in: linkedVehicleIds } },
      orderBy: { id: 'asc' },
      select: { id: true, status: true },
    });

    for (const v of vehicles) {
      if (v.status !== 'IN_TRANSIT') continue;

      // Try to park back in a FREE FLEET space at sourceHubId; fall back to parkingSpaceId: null if full
      const freeSource = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT ps.id
        FROM parking_space ps
        WHERE ps."hubId" = ${task.sourceHubId}
          AND ps."vehicleClass" = ${task.vehicleClass}::"VehicleClass"
          AND ps.pool = 'FLEET'::"ParkingPool"
          AND ps.status = 'FREE'::"ParkingSpaceStatus"
        ORDER BY ps.id ASC
        LIMIT 1
        FOR UPDATE OF ps SKIP LOCKED
      `;

      let sourceSpaceId: string | null = null;
      if (freeSource.length > 0) {
        sourceSpaceId = freeSource[0]!.id;
        assertTransition('parkingSpace', 'FREE', 'OCCUPIED');
        await tx.parkingSpace.update({
          where: { id: sourceSpaceId },
          data: { status: 'OCCUPIED' },
        });
      }

      assertTransition('rentalVehicle', 'IN_TRANSIT', 'AVAILABLE');
      await tx.rentalVehicle.update({
        where: { id: v.id },
        data: {
          status: 'AVAILABLE',
          hubId: task.sourceHubId,
          parkingSpaceId: sourceSpaceId,
        },
      });
    }

    const updated = await tx.redistributionTask.update({
      where: { id: task.id },
      data: { status: 'FAILED', failedAt: now, reason },
      include: { vehicles: { select: { rentalVehicleId: true } } },
    });

    await audit(tx, {
      actorId: actor.id,
      actorRole: actor.role,
      action: 'REDISTRIBUTION_FAILED',
      entityType: 'redistribution_task',
      entityIds: [task.id, ...linkedVehicleIds],
      reason,
      details: {
        sourceHubId: task.sourceHubId,
        destHubId: task.destHubId,
      },
    });

    return toTaskDto(updated);
  });

  events.emit('RESERVATION_CHANGED', { hubId: result.sourceHubId });
  events.emit('RESERVATION_CHANGED', { hubId: result.destHubId });

  return result;
}

/**
 * UC-25 A1: Cancel a PROPOSED or APPROVED redistribution task (requires reason).
 */
export async function cancelRedistributionTask(
  actor: RedistributionActor,
  id: string,
  rawReason: string | undefined,
  now: Date = new Date(),
): Promise<RedistributionTask> {
  const reason = validateReason(rawReason, true)!;

  return db.$transaction(async (tx) => {
    await lockRow(tx, 'redistribution_task', id);
    const task = await tx.redistributionTask.findUniqueOrThrow({
      where: { id },
      include: { vehicles: { select: { rentalVehicleId: true } } },
    });

    assertTransition('redistributionTask', task.status, 'CANCELLED');

    const updated = await tx.redistributionTask.update({
      where: { id: task.id },
      data: { status: 'CANCELLED', cancelledAt: now, reason },
      include: { vehicles: { select: { rentalVehicleId: true } } },
    });

    await audit(tx, {
      actorId: actor.id,
      actorRole: actor.role,
      action: 'REDISTRIBUTION_CANCELLED',
      entityType: 'redistribution_task',
      entityIds: [task.id],
      reason,
      details: {
        sourceHubId: task.sourceHubId,
        destHubId: task.destHubId,
      },
    });

    return toTaskDto(updated);
  });
}
