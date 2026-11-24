import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createTestApp, resetDb, loginAs } from './helpers';
import { db } from '../src/core/db';
import { config } from '../src/core/config';
import { runScheduler } from '../src/modules/charging/scheduler.service';
import { score, type PriorityConfig } from '../src/modules/charging/priority';
import { estimateDurationMs, type ScheduleConfig } from '../src/modules/charging/schedule';
import { getWeights } from '../src/modules/charging/charging.service';
import { overrideQueue } from '../src/modules/charging/chargingOps.service';
import type { Alternative } from '../src/types/common';
import type { ChargingQueueEntry, ChargingRequestView } from '../src/types/charging';

const app = createTestApp();
let student1Token: string;
let student2Token: string;
let operatorToken: string;

function min(n: number): number {
  return n * 60_000;
}

function atOffset(base: Date, offsetMs: number): Date {
  return new Date(base.getTime() + offsetMs);
}

function uid(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

function getScheduleConfig(): ScheduleConfig {
  return {
    chargeRatePctPerMin: config.CHARGE_RATE_PCT_PER_MIN,
    demoTimeScale: config.DEMO_TIME_SCALE,
  };
}

function getPriorityConfig(): PriorityConfig {
  return {
    urgencyHorizonMin: config.URGENCY_HORIZON_MIN,
    waitingFullMin: config.WAITING_FULL_MIN,
  };
}

function assertNoPointOverlaps(
  rows: Array<{
    id: string;
    chargingPointId: string | null;
    status: string;
    slotStart: Date | null;
    slotEnd: Date | null;
  }>,
) {
  const byPoint = new Map<string, Array<{ start: number; end: number }>>();
  for (const r of rows) {
    if (!r.chargingPointId || (r.status !== 'CHARGING' && r.status !== 'SCHEDULED')) continue;
    expect(r.slotStart).not.toBeNull();
    expect(r.slotEnd).not.toBeNull();
    const list = byPoint.get(r.chargingPointId) ?? [];
    list.push({ start: r.slotStart!.getTime(), end: r.slotEnd!.getTime() });
    byPoint.set(r.chargingPointId, list);
  }
  for (const list of byPoint.values()) {
    list.sort((a, b) => a.start - b.start);
    for (let i = 0; i < list.length; i++) {
      const curr = list[i]!;
      expect(curr.end).toBeGreaterThan(curr.start);
      if (i > 0) {
        const prev = list[i - 1]!;
        expect(curr.start).toBeGreaterThanOrEqual(prev.end);
      }
    }
  }
}

beforeAll(async () => {
  await resetDb();
  student1Token = loginAs('student1');
  student2Token = loginAs('student2');
  operatorToken = loginAs('operator1');
});

// ============================================================================
// AC-1: FR-21 availability
// ============================================================================

describe('T-20 AC-1 FR-21 availability', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('T-20 AC-1 FR-21 availability returns available=true, empty suggestions, and D-09 slotEnd for MOTORCYCLE and CAR', async () => {
    const now = new Date();
    const slotStart = atOffset(now, min(90));
    const motoTarget = 85;
    const carTarget = 90;

    // PEV-03: student1 MOTORCYCLE, batteryPct 55; dorm has DOR-CP-M-01 AVAILABLE
    const motoRes = await request(app)
      .get('/api/charging/availability')
      .set('Authorization', student1Token)
      .query({
        hubId: 'dorm',
        privateEvId: 'PEV-03',
        slotStart: slotStart.toISOString(),
        targetPct: String(motoTarget),
      });

    expect(motoRes.status).toBe(200);
    expect(motoRes.body.available).toBe(true);
    expect(motoRes.body.suggestions).toEqual([]);
    const expectedMotoEnd = new Date(
      slotStart.getTime() + estimateDurationMs(55, motoTarget, 'MOTORCYCLE', getScheduleConfig()),
    ).toISOString();
    expect(motoRes.body.slotEnd).toBe(expectedMotoEnd);

    // PEV-01: student1 CAR, batteryPct 60; dorm has DOR-CP-C-01 AVAILABLE
    const carRes = await request(app)
      .get('/api/charging/availability')
      .set('Authorization', student1Token)
      .query({
        hubId: 'dorm',
        privateEvId: 'PEV-01',
        slotStart: slotStart.toISOString(),
        targetPct: String(carTarget),
      });

    expect(carRes.status).toBe(200);
    expect(carRes.body.available).toBe(true);
    expect(carRes.body.suggestions).toEqual([]);
    const expectedCarEnd = new Date(
      slotStart.getTime() + estimateDurationMs(60, carTarget, 'CAR', getScheduleConfig()),
    ).toISOString();
    expect(carRes.body.slotEnd).toBe(expectedCarEnd);
  });

  it('T-20 AC-1 FR-21 availability treats touching windows [t+60, t+120) and [t+120, ...) as non-blocking', async () => {
    const base = new Date();
    const otherEvId = uid('PEV');
    await db.privateEv.create({
      data: {
        id: otherEvId,
        ownerId: 'student2',
        type: 'E_MOTORCYCLE',
        vehicleClass: 'MOTORCYCLE',
        label: 'Other Moto',
        batteryCapacityKwh: 4,
        batteryPct: 40,
      },
    });

    // Book the single MOTORCYCLE point at dorm: [base+60m, base+120m)
    await db.chargingRequest.create({
      data: {
        id: uid('CR'),
        requestedById: 'student2',
        ownerId: 'student2',
        vehicleKind: 'PRIVATE',
        privateEvId: otherEvId,
        vehicleClass: 'MOTORCYCLE',
        hubId: 'dorm',
        mode: 'ADVANCE',
        status: 'SCHEDULED',
        targetPct: 100,
        startPct: 40,
        currentPct: 40,
        desiredTime: atOffset(base, min(60)),
        chargingPointId: 'DOR-CP-M-01',
        slotStart: atOffset(base, min(60)),
        slotEnd: atOffset(base, min(120)),
      },
    });

    // Touching after: [base+120m, ...)
    const afterRes = await request(app)
      .get('/api/charging/availability')
      .set('Authorization', student1Token)
      .query({
        hubId: 'dorm',
        privateEvId: 'PEV-03',
        slotStart: atOffset(base, min(120)).toISOString(),
        targetPct: '85',
      });
    expect(afterRes.status).toBe(200);
    expect(afterRes.body.available).toBe(true);
    expect(afterRes.body.suggestions).toEqual([]);

    // Touching before: PEV-03 has 55% -> target 70% at 1%/min = 15m -> [base+45m, base+60m)
    const beforeRes = await request(app)
      .get('/api/charging/availability')
      .set('Authorization', student1Token)
      .query({
        hubId: 'dorm',
        privateEvId: 'PEV-03',
        slotStart: atOffset(base, min(45)).toISOString(),
        targetPct: '70',
      });
    expect(beforeRes.status).toBe(200);
    expect(beforeRes.body.available).toBe(true);
    expect(beforeRes.body.suggestions).toEqual([]);
  });

  it('T-20 AC-1 FR-21 availability ignores QUEUED requests (BR-06) and ignores FAULTY or wrong-class points (BR-13)', async () => {
    const base = new Date();
    // Add a QUEUED request at dorm for MOTORCYCLE; should NOT block availability
    const queuedEvId = uid('PEV');
    await db.privateEv.create({
      data: {
        id: queuedEvId,
        ownerId: 'student2',
        type: 'E_MOTORCYCLE',
        vehicleClass: 'MOTORCYCLE',
        label: 'Queued Moto',
        batteryCapacityKwh: 4,
        batteryPct: 20,
      },
    });
    await db.chargingRequest.create({
      data: {
        id: uid('CR'),
        requestedById: 'student2',
        ownerId: 'student2',
        vehicleKind: 'PRIVATE',
        privateEvId: queuedEvId,
        vehicleClass: 'MOTORCYCLE',
        hubId: 'dorm',
        mode: 'QUEUE',
        status: 'QUEUED',
        targetPct: 100,
        startPct: 20,
        currentPct: 20,
        desiredTime: base,
      },
    });

    const motoRes = await request(app)
      .get('/api/charging/availability')
      .set('Authorization', student1Token)
      .query({
        hubId: 'dorm',
        privateEvId: 'PEV-03',
        slotStart: atOffset(base, min(30)).toISOString(),
        targetPct: '85',
      });
    expect(motoRes.status).toBe(200);
    expect(motoRes.body.available).toBe(true);

    // campus-b has 1 CAR point CPB-CP-C-01 which is FAULTY, and 1 MOTO point CPB-CP-M-01 AVAILABLE.
    // PEV-01 (CAR) must NOT use MOTO point or FAULTY CAR point.
    const carAtCampusB = await request(app)
      .get('/api/charging/availability')
      .set('Authorization', student1Token)
      .query({
        hubId: 'campus-b',
        privateEvId: 'PEV-01',
        slotStart: atOffset(base, min(30)).toISOString(),
        targetPct: '80',
      });
    expect(carAtCampusB.status).toBe(200);
    expect(carAtCampusB.body.available).toBe(false);
    // No time suggestions at campus-b (only FAULTY CAR point), should still suggest other Hubs (dorm, campus-a)
    const suggestions = carAtCampusB.body.suggestions as Alternative[];
    expect(suggestions.every((s) => s.type === 'hub')).toBe(true);
    expect(suggestions.some((s) => s.hubId === 'dorm' || s.hubId === 'campus-a')).toBe(true);
  });

  it('T-20 AC-1 FR-21 availability when blocked returns <= ALTERNATIVE_SLOTS_COUNT earlier-first time suggestions then non-degraded other Hubs', async () => {
    const base = new Date();
    // Create 4 non-contiguous blocking SCHEDULED intervals on DOR-CP-M-01 (the only MOTO point at dorm)
    // Requested duration for PEV-03 (55 -> 75 = 20 min at 1%/min)
    // Blocks: [60, 120), [160, 190), [230, 260), [300, 330), [370, 400)
    // Candidate ends > t+90: t+120 (free [120,140)), t+190 (free [190,210)), t+260 (free [260,280)), t+330 (free [330,350))
    const blocks = [
      [60, 120],
      [160, 190],
      [230, 260],
      [300, 330],
      [370, 400],
    ] as const;

    for (const [sMin, eMin] of blocks) {
      const evId = uid('PEV');
      await db.privateEv.create({
        data: {
          id: evId,
          ownerId: 'student2',
          type: 'E_MOTORCYCLE',
          vehicleClass: 'MOTORCYCLE',
          label: `Blocker ${sMin}`,
          batteryCapacityKwh: 4,
          batteryPct: 40,
        },
      });
      await db.chargingRequest.create({
        data: {
          id: uid('CR'),
          requestedById: 'student2',
          ownerId: 'student2',
          vehicleKind: 'PRIVATE',
          privateEvId: evId,
          vehicleClass: 'MOTORCYCLE',
          hubId: 'dorm',
          mode: 'ADVANCE',
          status: 'SCHEDULED',
          targetPct: 90,
          startPct: 40,
          currentPct: 40,
          desiredTime: atOffset(base, min(sMin)),
          chargingPointId: 'DOR-CP-M-01',
          slotStart: atOffset(base, min(sMin)),
          slotEnd: atOffset(base, min(eMin)),
        },
      });
    }

    // Ensure campus-a has fresh telemetry so it appears as an alternative Hub (service is degraded)
    await db.hub.update({
      where: { id: 'campus-a' },
      data: { lastTelemetryAt: new Date() },
    });

    const requestedStart = atOffset(base, min(90));
    const res = await request(app)
      .get('/api/charging/availability')
      .set('Authorization', student1Token)
      .query({
        hubId: 'dorm',
        privateEvId: 'PEV-03',
        slotStart: requestedStart.toISOString(),
        targetPct: '75',
      });

    expect(res.status).toBe(200);
    expect(res.body.available).toBe(false);
    const suggestions = res.body.suggestions as Alternative[];

    const timeSuggestions = suggestions.filter((s) => s.type === 'time');
    const hubSuggestions = suggestions.filter((s) => s.type === 'hub');

    expect(timeSuggestions.length).toBe(config.ALTERNATIVE_SLOTS_COUNT);
    expect(timeSuggestions.map((s) => s.start)).toEqual([
      atOffset(base, min(120)).toISOString(),
      atOffset(base, min(190)).toISOString(),
      atOffset(base, min(260)).toISOString(),
    ]);
    for (const ts of timeSuggestions) {
      expect(ts.end).toBe(
        new Date(
          new Date(ts.start!).getTime() +
            estimateDurationMs(55, 75, 'MOTORCYCLE', getScheduleConfig()),
        ).toISOString(),
      );
      expect(ts.reason.length).toBeGreaterThan(0);
    }

    // Time suggestions come BEFORE hub suggestions
    const lastTimeIdx = suggestions.reduce((acc, s, i) => (s.type === 'time' ? i : acc), -1);
    const firstHubIdx = suggestions.findIndex((s) => s.type === 'hub');
    expect(firstHubIdx).toBeGreaterThan(lastTimeIdx);

    // Other non-degraded Hubs free for [t+90, t+110) are included; degraded service Hub is excluded
    expect(hubSuggestions.length).toBeGreaterThan(0);
    expect(hubSuggestions.some((h) => h.hubId === 'service')).toBe(false);
    expect(hubSuggestions.some((h) => h.hubId === 'dorm')).toBe(false);
  });

  it('T-20 AC-1 FR-21 availability skips candidate ends whose gap is shorter than duration and deduplicates identical ends', async () => {
    const base = new Date();
    // PEV-03: 55 -> 85 = 30 min duration.
    // Booked on MET-CP-M-01, MET-CP-M-04, MET-CP-M-05 (all 3 usable MOTO points at metro):
    // MET-CP-M-01: [60, 120) and [130, 200) -> t+120 has only 10m gap (too short for 30m!), t+200 is free
    // MET-CP-M-04: [60, 120) and [130, 200) -> duplicate t+120, duplicate t+200
    // MET-CP-M-05: [60, 125) and [135, 220) -> t+125 has only 10m gap, t+220 is free
    // Also MET-CP-M-02 is CHARGING (let's make sure CR-M-001 covers [base-10m, base+300m) so it blocks [t+90, t+120))
    await db.chargingRequest.update({
      where: { id: 'CR-M-001' },
      data: { slotEnd: atOffset(base, min(300)) },
    });

    const slots: Array<[string, number, number]> = [
      ['MET-CP-M-01', 60, 120],
      ['MET-CP-M-01', 130, 200],
      ['MET-CP-M-04', 60, 120],
      ['MET-CP-M-04', 130, 200],
      ['MET-CP-M-05', 60, 125],
      ['MET-CP-M-05', 135, 220],
    ];
    // Remove fixture CR-M-003/CR-M-004 so we control exact slots on MET-CP-M-04/05
    await db.chargingRequest.deleteMany({ where: { id: { in: ['CR-M-003', 'CR-M-004'] } } });

    for (const [pt, sMin, eMin] of slots) {
      const evId = uid('PEV');
      await db.privateEv.create({
        data: {
          id: evId,
          ownerId: 'student2',
          type: 'E_MOTORCYCLE',
          vehicleClass: 'MOTORCYCLE',
          label: `S-${pt}-${sMin}`,
          batteryCapacityKwh: 4,
          batteryPct: 40,
        },
      });
      await db.chargingRequest.create({
        data: {
          id: uid('CR'),
          requestedById: 'student2',
          ownerId: 'student2',
          vehicleKind: 'PRIVATE',
          privateEvId: evId,
          vehicleClass: 'MOTORCYCLE',
          hubId: 'metro',
          mode: 'ADVANCE',
          status: 'SCHEDULED',
          targetPct: 90,
          startPct: 40,
          currentPct: 40,
          desiredTime: atOffset(base, min(sMin)),
          chargingPointId: pt,
          slotStart: atOffset(base, min(sMin)),
          slotEnd: atOffset(base, min(eMin)),
        },
      });
    }

    const res = await request(app)
      .get('/api/charging/availability')
      .set('Authorization', student1Token)
      .query({
        hubId: 'metro',
        privateEvId: 'PEV-03',
        slotStart: atOffset(base, min(90)).toISOString(),
        targetPct: '85',
      });

    expect(res.status).toBe(200);
    expect(res.body.available).toBe(false);
    const timeStarts = (res.body.suggestions as Alternative[])
      .filter((s) => s.type === 'time')
      .map((s) => s.start);

    // Distinct starts, sorted earlier-first, t+120 and t+125 skipped because gap < 30m;
    // t+200, t+220, and CR-M-001's t+300 are the 3 (= ALTERNATIVE_SLOTS_COUNT) valid starts.
    expect(new Set(timeStarts).size).toBe(timeStarts.length);
    expect(timeStarts).toEqual([
      atOffset(base, min(200)).toISOString(),
      atOffset(base, min(220)).toISOString(),
      atOffset(base, min(300)).toISOString(),
    ]);
  });

  it('T-20 AC-1 FR-21 availability validates inputs (400/403/404) and allows EV with an active request', async () => {
    const base = new Date();
    const future = atOffset(base, min(60)).toISOString();
    const past = atOffset(base, -min(10)).toISOString();

    // Unknown hubId -> 400
    const badHub = await request(app)
      .get('/api/charging/availability')
      .set('Authorization', student1Token)
      .query({ hubId: 'unknown-hub', privateEvId: 'PEV-03', slotStart: future, targetPct: '85' });
    expect(badHub.status).toBe(400);

    // Past slotStart -> 400
    const pastRes = await request(app)
      .get('/api/charging/availability')
      .set('Authorization', student1Token)
      .query({ hubId: 'dorm', privateEvId: 'PEV-03', slotStart: past, targetPct: '85' });
    expect(pastRes.status).toBe(400);

    // Invalid ISO slotStart -> 400
    const badIso = await request(app)
      .get('/api/charging/availability')
      .set('Authorization', student1Token)
      .query({ hubId: 'dorm', privateEvId: 'PEV-03', slotStart: 'not-a-date', targetPct: '85' });
    expect(badIso.status).toBe(400);

    // targetPct <= batteryPct (55) -> 400 details.field = targetPct
    const lowTarget = await request(app)
      .get('/api/charging/availability')
      .set('Authorization', student1Token)
      .query({ hubId: 'dorm', privateEvId: 'PEV-03', slotStart: future, targetPct: '55' });
    expect(lowTarget.status).toBe(400);
    expect(lowTarget.body.error?.details?.field).toBe('targetPct');

    // targetPct > 100 -> 400
    const overTarget = await request(app)
      .get('/api/charging/availability')
      .set('Authorization', student1Token)
      .query({ hubId: 'dorm', privateEvId: 'PEV-03', slotStart: future, targetPct: '101' });
    expect(overTarget.status).toBe(400);

    // Missing EV -> 404
    const missingEv = await request(app)
      .get('/api/charging/availability')
      .set('Authorization', student1Token)
      .query({ hubId: 'dorm', privateEvId: 'NO-SUCH-EV', slotStart: future, targetPct: '85' });
    expect(missingEv.status).toBe(404);

    // Soft-deleted EV -> 404
    const delEvId = uid('PEV');
    await db.privateEv.create({
      data: {
        id: delEvId,
        ownerId: 'student1',
        type: 'E_MOTORCYCLE',
        vehicleClass: 'MOTORCYCLE',
        label: 'Deleted EV',
        batteryCapacityKwh: 3,
        batteryPct: 40,
        deletedAt: new Date(),
      },
    });
    const deletedEv = await request(app)
      .get('/api/charging/availability')
      .set('Authorization', student1Token)
      .query({ hubId: 'dorm', privateEvId: delEvId, slotStart: future, targetPct: '85' });
    expect(deletedEv.status).toBe(404);

    // Another student's EV -> 403
    const otherEv = await request(app)
      .get('/api/charging/availability')
      .set('Authorization', student1Token)
      .query({ hubId: 'dorm', privateEvId: 'PEV-02', slotStart: future, targetPct: '90' });
    expect(otherEv.status).toBe(403);

    // EV with existing live request (PEV-03 has CR-M-004 SCHEDULED in fixture) still succeeds on availability
    const withLiveReq = await request(app)
      .get('/api/charging/availability')
      .set('Authorization', student1Token)
      .query({ hubId: 'dorm', privateEvId: 'PEV-03', slotStart: future, targetPct: '85' });
    expect(withLiveReq.status).toBe(200);
    expect(withLiveReq.body.available).toBe(true);
  });
});

// ============================================================================
// AC-2: FR-21 advance-bookings
// ============================================================================

describe('T-20 AC-2 FR-21 advance-bookings', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('T-20 AC-2 FR-21 creates 201 SCHEDULED ADVANCE request on a usable point of EV class', async () => {
    const evId = uid('PEV');
    await db.privateEv.create({
      data: {
        id: evId,
        ownerId: 'student1',
        type: 'CAR',
        vehicleClass: 'CAR',
        label: 'Fresh Car',
        batteryCapacityKwh: 60,
        batteryPct: 40,
      },
    });

    const slotStart = atOffset(new Date(), min(60));
    const targetPct = 80;
    const expectedSlotEnd = new Date(
      slotStart.getTime() + estimateDurationMs(40, targetPct, 'CAR', getScheduleConfig()),
    );

    const res = await request(app)
      .post('/api/charging/advance-bookings')
      .set('Authorization', student1Token)
      .send({
        privateEvId: evId,
        hubId: 'dorm',
        slotStart: slotStart.toISOString(),
        targetPct,
      });

    expect(res.status).toBe(201);
    const body = res.body as ChargingRequestView;
    expect(body.status).toBe('SCHEDULED');
    expect(body.mode).toBe('ADVANCE');
    expect(body.vehicleKind).toBe('PRIVATE');
    expect(body.privateEvId).toBe(evId);
    expect(body.vehicleClass).toBe('CAR');
    expect(body.hubId).toBe('dorm');
    expect(body.chargingPointId).toBe('DOR-CP-C-01');
    expect(body.startPct).toBe(40);
    expect(body.currentPct).toBe(40);
    expect(body.targetPct).toBe(targetPct);
    expect(body.slotStart).toBe(slotStart.toISOString());
    expect(body.slotEnd).toBe(expectedSlotEnd.toISOString());
    expect(body.estimatedStart).toBe(slotStart.toISOString());
    expect(body.estimatedEnd).toBe(expectedSlotEnd.toISOString());

    const row = await db.chargingRequest.findUnique({ where: { id: body.id } });
    expect(row).not.toBeNull();
    expect(row!.requestedById).toBe('student1');
    expect(row!.ownerId).toBe('student1');
  });

  it('T-20 AC-2 FR-21 advance-bookings ignores QUEUED requests at the Hub (BR-06)', async () => {
    const evId = uid('PEV');
    await db.privateEv.create({
      data: {
        id: evId,
        ownerId: 'student2',
        type: 'E_MOTORCYCLE',
        vehicleClass: 'MOTORCYCLE',
        label: 'Moto Book',
        batteryCapacityKwh: 4,
        batteryPct: 50,
      },
    });
    const queuedEvId = uid('PEV');
    await db.privateEv.create({
      data: {
        id: queuedEvId,
        ownerId: 'student1',
        type: 'E_MOTORCYCLE',
        vehicleClass: 'MOTORCYCLE',
        label: 'Moto Queue',
        batteryCapacityKwh: 4,
        batteryPct: 20,
      },
    });
    await db.chargingRequest.create({
      data: {
        id: uid('CR'),
        requestedById: 'student1',
        ownerId: 'student1',
        vehicleKind: 'PRIVATE',
        privateEvId: queuedEvId,
        vehicleClass: 'MOTORCYCLE',
        hubId: 'dorm',
        mode: 'QUEUE',
        status: 'QUEUED',
        targetPct: 100,
        startPct: 20,
        currentPct: 20,
        desiredTime: new Date(),
      },
    });

    const slotStart = atOffset(new Date(), min(30));
    const res = await request(app)
      .post('/api/charging/advance-bookings')
      .set('Authorization', student2Token)
      .send({
        privateEvId: evId,
        hubId: 'dorm',
        slotStart: slotStart.toISOString(),
        targetPct: 80,
      });

    expect(res.status).toBe(201);
    expect(res.body.chargingPointId).toBe('DOR-CP-M-01');
  });

  it('T-20 AC-2 FR-21 returns 400 with 0 DB changes on missing field, unknown hubId, past slotStart, or invalid targetPct', async () => {
    const evId = uid('PEV');
    await db.privateEv.create({
      data: {
        id: evId,
        ownerId: 'student1',
        type: 'E_MOTORCYCLE',
        vehicleClass: 'MOTORCYCLE',
        label: 'Fresh Moto',
        batteryCapacityKwh: 4,
        batteryPct: 50,
      },
    });
    const beforeCount = await db.chargingRequest.count();
    const future = atOffset(new Date(), min(60)).toISOString();

    const cases = [
      { hubId: 'dorm', slotStart: future, targetPct: 80 }, // missing privateEvId
      { privateEvId: evId, slotStart: future, targetPct: 80 }, // missing hubId
      { privateEvId: evId, hubId: 'dorm', targetPct: 80 }, // missing slotStart
      { privateEvId: evId, hubId: 'dorm', slotStart: future }, // missing targetPct
      { privateEvId: evId, hubId: 'no-hub', slotStart: future, targetPct: 80 }, // unknown hubId
      {
        privateEvId: evId,
        hubId: 'dorm',
        slotStart: atOffset(new Date(), -min(5)).toISOString(),
        targetPct: 80,
      }, // past slotStart
      { privateEvId: evId, hubId: 'dorm', slotStart: future, targetPct: 50 }, // targetPct <= batteryPct
      { privateEvId: evId, hubId: 'dorm', slotStart: future, targetPct: 101 }, // targetPct > 100
      { privateEvId: evId, hubId: 'dorm', slotStart: future, targetPct: 0 }, // targetPct <= 0
    ];

    for (const payload of cases) {
      const res = await request(app)
        .post('/api/charging/advance-bookings')
        .set('Authorization', student1Token)
        .send(payload);
      expect(res.status).toBe(400);
      expect(res.body.error?.code).toBe('VALIDATION_ERROR');
      expect(res.body.error?.nextActions?.length).toBeGreaterThan(0);
    }

    const afterCount = await db.chargingRequest.count();
    expect(afterCount).toBe(beforeCount);
  });

  it('T-20 AC-2 FR-21 returns 404 for missing/deleted EV and 403 for another student EV', async () => {
    const future = atOffset(new Date(), min(60)).toISOString();

    const missing = await request(app)
      .post('/api/charging/advance-bookings')
      .set('Authorization', student1Token)
      .send({ privateEvId: 'MISSING-EV', hubId: 'dorm', slotStart: future, targetPct: 90 });
    expect(missing.status).toBe(404);

    const delEvId = uid('PEV');
    await db.privateEv.create({
      data: {
        id: delEvId,
        ownerId: 'student1',
        type: 'E_MOTORCYCLE',
        vehicleClass: 'MOTORCYCLE',
        label: 'Deleted',
        batteryCapacityKwh: 3,
        batteryPct: 30,
        deletedAt: new Date(),
      },
    });
    const deleted = await request(app)
      .post('/api/charging/advance-bookings')
      .set('Authorization', student1Token)
      .send({ privateEvId: delEvId, hubId: 'dorm', slotStart: future, targetPct: 90 });
    expect(deleted.status).toBe(404);

    const other = await request(app)
      .post('/api/charging/advance-bookings')
      .set('Authorization', student1Token)
      .send({ privateEvId: 'PEV-02', hubId: 'dorm', slotStart: future, targetPct: 90 });
    expect(other.status).toBe(403);
  });

  it('T-20 AC-2 FR-21 returns 409 HAS_ACTIVE_BOOKING when EV already has a live request (QUEUED, SCHEDULED, or CHARGING)', async () => {
    const future = atOffset(new Date(), min(180)).toISOString();

    // PEV-03 already has CR-M-004 (SCHEDULED) in fixture
    const scheduledRes = await request(app)
      .post('/api/charging/advance-bookings')
      .set('Authorization', student1Token)
      .send({ privateEvId: 'PEV-03', hubId: 'dorm', slotStart: future, targetPct: 90 });
    expect(scheduledRes.status).toBe(409);
    expect(scheduledRes.body.error?.code).toBe('HAS_ACTIVE_BOOKING');

    // PEV-01 already has CR-C-001 (CHARGING) in fixture
    const chargingRes = await request(app)
      .post('/api/charging/advance-bookings')
      .set('Authorization', student1Token)
      .send({ privateEvId: 'PEV-01', hubId: 'dorm', slotStart: future, targetPct: 90 });
    expect(chargingRes.status).toBe(409);
    expect(chargingRes.body.error?.code).toBe('HAS_ACTIVE_BOOKING');

    // Fresh EV with a QUEUED request
    const queuedEvId = uid('PEV');
    await db.privateEv.create({
      data: {
        id: queuedEvId,
        ownerId: 'student1',
        type: 'E_MOTORCYCLE',
        vehicleClass: 'MOTORCYCLE',
        label: 'Queued EV',
        batteryCapacityKwh: 4,
        batteryPct: 30,
      },
    });
    await db.chargingRequest.create({
      data: {
        id: uid('CR'),
        requestedById: 'student1',
        ownerId: 'student1',
        vehicleKind: 'PRIVATE',
        privateEvId: queuedEvId,
        vehicleClass: 'MOTORCYCLE',
        hubId: 'dorm',
        mode: 'QUEUE',
        status: 'QUEUED',
        targetPct: 90,
        startPct: 30,
        currentPct: 30,
        desiredTime: new Date(),
      },
    });
    const queuedRes = await request(app)
      .post('/api/charging/advance-bookings')
      .set('Authorization', student1Token)
      .send({ privateEvId: queuedEvId, hubId: 'dorm', slotStart: future, targetPct: 90 });
    expect(queuedRes.status).toBe(409);
    expect(queuedRes.body.error?.code).toBe('HAS_ACTIVE_BOOKING');
  });

  it('T-20 AC-2 FR-21 returns 409 NO_CAPACITY with alternatives when no point is free', async () => {
    const base = new Date();
    const blockerEvId = uid('PEV');
    const requesterEvId = uid('PEV');
    await db.privateEv.createMany({
      data: [
        {
          id: blockerEvId,
          ownerId: 'student2',
          type: 'E_MOTORCYCLE',
          vehicleClass: 'MOTORCYCLE',
          label: 'Blocker',
          batteryCapacityKwh: 4,
          batteryPct: 40,
        },
        {
          id: requesterEvId,
          ownerId: 'student1',
          type: 'E_MOTORCYCLE',
          vehicleClass: 'MOTORCYCLE',
          label: 'Requester',
          batteryCapacityKwh: 4,
          batteryPct: 50,
        },
      ],
    });

    await db.chargingRequest.create({
      data: {
        id: uid('CR'),
        requestedById: 'student2',
        ownerId: 'student2',
        vehicleKind: 'PRIVATE',
        privateEvId: blockerEvId,
        vehicleClass: 'MOTORCYCLE',
        hubId: 'dorm',
        mode: 'ADVANCE',
        status: 'SCHEDULED',
        targetPct: 100,
        startPct: 40,
        currentPct: 40,
        desiredTime: atOffset(base, min(60)),
        chargingPointId: 'DOR-CP-M-01',
        slotStart: atOffset(base, min(60)),
        slotEnd: atOffset(base, min(120)),
      },
    });

    const res = await request(app)
      .post('/api/charging/advance-bookings')
      .set('Authorization', student1Token)
      .send({
        privateEvId: requesterEvId,
        hubId: 'dorm',
        slotStart: atOffset(base, min(90)).toISOString(),
        targetPct: 80,
      });

    expect(res.status).toBe(409);
    expect(res.body.error?.code).toBe('NO_CAPACITY');
    expect(res.body.error?.nextActions?.length).toBeGreaterThan(0);
    const alts = res.body.error?.alternatives as Alternative[];
    expect(Array.isArray(alts)).toBe(true);
    expect(alts.length).toBeGreaterThan(0);
    expect(alts[0]?.type).toBe('time');
    expect(alts[0]?.start).toBe(atOffset(base, min(120)).toISOString());
    expect(alts.some((a) => a.type === 'hub')).toBe(true);
  });
});

// ============================================================================
// AC-3: BR-10 concurrent last-point race
// ============================================================================

describe('T-20 AC-3 BR-10 concurrent advance bookings', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('T-20 AC-3 BR-10 two students booking the last free point for overlapping windows -> 1 wins (201), 1 gets 409 NO_CAPACITY with alternatives', async () => {
    const ev1 = uid('PEV');
    const ev2 = uid('PEV');
    await db.privateEv.createMany({
      data: [
        {
          id: ev1,
          ownerId: 'student1',
          type: 'E_MOTORCYCLE',
          vehicleClass: 'MOTORCYCLE',
          label: 'Race EV 1',
          batteryCapacityKwh: 4,
          batteryPct: 40,
        },
        {
          id: ev2,
          ownerId: 'student2',
          type: 'E_MOTORCYCLE',
          vehicleClass: 'MOTORCYCLE',
          label: 'Race EV 2',
          batteryCapacityKwh: 4,
          batteryPct: 40,
        },
      ],
    });

    const base = new Date();
    const [r1, r2] = await Promise.all([
      request(app)
        .post('/api/charging/advance-bookings')
        .set('Authorization', student1Token)
        .send({
          privateEvId: ev1,
          hubId: 'dorm',
          slotStart: atOffset(base, min(60)).toISOString(),
          targetPct: 90,
        }),
      request(app)
        .post('/api/charging/advance-bookings')
        .set('Authorization', student2Token)
        .send({
          privateEvId: ev2,
          hubId: 'dorm',
          slotStart: atOffset(base, min(75)).toISOString(),
          targetPct: 90,
        }),
    ]);

    const statuses = [r1.status, r2.status].sort((a, b) => a - b);
    expect(statuses).toEqual([201, 409]);

    const loser = r1.status === 409 ? r1 : r2;
    expect(loser.body.error?.code).toBe('NO_CAPACITY');
    expect(Array.isArray(loser.body.error?.alternatives)).toBe(true);
    expect(loser.body.error.alternatives.length).toBeGreaterThan(0);

    const allReqs = await db.chargingRequest.findMany({
      where: { hubId: 'dorm', chargingPointId: 'DOR-CP-M-01' },
    });
    expect(allReqs.length).toBe(1);
    assertNoPointOverlaps(allReqs);
  });

  it('T-20 AC-3 BR-10 6 concurrent bookings for the last CAR point -> exactly 1 winner and 0 overlaps', async () => {
    const evIds: string[] = [];
    for (let i = 0; i < 6; i++) {
      const id = uid('PEV-RACE');
      evIds.push(id);
      await db.privateEv.create({
        data: {
          id,
          ownerId: i % 2 === 0 ? 'student1' : 'student2',
          type: 'CAR',
          vehicleClass: 'CAR',
          label: `Car ${i}`,
          batteryCapacityKwh: 60,
          batteryPct: 50,
        },
      });
    }

    const base = new Date();
    const results = await Promise.all(
      evIds.map((evId, i) =>
        request(app)
          .post('/api/charging/advance-bookings')
          .set('Authorization', i % 2 === 0 ? student1Token : student2Token)
          .send({
            privateEvId: evId,
            hubId: 'campus-a',
            slotStart: atOffset(base, min(60 + i * 5)).toISOString(),
            targetPct: 80,
          }),
      ),
    );

    const winners = results.filter((r) => r.status === 201);
    const losers = results.filter((r) => r.status === 409);
    expect(winners.length).toBe(1);
    expect(losers.length).toBe(5);
    for (const l of losers) {
      expect(l.body.error?.code).toBe('NO_CAPACITY');
    }

    const allRows = await db.chargingRequest.findMany();
    assertNoPointOverlaps(allRows);
  });
});

// ============================================================================
// AC-4: NFR-08 idempotency
// ============================================================================

describe('T-20 AC-4 NFR-08 idempotency', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('T-20 AC-4 NFR-08 same Idempotency-Key twice returns the same 201 booking and creates one row', async () => {
    const evId = uid('PEV');
    await db.privateEv.create({
      data: {
        id: evId,
        ownerId: 'student1',
        type: 'E_MOTORCYCLE',
        vehicleClass: 'MOTORCYCLE',
        label: 'Idem Moto',
        batteryCapacityKwh: 4,
        batteryPct: 40,
      },
    });

    const key = randomUUID();
    const slotStart = atOffset(new Date(), min(60)).toISOString();

    const first = await request(app)
      .post('/api/charging/advance-bookings')
      .set('Authorization', student1Token)
      .set('Idempotency-Key', key)
      .send({ privateEvId: evId, hubId: 'dorm', slotStart, targetPct: 90 });

    expect(first.status).toBe(201);

    const second = await request(app)
      .post('/api/charging/advance-bookings')
      .set('Authorization', student1Token)
      .set('Idempotency-Key', key)
      .send({ privateEvId: evId, hubId: 'dorm', slotStart, targetPct: 90 });

    expect(second.status).toBe(201);
    expect(second.body.id).toBe(first.body.id);
    expect(second.body.chargingPointId).toBe(first.body.chargingPointId);

    const count = await db.chargingRequest.count({ where: { privateEvId: evId } });
    expect(count).toBe(1);
  });

  it('T-20 AC-4 NFR-08 failed booking with Idempotency-Key is not cached; reusing key on another endpoint returns 400', async () => {
    const evId = uid('PEV');
    await db.privateEv.create({
      data: {
        id: evId,
        ownerId: 'student1',
        type: 'CAR',
        vehicleClass: 'CAR',
        label: 'Idem Car',
        batteryCapacityKwh: 60,
        batteryPct: 40,
      },
    });

    const key = randomUUID();
    const slotStart = atOffset(new Date(), min(60)).toISOString();

    // campus-b has only FAULTY CAR point -> 409 NO_CAPACITY
    const failRes = await request(app)
      .post('/api/charging/advance-bookings')
      .set('Authorization', student1Token)
      .set('Idempotency-Key', key)
      .send({ privateEvId: evId, hubId: 'campus-b', slotStart, targetPct: 80 });
    expect(failRes.status).toBe(409);

    // Same key now at dorm succeeds -> was NOT cached as 409
    const okRes = await request(app)
      .post('/api/charging/advance-bookings')
      .set('Authorization', student1Token)
      .set('Idempotency-Key', key)
      .send({ privateEvId: evId, hubId: 'dorm', slotStart, targetPct: 80 });
    expect(okRes.status).toBe(201);

    // Reusing key on another endpoint (vehicle-reservations) -> 400
    const reuseRes = await request(app)
      .post('/api/vehicle-reservations')
      .set('Authorization', student1Token)
      .set('Idempotency-Key', key)
      .send({ vehicleId: 'RV-M-001' });
    expect(reuseRes.status).toBe(400);
  });
});

// ============================================================================
// AC-5: BR-06 scheduler interaction with booked slots
// ============================================================================

describe('T-20 AC-5 BR-06 scheduler interaction with booked slots', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('T-20 AC-5 BR-06 runScheduler skips QUEUED request that overruns booked slot, starts short one that fits, and starts booked slot at slotStart', async () => {
    const base = new Date();
    const bookedEvId = uid('PEV-BOOK');
    const longQueuedEvId = uid('PEV-LONG');
    const shortQueuedEvId = uid('PEV-SHORT');

    await db.privateEv.createMany({
      data: [
        {
          id: bookedEvId,
          ownerId: 'student1',
          type: 'E_MOTORCYCLE',
          vehicleClass: 'MOTORCYCLE',
          label: 'Booked EV',
          batteryCapacityKwh: 4,
          batteryPct: 50,
        },
        {
          id: longQueuedEvId,
          ownerId: 'student2',
          type: 'E_MOTORCYCLE',
          vehicleClass: 'MOTORCYCLE',
          label: 'Long Queue EV',
          batteryCapacityKwh: 4,
          batteryPct: 40, // 40 -> 90 = 50 min at 1%/min
        },
        {
          id: shortQueuedEvId,
          ownerId: 'student2',
          type: 'E_MOTORCYCLE',
          vehicleClass: 'MOTORCYCLE',
          label: 'Short Queue EV',
          batteryCapacityKwh: 4,
          batteryPct: 85, // 85 -> 95 = 10 min at 1%/min
        },
      ],
    });

    const slotStart = atOffset(base, min(20));
    const bookRes = await request(app)
      .post('/api/charging/advance-bookings')
      .set('Authorization', student1Token)
      .send({
        privateEvId: bookedEvId,
        hubId: 'dorm',
        slotStart: slotStart.toISOString(),
        targetPct: 80,
      });
    expect(bookRes.status).toBe(201);
    const bookedId = bookRes.body.id as string;

    // Submit long queued request (50 min > 20 min gap before slotStart)
    const longRes = await request(app)
      .post('/api/charging/requests')
      .set('Authorization', student2Token)
      .send({
        vehicleKind: 'PRIVATE',
        privateEvId: longQueuedEvId,
        hubId: 'dorm',
        targetPct: 90,
      });
    expect(longRes.status).toBe(201);
    const longId = longRes.body.id as string;

    await runScheduler('dorm', base);

    // Long QUEUED request must NOT have started (would overrun slotStart)
    const longAfter1 = await db.chargingRequest.findUnique({ where: { id: longId } });
    const bookedAfter1 = await db.chargingRequest.findUnique({ where: { id: bookedId } });
    const pointAfter1 = await db.chargingPoint.findUnique({ where: { id: 'DOR-CP-M-01' } });
    expect(longAfter1?.status).toBe('QUEUED');
    expect(bookedAfter1?.status).toBe('SCHEDULED');
    expect(pointAfter1?.status).toBe('AVAILABLE');

    // Now add a short 10-min QUEUED request; it fits in [base, base+20m) so it CAN start
    const shortId = uid('CR-SHORT');
    await db.chargingRequest.create({
      data: {
        id: shortId,
        requestedById: 'student2',
        ownerId: 'student2',
        vehicleKind: 'PRIVATE',
        privateEvId: shortQueuedEvId,
        vehicleClass: 'MOTORCYCLE',
        hubId: 'dorm',
        mode: 'QUEUE',
        status: 'QUEUED',
        targetPct: 95,
        startPct: 85,
        currentPct: 85,
        desiredTime: base,
      },
    });

    await runScheduler('dorm', base);
    const shortAfter2 = await db.chargingRequest.findUnique({ where: { id: shortId } });
    expect(shortAfter2?.status).toBe('CHARGING');
    expect(shortAfter2?.slotEnd?.getTime()).toBeLessThanOrEqual(slotStart.getTime());

    // Complete short session before slotStart so point is AVAILABLE again, then call runScheduler at slotStart
    await db.chargingRequest.update({
      where: { id: shortId },
      data: { status: 'COMPLETED', endedAt: atOffset(base, min(10)), endReason: 'TARGET_REACHED', finalPct: 95 },
    });
    await db.chargingPoint.update({
      where: { id: 'DOR-CP-M-01' },
      data: { status: 'AVAILABLE' },
    });

    await runScheduler('dorm', slotStart);

    const bookedAtStart = await db.chargingRequest.findUnique({ where: { id: bookedId } });
    const pointAtStart = await db.chargingPoint.findUnique({ where: { id: 'DOR-CP-M-01' } });
    const longStillQueued = await db.chargingRequest.findUnique({ where: { id: longId } });
    expect(bookedAtStart?.status).toBe('CHARGING');
    expect(bookedAtStart?.chargingPointId).toBe('DOR-CP-M-01');
    expect(pointAtStart?.status).toBe('CHARGING');
    expect(longStillQueued?.status).toBe('QUEUED');
  });
});

// ============================================================================
// AC-6 & AC-7: FR-51 Fleet dispatch (single & allLowBattery)
// ============================================================================

describe('T-20 AC-6 & AC-7 FR-51 fleet dispatch', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('T-20 AC-6 FR-51 single dispatch succeeds at batteryPct = MIN_RENTAL_BATTERY_PCT - 1 (19%) for LOW_BATTERY and AVAILABLE, with ownerId=null, default target 100, audit row, and 0 notifications', async () => {
    // Fixture RV-M-003 at metro is LOW_BATTERY with batteryPct 19
    const res1 = await request(app)
      .post('/api/ops/charging/dispatch')
      .set('Authorization', operatorToken)
      .send({ rentalVehicleId: 'RV-M-003', hubId: 'metro' });

    expect(res1.status).toBe(201);
    expect(res1.body.created).toHaveLength(1);
    const created1 = res1.body.created[0] as ChargingRequestView;
    expect(created1.status).toBe('QUEUED');
    expect(created1.mode).toBe('QUEUE');
    expect(created1.vehicleKind).toBe('RENTAL');
    expect(created1.rentalVehicleId).toBe('RV-M-003');
    expect(created1.vehicleClass).toBe('MOTORCYCLE');
    expect(created1.hubId).toBe('metro');
    expect(created1.targetPct).toBe(100);
    expect(created1.startPct).toBe(config.MIN_RENTAL_BATTERY_PCT - 1);

    const dbReq1 = await db.chargingRequest.findUnique({ where: { id: created1.id } });
    expect(dbReq1?.ownerId).toBeNull();
    expect(dbReq1?.requestedById).toBe('operator1');

    const audits1 = await db.auditLog.findMany({
      where: { action: 'CHARGING_DISPATCHED', entityType: 'charging_request' },
    });
    expect(audits1).toHaveLength(1);
    expect(audits1[0]?.actorId).toBe('operator1');
    expect(audits1[0]?.entityIds).toContain(created1.id);
    expect(audits1[0]?.entityIds).toContain('RV-M-003');

    expect(await db.notification.count()).toBe(0);

    // Also eligible when status is AVAILABLE and batteryPct = MIN - 1 with custom targetPct
    const rvId = uid('RV');
    const spId = uid('SP');
    await db.parkingSpace.create({
      data: { id: spId, hubId: 'dorm', vehicleClass: 'MOTORCYCLE', pool: 'FLEET', status: 'OCCUPIED' },
    });
    await db.rentalVehicle.create({
      data: {
        id: rvId,
        hubId: 'dorm',
        type: 'E_BICYCLE',
        vehicleClass: 'MOTORCYCLE',
        status: 'AVAILABLE',
        batteryPct: config.MIN_RENTAL_BATTERY_PCT - 1,
        parkingSpaceId: spId,
      },
    });

    const res2 = await request(app)
      .post('/api/ops/charging/dispatch')
      .set('Authorization', operatorToken)
      .send({ rentalVehicleId: rvId, hubId: 'dorm', targetPct: 85 });

    expect(res2.status).toBe(201);
    expect(res2.body.created).toHaveLength(1);
    expect(res2.body.created[0].targetPct).toBe(85);
  });

  it('T-20 AC-6 FR-51 single dispatch rejects wrong Hub (400), invalid targetPct (400), unknown hub/vehicle (400/404), battery >= MIN (409), reserved (409), wrong status (409), live request (409)', async () => {
    // Wrong Hub -> 400 details.field = hubId (RV-M-003 is at metro, not dorm)
    const wrongHub = await request(app)
      .post('/api/ops/charging/dispatch')
      .set('Authorization', operatorToken)
      .send({ rentalVehicleId: 'RV-M-003', hubId: 'dorm' });
    expect(wrongHub.status).toBe(400);
    expect(wrongHub.body.error?.details?.field).toBe('hubId');

    // Unknown hubId -> 400
    const unknownHub = await request(app)
      .post('/api/ops/charging/dispatch')
      .set('Authorization', operatorToken)
      .send({ rentalVehicleId: 'RV-M-003', hubId: 'no-such-hub' });
    expect(unknownHub.status).toBe(400);

    // Unknown rentalVehicleId -> 404
    const unknownRv = await request(app)
      .post('/api/ops/charging/dispatch')
      .set('Authorization', operatorToken)
      .send({ rentalVehicleId: 'RV-MISSING', hubId: 'metro' });
    expect(unknownRv.status).toBe(404);

    // targetPct <= batteryPct (19) -> 400
    const lowTarget = await request(app)
      .post('/api/ops/charging/dispatch')
      .set('Authorization', operatorToken)
      .send({ rentalVehicleId: 'RV-M-003', hubId: 'metro', targetPct: 19 });
    expect(lowTarget.status).toBe(400);

    // Boundary: batteryPct === MIN_RENTAL_BATTERY_PCT (20, fixture RV-M-002) -> 409 NOT_ELIGIBLE
    const boundary20 = await request(app)
      .post('/api/ops/charging/dispatch')
      .set('Authorization', operatorToken)
      .send({ rentalVehicleId: 'RV-M-002', hubId: 'metro' });
    expect(boundary20.status).toBe(409);
    expect(boundary20.body.error?.code).toBe('NOT_ELIGIBLE');

    // Reserved vehicle (has CONFIRMED vehicle_reservation even if battery < 20) -> 409 NOT_ELIGIBLE
    const resRvId = uid('RV-RES');
    const resSpId = uid('SP-RES');
    await db.parkingSpace.create({
      data: { id: resSpId, hubId: 'dorm', vehicleClass: 'MOTORCYCLE', pool: 'FLEET', status: 'OCCUPIED' },
    });
    await db.rentalVehicle.create({
      data: {
        id: resRvId,
        hubId: 'dorm',
        type: 'E_MOTORCYCLE',
        vehicleClass: 'MOTORCYCLE',
        status: 'AVAILABLE',
        batteryPct: 12,
        parkingSpaceId: resSpId,
      },
    });
    await db.vehicleReservation.create({
      data: {
        id: uid('VR'),
        userId: 'student1',
        rentalVehicleId: resRvId,
        hubId: 'dorm',
        status: 'CONFIRMED',
        expiresAt: atOffset(new Date(), min(15)),
      },
    });
    const reservedRes = await request(app)
      .post('/api/ops/charging/dispatch')
      .set('Authorization', operatorToken)
      .send({ rentalVehicleId: resRvId, hubId: 'dorm' });
    expect(reservedRes.status).toBe(409);
    expect(reservedRes.body.error?.code).toBe('NOT_ELIGIBLE');

    // Wrong status (FAULTY with battery 10) -> 409 NOT_ELIGIBLE
    const faultyRvId = uid('RV-FLT');
    const faultySpId = uid('SP-FLT');
    await db.parkingSpace.create({
      data: { id: faultySpId, hubId: 'dorm', vehicleClass: 'MOTORCYCLE', pool: 'FLEET', status: 'OCCUPIED' },
    });
    await db.rentalVehicle.create({
      data: {
        id: faultyRvId,
        hubId: 'dorm',
        type: 'E_MOTORCYCLE',
        vehicleClass: 'MOTORCYCLE',
        status: 'FAULTY',
        batteryPct: 10,
        parkingSpaceId: faultySpId,
      },
    });
    const faultyRes = await request(app)
      .post('/api/ops/charging/dispatch')
      .set('Authorization', operatorToken)
      .send({ rentalVehicleId: faultyRvId, hubId: 'dorm' });
    expect(faultyRes.status).toBe(409);
    expect(faultyRes.body.error?.code).toBe('NOT_ELIGIBLE');

    // Live charging request -> 409 HAS_ACTIVE_BOOKING
    const firstOk = await request(app)
      .post('/api/ops/charging/dispatch')
      .set('Authorization', operatorToken)
      .send({ rentalVehicleId: 'RV-M-003', hubId: 'metro' });
    expect(firstOk.status).toBe(201);

    const dupDispatch = await request(app)
      .post('/api/ops/charging/dispatch')
      .set('Authorization', operatorToken)
      .send({ rentalVehicleId: 'RV-M-003', hubId: 'metro' });
    expect(dupDispatch.status).toBe(409);
    expect(dupDispatch.body.error?.code).toBe('HAS_ACTIVE_BOOKING');
  });

  it('T-20 AC-7 FR-51 dispatch allLowBattery creates requests only for eligible vehicles at the Hub and skips ineligible ones; empty returns []', async () => {
    // At dorm: currently RV-D-001 (90%) and RV-D-002 (30%), so nothing eligible yet -> []
    const emptyRes = await request(app)
      .post('/api/ops/charging/dispatch')
      .set('Authorization', operatorToken)
      .send({ hubId: 'dorm', allLowBattery: true });
    expect(emptyRes.status).toBe(201);
    expect(emptyRes.body).toEqual({ created: [] });
    expect(await db.auditLog.count({ where: { action: 'CHARGING_DISPATCHED' } })).toBe(0);

    // Add a mix of vehicles at dorm:
    // 1. Eligible LOW_BATTERY 15%
    // 2. Eligible AVAILABLE 19%
    // 3. Ineligible battery 20%
    // 4. Ineligible reserved (12%, CONFIRMED reservation)
    // 5. Ineligible FAULTY (10%)
    // 6. Ineligible already has QUEUED request (11%)
    const ids = {
      elig1: uid('RV-E1'),
      elig2: uid('RV-E2'),
      bat20: uid('RV-B20'),
      reserved: uid('RV-RES'),
      faulty: uid('RV-FLT'),
      live: uid('RV-LIVE'),
    };
    for (const [k, rvId] of Object.entries(ids)) {
      const spId = uid(`SP-${k}`);
      await db.parkingSpace.create({
        data: { id: spId, hubId: 'dorm', vehicleClass: 'MOTORCYCLE', pool: 'FLEET', status: 'OCCUPIED' },
      });
      await db.rentalVehicle.create({
        data: {
          id: rvId,
          hubId: 'dorm',
          type: 'E_MOTORCYCLE',
          vehicleClass: 'MOTORCYCLE',
          status: k === 'faulty' ? 'FAULTY' : k === 'elig1' ? 'LOW_BATTERY' : 'AVAILABLE',
          batteryPct:
            k === 'elig1'
              ? 15
              : k === 'elig2'
                ? config.MIN_RENTAL_BATTERY_PCT - 1
                : k === 'bat20'
                  ? config.MIN_RENTAL_BATTERY_PCT
                  : k === 'reserved'
                    ? 12
                    : k === 'faulty'
                      ? 10
                      : 11,
          parkingSpaceId: spId,
        },
      });
    }

    await db.vehicleReservation.create({
      data: {
        id: uid('VR'),
        userId: 'student1',
        rentalVehicleId: ids.reserved,
        hubId: 'dorm',
        status: 'CONFIRMED',
        expiresAt: atOffset(new Date(), min(15)),
      },
    });

    await db.chargingRequest.create({
      data: {
        id: uid('CR'),
        requestedById: 'operator1',
        ownerId: null,
        vehicleKind: 'RENTAL',
        rentalVehicleId: ids.live,
        vehicleClass: 'MOTORCYCLE',
        hubId: 'dorm',
        mode: 'QUEUE',
        status: 'QUEUED',
        targetPct: 100,
        startPct: 11,
        currentPct: 11,
        desiredTime: new Date(),
      },
    });

    const bulkRes = await request(app)
      .post('/api/ops/charging/dispatch')
      .set('Authorization', operatorToken)
      .send({ hubId: 'dorm', allLowBattery: true });

    expect(bulkRes.status).toBe(201);
    const created = bulkRes.body.created as ChargingRequestView[];
    const createdRvIds = created.map((c) => c.rentalVehicleId).sort();
    expect(createdRvIds).toEqual([ids.elig1, ids.elig2].sort());

    for (const c of created) {
      expect(c.status).toBe('QUEUED');
      expect(c.targetPct).toBe(100);
      expect(c.hubId).toBe('dorm');
      const row = await db.chargingRequest.findUnique({ where: { id: c.id } });
      expect(row?.ownerId).toBeNull();
    }

    const audits = await db.auditLog.findMany({
      where: { action: 'CHARGING_DISPATCHED' },
    });
    expect(audits).toHaveLength(2);
    expect(await db.notification.count()).toBe(0);
  });
});

// ============================================================================
// AC-8 & AC-9: FR-52 / FR-63 / FR-62 Manual override
// ============================================================================

describe('T-20 AC-8 & AC-9 FR-52 manual override', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('T-20 AC-8 FR-52 override validates reason 9 vs 10 trimmed chars and rejects bad actions', async () => {
    const nineChars = 'x'.repeat(config.OVERRIDE_REASON_MIN_CHARS - 1);
    const paddedNine = `   ${nineChars}   `;
    const tenChars = 'x'.repeat(config.OVERRIDE_REASON_MIN_CHARS);

    const shortRes = await request(app)
      .post('/api/ops/charging/override')
      .set('Authorization', operatorToken)
      .send({ action: 'PROMOTE', requestId: 'CR-M-002', reason: nineChars });
    expect(shortRes.status).toBe(400);
    expect(shortRes.body.error?.details?.field).toBe('reason');

    const paddedShortRes = await request(app)
      .post('/api/ops/charging/override')
      .set('Authorization', operatorToken)
      .send({ action: 'PROMOTE', requestId: 'CR-M-002', reason: paddedNine });
    expect(paddedShortRes.status).toBe(400);
    expect(paddedShortRes.body.error?.details?.field).toBe('reason');

    const badAction = await request(app)
      .post('/api/ops/charging/override')
      .set('Authorization', operatorToken)
      .send({ action: 'INVALID', requestId: 'CR-M-002', reason: tenChars });
    expect(badAction.status).toBe(400);

    // No audit row written on 400
    expect(await db.auditLog.count({ where: { action: 'CHARGING_OVERRIDE' } })).toBe(0);

    const okRes = await request(app)
      .post('/api/ops/charging/override')
      .set('Authorization', operatorToken)
      .send({ action: 'PROMOTE', requestId: 'CR-M-002', reason: tenChars });
    expect(okRes.status).toBe(200);
  });

  it('T-20 AC-8 FR-52 override rejects CHARGING/SCHEDULED with 409 SESSION_PROTECTED, COMPLETED/CANCELLED with 409, and missing id with 404', async () => {
    const reason = 'Operator safety check';

    // CHARGING target (CR-M-001) -> 409 SESSION_PROTECTED
    const chargingRes = await request(app)
      .post('/api/ops/charging/override')
      .set('Authorization', operatorToken)
      .send({ action: 'CANCEL', requestId: 'CR-M-001', reason });
    expect(chargingRes.status).toBe(409);
    expect(chargingRes.body.error?.code).toBe('SESSION_PROTECTED');

    // SCHEDULED target (CR-M-003) -> 409 SESSION_PROTECTED
    const scheduledRes = await request(app)
      .post('/api/ops/charging/override')
      .set('Authorization', operatorToken)
      .send({ action: 'PROMOTE', requestId: 'CR-M-003', reason });
    expect(scheduledRes.status).toBe(409);
    expect(scheduledRes.body.error?.code).toBe('SESSION_PROTECTED');

    // COMPLETED target -> 409 INVALID_STATE_TRANSITION
    const completedId = uid('CR-DONE');
    const evDone = uid('PEV-DONE');
    await db.privateEv.create({
      data: {
        id: evDone,
        ownerId: 'student1',
        type: 'E_MOTORCYCLE',
        vehicleClass: 'MOTORCYCLE',
        label: 'Done EV',
        batteryCapacityKwh: 4,
        batteryPct: 90,
      },
    });
    await db.chargingRequest.create({
      data: {
        id: completedId,
        requestedById: 'student1',
        ownerId: 'student1',
        vehicleKind: 'PRIVATE',
        privateEvId: evDone,
        vehicleClass: 'MOTORCYCLE',
        hubId: 'dorm',
        mode: 'QUEUE',
        status: 'COMPLETED',
        targetPct: 90,
        startPct: 50,
        currentPct: 90,
        finalPct: 90,
        endReason: 'TARGET_REACHED',
      },
    });
    const doneRes = await request(app)
      .post('/api/ops/charging/override')
      .set('Authorization', operatorToken)
      .send({ action: 'DEFER', requestId: completedId, reason });
    expect(doneRes.status).toBe(409);
    expect(doneRes.body.error?.code).toBe('INVALID_STATE_TRANSITION');

    // CANCELLED target -> 409 INVALID_STATE_TRANSITION
    const cancelledId = uid('CR-CANC');
    await db.chargingRequest.create({
      data: {
        id: cancelledId,
        requestedById: 'student1',
        ownerId: 'student1',
        vehicleKind: 'PRIVATE',
        privateEvId: evDone,
        vehicleClass: 'MOTORCYCLE',
        hubId: 'dorm',
        mode: 'QUEUE',
        status: 'CANCELLED',
        targetPct: 90,
        startPct: 50,
        currentPct: 50,
      },
    });
    const cancRes = await request(app)
      .post('/api/ops/charging/override')
      .set('Authorization', operatorToken)
      .send({ action: 'CANCEL', requestId: cancelledId, reason });
    expect(cancRes.status).toBe(409);
    expect(cancRes.body.error?.code).toBe('INVALID_STATE_TRANSITION');

    // Missing id -> 404
    const missingRes = await request(app)
      .post('/api/ops/charging/override')
      .set('Authorization', operatorToken)
      .send({ action: 'PROMOTE', requestId: 'NO-SUCH-CR', reason });
    expect(missingRes.status).toBe(404);
  });

  it('T-20 AC-8 & AC-9 FR-52 PROMOTE and DEFER change manualAdjust by MANUAL_ADJUST_STEP, reorder queue, audit with before/after, and notify only on DEFER (skipped when ownerId is null)', async () => {
    const base = new Date();
    const evHigh = uid('PEV-HI');
    const evLow = uid('PEV-LO');
    await db.privateEv.createMany({
      data: [
        {
          id: evHigh,
          ownerId: 'student1',
          type: 'E_MOTORCYCLE',
          vehicleClass: 'MOTORCYCLE',
          label: 'High Battery Moto',
          batteryCapacityKwh: 4,
          batteryPct: 80, // lower priority naturally
        },
        {
          id: evLow,
          ownerId: 'student2',
          type: 'E_MOTORCYCLE',
          vehicleClass: 'MOTORCYCLE',
          label: 'Low Battery Moto',
          batteryCapacityKwh: 4,
          batteryPct: 20, // higher priority naturally
        },
      ],
    });

    const reqHighId = uid('CR-HI');
    const reqLowId = uid('CR-LO');
    await db.chargingRequest.createMany({
      data: [
        {
          id: reqHighId,
          requestedById: 'student1',
          ownerId: 'student1',
          vehicleKind: 'PRIVATE',
          privateEvId: evHigh,
          vehicleClass: 'MOTORCYCLE',
          hubId: 'dorm',
          mode: 'QUEUE',
          status: 'QUEUED',
          targetPct: 100,
          startPct: 80,
          currentPct: 80,
          desiredTime: atOffset(base, -min(5)),
        },
        {
          id: reqLowId,
          requestedById: 'student2',
          ownerId: 'student2',
          vehicleKind: 'PRIVATE',
          privateEvId: evLow,
          vehicleClass: 'MOTORCYCLE',
          hubId: 'dorm',
          mode: 'QUEUE',
          status: 'QUEUED',
          targetPct: 100,
          startPct: 20,
          currentPct: 20,
          desiredTime: atOffset(base, -min(5)),
        },
      ],
    });

    // PROMOTE reqHighId -> moves ahead of reqLowId, manualAdjust += MANUAL_ADJUST_STEP, 0 notifications
    const promoteRes = await request(app)
      .post('/api/ops/charging/override')
      .set('Authorization', operatorToken)
      .send({ action: 'PROMOTE', requestId: reqHighId, reason: 'Urgent student trip' });
    expect(promoteRes.status).toBe(200);
    const promoEntries = promoteRes.body.entries as ChargingQueueEntry[];
    expect(promoEntries.map((e) => e.request.id)).toEqual([reqHighId, reqLowId]);
    expect(promoEntries[0]?.breakdown.manualAdjust).toBe(config.MANUAL_ADJUST_STEP);

    const dbHigh = await db.chargingRequest.findUnique({ where: { id: reqHighId } });
    expect(dbHigh?.manualAdjust).toBe(config.MANUAL_ADJUST_STEP);
    expect(await db.notification.count()).toBe(0);

    const promoAudit = await db.auditLog.findFirst({
      where: { action: 'CHARGING_OVERRIDE', entityIds: { has: reqHighId } },
    });
    expect(promoAudit).not.toBeNull();
    expect(promoAudit?.reason).toBe('Urgent student trip');
    const promoDetails = promoAudit?.details as Record<string, Record<string, unknown>>;
    expect(promoDetails['action']).toBe('PROMOTE');
    expect(promoDetails['before']?.['manualAdjust']).toBe(0);
    expect(promoDetails['after']?.['manualAdjust']).toBe(config.MANUAL_ADJUST_STEP);
    expect(typeof promoDetails['before']?.['score']).toBe('number');
    expect(typeof promoDetails['after']?.['score']).toBe('number');

    // DEFER reqHighId -> manualAdjust -= MANUAL_ADJUST_STEP (back to 0), moves behind reqLowId, CHARGING_DEFERRED notification to student1
    const deferRes = await request(app)
      .post('/api/ops/charging/override')
      .set('Authorization', operatorToken)
      .send({ action: 'DEFER', requestId: reqHighId, reason: 'Rebalancing queue load' });
    expect(deferRes.status).toBe(200);
    const deferEntries = deferRes.body.entries as ChargingQueueEntry[];
    expect(deferEntries.map((e) => e.request.id)).toEqual([reqLowId, reqHighId]);

    const notifs = await db.notification.findMany({ where: { userId: 'student1' } });
    expect(notifs).toHaveLength(1);
    expect(notifs[0]?.type).toBe('CHARGING_DEFERRED');

    // DEFER fleet request with ownerId = null -> succeeds, writes audit, sends 0 notifications
    const fleetReqId = uid('CR-FLT');
    await db.chargingRequest.create({
      data: {
        id: fleetReqId,
        requestedById: 'operator1',
        ownerId: null,
        vehicleKind: 'RENTAL',
        rentalVehicleId: 'RV-D-002',
        vehicleClass: 'MOTORCYCLE',
        hubId: 'dorm',
        mode: 'QUEUE',
        status: 'QUEUED',
        targetPct: 100,
        startPct: 30,
        currentPct: 30,
        desiredTime: atOffset(base, -min(5)),
      },
    });
    const fleetDefer = await request(app)
      .post('/api/ops/charging/override')
      .set('Authorization', operatorToken)
      .send({ action: 'DEFER', requestId: fleetReqId, reason: 'Fleet priority lowered' });
    expect(fleetDefer.status).toBe(200);
    expect(await db.notification.count()).toBe(1); // still only student1's notification
  });

  it('T-20 AC-8 & AC-9 FR-52 SWAP exchanges scores at now (verified via T-17 score()), writes 2 audit rows, and notifies only the owner whose score went down', async () => {
    const fixedNow = new Date();
    const createdOld = atOffset(fixedNow, -min(30));
    const evA = uid('PEV-A');
    const evB = uid('PEV-B');
    await db.privateEv.createMany({
      data: [
        {
          id: evA,
          ownerId: 'student1',
          type: 'E_MOTORCYCLE',
          vehicleClass: 'MOTORCYCLE',
          label: 'EV A',
          batteryCapacityKwh: 4,
          batteryPct: 20, // higher score
        },
        {
          id: evB,
          ownerId: 'student2',
          type: 'E_MOTORCYCLE',
          vehicleClass: 'MOTORCYCLE',
          label: 'EV B',
          batteryCapacityKwh: 4,
          batteryPct: 70, // lower score
        },
      ],
    });

    const reqAId = uid('CR-A');
    const reqBId = uid('CR-B');
    const neededByA = atOffset(fixedNow, min(60));
    await db.chargingRequest.createMany({
      data: [
        {
          id: reqAId,
          requestedById: 'student1',
          ownerId: 'student1',
          vehicleKind: 'PRIVATE',
          privateEvId: evA,
          vehicleClass: 'MOTORCYCLE',
          hubId: 'dorm',
          mode: 'QUEUE',
          status: 'QUEUED',
          targetPct: 100,
          startPct: 20,
          currentPct: 20,
          desiredTime: createdOld,
          neededBy: neededByA,
          createdAt: createdOld,
        },
        {
          id: reqBId,
          requestedById: 'student2',
          ownerId: 'student2',
          vehicleKind: 'PRIVATE',
          privateEvId: evB,
          vehicleClass: 'MOTORCYCLE',
          hubId: 'dorm',
          mode: 'QUEUE',
          status: 'QUEUED',
          targetPct: 100,
          startPct: 70,
          currentPct: 70,
          desiredTime: createdOld,
          neededBy: null,
          createdAt: createdOld,
        },
      ],
    });

    const weights = await getWeights();
    const pCfg = getPriorityConfig();
    const rowA = (await db.chargingRequest.findUnique({ where: { id: reqAId } }))!;
    const rowB = (await db.chargingRequest.findUnique({ where: { id: reqBId } }))!;
    const sABefore = score(rowA, weights, fixedNow, pCfg);
    const sBBefore = score(rowB, weights, fixedNow, pCfg);
    expect(sABefore).toBeGreaterThan(sBBefore);

    // Call overrideQueue directly with fixedNow so score() exchange at now is exact
    const result = await overrideQueue(
      { id: 'operator1', role: 'OPERATOR' },
      {
        action: 'SWAP',
        requestId: reqAId,
        otherRequestId: reqBId,
        reason: 'Swap priority for departure',
      },
      fixedNow,
    );

    const rowAAfter = (await db.chargingRequest.findUnique({ where: { id: reqAId } }))!;
    const rowBAfter = (await db.chargingRequest.findUnique({ where: { id: reqBId } }))!;
    const sAAfter = score(rowAAfter, weights, fixedNow, pCfg);
    const sBAfter = score(rowBAfter, weights, fixedNow, pCfg);

    expect(sAAfter).toBeCloseTo(sBBefore, 9);
    expect(sBAfter).toBeCloseTo(sABefore, 9);
    expect(result.entries.map((e) => e.request.id)).toEqual([reqBId, reqAId]);

    // Two CHARGING_OVERRIDE audit rows — one per changed request (entityIds: [id], partner in details)
    const audits = await db.auditLog.findMany({
      where: { action: 'CHARGING_OVERRIDE' },
      orderBy: { id: 'asc' },
    });
    expect(audits).toHaveLength(2);
    expect(audits.map((a) => a.entityIds).sort()).toEqual([[reqAId], [reqBId]].sort());
    for (const a of audits) {
      expect(a.reason).toBe('Swap priority for departure');
      const d = a.details as Record<string, unknown>;
      expect(d['action']).toBe('SWAP');
      expect(typeof d['otherRequestId']).toBe('string');
      expect(d['before']).toBeTruthy();
      expect(d['after']).toBeTruthy();
    }

    // Only student1 (owner of reqA whose score went DOWN) receives CHARGING_DEFERRED; student2 gets none
    const notifsS1 = await db.notification.findMany({ where: { userId: 'student1' } });
    const notifsS2 = await db.notification.findMany({ where: { userId: 'student2' } });
    expect(notifsS1).toHaveLength(1);
    expect(notifsS1[0]?.type).toBe('CHARGING_DEFERRED');
    expect(notifsS2).toHaveLength(0);
  });

  it('T-20 AC-8 FR-52 override SWAP via HTTP swaps order and rejects missing/same/cross-Hub/cross-class/non-QUEUED partner with 400', async () => {
    const base = new Date();
    const oldTime = atOffset(base, -min(150)); // saturated waiting=100 so scores don't drift over HTTP ms
    const ev1 = uid('PEV-M1');
    const ev2 = uid('PEV-M2');
    const evCar = uid('PEV-C1');
    const evOtherHub = uid('PEV-OH');
    await db.privateEv.createMany({
      data: [
        { id: ev1, ownerId: 'student1', type: 'E_MOTORCYCLE', vehicleClass: 'MOTORCYCLE', label: 'M1', batteryCapacityKwh: 4, batteryPct: 25 },
        { id: ev2, ownerId: 'student2', type: 'E_MOTORCYCLE', vehicleClass: 'MOTORCYCLE', label: 'M2', batteryCapacityKwh: 4, batteryPct: 75 },
        { id: evCar, ownerId: 'student1', type: 'CAR', vehicleClass: 'CAR', label: 'C1', batteryCapacityKwh: 60, batteryPct: 30 },
        { id: evOtherHub, ownerId: 'student2', type: 'E_MOTORCYCLE', vehicleClass: 'MOTORCYCLE', label: 'OH', batteryCapacityKwh: 4, batteryPct: 30 },
      ],
    });

    const id1 = uid('CR-1');
    const id2 = uid('CR-2');
    const idCar = uid('CR-CAR');
    const idOtherHub = uid('CR-OH');
    await db.chargingRequest.createMany({
      data: [
        { id: id1, requestedById: 'student1', ownerId: 'student1', vehicleKind: 'PRIVATE', privateEvId: ev1, vehicleClass: 'MOTORCYCLE', hubId: 'dorm', mode: 'QUEUE', status: 'QUEUED', targetPct: 100, startPct: 25, currentPct: 25, desiredTime: oldTime, createdAt: oldTime },
        { id: id2, requestedById: 'student2', ownerId: 'student2', vehicleKind: 'PRIVATE', privateEvId: ev2, vehicleClass: 'MOTORCYCLE', hubId: 'dorm', mode: 'QUEUE', status: 'QUEUED', targetPct: 100, startPct: 75, currentPct: 75, desiredTime: oldTime, createdAt: oldTime },
        { id: idCar, requestedById: 'student1', ownerId: 'student1', vehicleKind: 'PRIVATE', privateEvId: evCar, vehicleClass: 'CAR', hubId: 'dorm', mode: 'QUEUE', status: 'QUEUED', targetPct: 100, startPct: 30, currentPct: 30, desiredTime: oldTime, createdAt: oldTime },
        { id: idOtherHub, requestedById: 'student2', ownerId: 'student2', vehicleKind: 'PRIVATE', privateEvId: evOtherHub, vehicleClass: 'MOTORCYCLE', hubId: 'campus-a', mode: 'QUEUE', status: 'QUEUED', targetPct: 100, startPct: 30, currentPct: 30, desiredTime: oldTime, createdAt: oldTime },
      ],
    });

    const reason = 'Valid ten+ char reason';

    // Missing otherRequestId -> 400
    const missingOther = await request(app)
      .post('/api/ops/charging/override')
      .set('Authorization', operatorToken)
      .send({ action: 'SWAP', requestId: id1, reason });
    expect(missingOther.status).toBe(400);

    // Self-swap -> 400
    const selfSwap = await request(app)
      .post('/api/ops/charging/override')
      .set('Authorization', operatorToken)
      .send({ action: 'SWAP', requestId: id1, otherRequestId: id1, reason });
    expect(selfSwap.status).toBe(400);

    // Cross-class -> 400
    const crossClass = await request(app)
      .post('/api/ops/charging/override')
      .set('Authorization', operatorToken)
      .send({ action: 'SWAP', requestId: id1, otherRequestId: idCar, reason });
    expect(crossClass.status).toBe(400);
    expect(crossClass.body.error?.details?.field).toBe('otherRequestId');

    // Cross-Hub -> 400
    const crossHub = await request(app)
      .post('/api/ops/charging/override')
      .set('Authorization', operatorToken)
      .send({ action: 'SWAP', requestId: id1, otherRequestId: idOtherHub, reason });
    expect(crossHub.status).toBe(400);
    expect(crossHub.body.error?.details?.field).toBe('otherRequestId');

    // SWAP with SCHEDULED partner -> 409 SESSION_PROTECTED
    const swapScheduled = await request(app)
      .post('/api/ops/charging/override')
      .set('Authorization', operatorToken)
      .send({ action: 'SWAP', requestId: id1, otherRequestId: 'CR-M-003', reason });
    expect(swapScheduled.status).toBe(409);
    expect(swapScheduled.body.error?.code).toBe('SESSION_PROTECTED');

    // Valid HTTP SWAP
    const okSwap = await request(app)
      .post('/api/ops/charging/override')
      .set('Authorization', operatorToken)
      .send({ action: 'SWAP', requestId: id1, otherRequestId: id2, reason });
    expect(okSwap.status).toBe(200);
    expect((okSwap.body.entries as ChargingQueueEntry[]).map((e) => e.request.id)).toEqual([id2, id1]);
  });

  it('T-20 AC-8 & AC-9 FR-52 CANCEL transitions QUEUED -> CANCELLED, writes audit, and sends CHARGING_CANCELLED (skipped if ownerId is null)', async () => {
    const evId = uid('PEV-CAN');
    await db.privateEv.create({
      data: {
        id: evId,
        ownerId: 'student1',
        type: 'E_MOTORCYCLE',
        vehicleClass: 'MOTORCYCLE',
        label: 'Cancel EV',
        batteryCapacityKwh: 4,
        batteryPct: 40,
      },
    });
    const reqId = uid('CR-CAN');
    await db.chargingRequest.create({
      data: {
        id: reqId,
        requestedById: 'student1',
        ownerId: 'student1',
        vehicleKind: 'PRIVATE',
        privateEvId: evId,
        vehicleClass: 'MOTORCYCLE',
        hubId: 'dorm',
        mode: 'QUEUE',
        status: 'QUEUED',
        targetPct: 90,
        startPct: 40,
        currentPct: 40,
      },
    });

    const cancelRes = await request(app)
      .post('/api/ops/charging/override')
      .set('Authorization', operatorToken)
      .send({ action: 'CANCEL', requestId: reqId, reason: 'Hub maintenance closing' });

    expect(cancelRes.status).toBe(200);
    expect(cancelRes.body.entries).toEqual([]);

    const dbReq = await db.chargingRequest.findUnique({ where: { id: reqId } });
    expect(dbReq?.status).toBe('CANCELLED');

    const auditRow = await db.auditLog.findFirst({
      where: { action: 'CHARGING_OVERRIDE', entityIds: { has: reqId } },
    });
    expect(auditRow).not.toBeNull();
    expect(auditRow?.reason).toBe('Hub maintenance closing');

    const notifs = await db.notification.findMany({ where: { userId: 'student1' } });
    expect(notifs).toHaveLength(1);
    expect(notifs[0]?.type).toBe('CHARGING_CANCELLED');

    // Fleet CANCEL (ownerId = null) -> no notification
    const fleetId = uid('CR-FLTC');
    await db.chargingRequest.create({
      data: {
        id: fleetId,
        requestedById: 'operator1',
        ownerId: null,
        vehicleKind: 'RENTAL',
        rentalVehicleId: 'RV-D-002',
        vehicleClass: 'MOTORCYCLE',
        hubId: 'dorm',
        mode: 'QUEUE',
        status: 'QUEUED',
        targetPct: 100,
        startPct: 30,
        currentPct: 30,
      },
    });
    const fleetCancel = await request(app)
      .post('/api/ops/charging/override')
      .set('Authorization', operatorToken)
      .send({ action: 'CANCEL', requestId: fleetId, reason: 'Vehicle moved offline' });
    expect(fleetCancel.status).toBe(200);
    expect(await db.notification.count()).toBe(1);
  });
});

// ============================================================================
// AC-10: Role enforcement (403 in both directions)
// ============================================================================

describe('T-20 AC-10 role enforcement', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('T-20 AC-10 FR-61 STUDENT token on /ops/charging/dispatch and /override returns 403 and writes SECURITY_DENIED audit row', async () => {
    const dispatchRes = await request(app)
      .post('/api/ops/charging/dispatch')
      .set('Authorization', student1Token)
      .send({ rentalVehicleId: 'RV-M-003', hubId: 'metro' });
    expect(dispatchRes.status).toBe(403);

    const overrideRes = await request(app)
      .post('/api/ops/charging/override')
      .set('Authorization', student1Token)
      .send({ action: 'PROMOTE', requestId: 'CR-M-002', reason: 'Unauthorized attempt' });
    expect(overrideRes.status).toBe(403);

    // Wait a tick for async SECURITY_DENIED audit callback in requireRole
    await new Promise((r) => setTimeout(r, 50));
    const deniedAudits = await db.auditLog.findMany({
      where: { action: 'SECURITY_DENIED', actorId: 'student1' },
    });
    expect(deniedAudits.length).toBe(2);
  });

  it('T-20 AC-10 OPERATOR token on /charging/availability and /advance-bookings returns 403', async () => {
    const future = atOffset(new Date(), min(60)).toISOString();

    const availRes = await request(app)
      .get('/api/charging/availability')
      .set('Authorization', operatorToken)
      .query({ hubId: 'dorm', privateEvId: 'PEV-03', slotStart: future, targetPct: '85' });
    expect(availRes.status).toBe(403);

    const bookRes = await request(app)
      .post('/api/charging/advance-bookings')
      .set('Authorization', operatorToken)
      .send({ privateEvId: 'PEV-03', hubId: 'dorm', slotStart: future, targetPct: 85 });
    expect(bookRes.status).toBe(403);
  });
});
