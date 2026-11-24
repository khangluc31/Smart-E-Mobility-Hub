// Student reservation, rental & charging history service (FR-10, UC-07 E1, CONTRACTS §6, D-23).
// Read-only: merges vehicle_reservation, parking_reservation, and charging_request newest-first
// with cursor pagination (`createdAt DESC, id DESC`) and batched vehicle/charging/projection lookups.

import type {
  ChargingRequest as PrismaChargingRequest,
  ParkingReservation as PrismaParkingReservation,
  RentalVehicle as PrismaRentalVehicle,
  VehicleReservation as PrismaVehicleReservation,
} from '@prisma/client';
import { db, type DbClient } from '../../core/db';
import { encodeCursor, type ListCursor } from '../../core/pagination';
import {
  CHARGING_REQUEST_STATUSES,
  RESERVATION_STATUSES,
  type ChargingRequestStatus,
  type ReservationStatus,
} from '../../types/enums';
import type {
  HistoryItem,
  HistoryPage,
  HistoryStatus,
  HistoryType,
} from '../../types/reservations';
import { buildHubProjection, toRequestView } from '../charging/charging.service';
import { listChargingHistory } from '../charging/chargingRequests.service';
import type { ScheduleProjection } from '../charging/schedule';
import { toParkingDto } from './parkingReservations.service';
import { toReservationDto } from './vehicleReservations.service';
import { isVehicleCharging } from './vehicles.service';

export interface HistoryQuery {
  type?: HistoryType;
  status?: HistoryStatus;
  limit: number;
  cursor: ListCursor | null;
}

type RawCandidate =
  | { kind: 'vehicle'; createdAt: Date; id: string; row: PrismaVehicleReservation }
  | { kind: 'parking'; createdAt: Date; id: string; row: PrismaParkingReservation }
  | { kind: 'charging'; createdAt: Date; id: string; row: PrismaChargingRequest };

function asReservationStatus(status: HistoryStatus | undefined): ReservationStatus | undefined {
  if (status !== undefined && (RESERVATION_STATUSES as readonly string[]).includes(status)) {
    return status as ReservationStatus;
  }
  return undefined;
}

function asChargingStatus(status: HistoryStatus | undefined): ChargingRequestStatus | undefined {
  if (status !== undefined && (CHARGING_REQUEST_STATUSES as readonly string[]).includes(status)) {
    return status as ChargingRequestStatus;
  }
  return undefined;
}

/**
 * FR-10, UC-07 E1: Return the caller's own vehicle reservations, parking reservations,
 * and charging requests ordered newest-first (`createdAt DESC, id DESC`) with cursor pagination.
 */
export async function getHistory(
  userId: string,
  query: HistoryQuery,
  now: Date = new Date(),
  client: DbClient = db,
): Promise<HistoryPage> {
  const type: HistoryType = query.type ?? 'all';
  const reservationStatus = asReservationStatus(query.status);
  const chargingStatus = asChargingStatus(query.status);

  // Wider status filter: apply only to the kinds whose enum contains the requested status.
  const statusAllowsReservation = query.status === undefined || reservationStatus !== undefined;
  const statusAllowsCharging = query.status === undefined || chargingStatus !== undefined;

  const includeVehicle = (type === 'all' || type === 'vehicle') && statusAllowsReservation;
  const includeParking = (type === 'all' || type === 'parking') && statusAllowsReservation;
  const includeCharging = (type === 'all' || type === 'charging') && statusAllowsCharging;
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
  const [vehicleRows, parkingRows, chargingRows] = await Promise.all([
    includeVehicle
      ? client.vehicleReservation.findMany({
          where: {
            userId,
            ...(reservationStatus ? { status: reservationStatus } : {}),
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
            ...(reservationStatus ? { status: reservationStatus } : {}),
            ...cursorWhere,
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take,
        })
      : Promise.resolve<PrismaParkingReservation[]>([]),
    includeCharging
      ? listChargingHistory(client, userId, {
          status: chargingStatus,
          cursor: query.cursor,
          take,
        })
      : Promise.resolve<PrismaChargingRequest[]>([]),
  ]);

  const merged: RawCandidate[] = [];
  for (const row of vehicleRows) {
    merged.push({ kind: 'vehicle', createdAt: row.createdAt, id: row.id, row });
  }
  for (const row of parkingRows) {
    merged.push({ kind: 'parking', createdAt: row.createdAt, id: row.id, row });
  }
  for (const row of chargingRows) {
    merged.push({ kind: 'charging', createdAt: row.createdAt, id: row.id, row });
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

  // Build one hub projection per distinct Hub for kept live charging items (QUEUED / CHARGING).
  const chargingHubIds = Array.from(
    new Set(
      kept
        .filter(
          (c): c is Extract<RawCandidate, { kind: 'charging' }> =>
            c.kind === 'charging' &&
            (c.row.status === 'QUEUED' || c.row.status === 'CHARGING'),
        )
        .map((c) => c.row.hubId),
    ),
  );

  const [vehicles, chargingSet, projectionPairs] = await Promise.all([
    vehicleIds.length > 0
      ? client.rentalVehicle.findMany({ where: { id: { in: vehicleIds } } })
      : Promise.resolve<PrismaRentalVehicle[]>([]),
    vehicleIds.length > 0
      ? isVehicleCharging(client, vehicleIds)
      : Promise.resolve(new Set<string>()),
    Promise.all(
      chargingHubIds.map(async (hubId): Promise<[string, ScheduleProjection]> => {
        const bundle = await buildHubProjection(client, hubId, now);
        return [hubId, bundle.projection];
      }),
    ),
  ]);

  const vehicleById = new Map<string, PrismaRentalVehicle>();
  for (const v of vehicles) {
    vehicleById.set(v.id, v);
  }
  const projectionsByHub = new Map<string, ScheduleProjection>(projectionPairs);

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

    if (entry.kind === 'parking') {
      return {
        kind: 'parking',
        at: entry.createdAt.toISOString(),
        item: toParkingDto(entry.row, now),
      };
    }

    return {
      kind: 'charging',
      at: entry.createdAt.toISOString(),
      item: toRequestView(entry.row, projectionsByHub.get(entry.row.hubId) ?? null, now),
    };
  });

  return { items, nextCursor };
}
