// Rental vehicle search and trip recommendation service (FR-04, FR-05, BR-02, D-18).
// No req/res; all thresholds come from core/config.ts.

import type { Prisma, RentalVehicle as PrismaRentalVehicle } from '@prisma/client';
import { config } from '../../core/config';
import { db, type DbClient } from '../../core/db';
import { badRequest } from '../../core/errors';
import { isDegraded } from '../hubs/hubs.metrics';
import { alternativeHubs } from '../hubs/hubs.service';
import type { RentalVehicleType } from '../../types/enums';
import type { RentalVehicle } from '../../types/hubs';
import type { VehicleRecommendation } from '../../types/reservations';

export interface SearchVehiclesQuery {
  hubId?: string;
  type?: RentalVehicleType;
  minBattery?: number;
  availableOnly?: boolean;
}

export interface RecommendVehiclesQuery {
  originHubId: string;
  destinationHubId: string;
  time?: Date;
}

/**
 * D-18: A rental vehicle is charging when a `charging_request` row has
 * `rentalVehicleId = it` and `status = 'CHARGING'`.
 */
// D-18: read-only; TODO(M6): switch to charging.service when it exists
export async function isVehicleCharging(
  client: DbClient,
  vehicleIds: readonly string[],
): Promise<Set<string>> {
  if (vehicleIds.length === 0) {
    return new Set<string>();
  }
  const rows = await client.chargingRequest.findMany({
    where: {
      status: 'CHARGING',
      rentalVehicleId: { in: [...vehicleIds] },
    },
    select: { rentalVehicleId: true },
  });
  const set = new Set<string>();
  for (const r of rows) {
    if (r.rentalVehicleId) {
      set.add(r.rentalVehicleId);
    }
  }
  return set;
}

export function toRentalVehicleDto(
  row: PrismaRentalVehicle,
  charging: boolean,
): RentalVehicle {
  return {
    id: row.id,
    hubId: row.hubId,
    type: row.type,
    vehicleClass: row.vehicleClass as 'MOTORCYCLE',
    status: row.status,
    batteryPct: row.batteryPct,
    charging,
  };
}

/**
 * FR-04, BR-02, D-18: Search rental vehicles sorted by `batteryPct DESC, id ASC`.
 * With `availableOnly` (default `true`): only `status = 'AVAILABLE'`,
 * `batteryPct >= config.MIN_RENTAL_BATTERY_PCT`, and not currently charging.
 */
export async function searchVehicles(
  query: SearchVehiclesQuery,
  client: DbClient = db,
): Promise<RentalVehicle[]> {
  if (query.hubId !== undefined) {
    const hub = await client.hub.findUnique({
      where: { id: query.hubId },
      select: { id: true },
    });
    if (!hub) {
      throw badRequest(`Unknown Hub "${query.hubId}".`, 'hubId', [
        'Choose an existing Hub ID from GET /api/hubs.',
      ]);
    }
  }

  const availableOnly = query.availableOnly ?? true;
  const effectiveMinBattery = availableOnly
    ? Math.max(query.minBattery ?? 0, config.MIN_RENTAL_BATTERY_PCT)
    : query.minBattery;

  const where: Prisma.RentalVehicleWhereInput = {
    ...(query.hubId !== undefined ? { hubId: query.hubId } : {}),
    ...(query.type !== undefined ? { type: query.type } : {}),
    ...(availableOnly ? { status: 'AVAILABLE' } : {}),
    ...(effectiveMinBattery !== undefined
      ? { batteryPct: { gte: effectiveMinBattery } }
      : {}),
  };

  const rows = await client.rentalVehicle.findMany({
    where,
    orderBy: [{ batteryPct: 'desc' }, { id: 'asc' }],
  });

  const chargingSet = await isVehicleCharging(
    client,
    rows.map((r) => r.id),
  );

  const results: RentalVehicle[] = [];
  for (const row of rows) {
    const charging = chargingSet.has(row.id);
    if (availableOnly && charging) {
      continue; // D-18: charging rental vehicles are not rentable
    }
    results.push(toRentalVehicleDto(row, charging));
  }

  return results;
}

/**
 * FR-05: Recommend rentable vehicles at `originHubId` and evaluate return capacity
 * at `destinationHubId`, providing alternative destinations when full or degraded.
 */
export async function recommend(
  query: RecommendVehiclesQuery,
  now: Date = new Date(),
  client: DbClient = db,
): Promise<VehicleRecommendation> {
  // TODO(M4): time-based prediction (currently evaluates live state at `now`)
  const [originHub, destHub] = await Promise.all([
    client.hub.findUnique({ where: { id: query.originHubId } }),
    client.hub.findUnique({ where: { id: query.destinationHubId } }),
  ]);

  if (!originHub) {
    throw badRequest(`Unknown origin Hub "${query.originHubId}".`, 'originHubId', [
      'Choose an existing origin Hub ID from GET /api/hubs.',
    ]);
  }
  if (!destHub) {
    throw badRequest(
      `Unknown destination Hub "${query.destinationHubId}".`,
      'destinationHubId',
      ['Choose an existing destination Hub ID from GET /api/hubs.'],
    );
  }

  const [originVehicles, freeFleetSpaces] = await Promise.all([
    searchVehicles({ hubId: originHub.id, availableOnly: true }, client),
    client.parkingSpace.count({
      where: {
        hubId: destHub.id,
        vehicleClass: 'MOTORCYCLE',
        pool: 'FLEET',
        status: 'FREE',
      },
    }),
  ]);

  const vehicles = originVehicles.map((v) => ({
    ...v,
    reason: `Battery ${v.batteryPct}% at ${originHub.name}`,
  }));

  const destDegraded = isDegraded(
    destHub.lastTelemetryAt,
    now,
    config.STALLED_FEED_INTERVALS,
    config.TELEMETRY_INTERVAL_SEC,
  );

  const ok = freeFleetSpaces > 0 && !destDegraded;
  let destReason: string;
  if (destDegraded) {
    destReason = 'Hub data is stale';
  } else if (freeFleetSpaces === 0) {
    destReason = 'No free parking for returns';
  } else {
    destReason = `${freeFleetSpaces} free FLEET space(s) at ${destHub.name}`;
  }

  const alternativeDestinations = ok
    ? []
    : await alternativeHubs(
        {
          need: 'FLEET_PARKING',
          vehicleClass: 'MOTORCYCLE',
          excludeHubId: destHub.id,
        },
        now,
        client,
      );

  return {
    vehicles,
    destination: {
      hubId: destHub.id,
      freeFleetSpaces,
      ok,
      reason: destReason,
    },
    alternativeDestinations,
  };
}
