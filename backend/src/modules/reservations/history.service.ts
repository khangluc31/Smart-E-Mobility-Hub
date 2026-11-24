// Student reservation & rental history service (FR-10, UC-07 E1, CONTRACTS §6).
// Read-only: merges vehicle_reservation and parking_reservation newest-first with
// cursor pagination (`createdAt DESC, id DESC`) and batched vehicle/charging lookups.

import type {
  ParkingReservation as PrismaParkingReservation,
  RentalVehicle as PrismaRentalVehicle,
  VehicleReservation as PrismaVehicleReservation,
} from '@prisma/client';
import { db, type DbClient } from '../../core/db';
import { encodeCursor, type ListCursor } from '../../core/pagination';
import type { ReservationStatus } from '../../types/enums';
import type { HistoryItem, HistoryPage, HistoryType } from '../../types/reservations';
import { toParkingDto } from './parkingReservations.service';
import { toReservationDto } from './vehicleReservations.service';
import { isVehicleCharging } from './vehicles.service';

export interface HistoryQuery {
  type?: HistoryType;
  status?: ReservationStatus;
  limit: number;
  cursor: ListCursor | null;
}

type RawCandidate =
  | { kind: 'vehicle'; createdAt: Date; id: string; row: PrismaVehicleReservation }
  | { kind: 'parking'; createdAt: Date; id: string; row: PrismaParkingReservation };

/**
 * FR-10, UC-07 E1: Return the caller's own vehicle and parking reservations
 * ordered newest-first (`createdAt DESC, id DESC`) with cursor pagination.
 */
export async function getHistory(
  userId: string,
  query: HistoryQuery,
  now: Date = new Date(),
  client: DbClient = db,
): Promise<HistoryPage> {
  const type: HistoryType = query.type ?? 'all';

  if (type === 'charging') {
    // TODO(M6): charging items
    return { items: [], nextCursor: null };
  }

  const includeVehicle = type === 'all' || type === 'vehicle';
  const includeParking = type === 'all' || type === 'parking';
  const take = query.limit + 1;

  const cursorWhere = query.cursor
    ? {
        OR: [
          { createdAt: { lt: query.cursor.createdAt } },
          { createdAt: query.cursor.createdAt, id: { lt: query.cursor.id } },
        ],
      }
    : {};

  // Plain Prisma orderBy: DB collation and JS string comparison agree for our cuid ids (lowercase alphanumeric).
  const [vehicleRows, parkingRows] = await Promise.all([
    includeVehicle
      ? client.vehicleReservation.findMany({
          where: {
            userId,
            ...(query.status ? { status: query.status } : {}),
            ...cursorWhere,
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take,
        })
      : Promise.resolve<PrismaVehicleReservation[]>([]),
    includeParking
      ? client.parkingReservation.findMany({
          where: {
            userId,
            ...(query.status ? { status: query.status } : {}),
            ...cursorWhere,
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take,
        })
      : Promise.resolve<PrismaParkingReservation[]>([]),
  ]);

  const merged: RawCandidate[] = [];
  for (const row of vehicleRows) {
    merged.push({ kind: 'vehicle', createdAt: row.createdAt, id: row.id, row });
  }
  for (const row of parkingRows) {
    merged.push({ kind: 'parking', createdAt: row.createdAt, id: row.id, row });
  }

  // Sort merged set by (createdAt DESC, id DESC) to match the per-table SQL order.
  merged.sort((a, b) => {
    const timeDiff = b.createdAt.getTime() - a.createdAt.getTime();
    if (timeDiff !== 0) return timeDiff;
    if (b.id > a.id) return 1;
    if (b.id < a.id) return -1;
    return 0;
  });

  const hasMore = merged.length > query.limit;
  const kept = hasMore ? merged.slice(0, query.limit) : merged;
  const last = kept[kept.length - 1];
  const nextCursor =
    hasMore && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null;

  // Batch-load vehicles and charging flags only for the kept vehicle items (no N+1).
  const vehicleIds = Array.from(
    new Set(
      kept
        .filter((c): c is Extract<RawCandidate, { kind: 'vehicle' }> => c.kind === 'vehicle')
        .map((c) => c.row.rentalVehicleId),
    ),
  );

  const [vehicles, chargingSet] =
    vehicleIds.length > 0
      ? await Promise.all([
          client.rentalVehicle.findMany({ where: { id: { in: vehicleIds } } }),
          isVehicleCharging(client, vehicleIds),
        ])
      : [[], new Set<string>()];

  const vehicleById = new Map<string, PrismaRentalVehicle>();
  for (const v of vehicles) {
    vehicleById.set(v.id, v);
  }

  const items: HistoryItem[] = kept.map((entry) => {
    if (entry.kind === 'vehicle') {
      const vehicle = vehicleById.get(entry.row.rentalVehicleId);
      if (!vehicle) {
        throw new Error(
          `RentalVehicle ${entry.row.rentalVehicleId} not found for reservation ${entry.row.id}`,
        );
      }
      return {
        kind: 'vehicle',
        at: entry.createdAt.toISOString(),
        item: toReservationDto(entry.row, vehicle, now, chargingSet.has(vehicle.id)),
      };
    }

    return {
      kind: 'parking',
      at: entry.createdAt.toISOString(),
      item: toParkingDto(entry.row, now),
    };
  });

  return { items, nextCursor };
}
