// Monitoring & alerts service: network dashboard (FR-31), Hub drill-down (FR-32),
// alert evaluation & dedupe/suppression (FR-33, FR-35, BR-09, UC-20, NFR-27),
// alert inbox, acknowledge & dismiss (FR-34, FR-63, BR-05).

import { Prisma, type Alert as PrismaAlert } from '@prisma/client';
import { audit } from '../../core/audit';
import { config } from '../../core/config';
import { db, lockRow } from '../../core/db';
import { badRequest } from '../../core/errors';
import { encodeCursor, type ListCursor } from '../../core/pagination';
import { assertTransition } from '../../core/stateMachine';
import {
  VEHICLE_CLASSES,
  type AlertStatus,
  type AlertType,
  type Role,
  type VehicleClass,
} from '../../types/enums';
import type {
  Alert,
  AlertList,
  DashboardHub,
  DashboardResponse,
  OpsHubDetail,
  ResourceOccupant,
} from '../../types/monitoring';
import { isDegraded, roundTo1, utilPct } from '../hubs/hubs.metrics';
import { getHub, listHubs } from '../hubs/hubs.service';
import { detectImbalance } from '../redistribution/redistribution.service';

export const ALERT_NOTE_MAX = 1000;
export const SUPPRESSED_SETTING_PREFIX = 'monitoring.suppressed:';

const BASE_EVALUATED_ALERT_TYPES: readonly AlertType[] = [
  'NEAR_CAPACITY',
  'LOW_BATTERY',
  'FAULT',
  'STALLED_FEED',
];

const IMBALANCE_ALERT_TYPES: readonly AlertType[] = ['SHORTAGE', 'SURPLUS'];

export interface MonitoringActor {
  id: string;
  role: Role;
}

export interface AlertListFilters {
  status?: AlertStatus;
  type?: AlertType;
  hubId?: string;
}

export interface AlertListPageOptions {
  limit: number;
  cursor: ListCursor | null;
}

interface DesiredAlert {
  type: AlertType;
  hubId: string;
  vehicleClass: VehicleClass | null;
  resourceIds: string[];
  metric: Record<string, number | string>;
  message: string;
  dedupeKey: string;
}

function toAlertDto(row: PrismaAlert): Alert {
  const rawMetric = row.metric;
  const metric: Record<string, number | string> = {};
  if (rawMetric && typeof rawMetric === 'object' && !Array.isArray(rawMetric)) {
    for (const [k, v] of Object.entries(rawMetric as Record<string, unknown>)) {
      if (typeof v === 'number' || typeof v === 'string') {
        metric[k] = v;
      }
    }
  }

  return {
    id: row.id,
    type: row.type,
    status: row.status,
    hubId: row.hubId,
    vehicleClass: row.vehicleClass ?? null,
    resourceIds: [...row.resourceIds],
    metric,
    message: row.message,
    createdAt: row.createdAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
    closedAt: row.closedAt ? row.closedAt.toISOString() : null,
    closedById: row.closedById ?? null,
  };
}

function isAlertUniqueError(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
    return true;
  }
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('uq_alert_open') || msg.includes('23505');
}

function readSuppressedHubId(val: unknown): string | null {
  if (!val || typeof val !== 'object' || Array.isArray(val)) return null;
  const hubId = (val as Record<string, unknown>)['hubId'];
  return typeof hubId === 'string' ? hubId : null;
}

/**
 * FR-31, UC-19, CONTRACTS §10: Network dashboard across all Hubs.
 * Reuses `hubs.listHubs(now)` as the single source of truth for degradation,
 * available rental vehicle counts (D-18), and rounded utilisations.
 */
export async function getDashboard(now: Date = new Date()): Promise<DashboardResponse> {
  const [
    hubSummaries,
    activeRentalGroups,
    queueGroups,
    openAlertGroups,
    totalRentalVehicles,
    totalChargingPoints,
  ] = await Promise.all([
    listHubs(now),
    db.vehicleReservation.groupBy({
      by: ['hubId'],
      where: { status: 'ACTIVE' },
      _count: { _all: true },
    }),
    db.chargingRequest.groupBy({
      by: ['hubId', 'vehicleClass'],
      where: { status: 'QUEUED' },
      _count: { _all: true },
    }),
    db.alert.groupBy({
      by: ['hubId'],
      where: { status: 'OPEN' },
      _count: { _all: true },
    }),
    db.rentalVehicle.count(),
    db.chargingPoint.count(),
  ]);

  const activeRentalsByHub = new Map<string, number>();
  let totalActiveRentals = 0;
  for (const g of activeRentalGroups) {
    activeRentalsByHub.set(g.hubId, g._count._all);
    totalActiveRentals += g._count._all;
  }

  const queueByHub = new Map<string, Record<VehicleClass, number>>();
  for (const g of queueGroups) {
    const entry = queueByHub.get(g.hubId) ?? { MOTORCYCLE: 0, CAR: 0 };
    entry[g.vehicleClass] = g._count._all;
    queueByHub.set(g.hubId, entry);
  }

  const openAlertsByHub = new Map<string, number>();
  for (const g of openAlertGroups) {
    openAlertsByHub.set(g.hubId, g._count._all);
  }

  const hubs: DashboardHub[] = hubSummaries.map((summary) => ({
    hubId: summary.id,
    name: summary.name,
    degraded: summary.degraded,
    lastTelemetryAt: summary.lastTelemetryAt,
    availableRentalVehicles: {
      MOTORCYCLE: summary.availableRentalVehicles,
      CAR: 0,
    },
    parkingUtilPct: {
      MOTORCYCLE: summary.parking.MOTORCYCLE.utilPct,
      CAR: summary.parking.CAR.utilPct,
    },
    chargingUtilPct: {
      MOTORCYCLE: summary.charging.MOTORCYCLE.utilPct,
      CAR: summary.charging.CAR.utilPct,
    },
    activeRentals: activeRentalsByHub.get(summary.id) ?? 0,
    queueDepth: queueByHub.get(summary.id) ?? { MOTORCYCLE: 0, CAR: 0 },
    openAlerts: openAlertsByHub.get(summary.id) ?? 0,
  }));

  return {
    hubs,
    totals: {
      rentalVehicles: totalRentalVehicles,
      chargingPoints: totalChargingPoints,
      activeRentals: totalActiveRentals,
    },
    serverNow: now.toISOString(),
  };
}

/**
 * FR-32, UC-19, CONTRACTS §10: Enriched Hub drill-down with `occupiedBy` per resource.
 * Uses `hubs.getHub(hubId, now)` plus 3 Hub-scoped queries (fixed query count, no N+1).
 */
export async function getOpsHubDetail(
  hubId: string,
  now: Date = new Date(),
): Promise<OpsHubDetail> {
  const detail = await getHub(hubId, now);

  const [parkedVehicles, liveParkingReservations, activeChargingRequests] = await Promise.all([
    db.rentalVehicle.findMany({
      where: { hubId, parkingSpaceId: { not: null } },
      select: { id: true, parkingSpaceId: true },
    }),
    db.parkingReservation.findMany({
      where: { hubId, status: { in: ['ACTIVE', 'CONFIRMED'] } },
      select: {
        id: true,
        parkingSpaceId: true,
        status: true,
        windowStart: true,
        windowEnd: true,
        user: { select: { displayName: true } },
      },
      orderBy: { id: 'asc' },
    }),
    db.chargingRequest.findMany({
      where: { hubId, status: 'CHARGING' },
      select: {
        id: true,
        chargingPointId: true,
        rentalVehicleId: true,
        owner: { select: { displayName: true } },
      },
      orderBy: { id: 'asc' },
    }),
  ]);

  const vehicleBySpaceId = new Map<string, string>();
  for (const rv of parkedVehicles) {
    if (rv.parkingSpaceId) {
      vehicleBySpaceId.set(rv.parkingSpaceId, rv.id);
    }
  }

  const activeParkingBySpaceId = new Map<string, ResourceOccupant>();
  const confirmedCurrentBySpaceId = new Map<string, ResourceOccupant>();
  const nowMs = now.getTime();
  for (const pr of liveParkingReservations) {
    if (pr.status === 'ACTIVE') {
      if (!activeParkingBySpaceId.has(pr.parkingSpaceId)) {
        activeParkingBySpaceId.set(pr.parkingSpaceId, {
          kind: 'parkingReservation',
          id: pr.id,
          userDisplayName: pr.user.displayName,
        });
      }
    } else if (
      pr.status === 'CONFIRMED' &&
      pr.windowStart.getTime() <= nowMs &&
      nowMs < pr.windowEnd.getTime()
    ) {
      if (!confirmedCurrentBySpaceId.has(pr.parkingSpaceId)) {
        confirmedCurrentBySpaceId.set(pr.parkingSpaceId, {
          kind: 'parkingReservation',
          id: pr.id,
          userDisplayName: pr.user.displayName,
        });
      }
    }
  }

  const chargingByPointId = new Map<string, ResourceOccupant>();
  const chargingByVehicleId = new Map<string, ResourceOccupant>();
  for (const cr of activeChargingRequests) {
    const occupant: ResourceOccupant = {
      kind: 'chargingRequest',
      id: cr.id,
      ...(cr.owner ? { userDisplayName: cr.owner.displayName } : {}),
    };
    if (cr.chargingPointId && !chargingByPointId.has(cr.chargingPointId)) {
      chargingByPointId.set(cr.chargingPointId, occupant);
    }
    if (cr.rentalVehicleId && !chargingByVehicleId.has(cr.rentalVehicleId)) {
      chargingByVehicleId.set(cr.rentalVehicleId, occupant);
    }
  }

  return {
    ...detail,
    vehicles: detail.vehicles.map((v) => ({
      ...v,
      occupiedBy: chargingByVehicleId.get(v.id) ?? null,
    })),
    parkingSpaces: detail.parkingSpaces.map((s) => {
      const rvId = vehicleBySpaceId.get(s.id);
      if (rvId) {
        return { ...s, occupiedBy: { kind: 'rentalVehicle', id: rvId } };
      }
      const activePr = activeParkingBySpaceId.get(s.id);
      if (activePr) {
        return { ...s, occupiedBy: activePr };
      }
      if (s.status === 'RESERVED') {
        const confirmedPr = confirmedCurrentBySpaceId.get(s.id);
        if (confirmedPr) {
          return { ...s, occupiedBy: confirmedPr };
        }
      }
      return { ...s, occupiedBy: null };
    }),
    chargingPoints: detail.chargingPoints.map((p) => ({
      ...p,
      occupiedBy: chargingByPointId.get(p.id) ?? null,
    })),
  };
}

/**
 * FR-33, FR-35, BR-09, UC-20, NFR-27: Evaluate alert conditions for one Hub,
 * upsert active (OPEN/ACKNOWLEDGED) alerts, auto-resolve cleared ones, and manage
 * Postgres-backed DISMISSED suppression entries.
 */
export async function evaluateHub(hubId: string, now: Date = new Date()): Promise<void> {
  const hub = await db.hub.findUnique({ where: { id: hubId } });
  if (!hub) {
    return;
  }

  const hubDegraded = isDegraded(
    hub.lastTelemetryAt,
    now,
    config.STALLED_FEED_INTERVALS,
    config.TELEMETRY_INTERVAL_SEC,
  );

  // UC-24 E1: When degraded, suspend SHORTAGE/SURPLUS evaluation and leave existing ones untouched.
  const activeAlertTypes: AlertType[] = hubDegraded
    ? [...BASE_EVALUATED_ALERT_TYPES]
    : [...BASE_EVALUATED_ALERT_TYPES, ...IMBALANCE_ALERT_TYPES];

  const [spaces, points, vehicles, openIncidents, activeAlerts, suppressedSettings] =
    await Promise.all([
      db.parkingSpace.findMany({
        where: { hubId },
        select: { id: true, vehicleClass: true, status: true },
      }),
      db.chargingPoint.findMany({
        where: { hubId },
        select: { id: true, vehicleClass: true, status: true },
      }),
      db.rentalVehicle.findMany({
        where: { hubId },
        select: { id: true, status: true, batteryPct: true },
      }),
      db.incident.findMany({
        where: {
          hubId,
          status: { in: ['REPORTED', 'IN_MAINTENANCE'] },
        },
        select: {
          id: true,
          resourceType: true,
          resourceId: true,
          vehicleClass: true,
          category: true,
        },
      }),
      db.alert.findMany({
        where: {
          hubId,
          status: { in: ['OPEN', 'ACKNOWLEDGED'] },
          type: { in: activeAlertTypes },
        },
      }),
      db.setting.findMany({
        where: { key: { startsWith: SUPPRESSED_SETTING_PREFIX } },
      }),
    ]);

  const desiredByKey = new Map<string, DesiredAlert>();

  // 1. NEAR_CAPACITY (BR-09): parking (both pools, D-16) and charging per VehicleClass
  for (const vc of VEHICLE_CLASSES) {
    let pTotal = 0;
    let pUsed = 0;
    let pUnavail = 0;
    for (const s of spaces) {
      if (s.vehicleClass !== vc) continue;
      pTotal++;
      if (s.status === 'OCCUPIED' || s.status === 'RESERVED') pUsed++;
      else if (s.status === 'UNAVAILABLE') pUnavail++;
    }
    const pRaw = utilPct(pUsed, pTotal, pUnavail);
    if (pTotal > 0 && pRaw >= config.NEAR_CAPACITY_PCT) {
      const dedupeKey = `NEAR_CAPACITY:${hubId}:PARKING:${vc}`;
      const rounded = roundTo1(pRaw);
      desiredByKey.set(dedupeKey, {
        type: 'NEAR_CAPACITY',
        hubId,
        vehicleClass: vc,
        resourceIds: [],
        metric: {
          kind: 'PARKING',
          utilPct: rounded,
          used: pUsed,
          usable: pTotal - pUnavail,
          total: pTotal,
          thresholdPct: config.NEAR_CAPACITY_PCT,
        },
        message: `${hub.name} ${vc} parking utilisation is at ${rounded}% (threshold ${config.NEAR_CAPACITY_PCT}%).`,
        dedupeKey,
      });
    }

    let cTotal = 0;
    let cCharging = 0;
    let cFaulty = 0;
    for (const p of points) {
      if (p.vehicleClass !== vc) continue;
      cTotal++;
      if (p.status === 'CHARGING') cCharging++;
      else if (p.status === 'FAULTY') cFaulty++;
    }
    const cRaw = utilPct(cCharging, cTotal, cFaulty);
    if (cTotal > 0 && cRaw >= config.NEAR_CAPACITY_PCT) {
      const dedupeKey = `NEAR_CAPACITY:${hubId}:CHARGING:${vc}`;
      const rounded = roundTo1(cRaw);
      desiredByKey.set(dedupeKey, {
        type: 'NEAR_CAPACITY',
        hubId,
        vehicleClass: vc,
        resourceIds: [],
        metric: {
          kind: 'CHARGING',
          utilPct: rounded,
          used: cCharging,
          usable: cTotal - cFaulty,
          total: cTotal,
          thresholdPct: config.NEAR_CAPACITY_PCT,
        },
        message: `${hub.name} ${vc} charging utilisation is at ${rounded}% (threshold ${config.NEAR_CAPACITY_PCT}%).`,
        dedupeKey,
      });
    }
  }

  // 2. LOW_BATTERY (FR-33): AVAILABLE or LOW_BATTERY rental vehicles < MIN_RENTAL_BATTERY_PCT
  const lowBatteryVehicles = vehicles
    .filter(
      (v) =>
        (v.status === 'AVAILABLE' || v.status === 'LOW_BATTERY') &&
        v.batteryPct < config.MIN_RENTAL_BATTERY_PCT,
    )
    .sort((a, b) => a.id.localeCompare(b.id));
  if (lowBatteryVehicles.length > 0) {
    const dedupeKey = `LOW_BATTERY:${hubId}`;
    const lowestBatteryPct = lowBatteryVehicles.reduce(
      (min, v) => (v.batteryPct < min ? v.batteryPct : min),
      lowBatteryVehicles[0]!.batteryPct,
    );
    desiredByKey.set(dedupeKey, {
      type: 'LOW_BATTERY',
      hubId,
      vehicleClass: null,
      resourceIds: lowBatteryVehicles.map((v) => v.id),
      metric: {
        count: lowBatteryVehicles.length,
        lowestBatteryPct,
        thresholdPct: config.MIN_RENTAL_BATTERY_PCT,
      },
      message: `${lowBatteryVehicles.length} rental vehicle(s) below ${config.MIN_RENTAL_BATTERY_PCT}% battery at ${hub.name}.`,
      dedupeKey,
    });
  }

  // 3. FAULT (FR-33): open incidents whose resource is currently withdrawn
  const faultyVehicleIds = new Set(vehicles.filter((v) => v.status === 'FAULTY').map((v) => v.id));
  const unavailSpaceIds = new Set(spaces.filter((s) => s.status === 'UNAVAILABLE').map((s) => s.id));
  const faultyPointIds = new Set(points.filter((p) => p.status === 'FAULTY').map((p) => p.id));

  for (const inc of openIncidents) {
    const isWithdrawn =
      (inc.resourceType === 'RENTAL_VEHICLE' && faultyVehicleIds.has(inc.resourceId)) ||
      (inc.resourceType === 'PARKING_SPACE' && unavailSpaceIds.has(inc.resourceId)) ||
      (inc.resourceType === 'CHARGING_POINT' && faultyPointIds.has(inc.resourceId));
    if (!isWithdrawn) continue;

    const dedupeKey = `FAULT:${inc.resourceId}`;
    desiredByKey.set(dedupeKey, {
      type: 'FAULT',
      hubId,
      vehicleClass: inc.vehicleClass,
      resourceIds: [inc.resourceId],
      metric: {
        incidentId: inc.id,
        resourceType: inc.resourceType,
        category: inc.category,
      },
      message: `${inc.resourceType} ${inc.resourceId} at ${hub.name} is withdrawn (${inc.category}).`,
      dedupeKey,
    });
  }

  // 4. STALLED_FEED (FR-35): degraded telemetry feed
  if (hubDegraded) {
    const thresholdSec = config.STALLED_FEED_INTERVALS * config.TELEMETRY_INTERVAL_SEC;
    const stalledSec =
      hub.lastTelemetryAt === null
        ? -1
        : Math.floor((now.getTime() - hub.lastTelemetryAt.getTime()) / 1000);
    const dedupeKey = `STALLED:${hubId}`;
    desiredByKey.set(dedupeKey, {
      type: 'STALLED_FEED',
      hubId,
      vehicleClass: null,
      resourceIds: [],
      metric: { stalledSec, thresholdSec },
      message:
        hub.lastTelemetryAt === null
          ? `${hub.name} has never reported telemetry (threshold ${thresholdSec}s).`
          : `${hub.name} telemetry feed stalled for ${stalledSec}s (threshold ${thresholdSec}s).`,
      dedupeKey,
    });
  } else {
    // 5. SHORTAGE / SURPLUS (FR-43, BR-15; suspended when DEGRADED per UC-24 E1)
    const imbalances = await detectImbalance(hubId, now);
    for (const imb of imbalances) {
      if (imb.state !== 'SHORTAGE' && imb.state !== 'SURPLUS') continue;
      const dedupeKey = `${imb.state}:${hubId}:${imb.vehicleClass}`;
      desiredByKey.set(dedupeKey, {
        type: imb.state,
        hubId,
        vehicleClass: imb.vehicleClass,
        resourceIds: [],
        metric: {
          available: imb.available,
          min: imb.min,
          max: imb.max,
          amount: imb.amount,
        },
        message:
          imb.state === 'SHORTAGE'
            ? `${hub.name} ${imb.vehicleClass} vehicle shortage: ${imb.available} available (min ${imb.min}, deficit ${imb.amount}).`
            : `${hub.name} ${imb.vehicleClass} vehicle surplus: ${imb.available} available (max ${imb.max}, excess ${imb.amount}).`,
        dedupeKey,
      });
    }
  }

  // Build active and suppressed maps
  const activeByKey = new Map<string, PrismaAlert>();
  for (const a of activeAlerts) {
    activeByKey.set(a.dedupeKey, a);
  }

  const suppressedKeys = new Set<string>();
  const hubSuppressedSettingKeys: Array<{ settingKey: string; dedupeKey: string }> = [];
  for (const s of suppressedSettings) {
    const dedupeKey = s.key.slice(SUPPRESSED_SETTING_PREFIX.length);
    suppressedKeys.add(dedupeKey);
    if (readSuppressedHubId(s.value) === hubId) {
      hubSuppressedSettingKeys.push({ settingKey: s.key, dedupeKey });
    }
  }

  // Sync step 1: upsert active alerts (respecting ACKNOWLEDGED status and DISMISSED suppression)
  for (const [dedupeKey, desired] of desiredByKey) {
    const existing = activeByKey.get(dedupeKey);
    if (existing) {
      // Guard status IN ('OPEN','ACKNOWLEDGED') so a concurrently dismissed/resolved row is never mutated.
      await db.alert.updateMany({
        where: {
          id: existing.id,
          status: { in: ['OPEN', 'ACKNOWLEDGED'] },
        },
        data: {
          lastSeenAt: now,
          resourceIds: desired.resourceIds,
          metric: desired.metric as Prisma.InputJsonValue,
          message: desired.message,
        },
      });
      continue;
    }

    if (suppressedKeys.has(dedupeKey)) {
      continue;
    }

    try {
      await db.alert.create({
        data: {
          type: desired.type,
          status: 'OPEN',
          hubId: desired.hubId,
          vehicleClass: desired.vehicleClass,
          resourceIds: desired.resourceIds,
          metric: desired.metric as Prisma.InputJsonValue,
          message: desired.message,
          dedupeKey: desired.dedupeKey,
          createdAt: now,
          lastSeenAt: now,
        },
      });
    } catch (err: unknown) {
      if (isAlertUniqueError(err)) {
        // Concurrent evaluateHub race on uq_alert_open: update the winning active row instead of failing.
        await db.alert.updateMany({
          where: {
            dedupeKey: desired.dedupeKey,
            status: { in: ['OPEN', 'ACKNOWLEDGED'] },
          },
          data: {
            lastSeenAt: now,
            resourceIds: desired.resourceIds,
            metric: desired.metric as Prisma.InputJsonValue,
            message: desired.message,
          },
        });
      } else {
        throw err;
      }
    }
  }

  // Sync step 2: auto-resolve active alerts (of the 4 evaluated types) whose condition cleared
  for (const active of activeAlerts) {
    if (desiredByKey.has(active.dedupeKey)) {
      continue;
    }
    await db.$transaction(async (tx) => {
      await lockRow(tx, 'alert', active.id);
      const row = await tx.alert.findUnique({ where: { id: active.id } });
      if (!row || (row.status !== 'OPEN' && row.status !== 'ACKNOWLEDGED')) {
        return;
      }
      assertTransition('alert', row.status, 'RESOLVED');
      await tx.alert.update({
        where: { id: row.id },
        data: {
          status: 'RESOLVED',
          closedAt: now,
          lastSeenAt: now,
        },
      });
    });
  }

  // Sync step 3: clear DISMISSED suppression keys for this Hub whose condition has cleared
  // (while degraded, keep SHORTAGE:/SURPLUS: suppression keys untouched per UC-24 E1)
  const keysToDelete = hubSuppressedSettingKeys
    .filter((entry) => {
      if (
        hubDegraded &&
        (entry.dedupeKey.startsWith('SHORTAGE:') || entry.dedupeKey.startsWith('SURPLUS:'))
      ) {
        return false;
      }
      return !desiredByKey.has(entry.dedupeKey);
    })
    .map((entry) => entry.settingKey);
  if (keysToDelete.length > 0) {
    await db.setting.deleteMany({
      where: { key: { in: keysToDelete } },
    });
  }
}

/**
 * Evaluate all Hubs ordered by `id ASC`, isolating per-Hub failures so one bad Hub
 * never stops evaluation of the remaining Hubs.
 */
export async function evaluateAllHubs(now: Date = new Date()): Promise<void> {
  const hubs = await db.hub.findMany({
    orderBy: { id: 'asc' },
    select: { id: true },
  });

  for (const hub of hubs) {
    try {
      await evaluateHub(hub.id, now);
    } catch (err) {
      console.error(`[monitoring] evaluateHub failed for Hub "${hub.id}"`, err);
    }
  }
}

/**
 * FR-33, FR-35, CONTRACTS §10: List alerts with default `status = 'OPEN'`,
 * optional `type` / `hubId` filters, and cursor pagination (`createdAt DESC, id DESC`).
 */
export async function listAlerts(
  filters: AlertListFilters,
  page: AlertListPageOptions,
): Promise<AlertList> {
  const status: AlertStatus = filters.status ?? 'OPEN';

  const where: Prisma.AlertWhereInput = {
    status,
    ...(filters.type ? { type: filters.type } : {}),
    ...(filters.hubId ? { hubId: filters.hubId } : {}),
    ...(page.cursor
      ? {
          OR: [
            { createdAt: { lt: page.cursor.createdAt } },
            { createdAt: page.cursor.createdAt, id: { lt: page.cursor.id } },
          ],
        }
      : {}),
  };

  const rows = await db.alert.findMany({
    where,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: page.limit + 1,
  });

  const hasMore = rows.length > page.limit;
  const pageRows = hasMore ? rows.slice(0, page.limit) : rows;
  const lastRow = pageRows[pageRows.length - 1];
  const nextCursor = hasMore && lastRow ? encodeCursor(lastRow) : null;

  return {
    items: pageRows.map(toAlertDto),
    nextCursor,
  };
}

async function transitionAlert(
  actor: MonitoringActor,
  alertId: string,
  target: 'ACKNOWLEDGED' | 'DISMISSED',
  note?: string,
  now: Date = new Date(),
): Promise<Alert> {
  let trimmedNote: string | undefined;
  if (note !== undefined) {
    const trimmed = note.trim();
    if (trimmed.length > ALERT_NOTE_MAX) {
      throw badRequest(`note must be at most ${ALERT_NOTE_MAX} characters.`, 'note');
    }
    trimmedNote = trimmed.length > 0 ? trimmed : undefined;
  }

  return db.$transaction(async (tx) => {
    await lockRow(tx, 'alert', alertId);
    const alert = await tx.alert.findUniqueOrThrow({ where: { id: alertId } });

    assertTransition('alert', alert.status, target);

    const updated = await tx.alert.update({
      where: { id: alert.id },
      data: {
        status: target,
        closedAt: now,
        closedById: actor.id,
      },
    });

    if (target === 'DISMISSED') {
      const suppressionKey = `${SUPPRESSED_SETTING_PREFIX}${alert.dedupeKey}`;
      const suppressionValue: Prisma.InputJsonValue = {
        hubId: alert.hubId,
        alertId: alert.id,
        dismissedAt: now.toISOString(),
      };
      await tx.setting.upsert({
        where: { key: suppressionKey },
        create: { key: suppressionKey, value: suppressionValue },
        update: { value: suppressionValue },
      });
    }

    await audit(tx, {
      actorId: actor.id,
      actorRole: actor.role,
      action: target === 'ACKNOWLEDGED' ? 'ALERT_ACKNOWLEDGED' : 'ALERT_DISMISSED',
      entityType: 'alert',
      entityIds: [alert.id],
      reason: trimmedNote,
      details: {
        dedupeKey: alert.dedupeKey,
        hubId: alert.hubId,
        type: alert.type,
      },
    });

    return toAlertDto(updated);
  });
}

/**
 * FR-34, FR-63, BR-05: Acknowledge an OPEN alert (`OPEN -> ACKNOWLEDGED`).
 */
export async function acknowledgeAlert(
  actor: MonitoringActor,
  alertId: string,
  note?: string,
  now: Date = new Date(),
): Promise<Alert> {
  return transitionAlert(actor, alertId, 'ACKNOWLEDGED', note, now);
}

/**
 * FR-34, FR-63, BR-05, NFR-27: Dismiss an OPEN alert (`OPEN -> DISMISSED`) and
 * persist a Postgres suppression key until the underlying condition clears once.
 */
export async function dismissAlert(
  actor: MonitoringActor,
  alertId: string,
  note?: string,
  now: Date = new Date(),
): Promise<Alert> {
  return transitionAlert(actor, alertId, 'DISMISSED', note, now);
}
