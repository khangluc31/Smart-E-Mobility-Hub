import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createTestApp, resetDb, loginAs } from './helpers';
import { db } from '../src/core/db';
import { config } from '../src/core/config';
import { events } from '../src/core/events';
import { runScheduler } from '../src/modules/charging/scheduler.service';
import { endSession } from '../src/modules/charging/chargingRequests.service';
import type { ChargingRequestView } from '../src/types/charging';

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

// Verify no two SCHEDULED/CHARGING intervals on the same point overlap.
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
// AC-1: FR-20 Submit Charging Request — Private EV
// ============================================================================

describe('FR-20 AC-1 Submit charging request for Private EV', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('FR-20 AC-1 valid Private EV submit returns 201 QUEUED with EV class, startPct = currentPct = batteryPct, queuePosition and estimates', async () => {
    await db.privateEv.create({
      data: {
        id: 'PEV-S1-CAR',
        ownerId: 'student1',
        type: 'CAR',
        vehicleClass: 'CAR',
        label: 'Student1 Car 2',
        batteryCapacityKwh: 60,
        batteryPct: 35,
      },
    });

    // Submit at metro where CAR point MET-CP-C-01 is currently CHARGING, so request stays QUEUED
    const res = await request(app)
      .post('/api/charging/requests')
      .set('Authorization', student1Token)
      .send({
        vehicleKind: 'PRIVATE',
        privateEvId: 'PEV-S1-CAR',
        hubId: 'metro',
        targetPct: 85,
      });

    expect(res.status).toBe(201);
    const body = res.body as ChargingRequestView;
    expect(body.status).toBe('QUEUED');
    expect(body.mode).toBe('QUEUE');
    expect(body.vehicleKind).toBe('PRIVATE');
    expect(body.privateEvId).toBe('PEV-S1-CAR');
    expect(body.rentalVehicleId).toBeNull();
    expect(body.vehicleClass).toBe('CAR');
    expect(body.hubId).toBe('metro');
    expect(body.startPct).toBe(35);
    expect(body.currentPct).toBe(35);
    expect(body.targetPct).toBe(85);
    expect(body.queuePosition).toBe(1);
    expect(body.estimatedStart).toBeTruthy();
    expect(body.estimatedEnd).toBeTruthy();
    expect(body.serverNow).toBeTruthy();
    expect('requestedById' in body).toBe(false);
    expect('ownerId' in body).toBe(false);
  });

  it('FR-20 AC-1 rejects another student EV with 403, removed or unknown EV with 404, and second live request with 409 HAS_ACTIVE_BOOKING', async () => {
    await db.privateEv.createMany({
      data: [
        {
          id: 'PEV-S2-FREE',
          ownerId: 'student2',
          type: 'E_MOTORCYCLE',
          vehicleClass: 'MOTORCYCLE',
          label: 'Student2 Moto',
          batteryCapacityKwh: 4,
          batteryPct: 40,
        },
        {
          id: 'PEV-S1-DELETED',
          ownerId: 'student1',
          type: 'E_MOTORCYCLE',
          vehicleClass: 'MOTORCYCLE',
          label: 'Deleted Moto',
          batteryCapacityKwh: 4,
          batteryPct: 40,
          deletedAt: new Date(),
        },
      ],
    });

    // Another student's EV -> 403
    const otherEv = await request(app)
      .post('/api/charging/requests')
      .set('Authorization', student1Token)
      .send({
        vehicleKind: 'PRIVATE',
        privateEvId: 'PEV-S2-FREE',
        hubId: 'metro',
        targetPct: 90,
      });
    expect(otherEv.status).toBe(403);
    expect(otherEv.body.error.code).toBe('FORBIDDEN');

    // Soft-deleted EV -> 404
    const deletedEv = await request(app)
      .post('/api/charging/requests')
      .set('Authorization', student1Token)
      .send({
        vehicleKind: 'PRIVATE',
        privateEvId: 'PEV-S1-DELETED',
        hubId: 'metro',
        targetPct: 90,
      });
    expect(deletedEv.status).toBe(404);
    expect(deletedEv.body.error.code).toBe('NOT_FOUND');

    // Unknown EV -> 404
    const unknownEv = await request(app)
      .post('/api/charging/requests')
      .set('Authorization', student1Token)
      .send({
        vehicleKind: 'PRIVATE',
        privateEvId: 'PEV-DOES-NOT-EXIST',
        hubId: 'metro',
        targetPct: 90,
      });
    expect(unknownEv.status).toBe(404);
    expect(unknownEv.body.error.code).toBe('NOT_FOUND');

    // PEV-01 already has CHARGING CR-C-001 in resetDb -> 409 HAS_ACTIVE_BOOKING
    const duplicateActive = await request(app)
      .post('/api/charging/requests')
      .set('Authorization', student1Token)
      .send({
        vehicleKind: 'PRIVATE',
        privateEvId: 'PEV-01',
        hubId: 'metro',
        targetPct: 95,
      });
    expect(duplicateActive.status).toBe(409);
    expect(duplicateActive.body.error.code).toBe('HAS_ACTIVE_BOOKING');
  });

  it('FR-20 AC-1 validates targetPct <= batteryPct, 0, 101, missing fields, unknown hubId, and neededBy < desiredTime with 400', async () => {
    await db.privateEv.create({
      data: {
        id: 'PEV-S1-VAL',
        ownerId: 'student1',
        type: 'E_MOTORCYCLE',
        vehicleClass: 'MOTORCYCLE',
        label: 'Val Moto',
        batteryCapacityKwh: 4,
        batteryPct: 50,
      },
    });

    const now = new Date();
    const desired = atOffset(now, min(30)).toISOString();
    const earlierNeeded = atOffset(now, min(10)).toISOString();

    const invalidBodies = [
      // targetPct == batteryPct
      { vehicleKind: 'PRIVATE', privateEvId: 'PEV-S1-VAL', hubId: 'metro', targetPct: 50 },
      // targetPct < batteryPct
      { vehicleKind: 'PRIVATE', privateEvId: 'PEV-S1-VAL', hubId: 'metro', targetPct: 30 },
      // targetPct == 0
      { vehicleKind: 'PRIVATE', privateEvId: 'PEV-S1-VAL', hubId: 'metro', targetPct: 0 },
      // targetPct == 101
      { vehicleKind: 'PRIVATE', privateEvId: 'PEV-S1-VAL', hubId: 'metro', targetPct: 101 },
      // missing targetPct
      { vehicleKind: 'PRIVATE', privateEvId: 'PEV-S1-VAL', hubId: 'metro' },
      // unknown hubId
      { vehicleKind: 'PRIVATE', privateEvId: 'PEV-S1-VAL', hubId: 'unknown-hub', targetPct: 80 },
      // missing privateEvId
      { vehicleKind: 'PRIVATE', hubId: 'metro', targetPct: 80 },
      // neededBy < desiredTime
      {
        vehicleKind: 'PRIVATE',
        privateEvId: 'PEV-S1-VAL',
        hubId: 'metro',
        targetPct: 80,
        desiredTime: desired,
        neededBy: earlierNeeded,
      },
    ];

    for (const body of invalidBodies) {
      const res = await request(app)
        .post('/api/charging/requests')
        .set('Authorization', student1Token)
        .send(body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.details?.field).toBeTruthy();
    }

    const created = await db.chargingRequest.findMany({
      where: { privateEvId: 'PEV-S1-VAL' },
    });
    expect(created).toHaveLength(0);
  });
});

// ============================================================================
// AC-2: D-13 Submit Charging Request — Rental vehicle after return
// ============================================================================

describe('D-13 AC-2 Submit charging request for Rental vehicle within CHARGE_AFTER_RETURN_MIN', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('D-13 AC-2 succeeds within CHARGE_AFTER_RETURN_MIN of caller return at that Hub, and rejects expired window, other student return, or wrong Hub with 403', async () => {
    const now = new Date();
    const windowMin = config.CHARGE_AFTER_RETURN_MIN;

    // 1. Eligible return: returned (windowMin - 1) minutes ago at metro by student1 on RV-M-003 (LOW_BATTERY, 19%)
    await db.vehicleReservation.create({
      data: {
        id: 'VR-RET-OK',
        userId: 'student1',
        rentalVehicleId: 'RV-M-003',
        hubId: 'metro',
        returnHubId: 'metro',
        status: 'COMPLETED',
        endReason: 'RETURNED',
        createdAt: atOffset(now, -min(windowMin + 20)),
        expiresAt: atOffset(now, -min(windowMin + 5)),
        pickedUpAt: atOffset(now, -min(windowMin + 15)),
        returnedAt: atOffset(now, -min(windowMin - 1)),
        startBatteryPct: 60,
        endBatteryPct: 19,
      },
    });

    const okRes = await request(app)
      .post('/api/charging/requests')
      .set('Authorization', student1Token)
      .send({
        vehicleKind: 'RENTAL',
        rentalVehicleId: 'RV-M-003',
        hubId: 'metro',
        targetPct: 80,
      });
    expect(okRes.status).toBe(201);
    expect(okRes.body.vehicleKind).toBe('RENTAL');
    expect(okRes.body.rentalVehicleId).toBe('RV-M-003');
    expect(okRes.body.vehicleClass).toBe('MOTORCYCLE');
    expect(okRes.body.startPct).toBe(19);

    // 2. Just outside the window: returned (windowMin + 1) minutes ago on RV-M-001 -> 403
    await db.vehicleReservation.create({
      data: {
        id: 'VR-RET-LATE',
        userId: 'student1',
        rentalVehicleId: 'RV-M-001',
        hubId: 'metro',
        returnHubId: 'metro',
        status: 'COMPLETED',
        endReason: 'RETURNED',
        createdAt: atOffset(now, -min(windowMin + 30)),
        expiresAt: atOffset(now, -min(windowMin + 15)),
        pickedUpAt: atOffset(now, -min(windowMin + 25)),
        returnedAt: atOffset(now, -min(windowMin + 1)),
        startBatteryPct: 90,
        endBatteryPct: 80,
      },
    });

    const lateRes = await request(app)
      .post('/api/charging/requests')
      .set('Authorization', student1Token)
      .send({
        vehicleKind: 'RENTAL',
        rentalVehicleId: 'RV-M-001',
        hubId: 'metro',
        targetPct: 100,
      });
    expect(lateRes.status).toBe(403);
    expect(lateRes.body.error.code).toBe('FORBIDDEN');

    // 3. Another student's return within window on RV-M-002 -> student1 gets 403
    await db.vehicleReservation.create({
      data: {
        id: 'VR-RET-OTHER',
        userId: 'student2',
        rentalVehicleId: 'RV-M-002',
        hubId: 'metro',
        returnHubId: 'metro',
        status: 'COMPLETED',
        endReason: 'RETURNED',
        createdAt: atOffset(now, -min(15)),
        expiresAt: atOffset(now, -min(5)),
        pickedUpAt: atOffset(now, -min(10)),
        returnedAt: atOffset(now, -min(2)),
        startBatteryPct: 50,
        endBatteryPct: 20,
      },
    });

    const otherUserRes = await request(app)
      .post('/api/charging/requests')
      .set('Authorization', student1Token)
      .send({
        vehicleKind: 'RENTAL',
        rentalVehicleId: 'RV-M-002',
        hubId: 'metro',
        targetPct: 90,
      });
    expect(otherUserRes.status).toBe(403);

    // 4. Student2 returned RV-M-002 at metro, but requests charging at dorm -> 403
    const wrongHubRes = await request(app)
      .post('/api/charging/requests')
      .set('Authorization', student2Token)
      .send({
        vehicleKind: 'RENTAL',
        rentalVehicleId: 'RV-M-002',
        hubId: 'dorm',
        targetPct: 90,
      });
    expect(wrongHubRes.status).toBe(403);
  });

  it('D-13 AC-2 returns 409 NOT_ELIGIBLE when the returned vehicle was subsequently reserved, moved, or became faulty', async () => {
    const now = new Date();

    // RV-M-006 is RESERVED at metro; RV-M-007 is FAULTY at metro; RV-D-001 is at dorm (moved from metro)
    await db.vehicleReservation.createMany({
      data: [
        {
          id: 'VR-NOW-RES',
          userId: 'student1',
          rentalVehicleId: 'RV-M-006',
          hubId: 'metro',
          returnHubId: 'metro',
          status: 'COMPLETED',
          endReason: 'RETURNED',
          createdAt: atOffset(now, -min(20)),
          expiresAt: atOffset(now, -min(10)),
          returnedAt: atOffset(now, -min(5)),
        },
        {
          id: 'VR-NOW-FAULTY',
          userId: 'student1',
          rentalVehicleId: 'RV-M-007',
          hubId: 'metro',
          returnHubId: 'metro',
          status: 'COMPLETED',
          endReason: 'RETURNED',
          createdAt: atOffset(now, -min(20)),
          expiresAt: atOffset(now, -min(10)),
          returnedAt: atOffset(now, -min(5)),
        },
        {
          id: 'VR-NOW-MOVED',
          userId: 'student1',
          rentalVehicleId: 'RV-D-001',
          hubId: 'metro',
          returnHubId: 'metro',
          status: 'COMPLETED',
          endReason: 'RETURNED',
          createdAt: atOffset(now, -min(20)),
          expiresAt: atOffset(now, -min(10)),
          returnedAt: atOffset(now, -min(5)),
        },
      ],
    });

    for (const rentalVehicleId of ['RV-M-006', 'RV-M-007', 'RV-D-001']) {
      const res = await request(app)
        .post('/api/charging/requests')
        .set('Authorization', student1Token)
        .send({
          vehicleKind: 'RENTAL',
          rentalVehicleId,
          hubId: 'metro',
          targetPct: 95,
        });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('NOT_ELIGIBLE');
    }
  });
});

// ============================================================================
// AC-3: FR-22 View my requests & request by id
// ============================================================================

describe('FR-22 AC-3 View charging requests (/mine and /:id)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('FR-22 AC-3 /mine (active default and active=false) and /:id return only caller requests with estimates, null estimates when finished, and 404 for another user', async () => {
    const now = new Date();

    // Add a COMPLETED and a CANCELLED request for student1
    await db.chargingRequest.createMany({
      data: [
        {
          id: 'CR-S1-DONE',
          requestedById: 'student1',
          ownerId: 'student1',
          vehicleKind: 'PRIVATE',
          privateEvId: 'PEV-01',
          vehicleClass: 'CAR',
          hubId: 'metro',
          mode: 'QUEUE',
          status: 'COMPLETED',
          targetPct: 80,
          startPct: 40,
          currentPct: 80,
          finalPct: 80,
          endReason: 'TARGET_REACHED',
          createdAt: atOffset(now, -min(120)),
          endedAt: atOffset(now, -min(60)),
        },
        {
          id: 'CR-S1-CANC',
          requestedById: 'student1',
          ownerId: 'student1',
          vehicleKind: 'PRIVATE',
          privateEvId: 'PEV-03',
          vehicleClass: 'MOTORCYCLE',
          hubId: 'metro',
          mode: 'QUEUE',
          status: 'CANCELLED',
          targetPct: 90,
          startPct: 50,
          currentPct: 50,
          createdAt: atOffset(now, -min(90)),
          endedAt: atOffset(now, -min(85)),
        },
      ],
    });

    // Default active=true: student1 sees CR-M-002 (QUEUED), CR-M-004 (SCHEDULED), CR-C-001 (CHARGING)
    const activeRes = await request(app)
      .get('/api/charging/requests/mine')
      .set('Authorization', student1Token);
    expect(activeRes.status).toBe(200);
    const activeList = activeRes.body as ChargingRequestView[];
    const activeIds = activeList.map((r) => r.id);
    expect(activeIds).toContain('CR-M-002');
    expect(activeIds).toContain('CR-M-004');
    expect(activeIds).toContain('CR-C-001');
    expect(activeIds).not.toContain('CR-S1-DONE');
    expect(activeIds).not.toContain('CR-S1-CANC');
    // Never includes student2's CR-M-003 or fleet dispatch CR-M-001 (ownerId null)
    expect(activeIds).not.toContain('CR-M-003');
    expect(activeIds).not.toContain('CR-M-001');

    // Check rule-5 estimates by status
    const queued = activeList.find((r) => r.id === 'CR-M-002')!;
    expect(queued.queuePosition).toBe(1);
    expect(queued.estimatedStart).toBeTruthy();
    expect(queued.estimatedEnd).toBeTruthy();

    const scheduled = activeList.find((r) => r.id === 'CR-M-004')!;
    expect(scheduled.queuePosition).toBeNull();
    expect(scheduled.estimatedStart).toBe(scheduled.slotStart);
    expect(scheduled.estimatedEnd).toBe(scheduled.slotEnd);

    const charging = activeList.find((r) => r.id === 'CR-C-001')!;
    expect(charging.queuePosition).toBeNull();
    expect(charging.estimatedStart).toBeNull();
    expect(charging.estimatedEnd).toBeTruthy();

    // active=false: includes COMPLETED and CANCELLED with null estimates
    const allRes = await request(app)
      .get('/api/charging/requests/mine?active=false')
      .set('Authorization', student1Token);
    expect(allRes.status).toBe(200);
    const allList = allRes.body as ChargingRequestView[];
    const doneItem = allList.find((r) => r.id === 'CR-S1-DONE')!;
    expect(doneItem).toBeDefined();
    expect(doneItem.queuePosition).toBeNull();
    expect(doneItem.estimatedStart).toBeNull();
    expect(doneItem.estimatedEnd).toBeNull();

    const cancItem = allList.find((r) => r.id === 'CR-S1-CANC')!;
    expect(cancItem).toBeDefined();
    expect(cancItem.queuePosition).toBeNull();
    expect(cancItem.estimatedStart).toBeNull();
    expect(cancItem.estimatedEnd).toBeNull();

    // GET /:id for own request
    const singleRes = await request(app)
      .get('/api/charging/requests/CR-M-002')
      .set('Authorization', student1Token);
    expect(singleRes.status).toBe(200);
    expect(singleRes.body.id).toBe('CR-M-002');
    expect(singleRes.body.queuePosition).toBe(1);

    // Another student's request id -> 404
    const foreignRes = await request(app)
      .get('/api/charging/requests/CR-M-003')
      .set('Authorization', student1Token);
    expect(foreignRes.status).toBe(404);
    expect(foreignRes.body.error.code).toBe('NOT_FOUND');
  });
});

// ============================================================================
// AC-4 & AC-5: FR-49 / FR-50 / BR-06 / BR-10 Scheduler & Concurrency
// ============================================================================

describe('FR-49 FR-50 BR-06 AC-4 & BR-10 AC-5 Charging scheduler', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('FR-49 FR-50 BR-06 AC-4 assigns due SCHEDULED slots, skips overrunning long requests for shorter ones, enforces class match, ignores future desiredTime, never interrupts running sessions, and notifies CHARGING_STARTED', async () => {
    const now = new Date('2026-12-01T12:00:00.000Z');
    const motoRate = config.CHARGE_RATE_PCT_PER_MIN.MOTORCYCLE * config.DEMO_TIME_SCALE;

    // Clean charging_request and set up a controlled state at campus-a:
    // campus-a has CPA-CP-M-01 (MOTORCYCLE, AVAILABLE) and CPA-CP-C-01 (CAR, AVAILABLE).
    // Add CPA-CP-M-02 (MOTORCYCLE, AVAILABLE) and CPA-CP-M-03 (MOTORCYCLE, CHARGING).
    await db.chargingPoint.createMany({
      data: [
        { id: 'CPA-CP-M-02', hubId: 'campus-a', vehicleClass: 'MOTORCYCLE', status: 'AVAILABLE' },
        { id: 'CPA-CP-M-03', hubId: 'campus-a', vehicleClass: 'MOTORCYCLE', status: 'CHARGING' },
      ],
    });
    // Set CPA-CP-C-01 to FAULTY so CAR has no usable point at campus-a
    await db.chargingPoint.update({
      where: { id: 'CPA-CP-C-01' },
      data: { status: 'FAULTY' },
    });

    await db.privateEv.createMany({
      data: [
        { id: 'PEV-SCH-RUN', ownerId: 'student1', type: 'E_MOTORCYCLE', vehicleClass: 'MOTORCYCLE', label: 'Run', batteryCapacityKwh: 4, batteryPct: 50 },
        { id: 'PEV-SCH-DUE', ownerId: 'student1', type: 'E_MOTORCYCLE', vehicleClass: 'MOTORCYCLE', label: 'Due', batteryCapacityKwh: 4, batteryPct: 40 },
        { id: 'PEV-SCH-BOOK', ownerId: 'student2', type: 'E_MOTORCYCLE', vehicleClass: 'MOTORCYCLE', label: 'Book', batteryCapacityKwh: 4, batteryPct: 60 },
        { id: 'PEV-SCH-LONG', ownerId: 'student1', type: 'E_MOTORCYCLE', vehicleClass: 'MOTORCYCLE', label: 'Long', batteryCapacityKwh: 4, batteryPct: 10 },
        { id: 'PEV-SCH-SHORT', ownerId: 'student2', type: 'E_MOTORCYCLE', vehicleClass: 'MOTORCYCLE', label: 'Short', batteryCapacityKwh: 4, batteryPct: 80 },
        { id: 'PEV-SCH-FUT', ownerId: 'student1', type: 'E_MOTORCYCLE', vehicleClass: 'MOTORCYCLE', label: 'Fut', batteryCapacityKwh: 4, batteryPct: 5 },
        { id: 'PEV-SCH-CAR', ownerId: 'student1', type: 'CAR', vehicleClass: 'CAR', label: 'Car', batteryCapacityKwh: 50, batteryPct: 20 },
      ],
    });

    // 1) Running session on CPA-CP-M-03 (must never be interrupted)
    // 2) Due SCHEDULED slot on CPA-CP-M-01 starting at now - 1m -> must become CHARGING on CPA-CP-M-01
    // 3) Future SCHEDULED slot on CPA-CP-M-02 starting at now + 25m
    // 4) Higher-ranked LONG request (10% -> 90% = 80m / motoRate) that overruns now+25m on CPA-CP-M-02
    // 5) Lower-ranked SHORT request (80% -> 95% = 15m / motoRate) that fits before now+25m on CPA-CP-M-02
    // 6) Future desiredTime request (desiredTime = now + 10m)
    // 7) CAR request (must never be placed on a MOTORCYCLE point)
    const shortDurMs = ((95 - 80) / motoRate) * 60_000;
    const bookedStart = atOffset(now, shortDurMs + min(10)); // plenty of room for SHORT, not for LONG (80/15 * shortDurMs)

    await db.chargingRequest.createMany({
      data: [
        {
          id: 'CR-SCH-RUN',
          requestedById: 'student1',
          ownerId: 'student1',
          vehicleKind: 'PRIVATE',
          privateEvId: 'PEV-SCH-RUN',
          vehicleClass: 'MOTORCYCLE',
          hubId: 'campus-a',
          mode: 'QUEUE',
          status: 'CHARGING',
          chargingPointId: 'CPA-CP-M-03',
          startPct: 40,
          currentPct: 50,
          targetPct: 90,
          desiredTime: atOffset(now, -min(20)),
          slotStart: atOffset(now, -min(10)),
          slotEnd: atOffset(now, min(30)),
          startedAt: atOffset(now, -min(10)),
          createdAt: atOffset(now, -min(20)),
        },
        {
          id: 'CR-SCH-DUE',
          requestedById: 'student1',
          ownerId: 'student1',
          vehicleKind: 'PRIVATE',
          privateEvId: 'PEV-SCH-DUE',
          vehicleClass: 'MOTORCYCLE',
          hubId: 'campus-a',
          mode: 'ADVANCE',
          status: 'SCHEDULED',
          chargingPointId: 'CPA-CP-M-01',
          startPct: 40,
          currentPct: 40,
          targetPct: 80,
          desiredTime: atOffset(now, -min(1)),
          slotStart: atOffset(now, -min(1)),
          slotEnd: atOffset(now, min(39)),
          createdAt: atOffset(now, -min(60)),
        },
        {
          id: 'CR-SCH-BOOK',
          requestedById: 'student2',
          ownerId: 'student2',
          vehicleKind: 'PRIVATE',
          privateEvId: 'PEV-SCH-BOOK',
          vehicleClass: 'MOTORCYCLE',
          hubId: 'campus-a',
          mode: 'ADVANCE',
          status: 'SCHEDULED',
          chargingPointId: 'CPA-CP-M-02',
          startPct: 60,
          currentPct: 60,
          targetPct: 90,
          desiredTime: bookedStart,
          slotStart: bookedStart,
          slotEnd: atOffset(bookedStart, min(30)),
          createdAt: atOffset(now, -min(60)),
        },
        {
          id: 'CR-SCH-LONG',
          requestedById: 'student1',
          ownerId: 'student1',
          vehicleKind: 'PRIVATE',
          privateEvId: 'PEV-SCH-LONG',
          vehicleClass: 'MOTORCYCLE',
          hubId: 'campus-a',
          mode: 'QUEUE',
          status: 'QUEUED',
          startPct: 10,
          currentPct: 10,
          targetPct: 90,
          desiredTime: atOffset(now, -min(15)),
          createdAt: atOffset(now, -min(15)),
        },
        {
          id: 'CR-SCH-SHORT',
          requestedById: 'student2',
          ownerId: 'student2',
          vehicleKind: 'PRIVATE',
          privateEvId: 'PEV-SCH-SHORT',
          vehicleClass: 'MOTORCYCLE',
          hubId: 'campus-a',
          mode: 'QUEUE',
          status: 'QUEUED',
          startPct: 80,
          currentPct: 80,
          targetPct: 95,
          desiredTime: atOffset(now, -min(5)),
          createdAt: atOffset(now, -min(5)),
        },
        {
          id: 'CR-SCH-FUT',
          requestedById: 'student1',
          ownerId: 'student1',
          vehicleKind: 'PRIVATE',
          privateEvId: 'PEV-SCH-FUT',
          vehicleClass: 'MOTORCYCLE',
          hubId: 'campus-a',
          mode: 'QUEUE',
          status: 'QUEUED',
          startPct: 5,
          currentPct: 5,
          targetPct: 100,
          desiredTime: atOffset(now, min(10)),
          createdAt: atOffset(now, -min(30)),
        },
        {
          id: 'CR-SCH-CAR',
          requestedById: 'student1',
          ownerId: 'student1',
          vehicleKind: 'PRIVATE',
          privateEvId: 'PEV-SCH-CAR',
          vehicleClass: 'CAR',
          hubId: 'campus-a',
          mode: 'QUEUE',
          status: 'QUEUED',
          startPct: 20,
          currentPct: 20,
          targetPct: 80,
          desiredTime: atOffset(now, -min(20)),
          createdAt: atOffset(now, -min(20)),
        },
      ],
    });

    await runScheduler('campus-a', now);

    const requestsAfter = await db.chargingRequest.findMany({
      where: { hubId: 'campus-a' },
    });
    const byId = new Map(requestsAfter.map((r) => [r.id, r]));

    // 1) Running session untouched
    expect(byId.get('CR-SCH-RUN')?.status).toBe('CHARGING');
    expect(byId.get('CR-SCH-RUN')?.chargingPointId).toBe('CPA-CP-M-03');

    // 2) Due SCHEDULED request started on CPA-CP-M-01
    expect(byId.get('CR-SCH-DUE')?.status).toBe('CHARGING');
    expect(byId.get('CR-SCH-DUE')?.chargingPointId).toBe('CPA-CP-M-01');
    expect(byId.get('CR-SCH-DUE')?.startedAt?.getTime()).toBe(now.getTime());

    // 3) Future SCHEDULED slot stays SCHEDULED
    expect(byId.get('CR-SCH-BOOK')?.status).toBe('SCHEDULED');

    // 4) LONG skipped (overruns CR-SCH-BOOK), SHORT assigned to CPA-CP-M-02
    expect(byId.get('CR-SCH-LONG')?.status).toBe('QUEUED');
    const shortAfter = byId.get('CR-SCH-SHORT')!;
    expect(shortAfter.status).toBe('CHARGING');
    expect(shortAfter.chargingPointId).toBe('CPA-CP-M-02');
    expect(shortAfter.slotStart?.getTime()).toBe(now.getTime());
    expect(shortAfter.slotEnd?.getTime()).toBe(now.getTime() + shortDurMs);

    // 5) Future desiredTime and CAR stay QUEUED
    expect(byId.get('CR-SCH-FUT')?.status).toBe('QUEUED');
    expect(byId.get('CR-SCH-CAR')?.status).toBe('QUEUED');

    // 6) Charging points updated to CHARGING
    const pts = await db.chargingPoint.findMany({ where: { hubId: 'campus-a' } });
    const ptStatus = new Map(pts.map((p) => [p.id, p.status]));
    expect(ptStatus.get('CPA-CP-M-01')).toBe('CHARGING');
    expect(ptStatus.get('CPA-CP-M-02')).toBe('CHARGING');
    expect(ptStatus.get('CPA-CP-M-03')).toBe('CHARGING');

    // 7) CHARGING_STARTED notification sent to owners
    const notifs = await db.notification.findMany({
      where: { type: 'CHARGING_STARTED' },
    });
    expect(notifs.length).toBeGreaterThanOrEqual(1);
    expect(notifs.some((n) => n.userId === 'student2')).toBe(true);

    // 8) No overlapping intervals on any point
    assertNoPointOverlaps(requestsAfter);
  });

  it('BR-10 AC-5 two concurrent runScheduler runs never assign one request twice or put two sessions on one point', async () => {
    const now = new Date('2026-12-01T12:00:00.000Z');

    // At dorm: 1 AVAILABLE MOTO point DOR-CP-M-01; add DOR-CP-M-02 AVAILABLE and 3 eligible MOTO requests
    await db.chargingPoint.create({
      data: { id: 'DOR-CP-M-02', hubId: 'dorm', vehicleClass: 'MOTORCYCLE', status: 'AVAILABLE' },
    });
    await db.privateEv.createMany({
      data: [
        { id: 'PEV-RACE-1', ownerId: 'student1', type: 'E_MOTORCYCLE', vehicleClass: 'MOTORCYCLE', label: 'R1', batteryCapacityKwh: 4, batteryPct: 20 },
        { id: 'PEV-RACE-2', ownerId: 'student2', type: 'E_MOTORCYCLE', vehicleClass: 'MOTORCYCLE', label: 'R2', batteryCapacityKwh: 4, batteryPct: 30 },
        { id: 'PEV-RACE-3', ownerId: 'student1', type: 'E_MOTORCYCLE', vehicleClass: 'MOTORCYCLE', label: 'R3', batteryCapacityKwh: 4, batteryPct: 40 },
      ],
    });
    await db.chargingRequest.createMany({
      data: [
        {
          id: 'CR-RACE-1',
          requestedById: 'student1',
          ownerId: 'student1',
          vehicleKind: 'PRIVATE',
          privateEvId: 'PEV-RACE-1',
          vehicleClass: 'MOTORCYCLE',
          hubId: 'dorm',
          mode: 'QUEUE',
          status: 'QUEUED',
          startPct: 20,
          currentPct: 20,
          targetPct: 80,
          desiredTime: atOffset(now, -min(10)),
          createdAt: atOffset(now, -min(10)),
        },
        {
          id: 'CR-RACE-2',
          requestedById: 'student2',
          ownerId: 'student2',
          vehicleKind: 'PRIVATE',
          privateEvId: 'PEV-RACE-2',
          vehicleClass: 'MOTORCYCLE',
          hubId: 'dorm',
          mode: 'QUEUE',
          status: 'QUEUED',
          startPct: 30,
          currentPct: 30,
          targetPct: 80,
          desiredTime: atOffset(now, -min(8)),
          createdAt: atOffset(now, -min(8)),
        },
        {
          id: 'CR-RACE-3',
          requestedById: 'student1',
          ownerId: 'student1',
          vehicleKind: 'PRIVATE',
          privateEvId: 'PEV-RACE-3',
          vehicleClass: 'MOTORCYCLE',
          hubId: 'dorm',
          mode: 'QUEUE',
          status: 'QUEUED',
          startPct: 40,
          currentPct: 40,
          targetPct: 80,
          desiredTime: atOffset(now, -min(6)),
          createdAt: atOffset(now, -min(6)),
        },
      ],
    });

    await Promise.all([runScheduler('dorm', now), runScheduler('dorm', now)]);

    const rows = await db.chargingRequest.findMany({
      where: { hubId: 'dorm' },
      orderBy: { id: 'asc' },
    });
    const chargingRows = rows.filter((r) => r.status === 'CHARGING');
    const queuedRows = rows.filter((r) => r.status === 'QUEUED');

    expect(chargingRows).toHaveLength(2);
    expect(queuedRows).toHaveLength(1);
    expect(queuedRows[0]!.id).toBe('CR-RACE-3');

    const assignedPoints = new Set(chargingRows.map((r) => r.chargingPointId));
    expect(assignedPoints.size).toBe(2);
    assertNoPointOverlaps(rows);
  });
});

// ============================================================================
// AC-6, AC-7, AC-8: Stop, Telemetry TARGET_REACHED, Cancel
// ============================================================================

describe('FR-23 FR-24 AC-6 AC-7 AC-8 Stop, Telemetry Target Reached, and Cancel', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('FR-23 AC-6 stop ends CHARGING with USER_STOP and finalPct, frees point, and flips rental vehicle LOW_BATTERY -> AVAILABLE at >= MIN_RENTAL_BATTERY_PCT (stays LOW_BATTERY at min-1)', async () => {
    const now = new Date();
    const minBat = config.MIN_RENTAL_BATTERY_PCT;

    // 1. Stop student1's CHARGING request CR-C-001 on MET-CP-C-01
    const stopRes = await request(app)
      .post('/api/charging/requests/CR-C-001/stop')
      .set('Authorization', student1Token);
    expect(stopRes.status).toBe(200);
    const stopped = stopRes.body as ChargingRequestView;
    expect(stopped.status).toBe('COMPLETED');
    expect(stopped.endReason).toBe('USER_STOP');
    expect(stopped.finalPct).toBe(60);
    expect(stopped.estimatedStart).toBeNull();
    expect(stopped.estimatedEnd).toBeNull();
    expect(stopped.queuePosition).toBeNull();

    const cpAfter = await db.chargingPoint.findUnique({ where: { id: 'MET-CP-C-01' } });
    expect(cpAfter?.status).toBe('AVAILABLE');

    // Stopping again -> 409 INVALID_STATE_TRANSITION
    const stopAgain = await request(app)
      .post('/api/charging/requests/CR-C-001/stop')
      .set('Authorization', student1Token);
    expect(stopAgain.status).toBe(409);
    expect(stopAgain.body.error.code).toBe('INVALID_STATE_TRANSITION');

    // Stopping a QUEUED request -> 409 INVALID_STATE_TRANSITION
    const stopQueued = await request(app)
      .post('/api/charging/requests/CR-M-002/stop')
      .set('Authorization', student1Token);
    expect(stopQueued.status).toBe(409);
    expect(stopQueued.body.error.code).toBe('INVALID_STATE_TRANSITION');

    // 2. Rental vehicle LOW_BATTERY boundary: minBat - 1 stays LOW_BATTERY; minBat becomes AVAILABLE
    await db.rentalVehicle.update({
      where: { id: 'RV-M-003' },
      data: { status: 'LOW_BATTERY', batteryPct: minBat - 1 },
    });
    await db.chargingPoint.update({
      where: { id: 'DOR-CP-M-01' },
      data: { status: 'CHARGING' },
    });
    await db.chargingRequest.create({
      data: {
        id: 'CR-LOW-19',
        requestedById: 'student1',
        ownerId: 'student1',
        vehicleKind: 'RENTAL',
        rentalVehicleId: 'RV-M-003',
        vehicleClass: 'MOTORCYCLE',
        hubId: 'dorm',
        mode: 'QUEUE',
        status: 'CHARGING',
        chargingPointId: 'DOR-CP-M-01',
        startPct: 10,
        currentPct: minBat - 1,
        targetPct: 80,
        slotStart: atOffset(now, -min(10)),
        slotEnd: atOffset(now, min(60)),
        startedAt: atOffset(now, -min(10)),
      },
    });

    await request(app)
      .post('/api/charging/requests/CR-LOW-19/stop')
      .set('Authorization', student1Token)
      .expect(200);

    const rvAt19 = await db.rentalVehicle.findUnique({ where: { id: 'RV-M-003' } });
    expect(rvAt19?.status).toBe('LOW_BATTERY');

    // Now at exactly minBat (20%) -> flips LOW_BATTERY -> AVAILABLE
    await db.rentalVehicle.update({
      where: { id: 'RV-M-003' },
      data: { status: 'LOW_BATTERY', batteryPct: minBat },
    });
    await db.chargingPoint.update({
      where: { id: 'DOR-CP-M-01' },
      data: { status: 'CHARGING' },
    });
    await db.chargingRequest.create({
      data: {
        id: 'CR-LOW-20',
        requestedById: 'student1',
        ownerId: 'student1',
        vehicleKind: 'RENTAL',
        rentalVehicleId: 'RV-M-003',
        vehicleClass: 'MOTORCYCLE',
        hubId: 'dorm',
        mode: 'QUEUE',
        status: 'CHARGING',
        chargingPointId: 'DOR-CP-M-01',
        startPct: 10,
        currentPct: minBat,
        targetPct: 80,
        slotStart: atOffset(now, -min(10)),
        slotEnd: atOffset(now, min(60)),
        startedAt: atOffset(now, -min(10)),
      },
    });

    await request(app)
      .post('/api/charging/requests/CR-LOW-20/stop')
      .set('Authorization', student1Token)
      .expect(200);

    const rvAt20 = await db.rentalVehicle.findUnique({ where: { id: 'RV-M-003' } });
    expect(rvAt20?.status).toBe('AVAILABLE');
  });

  it('FR-24 AC-8 cancel transitions QUEUED and SCHEDULED to CANCELLED, rejects CHARGING with stop nextAction, rejects finished with 409, and returns 404 for another user', async () => {
    // 1. Cancel QUEUED CR-M-002 (owned by student1)
    const cancelQueued = await request(app)
      .post('/api/charging/requests/CR-M-002/cancel')
      .set('Authorization', student1Token);
    expect(cancelQueued.status).toBe(200);
    expect(cancelQueued.body.status).toBe('CANCELLED');

    // 2. Cancel again (finished) -> 409
    const cancelAgain = await request(app)
      .post('/api/charging/requests/CR-M-002/cancel')
      .set('Authorization', student1Token);
    expect(cancelAgain.status).toBe(409);
    expect(cancelAgain.body.error.code).toBe('INVALID_STATE_TRANSITION');

    // 3. Cancel SCHEDULED CR-M-004 (owned by student1)
    const cancelScheduled = await request(app)
      .post('/api/charging/requests/CR-M-004/cancel')
      .set('Authorization', student1Token);
    expect(cancelScheduled.status).toBe(200);
    expect(cancelScheduled.body.status).toBe('CANCELLED');

    // 4. Cancel CHARGING CR-C-001 -> 409 with "stop" nextAction
    const cancelCharging = await request(app)
      .post('/api/charging/requests/CR-C-001/cancel')
      .set('Authorization', student1Token);
    expect(cancelCharging.status).toBe(409);
    expect(cancelCharging.body.error.code).toBe('INVALID_STATE_TRANSITION');
    expect(
      (cancelCharging.body.error.nextActions as string[]).some((a) => /stop/i.test(a)),
    ).toBe(true);

    // 5. Cancel another user's request CR-M-003 (owned by student2) -> 404
    const cancelForeign = await request(app)
      .post('/api/charging/requests/CR-M-003/cancel')
      .set('Authorization', student1Token);
    expect(cancelForeign.status).toBe(404);
    expect(cancelForeign.body.error.code).toBe('NOT_FOUND');
  });

  it('FR-23 AC-7 telemetry reaching targetPct ends session TARGET_REACHED with CHARGING_COMPLETED notification, repeating is a no-op, and freed point is allocated to the next request', async () => {
    const now = new Date();
    const emittedHubs: string[] = [];
    events.on('CHARGING_QUEUE_CHANGED', ({ hubId }) => {
      emittedHubs.push(hubId);
    });

    // Queue a second CAR request at metro (where MET-CP-C-01 is CHARGING with CR-C-001, targetPct 90 for PEV-01)
    await db.privateEv.create({
      data: {
        id: 'PEV-NEXT-CAR',
        ownerId: 'student2',
        type: 'CAR',
        vehicleClass: 'CAR',
        label: 'Next Car',
        batteryCapacityKwh: 50,
        batteryPct: 40,
      },
    });
    await db.chargingRequest.create({
      data: {
        id: 'CR-NEXT-CAR',
        requestedById: 'student2',
        ownerId: 'student2',
        vehicleKind: 'PRIVATE',
        privateEvId: 'PEV-NEXT-CAR',
        vehicleClass: 'CAR',
        hubId: 'metro',
        mode: 'QUEUE',
        status: 'QUEUED',
        startPct: 40,
        currentPct: 40,
        targetPct: 80,
        desiredTime: atOffset(now, -min(5)),
        createdAt: atOffset(now, -min(5)),
      },
    });

    // Ingest telemetry packet bringing PEV-01 to 90% (targetPct of CR-C-001)
    const teleRes = await request(app)
      .post('/api/telemetry')
      .set('X-Telemetry-Key', config.TELEMETRY_KEY)
      .send({
        hubId: 'metro',
        timestamp: atOffset(now, min(1)).toISOString(),
        source: 'SIMULATOR',
        privateEvs: [{ id: 'PEV-01', batteryPct: 90 }],
      });
    expect(teleRes.status).toBe(202);
    expect(emittedHubs).toContain('metro');

    const completedReq = await db.chargingRequest.findUnique({ where: { id: 'CR-C-001' } });
    expect(completedReq?.status).toBe('COMPLETED');
    expect(completedReq?.endReason).toBe('TARGET_REACHED');
    expect(completedReq?.finalPct).toBe(90);

    const notifs1 = await db.notification.findMany({
      where: { userId: 'student1', type: 'CHARGING_COMPLETED' },
    });
    expect(notifs1).toHaveLength(1);

    // Repeating endSession(id, 'TARGET_REACHED') is a silent no-op
    await endSession('CR-C-001', 'TARGET_REACHED', now);
    const notifsAfterRepeat = await db.notification.findMany({
      where: { userId: 'student1', type: 'CHARGING_COMPLETED' },
    });
    expect(notifsAfterRepeat).toHaveLength(1);

    // After commit, running the scheduler allocates the freed CAR point MET-CP-C-01 to CR-NEXT-CAR
    await runScheduler('metro', now);
    const nextCar = await db.chargingRequest.findUnique({ where: { id: 'CR-NEXT-CAR' } });
    expect(nextCar?.status).toBe('CHARGING');
    expect(nextCar?.chargingPointId).toBe('MET-CP-C-01');
  });
});

// ============================================================================
// AC-9: Student-only role & auth guards
// ============================================================================

describe('FR-61 AC-9 Student charging routes enforce STUDENT role and auth', () => {
  beforeEach(async () => {
    await resetDb();
  });

  const routes = [
    {
      method: 'post' as const,
      path: '/api/charging/requests',
      body: { vehicleKind: 'PRIVATE', privateEvId: 'PEV-01', hubId: 'metro', targetPct: 90 },
    },
    { method: 'get' as const, path: '/api/charging/requests/mine' },
    { method: 'get' as const, path: '/api/charging/requests/CR-M-002' },
    { method: 'post' as const, path: '/api/charging/requests/CR-C-001/stop' },
    { method: 'post' as const, path: '/api/charging/requests/CR-M-002/cancel' },
  ];

  it('FR-61 AC-9 returns 401 without token on all five student charging routes', async () => {
    for (const r of routes) {
      const req = request(app)[r.method](r.path);
      const res = r.body ? await req.send(r.body) : await req;
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHENTICATED');
    }
  });

  it('FR-61 AC-9 returns 403 and writes SECURITY_DENIED audit row for OPERATOR token on all five student charging routes', async () => {
    for (const r of routes) {
      const req = request(app)[r.method](r.path).set('Authorization', operatorToken);
      const res = r.body ? await req.send(r.body) : await req;
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    }

    const audits = await db.auditLog.findMany({
      where: { action: 'SECURITY_DENIED', actorId: 'operator1' },
    });
    expect(audits).toHaveLength(5);
  });
});
