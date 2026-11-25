// What-if Simulation service: templates, scenarios, async runs, save/unsave,
// two-step preview -> apply (D-20, UC-33), dismiss, and compare (FR-53–FR-59, FR-63).

import crypto from 'node:crypto';
import type {
  Prisma,
  SimRecommendation as PrismaSimRecommendation,
  SimRun as PrismaSimRun,
  SimScenario as PrismaSimScenario,
} from '@prisma/client';
import { audit } from '../../core/audit';
import { config } from '../../core/config';
import { db, lockRow, type Tx } from '../../core/db';
import { badRequest, conflict, notFound } from '../../core/errors';
import { events } from '../../core/events';
import { assertTransition } from '../../core/stateMachine';
import { addMinutes } from '../../core/time';
import type { ChargingWeights } from '../../types/charging';
import {
  SCENARIO_TEMPLATES,
  type Role,
  type ScenarioTemplate,
  type VehicleClass,
} from '../../types/enums';
import type {
  Recommendation,
  RecommendationApplyResult,
  RecommendationPreview,
  Scenario,
  ScenarioCondition,
  ScenarioTemplateSpec,
  SimCompareMetric,
  SimCompareResult,
  SimCompareRow,
  SimHubSummary,
  SimInterval,
  SimRun,
  SimRunDetail,
  SimSnapshot,
} from '../../types/simulation';
import { setWeights } from '../charging/charging.service';
import { isDegraded, roundTo1 } from '../hubs/hubs.metrics';
import {
  createRedistributionTask,
  previewRedistribution,
} from '../redistribution/redistribution.service';
import { runSimulation, type SimEngineConfig } from './engine';
import { generateRecommendations, type RecommendConfig } from './recommend';
import { takeSnapshot } from './snapshot';

export interface SimulationActor {
  id: string;
  role: Role;
}

export interface CreateScenarioInput {
  name: string;
  horizonH: number;
  seed?: number;
  conditions: unknown;
}

const SIM_RUN_ADVISORY_LOCK_KEY = 290029;
const MAX_NAME_LEN = 120;
const DEFAULT_SEED = 42;

// Tracks in-flight async simulation runs so tests can await clean teardown before resetDb().
const activeRuns = new Set<Promise<void>>();

export async function awaitIdleRuns(): Promise<void> {
  while (activeRuns.size > 0) {
    await Promise.allSettled(Array.from(activeRuns));
  }
}

function getEngineConfig(): SimEngineConfig {
  return {
    simIntervalMin: config.SIM_INTERVAL_MIN,
    simMaxRuntimeSec: config.SIM_MAX_RUNTIME_SEC,
    nearCapacityPct: config.NEAR_CAPACITY_PCT,
    minRentalBatteryPct: config.MIN_RENTAL_BATTERY_PCT,
    chargeRatePctPerMin: config.CHARGE_RATE_PCT_PER_MIN,
    batteryDrainPctPerMin: config.BATTERY_DRAIN_PCT_PER_MIN,
    urgencyHorizonMin: config.URGENCY_HORIZON_MIN,
    waitingFullMin: config.WAITING_FULL_MIN,
  };
}

function getRecommendConfig(): RecommendConfig {
  return {
    nearCapacityPct: config.NEAR_CAPACITY_PCT,
    imbalanceMinDefault: config.IMBALANCE_MIN_DEFAULT,
    redistributionDestLimitPct: config.REDISTRIBUTION_DEST_LIMIT_PCT,
    minRentalBatteryPct: config.MIN_RENTAL_BATTERY_PCT,
  };
}

function toScenarioDto(row: PrismaSimScenario): Scenario {
  return {
    id: row.id,
    name: row.name,
    horizonH: row.horizonH,
    seed: row.seed,
    conditions: Array.isArray(row.conditions)
      ? (row.conditions as unknown as ScenarioCondition[])
      : [],
    createdById: row.createdById,
    createdAt: row.createdAt.toISOString(),
  };
}

function extractSnapshotTakenAt(snapshot: Prisma.JsonValue, fallback: Date): string {
  if (snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)) {
    const takenAt = (snapshot as Record<string, unknown>)['takenAt'];
    if (typeof takenAt === 'string') return takenAt;
  }
  return fallback.toISOString();
}

function toRunDto(row: PrismaSimRun): SimRun {
  return {
    id: row.id,
    scenarioId: row.scenarioId,
    status: row.status,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
    durationMs: row.durationMs ?? null,
    savedName: row.savedName ?? null,
    snapshotTakenAt: extractSnapshotTakenAt(row.snapshot, row.startedAt),
  };
}

function toRecDto(row: PrismaSimRecommendation): Recommendation {
  const payload =
    row.payload && typeof row.payload === 'object' && !Array.isArray(row.payload)
      ? (row.payload as Record<string, unknown>)
      : {};
  const projectedImpact: Record<string, number> = {};
  if (
    row.projectedImpact &&
    typeof row.projectedImpact === 'object' &&
    !Array.isArray(row.projectedImpact)
  ) {
    for (const [k, v] of Object.entries(row.projectedImpact as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isFinite(v)) {
        projectedImpact[k] = v;
      }
    }
  }
  const reason =
    typeof payload['_reason'] === 'string'
      ? payload['_reason']
      : `Apply ${row.type} recommendation.`;
  const cleanPayload = { ...payload };
  delete cleanPayload['_reason'];

  return {
    id: row.id,
    runId: row.runId,
    type: row.type,
    status: row.status,
    payload: cleanPayload,
    projectedImpact,
    reason,
  };
}

function extractRunResults(raw: Prisma.JsonValue): {
  intervals: SimInterval[];
  summary: SimHubSummary[];
  warning: 'NETWORK_SATURATED' | null;
} {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { intervals: [], summary: [], warning: null };
  }
  const obj = raw as Record<string, unknown>;
  const intervals = Array.isArray(obj['intervals']) ? (obj['intervals'] as SimInterval[]) : [];
  const summary = Array.isArray(obj['summary']) ? (obj['summary'] as SimHubSummary[]) : [];
  const warning = obj['warning'] === 'NETWORK_SATURATED' ? 'NETWORK_SATURATED' : null;
  return { intervals, summary, warning };
}

/**
 * FR-54, CONTRACTS §13: Returns all 5 scenario template specs (drives the form).
 */
export function listTemplates(): ScenarioTemplateSpec[] {
  const maxH = config.SIM_MAX_HORIZON_H;
  return [
    {
      template: 'METRO_SURGE',
      label: 'Metro Station Demand Surge',
      params: [
        { name: 'multiplierPct', type: 'number', min: 1, max: 500, required: true },
        { name: 'startHour', type: 'integer', min: 0, max: 23, required: true },
        { name: 'durationH', type: 'integer', min: 1, max: maxH, required: true },
      ],
    },
    {
      template: 'HUB_PARKING_FULL',
      label: 'Hub Parking Saturation',
      params: [{ name: 'hubId', type: 'hubId', required: true }],
    },
    {
      template: 'CHARGING_SPIKE',
      label: 'Charging Demand Spike',
      params: [
        { name: 'hubIds', type: 'hubIds', required: true },
        { name: 'multiplierPct', type: 'number', min: 1, max: 500, required: true },
        { name: 'startHour', type: 'integer', min: 0, max: 23, required: true },
        { name: 'durationH', type: 'integer', min: 1, max: maxH, required: true },
      ],
    },
    {
      template: 'POINT_OUTAGE',
      label: 'Partial Charging Point Outage',
      params: [
        { name: 'hubId', type: 'hubId', required: true },
        { name: 'pctOfPoints', type: 'number', min: 1, max: 100, required: true },
        { name: 'startHour', type: 'integer', min: 0, max: 23, required: true },
        { name: 'durationH', type: 'integer', min: 1, max: maxH, required: true },
      ],
    },
    {
      template: 'VEHICLE_IMBALANCE',
      label: 'Vehicle Concentration / Shortage',
      params: [
        { name: 'hubId', type: 'hubId', required: true },
        { name: 'deltaVehicles', type: 'integer', min: -300, max: 300, required: true },
      ],
    },
  ];
}

function requireParamNumber(
  params: Record<string, unknown>,
  key: string,
  fieldPath: string,
  opts: { min: number; max: number; integer?: boolean; nonZero?: boolean },
): number {
  const v = params[key];
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw badRequest(`${fieldPath} must be a number.`, fieldPath);
  }
  if (opts.integer && !Number.isInteger(v)) {
    throw badRequest(`${fieldPath} must be an integer.`, fieldPath);
  }
  if (v < opts.min || v > opts.max) {
    throw badRequest(`${fieldPath} must be between ${opts.min} and ${opts.max}.`, fieldPath);
  }
  if (opts.nonZero && v === 0) {
    throw badRequest(`${fieldPath} must not be 0.`, fieldPath);
  }
  return v;
}

function requireParamHubId(
  params: Record<string, unknown>,
  key: string,
  fieldPath: string,
  validHubIds: Set<string>,
): string {
  const v = params[key];
  if (typeof v !== 'string' || v.trim().length === 0) {
    throw badRequest(`${fieldPath} is required.`, fieldPath);
  }
  const hubId = v.trim();
  if (!validHubIds.has(hubId)) {
    throw badRequest(`Unknown Hub "${hubId}" in ${fieldPath}.`, fieldPath);
  }
  return hubId;
}

/**
 * FR-54, UC-29: Validate and persist a new simulation scenario.
 */
export async function createScenario(
  actor: SimulationActor,
  input: CreateScenarioInput,
  now: Date = new Date(),
): Promise<Scenario> {
  const name = input.name.trim();
  if (name.length === 0 || name.length > MAX_NAME_LEN) {
    throw badRequest(`name must be 1–${MAX_NAME_LEN} characters.`, 'name');
  }
  if (!Number.isInteger(input.horizonH) || input.horizonH < 1 || input.horizonH > config.SIM_MAX_HORIZON_H) {
    throw badRequest(`horizonH must be an integer between 1 and ${config.SIM_MAX_HORIZON_H}.`, 'horizonH');
  }
  const seed = input.seed ?? DEFAULT_SEED;
  if (!Number.isInteger(seed)) {
    throw badRequest('seed must be an integer.', 'seed');
  }
  if (!Array.isArray(input.conditions) || input.conditions.length === 0) {
    throw badRequest('conditions must contain at least one condition.', 'conditions');
  }

  const hubs = await db.hub.findMany({ select: { id: true } });
  const validHubIds = new Set(hubs.map((h) => h.id));

  const validatedConditions: ScenarioCondition[] = [];
  for (let i = 0; i < input.conditions.length; i++) {
    const rawCond = input.conditions[i];
    if (!rawCond || typeof rawCond !== 'object' || Array.isArray(rawCond)) {
      throw badRequest(`conditions[${i}] must be an object.`, `conditions[${i}]`);
    }
    const condObj = rawCond as Record<string, unknown>;
    const tmpl = condObj['template'];
    if (
      typeof tmpl !== 'string' ||
      !(SCENARIO_TEMPLATES as readonly string[]).includes(tmpl)
    ) {
      throw badRequest(
        `conditions[${i}].template must be one of: ${SCENARIO_TEMPLATES.join(', ')}.`,
        `conditions[${i}].template`,
      );
    }
    const rawParams = condObj['params'];
    if (!rawParams || typeof rawParams !== 'object' || Array.isArray(rawParams)) {
      throw badRequest(`conditions[${i}].params must be an object.`, `conditions[${i}].params`);
    }
    const p = rawParams as Record<string, unknown>;
    const prefix = `conditions[${i}].params`;
    const template = tmpl as ScenarioTemplate;

    if (template === 'METRO_SURGE') {
      const multiplierPct = requireParamNumber(p, 'multiplierPct', `${prefix}.multiplierPct`, {
        min: 1,
        max: 500,
      });
      const startHour = requireParamNumber(p, 'startHour', `${prefix}.startHour`, {
        min: 0,
        max: input.horizonH - 1,
        integer: true,
      });
      const durationH = requireParamNumber(p, 'durationH', `${prefix}.durationH`, {
        min: 1,
        max: input.horizonH,
        integer: true,
      });
      validatedConditions.push({ template, params: { multiplierPct, startHour, durationH } });
    } else if (template === 'HUB_PARKING_FULL') {
      const hubId = requireParamHubId(p, 'hubId', `${prefix}.hubId`, validHubIds);
      validatedConditions.push({ template, params: { hubId } });
    } else if (template === 'CHARGING_SPIKE') {
      const rawIds = p['hubIds'];
      if (!Array.isArray(rawIds) || rawIds.length === 0) {
        throw badRequest(`${prefix}.hubIds must be a non-empty array of Hub IDs.`, `${prefix}.hubIds`);
      }
      const hubIds: string[] = [];
      for (const item of rawIds) {
        if (typeof item !== 'string' || !validHubIds.has(item.trim())) {
          throw badRequest(`Invalid Hub ID in ${prefix}.hubIds.`, `${prefix}.hubIds`);
        }
        hubIds.push(item.trim());
      }
      const multiplierPct = requireParamNumber(p, 'multiplierPct', `${prefix}.multiplierPct`, {
        min: 1,
        max: 500,
      });
      const startHour = requireParamNumber(p, 'startHour', `${prefix}.startHour`, {
        min: 0,
        max: input.horizonH - 1,
        integer: true,
      });
      const durationH = requireParamNumber(p, 'durationH', `${prefix}.durationH`, {
        min: 1,
        max: input.horizonH,
        integer: true,
      });
      validatedConditions.push({
        template,
        params: { hubIds, multiplierPct, startHour, durationH },
      });
    } else if (template === 'POINT_OUTAGE') {
      const hubId = requireParamHubId(p, 'hubId', `${prefix}.hubId`, validHubIds);
      const pctOfPoints = requireParamNumber(p, 'pctOfPoints', `${prefix}.pctOfPoints`, {
        min: 1,
        max: 100,
      });
      const startHour = requireParamNumber(p, 'startHour', `${prefix}.startHour`, {
        min: 0,
        max: input.horizonH - 1,
        integer: true,
      });
      const durationH = requireParamNumber(p, 'durationH', `${prefix}.durationH`, {
        min: 1,
        max: input.horizonH,
        integer: true,
      });
      validatedConditions.push({
        template,
        params: { hubId, pctOfPoints, startHour, durationH },
      });
    } else {
      const hubId = requireParamHubId(p, 'hubId', `${prefix}.hubId`, validHubIds);
      const deltaVehicles = requireParamNumber(p, 'deltaVehicles', `${prefix}.deltaVehicles`, {
        min: -300,
        max: 300,
        integer: true,
        nonZero: true,
      });
      validatedConditions.push({ template, params: { hubId, deltaVehicles } });
    }
  }

  const created = await db.simScenario.create({
    data: {
      name,
      horizonH: input.horizonH,
      seed,
      conditions: validatedConditions as unknown as Prisma.InputJsonValue,
      createdById: actor.id,
      createdAt: now,
    },
  });

  return toScenarioDto(created);
}

export async function listScenarios(): Promise<Scenario[]> {
  const rows = await db.simScenario.findMany({
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  });
  return rows.map(toScenarioDto);
}

export async function getScenario(id: string): Promise<Scenario> {
  const row = await db.simScenario.findUnique({ where: { id } });
  if (!row) throw notFound('Scenario');
  return toScenarioDto(row);
}

/**
 * FR-53, FR-55: Takes a read-only snapshot, inserts a RUNNING sim_run under a serialized
 * advisory lock (rejecting concurrent RUNNING runs with 409), kicks off async execution,
 * and returns 202 SimRun immediately. Zero writes to live tables (NFR-23).
 */
export async function startRun(
  _actor: SimulationActor,
  scenarioId: string,
  now: Date = new Date(),
): Promise<SimRun> {
  const scenario = await db.simScenario.findUnique({ where: { id: scenarioId } });
  if (!scenario) throw notFound('Scenario');

  // Fast-fail check before taking a snapshot if another run is already RUNNING
  const runningPreCheck = await db.simRun.findFirst({
    where: { status: 'RUNNING' },
    select: { id: true },
  });
  if (runningPreCheck) {
    throw conflict('RESOURCE_TAKEN', 'Another simulation run is already running.', {
      nextActions: ['Wait for the current simulation run to finish and try again.'],
      details: { runningRunId: runningPreCheck.id },
    });
  }

  const snapshot = await takeSnapshot(now);

  // Serialized insert under pg_advisory_xact_lock guarantees at most one RUNNING row
  const createdRun = await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${SIM_RUN_ADVISORY_LOCK_KEY})`;
    const alreadyRunning = await tx.simRun.findFirst({
      where: { status: 'RUNNING' },
      select: { id: true },
    });
    if (alreadyRunning) {
      throw conflict('RESOURCE_TAKEN', 'Another simulation run is already running.', {
        nextActions: ['Wait for the current simulation run to finish and try again.'],
        details: { runningRunId: alreadyRunning.id },
      });
    }

    return tx.simRun.create({
      data: {
        scenarioId: scenario.id,
        status: 'RUNNING',
        snapshot: snapshot as unknown as Prisma.InputJsonValue,
        results: {},
        startedAt: now,
      },
    });
  });

  const scenarioDto = toScenarioDto(scenario);
  const runId = createdRun.id;

  const job = new Promise<void>((resolve) => {
    setImmediate(() => {
      void (async () => {
        const execStart = Date.now();
        try {
          const engineOut = runSimulation(
            snapshot,
            {
              horizonH: scenarioDto.horizonH,
              seed: scenarioDto.seed,
              conditions: scenarioDto.conditions,
            },
            getEngineConfig(),
          );
          const recOut = generateRecommendations(
            snapshot,
            engineOut.intervals,
            engineOut.summary,
            getRecommendConfig(),
          );
          const finishedAt = new Date();
          const durationMs = Math.max(0, Date.now() - execStart);

          await db.$transaction(async (tx) => {
            await lockRow(tx, 'sim_run', runId);
            const current = await tx.simRun.findUniqueOrThrow({ where: { id: runId } });
            assertTransition('simRun', current.status, engineOut.status);

            if (recOut.recommendations.length > 0) {
              await tx.simRecommendation.createMany({
                data: recOut.recommendations.map((rec) => ({
                  runId,
                  type: rec.type,
                  payload: { ...rec.payload, _reason: rec.reason } as Prisma.InputJsonValue,
                  projectedImpact: rec.projectedImpact as Prisma.InputJsonValue,
                  status: 'PENDING',
                })),
              });
            }

            await tx.simRun.update({
              where: { id: runId },
              data: {
                status: engineOut.status,
                results: {
                  intervals: engineOut.intervals,
                  summary: engineOut.summary,
                  warning: recOut.warning,
                } as unknown as Prisma.InputJsonValue,
                finishedAt,
                durationMs,
              },
            });
          });
        } catch (err) {
          console.error(`[simulation] run ${runId} failed`, err);
          try {
            await db.$transaction(async (tx) => {
              await lockRow(tx, 'sim_run', runId);
              const current = await tx.simRun.findUniqueOrThrow({ where: { id: runId } });
              if (current.status === 'RUNNING') {
                assertTransition('simRun', current.status, 'FAILED');
                await tx.simRun.update({
                  where: { id: runId },
                  data: {
                    status: 'FAILED',
                    finishedAt: new Date(),
                    durationMs: Math.max(0, Date.now() - execStart),
                  },
                });
              }
            });
          } catch {
            // ignore cleanup errors if test truncated DB
          }
        } finally {
          resolve();
        }
      })();
    });
  });

  activeRuns.add(job);
  void job.finally(() => {
    activeRuns.delete(job);
  });

  return toRunDto(createdRun);
}

export async function listRuns(opts: { saved?: boolean } = {}): Promise<SimRun[]> {
  const rows = await db.simRun.findMany({
    where: opts.saved === true ? { savedName: { not: null } } : undefined,
    orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
  });
  return rows.map(toRunDto);
}

export async function getRunDetail(id: string): Promise<SimRunDetail> {
  const row = await db.simRun.findUnique({
    where: { id },
    include: {
      recommendations: { orderBy: { id: 'asc' } },
    },
  });
  if (!row) throw notFound('Simulation run');

  const { intervals, summary, warning } = extractRunResults(row.results);
  return {
    run: toRunDto(row),
    intervals,
    summary,
    recommendations: row.recommendations.map(toRecDto),
    warning,
  };
}

export async function saveRun(id: string, rawName: string): Promise<SimRun> {
  const name = rawName.trim();
  if (name.length === 0 || name.length > MAX_NAME_LEN) {
    throw badRequest(`name must be 1–${MAX_NAME_LEN} characters.`, 'name');
  }

  return db.$transaction(async (tx) => {
    await lockRow(tx, 'sim_run', id);
    const run = await tx.simRun.findUniqueOrThrow({ where: { id } });
    if (run.status !== 'COMPLETED') {
      throw conflict('INVALID_STATE_TRANSITION', 'Only COMPLETED simulation runs can be saved.', {
        nextActions: ['Wait for the run to complete before saving.'],
        details: { status: run.status },
      });
    }
    const updated = await tx.simRun.update({
      where: { id },
      data: { savedName: name },
    });
    return toRunDto(updated);
  });
}

export async function unsaveRun(id: string): Promise<void> {
  await db.$transaction(async (tx) => {
    await lockRow(tx, 'sim_run', id);
    await tx.simRun.update({
      where: { id },
      data: { savedName: null },
    });
  });
}

// ---------------------------------------------------------------------------
// Live Re-validation helper for Preview & Apply (FR-58, D-20, UC-33)
// ---------------------------------------------------------------------------

async function evaluateRecommendationLive(
  tx: Tx,
  rec: Recommendation,
  now: Date,
): Promise<{ valid: boolean; problems: string[]; liveChanges: string[] }> {
  const p = rec.payload;
  if (rec.type === 'REDISTRIBUTE') {
    const sourceHubId = String(p['sourceHubId'] ?? '');
    const destHubId = String(p['destHubId'] ?? '');
    const vehicleClass = (String(p['vehicleClass'] ?? 'MOTORCYCLE') as VehicleClass);
    const count = Number(p['count'] ?? 0);

    try {
      const preview = await previewRedistribution(
        { sourceHubId, destHubId, vehicleClass, count },
        now,
        tx,
      );
      return {
        valid: preview.ok,
        problems: preview.problems,
        liveChanges: [
          `Create PROPOSED redistribution task: move ${count} ${vehicleClass} vehicle(s) from ${sourceHubId} to ${destHubId}.`,
        ],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Invalid redistribution payload.';
      return { valid: false, problems: [msg], liveChanges: [] };
    }
  }

  if (rec.type === 'CHARGING_ADJUST') {
    const rawW = p['weights'];
    if (!rawW || typeof rawW !== 'object' || Array.isArray(rawW)) {
      return { valid: false, problems: ['Missing weights payload.'], liveChanges: [] };
    }
    const w = rawW as Record<string, unknown>;
    const battery = Number(w['battery']);
    const urgency = Number(w['urgency']);
    const waiting = Number(w['waiting']);
    const valid =
      Number.isFinite(battery) &&
      battery >= 0 &&
      Number.isFinite(urgency) &&
      urgency >= 0 &&
      Number.isFinite(waiting) &&
      waiting >= 0 &&
      battery + urgency + waiting > 0;
    return {
      valid,
      problems: valid ? [] : ['Charging weights must be non-negative and not all zero.'],
      liveChanges: valid
        ? [`Update live charging weights to battery=${battery}, urgency=${urgency}, waiting=${waiting}.`]
        : [],
    };
  }

  // REDIRECT
  const fromHubId = String(p['fromHubId'] ?? '');
  const toHubId = String(p['toHubId'] ?? '');
  const hours = Number(p['hours'] ?? 2);
  const problems: string[] = [];

  if (!fromHubId || !toHubId || fromHubId === toHubId) {
    problems.push('fromHubId and toHubId must be distinct Hub IDs.');
  }
  if (!Number.isFinite(hours) || hours <= 0) {
    problems.push('Redirect duration hours must be positive.');
  }
  const hubs = await tx.hub.findMany({
    where: { id: { in: [fromHubId, toHubId] } },
    select: { id: true, lastTelemetryAt: true },
  });
  const fromHub = hubs.find((h) => h.id === fromHubId);
  const toHub = hubs.find((h) => h.id === toHubId);
  if (!fromHub) problems.push(`Unknown source Hub "${fromHubId}".`);
  if (!toHub) problems.push(`Unknown target Hub "${toHubId}".`);
  if (
    toHub &&
    isDegraded(
      toHub.lastTelemetryAt,
      now,
      config.STALLED_FEED_INTERVALS,
      config.TELEMETRY_INTERVAL_SEC,
    )
  ) {
    problems.push(`Target Hub "${toHubId}" is currently DEGRADED.`);
  }

  return {
    valid: problems.length === 0,
    problems,
    liveChanges:
      problems.length === 0
        ? [`Create live Hub redirect from ${fromHubId} to ${toHubId} for ${hours}h.`]
        : [],
  };
}

/**
 * FR-58, D-20: Preview a PENDING recommendation against live state and issue a 5-min confirmToken if valid.
 */
export async function previewRecommendation(
  id: string,
  now: Date = new Date(),
): Promise<RecommendationPreview> {
  return db.$transaction(async (tx) => {
    await lockRow(tx, 'sim_recommendation', id);
    const row = await tx.simRecommendation.findUniqueOrThrow({ where: { id } });
    if (row.status !== 'PENDING') {
      throw conflict('INVALID_STATE_TRANSITION', `Recommendation is already ${row.status}.`, {
        nextActions: ['Only PENDING recommendations can be previewed.'],
        details: { status: row.status },
      });
    }

    const recDto = toRecDto(row);
    const check = await evaluateRecommendationLive(tx, recDto, now);

    let confirmToken: string | null = null;
    let expiresAt: Date | null = null;

    if (check.valid) {
      confirmToken = crypto.randomUUID();
      expiresAt = addMinutes(now, config.CONFIRM_TOKEN_TTL_MIN);
    }

    await tx.simRecommendation.update({
      where: { id },
      data: {
        confirmToken,
        confirmTokenExpiresAt: expiresAt,
      },
    });

    return {
      recommendation: recDto,
      liveChanges: check.liveChanges,
      valid: check.valid,
      problems: check.problems,
      confirmToken,
      expiresAt: expiresAt ? expiresAt.toISOString() : null,
    };
  });
}

/**
 * FR-58, D-20, UC-33: Apply a PENDING recommendation using its one-time confirmToken.
 * On live re-validation failure (UC-33 E1), commits status='BLOCKED' + audit BEFORE throwing 409 LIVE_STATE_CONFLICT.
 */
export async function applyRecommendation(
  actor: SimulationActor,
  id: string,
  confirmToken: string,
  now: Date = new Date(),
): Promise<RecommendationApplyResult> {
  const txOutcome = await db.$transaction(async (tx) => {
    await lockRow(tx, 'sim_recommendation', id);
    const row = await tx.simRecommendation.findUniqueOrThrow({ where: { id } });

    assertTransition('recommendation', row.status, 'APPLIED');

    if (
      !row.confirmToken ||
      row.confirmToken !== confirmToken ||
      !row.confirmTokenExpiresAt ||
      row.confirmTokenExpiresAt.getTime() <= now.getTime()
    ) {
      throw conflict('CONFIRM_TOKEN_INVALID', 'Confirmation token is missing, invalid, or expired.', {
        nextActions: ['Preview the recommendation again to obtain a fresh confirmation token.'],
      });
    }

    const recDto = toRecDto(row);
    const check = await evaluateRecommendationLive(tx, recDto, now);

    // UC-33 E1: live re-validation failed -> persist BLOCKED + audit and commit before throwing 409
    if (!check.valid) {
      assertTransition('recommendation', row.status, 'BLOCKED');
      await tx.simRecommendation.update({
        where: { id },
        data: {
          status: 'BLOCKED',
          confirmToken: null,
          confirmTokenExpiresAt: null,
        },
      });
      await audit(tx, {
        actorId: actor.id,
        actorRole: actor.role,
        action: 'SIM_RECOMMENDATION_BLOCKED',
        entityType: 'sim_recommendation',
        entityIds: [row.id],
        details: { type: row.type, problems: check.problems },
      });
      return { kind: 'blocked' as const, problems: check.problems };
    }

    let created: RecommendationApplyResult['created'];
    let emitAllCharging = false;
    let emitRedirectHubId: string | null = null;
    let allHubIds: string[] = [];

    if (row.type === 'REDISTRIBUTE') {
      const p = recDto.payload;
      const task = await createRedistributionTask(
        actor,
        {
          sourceHubId: String(p['sourceHubId']),
          destHubId: String(p['destHubId']),
          vehicleClass: String(p['vehicleClass'] ?? 'MOTORCYCLE') as VehicleClass,
          count: Number(p['count']),
          override: false,
        },
        {
          tx,
          origin: 'SIMULATION',
          recommendationId: row.id,
          now,
        },
      );
      created = { type: 'redistributionTask', id: task.id };
    } else if (row.type === 'CHARGING_ADJUST') {
      const weights = recDto.payload['weights'] as ChargingWeights;
      await setWeights(actor, weights, { tx });
      allHubIds = (await tx.hub.findMany({ select: { id: true } })).map((h) => h.id);
      emitAllCharging = true;
      created = { type: 'weights', id: 'charging.weights' };
    } else {
      const p = recDto.payload;
      const fromHubId = String(p['fromHubId']);
      const toHubId = String(p['toHubId']);
      const hours = Number(p['hours'] ?? 2);
      const redirect = await tx.hubRedirect.create({
        data: {
          fromHubId,
          toHubId,
          activeUntil: addMinutes(now, hours * 60),
          createdById: actor.id,
          recommendationId: row.id,
        },
      });
      emitRedirectHubId = fromHubId;
      created = { type: 'hubRedirect', id: redirect.id };
    }

    const updated = await tx.simRecommendation.update({
      where: { id },
      data: {
        status: 'APPLIED',
        appliedById: actor.id,
        appliedAt: now,
        confirmToken: null,
        confirmTokenExpiresAt: null,
      },
    });

    await audit(tx, {
      actorId: actor.id,
      actorRole: actor.role,
      action: 'SIM_RECOMMENDATION_APPLIED',
      entityType: 'sim_recommendation',
      entityIds: [row.id, created.id],
      details: { type: row.type, created },
    });

    return {
      kind: 'applied' as const,
      result: { recommendation: toRecDto(updated), created },
      emitAllCharging,
      allHubIds,
      emitRedirectHubId,
    };
  });

  if (txOutcome.kind === 'blocked') {
    throw conflict(
      'LIVE_STATE_CONFLICT',
      'Live operational state changed since preview; recommendation has been marked BLOCKED.',
      {
        nextActions: ['Inspect current Hub capacity and run a fresh simulation.'],
        details: { problems: txOutcome.problems },
      },
    );
  }

  // Post-commit events (ARCHITECTURE §4.6)
  if (txOutcome.emitAllCharging) {
    for (const hId of txOutcome.allHubIds) {
      events.emit('CHARGING_QUEUE_CHANGED', { hubId: hId });
    }
  }
  if (txOutcome.emitRedirectHubId) {
    events.emit('RESERVATION_CHANGED', { hubId: txOutcome.emitRedirectHubId });
  }

  return txOutcome.result;
}

/**
 * UC-33 A1: Dismiss a PENDING recommendation with zero live writes.
 */
export async function dismissRecommendation(
  actor: SimulationActor,
  id: string,
  _now: Date = new Date(),
): Promise<Recommendation> {
  return db.$transaction(async (tx) => {
    await lockRow(tx, 'sim_recommendation', id);
    const row = await tx.simRecommendation.findUniqueOrThrow({ where: { id } });

    assertTransition('recommendation', row.status, 'DISMISSED');

    const updated = await tx.simRecommendation.update({
      where: { id },
      data: {
        status: 'DISMISSED',
        confirmToken: null,
        confirmTokenExpiresAt: null,
      },
    });

    await audit(tx, {
      actorId: actor.id,
      actorRole: actor.role,
      action: 'SIM_RECOMMENDATION_DISMISSED',
      entityType: 'sim_recommendation',
      entityIds: [row.id],
      details: { type: row.type },
    });

    return toRecDto(updated);
  });
}

/**
 * FR-59, UC-34: Compare two COMPLETED simulation runs with the same horizon.
 */
export async function compareRuns(runAId: string, runBId: string): Promise<SimCompareResult> {
  const [runA, runB] = await Promise.all([
    db.simRun.findUnique({ where: { id: runAId }, include: { scenario: true } }),
    db.simRun.findUnique({ where: { id: runBId }, include: { scenario: true } }),
  ]);

  if (!runA) throw notFound('Simulation run A');
  if (!runB) throw notFound('Simulation run B');

  if (runA.status !== 'COMPLETED' || runB.status !== 'COMPLETED') {
    throw conflict('INVALID_STATE_TRANSITION', 'Both runs must be COMPLETED to compare.', {
      nextActions: ['Select two COMPLETED simulation runs.'],
      details: { statusA: runA.status, statusB: runB.status },
    });
  }

  if (runA.scenario.horizonH !== runB.scenario.horizonH) {
    throw conflict('NOT_ELIGIBLE', 'Cannot compare runs with different horizons.', {
      nextActions: ['Select two runs that share the same horizonH.'],
      details: { horizonA: runA.scenario.horizonH, horizonB: runB.scenario.horizonH },
    });
  }

  const resA = extractRunResults(runA.results);
  const resB = extractRunResults(runB.results);

  const mapA = new Map(resA.summary.map((s) => [s.hubId, s]));
  const mapB = new Map(resB.summary.map((s) => [s.hubId, s]));
  const hubIds = Array.from(new Set([...mapA.keys(), ...mapB.keys()])).sort((x, y) =>
    x.localeCompare(y),
  );

  const metrics: readonly SimCompareMetric[] = [
    'peakParkingUtilPct',
    'peakChargingUtilPct',
    'avgChargingWaitMin',
    'unservedTotal',
  ];

  const rows: SimCompareRow[] = [];
  let unservedSumA = 0;
  let unservedSumB = 0;
  let waitSumA = 0;
  let waitSumB = 0;
  let peakParkSumA = 0;
  let peakParkSumB = 0;

  for (const hubId of hubIds) {
    const sA = mapA.get(hubId) ?? {
      hubId,
      peakParkingUtilPct: 0,
      peakChargingUtilPct: 0,
      avgChargingWaitMin: 0,
      unservedTotal: 0,
    };
    const sB = mapB.get(hubId) ?? {
      hubId,
      peakParkingUtilPct: 0,
      peakChargingUtilPct: 0,
      avgChargingWaitMin: 0,
      unservedTotal: 0,
    };

    unservedSumA += sA.unservedTotal;
    unservedSumB += sB.unservedTotal;
    waitSumA += sA.avgChargingWaitMin;
    waitSumB += sB.avgChargingWaitMin;
    peakParkSumA += sA.peakParkingUtilPct;
    peakParkSumB += sB.peakParkingUtilPct;

    for (const metric of metrics) {
      const a = sA[metric];
      const b = sB[metric];
      const diff = roundTo1(b - a);
      const diffPct = a === 0 ? (b === 0 ? 0 : 100) : roundTo1(((b - a) / a) * 100);
      rows.push({ hubId, metric, a, b, diff, diffPct });
    }
  }

  const hubCount = Math.max(1, hubIds.length);
  const avgWaitA = waitSumA / hubCount;
  const avgWaitB = waitSumB / hubCount;
  const avgParkA = peakParkSumA / hubCount;
  const avgParkB = peakParkSumB / hubCount;

  let better: 'a' | 'b' | 'tie' = 'tie';
  if (unservedSumA !== unservedSumB) {
    better = unservedSumA < unservedSumB ? 'a' : 'b';
  } else if (avgWaitA !== avgWaitB) {
    better = avgWaitA < avgWaitB ? 'a' : 'b';
  } else if (avgParkA !== avgParkB) {
    better = avgParkA < avgParkB ? 'a' : 'b';
  }

  return {
    a: toRunDto(runA),
    b: toRunDto(runB),
    rows,
    better,
  };
}

// Re-export SimSnapshot type helper if needed by callers
export type { SimSnapshot };
