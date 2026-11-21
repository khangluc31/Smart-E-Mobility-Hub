// Hub read-only service (FR-01, FR-02, FR-03, FR-19). No req/res, no Prisma in routes.

import { db, type DbClient } from '../../core/db';
import { config } from '../../core/config';
import { notFound } from '../../core/errors';
import { utilPct, classCount, isDegraded, isNearCapacity, rankAlternatives } from './hubs.metrics';
import type { VehicleClass } from '../../types/enums';
import type { HubSummary, HubDetail, AlternativeNeed } from '../../types/hubs';
import type { Alternative } from '../../types/common';

// ---- internal types for groupBy rows ----
interface SpaceRow { hubId: string; vehicleClass: VehicleClass; pool: 'FLEET' | 'PUBLIC'; status: string; _count: { _all: number } }
interface PointRow { hubId: string; vehicleClass: VehicleClass; status: string; _count: { _all: number } }

function emptyClassCount(): Record<VehicleClass, { free: number; total: number; occ: number; res: number; unavail: number; charging: number; faulty: number }> {
  return {
    MOTORCYCLE: { free: 0, total: 0, occ: 0, res: 0, unavail: 0, charging: 0, faulty: 0 },
    CAR: { free: 0, total: 0, occ: 0, res: 0, unavail: 0, charging: 0, faulty: 0 },
  };
}

function buildSummary(
  hub: { id: string; name: string; location: string; lastTelemetryAt: Date | null },
  availCount: number,
  parkingAll: Record<VehicleClass, { free: number; total: number; occ: number; res: number; unavail: number }>,
  parkingPub: Record<VehicleClass, { free: number; total: number; occ: number; res: number; unavail: number }>,
  chargingCounts: Record<VehicleClass, { free: number; total: number; charging: number; faulty: number }>,
  redirectToHubId: string | null,
  now: Date,
): HubSummary {
  const degraded = isDegraded(hub.lastTelemetryAt, now, config.STALLED_FEED_INTERVALS, config.TELEMETRY_INTERVAL_SEC);

  const parkingRaw: Record<VehicleClass, number> = { MOTORCYCLE: 0, CAR: 0 };
  const chargingRaw: Record<VehicleClass, number> = { MOTORCYCLE: 0, CAR: 0 };
  const parking: Record<VehicleClass, ReturnType<typeof classCount>> = {} as never;
  const publicParking: Record<VehicleClass, ReturnType<typeof classCount>> = {} as never;
  const charging: Record<VehicleClass, ReturnType<typeof classCount>> = {} as never;

  for (const vc of ['MOTORCYCLE', 'CAR'] as VehicleClass[]) {
    const pa = parkingAll[vc];
    const pp = parkingPub[vc];
    const ch = chargingCounts[vc];
    const pRaw = utilPct(pa.occ + pa.res, pa.total, pa.unavail);
    parkingRaw[vc] = pRaw;
    parking[vc] = classCount(pa.free, pa.total, pRaw);
    publicParking[vc] = classCount(pp.free, pp.total, utilPct(pp.occ + pp.res, pp.total, pp.unavail));
    const cRaw = utilPct(ch.charging, ch.total, ch.faulty);
    chargingRaw[vc] = cRaw;
    charging[vc] = classCount(ch.free, ch.total, cRaw);
  }

  return {
    id: hub.id,
    name: hub.name,
    location: hub.location,
    lastTelemetryAt: hub.lastTelemetryAt?.toISOString() ?? null,
    degraded,
    availableRentalVehicles: availCount,
    parking,
    publicParking,
    charging,
    nearCapacity: isNearCapacity(parking, publicParking, charging, { parkingRaw, chargingRaw }, config.NEAR_CAPACITY_PCT),
    redirectToHubId,
  };
}

// ---- public API ----

export async function listHubs(now: Date = new Date(), client: DbClient = db): Promise<HubSummary[]> {
  const [hubs, spaceRows, pointRows, redirects, chargingRvIds] = await Promise.all([
    client.hub.findMany({ orderBy: { id: 'asc' } }),
    client.parkingSpace.groupBy({
      by: ['hubId', 'vehicleClass', 'pool', 'status'],
      _count: { _all: true },
    }) as unknown as SpaceRow[],
    client.chargingPoint.groupBy({
      by: ['hubId', 'vehicleClass', 'status'],
      _count: { _all: true },
    }) as unknown as PointRow[],
    client.hubRedirect.findMany({ where: { activeUntil: { gt: now } }, orderBy: { id: 'desc' } }),
    client.chargingRequest.findMany({
      where: { status: 'CHARGING', rentalVehicleId: { not: null } },
      select: { rentalVehicleId: true },
    }),
  ]);

  const chargingRvSet = new Set(chargingRvIds.map((r) => r.rentalVehicleId));

  const vehicles = await client.rentalVehicle.findMany({
    where: { status: 'AVAILABLE', batteryPct: { gte: config.MIN_RENTAL_BATTERY_PCT } },
    select: { id: true, hubId: true },
  });
  const availByHub = new Map<string, number>();
  for (const v of vehicles) {
    if (chargingRvSet.has(v.id)) continue; // D-18
    availByHub.set(v.hubId, (availByHub.get(v.hubId) ?? 0) + 1);
  }

  const redirectMap = new Map<string, string>();
  for (const r of redirects) {
    if (!redirectMap.has(r.fromHubId)) redirectMap.set(r.fromHubId, r.toHubId);
  }

  const parkingAllByHub = new Map<string, Record<VehicleClass, { free: number; total: number; occ: number; res: number; unavail: number }>>();
  const parkingPubByHub = new Map<string, Record<VehicleClass, { free: number; total: number; occ: number; res: number; unavail: number }>>();
  for (const r of spaceRows) {
    const cnt = r._count._all;
    for (const [map, matchPool] of [[parkingAllByHub, null], [parkingPubByHub, 'PUBLIC']] as const) {
      if (matchPool && r.pool !== matchPool) continue;
      if (!map.has(r.hubId)) map.set(r.hubId, { MOTORCYCLE: { free: 0, total: 0, occ: 0, res: 0, unavail: 0 }, CAR: { free: 0, total: 0, occ: 0, res: 0, unavail: 0 } });
      const vc = map.get(r.hubId)![r.vehicleClass];
      vc.total += cnt;
      if (r.status === 'FREE') vc.free += cnt;
      else if (r.status === 'OCCUPIED') vc.occ += cnt;
      else if (r.status === 'RESERVED') vc.res += cnt;
      else if (r.status === 'UNAVAILABLE') vc.unavail += cnt;
    }
  }

  const chargingByHub = new Map<string, Record<VehicleClass, { free: number; total: number; charging: number; faulty: number }>>();
  for (const r of pointRows) {
    if (!chargingByHub.has(r.hubId)) chargingByHub.set(r.hubId, { MOTORCYCLE: { free: 0, total: 0, charging: 0, faulty: 0 }, CAR: { free: 0, total: 0, charging: 0, faulty: 0 } });
    const vc = chargingByHub.get(r.hubId)![r.vehicleClass];
    vc.total += r._count._all;
    if (r.status === 'AVAILABLE') vc.free += r._count._all;
    else if (r.status === 'CHARGING') vc.charging += r._count._all;
    else if (r.status === 'FAULTY') vc.faulty += r._count._all;
  }

  const empty5 = () => ({ MOTORCYCLE: { free: 0, total: 0, occ: 0, res: 0, unavail: 0 }, CAR: { free: 0, total: 0, occ: 0, res: 0, unavail: 0 } });
  const empty4 = () => ({ MOTORCYCLE: { free: 0, total: 0, charging: 0, faulty: 0 }, CAR: { free: 0, total: 0, charging: 0, faulty: 0 } });

  return hubs.map((h) =>
    buildSummary(h, availByHub.get(h.id) ?? 0, parkingAllByHub.get(h.id) ?? empty5(), parkingPubByHub.get(h.id) ?? empty5(), chargingByHub.get(h.id) ?? empty4(), redirectMap.get(h.id) ?? null, now),
  );
}

export async function getHub(hubId: string, now: Date = new Date(), client: DbClient = db): Promise<HubDetail> {
  const hub = await client.hub.findUnique({ where: { id: hubId } });
  if (!hub) throw notFound('Hub');

  const [vehicles, parkingSpaces, chargingPoints, chargingRvIds, redirects] = await Promise.all([
    client.rentalVehicle.findMany({ where: { hubId }, orderBy: { id: 'asc' } }),
    client.parkingSpace.findMany({ where: { hubId }, orderBy: { id: 'asc' } }),
    client.chargingPoint.findMany({ where: { hubId }, orderBy: { id: 'asc' } }),
    client.chargingRequest.findMany({
      where: { hubId, status: 'CHARGING', rentalVehicleId: { not: null } },
      select: { rentalVehicleId: true },
    }),
    client.hubRedirect.findMany({ where: { fromHubId: hubId, activeUntil: { gt: now } }, orderBy: { id: 'desc' }, take: 1 }),
  ]);

  const chargingRvSet = new Set(chargingRvIds.map((r) => r.rentalVehicleId));
  const redirectToHubId = redirects[0]?.toHubId ?? null;

  const parkingAll = emptyClassCount();
  const parkingPub = emptyClassCount();
  for (const s of parkingSpaces) {
    for (const [acc, matchPool] of [[parkingAll, null], [parkingPub, 'PUBLIC']] as const) {
      if (matchPool && s.pool !== matchPool) continue;
      const vc = acc[s.vehicleClass];
      vc.total++;
      if (s.status === 'FREE') vc.free++;
      else if (s.status === 'OCCUPIED') vc.occ++;
      else if (s.status === 'RESERVED') vc.res++;
      else if (s.status === 'UNAVAILABLE') vc.unavail++;
    }
  }

  const chargingCounts = emptyClassCount();
  for (const p of chargingPoints) {
    const vc = chargingCounts[p.vehicleClass];
    vc.total++;
    if (p.status === 'AVAILABLE') vc.free++;
    else if (p.status === 'CHARGING') vc.charging++;
    else if (p.status === 'FAULTY') vc.faulty++;
  }

  let availCount = 0;
  for (const v of vehicles) {
    if (v.status === 'AVAILABLE' && v.batteryPct >= config.MIN_RENTAL_BATTERY_PCT && !chargingRvSet.has(v.id)) {
      availCount++;
    }
  }

  const summary = buildSummary(hub, availCount, parkingAll, parkingPub, chargingCounts, redirectToHubId, now);

  return {
    ...summary,
    vehicles: vehicles.map((v) => ({
      id: v.id,
      hubId: v.hubId,
      type: v.type,
      vehicleClass: v.vehicleClass as 'MOTORCYCLE',
      status: v.status,
      batteryPct: v.batteryPct,
      charging: chargingRvSet.has(v.id),
    })),
    parkingSpaces: parkingSpaces.map((s) => ({
      id: s.id,
      hubId: s.hubId,
      vehicleClass: s.vehicleClass,
      pool: s.pool,
      status: s.status,
    })),
    chargingPoints: chargingPoints.map((p) => ({
      id: p.id,
      hubId: p.hubId,
      vehicleClass: p.vehicleClass,
      status: p.status,
    })),
  };
}

export async function alternativeHubs(
  query: { need: AlternativeNeed; vehicleClass: VehicleClass; excludeHubId?: string; from?: Date; to?: Date },
  now: Date = new Date(),
  client: DbClient = db,
): Promise<Alternative[]> {
  const { need, vehicleClass, excludeHubId, from, to } = query;

  const hubs = await client.hub.findMany({ orderBy: { id: 'asc' } });
  const eligible = hubs.filter((h) => {
    if (h.id === excludeHubId) return false;
    if (isDegraded(h.lastTelemetryAt, now, config.STALLED_FEED_INTERVALS, config.TELEMETRY_INTERVAL_SEC)) return false;
    return true;
  });
  if (eligible.length === 0) return [];

  const eligibleIds = eligible.map((h) => h.id);

  let freeCounts: Map<string, number>;
  let needLabel: string;

  if (need === 'FLEET_PARKING') {
    needLabel = `free FLEET ${vehicleClass.toLowerCase()} space(s)`;
    if (from && to) {
      freeCounts = await fleetParkingWindowFree(client, eligibleIds, vehicleClass);
    } else {
      freeCounts = await statusFreeCount(client, 'parkingSpace', eligibleIds, vehicleClass, { pool: 'FLEET' });
    }
  } else if (need === 'PUBLIC_PARKING') {
    needLabel = `free PUBLIC ${vehicleClass.toLowerCase()} space(s)`;
    if (from && to) {
      freeCounts = await publicParkingWindowFree(client, eligibleIds, vehicleClass, from, to);
    } else {
      freeCounts = await statusFreeCount(client, 'parkingSpace', eligibleIds, vehicleClass, { pool: 'PUBLIC' });
    }
  } else {
    needLabel = `free ${vehicleClass.toLowerCase()} charging point(s)`;
    if (from && to) {
      freeCounts = await chargingWindowFree(client, eligibleIds, vehicleClass, from, to);
    } else {
      freeCounts = await statusFreeCount(client, 'chargingPoint', eligibleIds, vehicleClass, {});
    }
  }

  const items = eligible
    .filter((h) => (freeCounts.get(h.id) ?? 0) > 0)
    .map((h) => ({ hubId: h.id, hubName: h.name, free: freeCounts.get(h.id)! }));

  if (items.length === 0) return [];

  let redirectTargetHubId: string | null = null;
  let excludeHubName: string | null = null;
  if (excludeHubId) {
    const redirect = await client.hubRedirect.findFirst({
      where: { fromHubId: excludeHubId, activeUntil: { gt: now } },
      orderBy: { id: 'desc' },
    });
    if (redirect && items.some((i) => i.hubId === redirect.toHubId)) {
      redirectTargetHubId = redirect.toHubId;
      const srcHub = hubs.find((h) => h.id === excludeHubId);
      excludeHubName = srcHub?.name ?? excludeHubId;
    }
  }

  return rankAlternatives(items, redirectTargetHubId, excludeHubName, needLabel);
}

// ---- internal query helpers (fixed query count) ----

async function statusFreeCount(
  client: DbClient,
  model: 'parkingSpace' | 'chargingPoint',
  hubIds: string[],
  vehicleClass: VehicleClass,
  extra: { pool?: 'FLEET' | 'PUBLIC' },
): Promise<Map<string, number>> {
  const freeStatus = model === 'parkingSpace' ? 'FREE' : 'AVAILABLE';
  const where: Record<string, unknown> = { hubId: { in: hubIds }, vehicleClass, status: freeStatus };
  if (extra.pool) where['pool'] = extra.pool;

  const rows = await (client[model] as never as { groupBy: (args: unknown) => Promise<Array<{ hubId: string; _count: { _all: number } }>> }).groupBy({
    by: ['hubId'],
    where,
    _count: { _all: true },
  });
  const m = new Map<string, number>();
  for (const r of rows) m.set(r.hubId, r._count._all);
  return m;
}

async function fleetParkingWindowFree(
  client: DbClient,
  hubIds: string[],
  vehicleClass: VehicleClass,
): Promise<Map<string, number>> {
  // FLEET spaces don't have user parking_reservations (D-19 uses redistribution_task),
  // so "free for a window" is the same as "currently FREE".
  return statusFreeCount(client, 'parkingSpace', hubIds, vehicleClass, { pool: 'FLEET' });
}

async function publicParkingWindowFree(
  client: DbClient,
  hubIds: string[],
  vehicleClass: VehicleClass,
  from: Date,
  to: Date,
): Promise<Map<string, number>> {
  const rows = await (client.$queryRaw as (s: TemplateStringsArray, ...v: unknown[]) => Promise<Array<{ hubId: string; free: bigint }>>)`
    SELECT ps."hubId", COUNT(*)::bigint AS free
    FROM parking_space ps
    WHERE ps."hubId" = ANY(${hubIds})
      AND ps."vehicleClass" = ${vehicleClass}::"VehicleClass"
      AND ps.pool = 'PUBLIC'::"ParkingPool"
      AND ps.status != 'UNAVAILABLE'::"ParkingSpaceStatus"
      AND NOT EXISTS (
        SELECT 1 FROM parking_reservation pr
        WHERE pr."parkingSpaceId" = ps.id
          AND pr.status IN ('CONFIRMED', 'ACTIVE')
          AND pr."windowStart" < ${to}
          AND pr."windowEnd" > ${from}
      )
    GROUP BY ps."hubId"`;
  const m = new Map<string, number>();
  for (const r of rows) m.set(r.hubId, Number(r.free));
  return m;
}

async function chargingWindowFree(
  client: DbClient,
  hubIds: string[],
  vehicleClass: VehicleClass,
  from: Date,
  to: Date,
): Promise<Map<string, number>> {
  const rows = await (client.$queryRaw as (s: TemplateStringsArray, ...v: unknown[]) => Promise<Array<{ hubId: string; free: bigint }>>)`
    SELECT cp."hubId", COUNT(*)::bigint AS free
    FROM charging_point cp
    WHERE cp."hubId" = ANY(${hubIds})
      AND cp."vehicleClass" = ${vehicleClass}::"VehicleClass"
      AND cp.status != 'FAULTY'::"ChargingPointStatus"
      AND NOT EXISTS (
        SELECT 1 FROM charging_request cr
        WHERE cr."chargingPointId" = cp.id
          AND cr.status IN ('SCHEDULED', 'CHARGING')
          AND cr."slotStart" < ${to}
          AND cr."slotEnd" > ${from}
      )
    GROUP BY cp."hubId"`;
  const m = new Map<string, number>();
  for (const r of rows) m.set(r.hubId, Number(r.free));
  return m;
}
