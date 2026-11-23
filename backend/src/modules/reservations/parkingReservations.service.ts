// Parking reservations service: availability, reserve, cancel, change window, claim,
// leave, and parkingTick (FR-14..FR-19, BR-03, BR-05, BR-10, BR-13, NFR-08, D-16).
// Lock order: parking_space -> parking_reservation (ARCHITECTURE §4.1).

import type {
  ParkingReservation as PrismaParkingReservation,
  ParkingSpace as PrismaParkingSpace,
} from '@prisma/client';
import { config } from '../../core/config';
import { db, lockRow, type DbClient, type Tx } from '../../core/db';
import { badRequest, conflict, notFound } from '../../core/errors';
import { events } from '../../core/events';
import { withIdempotency } from '../../core/idempotency';
import { notify } from '../../core/notify';
import { assertTransition } from '../../core/stateMachine';
import { addMinutes } from '../../core/time';
import { isDegraded } from '../hubs/hubs.metrics';
import { alternativeHubs } from '../hubs/hubs.service';
import type { Alternative } from '../../types/common';
import type { VehicleClass } from '../../types/enums';
import type { ParkingAvailability, ParkingReservation } from '../../types/reservations';

// CONTRACTS §5: start ≥ now − 1 min (clock skew)
export const WINDOW_START_GRACE_MS = 60_000;

const MS_PER_HOUR = 3_600_000;
const LOCK_RETRY_ATTEMPTS = 2;

export interface ParkingAvailabilityQuery {
  hubId: string;
  vehicleClass: VehicleClass;
  from: Date;
  to: Date;
}

export interface ReserveParkingInput {
  hubId: string;
  vehicleClass: VehicleClass;
  privateEvId?: string;
  windowStart: Date;
  windowEnd: Date;
}

export interface ReserveParkingOptions {
  idemKey?: string;
  tx?: Tx;
  bookingGroupId?: string;
  now?: Date;
}

export interface ChangeParkingWindowInput {
  windowStart: Date;
  windowEnd: Date;
}

export function toParkingDto(
  row: PrismaParkingReservation,
  now: Date = new Date(),
): ParkingReservation {
  return {
    id: row.id,
    status: row.status,
    hubId: row.hubId,
    parkingSpaceId: row.parkingSpaceId,
    vehicleClass: row.vehicleClass,
    privateEvId: row.privateEvId ?? null,
    windowStart: row.windowStart.toISOString(),
    windowEnd: row.windowEnd.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    claimedAt: row.claimedAt ? row.claimedAt.toISOString() : null,
    bookingGroupId: row.bookingGroupId ?? null,
    serverNow: now.toISOString(),
  };
}

function computeHoldExpiresAt(windowStart: Date, windowEnd: Date): Date {
  const holdEnd = addMinutes(windowStart, config.RESERVATION_HOLD_MIN);
  return holdEnd.getTime() < windowEnd.getTime() ? holdEnd : windowEnd;
}

function validateParkingWindow(
  start: Date,
  end: Date,
  now: Date,
  startField: string,
  endField: string,
): void {
  if (end.getTime() <= start.getTime()) {
    throw badRequest(`${endField} must be after ${startField}.`, endField, [
      `Choose a ${endField} after ${startField}.`,
    ]);
  }
  const maxWindowMs = config.PARKING_MAX_WINDOW_H * MS_PER_HOUR;
  if (end.getTime() - start.getTime() > maxWindowMs) {
    throw badRequest(
      `Parking window cannot exceed ${config.PARKING_MAX_WINDOW_H} hours.`,
      endField,
      [`Shorten the parking window to at most ${config.PARKING_MAX_WINDOW_H} hours.`],
    );
  }
  if (start.getTime() < now.getTime() - WINDOW_START_GRACE_MS) {
    throw badRequest(`${startField} cannot be in the past.`, startField, [
      'Choose a start time starting now or in the future.',
    ]);
  }
}

function isExclusionViolation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: unknown; meta?: unknown; message?: unknown };
  if (e.code === '23P01') return true;
  const metaText = e.meta ? JSON.stringify(e.meta) : '';
  const msgText = typeof e.message === 'string' ? e.message : '';
  return (
    metaText.includes('23P01') ||
    metaText.includes('ex_parking_overlap') ||
    msgText.includes('23P01') ||
    msgText.includes('ex_parking_overlap')
  );
}

function throwNoCapacity(hubLabel: string, alternatives: Alternative[]): never {
  const nextActions =
    alternatives.length > 0
      ? ['Choose one of the alternative Hubs with free PUBLIC parking for this window.']
      : ['No Hub has free PUBLIC parking for this window; try a different time window.'];

  throw conflict(
    'NO_CAPACITY',
    `No free PUBLIC parking spaces available at "${hubLabel}" for the requested window.`,
    {
      nextActions,
      alternatives,
    },
  );
}

function throwHoldExpired(): never {
  throw conflict('HOLD_EXPIRED', 'This parking reservation hold has expired.', {
    nextActions: ['Search availability and create a new parking reservation.'],
  });
}

/**
 * Shared lock-and-re-read helper (ARCHITECTURE §4.1, T-13 Rule 11):
 * Lock order: `parking_space` first, then `parking_reservation`, re-read and
 * retry once if `parkingSpaceId` drifted concurrently.
 */
async function lockOwnedParkingReservation(
  tx: Tx,
  userId: string,
  id: string,
): Promise<{
  reservation: PrismaParkingReservation;
  space: PrismaParkingSpace;
}> {
  for (let attempt = 0; attempt < LOCK_RETRY_ATTEMPTS; attempt++) {
    const unlocked = await tx.parkingReservation.findUnique({ where: { id } });
    if (!unlocked || unlocked.userId !== userId) {
      throw notFound('Parking reservation');
    }

    await lockRow(tx, 'parking_space', unlocked.parkingSpaceId);
    await lockRow(tx, 'parking_reservation', id);

    const reread = await tx.parkingReservation.findUniqueOrThrow({ where: { id } });
    if (reread.userId !== userId) {
      throw notFound('Parking reservation');
    }

    if (reread.parkingSpaceId === unlocked.parkingSpaceId) {
      const space = await tx.parkingSpace.findUniqueOrThrow({
        where: { id: reread.parkingSpaceId },
      });
      return { reservation: reread, space };
    }
  }

  throw conflict('RESOURCE_TAKEN', 'Parking reservation was modified concurrently.', {
    nextActions: ['Reload and try again.'],
  });
}

async function applyParkingExpiryInTx(
  tx: Tx,
  res: PrismaParkingReservation,
  space: PrismaParkingSpace,
): Promise<void> {
  assertTransition('reservation', res.status, 'EXPIRED');
  await tx.parkingReservation.update({
    where: { id: res.id },
    data: { status: 'EXPIRED' },
  });

  if (space.status === 'RESERVED') {
    assertTransition('parkingSpace', space.status, 'FREE');
    await tx.parkingSpace.update({
      where: { id: space.id },
      data: { status: 'FREE' },
    });
  }

  await notify(tx, {
    userId: res.userId,
    type: 'RESERVATION_EXPIRED',
    title: 'Parking reservation expired',
    body: `Your parking reservation for space ${res.parkingSpaceId} at Hub ${res.hubId} has expired.`,
    data: {
      parkingReservationId: res.id,
      hubId: res.hubId,
      parkingSpaceId: res.parkingSpaceId,
    },
  });
}

/**
 * FR-14, D-16: Count PUBLIC spaces of the class at the Hub that are not UNAVAILABLE
 * and have no overlapping CONFIRMED/ACTIVE reservation for `[from, to)`.
 */
export async function getAvailability(
  query: ParkingAvailabilityQuery,
  now: Date = new Date(),
  client: DbClient = db,
): Promise<ParkingAvailability> {
  validateParkingWindow(query.from, query.to, now, 'from', 'to');

  const hub = await client.hub.findUnique({ where: { id: query.hubId } });
  if (!hub) {
    throw badRequest(`Unknown Hub "${query.hubId}".`, 'hubId', [
      'Choose an existing Hub ID from GET /api/hubs.',
    ]);
  }

  const [total, freeRows] = await Promise.all([
    client.parkingSpace.count({
      where: {
        hubId: hub.id,
        pool: 'PUBLIC',
        vehicleClass: query.vehicleClass,
        status: { not: 'UNAVAILABLE' },
      },
    }),
    client.$queryRaw<Array<{ free: bigint }>>`
      SELECT COUNT(*)::bigint AS free
      FROM parking_space ps
      WHERE ps."hubId" = ${hub.id}
        AND ps.pool = 'PUBLIC'::"ParkingPool"
        AND ps."vehicleClass" = ${query.vehicleClass}::"VehicleClass"
        AND ps.status != 'UNAVAILABLE'::"ParkingSpaceStatus"
        AND NOT EXISTS (
          SELECT 1
          FROM parking_reservation pr
          WHERE pr."parkingSpaceId" = ps.id
            AND pr.status IN ('CONFIRMED', 'ACTIVE')
            AND pr."windowStart" < ${query.to}
            AND pr."windowEnd" > ${query.from}
        )
    `,
  ]);

  const free = Number(freeRows[0]?.free ?? 0n);
  const hubDegraded = isDegraded(
    hub.lastTelemetryAt,
    now,
    config.STALLED_FEED_INTERVALS,
    config.TELEMETRY_INTERVAL_SEC,
  );

  const alternatives =
    free === 0 || hubDegraded
      ? await alternativeHubs(
          {
            need: 'PUBLIC_PARKING',
            vehicleClass: query.vehicleClass,
            excludeHubId: hub.id,
            from: query.from,
            to: query.to,
          },
          now,
          client,
        )
      : [];

  return {
    hubId: hub.id,
    vehicleClass: query.vehicleClass,
    free,
    total,
    alternatives,
  };
}

/**
 * FR-15, BR-10, BR-13, NFR-08, D-16:
 * Reserve a PUBLIC parking space for `[windowStart, windowEnd)`.
 * When `opts.tx` is supplied (e.g. T-14 combined booking), executes directly inside
 * the caller's transaction and skips idempotency and event emission.
 */
export async function reserveParking(
  userId: string,
  input: ReserveParkingInput,
  opts: ReserveParkingOptions = {},
): Promise<ParkingReservation> {
  if (opts.tx && opts.idemKey) {
    throw new Error(
      'reserveParking: cannot combine opts.tx with opts.idemKey; caller owns idempotency.',
    );
  }

  const now = opts.now ?? new Date();
  validateParkingWindow(
    input.windowStart,
    input.windowEnd,
    now,
    'windowStart',
    'windowEnd',
  );

  const hubClient: DbClient = opts.tx ?? db;
  const hub = await hubClient.hub.findUnique({ where: { id: input.hubId } });
  if (!hub) {
    throw badRequest(`Unknown Hub "${input.hubId}".`, 'hubId', [
      'Choose an existing Hub ID from GET /api/hubs.',
    ]);
  }

  const runReserve = async (tx: Tx): Promise<ParkingReservation> => {
    // Step 2: optional privateEvId ownership + soft-delete + class check
    // read-only; private-evs (T-14) imports reservations, not the other way round
    if (input.privateEvId !== undefined) {
      const ev = await tx.privateEv.findUnique({
        where: { id: input.privateEvId },
      });
      if (!ev || ev.ownerId !== userId || ev.deletedAt !== null) {
        throw notFound('Private EV');
      }
      if (ev.vehicleClass !== input.vehicleClass) {
        throw conflict(
          'CLASS_MISMATCH',
          `Private EV class (${ev.vehicleClass}) does not match requested parking class (${input.vehicleClass}).`,
          {
            nextActions: [`Reserve a ${ev.vehicleClass} parking space for this EV.`],
          },
        );
      }
    }

    // Step 3: pick one free PUBLIC space for [windowStart, windowEnd)
    // Known limit (T-13 Rule 5): SKIP LOCKED also skips a space another transaction
    // is reserving for a different window, so under heavy concurrency a request may
    // receive NO_CAPACITY while a space is technically free; the last-space race
    // still guarantees exactly one winner.
    const freeSpaces = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT ps.id
      FROM parking_space ps
      WHERE ps."hubId" = ${hub.id}
        AND ps.pool = 'PUBLIC'::"ParkingPool"
        AND ps."vehicleClass" = ${input.vehicleClass}::"VehicleClass"
        AND ps.status != 'UNAVAILABLE'::"ParkingSpaceStatus"
        AND NOT EXISTS (
          SELECT 1
          FROM parking_reservation pr
          WHERE pr."parkingSpaceId" = ps.id
            AND pr.status IN ('CONFIRMED', 'ACTIVE')
            AND pr."windowStart" < ${input.windowEnd}
            AND pr."windowEnd" > ${input.windowStart}
        )
      ORDER BY ps.id
      LIMIT 1
      FOR UPDATE OF ps SKIP LOCKED
    `;

    const spaceId = freeSpaces[0]?.id;
    if (!spaceId) {
      const alternatives = await alternativeHubs(
        {
          need: 'PUBLIC_PARKING',
          vehicleClass: input.vehicleClass,
          excludeHubId: hub.id,
          from: input.windowStart,
          to: input.windowEnd,
        },
        now,
        tx,
      );
      throwNoCapacity(hub.name, alternatives);
    }

    // Step 5: insert CONFIRMED reservation; space status stays unchanged until windowStart
    const expiresAt = computeHoldExpiresAt(input.windowStart, input.windowEnd);
    const created = await tx.parkingReservation.create({
      data: {
        userId,
        parkingSpaceId: spaceId,
        hubId: hub.id,
        vehicleClass: input.vehicleClass,
        privateEvId: input.privateEvId ?? null,
        windowStart: input.windowStart,
        windowEnd: input.windowEnd,
        status: 'CONFIRMED',
        expiresAt,
        bookingGroupId: opts.bookingGroupId ?? null,
        idempotencyKey: opts.idemKey ?? null,
      },
    });

    return toParkingDto(created, now);
  };

  try {
    if (opts.tx) {
      return await runReserve(opts.tx);
    }

    const outcome = await db.$transaction(async (tx) => {
      return withIdempotency(
        tx,
        {
          userId,
          key: opts.idemKey,
          endpoint: 'POST /api/parking-reservations',
          now,
        },
        async () => ({
          status: 201,
          body: await runReserve(tx),
        }),
      );
    });

    if (!outcome.replayed) {
      events.emit('RESERVATION_CHANGED', { hubId: outcome.body.hubId });
    }
    return outcome.body;
  } catch (err: unknown) {
    if (isExclusionViolation(err)) {
      // Exclusion violation aborted the transaction; query alternatives with plain db.
      const alternatives = await alternativeHubs(
        {
          need: 'PUBLIC_PARKING',
          vehicleClass: input.vehicleClass,
          excludeHubId: hub.id,
          from: input.windowStart,
          to: input.windowEnd,
        },
        now,
        db,
      );
      throwNoCapacity(hub.name, alternatives);
    }
    throw err;
  }
}

/**
 * FR-16, Rule 6: Cancel a CONFIRMED parking reservation.
 * If CONFIRMED and `expiresAt <= now`, commits the expiry first and throws 409 HOLD_EXPIRED.
 * If the window already started (`now >= windowStart`) and space is RESERVED, releases space to FREE.
 */
export async function cancelParking(
  userId: string,
  id: string,
  now: Date = new Date(),
): Promise<ParkingReservation> {
  const outcome = await db.$transaction(async (tx) => {
    const { reservation: res, space } = await lockOwnedParkingReservation(tx, userId, id);

    if (res.status === 'CONFIRMED' && res.expiresAt.getTime() <= now.getTime()) {
      await applyParkingExpiryInTx(tx, res, space);
      return { kind: 'EXPIRED' as const, hubId: res.hubId };
    }

    assertTransition('reservation', res.status, 'CANCELLED');

    const updatedRes = await tx.parkingReservation.update({
      where: { id: res.id },
      data: { status: 'CANCELLED' },
    });

    if (space.status === 'RESERVED' && now.getTime() >= res.windowStart.getTime()) {
      assertTransition('parkingSpace', space.status, 'FREE');
      await tx.parkingSpace.update({
        where: { id: space.id },
        data: { status: 'FREE' },
      });
    }

    return {
      kind: 'CANCELLED' as const,
      hubId: updatedRes.hubId,
      dto: toParkingDto(updatedRes, now),
    };
  });

  events.emit('RESERVATION_CHANGED', { hubId: outcome.hubId });

  if (outcome.kind === 'EXPIRED') {
    throwHoldExpired();
  }

  return outcome.dto;
}

/**
 * FR-17, Rule 7: Modify a CONFIRMED parking reservation's time window before it starts.
 * Keeps the current space if free ignoring this reservation itself; otherwise allocates
 * another free PUBLIC space at the same Hub/class via SKIP LOCKED. Rolls back on NO_CAPACITY.
 */
export async function changeWindow(
  userId: string,
  id: string,
  input: ChangeParkingWindowInput,
  now: Date = new Date(),
): Promise<ParkingReservation> {
  validateParkingWindow(
    input.windowStart,
    input.windowEnd,
    now,
    'windowStart',
    'windowEnd',
  );

  let targetHubId = '';
  let targetClass: VehicleClass = 'MOTORCYCLE';

  try {
    const outcome = await db.$transaction(async (tx) => {
      const { reservation: res, space: currentSpace } = await lockOwnedParkingReservation(
        tx,
        userId,
        id,
      );
      targetHubId = res.hubId;
      targetClass = res.vehicleClass;

      if (res.status !== 'CONFIRMED') {
        assertTransition('reservation', res.status, 'CONFIRMED');
      }

      if (now.getTime() >= res.windowStart.getTime()) {
        throw conflict('NOT_ELIGIBLE', 'Window already started; cancel instead.', {
          nextActions: ['Cancel or claim this parking reservation instead.'],
        });
      }

      let targetSpaceId: string | null = null;

      // Test whether the current space is still free for the new window ignoring this reservation
      if (currentSpace.status !== 'UNAVAILABLE') {
        const overlappingOnCurrent = await tx.parkingReservation.findFirst({
          where: {
            parkingSpaceId: currentSpace.id,
            id: { not: res.id },
            status: { in: ['CONFIRMED', 'ACTIVE'] },
            windowStart: { lt: input.windowEnd },
            windowEnd: { gt: input.windowStart },
          },
          select: { id: true },
        });
        if (!overlappingOnCurrent) {
          targetSpaceId = currentSpace.id;
        }
      }

      // Otherwise pick another free PUBLIC space at the same Hub and class
      if (!targetSpaceId) {
        const freeSpaces = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT ps.id
          FROM parking_space ps
          WHERE ps."hubId" = ${res.hubId}
            AND ps.pool = 'PUBLIC'::"ParkingPool"
            AND ps."vehicleClass" = ${res.vehicleClass}::"VehicleClass"
            AND ps.status != 'UNAVAILABLE'::"ParkingSpaceStatus"
            AND NOT EXISTS (
              SELECT 1
              FROM parking_reservation pr
              WHERE pr."parkingSpaceId" = ps.id
                AND pr.id != ${res.id}
                AND pr.status IN ('CONFIRMED', 'ACTIVE')
                AND pr."windowStart" < ${input.windowEnd}
                AND pr."windowEnd" > ${input.windowStart}
            )
          ORDER BY ps.id
          LIMIT 1
          FOR UPDATE OF ps SKIP LOCKED
        `;
        targetSpaceId = freeSpaces[0]?.id ?? null;
      }

      if (!targetSpaceId) {
        const alternatives = await alternativeHubs(
          {
            need: 'PUBLIC_PARKING',
            vehicleClass: res.vehicleClass,
            excludeHubId: res.hubId,
            from: input.windowStart,
            to: input.windowEnd,
          },
          now,
          tx,
        );
        throwNoCapacity(res.hubId, alternatives);
      }

      const expiresAt = computeHoldExpiresAt(input.windowStart, input.windowEnd);
      const updatedRes = await tx.parkingReservation.update({
        where: { id: res.id },
        data: {
          parkingSpaceId: targetSpaceId,
          windowStart: input.windowStart,
          windowEnd: input.windowEnd,
          expiresAt,
        },
      });

      return {
        hubId: updatedRes.hubId,
        dto: toParkingDto(updatedRes, now),
      };
    });

    events.emit('RESERVATION_CHANGED', { hubId: outcome.hubId });
    return outcome.dto;
  } catch (err: unknown) {
    if (isExclusionViolation(err)) {
      const alternatives = targetHubId
        ? await alternativeHubs(
            {
              need: 'PUBLIC_PARKING',
              vehicleClass: targetClass,
              excludeHubId: targetHubId,
              from: input.windowStart,
              to: input.windowEnd,
            },
            now,
            db,
          )
        : [];
      throwNoCapacity(targetHubId || 'Hub', alternatives);
    }
    throw err;
  }
}

/**
 * FR-18, Rule 8: Claim a CONFIRMED parking reservation on arrival.
 * Allowed from `windowStart` up to `expiresAt`.
 */
export async function claimParking(
  userId: string,
  id: string,
  now: Date = new Date(),
): Promise<ParkingReservation> {
  const outcome = await db.$transaction(async (tx) => {
    const { reservation: res, space } = await lockOwnedParkingReservation(tx, userId, id);

    if (res.status !== 'CONFIRMED') {
      assertTransition('reservation', res.status, 'ACTIVE');
    }

    if (now.getTime() < res.windowStart.getTime()) {
      throw conflict('NOT_ELIGIBLE', 'Too early to claim this parking reservation.', {
        nextActions: [`Claim this reservation at or after ${res.windowStart.toISOString()}.`],
        details: { opensAt: res.windowStart.toISOString() },
      });
    }

    if (now.getTime() >= res.expiresAt.getTime()) {
      await applyParkingExpiryInTx(tx, res, space);
      return { kind: 'EXPIRED' as const, hubId: res.hubId };
    }

    if (space.status === 'UNAVAILABLE') {
      throw conflict('NOT_ELIGIBLE', 'This parking space has been withdrawn.', {
        nextActions: ['Search for another available parking space.'],
      });
    }

    if (space.status === 'OCCUPIED') {
      throw conflict(
        'NOT_ELIGIBLE',
        'Space is being vacated, try again in a few seconds.',
        {
          nextActions: ['Wait a few seconds and try claiming again.'],
        },
      );
    }

    assertTransition('reservation', res.status, 'ACTIVE');
    assertTransition('parkingSpace', space.status, 'OCCUPIED');

    const updatedRes = await tx.parkingReservation.update({
      where: { id: res.id },
      data: {
        status: 'ACTIVE',
        claimedAt: now,
      },
    });

    await tx.parkingSpace.update({
      where: { id: space.id },
      data: { status: 'OCCUPIED' },
    });

    return {
      kind: 'ACTIVE' as const,
      hubId: updatedRes.hubId,
      dto: toParkingDto(updatedRes, now),
    };
  });

  events.emit('RESERVATION_CHANGED', { hubId: outcome.hubId });

  if (outcome.kind === 'EXPIRED') {
    throwHoldExpired();
  }

  return outcome.dto;
}

/**
 * FR-18, Rule 9: End an ACTIVE parking stay early (`ACTIVE -> COMPLETED`, `OCCUPIED -> FREE`).
 */
export async function leaveParking(
  userId: string,
  id: string,
  now: Date = new Date(),
): Promise<ParkingReservation> {
  const outcome = await db.$transaction(async (tx) => {
    const { reservation: res, space } = await lockOwnedParkingReservation(tx, userId, id);

    assertTransition('reservation', res.status, 'COMPLETED');

    const updatedRes = await tx.parkingReservation.update({
      where: { id: res.id },
      data: { status: 'COMPLETED' },
    });

    if (space.status === 'OCCUPIED') {
      assertTransition('parkingSpace', space.status, 'FREE');
      await tx.parkingSpace.update({
        where: { id: space.id },
        data: { status: 'FREE' },
      });
    }

    return {
      hubId: updatedRes.hubId,
      dto: toParkingDto(updatedRes, now),
    };
  });

  events.emit('RESERVATION_CHANGED', { hubId: outcome.hubId });
  return outcome.dto;
}

/**
 * Helper for parkingTick per-row locking: locks `parking_space` -> `parking_reservation`
 * and retries once if `parkingSpaceId` drifted concurrently.
 */
async function lockParkingReservationForTick(
  tx: Tx,
  id: string,
  predicate: (row: PrismaParkingReservation) => boolean,
): Promise<{
  reservation: PrismaParkingReservation;
  space: PrismaParkingSpace;
} | null> {
  for (let attempt = 0; attempt < LOCK_RETRY_ATTEMPTS; attempt++) {
    const unlocked = await tx.parkingReservation.findUnique({ where: { id } });
    if (!unlocked || !predicate(unlocked)) {
      return null;
    }

    await lockRow(tx, 'parking_space', unlocked.parkingSpaceId);
    await lockRow(tx, 'parking_reservation', id);

    const reread = await tx.parkingReservation.findUniqueOrThrow({ where: { id } });
    if (!predicate(reread)) {
      return null;
    }

    if (reread.parkingSpaceId === unlocked.parkingSpaceId) {
      const space = await tx.parkingSpace.findUniqueOrThrow({
        where: { id: reread.parkingSpaceId },
      });
      return { reservation: reread, space };
    }
  }
  return null;
}

/**
 * FR-18, BR-03, D-02, ARCHITECTURE §6.3, T-13 Rule 10:
 * Three ordered passes (one small transaction per row, lock space -> reservation, re-check):
 *   1. Window over: ACTIVE with `windowEnd <= now` -> COMPLETED, space OCCUPIED -> FREE.
 *   2. Unclaimed: CONFIRMED with `expiresAt <= now` -> EXPIRED, space RESERVED -> FREE, notify.
 *   3. Window started: CONFIRMED with `windowStart <= now < expiresAt` and space FREE -> RESERVED.
 */
export async function parkingTick(now: Date = new Date()): Promise<{
  completed: number;
  expired: number;
  reserved: number;
}> {
  let completed = 0;
  let expired = 0;
  let reserved = 0;

  // Pass 1: Window over (ACTIVE with windowEnd <= now)
  const endedRows = await db.parkingReservation.findMany({
    where: { status: 'ACTIVE', windowEnd: { lte: now } },
    select: { id: true },
  });

  for (const row of endedRows) {
    try {
      const result = await db.$transaction(async (tx) => {
        const locked = await lockParkingReservationForTick(
          tx,
          row.id,
          (r) => r.status === 'ACTIVE' && r.windowEnd.getTime() <= now.getTime(),
        );
        if (!locked) return null;

        assertTransition('reservation', locked.reservation.status, 'COMPLETED');
        await tx.parkingReservation.update({
          where: { id: locked.reservation.id },
          data: { status: 'COMPLETED' },
        });

        if (locked.space.status === 'OCCUPIED') {
          assertTransition('parkingSpace', locked.space.status, 'FREE');
          await tx.parkingSpace.update({
            where: { id: locked.space.id },
            data: { status: 'FREE' },
          });
        }

        return { hubId: locked.reservation.hubId };
      });

      if (result) {
        completed += 1;
        events.emit('RESERVATION_CHANGED', { hubId: result.hubId });
      }
    } catch (err: unknown) {
      console.error(`[reservations.tick] failed to complete parking "${row.id}"`, err);
    }
  }

  // Pass 2: Unclaimed (CONFIRMED with expiresAt <= now)
  const dueExpiryRows = await db.parkingReservation.findMany({
    where: { status: 'CONFIRMED', expiresAt: { lte: now } },
    select: { id: true },
  });

  for (const row of dueExpiryRows) {
    try {
      const result = await db.$transaction(async (tx) => {
        const locked = await lockParkingReservationForTick(
          tx,
          row.id,
          (r) => r.status === 'CONFIRMED' && r.expiresAt.getTime() <= now.getTime(),
        );
        if (!locked) return null;

        await applyParkingExpiryInTx(tx, locked.reservation, locked.space);
        return { hubId: locked.reservation.hubId };
      });

      if (result) {
        expired += 1;
        events.emit('RESERVATION_CHANGED', { hubId: result.hubId });
      }
    } catch (err: unknown) {
      console.error(`[reservations.tick] failed to expire parking "${row.id}"`, err);
    }
  }

  // Pass 3: Window started (CONFIRMED with windowStart <= now < expiresAt and space FREE)
  const startedRows = await db.parkingReservation.findMany({
    where: {
      status: 'CONFIRMED',
      windowStart: { lte: now },
      expiresAt: { gt: now },
    },
    select: { id: true },
  });

  for (const row of startedRows) {
    try {
      const result = await db.$transaction(async (tx) => {
        const locked = await lockParkingReservationForTick(
          tx,
          row.id,
          (r) =>
            r.status === 'CONFIRMED' &&
            r.windowStart.getTime() <= now.getTime() &&
            r.expiresAt.getTime() > now.getTime(),
        );
        if (!locked) return null;

        if (locked.space.status !== 'FREE') {
          return null;
        }

        assertTransition('parkingSpace', locked.space.status, 'RESERVED');
        await tx.parkingSpace.update({
          where: { id: locked.space.id },
          data: { status: 'RESERVED' },
        });

        return { hubId: locked.reservation.hubId };
      });

      if (result) {
        reserved += 1;
        events.emit('RESERVATION_CHANGED', { hubId: result.hubId });
      }
    } catch (err: unknown) {
      console.error(`[reservations.tick] failed to start parking window "${row.id}"`, err);
    }
  }

  return { completed, expired, reserved };
}
