// Charging request lifecycle service: submit (FR-20, D-13), view (FR-22), cancel (FR-24),
// stop & endSession (FR-23, FR-62).

import { Prisma, type ChargingRequest } from '@prisma/client';
import { config } from '../../core/config';
import { db, lockRow, type DbClient, type Tx } from '../../core/db';
import { AppError, badRequest, conflict, forbidden, notFound } from '../../core/errors';
import { events } from '../../core/events';
import { notify } from '../../core/notify';
import { assertTransition } from '../../core/stateMachine';
import { addMinutes } from '../../core/time';
import type { ChargingRequestView } from '../../types/charging';
import type {
  ChargingEndReason,
  ChargingVehicleKind,
  Role,
  VehicleClass,
} from '../../types/enums';
import { buildHubProjection, toRequestView } from './charging.service';
import type { ScheduleProjection } from './schedule';

export interface ChargingActor {
  id: string;
  role: Role;
}

export type SubmitRequestInput =
  | {
      vehicleKind: 'PRIVATE';
      privateEvId: string;
      hubId: string;
      targetPct: number;
      desiredTime?: Date;
      neededBy?: Date | null;
    }
  | {
      vehicleKind: 'RENTAL';
      rentalVehicleId: string;
      hubId: string;
      targetPct: number;
      neededBy?: Date | null;
    };

export interface CreateQueueRequestInput {
  requestedById: string;
  ownerId: string | null;
  vehicleKind: ChargingVehicleKind;
  rentalVehicleId?: string | null;
  privateEvId?: string | null;
  vehicleClass: VehicleClass;
  hubId: string;
  targetPct: number;
  currentPct: number;
  desiredTime?: Date;
  neededBy?: Date | null;
}

interface PrivateEvLockRow {
  id: string;
  ownerId: string;
  vehicleClass: VehicleClass;
  batteryPct: number;
  deletedAt: Date | null;
}

function isActiveBookingUniqueError(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
    return true;
  }
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes('uq_charge_active_pev') ||
    msg.includes('uq_charge_active_rental') ||
    msg.includes('23505')
  );
}

// Shared queue insertion helper (reused by T-19 return-with-charging and T-20 fleet dispatch).
export async function createQueueRequest(
  tx: Tx,
  input: CreateQueueRequestInput,
  now: Date = new Date(),
): Promise<ChargingRequest> {
  try {
    return await tx.chargingRequest.create({
      data: {
        requestedById: input.requestedById,
        ownerId: input.ownerId,
        vehicleKind: input.vehicleKind,
        rentalVehicleId: input.rentalVehicleId ?? null,
        privateEvId: input.privateEvId ?? null,
        vehicleClass: input.vehicleClass,
        hubId: input.hubId,
        mode: 'QUEUE',
        status: 'QUEUED',
        targetPct: input.targetPct,
        startPct: input.currentPct,
        currentPct: input.currentPct,
        desiredTime: input.desiredTime ?? now,
        neededBy: input.neededBy ?? null,
        createdAt: now,
      },
    });
  } catch (err) {
    if (isActiveBookingUniqueError(err)) {
      throw conflict('HAS_ACTIVE_BOOKING', 'This vehicle already has an active charging request.', {
        nextActions: ['Wait for the current charging request to finish or cancel it first.'],
      });
    }
    throw err;
  }
}

export async function submitRequest(
  user: ChargingActor,
  input: SubmitRequestInput,
  now: Date = new Date(),
): Promise<ChargingRequestView> {
  if (!Number.isFinite(input.targetPct) || input.targetPct <= 0 || input.targetPct > 100) {
    throw badRequest('targetPct must be greater than 0 and at most 100.', 'targetPct');
  }

  const hub = await db.hub.findUnique({ where: { id: input.hubId }, select: { id: true } });
  if (!hub) {
    throw badRequest(`Hub "${input.hubId}" does not exist.`, 'hubId');
  }

  const created = await db.$transaction(async (tx) => {
    if (input.vehicleKind === 'PRIVATE') {
      const desiredTime = input.desiredTime ?? now;
      const neededBy = input.neededBy ?? null;
      if (neededBy && neededBy.getTime() < desiredTime.getTime()) {
        throw badRequest('neededBy must not be earlier than desiredTime.', 'neededBy');
      }

      // Rule 2 & Rule 9: lock private_ev FOR SHARE first (same lock order as T-14).
      const rows = await tx.$queryRaw<PrivateEvLockRow[]>`
        SELECT id, "ownerId", "vehicleClass", "batteryPct", "deletedAt"
        FROM "private_ev"
        WHERE id = ${input.privateEvId}
        FOR SHARE
      `;
      const ev = rows[0];
      if (!ev || ev.deletedAt !== null) {
        throw notFound('Private EV');
      }
      if (ev.ownerId !== user.id) {
        throw forbidden('You can only request charging for your own Private EV.');
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

      return createQueueRequest(
        tx,
        {
          requestedById: user.id,
          ownerId: user.id,
          vehicleKind: 'PRIVATE',
          privateEvId: ev.id,
          vehicleClass: ev.vehicleClass,
          hubId: input.hubId,
          targetPct: input.targetPct,
          currentPct: ev.batteryPct,
          desiredTime,
          neededBy,
        },
        now,
      );
    }

    // RENTAL path (D-13: within CHARGE_AFTER_RETURN_MIN after caller's own return at this Hub).
    const neededBy = input.neededBy ?? null;
    if (neededBy && neededBy.getTime() < now.getTime()) {
      throw badRequest('neededBy must not be earlier than desiredTime.', 'neededBy');
    }

    // Rule 3 & Rule 9: lock rental_vehicle first.
    await lockRow(tx, 'rental_vehicle', input.rentalVehicleId);
    const vehicle = await tx.rentalVehicle.findUniqueOrThrow({
      where: { id: input.rentalVehicleId },
    });

    // D-13: read-only; charging must never import reservations (D-23, T-19).
    const cutoff = addMinutes(now, -config.CHARGE_AFTER_RETURN_MIN);
    const recentReturn = await tx.vehicleReservation.findFirst({
      where: {
        userId: user.id,
        rentalVehicleId: vehicle.id,
        status: 'COMPLETED',
        endReason: 'RETURNED',
        returnHubId: input.hubId,
        returnedAt: { gte: cutoff },
      },
      select: { id: true },
    });
    if (!recentReturn) {
      throw forbidden(
        `You can request charging for a rental vehicle only within ${config.CHARGE_AFTER_RETURN_MIN} minutes after returning it.`,
      );
    }

    if (
      vehicle.hubId !== input.hubId ||
      (vehicle.status !== 'AVAILABLE' && vehicle.status !== 'LOW_BATTERY')
    ) {
      throw conflict(
        'NOT_ELIGIBLE',
        'This rental vehicle is no longer eligible for charging at this Hub.',
        { nextActions: ['Check the vehicle status at this Hub.'] },
      );
    }

    if (input.targetPct <= vehicle.batteryPct) {
      throw badRequest(
        `targetPct (${input.targetPct}) must be greater than current batteryPct (${vehicle.batteryPct}).`,
        'targetPct',
      );
    }

    const active = await tx.chargingRequest.findFirst({
      where: {
        rentalVehicleId: vehicle.id,
        status: { in: ['QUEUED', 'SCHEDULED', 'CHARGING'] },
      },
      select: { id: true },
    });
    if (active) {
      throw conflict(
        'HAS_ACTIVE_BOOKING',
        'This rental vehicle already has an active charging request.',
        { nextActions: ['Wait for the current charging request to finish.'] },
      );
    }

    return createQueueRequest(
      tx,
      {
        requestedById: user.id,
        ownerId: user.id,
        vehicleKind: 'RENTAL',
        rentalVehicleId: vehicle.id,
        vehicleClass: 'MOTORCYCLE',
        hubId: input.hubId,
        targetPct: input.targetPct,
        currentPct: vehicle.batteryPct,
        desiredTime: now,
        neededBy,
      },
      now,
    );
  });

  // Compute projection before emitting so the 201 response has the QUEUED position/estimates.
  const bundle = await buildHubProjection(db, created.hubId, now);
  const view = toRequestView(created, bundle.projection, now);

  events.emit('CHARGING_QUEUE_CHANGED', { hubId: created.hubId });
  return view;
}

export async function listMine(
  userId: string,
  opts: { active?: boolean } = {},
  now: Date = new Date(),
  client: DbClient = db,
): Promise<ChargingRequestView[]> {
  const activeOnly = opts.active ?? true;
  const rows = await client.chargingRequest.findMany({
    where: {
      ownerId: userId,
      ...(activeOnly ? { status: { in: ['QUEUED', 'SCHEDULED', 'CHARGING'] } } : {}),
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  });

  const hubsNeedingProjection = new Set<string>();
  for (const r of rows) {
    if (r.status === 'QUEUED' || r.status === 'CHARGING') {
      hubsNeedingProjection.add(r.hubId);
    }
  }

  const projections = new Map<string, ScheduleProjection>();
  await Promise.all(
    Array.from(hubsNeedingProjection).map(async (hid) => {
      const bundle = await buildHubProjection(client, hid, now);
      projections.set(hid, bundle.projection);
    }),
  );

  return rows.map((r) => toRequestView(r, projections.get(r.hubId) ?? null, now));
}

export async function getMine(
  userId: string,
  id: string,
  now: Date = new Date(),
  client: DbClient = db,
): Promise<ChargingRequestView> {
  const row = await client.chargingRequest.findUnique({ where: { id } });
  if (!row || row.ownerId !== userId) {
    throw notFound('Charging request');
  }

  const projection =
    row.status === 'QUEUED' || row.status === 'CHARGING'
      ? (await buildHubProjection(client, row.hubId, now)).projection
      : null;

  return toRequestView(row, projection, now);
}

export async function cancelRequest(
  userId: string,
  id: string,
  now: Date = new Date(),
): Promise<ChargingRequestView> {
  const meta = await db.chargingRequest.findUnique({
    where: { id },
    select: {
      id: true,
      ownerId: true,
      rentalVehicleId: true,
      privateEvId: true,
      chargingPointId: true,
    },
  });
  if (!meta || meta.ownerId !== userId) {
    throw notFound('Charging request');
  }

  const updated = await db.$transaction(async (tx) => {
    // Rule 9 lock order: vehicle -> charging_point -> charging_request.
    if (meta.rentalVehicleId) {
      await lockRow(tx, 'rental_vehicle', meta.rentalVehicleId);
    } else if (meta.privateEvId) {
      await lockRow(tx, 'private_ev', meta.privateEvId);
    }
    if (meta.chargingPointId) {
      await lockRow(tx, 'charging_point', meta.chargingPointId);
    }
    await lockRow(tx, 'charging_request', id);

    const req = await tx.chargingRequest.findUniqueOrThrow({ where: { id } });
    if (req.ownerId !== userId) {
      throw notFound('Charging request');
    }

    if (req.status === 'CHARGING') {
      throw new AppError(
        409,
        'INVALID_STATE_TRANSITION',
        'Cannot cancel a charging session that is currently in progress.',
        {
          nextActions: ['Stop the session instead.'],
          details: { entity: 'chargingRequest', from: req.status, to: 'CANCELLED' },
        },
      );
    }

    assertTransition('chargingRequest', req.status, 'CANCELLED');

    return tx.chargingRequest.update({
      where: { id: req.id },
      data: {
        status: 'CANCELLED',
        endedAt: now,
      },
    });
  });

  events.emit('CHARGING_QUEUE_CHANGED', { hubId: updated.hubId });
  return toRequestView(updated, null, now);
}

export async function endSession(
  requestId: string,
  reason: ChargingEndReason,
  now: Date = new Date(),
  opts: { strict?: boolean } = {},
): Promise<ChargingRequest | null> {
  const meta = await db.chargingRequest.findUnique({
    where: { id: requestId },
    select: {
      id: true,
      rentalVehicleId: true,
      privateEvId: true,
      chargingPointId: true,
    },
  });
  if (!meta) {
    if (opts.strict) throw notFound('Charging request');
    return null;
  }

  const ended = await db.$transaction(async (tx) => {
    // Rule 9 lock order: vehicle -> charging_point -> charging_request.
    if (meta.rentalVehicleId) {
      await lockRow(tx, 'rental_vehicle', meta.rentalVehicleId);
    } else if (meta.privateEvId) {
      await lockRow(tx, 'private_ev', meta.privateEvId);
    }
    if (meta.chargingPointId) {
      await lockRow(tx, 'charging_point', meta.chargingPointId);
    }
    await lockRow(tx, 'charging_request', requestId);

    const req = await tx.chargingRequest.findUnique({ where: { id: requestId } });
    if (!req) {
      if (opts.strict) throw notFound('Charging request');
      return null;
    }

    if (req.status !== 'CHARGING') {
      if (opts.strict) {
        assertTransition('chargingRequest', req.status, 'COMPLETED');
      }
      return null;
    }

    assertTransition('chargingRequest', req.status, 'COMPLETED');

    const finalPct = req.currentPct;
    const completed = await tx.chargingRequest.update({
      where: { id: req.id },
      data: {
        status: 'COMPLETED',
        endReason: reason,
        finalPct,
        endedAt: now,
      },
    });

    if (req.chargingPointId) {
      // Lock if chargingPointId was assigned after initial meta read (defensive).
      if (req.chargingPointId !== meta.chargingPointId) {
        await lockRow(tx, 'charging_point', req.chargingPointId);
      }
      const point = await tx.chargingPoint.findUnique({ where: { id: req.chargingPointId } });
      if (point && point.status === 'CHARGING') {
        assertTransition('chargingPoint', point.status, 'AVAILABLE');
        await tx.chargingPoint.update({
          where: { id: point.id },
          data: { status: 'AVAILABLE' },
        });
      }
    }

    // Rental vehicle LOW_BATTERY -> AVAILABLE once finalPct >= MIN_RENTAL_BATTERY_PCT (BR-02).
    if (req.vehicleKind === 'RENTAL' && req.rentalVehicleId) {
      const vehicle = await tx.rentalVehicle.findUnique({ where: { id: req.rentalVehicleId } });
      if (
        vehicle &&
        vehicle.status === 'LOW_BATTERY' &&
        finalPct >= config.MIN_RENTAL_BATTERY_PCT
      ) {
        assertTransition('rentalVehicle', vehicle.status, 'AVAILABLE');
        await tx.rentalVehicle.update({
          where: { id: vehicle.id },
          data: { status: 'AVAILABLE' },
        });
      }
    }

    // FR-62 notifications inside the same transaction.
    if (req.ownerId) {
      if (reason === 'TARGET_REACHED') {
        await notify(tx, {
          userId: req.ownerId,
          type: 'CHARGING_COMPLETED',
          title: 'Charging completed',
          body: `Your vehicle reached ${finalPct}% battery at Hub ${req.hubId}.`,
          data: {
            chargingRequestId: req.id,
            hubId: req.hubId,
            chargingPointId: req.chargingPointId,
            finalPct,
          },
        });
      } else if (reason === 'POINT_FAILURE' || reason === 'VEHICLE_FAULT') {
        await notify(tx, {
          userId: req.ownerId,
          type: 'CHARGING_ENDED_FAULT',
          title: 'Charging ended due to fault',
          body: `Your charging session at Hub ${req.hubId} ended at ${finalPct}% (${reason}).`,
          data: {
            chargingRequestId: req.id,
            hubId: req.hubId,
            chargingPointId: req.chargingPointId,
            endReason: reason,
            finalPct,
          },
        });
      }
      // USER_STOP: no notification (the user initiated the stop).
    }

    return completed;
  });

  if (ended) {
    events.emit('CHARGING_QUEUE_CHANGED', { hubId: ended.hubId });
  }

  return ended;
}

export async function stopSession(
  userId: string,
  id: string,
  now: Date = new Date(),
): Promise<ChargingRequestView> {
  const existing = await db.chargingRequest.findUnique({
    where: { id },
    select: { id: true, ownerId: true },
  });
  if (!existing || existing.ownerId !== userId) {
    throw notFound('Charging request');
  }

  const ended = await endSession(id, 'USER_STOP', now, { strict: true });
  if (!ended) {
    throw notFound('Charging request');
  }

  return toRequestView(ended, null, now);
}
