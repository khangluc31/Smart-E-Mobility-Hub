// Private EVs service: list, register, edit, soft-delete, and combined parking+charging
// booking (FR-25..FR-28, BR-08, BR-10, BR-13, BR-14, NFR-08).
// Lock order: private_ev -> parking_space -> charging_point -> bookings (ARCHITECTURE §4.1).

import { randomUUID } from 'node:crypto';
import type { PrivateEv as PrismaPrivateEv } from '@prisma/client';
import { config } from '../../core/config';
import { db, lockRow, type DbClient, type Tx } from '../../core/db';
import { AppError, badRequest, conflict, notFound } from '../../core/errors';
import { events } from '../../core/events';
import { withIdempotency } from '../../core/idempotency';
import type { ChargingRequestView } from '../../types/charging';
import { PRIVATE_EV_TYPES, type PrivateEvType, type VehicleClass } from '../../types/enums';
import type { CombinedBookingResult, PrivateEv } from '../../types/privateEvs';
import type { ParkingReservation } from '../../types/reservations';
import { bookAdvanceSlot } from '../charging/advanceBooking.service';
import {
  activeParkingEvIds,
  reserveParking,
  WINDOW_START_GRACE_MS,
} from '../reservations/parkingReservations.service';
import {
  classForType,
  PRIVATE_EV_LABEL_MAX,
  PRIVATE_EV_LABEL_MIN,
} from './privateEvs.rules';

const MS_PER_HOUR = 3_600_000;

export interface PrivateEvActor {
  id: string;
}

export interface BookParkingAndChargingInput {
  hubId: string;
  windowStart: Date;
  windowEnd: Date;
  targetPct: number;
  chargeStart?: Date;
}

export interface BookParkingAndChargingOptions {
  idemKey?: string;
  now?: Date;
}

export interface CreatePrivateEvInput {
  type: PrivateEvType;
  label: string;
  batteryCapacityKwh: number;
  batteryPct: number;
}

export interface UpdatePrivateEvInput {
  type?: PrivateEvType;
  label?: string;
  batteryCapacityKwh?: number;
  batteryPct?: number;
}

export function toPrivateEvDto(row: PrismaPrivateEv, hasActiveBooking: boolean): PrivateEv {
  return {
    id: row.id,
    type: row.type,
    vehicleClass: row.vehicleClass,
    label: row.label,
    batteryCapacityKwh: row.batteryCapacityKwh,
    batteryPct: row.batteryPct,
    hasActiveBooking,
  };
}

function validateLabel(label: string): string {
  const trimmed = label.trim();
  if (trimmed.length < PRIVATE_EV_LABEL_MIN) {
    throw badRequest(`label must be at least ${PRIVATE_EV_LABEL_MIN} characters.`, 'label');
  }
  if (trimmed.length > PRIVATE_EV_LABEL_MAX) {
    throw badRequest(`label must be at most ${PRIVATE_EV_LABEL_MAX} characters.`, 'label');
  }
  return trimmed;
}

function validateBatteryCapacityKwh(batteryCapacityKwh: number): number {
  if (!Number.isFinite(batteryCapacityKwh) || batteryCapacityKwh <= 0) {
    throw badRequest('batteryCapacityKwh must be greater than 0.', 'batteryCapacityKwh');
  }
  return batteryCapacityKwh;
}

function validateBatteryPct(batteryPct: number): number {
  if (!Number.isFinite(batteryPct) || batteryPct < 0 || batteryPct > 100) {
    throw badRequest('batteryPct must be between 0 and 100.', 'batteryPct');
  }
  return batteryPct;
}

function validateType(type: PrivateEvType): PrivateEvType {
  if (!PRIVATE_EV_TYPES.includes(type)) {
    throw badRequest(`type must be one of: ${PRIVATE_EV_TYPES.join(', ')}.`, 'type');
  }
  return type;
}

// TODO(M6): switch to charging.service when it exists
async function activeChargingEvIds(
  client: DbClient,
  evIds: readonly string[],
): Promise<Set<string>> {
  if (evIds.length === 0) return new Set();
  const rows = await client.chargingRequest.findMany({
    where: {
      privateEvId: { in: [...evIds] },
      status: { in: ['QUEUED', 'SCHEDULED', 'CHARGING'] },
    },
    select: { privateEvId: true },
    distinct: ['privateEvId'],
  });
  const ids = new Set<string>();
  for (const r of rows) {
    if (r.privateEvId) ids.add(r.privateEvId);
  }
  return ids;
}

/**
 * Compute EV ids that have an active parking reservation or charging request
 * in two fixed queries (no N+1, NFR-01, T-14 Rule 4).
 */
async function activeBookingEvIds(
  client: DbClient,
  evIds: readonly string[],
): Promise<Set<string>> {
  if (evIds.length === 0) return new Set();
  const parkingIds = await activeParkingEvIds(client, evIds);
  const chargingIds = await activeChargingEvIds(client, evIds);
  const combined = new Set<string>(parkingIds);
  for (const id of chargingIds) combined.add(id);
  return combined;
}

/**
 * Lock an owned, non-removed Private EV row FOR UPDATE inside a transaction.
 * Unknown id, foreign owner, and soft-deleted EV all produce the exact same 404 body (Rule 1).
 */
async function lockOwnedPrivateEv(
  tx: Tx,
  userId: string,
  id: string,
): Promise<PrismaPrivateEv> {
  try {
    await lockRow(tx, 'private_ev', id);
  } catch (err: unknown) {
    if (err instanceof AppError && err.code === 'NOT_FOUND') {
      throw notFound('Private EV');
    }
    throw err;
  }

  const ev = await tx.privateEv.findUniqueOrThrow({ where: { id } });
  if (ev.ownerId !== userId || ev.deletedAt !== null) {
    throw notFound('Private EV');
  }
  return ev;
}

/**
 * FR-25, Rule 3 & 4: List caller's non-removed Private EVs ordered by label ASC, id ASC,
 * with `hasActiveBooking` computed in 3 total queries (no N+1).
 */
export async function listPrivateEvs(
  userId: string,
  client: DbClient = db,
): Promise<PrivateEv[]> {
  const rows = await client.privateEv.findMany({
    where: { ownerId: userId, deletedAt: null },
    orderBy: [{ label: 'asc' }, { id: 'asc' }],
  });

  if (rows.length === 0) return [];

  const activeIds = await activeBookingEvIds(
    client,
    rows.map((r) => r.id),
  );
  return rows.map((row) => toPrivateEvDto(row, activeIds.has(row.id)));
}

/**
 * FR-25, BR-08, BR-13: Register a Private EV for the caller.
 * Class is always derived from `type`; lives only in `private_ev`.
 */
export async function createPrivateEv(
  userId: string,
  input: CreatePrivateEvInput,
): Promise<PrivateEv> {
  const type = validateType(input.type);
  const label = validateLabel(input.label);
  const batteryCapacityKwh = validateBatteryCapacityKwh(input.batteryCapacityKwh);
  const batteryPct = validateBatteryPct(input.batteryPct);
  const vehicleClass = classForType(type);

  const created = await db.privateEv.create({
    data: {
      ownerId: userId,
      type,
      vehicleClass,
      label,
      batteryCapacityKwh,
      batteryPct,
    },
  });

  return toPrivateEvDto(created, false);
}

/**
 * FR-26, Rule 5 & 7: Edit a Private EV.
 * Locks `private_ev` FOR UPDATE, checks active bookings inside the tx before changing `type`
 * (serialising against `reserveParking`'s FOR SHARE lock on `private_ev`).
 */
export async function updatePrivateEv(
  userId: string,
  id: string,
  input: UpdatePrivateEvInput,
): Promise<PrivateEv> {
  const hasField =
    input.label !== undefined ||
    input.type !== undefined ||
    input.batteryCapacityKwh !== undefined ||
    input.batteryPct !== undefined;

  if (!hasField) {
    throw badRequest('Provide at least one field to update.', 'body', [
      'Include at least one of label, type, batteryCapacityKwh, or batteryPct.',
    ]);
  }

  const label = input.label !== undefined ? validateLabel(input.label) : undefined;
  const type = input.type !== undefined ? validateType(input.type) : undefined;
  const batteryCapacityKwh =
    input.batteryCapacityKwh !== undefined
      ? validateBatteryCapacityKwh(input.batteryCapacityKwh)
      : undefined;
  const batteryPct =
    input.batteryPct !== undefined ? validateBatteryPct(input.batteryPct) : undefined;

  return db.$transaction(async (tx) => {
    const ev = await lockOwnedPrivateEv(tx, userId, id);
    const activeIds = await activeBookingEvIds(tx, [ev.id]);
    const hasActiveBooking = activeIds.has(ev.id);

    const typeChanging = type !== undefined && type !== ev.type;
    if (typeChanging && hasActiveBooking) {
      throw conflict(
        'HAS_ACTIVE_BOOKING',
        'Cannot change Private EV type while it has an active booking.',
        {
          nextActions: [
            'Cancel or complete active parking reservations and charging requests for this EV before changing its type.',
          ],
        },
      );
    }

    const data: {
      label?: string;
      type?: PrivateEvType;
      vehicleClass?: ReturnType<typeof classForType>;
      batteryCapacityKwh?: number;
      batteryPct?: number;
    } = {};

    if (label !== undefined) data.label = label;
    if (batteryCapacityKwh !== undefined) data.batteryCapacityKwh = batteryCapacityKwh;
    if (batteryPct !== undefined) data.batteryPct = batteryPct;
    if (typeChanging && type !== undefined) {
      data.type = type;
      data.vehicleClass = classForType(type);
    }

    const updated = await tx.privateEv.update({
      where: { id: ev.id },
      data,
    });

    return toPrivateEvDto(updated, hasActiveBooking);
  });
}

/**
 * FR-27, Rule 6 & 7: Soft-delete a Private EV (`deletedAt = now`).
 * Locks `private_ev` FOR UPDATE and refuses if an active parking or charging booking exists.
 */
export async function removePrivateEv(
  userId: string,
  id: string,
  now: Date = new Date(),
): Promise<void> {
  await db.$transaction(async (tx) => {
    const ev = await lockOwnedPrivateEv(tx, userId, id);
    const activeIds = await activeBookingEvIds(tx, [ev.id]);

    if (activeIds.has(ev.id)) {
      throw conflict(
        'HAS_ACTIVE_BOOKING',
        'Cannot remove a Private EV while it has an active booking.',
        {
          nextActions: [
            'Cancel or complete active parking reservations and charging requests for this EV before removing it.',
          ],
        },
      );
    }

    await tx.privateEv.update({
      where: { id: ev.id },
      data: { deletedAt: now },
    });
  });
}

function validateCombinedBookingInput(
  input: BookParkingAndChargingInput,
  chargeStart: Date,
  now: Date,
): void {
  if (input.windowEnd.getTime() <= input.windowStart.getTime()) {
    throw badRequest('windowEnd must be after windowStart.', 'windowEnd', [
      'Choose a windowEnd after windowStart.',
    ]);
  }
  const maxWindowMs = config.PARKING_MAX_WINDOW_H * MS_PER_HOUR;
  if (input.windowEnd.getTime() - input.windowStart.getTime() > maxWindowMs) {
    throw badRequest(
      `Parking window cannot exceed ${config.PARKING_MAX_WINDOW_H} hours.`,
      'windowEnd',
      [`Shorten the parking window to at most ${config.PARKING_MAX_WINDOW_H} hours.`],
    );
  }
  if (input.windowStart.getTime() < now.getTime() - WINDOW_START_GRACE_MS) {
    throw badRequest('windowStart cannot be in the past.', 'windowStart', [
      'Choose a windowStart starting now or in the future.',
    ]);
  }
  if (!Number.isFinite(input.targetPct) || input.targetPct <= 0 || input.targetPct > 100) {
    throw badRequest('targetPct must be greater than 0 and at most 100.', 'targetPct');
  }
  if (
    chargeStart.getTime() < input.windowStart.getTime() ||
    chargeStart.getTime() >= input.windowEnd.getTime()
  ) {
    throw badRequest('chargeStart must be within [windowStart, windowEnd).', 'chargeStart', [
      'Choose a chargeStart at or after windowStart and strictly before windowEnd.',
    ]);
  }
  if (chargeStart.getTime() <= now.getTime()) {
    throw badRequest('chargeStart must be in the future.', 'chargeStart', [
      'Choose a chargeStart after the current server time.',
    ]);
  }
}

function buildCombinedNoCapacityError(
  missing: 'PARKING' | 'CHARGING',
  hubName: string,
  err: AppError,
): AppError {
  const alternatives = err.alternatives ?? [];
  if (missing === 'PARKING') {
    const nextActions =
      alternatives.length > 0
        ? [
            'Nothing was booked. Choose one of the alternative Hubs with free PUBLIC parking, or try a different window.',
          ]
        : ['Nothing was booked. Try a different time window or check another Hub.'];
    return conflict(
      'NO_CAPACITY',
      `No free PUBLIC parking spaces available at "${hubName}" for the requested window; nothing was booked.`,
      {
        nextActions,
        alternatives,
        details: { ...(err.details ?? {}), missing: 'PARKING' },
      },
    );
  }

  const nextActions =
    alternatives.length > 0
      ? [
          'Nothing was booked. Choose one of the suggested charging start times or alternative Hubs.',
        ]
      : ['Nothing was booked. Try a different charging start time or check another Hub.'];
  return conflict(
    'NO_CAPACITY',
    `No free charging point available at "${hubName}" for the requested slot; nothing was booked.`,
    {
      nextActions,
      alternatives,
      details: { ...(err.details ?? {}), missing: 'CHARGING' },
    },
  );
}

/**
 * FR-28, BR-10, BR-13, BR-14, NFR-08:
 * Atomically book a PUBLIC parking space and an advance charging slot for a Private EV
 * in one transaction. Either both commit with a shared `bookingGroupId` or neither does.
 */
export async function bookParkingAndCharging(
  user: PrivateEvActor,
  evId: string,
  input: BookParkingAndChargingInput,
  opts: BookParkingAndChargingOptions = {},
): Promise<CombinedBookingResult> {
  const now = opts.now ?? new Date();
  const chargeStart = input.chargeStart ?? input.windowStart;

  validateCombinedBookingInput(input, chargeStart, now);

  const hub = await db.hub.findUnique({
    where: { id: input.hubId },
    select: { id: true, name: true },
  });
  if (!hub) {
    throw badRequest(`Unknown Hub "${input.hubId}".`, 'hubId', [
      'Choose an existing Hub ID from GET /api/hubs.',
    ]);
  }

  const outcome = await db.$transaction(async (tx) => {
    return withIdempotency(
      tx,
      {
        userId: user.id,
        key: opts.idemKey,
        endpoint: 'POST /api/private-evs/:id/book-parking-charging',
        now,
      },
      async () => {
        // Step 1: Lock the Private EV FOR SHARE first (ARCHITECTURE §4.1 lock order).
        // Missing, soft-deleted, or another student's EV -> 404 (path id, same rule as T-14).
        const evRows = await tx.$queryRaw<
          Array<{
            id: string;
            ownerId: string;
            vehicleClass: VehicleClass;
            deletedAt: Date | null;
          }>
        >`
          SELECT id, "ownerId", "vehicleClass", "deletedAt"
          FROM private_ev
          WHERE id = ${evId}
          FOR SHARE
        `;
        const ev = evRows[0];
        if (!ev || ev.ownerId !== user.id || ev.deletedAt !== null) {
          throw notFound('Private EV');
        }

        // Step 2: Shared group id linking the parking and charging records (BR-14).
        // Both parts are independent afterwards: cancelling one via its existing endpoint
        // does not cancel the other (no group cancel in T-21).
        const bookingGroupId = randomUUID();

        // Step 3: Reserve a PUBLIC parking space (no idemKey; outer transaction owns idempotency).
        let parkingReservation: ParkingReservation;
        try {
          parkingReservation = await reserveParking(
            user.id,
            {
              hubId: hub.id,
              vehicleClass: ev.vehicleClass,
              privateEvId: ev.id,
              windowStart: input.windowStart,
              windowEnd: input.windowEnd,
            },
            { tx, bookingGroupId, now },
          );
        } catch (err: unknown) {
          if (err instanceof AppError && err.code === 'NO_CAPACITY') {
            throw buildCombinedNoCapacityError('PARKING', hub.name, err);
          }
          throw err;
        }

        // Step 4: Book an advance charging slot (no idemKey; outer transaction owns idempotency).
        // Lock order note: the only booking row written before charging_point is locked is
        // this transaction's own new parking_reservation row, which no other transaction can see or lock.
        let chargingRequest: ChargingRequestView;
        try {
          chargingRequest = await bookAdvanceSlot(
            user,
            {
              privateEvId: ev.id,
              hubId: hub.id,
              slotStart: chargeStart,
              targetPct: input.targetPct,
            },
            { tx, bookingGroupId, now },
          );
        } catch (err: unknown) {
          if (err instanceof AppError && err.code === 'NO_CAPACITY') {
            throw buildCombinedNoCapacityError('CHARGING', hub.name, err);
          }
          throw err;
        }

        // Step 5: Charging slot must finish on or before windowEnd; throwing rolls back both rows.
        if (
          chargingRequest.slotEnd !== null &&
          Date.parse(chargingRequest.slotEnd) > input.windowEnd.getTime()
        ) {
          throw badRequest(
            "Charging wouldn't finish before your parking window ends — start earlier, park longer or lower the target.",
            'chargeStart',
            [
              'Choose an earlier chargeStart, extend windowEnd, or lower targetPct so charging fits in your parking window.',
            ],
          );
        }

        return {
          status: 201,
          body: {
            bookingGroupId,
            parkingReservation,
            chargingRequest,
          },
        };
      },
    );
  });

  // Post-commit events only; never emitted on an idempotent replay.
  if (!outcome.replayed) {
    events.emit('RESERVATION_CHANGED', { hubId: outcome.body.parkingReservation.hubId });
    events.emit('CHARGING_QUEUE_CHANGED', { hubId: outcome.body.chargingRequest.hubId });
  }

  return outcome.body;
}
