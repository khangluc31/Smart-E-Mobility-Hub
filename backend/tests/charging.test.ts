import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createTestApp, resetDb, loginAs } from './helpers';
import { db } from '../src/core/db';
import { config } from '../src/core/config';
import { events } from '../src/core/events';
import { scoreBreakdown, score, rankQueue, orderForHub } from '../src/modules/charging/priority';
import { estimateDurationMs, projectSchedule } from '../src/modules/charging/schedule';
import { getQueue, getSchedule } from '../src/modules/charging/charging.service';
import type { ChargingQueue, ChargingSchedule, ChargingWeightsView } from '../src/types/charging';

const app = createTestApp();
let operatorToken: string;
let studentToken: string;

// Fixed configs for pure unit tests (never relies on env config).
const PRIORITY_CFG = {
  urgencyHorizonMin: 240,
  waitingFullMin: 120,
};

const SCHEDULE_CFG = {
  chargeRatePctPerMin: {
    MOTORCYCLE: 1.0,
    CAR: 0.5,
  },
  demoTimeScale: 1,
};

const DEFAULT_WEIGHTS = { battery: 0.5, urgency: 0.3, waiting: 0.2 };

function min(n: number): number {
  return n * 60_000;
}

function atOffset(base: Date, offsetMs: number): Date {
  return new Date(base.getTime() + offsetMs);
}

interface PureQueueInput {
  id: string;
  hubId?: string;
  vehicleClass?: 'MOTORCYCLE' | 'CAR';
  vehicleKind?: 'RENTAL' | 'PRIVATE';
  status?: 'QUEUED' | 'SCHEDULED' | 'CHARGING' | 'COMPLETED' | 'CANCELLED';
  currentPct: number;
  targetPct?: number;
  desiredTime: Date;
  neededBy: Date | null;
  createdAt: Date;
  manualAdjust?: number;
}

function makeQueueEntry(base: Date, overrides: PureQueueInput) {
  return {
    id: overrides.id,
    hubId: overrides.hubId ?? 'metro',
    vehicleClass: overrides.vehicleClass ?? ('MOTORCYCLE' as const),
    vehicleKind: overrides.vehicleKind ?? ('PRIVATE' as const),
    status: overrides.status ?? ('QUEUED' as const),
    currentPct: overrides.currentPct,
    targetPct: overrides.targetPct ?? 100,
    desiredTime: overrides.desiredTime,
    neededBy: overrides.neededBy,
    createdAt: overrides.createdAt,
    manualAdjust: overrides.manualAdjust ?? 0,
  };
}

// Check that no two intervals on the same point overlap: [aStart, aEnd) vs [bStart, bEnd).
function assertNoOverlaps(intervals: Array<{ start: Date | string; end: Date | string }>) {
  const sorted = intervals
    .map((x) => ({
      start: x.start instanceof Date ? x.start.getTime() : Date.parse(x.start),
      end: x.end instanceof Date ? x.end.getTime() : Date.parse(x.end),
    }))
    .sort((a, b) => a.start - b.start);

  for (let i = 0; i < sorted.length; i++) {
    const curr = sorted[i]!;
    expect(curr.end).toBeGreaterThan(curr.start);
    if (i > 0) {
      const prev = sorted[i - 1]!;
      expect(curr.start).toBeGreaterThanOrEqual(prev.end);
    }
  }
}

beforeAll(async () => {
  await resetDb();
  operatorToken = loginAs('operator1');
  studentToken = loginAs('student1');
});

// ============================================================================
// Pure unit tests: priority.ts (AC-1, AC-2)
// ============================================================================

describe('charging/priority.ts pure functions', () => {
  const now = new Date('2026-12-01T10:00:00.000Z');

  it('BR-06 AC-1 scoreBreakdown returns weighted parts summing to score for hand-computed case', () => {
    // currentPct = 40 -> battery = 60 -> weighted = 0.5 * 60 = 30
    // neededBy = now + 120m (horizon 240m) -> urgency = 100 * (1 - 120/240) = 50 -> weighted = 0.3 * 50 = 15
    // createdAt = now - 60m, desiredTime = now - 60m (full 120m) -> waiting = 50 -> weighted = 0.2 * 50 = 10
    // manualAdjust = 10 -> total = 65
    const entry = makeQueueEntry(now, {
      id: 'q1',
      currentPct: 40,
      neededBy: atOffset(now, min(120)),
      createdAt: atOffset(now, -min(60)),
      desiredTime: atOffset(now, -min(60)),
      manualAdjust: 10,
    });

    const bd = scoreBreakdown(entry, DEFAULT_WEIGHTS, now, PRIORITY_CFG);
    const total = score(entry, DEFAULT_WEIGHTS, now, PRIORITY_CFG);

    expect(bd.battery).toBeCloseTo(30, 6);
    expect(bd.urgency).toBeCloseTo(15, 6);
    expect(bd.waiting).toBeCloseTo(10, 6);
    expect(bd.manualAdjust).toBe(10);
    expect(bd.battery + bd.urgency + bd.waiting + bd.manualAdjust).toBeCloseTo(total, 6);
    expect(total).toBeCloseTo(65, 6);
  });

  it('D-08 AC-1 urgency clamps at 100 for past neededBy, 0 beyond horizon, and 0 when null', () => {
    const base = {
      id: 'u1',
      currentPct: 100,
      createdAt: now,
      desiredTime: now,
    };

    const pastNeeded = makeQueueEntry(now, { ...base, neededBy: atOffset(now, -min(15)) });
    expect(scoreBreakdown(pastNeeded, DEFAULT_WEIGHTS, now, PRIORITY_CFG).urgency).toBeCloseTo(30, 6);

    const beyondHorizon = makeQueueEntry(now, { ...base, neededBy: atOffset(now, min(300)) });
    expect(scoreBreakdown(beyondHorizon, DEFAULT_WEIGHTS, now, PRIORITY_CFG).urgency).toBe(0);

    const nullNeeded = makeQueueEntry(now, { ...base, neededBy: null });
    expect(scoreBreakdown(nullNeeded, DEFAULT_WEIGHTS, now, PRIORITY_CFG).urgency).toBe(0);
  });

  it('D-08 AC-1 waiting counts from max(createdAt, desiredTime), is 0 before desiredTime, and clamps at 100', () => {
    // createdAt is 100m ago, desiredTime is 30m ago -> waitingMinutes = 30 -> 30/120*100 = 25 -> weighted = 0.2*25 = 5
    const afterDesired = makeQueueEntry(now, {
      id: 'w1',
      currentPct: 100,
      neededBy: null,
      createdAt: atOffset(now, -min(100)),
      desiredTime: atOffset(now, -min(30)),
    });
    expect(scoreBreakdown(afterDesired, DEFAULT_WEIGHTS, now, PRIORITY_CFG).waiting).toBeCloseTo(5, 6);

    // desiredTime in the future -> not eligible yet -> waiting = 0
    const futureDesired = makeQueueEntry(now, {
      id: 'w2',
      currentPct: 100,
      neededBy: null,
      createdAt: atOffset(now, -min(60)),
      desiredTime: atOffset(now, min(15)),
    });
    expect(scoreBreakdown(futureDesired, DEFAULT_WEIGHTS, now, PRIORITY_CFG).waiting).toBe(0);

    // waiting 200m >= WAITING_FULL_MIN 120m -> clamped at 100 -> weighted = 0.2*100 = 20
    const cappedWaiting = makeQueueEntry(now, {
      id: 'w3',
      currentPct: 100,
      neededBy: null,
      createdAt: atOffset(now, -min(200)),
      desiredTime: atOffset(now, -min(200)),
    });
    expect(scoreBreakdown(cappedWaiting, DEFAULT_WEIGHTS, now, PRIORITY_CFG).waiting).toBeCloseTo(20, 6);
  });

  it('BR-06 AC-1 gives no bonus by vehicleKind (RENTAL vs PRIVATE identical score)', () => {
    const rental = makeQueueEntry(now, {
      id: 'r1',
      vehicleKind: 'RENTAL',
      currentPct: 50,
      neededBy: atOffset(now, min(60)),
      createdAt: atOffset(now, -min(30)),
      desiredTime: atOffset(now, -min(30)),
    });
    const priv = makeQueueEntry(now, {
      id: 'p1',
      vehicleKind: 'PRIVATE',
      currentPct: 50,
      neededBy: atOffset(now, min(60)),
      createdAt: atOffset(now, -min(30)),
      desiredTime: atOffset(now, -min(30)),
    });

    expect(score(rental, DEFAULT_WEIGHTS, now, PRIORITY_CFG)).toBe(
      score(priv, DEFAULT_WEIGHTS, now, PRIORITY_CFG),
    );
  });

  it('BR-06 AC-2 rankQueue sorts by score DESC and applies every tie-break in order', () => {
    // Use battery weight 1, others 0, and manualAdjust to force exact equal scores while varying fields.
    const w = { battery: 1, urgency: 0, waiting: 0 };

    // 1. Higher score wins
    // 2. Equal score -> lower currentPct wins
    // 3. Equal score & currentPct -> earlier neededBy wins (null last)
    // 4. Equal score, currentPct, neededBy -> earlier createdAt wins
    // 5. Equal all above -> id ASC wins
    const high = makeQueueEntry(now, {
      id: 'high',
      currentPct: 10, // score 90
      neededBy: null,
      createdAt: now,
      desiredTime: now,
    });
    const lowBat = makeQueueEntry(now, {
      id: 'tie-lowbat',
      currentPct: 20, // raw 80, manual -30 => score 50
      manualAdjust: -30,
      neededBy: null,
      createdAt: now,
      desiredTime: now,
    });
    const earlierNeed = makeQueueEntry(now, {
      id: 'tie-need1',
      currentPct: 50, // score 50
      neededBy: atOffset(now, min(30)),
      createdAt: now,
      desiredTime: now,
    });
    const laterNeed = makeQueueEntry(now, {
      id: 'tie-need2',
      currentPct: 50,
      neededBy: atOffset(now, min(60)),
      createdAt: atOffset(now, -min(10)),
      desiredTime: atOffset(now, -min(10)),
    });
    const nullNeedEarlyCreate = makeQueueEntry(now, {
      id: 'tie-b',
      currentPct: 50,
      neededBy: null,
      createdAt: atOffset(now, -min(20)),
      desiredTime: atOffset(now, -min(20)),
    });
    const nullNeedLateCreateB = makeQueueEntry(now, {
      id: 'tie-z',
      currentPct: 50,
      neededBy: null,
      createdAt: atOffset(now, -min(5)),
      desiredTime: atOffset(now, -min(5)),
    });
    const nullNeedLateCreateA = makeQueueEntry(now, {
      id: 'tie-a',
      currentPct: 50,
      neededBy: null,
      createdAt: atOffset(now, -min(5)),
      desiredTime: atOffset(now, -min(5)),
    });

    const ranked = rankQueue(
      [
        nullNeedLateCreateB,
        laterNeed,
        nullNeedLateCreateA,
        lowBat,
        nullNeedEarlyCreate,
        earlierNeed,
        high,
      ],
      w,
      now,
      PRIORITY_CFG,
    );

    expect(ranked.map((r) => r.id)).toEqual([
      'high',
      'tie-lowbat',
      'tie-need1',
      'tie-need2',
      'tie-b',
      'tie-a',
      'tie-z',
    ]);
  });

  it('BR-06 AC-2 orderForHub puts not-yet-eligible tail after eligible, sorted by desiredTime, createdAt, id', () => {
    const eligibleLowScore = makeQueueEntry(now, {
      id: 'elig-1',
      currentPct: 90,
      neededBy: null,
      createdAt: now,
      desiredTime: now,
    });
    const futureHighScore1 = makeQueueEntry(now, {
      id: 'fut-b',
      currentPct: 5, // higher battery score, but desiredTime is in the future!
      neededBy: atOffset(now, min(20)),
      createdAt: atOffset(now, -min(10)),
      desiredTime: atOffset(now, min(10)),
    });
    const futureDesiredLater = makeQueueEntry(now, {
      id: 'fut-later',
      currentPct: 1,
      neededBy: null,
      createdAt: atOffset(now, -min(30)),
      desiredTime: atOffset(now, min(20)),
    });
    const futureTieEarlierCreate = makeQueueEntry(now, {
      id: 'fut-a',
      currentPct: 80,
      neededBy: null,
      createdAt: atOffset(now, -min(20)),
      desiredTime: atOffset(now, min(10)),
    });
    const futureTieSameCreateA = makeQueueEntry(now, {
      id: 'fut-c1',
      currentPct: 80,
      neededBy: null,
      createdAt: atOffset(now, -min(10)),
      desiredTime: atOffset(now, min(10)),
    });

    const ordered = orderForHub(
      [
        futureDesiredLater,
        futureHighScore1,
        futureTieSameCreateA,
        eligibleLowScore,
        futureTieEarlierCreate,
      ],
      DEFAULT_WEIGHTS,
      now,
      PRIORITY_CFG,
    );

    // Eligible first, then future sorted by desiredTime ASC, createdAt ASC, id ASC.
    expect(ordered.map((e) => e.id)).toEqual([
      'elig-1',
      'fut-a',
      'fut-b',
      'fut-c1',
      'fut-later',
    ]);
  });
});

// ============================================================================
// Pure unit tests: schedule.ts (AC-3, AC-4)
// ============================================================================

describe('charging/schedule.ts pure functions', () => {
  const now = new Date('2026-12-01T10:00:00.000Z');

  it('D-09 D-10 AC-3 estimateDurationMs uses class rate × DEMO_TIME_SCALE and returns 0 when toPct <= fromPct', () => {
    expect(estimateDurationMs(20, 80, 'MOTORCYCLE', SCHEDULE_CFG)).toBe(min(60));
    expect(estimateDurationMs(20, 80, 'CAR', SCHEDULE_CFG)).toBe(min(120));

    const fastCfg = { ...SCHEDULE_CFG, demoTimeScale: 2 };
    expect(estimateDurationMs(20, 80, 'CAR', fastCfg)).toBe(min(60));

    expect(estimateDurationMs(80, 80, 'MOTORCYCLE', SCHEDULE_CFG)).toBe(0);
    expect(estimateDurationMs(90, 80, 'CAR', SCHEDULE_CFG)).toBe(0);
  });

  it('FR-49 AC-4 projectSchedule worked example: short fits before booked slot, long goes to P1, tie at now+60 broken by point id', () => {
    // 2 MOTORCYCLE points: P1 running until now+20 min; P2 free now, booked [now+30, now+60]
    // Queue (in order): A (40 min), B (10 min), C (desiredTime now+50, 10 min)
    // Expected: B on P2 [now, now+10], A on P1 [now+20, now+60], C on P1 [now+60, now+70]
    const points = [
      { id: 'P1', vehicleClass: 'MOTORCYCLE' as const, status: 'CHARGING' as const },
      { id: 'P2', vehicleClass: 'MOTORCYCLE' as const, status: 'AVAILABLE' as const },
    ];
    const running = [
      {
        id: 'run-1',
        chargingPointId: 'P1',
        vehicleClass: 'MOTORCYCLE' as const,
        currentPct: 60,
        targetPct: 80, // 20% at 1%/min = 20 min -> ends at now+20
      },
    ];
    const booked = [
      {
        id: 'book-1',
        chargingPointId: 'P2',
        vehicleClass: 'MOTORCYCLE' as const,
        slotStart: atOffset(now, min(30)),
        slotEnd: atOffset(now, min(60)),
      },
    ];
    const ordered = [
      makeQueueEntry(now, {
        id: 'A',
        currentPct: 60,
        targetPct: 100, // 40 min
        desiredTime: now,
        neededBy: null,
        createdAt: atOffset(now, -min(10)),
      }),
      makeQueueEntry(now, {
        id: 'B',
        currentPct: 90,
        targetPct: 100, // 10 min
        desiredTime: now,
        neededBy: null,
        createdAt: atOffset(now, -min(5)),
      }),
      makeQueueEntry(now, {
        id: 'C',
        currentPct: 90,
        targetPct: 100, // 10 min
        desiredTime: atOffset(now, min(50)),
        neededBy: null,
        createdAt: now,
      }),
    ];

    const result = projectSchedule({
      points,
      running,
      booked,
      ordered,
      now,
      cfg: SCHEDULE_CFG,
    });

    const p1 = result.byPoint.get('P1');
    const p2 = result.byPoint.get('P2');
    expect(p1).toBeDefined();
    expect(p2).toBeDefined();

    expect(p2!.projected).toEqual([
      { requestId: 'B', pointId: 'P2', start: now, end: atOffset(now, min(10)) },
    ]);
    expect(p1!.projected).toEqual([
      { requestId: 'A', pointId: 'P1', start: atOffset(now, min(20)), end: atOffset(now, min(60)) },
      { requestId: 'C', pointId: 'P1', start: atOffset(now, min(60)), end: atOffset(now, min(70)) },
    ]);

    // Verify no overlaps on any point (running + booked + projected combined)
    assertNoOverlaps([
      { start: now, end: atOffset(now, min(20)) },
      ...p1!.projected,
    ]);
    assertNoOverlaps([
      { start: atOffset(now, min(30)), end: atOffset(now, min(60)) },
      ...p2!.projected,
    ]);
  });

  it('FR-50 AC-4 projectSchedule skips FAULTY points, never places a CAR request on MOTORCYCLE points, and CAR queuePosition ignores MOTORCYCLE requests', () => {
    const points = [
      { id: 'M1', vehicleClass: 'MOTORCYCLE' as const, status: 'AVAILABLE' as const },
      { id: 'C1', vehicleClass: 'CAR' as const, status: 'FAULTY' as const },
    ];
    const ordered = [
      makeQueueEntry(now, {
        id: 'moto-req',
        vehicleClass: 'MOTORCYCLE',
        currentPct: 50,
        targetPct: 70,
        desiredTime: now,
        neededBy: null,
        createdAt: now,
      }),
      makeQueueEntry(now, {
        id: 'car-req',
        vehicleClass: 'CAR',
        currentPct: 50,
        targetPct: 80,
        desiredTime: now,
        neededBy: null,
        createdAt: now,
      }),
    ];

    const result = projectSchedule({
      points,
      running: [],
      booked: [],
      ordered,
      now,
      cfg: SCHEDULE_CFG,
    });

    const m1 = result.byPoint.get('M1');
    const c1 = result.byPoint.get('C1');
    expect(m1!.projected.map((x) => x.requestId)).toEqual(['moto-req']);
    expect(c1!.projected).toEqual([]);

    const carEst = result.byRequest.get('car-req');
    expect(carEst?.queuePosition).toBe(1);
    expect(carEst?.estimatedStart).toBeNull();
    expect(carEst?.estimatedEnd).toBeNull();
  });
});

// ============================================================================
// HTTP API tests (AC-5, AC-6, AC-7, AC-9)
// ============================================================================

describe('T-17 Operator charging weights API (FR-48)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('FR-48 AC-5 GET weights returns defaults with isDefault true; PUT updates setting, emits event, audits before/after; reset restores defaults', async () => {
    const initial = await request(app)
      .get('/api/ops/charging/weights')
      .set('Authorization', operatorToken);
    expect(initial.status).toBe(200);
    expect(initial.body).toEqual({
      ...config.CHARGING_WEIGHTS,
      isDefault: true,
    } satisfies ChargingWeightsView);

    const emittedHubs: string[] = [];
    const listener = (payload: { hubId: string }) => {
      emittedHubs.push(payload.hubId);
    };
    events.on('CHARGING_QUEUE_CHANGED', listener);

    // Non-sum-to-1 weights are allowed per rule 1
    const putRes = await request(app)
      .put('/api/ops/charging/weights')
      .set('Authorization', operatorToken)
      .send({ battery: 2, urgency: 1, waiting: 0 });
    expect(putRes.status).toBe(200);
    expect(putRes.body).toEqual({ battery: 2, urgency: 1, waiting: 0 });

    const afterPut = await request(app)
      .get('/api/ops/charging/weights')
      .set('Authorization', operatorToken);
    expect(afterPut.status).toBe(200);
    expect(afterPut.body).toEqual({
      battery: 2,
      urgency: 1,
      waiting: 0,
      isDefault: false,
    });

    // Setting row persisted
    const settingRow = await db.setting.findUnique({ where: { key: 'charging.weights' } });
    expect(settingRow?.value).toEqual({ battery: 2, urgency: 1, waiting: 0 });

    // Audit row written with before/after
    const putAudits = await db.auditLog.findMany({
      where: { action: 'CHARGING_WEIGHTS_SET' },
      orderBy: { id: 'desc' },
    });
    expect(putAudits).toHaveLength(1);
    const putAudit = putAudits[0]!;
    expect(putAudit.entityType).toBe('setting');
    expect(putAudit.entityIds).toEqual(['charging.weights']);
    expect(putAudit.details).toEqual({
      before: config.CHARGING_WEIGHTS,
      after: { battery: 2, urgency: 1, waiting: 0 },
    });

    // Event emitted once per Hub (5 Hubs)
    expect(emittedHubs.sort()).toEqual(['campus-a', 'campus-b', 'dorm', 'metro', 'service']);
    emittedHubs.length = 0;

    // Reset weights
    const resetRes = await request(app)
      .post('/api/ops/charging/weights/reset')
      .set('Authorization', operatorToken);
    expect(resetRes.status).toBe(200);
    expect(resetRes.body).toMatchObject(config.CHARGING_WEIGHTS);

    const afterReset = await request(app)
      .get('/api/ops/charging/weights')
      .set('Authorization', operatorToken);
    expect(afterReset.status).toBe(200);
    expect(afterReset.body).toEqual({
      ...config.CHARGING_WEIGHTS,
      isDefault: true,
    });

    const deletedSetting = await db.setting.findUnique({ where: { key: 'charging.weights' } });
    expect(deletedSetting).toBeNull();

    const resetAudits = await db.auditLog.findMany({
      where: { action: 'CHARGING_WEIGHTS_RESET' },
    });
    expect(resetAudits).toHaveLength(1);
    const resetAudit = resetAudits[0]!;
    expect(resetAudit.entityType).toBe('setting');
    expect(resetAudit.entityIds).toEqual(['charging.weights']);
    expect(emittedHubs.sort()).toEqual(['campus-a', 'campus-b', 'dorm', 'metro', 'service']);
  });

  it('FR-48 AC-5 PUT weights rejects all-zero, negative, non-numeric string, or missing fields with 400 and leaves DB unchanged', async () => {
    const badPayloads = [
      { battery: 0, urgency: 0, waiting: 0 },
      { battery: -0.1, urgency: 0.5, waiting: 0.5 },
      { battery: 'abc', urgency: 0.3, waiting: 0.2 },
      { battery: 0.5, urgency: 0.3 },
    ];

    for (const body of badPayloads) {
      const res = await request(app)
        .put('/api/ops/charging/weights')
        .set('Authorization', operatorToken)
        .send(body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.details?.field).toBeTruthy();
      expect(res.body.error.nextActions.length).toBeGreaterThan(0);
    }

    const row = await db.setting.findUnique({ where: { key: 'charging.weights' } });
    expect(row).toBeNull();
    const audits = await db.auditLog.findMany({ where: { action: 'CHARGING_WEIGHTS_SET' } });
    expect(audits).toHaveLength(0);
  });

  it('FR-48 AC-5 changing weights immediately changes GET /ops/charging/queue order', async () => {
    // Use dorm hub where resetDb has no charging requests, and add 2 private EVs + 2 QUEUED requests
    const now = new Date();
    await db.privateEv.createMany({
      data: [
        { id: 'PEV-W1', ownerId: 'student1', type: 'E_MOTORCYCLE', vehicleClass: 'MOTORCYCLE', label: 'W1', batteryCapacityKwh: 4, batteryPct: 10 },
        { id: 'PEV-W2', ownerId: 'student2', type: 'E_MOTORCYCLE', vehicleClass: 'MOTORCYCLE', label: 'W2', batteryCapacityKwh: 4, batteryPct: 85 },
      ],
    });
    await db.chargingRequest.createMany({
      data: [
        // Low battery (10%), no urgency
        {
          id: 'CR-W1',
          requestedById: 'student1',
          ownerId: 'student1',
          vehicleKind: 'PRIVATE',
          privateEvId: 'PEV-W1',
          vehicleClass: 'MOTORCYCLE',
          hubId: 'dorm',
          mode: 'QUEUE',
          status: 'QUEUED',
          targetPct: 90,
          startPct: 10,
          currentPct: 10,
          desiredTime: atOffset(now, -min(5)),
          neededBy: null,
          createdAt: atOffset(now, -min(5)),
        },
        // High battery (85%), urgent neededBy in 10 min
        {
          id: 'CR-W2',
          requestedById: 'student2',
          ownerId: 'student2',
          vehicleKind: 'PRIVATE',
          privateEvId: 'PEV-W2',
          vehicleClass: 'MOTORCYCLE',
          hubId: 'dorm',
          mode: 'QUEUE',
          status: 'QUEUED',
          targetPct: 95,
          startPct: 85,
          currentPct: 85,
          desiredTime: atOffset(now, -min(5)),
          neededBy: atOffset(now, min(10)),
          createdAt: atOffset(now, -min(5)),
        },
      ],
    });

    // Set battery-dominant weights -> CR-W1 first
    await request(app)
      .put('/api/ops/charging/weights')
      .set('Authorization', operatorToken)
      .send({ battery: 1, urgency: 0, waiting: 0 })
      .expect(200);

    const q1 = await request(app)
      .get('/api/ops/charging/queue?hubId=dorm&vehicleClass=MOTORCYCLE')
      .set('Authorization', operatorToken);
    expect(q1.status).toBe(200);
    expect((q1.body as ChargingQueue).entries.map((e) => e.request.id)).toEqual(['CR-W1', 'CR-W2']);

    // Switch to urgency-dominant weights -> CR-W2 first
    await request(app)
      .put('/api/ops/charging/weights')
      .set('Authorization', operatorToken)
      .send({ battery: 0, urgency: 1, waiting: 0 })
      .expect(200);

    const q2 = await request(app)
      .get('/api/ops/charging/queue?hubId=dorm&vehicleClass=MOTORCYCLE')
      .set('Authorization', operatorToken);
    expect(q2.status).toBe(200);
    expect((q2.body as ChargingQueue).entries.map((e) => e.request.id)).toEqual(['CR-W2', 'CR-W1']);
  });
});

describe('T-17 Operator charging queue & schedule views (AC-6, AC-7)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('FR-48 AC-6 GET /ops/charging/queue validates hubId and vehicleClass', async () => {
    const missingHub = await request(app)
      .get('/api/ops/charging/queue')
      .set('Authorization', operatorToken);
    expect(missingHub.status).toBe(400);
    expect(missingHub.body.error.details?.field).toBe('hubId');

    const unknownHub = await request(app)
      .get('/api/ops/charging/queue?hubId=nope')
      .set('Authorization', operatorToken);
    expect(unknownHub.status).toBe(400);
    expect(unknownHub.body.error.details?.field).toBe('hubId');

    const badClass = await request(app)
      .get('/api/ops/charging/queue?hubId=metro&vehicleClass=TRUCK')
      .set('Authorization', operatorToken);
    expect(badClass.status).toBe(400);
    expect(badClass.body.error.details?.field).toBe('vehicleClass');
  });

  it('FR-49 AC-6 AC-7 queue and schedule agree on projected estimates, order MOTORCYCLE before CAR, include FAULTY points, and hide owner/requester ids', async () => {
    const now = new Date();

    // Add a CAR queued request and a future-desired MOTORCYCLE queued request at metro
    await db.privateEv.createMany({
      data: [
        { id: 'PEV-Q-CAR', ownerId: 'student2', type: 'CAR', vehicleClass: 'CAR', label: 'Car Q', batteryCapacityKwh: 50, batteryPct: 40 },
        { id: 'PEV-Q-FUT', ownerId: 'student2', type: 'E_MOTORCYCLE', vehicleClass: 'MOTORCYCLE', label: 'Future Moto', batteryCapacityKwh: 4, batteryPct: 30 },
      ],
    });
    await db.chargingRequest.createMany({
      data: [
        {
          id: 'CR-Q-CAR',
          requestedById: 'student2',
          ownerId: 'student2',
          vehicleKind: 'PRIVATE',
          privateEvId: 'PEV-Q-CAR',
          vehicleClass: 'CAR',
          hubId: 'metro',
          mode: 'QUEUE',
          status: 'QUEUED',
          targetPct: 90,
          startPct: 40,
          currentPct: 40,
          desiredTime: atOffset(now, -min(5)),
          createdAt: atOffset(now, -min(5)),
        },
        {
          id: 'CR-Q-FUT',
          requestedById: 'student2',
          ownerId: 'student2',
          vehicleKind: 'PRIVATE',
          privateEvId: 'PEV-Q-FUT',
          vehicleClass: 'MOTORCYCLE',
          hubId: 'metro',
          mode: 'QUEUE',
          status: 'QUEUED',
          targetPct: 80,
          startPct: 30,
          currentPct: 30,
          desiredTime: atOffset(now, min(45)),
          createdAt: atOffset(now, -min(10)),
        },
      ],
    });

    const queueRes = await request(app)
      .get('/api/ops/charging/queue?hubId=metro')
      .set('Authorization', operatorToken);
    expect(queueRes.status).toBe(200);
    const queue = queueRes.body as ChargingQueue;

    // MOTORCYCLE entries come before CAR entries when vehicleClass is omitted
    const classes = queue.entries.map((e) => e.request.vehicleClass);
    const firstCarIdx = classes.indexOf('CAR');
    expect(firstCarIdx).toBeGreaterThan(0);
    expect(classes.slice(0, firstCarIdx).every((c) => c === 'MOTORCYCLE')).toBe(true);
    expect(classes.slice(firstCarIdx).every((c) => c === 'CAR')).toBe(true);

    // CR-M-002 (eligible) ranks before CR-Q-FUT (future desiredTime)
    const motoEntries = queue.entries.filter((e) => e.request.vehicleClass === 'MOTORCYCLE');
    expect(motoEntries.map((e) => e.request.id)).toEqual(['CR-M-002', 'CR-Q-FUT']);
    expect(motoEntries.map((e) => e.rank)).toEqual([1, 2]);
    expect(motoEntries[1]!.breakdown.waiting).toBe(0);

    // CAR entry ranked 1 (ignores MOTORCYCLE requests)
    const carEntries = queue.entries.filter((e) => e.request.vehicleClass === 'CAR');
    expect(carEntries.map((e) => e.request.id)).toEqual(['CR-Q-CAR']);
    expect(carEntries[0]!.rank).toBe(1);
    expect(carEntries[0]!.request.queuePosition).toBe(1);

    // SCHEDULED and CHARGING requests not in queue
    expect(queue.entries.find((e) => ['CR-M-001', 'CR-M-003', 'CR-M-004', 'CR-C-001'].includes(e.request.id))).toBeUndefined();

    // DTO checks: never expose requestedById / ownerId; breakdown sums to score
    for (const entry of queue.entries) {
      expect(entry.request.queuePosition).toBe(entry.rank);
      expect(entry.request.serverNow).toBeTruthy();
      expect('requestedById' in entry.request).toBe(false);
      expect('ownerId' in entry.request).toBe(false);
      const sum =
        entry.breakdown.battery +
        entry.breakdown.urgency +
        entry.breakdown.waiting +
        entry.breakdown.manualAdjust;
      expect(sum).toBeCloseTo(entry.score, 6);
    }

    // Schedule for metro
    const schedMetroRes = await request(app)
      .get('/api/ops/charging/schedule?hubId=metro')
      .set('Authorization', operatorToken);
    expect(schedMetroRes.status).toBe(200);
    const schedMetro = schedMetroRes.body as ChargingSchedule;

    // Points ordered by id ASC
    const pointIds = schedMetro.points.map((p) => p.point.id);
    expect(pointIds).toEqual([...pointIds].sort());

    // FAULTY point MET-CP-M-03 is included with empty projected
    const faultyPt = schedMetro.points.find((p) => p.point.id === 'MET-CP-M-03');
    expect(faultyPt).toBeDefined();
    expect(faultyPt!.point.status).toBe('FAULTY');
    expect(faultyPt!.current).toBeNull();
    expect(faultyPt!.booked).toEqual([]);
    expect(faultyPt!.projected).toEqual([]);

    // Running session CR-M-001 on MET-CP-M-02: estimatedStart null, estimatedEnd present
    const cpM02 = schedMetro.points.find((p) => p.point.id === 'MET-CP-M-02');
    expect(cpM02?.current?.id).toBe('CR-M-001');
    expect(cpM02?.current?.estimatedStart).toBeNull();
    expect(cpM02?.current?.estimatedEnd).toBeTruthy();
    expect(cpM02?.current?.queuePosition).toBeNull();

    // Booked session CR-M-003 on MET-CP-M-04
    const cpM04 = schedMetro.points.find((p) => p.point.id === 'MET-CP-M-04');
    expect(cpM04?.booked.map((b) => b.id)).toEqual(['CR-M-003']);
    expect(cpM04?.booked[0]!.estimatedStart).toBe(cpM04?.booked[0]!.slotStart);
    expect(cpM04?.booked[0]!.estimatedEnd).toBe(cpM04?.booked[0]!.slotEnd);

    // Every projected item matches queue's estimatedStart/estimatedEnd and has no overlaps on its point
    const projectedById = new Map<string, { estimatedStart: string; estimatedEnd: string }>();
    for (const pt of schedMetro.points) {
      const intervals: Array<{ start: string; end: string }> = [];
      if (pt.current?.estimatedEnd) {
        intervals.push({ start: schedMetro.generatedAt, end: pt.current.estimatedEnd });
      }
      for (const b of pt.booked) {
        if (b.slotStart && b.slotEnd) intervals.push({ start: b.slotStart, end: b.slotEnd });
      }
      for (const proj of pt.projected) {
        intervals.push({ start: proj.estimatedStart, end: proj.estimatedEnd });
        projectedById.set(proj.requestId, {
          estimatedStart: proj.estimatedStart,
          estimatedEnd: proj.estimatedEnd,
        });
      }
      assertNoOverlaps(intervals);
    }

    for (const entry of queue.entries) {
      const p = projectedById.get(entry.request.id);
      expect(p).toBeDefined();
      // Sequential HTTP calls evaluate `new Date()` a few ms apart; when shifted by
      // (generatedAt - serverNow) or evaluated at a shared `now`, times match identically.
      const clockDeltaMs =
        Date.parse(schedMetro.generatedAt) - Date.parse(entry.request.serverNow);
      expect(
        Math.abs(
          Date.parse(p!.estimatedStart) -
            Date.parse(entry.request.estimatedStart!) -
            clockDeltaMs,
        ),
      ).toBeLessThanOrEqual(clockDeltaMs + 5);
      expect(
        Math.abs(
          Date.parse(p!.estimatedEnd) -
            Date.parse(entry.request.estimatedEnd!) -
            clockDeltaMs,
        ),
      ).toBeLessThanOrEqual(clockDeltaMs + 5);
    }

    // At a shared `now`, getQueue and getSchedule produce identical ISO strings
    const sharedNow = new Date();
    const [qAtNow, sAtNow] = await Promise.all([
      getQueue({ hubId: 'metro' }, sharedNow),
      getSchedule({ hubId: 'metro' }, sharedNow),
    ]);
    const projAtNow = new Map<string, { estimatedStart: string; estimatedEnd: string }>();
    for (const pt of sAtNow.points) {
      for (const proj of pt.projected) {
        projAtNow.set(proj.requestId, {
          estimatedStart: proj.estimatedStart,
          estimatedEnd: proj.estimatedEnd,
        });
      }
    }
    for (const entry of qAtNow.entries) {
      const p = projAtNow.get(entry.request.id);
      expect(p).toBeDefined();
      expect(entry.request.estimatedStart).toBe(p!.estimatedStart);
      expect(entry.request.estimatedEnd).toBe(p!.estimatedEnd);
    }

    // All-hubs schedule ordered by hubId ASC, then point.id ASC
    const schedAllRes = await request(app)
      .get('/api/ops/charging/schedule')
      .set('Authorization', operatorToken);
    expect(schedAllRes.status).toBe(200);
    const schedAll = schedAllRes.body as ChargingSchedule;
    expect(schedAll.points).toHaveLength(13);
    const keys = schedAll.points.map((p) => `${p.point.hubId}:${p.point.id}`);
    expect(keys).toEqual([...keys].sort());

    // Unknown hubId on schedule -> 400
    const badSchedHub = await request(app)
      .get('/api/ops/charging/schedule?hubId=unknown')
      .set('Authorization', operatorToken);
    expect(badSchedHub.status).toBe(400);
    expect(badSchedHub.body.error.details?.field).toBe('hubId');
  });
});

describe('T-17 Role & Auth enforcement on all 5 routes (AC-9)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  const routes = [
    { method: 'get' as const, path: '/api/ops/charging/queue?hubId=metro' },
    { method: 'get' as const, path: '/api/ops/charging/schedule' },
    { method: 'get' as const, path: '/api/ops/charging/weights' },
    { method: 'put' as const, path: '/api/ops/charging/weights', body: { battery: 0.5, urgency: 0.3, waiting: 0.2 } },
    { method: 'post' as const, path: '/api/ops/charging/weights/reset' },
  ];

  it('FR-61 AC-9 returns 401 without token on all five routes', async () => {
    for (const r of routes) {
      const req = request(app)[r.method](r.path);
      const res = r.body ? await req.send(r.body) : await req;
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHENTICATED');
    }
  });

  it('FR-61 AC-9 returns 403 and writes SECURITY_DENIED audit row for STUDENT token on all five routes', async () => {
    for (const r of routes) {
      const req = request(app)[r.method](r.path).set('Authorization', studentToken);
      const res = r.body ? await req.send(r.body) : await req;
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    }

    const audits = await db.auditLog.findMany({
      where: { action: 'SECURITY_DENIED', actorId: 'student1' },
    });
    expect(audits).toHaveLength(5);
  });
});
