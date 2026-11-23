// Private EVs service: list, register, edit, soft-delete (FR-25, FR-26, FR-27, BR-08, BR-13).
// Lock order: private_ev -> parking_space -> parking_reservation (ARCHITECTURE §4.1, T-14 Rule 7).

import type { PrivateEv as PrismaPrivateEv } from '@prisma/client';
import { db, lockRow, type DbClient, type Tx } from '../../core/db';
import { AppError, badRequest, conflict, notFound } from '../../core/errors';
import { PRIVATE_EV_TYPES, type PrivateEvType } from '../../types/enums';
import type { PrivateEv } from '../../types/privateEvs';
import { activeParkingEvIds } from '../reservations/parkingReservations.service';
import {
  classForType,
  PRIVATE_EV_LABEL_MAX,
  PRIVATE_EV_LABEL_MIN,
} from './privateEvs.rules';

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
