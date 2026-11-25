// Charging engine service: weights persistence (FR-48), Hub queue/schedule projection
// (FR-22, FR-49, FR-50, BR-06), and Operator read-only views (CONTRACTS §8.2).

import type { ChargingPoint as PrismaChargingPoint, ChargingRequest } from '@prisma/client';
import { audit } from '../../core/audit';
import { config } from '../../core/config';
import { db, type DbClient, type Tx } from '../../core/db';
import { badRequest } from '../../core/errors';
import { events } from '../../core/events';
import { toIso } from '../../core/time';
import type {
  ChargingQueue,
  ChargingQueueEntry,
  ChargingRequestView,
  ChargingSchedule,
  ChargingSchedulePoint,
  ChargingWeights,
  ChargingWeightsView,
} from '../../types/charging';
import { VEHICLE_CLASSES, type Role, type VehicleClass } from '../../types/enums';
import type { ChargingPoint } from '../../types/hubs';
import { orderForHub, score, scoreBreakdown, type PriorityConfig } from './priority';
import {
  projectSchedule,
  type ScheduleBookedInput,
  type ScheduleConfig,
  type ScheduleProjection,
  type ScheduleRunningInput,
} from './schedule';

export const CHARGING_WEIGHTS_SETTING_KEY = 'charging.weights';

export interface WeightsActor {
  id: string;
  role: Role;
}

function getPriorityConfig(): PriorityConfig {
  return {
    urgencyHorizonMin: config.URGENCY_HORIZON_MIN,
    waitingFullMin: config.WAITING_FULL_MIN,
  };
}

function getScheduleConfig(): ScheduleConfig {
  return {
    chargeRatePctPerMin: config.CHARGE_RATE_PCT_PER_MIN,
    demoTimeScale: config.DEMO_TIME_SCALE,
  };
}

function isValidWeightsJson(val: unknown): val is ChargingWeights {
  if (!val || typeof val !== 'object') return false;
  const o = val as Record<string, unknown>;
  return (
    typeof o['battery'] === 'number' &&
    Number.isFinite(o['battery']) &&
    o['battery'] >= 0 &&
    typeof o['urgency'] === 'number' &&
    Number.isFinite(o['urgency']) &&
    o['urgency'] >= 0 &&
    typeof o['waiting'] === 'number' &&
    Number.isFinite(o['waiting']) &&
    o['waiting'] >= 0 &&
    o['battery'] + o['urgency'] + o['waiting'] > 0
  );
}

function validateWeightsInput(input: ChargingWeights): ChargingWeights {
  const fields: (keyof ChargingWeights)[] = ['battery', 'urgency', 'waiting'];
  for (const field of fields) {
    const val = input[field];
    if (typeof val !== 'number' || !Number.isFinite(val)) {
      throw badRequest(`${field} must be a finite number.`, field);
    }
    if (val < 0) {
      throw badRequest(`${field} must be at least 0.`, field);
    }
  }
  if (input.battery + input.urgency + input.waiting <= 0) {
    throw badRequest('At least one weight must be greater than 0.', 'weights');
  }
  return {
    battery: input.battery,
    urgency: input.urgency,
    waiting: input.waiting,
  };
}

export async function getWeights(client: DbClient = db): Promise<ChargingWeightsView> {
  const row = await client.setting.findUnique({
    where: { key: CHARGING_WEIGHTS_SETTING_KEY },
  });
  if (row && isValidWeightsJson(row.value)) {
    return {
      battery: row.value.battery,
      urgency: row.value.urgency,
      waiting: row.value.waiting,
      isDefault: false,
    };
  }
  return {
    battery: config.CHARGING_WEIGHTS.battery,
    urgency: config.CHARGING_WEIGHTS.urgency,
    waiting: config.CHARGING_WEIGHTS.waiting,
    isDefault: true,
  };
}

export async function setWeights(
  actor: WeightsActor,
  input: ChargingWeights,
  opts?: { tx?: Tx },
): Promise<ChargingWeights> {
  const after = validateWeightsInput(input);

  const apply = async (tx: Tx): Promise<string[]> => {
    const beforeView = await getWeights(tx);
    const before: ChargingWeights = {
      battery: beforeView.battery,
      urgency: beforeView.urgency,
      waiting: beforeView.waiting,
    };

    await tx.setting.upsert({
      where: { key: CHARGING_WEIGHTS_SETTING_KEY },
      create: { key: CHARGING_WEIGHTS_SETTING_KEY, value: { ...after } },
      update: { value: { ...after } },
    });

    await audit(tx, {
      actorId: actor.id,
      actorRole: actor.role,
      action: 'CHARGING_WEIGHTS_SET',
      entityType: 'setting',
      entityIds: [CHARGING_WEIGHTS_SETTING_KEY],
      details: { before, after },
    });

    const hubs = await tx.hub.findMany({ select: { id: true } });
    return hubs.map((h) => h.id);
  };

  if (opts?.tx) {
    await apply(opts.tx);
    return after;
  }

  const hubIds = await db.$transaction(apply);

  // Post-commit events (ARCHITECTURE §4.6)
  for (const hubId of hubIds) {
    events.emit('CHARGING_QUEUE_CHANGED', { hubId });
  }

  return after;
}

export async function resetWeights(actor: WeightsActor): Promise<ChargingWeights> {
  const after: ChargingWeights = {
    battery: config.CHARGING_WEIGHTS.battery,
    urgency: config.CHARGING_WEIGHTS.urgency,
    waiting: config.CHARGING_WEIGHTS.waiting,
  };

  const hubIds = await db.$transaction(async (tx) => {
    const beforeView = await getWeights(tx);
    const before: ChargingWeights = {
      battery: beforeView.battery,
      urgency: beforeView.urgency,
      waiting: beforeView.waiting,
    };

    await tx.setting.deleteMany({
      where: { key: CHARGING_WEIGHTS_SETTING_KEY },
    });

    await audit(tx, {
      actorId: actor.id,
      actorRole: actor.role,
      action: 'CHARGING_WEIGHTS_RESET',
      entityType: 'setting',
      entityIds: [CHARGING_WEIGHTS_SETTING_KEY],
      details: { before, after },
    });

    const hubs = await tx.hub.findMany({ select: { id: true } });
    return hubs.map((h) => h.id);
  });

  for (const hubId of hubIds) {
    events.emit('CHARGING_QUEUE_CHANGED', { hubId });
  }

  return after;
}

export interface HubProjectionBundle {
  weights: ChargingWeights;
  priorityCfg: PriorityConfig;
  points: PrismaChargingPoint[];
  requestsById: Map<string, ChargingRequest>;
  orderedByClass: Record<VehicleClass, ChargingRequest[]>;
  projection: ScheduleProjection;
}

export async function buildHubProjection(
  client: DbClient,
  hubId: string,
  now: Date = new Date(),
): Promise<HubProjectionBundle> {
  const [weightsView, points, liveRequests] = await Promise.all([
    getWeights(client),
    client.chargingPoint.findMany({
      where: { hubId },
      orderBy: { id: 'asc' },
    }),
    client.chargingRequest.findMany({
      where: {
        hubId,
        status: { in: ['QUEUED', 'SCHEDULED', 'CHARGING'] },
      },
    }),
  ]);

  const weights: ChargingWeights = {
    battery: weightsView.battery,
    urgency: weightsView.urgency,
    waiting: weightsView.waiting,
  };
  const priorityCfg = getPriorityConfig();
  const scheduleCfg = getScheduleConfig();

  const requestsById = new Map<string, ChargingRequest>();
  const queuedByClass: Record<VehicleClass, ChargingRequest[]> = {
    MOTORCYCLE: [],
    CAR: [],
  };
  const running: ScheduleRunningInput[] = [];
  const booked: ScheduleBookedInput[] = [];

  for (const req of liveRequests) {
    requestsById.set(req.id, req);
    if (req.status === 'QUEUED') {
      queuedByClass[req.vehicleClass].push(req);
    } else if (req.status === 'CHARGING' && req.chargingPointId) {
      running.push({
        id: req.id,
        chargingPointId: req.chargingPointId,
        vehicleClass: req.vehicleClass,
        currentPct: req.currentPct,
        targetPct: req.targetPct,
      });
    } else if (req.status === 'SCHEDULED' && req.chargingPointId && req.slotStart && req.slotEnd) {
      booked.push({
        id: req.id,
        chargingPointId: req.chargingPointId,
        vehicleClass: req.vehicleClass,
        slotStart: req.slotStart,
        slotEnd: req.slotEnd,
      });
    }
  }

  // Order QUEUED requests independently per class (BR-06, FR-50)
  const orderedByClass: Record<VehicleClass, ChargingRequest[]> = {
    MOTORCYCLE: orderForHub(queuedByClass.MOTORCYCLE, weights, now, priorityCfg),
    CAR: orderForHub(queuedByClass.CAR, weights, now, priorityCfg),
  };

  const projection = projectSchedule({
    points,
    running,
    booked,
    ordered: [...orderedByClass.MOTORCYCLE, ...orderedByClass.CAR],
    now,
    cfg: scheduleCfg,
  });

  return {
    weights,
    priorityCfg,
    points,
    requestsById,
    orderedByClass,
    projection,
  };
}

export function toRequestView(
  row: ChargingRequest,
  projection: ScheduleProjection | null,
  now: Date = new Date(),
): ChargingRequestView {
  let queuePosition: number | null = null;
  let estimatedStart: string | null = null;
  let estimatedEnd: string | null = null;

  if (row.status === 'QUEUED') {
    const proj = projection?.byRequest.get(row.id);
    if (proj) {
      queuePosition = proj.queuePosition;
      estimatedStart = proj.estimatedStart ? toIso(proj.estimatedStart) : null;
      estimatedEnd = proj.estimatedEnd ? toIso(proj.estimatedEnd) : null;
    }
  } else if (row.status === 'SCHEDULED') {
    estimatedStart = row.slotStart ? toIso(row.slotStart) : null;
    estimatedEnd = row.slotEnd ? toIso(row.slotEnd) : null;
  } else if (row.status === 'CHARGING') {
    const runningEnd = projection?.runningEndByRequest.get(row.id);
    estimatedEnd = runningEnd ? toIso(runningEnd) : row.slotEnd ? toIso(row.slotEnd) : null;
  }

  return {
    id: row.id,
    status: row.status,
    mode: row.mode,
    hubId: row.hubId,
    vehicleClass: row.vehicleClass,
    vehicleKind: row.vehicleKind,
    rentalVehicleId: row.rentalVehicleId,
    privateEvId: row.privateEvId,
    startPct: row.startPct,
    currentPct: row.currentPct,
    targetPct: row.targetPct,
    desiredTime: toIso(row.desiredTime),
    neededBy: row.neededBy ? toIso(row.neededBy) : null,
    chargingPointId: row.chargingPointId,
    slotStart: row.slotStart ? toIso(row.slotStart) : null,
    slotEnd: row.slotEnd ? toIso(row.slotEnd) : null,
    queuePosition,
    estimatedStart,
    estimatedEnd,
    endReason: row.endReason,
    finalPct: row.finalPct,
    createdAt: toIso(row.createdAt),
    serverNow: toIso(now),
  };
}

function toPointDto(row: PrismaChargingPoint): ChargingPoint {
  return {
    id: row.id,
    hubId: row.hubId,
    vehicleClass: row.vehicleClass,
    status: row.status,
  };
}

async function assertHubExists(client: DbClient, hubId: string): Promise<void> {
  const hub = await client.hub.findUnique({ where: { id: hubId }, select: { id: true } });
  if (!hub) {
    throw badRequest(`Hub "${hubId}" does not exist.`, 'hubId');
  }
}

export async function getQueue(
  input: { hubId: string; vehicleClass?: VehicleClass },
  now: Date = new Date(),
  client: DbClient = db,
): Promise<ChargingQueue> {
  await assertHubExists(client, input.hubId);

  const bundle = await buildHubProjection(client, input.hubId, now);
  const classes: VehicleClass[] = input.vehicleClass ? [input.vehicleClass] : [...VEHICLE_CLASSES];

  const entries: ChargingQueueEntry[] = [];
  for (const vc of classes) {
    const list = bundle.orderedByClass[vc];
    for (const [i, row] of list.entries()) {
      entries.push({
        rank: i + 1,
        score: score(row, bundle.weights, now, bundle.priorityCfg),
        breakdown: scoreBreakdown(row, bundle.weights, now, bundle.priorityCfg),
        request: toRequestView(row, bundle.projection, now),
      });
    }
  }

  return {
    weights: bundle.weights,
    entries,
  };
}

export async function getSchedule(
  input: { hubId?: string } = {},
  now: Date = new Date(),
  client: DbClient = db,
): Promise<ChargingSchedule> {
  let hubIds: string[];
  if (input.hubId !== undefined) {
    await assertHubExists(client, input.hubId);
    hubIds = [input.hubId];
  } else {
    const hubs = await client.hub.findMany({
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    hubIds = hubs.map((h) => h.id);
  }

  const pointsOut: ChargingSchedulePoint[] = [];

  for (const hubId of hubIds) {
    const bundle = await buildHubProjection(client, hubId, now);
    for (const pt of bundle.points) {
      const ptSchedule = bundle.projection.byPoint.get(pt.id);
      const currentRow = ptSchedule?.currentId
        ? (bundle.requestsById.get(ptSchedule.currentId) ?? null)
        : null;
      const bookedRows = (ptSchedule?.bookedIds ?? [])
        .map((id) => bundle.requestsById.get(id))
        .filter((r): r is ChargingRequest => Boolean(r));

      pointsOut.push({
        point: toPointDto(pt),
        current: currentRow ? toRequestView(currentRow, bundle.projection, now) : null,
        booked: bookedRows.map((r) => toRequestView(r, bundle.projection, now)),
        projected: (ptSchedule?.projected ?? []).map((p) => ({
          requestId: p.requestId,
          estimatedStart: toIso(p.start),
          estimatedEnd: toIso(p.end),
        })),
      });
    }
  }

  return {
    generatedAt: toIso(now),
    points: pointsOut,
  };
}
