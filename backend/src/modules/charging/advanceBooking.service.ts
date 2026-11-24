// Advance charging booking service: availability check and slot booking
// (FR-21, BR-06, BR-10, BR-13, NFR-08, D-09, D-10, D-12, ARCHITECTURE §9.4).
// Lock order: private_ev (FOR SHARE) -> charging_point (FOR UPDATE SKIP LOCKED) -> charging_request.

import { Prisma } from '@prisma/client';
import { config } from '../../core/config';
import { db, type DbClient, type Tx } from '../../core/db';
import { badRequest, conflict, forbidden, notFound } from '../../core/errors';
import { events } from '../../core/events';
import { withIdempotency } from '../../core/idempotency';
import { toIso } from '../../core/time';
import type { ChargingAvailability, ChargingRequestView } from '../../types/charging';
import type { Alternative } from '../../types/common';
import type { VehicleClass } from '../../types/enums';
import { alternativeHubs } from '../hubs/hubs.service';
import { toRequestView } from './charging.service';
import type { ChargingActor } from './chargingRequests.service';
import { estimateDurationMs, type ScheduleConfig } from './schedule';

export interface ChargingAvailabilityQuery {
  hubId: string;
  privateEvId: string;
  slotStart: Date;
  targetPct: number;
}

export interface BookAdvanceSlotInput {
  privateEvId: string;
  hubId: string;
  slotStart: Date;
  targetPct: number;
}

export interface BookAdvanceSlotOptions {
  idemKey?: string;
  tx?: Tx;
  bookingGroupId?: string;
  now?: Date;
}

export interface BlockingSlotInterval {
  chargingPointId: string;
  slotStart: Date;
  slotEnd: Date;
}

export interface FreeSlotSuggestion {
  start: Date;
  end: Date;
}

interface PrivateEvLockRow {
  id: string;
  ownerId: string;
  vehicleClass: VehicleClass;
  batteryPct: number;
  deletedAt: Date | null;
}

function getScheduleConfig(): ScheduleConfig {
  return {
    chargeRatePctPerMin: config.CHARGE_RATE_PCT_PER_MIN,
    demoTimeScale: config.DEMO_TIME_SCALE,
  };
}

function isChargingOverlapError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: unknown; meta?: unknown; message?: unknown };
  if (e.code === '23P01') return true;
  const metaText = e.meta ? JSON.stringify(e.meta) : '';
  const msgText = typeof e.message === 'string' ? e.message : '';
  return (
    metaText.includes('23P01') ||
    metaText.includes('ex_charging_overlap') ||
    msgText.includes('23P01') ||
    msgText.includes('ex_charging_overlap')
  );
}

function isActivePevUniqueError(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
    return true;
  }
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('uq_charge_active_pev') || msg.includes('23505');
}

function hasFreePointForWindow(
  usablePointIds: readonly string[],
  intervalsByPoint: ReadonlyMap<string, readonly { startMs: number; endMs: number }[]>,
  startMs: number,
  endMs: number,
): boolean {
  for (const pointId of usablePointIds) {
    const intervals = intervalsByPoint.get(pointId);
    if (!intervals || intervals.length === 0) {
      return true;
    }
    const blocked = intervals.some((i) => i.startMs < endMs && i.endMs > startMs);
    if (!blocked) {
      return true;
    }
  }
  return false;
}

function groupIntervalsByPoint(
  usablePointIds: readonly string[],
  intervals: readonly BlockingSlotInterval[],
): Map<string, Array<{ startMs: number; endMs: number }>> {
  const usableSet = new Set(usablePointIds);
  const byPoint = new Map<string, Array<{ startMs: number; endMs: number }>>();
  for (const interval of intervals) {
    if (!usableSet.has(interval.chargingPointId)) continue;
    const list = byPoint.get(interval.chargingPointId) ?? [];
    list.push({
      startMs: interval.slotStart.getTime(),
      endMs: interval.slotEnd.getTime(),
    });
    byPoint.set(interval.chargingPointId, list);
  }
  return byPoint;
}

/**
 * FR-21: Pure helper returning up to `limit` (default `ALTERNATIVE_SLOTS_COUNT`) earliest free
 * start times at a Hub. Candidates are `slotStart` and every `slotEnd > slotStart` of a
 * SCHEDULED/CHARGING interval on a usable point, deduplicated and sorted ascending; a candidate
 * is kept if at least one usable point is free for `[candidate, candidate + durationMs)`.
 */
export function nextFreeStarts(input: {
  usablePointIds: readonly string[];
  intervals: readonly BlockingSlotInterval[];
  slotStart: Date;
  durationMs: number;
  limit?: number;
}): FreeSlotSuggestion[] {
  const {
    usablePointIds,
    intervals,
    slotStart,
    durationMs,
    limit = config.ALTERNATIVE_SLOTS_COUNT,
  } = input;

  if (usablePointIds.length === 0 || durationMs <= 0 || limit <= 0) {
    return [];
  }

  const slotStartMs = slotStart.getTime();
  const usableSet = new Set(usablePointIds);
  const intervalsByPoint = groupIntervalsByPoint(usablePointIds, intervals);

  const candidateSet = new Set<number>([slotStartMs]);
  for (const interval of intervals) {
    if (!usableSet.has(interval.chargingPointId)) continue;
    const endMs = interval.slotEnd.getTime();
    if (endMs > slotStartMs) {
      candidateSet.add(endMs);
    }
  }

  const sortedCandidates = Array.from(candidateSet).sort((a, b) => a - b);
  const freeStarts: FreeSlotSuggestion[] = [];

  for (const candMs of sortedCandidates) {
    if (hasFreePointForWindow(usablePointIds, intervalsByPoint, candMs, candMs + durationMs)) {
      freeStarts.push({
        start: new Date(candMs),
        end: new Date(candMs + durationMs),
      });
      if (freeStarts.length >= limit) {
        break;
      }
    }
  }

  return freeStarts;
}

async function loadHubPointsAndIntervals(
  client: DbClient,
  hubId: string,
  vehicleClass: VehicleClass,
  slotStart: Date,
): Promise<{
  usablePointIds: string[];
  intervals: BlockingSlotInterval[];
}> {
  const usablePoints = await client.chargingPoint.findMany({
    where: {
      hubId,
      vehicleClass,
      status: { not: 'FAULTY' },
    },
    orderBy: { id: 'asc' },
    select: { id: true },
  });

  const usablePointIds = usablePoints.map((p) => p.id);
  if (usablePointIds.length === 0) {
    return { usablePointIds, intervals: [] };
  }

  const blockingRows = await client.chargingRequest.findMany({
    where: {
      hubId,
      vehicleClass,
      status: { in: ['SCHEDULED', 'CHARGING'] },
      chargingPointId: { in: usablePointIds },
      slotStart: { not: null },
      slotEnd: { gt: slotStart },
    },
    select: {
      chargingPointId: true,
      slotStart: true,
      slotEnd: true,
    },
  });

  const intervals: BlockingSlotInterval[] = [];
  for (const row of blockingRows) {
    if (row.chargingPointId && row.slotStart && row.slotEnd) {
      intervals.push({
        chargingPointId: row.chargingPointId,
        slotStart: row.slotStart,
        slotEnd: row.slotEnd,
      });
    }
  }

  return { usablePointIds, intervals };
}

function toTimeAlternatives(
  freeStarts: readonly FreeSlotSuggestion[],
  hubId: string,
  hubName: string,
  vehicleClass: VehicleClass,
): Alternative[] {
  return freeStarts.map((slot) => ({
    type: 'time',
    hubId,
    hubName,
    start: toIso(slot.start),
    end: toIso(slot.end),
    reason: `Next free ${vehicleClass.toLowerCase()} charging slot at ${hubName}.`,
  }));
}

async function buildNoCapacitySuggestions(
  client: DbClient,
  params: {
    hubId: string;
    hubName: string;
    vehicleClass: VehicleClass;
    slotStart: Date;
    slotEnd: Date;
    durationMs: number;
    preloaded?: {
      usablePointIds: readonly string[];
      intervals: readonly BlockingSlotInterval[];
    };
  },
  now: Date,
): Promise<Alternative[]> {
  const { usablePointIds, intervals } =
    params.preloaded ??
    (await loadHubPointsAndIntervals(client, params.hubId, params.vehicleClass, params.slotStart));

  const freeStarts = nextFreeStarts({
    usablePointIds,
    intervals,
    slotStart: params.slotStart,
    durationMs: params.durationMs,
    limit: config.ALTERNATIVE_SLOTS_COUNT,
  });

  const timeAlternatives = toTimeAlternatives(
    freeStarts,
    params.hubId,
    params.hubName,
    params.vehicleClass,
  );

  const hubAlternatives = await alternativeHubs(
    {
      need: 'CHARGING',
      vehicleClass: params.vehicleClass,
      excludeHubId: params.hubId,
      from: params.slotStart,
      to: params.slotEnd,
    },
    now,
    client,
  );

  return [...timeAlternatives, ...hubAlternatives];
}

function throwNoCapacity(hubName: string, alternatives: Alternative[]): never {
  const nextActions =
    alternatives.length > 0
      ? ['Choose one of the suggested start times or alternative Hubs.']
      : ['Try a later start time or check another Hub.'];

  throw conflict(
    'NO_CAPACITY',
    `No free charging point available at "${hubName}" for the requested slot.`,
    {
      nextActions,
      alternatives,
    },
  );
}

function validateAdvanceWindowAndTarget(slotStart: Date, targetPct: number, now: Date): void {
  if (!Number.isFinite(targetPct) || targetPct <= 0 || targetPct > 100) {
    throw badRequest('targetPct must be greater than 0 and at most 100.', 'targetPct');
  }
  if (slotStart.getTime() <= now.getTime()) {
    throw badRequest('slotStart must be in the future.', 'slotStart', [
      'Choose a start time after the current server time.',
    ]);
  }
}

/**
 * FR-21: Check whether a charging point of the Private EV's class is free at the Hub for
 * `[slotStart, slotEnd)`. Does not require the EV to have no active charging request.
 */
export async function checkAvailability(
  user: Pick<ChargingActor, 'id'>,
  query: ChargingAvailabilityQuery,
  now: Date = new Date(),
  client: DbClient = db,
): Promise<ChargingAvailability> {
  validateAdvanceWindowAndTarget(query.slotStart, query.targetPct, now);

  const hub = await client.hub.findUnique({
    where: { id: query.hubId },
    select: { id: true, name: true },
  });
  if (!hub) {
    throw badRequest(`Hub "${query.hubId}" does not exist.`, 'hubId');
  }

  const ev = await client.privateEv.findUnique({
    where: { id: query.privateEvId },
    select: {
      id: true,
      ownerId: true,
      vehicleClass: true,
      batteryPct: true,
      deletedAt: true,
    },
  });
  if (!ev || ev.deletedAt !== null) {
    throw notFound('Private EV');
  }
  if (ev.ownerId !== user.id) {
    throw forbidden('You can only check charging availability for your own Private EV.');
  }
  if (query.targetPct <= ev.batteryPct) {
    throw badRequest(
      `targetPct (${query.targetPct}) must be greater than current batteryPct (${ev.batteryPct}).`,
      'targetPct',
    );
  }

  const durationMs = estimateDurationMs(
    ev.batteryPct,
    query.targetPct,
    ev.vehicleClass,
    getScheduleConfig(),
  );
  const slotEnd = new Date(query.slotStart.getTime() + durationMs);

  const { usablePointIds, intervals } = await loadHubPointsAndIntervals(
    client,
    hub.id,
    ev.vehicleClass,
    query.slotStart,
  );
  const intervalsByPoint = groupIntervalsByPoint(usablePointIds, intervals);
  const available = hasFreePointForWindow(
    usablePointIds,
    intervalsByPoint,
    query.slotStart.getTime(),
    slotEnd.getTime(),
  );

  if (available) {
    return {
      available: true,
      slotEnd: toIso(slotEnd),
      suggestions: [],
    };
  }

  const suggestions = await buildNoCapacitySuggestions(
    client,
    {
      hubId: hub.id,
      hubName: hub.name,
      vehicleClass: ev.vehicleClass,
      slotStart: query.slotStart,
      slotEnd,
      durationMs,
      preloaded: { usablePointIds, intervals },
    },
    now,
  );

  return {
    available: false,
    slotEnd: toIso(slotEnd),
    suggestions,
  };
}

/**
 * FR-21, BR-10, BR-13, NFR-08: Book an advance charging slot for a Private EV.
 * When `opts.tx` is supplied (e.g. FR-28 combined booking), runs directly in the caller's
 * transaction and skips idempotency and post-commit event emission.
 */
export async function bookAdvanceSlot(
  user: Pick<ChargingActor, 'id'>,
  input: BookAdvanceSlotInput,
  opts: BookAdvanceSlotOptions = {},
): Promise<ChargingRequestView> {
  if (opts.tx && opts.idemKey) {
    throw new Error(
      'bookAdvanceSlot: cannot combine opts.tx with opts.idemKey; caller owns idempotency.',
    );
  }

  const now = opts.now ?? new Date();
  validateAdvanceWindowAndTarget(input.slotStart, input.targetPct, now);

  const hubClient: DbClient = opts.tx ?? db;
  const hub = await hubClient.hub.findUnique({
    where: { id: input.hubId },
    select: { id: true, name: true },
  });
  if (!hub) {
    throw badRequest(`Hub "${input.hubId}" does not exist.`, 'hubId');
  }

  // Captured before the insert so a 23P01 exclusion violation can build alternatives after rollback.
  const slotContext: {
    value: {
      vehicleClass: VehicleClass;
      slotEnd: Date;
      durationMs: number;
    } | null;
  } = { value: null };

  const runBook = async (tx: Tx): Promise<ChargingRequestView> => {
    // Lock order: private_ev (FOR SHARE) -> charging_point (SKIP LOCKED) -> charging_request.
    const evRows = await tx.$queryRaw<PrivateEvLockRow[]>`
      SELECT id, "ownerId", "vehicleClass", "batteryPct", "deletedAt"
      FROM "private_ev"
      WHERE id = ${input.privateEvId}
      FOR SHARE
    `;
    const ev = evRows[0];
    if (!ev || ev.deletedAt !== null) {
      throw notFound('Private EV');
    }
    if (ev.ownerId !== user.id) {
      throw forbidden('You can only book advance charging for your own Private EV.');
    }
    if (input.targetPct <= ev.batteryPct) {
      throw badRequest(
        `targetPct (${input.targetPct}) must be greater than current batteryPct (${ev.batteryPct}).`,
        'targetPct',
      );
    }

    const active = await tx.chargingRequest.findFirst({
      where: {
        privateEvId: ev.id,
        status: { in: ['QUEUED', 'SCHEDULED', 'CHARGING'] },
      },
      select: { id: true },
    });
    if (active) {
      throw conflict(
        'HAS_ACTIVE_BOOKING',
        'This Private EV already has an active charging request.',
        { nextActions: ['Wait for the current charging request to finish or cancel it first.'] },
      );
    }

    const durationMs = estimateDurationMs(
      ev.batteryPct,
      input.targetPct,
      ev.vehicleClass,
      getScheduleConfig(),
    );
    const slotEnd = new Date(input.slotStart.getTime() + durationMs);
    slotContext.value = { vehicleClass: ev.vehicleClass, slotEnd, durationMs };

    // BR-10, BR-13: pick one free non-FAULTY point of the EV's class for [slotStart, slotEnd).
    // Known limit (same as T-13): SKIP LOCKED may skip a point currently locked for a different
    // time window; the last-point race still guarantees exactly one winner.
    const freePoints = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT cp.id
      FROM charging_point cp
      WHERE cp."hubId" = ${hub.id}
        AND cp."vehicleClass" = ${ev.vehicleClass}::"VehicleClass"
        AND cp.status != 'FAULTY'::"ChargingPointStatus"
        AND NOT EXISTS (
          SELECT 1
          FROM charging_request cr
          WHERE cr."chargingPointId" = cp.id
            AND cr.status IN ('SCHEDULED', 'CHARGING')
            AND cr."slotStart" < ${slotEnd}
            AND cr."slotEnd" > ${input.slotStart}
        )
      ORDER BY cp.id
      LIMIT 1
      FOR UPDATE OF cp SKIP LOCKED
    `;

    const pointId = freePoints[0]?.id;
    if (!pointId) {
      const suggestions = await buildNoCapacitySuggestions(
        tx,
        {
          hubId: hub.id,
          hubName: hub.name,
          vehicleClass: ev.vehicleClass,
          slotStart: input.slotStart,
          slotEnd,
          durationMs,
        },
        now,
      );
      throwNoCapacity(hub.name, suggestions);
    }

    const created = await tx.chargingRequest.create({
      data: {
        requestedById: user.id,
        ownerId: user.id,
        vehicleKind: 'PRIVATE',
        privateEvId: ev.id,
        vehicleClass: ev.vehicleClass,
        hubId: hub.id,
        mode: 'ADVANCE',
        status: 'SCHEDULED',
        targetPct: input.targetPct,
        startPct: ev.batteryPct,
        currentPct: ev.batteryPct,
        desiredTime: input.slotStart,
        chargingPointId: pointId,
        slotStart: input.slotStart,
        slotEnd,
        bookingGroupId: opts.bookingGroupId ?? null,
        createdAt: now,
      },
    });

    return toRequestView(created, null, now);
  };

  try {
    if (opts.tx) {
      return await runBook(opts.tx);
    }

    const outcome = await db.$transaction(async (tx) => {
      return withIdempotency(
        tx,
        {
          userId: user.id,
          key: opts.idemKey,
          endpoint: 'POST /api/charging/advance-bookings',
          now,
        },
        async () => ({
          status: 201,
          body: await runBook(tx),
        }),
      );
    });

    if (!outcome.replayed) {
      events.emit('CHARGING_QUEUE_CHANGED', { hubId: outcome.body.hubId });
    }
    return outcome.body;
  } catch (err: unknown) {
    if (isChargingOverlapError(err)) {
      // ex_charging_overlap aborted the transaction; query suggestions with plain db.
      const ctx = slotContext.value;
      const suggestions = ctx
        ? await buildNoCapacitySuggestions(
            db,
            {
              hubId: hub.id,
              hubName: hub.name,
              vehicleClass: ctx.vehicleClass,
              slotStart: input.slotStart,
              slotEnd: ctx.slotEnd,
              durationMs: ctx.durationMs,
            },
            now,
          )
        : [];
      throwNoCapacity(hub.name, suggestions);
    }
    if (isActivePevUniqueError(err)) {
      throw conflict(
        'HAS_ACTIVE_BOOKING',
        'This Private EV already has an active charging request.',
        { nextActions: ['Wait for the current charging request to finish or cancel it first.'] },
      );
    }
    throw err;
  }
}
