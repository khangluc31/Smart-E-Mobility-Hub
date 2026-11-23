// Vehicle reservations service: reserve, current, cancel, change vehicle, and hold expiry
// (FR-06, FR-07, FR-08, FR-09, BR-01, BR-02, BR-03, BR-05, BR-10, NFR-08, NFR-21).

import {
  Prisma,
  type RentalVehicle as PrismaRentalVehicle,
  type VehicleReservation as PrismaVehicleReservation,
} from '@prisma/client';
import { config } from '../../core/config';
import { db, lockRow, type DbClient, type Tx } from '../../core/db';
import { badRequest, conflict, notFound } from '../../core/errors';
import { events } from '../../core/events';
import { withIdempotency } from '../../core/idempotency';
import { notify } from '../../core/notify';
import { assertTransition } from '../../core/stateMachine';
import { addMinutes } from '../../core/time';
import type { Alternative } from '../../types/common';
import type { VehicleReservation } from '../../types/reservations';
import { isVehicleCharging, toRentalVehicleDto } from './vehicles.service';

// Named transaction pool/wait constants so 50 concurrent reservation requests on
// the same vehicle serialize on the row lock without failing with P2024/P2028.
export const RESERVE_TX_MAX_WAIT_MS = 15_000;
export const RESERVE_TX_TIMEOUT_MS = 15_000;

const LOCK_RETRY_ATTEMPTS = 2;

export function toReservationDto(
  row: PrismaVehicleReservation,
  vehicle: PrismaRentalVehicle,
  now: Date = new Date(),
  charging = false,
): VehicleReservation {
  return {
    id: row.id,
    status: row.status,
    hubId: row.hubId,
    vehicle: toRentalVehicleDto(vehicle, charging),
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    pickedUpAt: row.pickedUpAt ? row.pickedUpAt.toISOString() : null,
    returnedAt: row.returnedAt ? row.returnedAt.toISOString() : null,
    returnHubId: row.returnHubId ?? null,
    startBatteryPct: row.startBatteryPct ?? null,
    endBatteryPct: row.endBatteryPct ?? null,
    endReason: row.endReason ?? null,
    serverNow: now.toISOString(),
  };
}

/**
 * Lists up to `config.ALTERNATIVE_SLOTS_COUNT` rentable vehicles at the same Hub,
 * sorted by `batteryPct DESC, id ASC` (`ALTERNATIVE_SLOTS_COUNT` is reused as
 * "how many alternatives to list" per T-11 Rule 5.4).
 */
async function findSameHubVehicleAlternatives(
  client: DbClient,
  hubId: string,
  excludeVehicleId: string,
): Promise<Alternative[]> {
  const candidates = await client.rentalVehicle.findMany({
    where: {
      hubId,
      id: { not: excludeVehicleId },
      status: 'AVAILABLE',
      batteryPct: { gte: config.MIN_RENTAL_BATTERY_PCT },
    },
    orderBy: [{ batteryPct: 'desc' }, { id: 'asc' }],
  });

  if (candidates.length === 0) {
    return [];
  }

  const chargingSet = await isVehicleCharging(
    client,
    candidates.map((c) => c.id),
  );

  const alternatives: Alternative[] = [];
  for (const c of candidates) {
    if (chargingSet.has(c.id)) continue;
    alternatives.push({
      type: 'rentalVehicle',
      id: c.id,
      hubId: c.hubId,
      batteryPct: c.batteryPct,
      reason: `Available at same Hub with ${c.batteryPct}% battery`,
    });
    if (alternatives.length >= config.ALTERNATIVE_SLOTS_COUNT) {
      break;
    }
  }
  return alternatives;
}

function throwResourceTaken(alternatives: Alternative[]): never {
  const nextActions =
    alternatives.length > 0
      ? ['Pick one of the alternative vehicles at this Hub.', 'Search other Hubs.']
      : ['No other vehicles are available at this Hub; search another Hub.'];

  throw conflict('RESOURCE_TAKEN', 'This vehicle is not available for reservation.', {
    nextActions,
    alternatives,
  });
}

function throwActiveRentalExists(): never {
  throw conflict(
    'ACTIVE_RENTAL_EXISTS',
    'You already have an active vehicle reservation or rental.',
    {
      nextActions: [
        'Use, cancel, or complete your current vehicle reservation before creating a new one.',
      ],
    },
  );
}

function throwLowBattery(): never {
  throw conflict(
    'LOW_BATTERY',
    'This vehicle does not have sufficient battery to be reserved.',
    {
      nextActions: ['Pick another available vehicle with sufficient battery.'],
    },
  );
}

function throwHoldExpired(): never {
  throw conflict('HOLD_EXPIRED', 'This vehicle reservation hold has expired.', {
    nextActions: ['Search and reserve an available vehicle again.'],
  });
}

async function assertVehicleRentable(
  tx: Tx,
  vehicle: PrismaRentalVehicle,
): Promise<void> {
  if (
    vehicle.status === 'LOW_BATTERY' ||
    vehicle.batteryPct < config.MIN_RENTAL_BATTERY_PCT
  ) {
    throwLowBattery();
  }

  const chargingSet = await isVehicleCharging(tx, [vehicle.id]);
  if (vehicle.status !== 'AVAILABLE' || chargingSet.has(vehicle.id)) {
    const alternatives = await findSameHubVehicleAlternatives(
      tx,
      vehicle.hubId,
      vehicle.id,
    );
    throwResourceTaken(alternatives);
  }
}

/**
 * Helper used inside a transaction when a CONFIRMED hold is discovered past `expiresAt`:
 * transitions reservation CONFIRMED → EXPIRED (`endReason: 'EXPIRED'`), releases the vehicle
 * RESERVED → AVAILABLE only if its status is still RESERVED, and inserts a
 * `RESERVATION_EXPIRED` notification row.
 */
async function applyHoldExpiryInTx(
  tx: Tx,
  reservation: PrismaVehicleReservation,
  vehicle: PrismaRentalVehicle,
): Promise<void> {
  assertTransition('reservation', reservation.status, 'EXPIRED');
  await tx.vehicleReservation.update({
    where: { id: reservation.id },
    data: {
      status: 'EXPIRED',
      endReason: 'EXPIRED',
    },
  });

  if (vehicle.status === 'RESERVED') {
    assertTransition('rentalVehicle', vehicle.status, 'AVAILABLE');
    await tx.rentalVehicle.update({
      where: { id: vehicle.id },
      data: { status: 'AVAILABLE' },
    });
  }

  await notify(tx, {
    userId: reservation.userId,
    type: 'RESERVATION_EXPIRED',
    title: 'Vehicle reservation expired',
    body: `Your reservation hold for vehicle ${reservation.rentalVehicleId} has expired.`,
    data: {
      reservationId: reservation.id,
      vehicleId: reservation.rentalVehicleId,
      hubId: reservation.hubId,
    },
  });
}

/**
 * FR-06, BR-01, BR-02, BR-10, NFR-08, NFR-21:
 * Reserve a rental vehicle with row locking and idempotency protection.
 */
export async function reserveVehicle(
  userId: string,
  vehicleId: string,
  idemKey?: string,
  now: Date = new Date(),
): Promise<VehicleReservation> {
  let targetHubId: string | null = null;

  try {
    const outcome = await db.$transaction(
      async (tx) => {
        return withIdempotency(
          tx,
          {
            userId,
            key: idemKey,
            endpoint: 'POST /api/vehicle-reservations',
            now,
          },
          async () => {
            // Step 2: lock resource row first (throws 404 NOT_FOUND if missing)
            await lockRow(tx, 'rental_vehicle', vehicleId);
            const vehicle = await tx.rentalVehicle.findUniqueOrThrow({
              where: { id: vehicleId },
            });
            targetHubId = vehicle.hubId;

            // Step 3: BR-01 check caller's active reservation
            const existingActive = await tx.vehicleReservation.findFirst({
              where: {
                userId,
                status: { in: ['CONFIRMED', 'ACTIVE'] },
              },
              select: { id: true },
            });
            if (existingActive) {
              throwActiveRentalExists();
            }

            // Step 4: BR-02 & D-18 battery, status, and charging check
            await assertVehicleRentable(tx, vehicle);

            // Step 5: BR-05 state transition & writes
            assertTransition('rentalVehicle', vehicle.status, 'RESERVED');
            const expiresAt = addMinutes(now, config.RESERVATION_HOLD_MIN);

            const created = await tx.vehicleReservation.create({
              data: {
                userId,
                rentalVehicleId: vehicle.id,
                hubId: vehicle.hubId,
                status: 'CONFIRMED',
                createdAt: now,
                expiresAt,
                idempotencyKey: idemKey ?? null,
              },
            });

            const updatedVehicle = await tx.rentalVehicle.update({
              where: { id: vehicle.id },
              data: { status: 'RESERVED' },
            });

            return {
              status: 201,
              body: toReservationDto(created, updatedVehicle, now, false),
            };
          },
        );
      },
      {
        maxWait: RESERVE_TX_MAX_WAIT_MS,
        timeout: RESERVE_TX_TIMEOUT_MS,
      },
    );

    if (!outcome.replayed) {
      events.emit('RESERVATION_CHANGED', { hubId: outcome.body.hubId });
    }
    return outcome.body;
  } catch (err: unknown) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const metaText = `${JSON.stringify(err.meta ?? {})} ${err.message}`;
      if (
        metaText.includes('uq_vres_active_user') ||
        metaText.includes('userId')
      ) {
        throwActiveRentalExists();
      }
      const hubId =
        targetHubId ??
        (
          await db.rentalVehicle.findUnique({
            where: { id: vehicleId },
            select: { hubId: true },
          })
        )?.hubId;
      const alternatives = hubId
        ? await findSameHubVehicleAlternatives(db, hubId, vehicleId)
        : [];
      throwResourceTaken(alternatives);
    }
    throw err;
  }
}

/**
 * FR-07: Return the caller's current CONFIRMED or ACTIVE vehicle reservation, or `null`.
 */
export async function getCurrent(
  userId: string,
  now: Date = new Date(),
): Promise<VehicleReservation | null> {
  const row = await db.vehicleReservation.findFirst({
    where: {
      userId,
      status: { in: ['CONFIRMED', 'ACTIVE'] },
    },
    include: {
      rentalVehicle: true,
    },
    orderBy: { createdAt: 'desc' },
  });

  if (!row) {
    return null;
  }

  const chargingSet = await isVehicleCharging(db, [row.rentalVehicleId]);
  return toReservationDto(
    row,
    row.rentalVehicle,
    now,
    chargingSet.has(row.rentalVehicleId),
  );
}

/**
 * FR-08, Rule 8 & Rule 9: Cancel a CONFIRMED vehicle reservation.
 * Lock order: vehicle first, then reservation (with re-read & 1-time retry if vehicle changed).
 * If CONFIRMED and `expiresAt <= now`, commits the expiry first and throws 409 HOLD_EXPIRED.
 */
export async function cancelReservation(
  userId: string,
  id: string,
  now: Date = new Date(),
): Promise<VehicleReservation> {
  const outcome = await db.$transaction(async (tx) => {
    let lockedVehicleId: string | null = null;
    let res: PrismaVehicleReservation | null = null;

    for (let attempt = 0; attempt < LOCK_RETRY_ATTEMPTS; attempt++) {
      const unlocked = await tx.vehicleReservation.findUnique({ where: { id } });
      if (!unlocked || unlocked.userId !== userId) {
        throw notFound('Vehicle reservation');
      }

      await lockRow(tx, 'rental_vehicle', unlocked.rentalVehicleId);
      await lockRow(tx, 'vehicle_reservation', id);

      const reread = await tx.vehicleReservation.findUniqueOrThrow({ where: { id } });
      if (reread.userId !== userId) {
        throw notFound('Vehicle reservation');
      }

      if (reread.rentalVehicleId === unlocked.rentalVehicleId) {
        lockedVehicleId = unlocked.rentalVehicleId;
        res = reread;
        break;
      }
    }

    if (!res || !lockedVehicleId) {
      throw conflict('RESOURCE_TAKEN', 'Reservation was modified concurrently.', {
        nextActions: ['Reload and try again.'],
      });
    }

    const vehicle = await tx.rentalVehicle.findUniqueOrThrow({
      where: { id: lockedVehicleId },
    });

    // Rule 8: expired-but-not-yet-flipped CONFIRMED hold -> expire and commit, then throw HOLD_EXPIRED
    if (res.status === 'CONFIRMED' && res.expiresAt.getTime() <= now.getTime()) {
      await applyHoldExpiryInTx(tx, res, vehicle);
      return { kind: 'EXPIRED' as const, hubId: res.hubId };
    }

    // Rule 9: assertTransition on reservation (ACTIVE/COMPLETED/CANCELLED/EXPIRED -> 409 INVALID_STATE_TRANSITION)
    assertTransition('reservation', res.status, 'CANCELLED');

    const updatedRes = await tx.vehicleReservation.update({
      where: { id: res.id },
      data: {
        status: 'CANCELLED',
        endReason: 'CANCELLED',
      },
    });

    let updatedVehicle = vehicle;
    if (vehicle.status === 'RESERVED') {
      assertTransition('rentalVehicle', vehicle.status, 'AVAILABLE');
      updatedVehicle = await tx.rentalVehicle.update({
        where: { id: vehicle.id },
        data: { status: 'AVAILABLE' },
      });
    }

    const chargingSet = await isVehicleCharging(tx, [updatedVehicle.id]);
    return {
      kind: 'CANCELLED' as const,
      hubId: updatedRes.hubId,
      dto: toReservationDto(
        updatedRes,
        updatedVehicle,
        now,
        chargingSet.has(updatedVehicle.id),
      ),
    };
  });

  events.emit('RESERVATION_CHANGED', { hubId: outcome.hubId });

  if (outcome.kind === 'EXPIRED') {
    throwHoldExpired();
  }

  return outcome.dto;
}

/**
 * FR-09, Rule 8 & Rule 10: Atomically change the reserved vehicle while keeping `expiresAt`.
 * Locks both vehicles in ascending ID order, then locks the reservation.
 */
export async function changeVehicle(
  userId: string,
  id: string,
  newVehicleId: string,
  now: Date = new Date(),
): Promise<VehicleReservation> {
  const outcome = await db.$transaction(async (tx) => {
    let oldVehicleId: string | null = null;
    let res: PrismaVehicleReservation | null = null;

    for (let attempt = 0; attempt < LOCK_RETRY_ATTEMPTS; attempt++) {
      const unlocked = await tx.vehicleReservation.findUnique({ where: { id } });
      if (!unlocked || unlocked.userId !== userId) {
        throw notFound('Vehicle reservation');
      }

      if (unlocked.rentalVehicleId === newVehicleId) {
        throw badRequest(
          'New vehicle must be different from the currently reserved vehicle.',
          'vehicleId',
          ['Pick a different vehicle to switch your reservation.'],
        );
      }

      const [firstVehicleId, secondVehicleId] = [
        unlocked.rentalVehicleId,
        newVehicleId,
      ].sort();
      await lockRow(tx, 'rental_vehicle', firstVehicleId!);
      await lockRow(tx, 'rental_vehicle', secondVehicleId!);
      await lockRow(tx, 'vehicle_reservation', id);

      const reread = await tx.vehicleReservation.findUniqueOrThrow({ where: { id } });
      if (reread.userId !== userId) {
        throw notFound('Vehicle reservation');
      }

      if (reread.rentalVehicleId === unlocked.rentalVehicleId) {
        oldVehicleId = unlocked.rentalVehicleId;
        res = reread;
        break;
      }
    }

    if (!res || !oldVehicleId) {
      throw conflict('RESOURCE_TAKEN', 'Reservation was modified concurrently.', {
        nextActions: ['Reload and try again.'],
      });
    }

    if (res.rentalVehicleId === newVehicleId) {
      throw badRequest(
        'New vehicle must be different from the currently reserved vehicle.',
        'vehicleId',
        ['Pick a different vehicle to switch your reservation.'],
      );
    }

    const [oldVehicle, newVehicle] = await Promise.all([
      tx.rentalVehicle.findUniqueOrThrow({ where: { id: oldVehicleId } }),
      tx.rentalVehicle.findUniqueOrThrow({ where: { id: newVehicleId } }),
    ]);

    // Rule 8: expired-but-not-yet-flipped CONFIRMED hold -> expire and commit, then throw HOLD_EXPIRED
    if (res.status === 'CONFIRMED' && res.expiresAt.getTime() <= now.getTime()) {
      await applyHoldExpiryInTx(tx, res, oldVehicle);
      return { kind: 'EXPIRED' as const, hubIds: [res.hubId] };
    }

    // Only CONFIRMED reservations can change vehicles; finished/active reservations -> 409 INVALID_STATE_TRANSITION
    if (res.status !== 'CONFIRMED') {
      assertTransition('reservation', res.status, 'CONFIRMED');
    }

    // Validate new vehicle eligibility (Rule 5 step 4)
    await assertVehicleRentable(tx, newVehicle);

    // Release old vehicle only if still RESERVED (never transition FAULTY -> AVAILABLE)
    if (oldVehicle.status === 'RESERVED') {
      assertTransition('rentalVehicle', oldVehicle.status, 'AVAILABLE');
      await tx.rentalVehicle.update({
        where: { id: oldVehicle.id },
        data: { status: 'AVAILABLE' },
      });
    }

    assertTransition('rentalVehicle', newVehicle.status, 'RESERVED');
    const updatedNewVehicle = await tx.rentalVehicle.update({
      where: { id: newVehicle.id },
      data: { status: 'RESERVED' },
    });

    const updatedRes = await tx.vehicleReservation.update({
      where: { id: res.id },
      data: {
        rentalVehicleId: updatedNewVehicle.id,
        hubId: updatedNewVehicle.hubId,
      },
    });

    const hubIds =
      res.hubId === updatedNewVehicle.hubId
        ? [res.hubId]
        : [res.hubId, updatedNewVehicle.hubId];

    return {
      kind: 'CHANGED' as const,
      hubIds,
      dto: toReservationDto(updatedRes, updatedNewVehicle, now, false),
    };
  });

  for (const hubId of outcome.hubIds) {
    events.emit('RESERVATION_CHANGED', { hubId });
  }

  if (outcome.kind === 'EXPIRED') {
    throwHoldExpired();
  }

  return outcome.dto;
}

/**
 * BR-03, D-02, ARCHITECTURE §6.3: Expire due CONFIRMED vehicle reservation holds.
 * Selects due IDs without lock, then processes each ID in its own small transaction
 * locking the vehicle first, then the reservation, and re-checking the condition.
 */
export async function expireVehicleHolds(now: Date = new Date()): Promise<number> {
  const dueRows = await db.vehicleReservation.findMany({
    where: {
      status: 'CONFIRMED',
      expiresAt: { lte: now },
    },
    select: { id: true },
  });

  let expiredCount = 0;

  for (const due of dueRows) {
    try {
      const result = await db.$transaction(async (tx) => {
        let lockedVehicleId: string | null = null;
        let res: PrismaVehicleReservation | null = null;

        for (let attempt = 0; attempt < LOCK_RETRY_ATTEMPTS; attempt++) {
          const unlocked = await tx.vehicleReservation.findUnique({
            where: { id: due.id },
          });
          if (
            !unlocked ||
            unlocked.status !== 'CONFIRMED' ||
            unlocked.expiresAt.getTime() > now.getTime()
          ) {
            return null;
          }

          await lockRow(tx, 'rental_vehicle', unlocked.rentalVehicleId);
          await lockRow(tx, 'vehicle_reservation', due.id);

          const reread = await tx.vehicleReservation.findUniqueOrThrow({
            where: { id: due.id },
          });
          if (
            reread.status !== 'CONFIRMED' ||
            reread.expiresAt.getTime() > now.getTime()
          ) {
            return null;
          }

          if (reread.rentalVehicleId === unlocked.rentalVehicleId) {
            lockedVehicleId = unlocked.rentalVehicleId;
            res = reread;
            break;
          }
        }

        if (!res || !lockedVehicleId) {
          return null;
        }

        const vehicle = await tx.rentalVehicle.findUniqueOrThrow({
          where: { id: lockedVehicleId },
        });

        await applyHoldExpiryInTx(tx, res, vehicle);
        return { hubId: res.hubId };
      });

      if (result) {
        expiredCount += 1;
        events.emit('RESERVATION_CHANGED', { hubId: result.hubId });
      }
    } catch (err: unknown) {
      console.error(`[reservations.tick] failed to expire vehicle hold "${due.id}"`, err);
    }
  }

  return expiredCount;
}
