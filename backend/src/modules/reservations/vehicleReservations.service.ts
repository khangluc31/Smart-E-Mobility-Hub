// Vehicle reservations service: reserve, current, cancel, change vehicle, and hold expiry
// (FR-06, FR-07, FR-08, FR-09, BR-01, BR-02, BR-03, BR-05, BR-10, NFR-08, NFR-21).

import {
  Prisma,
  type ChargingRequest as PrismaChargingRequest,
  type RentalVehicle as PrismaRentalVehicle,
  type VehicleReservation as PrismaVehicleReservation,
} from '@prisma/client';
import { config } from '../../core/config';
import { db, lockRow, type DbClient, type Tx } from '../../core/db';
import { AppError, badRequest, conflict, notFound } from '../../core/errors';
import { events } from '../../core/events';
import { withIdempotency } from '../../core/idempotency';
import { notify } from '../../core/notify';
import { assertTransition } from '../../core/stateMachine';
import { addMinutes } from '../../core/time';
import { buildHubProjection, toRequestView } from '../charging/charging.service';
import { cancelQueuedForVehicle, createQueueRequest } from '../charging/chargingRequests.service';
import { isDegraded } from '../hubs/hubs.metrics';
import { alternativeHubs } from '../hubs/hubs.service';
import type { ChargingRequestView } from '../../types/charging';
import type { Alternative } from '../../types/common';
import type { RentalVehicleType } from '../../types/enums';
import type { IncidentImpact } from '../../types/incidents';
import type { VehicleReservation, VehicleReturnResult } from '../../types/reservations';
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
  const cancelledChargingRef: { current: { hubId: string; requestId: string } | null } = {
    current: null,
  };

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

            // D-18: reserving a vehicle that is QUEUED for charging cancels that queued request
            // inside the same transaction (lock order: rental_vehicle -> vehicle_reservation -> charging_request).
            cancelledChargingRef.current = await cancelQueuedForVehicle(tx, updatedVehicle.id, now);

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
      if (cancelledChargingRef.current) {
        events.emit('CHARGING_QUEUE_CHANGED', { hubId: cancelledChargingRef.current.hubId });
      }
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
 * Shared lock-and-re-read helper (ARCHITECTURE §4.1, T-11/T-12 Rule 2):
 * 1. Unlocked read of the reservation to discover `rentalVehicleId` and verify ownership (404).
 * 2. Lock `rental_vehicle` first.
 * 3. Optional callback to lock a secondary resource (`parking_space`) while respecting
 *    the global `rental_vehicle -> parking_space -> vehicle_reservation` lock order.
 * 4. Lock `vehicle_reservation` and re-read; retry once if `rentalVehicleId` drifted.
 */
async function lockOwnedReservation<TExtra = undefined>(
  tx: Tx,
  userId: string,
  id: string,
  afterVehicleLock?: (vehicle: PrismaRentalVehicle) => Promise<TExtra>,
): Promise<{
  reservation: PrismaVehicleReservation;
  vehicle: PrismaRentalVehicle;
  extra: TExtra;
}> {
  for (let attempt = 0; attempt < LOCK_RETRY_ATTEMPTS; attempt++) {
    const unlocked = await tx.vehicleReservation.findUnique({ where: { id } });
    if (!unlocked || unlocked.userId !== userId) {
      throw notFound('Vehicle reservation');
    }

    await lockRow(tx, 'rental_vehicle', unlocked.rentalVehicleId);
    const vehicle = await tx.rentalVehicle.findUniqueOrThrow({
      where: { id: unlocked.rentalVehicleId },
    });

    const extra = afterVehicleLock
      ? await afterVehicleLock(vehicle)
      : (undefined as TExtra);

    await lockRow(tx, 'vehicle_reservation', id);

    const reread = await tx.vehicleReservation.findUniqueOrThrow({ where: { id } });
    if (reread.userId !== userId) {
      throw notFound('Vehicle reservation');
    }

    if (reread.rentalVehicleId === unlocked.rentalVehicleId) {
      return { reservation: reread, vehicle, extra };
    }
  }

  throw conflict('RESOURCE_TAKEN', 'Reservation was modified concurrently.', {
    nextActions: ['Reload and try again.'],
  });
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
    const { reservation: res, vehicle } = await lockOwnedReservation(tx, userId, id);

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
 * FR-11, ARCHITECTURE §6.2, T-12 Rule 3:
 * Pick up a reserved vehicle within the hold window.
 * Lock order: `rental_vehicle` → current `parking_space` (if any) → `vehicle_reservation`.
 * Frees the former FLEET space (OCCUPIED → FREE; UNAVAILABLE stays UNAVAILABLE).
 */
export async function pickUp(
  userId: string,
  id: string,
  now: Date = new Date(),
): Promise<VehicleReservation> {
  const outcome = await db.$transaction(async (tx) => {
    const { reservation: res, vehicle } = await lockOwnedReservation(
      tx,
      userId,
      id,
      async (lockedVeh) => {
        if (lockedVeh.parkingSpaceId) {
          await lockRow(tx, 'parking_space', lockedVeh.parkingSpaceId);
        }
        return undefined;
      },
    );

    // Step 2: reservation must be CONFIRMED (else 409 INVALID_STATE_TRANSITION + D-22 audit)
    if (res.status !== 'CONFIRMED') {
      assertTransition('reservation', res.status, 'ACTIVE');
    }

    // Step 3: CONFIRMED but hold expired -> expire & commit, then throw 409 HOLD_EXPIRED
    if (res.expiresAt.getTime() <= now.getTime()) {
      await applyHoldExpiryInTx(tx, res, vehicle);
      return { kind: 'EXPIRED' as const, hubId: res.hubId };
    }

    // Step 4: FAULTY vehicle -> 409 NOT_ELIGIBLE (no state change)
    if (vehicle.status === 'FAULTY') {
      throw conflict('NOT_ELIGIBLE', 'This vehicle has been reported faulty.', {
        nextActions: ['Search and reserve another available vehicle.'],
      });
    }

    // Step 5: transitions & updates (reservation, vehicle, former FLEET space)
    assertTransition('reservation', res.status, 'ACTIVE');
    assertTransition('rentalVehicle', vehicle.status, 'IN_USE');

    const formerSpaceId = vehicle.parkingSpaceId;

    const updatedRes = await tx.vehicleReservation.update({
      where: { id: res.id },
      data: {
        status: 'ACTIVE',
        pickedUpAt: now,
        startBatteryPct: vehicle.batteryPct,
      },
    });

    const updatedVehicle = await tx.rentalVehicle.update({
      where: { id: vehicle.id },
      data: {
        status: 'IN_USE',
        parkingSpaceId: null,
      },
    });

    if (formerSpaceId) {
      const space = await tx.parkingSpace.findUnique({
        where: { id: formerSpaceId },
      });
      if (space && space.status === 'OCCUPIED') {
        assertTransition('parkingSpace', space.status, 'FREE');
        await tx.parkingSpace.update({
          where: { id: space.id },
          data: { status: 'FREE' },
        });
      }
    }

    const chargingSet = await isVehicleCharging(tx, [updatedVehicle.id]);
    return {
      kind: 'ACTIVE' as const,
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

export interface ReturnRequestChargingInput {
  targetPct: number;
  neededBy?: Date | null;
}

export interface ReturnVehicleInput {
  hubId: string;
  requestCharging?: ReturnRequestChargingInput;
}

/**
 * FR-12, BR-02, BR-04, BR-10, BR-13, D-13, D-14, D-16, D-17, T-12/T-19:
 * Return an ACTIVE rental to any non-degraded Hub with a free FLEET MOTORCYCLE space.
 * Uses `FOR UPDATE SKIP LOCKED` to claim a free FLEET space without double-allocation.
 * Optionally queues a RENTAL charging request in the same transaction (all-or-nothing, D-13).
 */
export async function returnVehicle(
  userId: string,
  id: string,
  input: ReturnVehicleInput,
  now: Date = new Date(),
): Promise<VehicleReturnResult> {
  // Step 1: pre-transaction validation (no state change)
  if (input.requestCharging !== undefined) {
    const { targetPct, neededBy } = input.requestCharging;
    if (
      typeof targetPct !== 'number' ||
      !Number.isFinite(targetPct) ||
      targetPct <= 0 ||
      targetPct > 100
    ) {
      throw badRequest(
        'requestCharging.targetPct must be greater than 0 and at most 100.',
        'requestCharging.targetPct',
      );
    }
    if (neededBy !== undefined && neededBy !== null && neededBy.getTime() <= now.getTime()) {
      throw badRequest(
        'requestCharging.neededBy must be in the future.',
        'requestCharging.neededBy',
      );
    }
  }

  const returnHub = await db.hub.findUnique({ where: { id: input.hubId } });
  if (!returnHub) {
    throw badRequest(`Unknown Hub "${input.hubId}".`, 'hubId', [
      'Choose an existing Hub ID from GET /api/hubs.',
    ]);
  }

  if (
    isDegraded(
      returnHub.lastTelemetryAt,
      now,
      config.STALLED_FEED_INTERVALS,
      config.TELEMETRY_INTERVAL_SEC,
    )
  ) {
    const alternatives = await alternativeHubs(
      {
        need: 'FLEET_PARKING',
        vehicleClass: 'MOTORCYCLE',
        excludeHubId: returnHub.id,
      },
      now,
      db,
    );
    throw new AppError(400, 'VALIDATION_ERROR', 'Hub data is stale.', {
      nextActions:
        alternatives.length > 0
          ? ['Return the vehicle to one of the alternative Hubs.']
          : ['Wait for telemetry to resume or try another Hub.'],
      alternatives,
      details: { field: 'hubId' },
    });
  }

  // Step 2–5: atomic return transaction
  const outcome = await db.$transaction(async (tx) => {
    const {
      reservation: res,
      vehicle,
      extra: freeSpaceId,
    } = await lockOwnedReservation<string | null>(tx, userId, id, async () => {
      const freeSpaces = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM parking_space
        WHERE "hubId" = ${returnHub.id}
          AND pool = 'FLEET'
          AND "vehicleClass" = 'MOTORCYCLE'
          AND status = 'FREE'
          AND "reservedForTaskId" IS NULL
        ORDER BY id
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      `;
      return freeSpaces[0]?.id ?? null;
    });

    // Step 3: check ACTIVE -> COMPLETED before HUB_FULL so finished rentals never report HUB_FULL
    assertTransition('reservation', res.status, 'COMPLETED');

    // Step 5 (faulty guard): FAULTY vehicle during ride -> 409 NOT_ELIGIBLE (incident flow closes it)
    if (vehicle.status === 'FAULTY') {
      throw conflict(
        'NOT_ELIGIBLE',
        'This vehicle is marked faulty and cannot be returned through the normal flow.',
        {
          nextActions: ['Contact operations; the incident flow handles faulty rentals.'],
        },
      );
    }

    // Step 4: no free FLEET space -> 409 HUB_FULL + alternatives; transaction rolls back cleanly
    if (!freeSpaceId) {
      const alternatives = await alternativeHubs(
        {
          need: 'FLEET_PARKING',
          vehicleClass: 'MOTORCYCLE',
          excludeHubId: returnHub.id,
        },
        now,
        tx,
      );
      const nextActions =
        alternatives.length > 0
          ? ['Return the vehicle to one of the alternative Hubs.']
          : ['No Hub has free FLEET parking space right now; try again shortly.'];
      throw conflict(
        'HUB_FULL',
        `Hub "${returnHub.name}" has no free FLEET motorcycle parking spaces.`,
        {
          nextActions,
          alternatives,
        },
      );
    }

    // Step 5: space FREE -> OCCUPIED; vehicle IN_USE -> AVAILABLE | LOW_BATTERY; reservation ACTIVE -> COMPLETED
    assertTransition('parkingSpace', 'FREE', 'OCCUPIED');
    await tx.parkingSpace.update({
      where: { id: freeSpaceId },
      data: { status: 'OCCUPIED' },
    });

    // BR-02 & D-17: battery comes from the vehicle row (telemetry), never from the request body
    const nextVehicleStatus =
      vehicle.batteryPct >= config.MIN_RENTAL_BATTERY_PCT
        ? 'AVAILABLE'
        : 'LOW_BATTERY';
    assertTransition('rentalVehicle', vehicle.status, nextVehicleStatus);

    const updatedVehicle = await tx.rentalVehicle.update({
      where: { id: vehicle.id },
      data: {
        hubId: returnHub.id,
        parkingSpaceId: freeSpaceId,
        status: nextVehicleStatus,
      },
    });

    const updatedRes = await tx.vehicleReservation.update({
      where: { id: res.id },
      data: {
        status: 'COMPLETED',
        returnedAt: now,
        returnHubId: returnHub.id,
        endBatteryPct: vehicle.batteryPct,
        endReason: 'RETURNED',
      },
    });

    // D-13: optional charging on return in the same transaction (all-or-nothing).
    let createdCharging: PrismaChargingRequest | null = null;
    if (input.requestCharging !== undefined) {
      if (input.requestCharging.targetPct <= vehicle.batteryPct) {
        throw badRequest(
          `Battery is already at ${vehicle.batteryPct}%; return without charging or pick a higher target.`,
          'requestCharging.targetPct',
          [
            'Return the vehicle without charging.',
            'Pick a targetPct higher than the current battery level.',
          ],
        );
      }

      createdCharging = await createQueueRequest(
        tx,
        {
          requestedById: userId,
          ownerId: userId,
          vehicleKind: 'RENTAL',
          rentalVehicleId: vehicle.id,
          vehicleClass: 'MOTORCYCLE',
          hubId: returnHub.id,
          targetPct: input.requestCharging.targetPct,
          currentPct: vehicle.batteryPct,
          desiredTime: now,
          neededBy: input.requestCharging.neededBy ?? null,
        },
        now,
      );
    }

    const hubIds =
      res.hubId === returnHub.id ? [res.hubId] : [res.hubId, returnHub.id];

    const chargingSet = await isVehicleCharging(tx, [updatedVehicle.id]);
    return {
      hubIds,
      reservation: toReservationDto(
        updatedRes,
        updatedVehicle,
        now,
        chargingSet.has(updatedVehicle.id),
      ),
      createdCharging,
    };
  });

  // Compute projection before emitting so the 200 response carries QUEUED position/estimates.
  let chargingRequest: ChargingRequestView | null = null;
  if (outcome.createdCharging) {
    const bundle = await buildHubProjection(db, outcome.createdCharging.hubId, now);
    chargingRequest = toRequestView(outcome.createdCharging, bundle.projection, now);
  }

  for (const hubId of outcome.hubIds) {
    events.emit('RESERVATION_CHANGED', { hubId });
  }
  if (outcome.createdCharging) {
    events.emit('CHARGING_QUEUE_CHANGED', { hubId: outcome.createdCharging.hubId });
  }

  return {
    reservation: outcome.reservation,
    chargingRequest,
  };
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

    // D-18: cancel any QUEUED charging request on the newly reserved vehicle.
    const cancelledCharging = await cancelQueuedForVehicle(tx, updatedNewVehicle.id, now);

    const hubIds =
      res.hubId === updatedNewVehicle.hubId
        ? [res.hubId]
        : [res.hubId, updatedNewVehicle.hubId];

    return {
      kind: 'CHANGED' as const,
      hubIds,
      cancelledCharging,
      dto: toReservationDto(updatedRes, updatedNewVehicle, now, false),
    };
  });

  for (const hubId of outcome.hubIds) {
    events.emit('RESERVATION_CHANGED', { hubId });
  }
  if (outcome.kind === 'CHANGED' && outcome.cancelledCharging) {
    events.emit('CHARGING_QUEUE_CHANGED', { hubId: outcome.cancelledCharging.hubId });
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

export interface RecoverVehicleInput {
  id: string;
  hubId: string;
  type: RentalVehicleType;
  batteryPct: number;
}

/**
 * FR-39, FR-40, BR-02, BR-07, D-18 (T-22 Rule 4): Recover CONFIRMED and ACTIVE vehicle
 * reservations on a withdrawn FAULTY rental vehicle inside the caller's incident transaction
 * (withdrawn vehicle row is already locked).
 * - CONFIRMED -> reassign to an eligible AVAILABLE vehicle at the same Hub (battery >= MIN,
 *   not CHARGING, same type preferred, SKIP LOCKED; expiresAt & hubId kept) + RESERVATION_REASSIGNED,
 *   or CANCELLED (endReason INCIDENT) + RESERVATION_CANCELLED.
 * - ACTIVE -> COMPLETED (endReason INCIDENT, endBatteryPct = vehicle.batteryPct) + RENTAL_ENDED_INCIDENT.
 */
export async function recoverVehicleBookings(
  tx: Tx,
  vehicle: RecoverVehicleInput,
  now: Date = new Date(),
): Promise<IncidentImpact[]> {
  const candidates = await tx.vehicleReservation.findMany({
    where: {
      rentalVehicleId: vehicle.id,
      status: { in: ['CONFIRMED', 'ACTIVE'] },
    },
    orderBy: { id: 'asc' },
    select: { id: true },
  });

  const impacts: IncidentImpact[] = [];

  for (const candidate of candidates) {
    // Lock order: withdrawn rental_vehicle [already locked] -> vehicle_reservation.
    // Replacement vehicles are picked via FOR UPDATE SKIP LOCKED (never waits, cannot deadlock).
    await lockRow(tx, 'vehicle_reservation', candidate.id);

    const res = await tx.vehicleReservation.findUnique({ where: { id: candidate.id } });
    if (
      !res ||
      res.rentalVehicleId !== vehicle.id ||
      (res.status !== 'CONFIRMED' && res.status !== 'ACTIVE')
    ) {
      continue;
    }

    if (res.status === 'CONFIRMED') {
      // BR-02, BR-10, D-18: eligible replacement at the same Hub, same type preferred.
      // SKIP LOCKED never waits, so taking a replacement resource after locking bookings cannot deadlock.
      const replacements = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT rv.id
        FROM rental_vehicle rv
        WHERE rv."hubId" = ${vehicle.hubId}
          AND rv.id != ${vehicle.id}
          AND rv.status = 'AVAILABLE'::"RentalVehicleStatus"
          AND rv."batteryPct" >= ${config.MIN_RENTAL_BATTERY_PCT}
          AND NOT EXISTS (
            SELECT 1
            FROM charging_request cr
            WHERE cr."rentalVehicleId" = rv.id
              AND cr.status = 'CHARGING'::"ChargingRequestStatus"
          )
        ORDER BY
          CASE WHEN rv.type = ${vehicle.type}::"RentalVehicleType" THEN 0 ELSE 1 END,
          rv."batteryPct" DESC,
          rv.id ASC
        LIMIT 1
        FOR UPDATE OF rv SKIP LOCKED
      `;

      const replacementId = replacements[0]?.id ?? null;

      if (replacementId) {
        assertTransition('rentalVehicle', 'AVAILABLE', 'RESERVED');
        await tx.rentalVehicle.update({
          where: { id: replacementId },
          data: { status: 'RESERVED' },
        });

        await tx.vehicleReservation.update({
          where: { id: res.id },
          data: { rentalVehicleId: replacementId },
        });

        // D-18: reserving the replacement vehicle cancels any QUEUED charging request on it.
        await cancelQueuedForVehicle(tx, replacementId, now);

        await notify(tx, {
          userId: res.userId,
          type: 'RESERVATION_REASSIGNED',
          title: 'Vehicle reservation reassigned',
          body: `Your reservation at Hub ${res.hubId} was moved from vehicle ${vehicle.id} to ${replacementId}.`,
          data: {
            reservationId: res.id,
            oldVehicleId: vehicle.id,
            newVehicleId: replacementId,
            hubId: res.hubId,
          },
        });

        impacts.push({
          bookingType: 'VEHICLE_RESERVATION',
          bookingId: res.id,
          userId: res.userId,
          outcome: 'REASSIGNED',
          newResourceId: replacementId,
        });
      } else {
        assertTransition('reservation', res.status, 'CANCELLED');
        await tx.vehicleReservation.update({
          where: { id: res.id },
          data: {
            status: 'CANCELLED',
            endReason: 'INCIDENT',
          },
        });

        await notify(tx, {
          userId: res.userId,
          type: 'RESERVATION_CANCELLED',
          title: 'Vehicle reservation cancelled',
          body: `Your reservation for vehicle ${vehicle.id} at Hub ${res.hubId} was cancelled because the vehicle became faulty and no replacement was available.`,
          data: {
            reservationId: res.id,
            vehicleId: vehicle.id,
            hubId: res.hubId,
            reason: 'INCIDENT',
          },
        });

        impacts.push({
          bookingType: 'VEHICLE_RESERVATION',
          bookingId: res.id,
          userId: res.userId,
          outcome: 'CANCELLED',
          newResourceId: null,
        });
      }
    } else {
      // ACTIVE rental: cannot swap mid-ride; end with endReason INCIDENT and vehicle's batteryPct.
      assertTransition('reservation', res.status, 'COMPLETED');
      await tx.vehicleReservation.update({
        where: { id: res.id },
        data: {
          status: 'COMPLETED',
          endReason: 'INCIDENT',
          returnedAt: now,
          endBatteryPct: vehicle.batteryPct,
        },
      });

      await notify(tx, {
        userId: res.userId,
        type: 'RENTAL_ENDED_INCIDENT',
        title: 'Rental ended due to vehicle incident',
        body: `Your rental of vehicle ${vehicle.id} was ended due to a reported fault. Please park it safely.`,
        data: {
          reservationId: res.id,
          vehicleId: vehicle.id,
          hubId: res.hubId,
          endBatteryPct: vehicle.batteryPct,
        },
      });

      impacts.push({
        bookingType: 'VEHICLE_RESERVATION',
        bookingId: res.id,
        userId: res.userId,
        outcome: 'ENDED',
        newResourceId: null,
      });
    }
  }

  return impacts;
}
