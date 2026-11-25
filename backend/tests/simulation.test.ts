// T-29 What-if Simulation tests: Snapshot, Pure Engine, Recommendations, Async Runs,
// NFR-23 15-table MD5 Checksum Proof, Save/Compare, Preview/Apply/Dismiss, Races & Role Guards.

import crypto from 'node:crypto';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../src/core/config';
import { db } from '../src/core/db';
import { runSimulation, type SimEngineConfig } from '../src/modules/simulation/engine';
import { generateRecommendations } from '../src/modules/simulation/recommend';
import { awaitIdleRuns } from '../src/modules/simulation/simulation.service';
import { takeSnapshot } from '../src/modules/simulation/snapshot';
import type { SimHubSummary, SimInterval, SimSnapshot } from '../src/types/simulation';
import { createTestApp, loginAs, resetDb } from './helpers';

const app = createTestApp();
const opsAuth = () => loginAs('operator1');
const stuAuth = () => loginAs('student1');

const engineCfg: SimEngineConfig = {
  simIntervalMin: config.SIM_INTERVAL_MIN,
  simMaxRuntimeSec: config.SIM_MAX_RUNTIME_SEC,
  nearCapacityPct: config.NEAR_CAPACITY_PCT,
  minRentalBatteryPct: config.MIN_RENTAL_BATTERY_PCT,
  chargeRatePctPerMin: config.CHARGE_RATE_PCT_PER_MIN,
  batteryDrainPctPerMin: config.BATTERY_DRAIN_PCT_PER_MIN,
  urgencyHorizonMin: config.URGENCY_HORIZON_MIN,
  waitingFullMin: config.WAITING_FULL_MIN,
};

const recCfg = {
  nearCapacityPct: config.NEAR_CAPACITY_PCT,
  imbalanceMinDefault: config.IMBALANCE_MIN_DEFAULT,
  redistributionDestLimitPct: config.REDISTRIBUTION_DEST_LIMIT_PCT,
  minRentalBatteryPct: config.MIN_RENTAL_BATTERY_PCT,
};

// NFR-23: MD5 checksum over ordered rows of ALL 15 live tables (excluding sim_*, audit_log, notification, telemetry_reject).
async function liveChecksum(): Promise<string> {
  const [
    hubs,
    thresholds,
    redirects,
    settings,
    vehicles,
    privateEvs,
    spaces,
    points,
    vRes,
    pRes,
    cReq,
    incidents,
    alerts,
    rTasks,
    rTaskVehicles,
  ] = await Promise.all([
    db.hub.findMany({ orderBy: { id: 'asc' } }),
    db.hubThreshold.findMany({ orderBy: { id: 'asc' } }),
    db.hubRedirect.findMany({ orderBy: { id: 'asc' } }),
    db.setting.findMany({ orderBy: { key: 'asc' } }),
    db.rentalVehicle.findMany({ orderBy: { id: 'asc' } }),
    db.privateEv.findMany({ orderBy: { id: 'asc' } }),
    db.parkingSpace.findMany({ orderBy: { id: 'asc' } }),
    db.chargingPoint.findMany({ orderBy: { id: 'asc' } }),
    db.vehicleReservation.findMany({ orderBy: { id: 'asc' } }),
    db.parkingReservation.findMany({ orderBy: { id: 'asc' } }),
    db.chargingRequest.findMany({ orderBy: { id: 'asc' } }),
    db.incident.findMany({ orderBy: { id: 'asc' } }),
    db.alert.findMany({ orderBy: { id: 'asc' } }),
    db.redistributionTask.findMany({ orderBy: { id: 'asc' } }),
    db.redistributionTaskVehicle.findMany({
      orderBy: [{ taskId: 'asc' }, { rentalVehicleId: 'asc' }],
    }),
  ]);

  const payload = JSON.stringify({
    hubs,
    thresholds,
    redirects,
    settings,
    vehicles,
    privateEvs,
    spaces,
    points,
    vRes,
    pRes,
    cReq,
    incidents,
    alerts,
    rTasks,
    rTaskVehicles,
  });

  return crypto.createHash('md5').update(payload).digest('hex');
}

async function waitForRunCompletion(runId: string) {
  await awaitIdleRuns();
  const detail = await request(app)
    .get(`/api/ops/simulation/runs/${runId}`)
    .set('Authorization', opsAuth());
  return detail;
}

beforeEach(async () => {
  await resetDb();
});

afterEach(async () => {
  await awaitIdleRuns();
});

// ============================================================================
// Group 1: Pure Engine determinism, all 5 templates, timeout & Recommendations
// ============================================================================

describe('Group 1: FR-55 / FR-56 / FR-57 pure engine & recommendations', () => {
  it('FR-55 D-07 pure engine is deterministic for the same seed and differs for a different seed', async () => {
    const snap = await takeSnapshot(new Date('2026-11-25T07:00:00.000Z'));
    const scen = {
      horizonH: 4,
      seed: 12345,
      conditions: [{ template: 'METRO_SURGE' as const, params: { multiplierPct: 200, startHour: 0, durationH: 2 } }],
    };

    const run1 = runSimulation(snap, scen, engineCfg);
    const run2 = runSimulation(snap, scen, engineCfg);
    const runDiffSeed = runSimulation(snap, { ...scen, seed: 99999 }, engineCfg);

    expect(run1.status).toBe('COMPLETED');
    expect(run1.intervals).toEqual(run2.intervals);
    expect(run1.summary).toEqual(run2.summary);

    const rec1 = generateRecommendations(snap, run1.intervals, run1.summary, recCfg);
    const rec2 = generateRecommendations(snap, run2.intervals, run2.summary, recCfg);
    expect(rec1).toEqual(rec2);

    expect(runDiffSeed.intervals).not.toEqual(run1.intervals);
  });

  it('FR-54 FR-56 all 5 scenario templates (METRO_SURGE, HUB_PARKING_FULL, CHARGING_SPIKE, POINT_OUTAGE, VEHICLE_IMBALANCE) produce measurable changes vs baseline', async () => {
    const snap = await takeSnapshot(new Date('2026-11-25T07:00:00.000Z'));
    const baseline = runSimulation(snap, { horizonH: 3, seed: 77, conditions: [] }, engineCfg);

    const surge = runSimulation(
      snap,
      {
        horizonH: 3,
        seed: 77,
        conditions: [{ template: 'METRO_SURGE', params: { multiplierPct: 400, startHour: 0, durationH: 3 } }],
      },
      engineCfg,
    );
    expect(surge.intervals).not.toEqual(baseline.intervals);

    const parkFull = runSimulation(
      snap,
      {
        horizonH: 3,
        seed: 77,
        conditions: [{ template: 'HUB_PARKING_FULL', params: { hubId: 'dorm' } }],
      },
      engineCfg,
    );
    const dormBasePeak = baseline.summary.find((s) => s.hubId === 'dorm')!.peakParkingUtilPct;
    const dormFullPeak = parkFull.summary.find((s) => s.hubId === 'dorm')!.peakParkingUtilPct;
    expect(dormFullPeak).toBeGreaterThanOrEqual(dormBasePeak);
    expect(parkFull.intervals).not.toEqual(baseline.intervals);

    const chgSpike = runSimulation(
      snap,
      {
        horizonH: 3,
        seed: 77,
        conditions: [
          {
            template: 'CHARGING_SPIKE',
            params: { hubIds: ['metro', 'dorm'], multiplierPct: 450, startHour: 0, durationH: 3 },
          },
        ],
      },
      engineCfg,
    );
    expect(chgSpike.intervals).not.toEqual(baseline.intervals);

    const outage = runSimulation(
      snap,
      {
        horizonH: 3,
        seed: 77,
        conditions: [
          {
            template: 'POINT_OUTAGE',
            params: { hubId: 'metro', pctOfPoints: 100, startHour: 0, durationH: 3 },
          },
        ],
      },
      engineCfg,
    );
    expect(outage.intervals).not.toEqual(baseline.intervals);

    const imbalance = runSimulation(
      snap,
      {
        horizonH: 3,
        seed: 77,
        conditions: [{ template: 'VEHICLE_IMBALANCE', params: { hubId: 'dorm', deltaVehicles: 10 } }],
      },
      engineCfg,
    );
    expect(imbalance.intervals).not.toEqual(baseline.intervals);
  });

  it('FR-55 NFR-26 engine respects maxRuntimeMs cap and cleanly returns INCOMPLETE with partial intervals', async () => {
    const snap = await takeSnapshot(new Date('2026-11-25T07:00:00.000Z'));
    const out = runSimulation(
      snap,
      {
        horizonH: 24,
        seed: 42,
        conditions: [{ template: 'METRO_SURGE', params: { multiplierPct: 150, startHour: 0, durationH: 4 } }],
      },
      engineCfg,
      { maxRuntimeMs: 0 },
    );
    expect(out.status).toBe('INCOMPLETE');
    expect(out.intervals.length).toBeLessThan(24 * 4 * snap.hubs.length);
  });

  it('FR-57 UC-32 recommend.ts emits empty list when balanced, targeted recommendations on breach, and NETWORK_SATURATED when all Hubs >= 85%', async () => {
    const snap = await takeSnapshot(new Date('2026-11-25T07:00:00.000Z'));
    const balancedSnap: SimSnapshot = {
      ...snap,
      thresholds: snap.hubs.map((h) => ({
        hubId: h.id,
        vehicleClass: 'MOTORCYCLE',
        minAvailable: 0,
        maxAvailable: 100,
      })),
    };
    const balancedSummary: SimHubSummary[] = snap.hubs.map((h) => ({
      hubId: h.id,
      peakParkingUtilPct: 40,
      peakChargingUtilPct: 30,
      avgChargingWaitMin: 2,
      unservedTotal: 0,
    }));
    const balancedIvs: SimInterval[] = snap.hubs.map((h) => ({
      t: snap.takenAt,
      hubId: h.id,
      parkingUtilPct: 40,
      chargingUtilPct: 30,
      avgChargingWaitMin: 2,
      maxQueueDepth: 0,
      unservedRental: 0,
      unservedParking: 0,
      unservedCharging: 0,
      redirectedReturns: 0,
      availableVehicles: 5,
      breach: false,
    }));

    const balanced = generateRecommendations(balancedSnap, balancedIvs, balancedSummary, recCfg);
    expect(balanced).toEqual({ recommendations: [], warning: null });

    // Single-Hub breach -> generates REDIRECT + CHARGING_ADJUST
    const breachSummary: SimHubSummary[] = balancedSummary.map((s) =>
      s.hubId === 'metro'
        ? { ...s, peakParkingUtilPct: 92, peakChargingUtilPct: 90, avgChargingWaitMin: 20, unservedTotal: 2 }
        : s,
    );
    const breachRes = generateRecommendations(balancedSnap, balancedIvs, breachSummary, recCfg);
    expect(breachRes.warning).toBeNull();
    expect(breachRes.recommendations.some((r) => r.type === 'REDIRECT')).toBe(true);
    expect(breachRes.recommendations.some((r) => r.type === 'CHARGING_ADJUST')).toBe(true);

    // All Hubs >= NEAR_CAPACITY_PCT -> warning: 'NETWORK_SATURATED'
    const satSummary: SimHubSummary[] = balancedSummary.map((s) => ({
      ...s,
      peakParkingUtilPct: config.NEAR_CAPACITY_PCT,
    }));
    const satRes = generateRecommendations(balancedSnap, balancedIvs, satSummary, recCfg);
    expect(satRes.warning).toBe('NETWORK_SATURATED');
  });
});

// ============================================================================
// Group 2: Templates & Scenario Validation (FR-54, NFR-13, UC-29)
// ============================================================================

describe('Group 2: FR-54 templates & scenario validation', () => {
  it('FR-54 UC-29 GET /templates lists all 5 templates and POST /scenarios validates horizonH, conditions, and params with dotted details.field (0 writes on error)', async () => {
    const tmplRes = await request(app)
      .get('/api/ops/simulation/templates')
      .set('Authorization', opsAuth());
    expect(tmplRes.status).toBe(200);
    expect(tmplRes.body).toHaveLength(5);

    // Boundaries: horizonH 0 and 25 -> 400
    const badH0 = await request(app)
      .post('/api/ops/simulation/scenarios')
      .set('Authorization', opsAuth())
      .send({ name: 'Bad H0', horizonH: 0, conditions: [{ template: 'HUB_PARKING_FULL', params: { hubId: 'metro' } }] });
    expect(badH0.status).toBe(400);
    expect(badH0.body.error.details.field).toBe('horizonH');

    const badH25 = await request(app)
      .post('/api/ops/simulation/scenarios')
      .set('Authorization', opsAuth())
      .send({ name: 'Bad H25', horizonH: config.SIM_MAX_HORIZON_H + 1, conditions: [{ template: 'HUB_PARKING_FULL', params: { hubId: 'metro' } }] });
    expect(badH25.status).toBe(400);
    expect(badH25.body.error.details.field).toBe('horizonH');

    // Empty conditions -> 400
    const emptyConds = await request(app)
      .post('/api/ops/simulation/scenarios')
      .set('Authorization', opsAuth())
      .send({ name: 'Empty', horizonH: 4, conditions: [] });
    expect(emptyConds.status).toBe(400);
    expect(emptyConds.body.error.details.field).toBe('conditions');

    // Dotted param validations
    const badCases = [
      {
        cond: { template: 'METRO_SURGE', params: { multiplierPct: 0, startHour: 0, durationH: 1 } },
        field: 'conditions[0].params.multiplierPct',
      },
      {
        cond: { template: 'METRO_SURGE', params: { multiplierPct: 501, startHour: 0, durationH: 1 } },
        field: 'conditions[0].params.multiplierPct',
      },
      {
        cond: { template: 'POINT_OUTAGE', params: { hubId: 'metro', pctOfPoints: 101, startHour: 0, durationH: 1 } },
        field: 'conditions[0].params.pctOfPoints',
      },
      {
        cond: { template: 'VEHICLE_IMBALANCE', params: { hubId: 'metro', deltaVehicles: 0 } },
        field: 'conditions[0].params.deltaVehicles',
      },
      {
        cond: { template: 'HUB_PARKING_FULL', params: { hubId: 'does-not-exist' } },
        field: 'conditions[0].params.hubId',
      },
      {
        cond: { template: 'METRO_SURGE', params: { multiplierPct: 50, startHour: 4, durationH: 1 } },
        field: 'conditions[0].params.startHour',
      },
    ];

    for (const c of badCases) {
      const res = await request(app)
        .post('/api/ops/simulation/scenarios')
        .set('Authorization', opsAuth())
        .send({ name: 'Invalid', horizonH: 4, conditions: [c.cond] });
      expect(res.status).toBe(400);
      expect(res.body.error.details.field).toBe(c.field);
    }

    // Zero scenarios persisted after all invalid calls
    expect(await db.simScenario.count()).toBe(0);

    // Valid boundaries: horizonH 1 and 24 -> 201
    const ok1 = await request(app)
      .post('/api/ops/simulation/scenarios')
      .set('Authorization', opsAuth())
      .send({ name: 'Min H', horizonH: 1, conditions: [{ template: 'HUB_PARKING_FULL', params: { hubId: 'metro' } }] });
    expect(ok1.status).toBe(201);

    const ok24 = await request(app)
      .post('/api/ops/simulation/scenarios')
      .set('Authorization', opsAuth())
      .send({ name: 'Max H', horizonH: config.SIM_MAX_HORIZON_H, conditions: [{ template: 'METRO_SURGE', params: { multiplierPct: 100, startHour: 0, durationH: 4 } }] });
    expect(ok24.status).toBe(201);
  });

  it('FR-54 GET /scenarios lists newest-first and GET /scenarios/:id returns detail or 404', async () => {
    const s1 = await request(app)
      .post('/api/ops/simulation/scenarios')
      .set('Authorization', opsAuth())
      .send({ name: 'First', horizonH: 2, conditions: [{ template: 'HUB_PARKING_FULL', params: { hubId: 'dorm' } }] });
    const s2 = await request(app)
      .post('/api/ops/simulation/scenarios')
      .set('Authorization', opsAuth())
      .send({ name: 'Second', horizonH: 2, conditions: [{ template: 'HUB_PARKING_FULL', params: { hubId: 'metro' } }] });

    const list = await request(app).get('/api/ops/simulation/scenarios').set('Authorization', opsAuth());
    expect(list.status).toBe(200);
    expect(list.body.map((s: { id: string }) => s.id)).toEqual([s2.body.id, s1.body.id]);

    const detail = await request(app)
      .get(`/api/ops/simulation/scenarios/${s1.body.id}`)
      .set('Authorization', opsAuth());
    expect(detail.status).toBe(200);
    expect(detail.body.name).toBe('First');

    const missing = await request(app)
      .get('/api/ops/simulation/scenarios/unknown-id')
      .set('Authorization', opsAuth());
    expect(missing.status).toBe(404);
  });
});

// ============================================================================
// Group 3: NFR-23 / BR-11 Live-State Isolation Checksum Proof (Full 24h Run)
// ============================================================================

describe('Group 3: NFR-23 / BR-11 live-state isolation checksum proof', () => {
  it('FR-53 FR-55 NFR-23 BR-11 full 24h simulation completes in < 60s with 100% identical 15-table MD5 liveChecksum before and after', async () => {
    const sc = await request(app)
      .post('/api/ops/simulation/scenarios')
      .set('Authorization', opsAuth())
      .send({
        name: 'Full 24h Isolation Proof',
        horizonH: config.SIM_MAX_HORIZON_H,
        seed: 2026,
        conditions: [
          { template: 'METRO_SURGE', params: { multiplierPct: 200, startHour: 7, durationH: 3 } },
          { template: 'CHARGING_SPIKE', params: { hubIds: ['metro'], multiplierPct: 150, startHour: 16, durationH: 2 } },
        ],
      });
    expect(sc.status).toBe(201);

    const checksumBefore = await liveChecksum();

    const startRes = await request(app)
      .post('/api/ops/simulation/runs')
      .set('Authorization', opsAuth())
      .send({ scenarioId: sc.body.id });
    expect(startRes.status).toBe(202);
    expect(startRes.body.status).toBe('RUNNING');

    const detail = await waitForRunCompletion(startRes.body.id as string);
    expect(detail.status).toBe(200);
    expect(detail.body.run.status).toBe('COMPLETED');
    expect(detail.body.run.durationMs).toBeLessThan(config.SIM_MAX_RUNTIME_SEC * 1000);
    expect(detail.body.intervals.length).toBeGreaterThan(0);
    expect(detail.body.summary).toHaveLength(5);

    const checksumAfter = await liveChecksum();
    expect(checksumAfter).toBe(checksumBefore);
  });
});

// ============================================================================
// Group 4: Concurrent Run Guard (POST /runs race)
// ============================================================================

describe('Group 4: FR-55 concurrent POST /runs guard', () => {
  it('FR-55 BR-10 concurrent POST /runs guard rejects with 409 RESOURCE_TAKEN when a run is already RUNNING', async () => {
    const sc = await request(app)
      .post('/api/ops/simulation/scenarios')
      .set('Authorization', opsAuth())
      .send({
        name: 'Concurrent Guard',
        horizonH: 4,
        seed: 10,
        conditions: [{ template: 'METRO_SURGE', params: { multiplierPct: 100, startHour: 0, durationH: 2 } }],
      });

    // Deterministic check: seed a RUNNING row -> POST /runs returns 409 RESOURCE_TAKEN
    const seededRun = await db.simRun.create({
      data: {
        scenarioId: sc.body.id,
        status: 'RUNNING',
        snapshot: { takenAt: new Date().toISOString() },
        results: {},
      },
    });
    const blocked = await request(app)
      .post('/api/ops/simulation/runs')
      .set('Authorization', opsAuth())
      .send({ scenarioId: sc.body.id });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('RESOURCE_TAKEN');

    // Clear seeded RUNNING row and fire two simultaneous POST /runs via Promise.all
    await db.simRun.delete({ where: { id: seededRun.id } });
    const [r1, r2] = await Promise.all([
      request(app).post('/api/ops/simulation/runs').set('Authorization', opsAuth()).send({ scenarioId: sc.body.id }),
      request(app).post('/api/ops/simulation/runs').set('Authorization', opsAuth()).send({ scenarioId: sc.body.id }),
    ]);

    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([202, 409]);
    const loser = r1.status === 409 ? r1 : r2;
    expect(loser.body.error.code).toBe('RESOURCE_TAKEN');
  });
});

// ============================================================================
// Group 5: Save, Unsave & Compare (FR-59, UC-34)
// ============================================================================

describe('Group 5: FR-59 save, unsave & compare', () => {
  it('FR-59 UC-34 save, list saved, unsave (204), reject non-COMPLETED save (409), and compare runs with diff/diffPct/better and 409 on different horizons', async () => {
    const sA = await request(app)
      .post('/api/ops/simulation/scenarios')
      .set('Authorization', opsAuth())
      .send({ name: 'Scen A', horizonH: 2, seed: 1, conditions: [{ template: 'METRO_SURGE', params: { multiplierPct: 50, startHour: 0, durationH: 1 } }] });
    const sB = await request(app)
      .post('/api/ops/simulation/scenarios')
      .set('Authorization', opsAuth())
      .send({ name: 'Scen B', horizonH: 2, seed: 2, conditions: [{ template: 'METRO_SURGE', params: { multiplierPct: 300, startHour: 0, durationH: 2 } }] });
    const sC = await request(app)
      .post('/api/ops/simulation/scenarios')
      .set('Authorization', opsAuth())
      .send({ name: 'Scen C', horizonH: 4, seed: 3, conditions: [{ template: 'METRO_SURGE', params: { multiplierPct: 100, startHour: 0, durationH: 2 } }] });

    const runA = (await request(app).post('/api/ops/simulation/runs').set('Authorization', opsAuth()).send({ scenarioId: sA.body.id })).body.id as string;
    await waitForRunCompletion(runA);
    const runB = (await request(app).post('/api/ops/simulation/runs').set('Authorization', opsAuth()).send({ scenarioId: sB.body.id })).body.id as string;
    await waitForRunCompletion(runB);
    const runC = (await request(app).post('/api/ops/simulation/runs').set('Authorization', opsAuth()).send({ scenarioId: sC.body.id })).body.id as string;
    await waitForRunCompletion(runC);

    // Save runA -> appears in GET /runs?saved=true -> unsave -> 204 -> gone
    const saved = await request(app)
      .post(`/api/ops/simulation/runs/${runA}/save`)
      .set('Authorization', opsAuth())
      .send({ name: 'Baseline 2h' });
    expect(saved.status).toBe(200);
    expect(saved.body.savedName).toBe('Baseline 2h');

    const savedList = await request(app)
      .get('/api/ops/simulation/runs')
      .query({ saved: 'true' })
      .set('Authorization', opsAuth());
    expect(savedList.body.map((r: { id: string }) => r.id)).toEqual([runA]);

    const unsaved = await request(app)
      .delete(`/api/ops/simulation/runs/${runA}/save`)
      .set('Authorization', opsAuth());
    expect(unsaved.status).toBe(204);

    const savedListAfter = await request(app)
      .get('/api/ops/simulation/runs')
      .query({ saved: 'true' })
      .set('Authorization', opsAuth());
    expect(savedListAfter.body).toHaveLength(0);

    // Saving a non-COMPLETED run -> 409
    const runningRow = await db.simRun.create({
      data: { scenarioId: sA.body.id, status: 'RUNNING', snapshot: {}, results: {} },
    });
    const saveRunning = await request(app)
      .post(`/api/ops/simulation/runs/${runningRow.id}/save`)
      .set('Authorization', opsAuth())
      .send({ name: 'Nope' });
    expect(saveRunning.status).toBe(409);

    // Compare runA vs runB (same horizon) -> 200 with rows + better
    const cmp = await request(app)
      .get('/api/ops/simulation/compare')
      .query({ runA, runB })
      .set('Authorization', opsAuth());
    expect(cmp.status).toBe(200);
    expect(cmp.body.rows.length).toBe(5 * 4);
    expect(['a', 'b', 'tie']).toContain(cmp.body.better);

    // Different horizons -> 409
    const diffH = await request(app)
      .get('/api/ops/simulation/compare')
      .query({ runA, runB: runC })
      .set('Authorization', opsAuth());
    expect(diffH.status).toBe(409);

    // Missing / unknown -> 400 / 404
    expect(
      (await request(app).get('/api/ops/simulation/compare').query({ runA }).set('Authorization', opsAuth())).status,
    ).toBe(400);
    expect(
      (await request(app).get('/api/ops/simulation/compare').query({ runA, runB: 'missing' }).set('Authorization', opsAuth())).status,
    ).toBe(404);
  });
});

// ============================================================================
// Groups 6, 7, 8, 9, 10: Preview, Apply, Token, Conflict, Race, Dismiss & Auth
// ============================================================================

async function seedCompletedRunWithRecs() {
  const sc = await db.simScenario.create({
    data: {
      name: 'Seeded Rec Scenario',
      horizonH: 2,
      seed: 1,
      conditions: [],
      createdById: 'operator1',
    },
  });
  const run = await db.simRun.create({
    data: {
      scenarioId: sc.id,
      status: 'COMPLETED',
      snapshot: { takenAt: new Date().toISOString() },
      results: { intervals: [], summary: [], warning: null },
      finishedAt: new Date(),
      durationMs: 10,
    },
  });

  // Add free FLEET spaces at campus-a so metro -> campus-a (count 1) is well within 85%
  await db.parkingSpace.createMany({
    data: [
      { id: 'CPA-F-SIM-1', hubId: 'campus-a', vehicleClass: 'MOTORCYCLE', pool: 'FLEET', status: 'FREE' },
      { id: 'CPA-F-SIM-2', hubId: 'campus-a', vehicleClass: 'MOTORCYCLE', pool: 'FLEET', status: 'FREE' },
    ],
  });

  const recRedist = await db.simRecommendation.create({
    data: {
      runId: run.id,
      type: 'REDISTRIBUTE',
      payload: {
        sourceHubId: 'metro',
        destHubId: 'campus-a',
        vehicleClass: 'MOTORCYCLE',
        count: 1,
        _reason: 'Move 1 vehicle metro -> campus-a',
      },
      projectedImpact: { deficitReduced: 1 },
      status: 'PENDING',
    },
  });

  const recWeights = await db.simRecommendation.create({
    data: {
      runId: run.id,
      type: 'CHARGING_ADJUST',
      payload: {
        hubId: 'metro',
        weights: { battery: 0.4, urgency: 0.45, waiting: 0.15 },
        _reason: 'Raise urgency weight',
      },
      projectedImpact: { peakChargingUtilPct: 95 },
      status: 'PENDING',
    },
  });

  const recRedirect = await db.simRecommendation.create({
    data: {
      runId: run.id,
      type: 'REDIRECT',
      payload: {
        fromHubId: 'dorm',
        toHubId: 'campus-b',
        hours: 2,
        _reason: 'Redirect dorm -> campus-b',
      },
      projectedImpact: { fromPeakParkingUtilPct: 90 },
      status: 'PENDING',
    },
  });

  return { run, recRedist, recWeights, recRedirect };
}

describe('Groups 6–9: FR-58 D-20 preview -> apply, token validation, UC-33 E1 BLOCKED & double-apply race', () => {
  it('FR-58 D-20 D-12 preview -> apply works end-to-end for REDISTRIBUTE (T-28 task), CHARGING_ADJUST (T-17 weights), and REDIRECT (T-04 hub_redirect + alternatives ranking)', async () => {
    const { recRedist, recWeights, recRedirect } = await seedCompletedRunWithRecs();

    // 1. REDISTRIBUTE
    const prevR = await request(app)
      .get(`/api/ops/simulation/recommendations/${recRedist.id}/preview`)
      .set('Authorization', opsAuth());
    expect(prevR.status).toBe(200);
    expect(prevR.body.valid).toBe(true);
    expect(typeof prevR.body.confirmToken).toBe('string');
    expect(await db.redistributionTask.count()).toBe(0);

    const appR = await request(app)
      .post(`/api/ops/simulation/recommendations/${recRedist.id}/apply`)
      .set('Authorization', opsAuth())
      .send({ confirmToken: prevR.body.confirmToken });
    expect(appR.status).toBe(200);
    expect(appR.body.recommendation.status).toBe('APPLIED');
    expect(appR.body.created.type).toBe('redistributionTask');

    const task = await db.redistributionTask.findUnique({ where: { id: appR.body.created.id } });
    expect(task).toMatchObject({
      status: 'PROPOSED',
      origin: 'SIMULATION',
      recommendationId: recRedist.id,
    });

    // Re-using the same confirmToken after apply -> 409 INVALID_STATE_TRANSITION (one-time token)
    const reuse = await request(app)
      .post(`/api/ops/simulation/recommendations/${recRedist.id}/apply`)
      .set('Authorization', opsAuth())
      .send({ confirmToken: prevR.body.confirmToken });
    expect(reuse.status).toBe(409);
    expect(reuse.body.error.code).toBe('INVALID_STATE_TRANSITION');

    // 2. CHARGING_ADJUST -> updates live weights
    const prevW = await request(app)
      .get(`/api/ops/simulation/recommendations/${recWeights.id}/preview`)
      .set('Authorization', opsAuth());
    expect(prevW.body.valid).toBe(true);
    const appW = await request(app)
      .post(`/api/ops/simulation/recommendations/${recWeights.id}/apply`)
      .set('Authorization', opsAuth())
      .send({ confirmToken: prevW.body.confirmToken });
    expect(appW.status).toBe(200);
    expect(appW.body.created).toEqual({ type: 'weights', id: 'charging.weights' });

    const liveWeights = await request(app)
      .get('/api/ops/charging/weights')
      .set('Authorization', opsAuth());
    expect(liveWeights.body).toMatchObject({ battery: 0.4, urgency: 0.45, waiting: 0.15 });

    // 3. REDIRECT -> creates hub_redirect ranked first by GET /api/hubs/alternatives (D-12)
    const prevD = await request(app)
      .get(`/api/ops/simulation/recommendations/${recRedirect.id}/preview`)
      .set('Authorization', opsAuth());
    expect(prevD.body.valid).toBe(true);
    const appD = await request(app)
      .post(`/api/ops/simulation/recommendations/${recRedirect.id}/apply`)
      .set('Authorization', opsAuth())
      .send({ confirmToken: prevD.body.confirmToken });
    expect(appD.status).toBe(200);
    expect(appD.body.created.type).toBe('hubRedirect');

    const alts = await request(app)
      .get('/api/hubs/alternatives')
      .query({ need: 'FLEET_PARKING', vehicleClass: 'MOTORCYCLE', excludeHubId: 'dorm' })
      .set('Authorization', opsAuth());
    expect(alts.status).toBe(200);
    expect(alts.body[0].hubId).toBe('campus-b');

    const appliedAudits = await db.auditLog.count({ where: { action: 'SIM_RECOMMENDATION_APPLIED' } });
    expect(appliedAudits).toBe(3);
  });

  it('FR-58 D-20 apply rejects missing preview, wrong confirmToken, and expired confirmToken with 409 CONFIRM_TOKEN_INVALID and 0 live writes', async () => {
    const { recRedist } = await seedCompletedRunWithRecs();

    // Before preview
    const noPrev = await request(app)
      .post(`/api/ops/simulation/recommendations/${recRedist.id}/apply`)
      .set('Authorization', opsAuth())
      .send({ confirmToken: 'any-token' });
    expect(noPrev.status).toBe(409);
    expect(noPrev.body.error.code).toBe('CONFIRM_TOKEN_INVALID');

    // Preview then wrong token
    const prev = await request(app)
      .get(`/api/ops/simulation/recommendations/${recRedist.id}/preview`)
      .set('Authorization', opsAuth());
    const wrong = await request(app)
      .post(`/api/ops/simulation/recommendations/${recRedist.id}/apply`)
      .set('Authorization', opsAuth())
      .send({ confirmToken: 'wrong-token' });
    expect(wrong.status).toBe(409);
    expect(wrong.body.error.code).toBe('CONFIRM_TOKEN_INVALID');

    // Expired token
    await db.simRecommendation.update({
      where: { id: recRedist.id },
      data: { confirmTokenExpiresAt: new Date(Date.now() - 1000) },
    });
    const expired = await request(app)
      .post(`/api/ops/simulation/recommendations/${recRedist.id}/apply`)
      .set('Authorization', opsAuth())
      .send({ confirmToken: prev.body.confirmToken });
    expect(expired.status).toBe(409);
    expect(expired.body.error.code).toBe('CONFIRM_TOKEN_INVALID');

    const stillPending = await db.simRecommendation.findUnique({ where: { id: recRedist.id } });
    expect(stillPending!.status).toBe('PENDING');
    expect(await db.redistributionTask.count()).toBe(0);
  });

  it('FR-58 UC-33 E1 apply re-validates live state, persists BLOCKED + SIM_RECOMMENDATION_BLOCKED audit, and throws 409 LIVE_STATE_CONFLICT when live capacity changes', async () => {
    const { recRedist } = await seedCompletedRunWithRecs();

    const prev = await request(app)
      .get(`/api/ops/simulation/recommendations/${recRedist.id}/preview`)
      .set('Authorization', opsAuth());
    expect(prev.body.valid).toBe(true);

    // Mutate live state before apply: occupy all FLEET spaces at campus-a so capacity fails!
    await db.parkingSpace.updateMany({
      where: { hubId: 'campus-a', pool: 'FLEET', vehicleClass: 'MOTORCYCLE' },
      data: { status: 'OCCUPIED' },
    });

    const appRes = await request(app)
      .post(`/api/ops/simulation/recommendations/${recRedist.id}/apply`)
      .set('Authorization', opsAuth())
      .send({ confirmToken: prev.body.confirmToken });
    expect(appRes.status).toBe(409);
    expect(appRes.body.error.code).toBe('LIVE_STATE_CONFLICT');
    expect(Array.isArray(appRes.body.error.details.problems)).toBe(true);

    // BLOCKED persisted (not rolled back!) + audit written + 0 tasks created
    const recAfter = await db.simRecommendation.findUnique({ where: { id: recRedist.id } });
    expect(recAfter!.status).toBe('BLOCKED');
    expect(recAfter!.confirmToken).toBeNull();
    expect(await db.redistributionTask.count()).toBe(0);

    const blockedAudit = await db.auditLog.findFirst({
      where: { action: 'SIM_RECOMMENDATION_BLOCKED', entityIds: { has: recRedist.id } },
    });
    expect(blockedAudit).not.toBeNull();
  });

  it('FR-58 BR-10 D-20 double-apply race with the same valid confirmToken yields exactly one 200 APPLIED, one 409 INVALID_STATE_TRANSITION, 1 live write, and 1 audit row', async () => {
    const { recRedist } = await seedCompletedRunWithRecs();

    const prev = await request(app)
      .get(`/api/ops/simulation/recommendations/${recRedist.id}/preview`)
      .set('Authorization', opsAuth());
    const token = prev.body.confirmToken as string;

    const [r1, r2] = await Promise.all([
      request(app)
        .post(`/api/ops/simulation/recommendations/${recRedist.id}/apply`)
        .set('Authorization', opsAuth())
        .send({ confirmToken: token }),
      request(app)
        .post(`/api/ops/simulation/recommendations/${recRedist.id}/apply`)
        .set('Authorization', opsAuth())
        .send({ confirmToken: token }),
    ]);

    expect([r1.status, r2.status].sort()).toEqual([200, 409]);
    const loser = r1.status === 409 ? r1 : r2;
    expect(loser.body.error.code).toBe('INVALID_STATE_TRANSITION');

    expect(await db.redistributionTask.count()).toBe(1);
    const audits = await db.auditLog.findMany({
      where: { action: 'SIM_RECOMMENDATION_APPLIED', entityIds: { has: recRedist.id } },
    });
    expect(audits).toHaveLength(1);
  });
});

// ============================================================================
// Group 10: Dismiss (UC-33 A1) + Role & Auth Guards (FR-61, BR-12)
// ============================================================================

describe('Group 10: FR-58 dismiss & FR-61 role/auth guards', () => {
  it('FR-58 UC-33 A1 dismiss transitions PENDING -> DISMISSED with audit and 0 live writes (identical liveChecksum); second dismiss returns 409', async () => {
    const { recRedist } = await seedCompletedRunWithRecs();
    const before = await liveChecksum();

    const d1 = await request(app)
      .post(`/api/ops/simulation/recommendations/${recRedist.id}/dismiss`)
      .set('Authorization', opsAuth());
    expect(d1.status).toBe(200);
    expect(d1.body.status).toBe('DISMISSED');

    const after = await liveChecksum();
    expect(after).toBe(before);

    const auditRow = await db.auditLog.findFirst({
      where: { action: 'SIM_RECOMMENDATION_DISMISSED', entityIds: { has: recRedist.id } },
    });
    expect(auditRow).not.toBeNull();

    const d2 = await request(app)
      .post(`/api/ops/simulation/recommendations/${recRedist.id}/dismiss`)
      .set('Authorization', opsAuth());
    expect(d2.status).toBe(409);
  });

  it('FR-61 BR-12 rejects STUDENT with 403 + SECURITY_DENIED and unauthenticated with 401 on all 13 /api/ops/simulation/* routes', async () => {
    const routes: Array<{ method: 'get' | 'post' | 'delete'; path: string }> = [
      { method: 'get', path: '/api/ops/simulation/templates' },
      { method: 'post', path: '/api/ops/simulation/scenarios' },
      { method: 'get', path: '/api/ops/simulation/scenarios' },
      { method: 'get', path: '/api/ops/simulation/scenarios/fake-id' },
      { method: 'post', path: '/api/ops/simulation/runs' },
      { method: 'get', path: '/api/ops/simulation/runs' },
      { method: 'get', path: '/api/ops/simulation/runs/fake-id' },
      { method: 'post', path: '/api/ops/simulation/runs/fake-id/save' },
      { method: 'delete', path: '/api/ops/simulation/runs/fake-id/save' },
      { method: 'get', path: '/api/ops/simulation/recommendations/fake-id/preview' },
      { method: 'post', path: '/api/ops/simulation/recommendations/fake-id/apply' },
      { method: 'post', path: '/api/ops/simulation/recommendations/fake-id/dismiss' },
      { method: 'get', path: '/api/ops/simulation/compare' },
    ];

    for (const r of routes) {
      const noAuth = await request(app)[r.method](r.path);
      expect(noAuth.status).toBe(401);

      const stu = await request(app)[r.method](r.path).set('Authorization', stuAuth());
      expect(stu.status).toBe(403);
    }

    const deniedCount = await db.auditLog.count({ where: { action: 'SECURITY_DENIED' } });
    expect(deniedCount).toBeGreaterThanOrEqual(routes.length);
  });
});
