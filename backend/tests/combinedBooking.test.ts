// Combined parking + charging booking tests (T-21, FR-28, BR-14, BR-10, BR-13, NFR-08).
// Written from SPEC, ARCHITECTURE, CONTRACTS, and T-21 ticket before reading writer code.

import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { config } from '../src/core/config';
import { db } from '../src/core/db';
import { events } from '../src/core/events';
import { createTestApp, loginAs, resetDb } from './helpers';

const app = createTestApp();

function futureIso(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

const MIN_MS = 60_000;
const HR_MS = 3_600_000;

async function createCleanEv(
  ownerId: 'student1' | 'student2',
  type: 'CAR' | 'E_MOTORCYCLE' = 'CAR',
  batteryPct = 50,
  idSuffix = Math.random().toString(36).slice(2, 8),
) {
  const vehicleClass = type === 'CAR' ? 'CAR' : 'MOTORCYCLE';
  return db.privateEv.create({
    data: {
      id: `PEV-TEST-${idSuffix}`,
      ownerId,
      type,
      vehicleClass,
      label: `Test ${type} ${idSuffix}`,
      batteryCapacityKwh: type === 'CAR' ? 50 : 4,
      batteryPct,
    },
  });
}

describe('T-21 Combined parking + charging booking (POST /api/private-evs/:id/book-parking-charging)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  // ---- AC-1: FR-28 success ----

  it('FR-28 T-21 AC-1 books parking + charging in one transaction with shared bookingGroupId and explicit chargeStart', async () => {
    const ev = await createCleanEv('student1', 'CAR', 50, 'ac1a');
    const windowStart = futureIso(30 * MIN_MS);
    const chargeStart = futureIso(45 * MIN_MS);
    const windowEnd = futureIso(4 * HR_MS);

    const res = await request(app)
      .post(`/api/private-evs/${ev.id}/book-parking-charging`)
      .set('Authorization', loginAs('student1'))
      .send({
        hubId: 'dorm',
        windowStart,
        windowEnd,
        targetPct: 85,
        chargeStart,
      });

    expect(res.status).toBe(201);
    expect(typeof res.body.bookingGroupId).toBe('string');
    expect(res.body.bookingGroupId.length).toBeGreaterThan(0);

    const { bookingGroupId, parkingReservation, chargingRequest } = res.body;
    expect(parkingReservation.status).toBe('CONFIRMED');
    expect(parkingReservation.hubId).toBe('dorm');
    expect(parkingReservation.vehicleClass).toBe('CAR');
    expect(parkingReservation.privateEvId).toBe(ev.id);
    expect(parkingReservation.bookingGroupId).toBe(bookingGroupId);
    expect(new Date(parkingReservation.windowStart).toISOString()).toBe(windowStart);
    expect(new Date(parkingReservation.windowEnd).toISOString()).toBe(windowEnd);

    expect(chargingRequest.status).toBe('SCHEDULED');
    expect(chargingRequest.mode).toBe('ADVANCE');
    expect(chargingRequest.hubId).toBe('dorm');
    expect(chargingRequest.vehicleClass).toBe('CAR');
    expect(chargingRequest.privateEvId).toBe(ev.id);
    expect(chargingRequest.targetPct).toBe(85);
    expect(chargingRequest.chargingPointId).toBeTruthy();
    expect(new Date(chargingRequest.slotStart).toISOString()).toBe(chargeStart);

    // Verify DB rows share the exact bookingGroupId
    const dbParking = await db.parkingReservation.findUnique({
      where: { id: parkingReservation.id },
    });
    const dbCharging = await db.chargingRequest.findUnique({
      where: { id: chargingRequest.id },
    });
    expect(dbParking?.bookingGroupId).toBe(bookingGroupId);
    expect(dbCharging?.bookingGroupId).toBe(bookingGroupId);
  });

  it('FR-28 T-21 AC-1 defaults chargeStart to windowStart when omitted and works for MOTORCYCLE EVs (BR-13)', async () => {
    const ev = await createCleanEv('student1', 'E_MOTORCYCLE', 40, 'ac1b');
    const windowStart = futureIso(20 * MIN_MS);
    const windowEnd = futureIso(3 * HR_MS);

    const res = await request(app)
      .post(`/api/private-evs/${ev.id}/book-parking-charging`)
      .set('Authorization', loginAs('student1'))
      .send({
        hubId: 'dorm',
        windowStart,
        windowEnd,
        targetPct: 90,
      });

    expect(res.status).toBe(201);
    expect(res.body.parkingReservation.vehicleClass).toBe('MOTORCYCLE');
    expect(res.body.chargingRequest.vehicleClass).toBe('MOTORCYCLE');
    expect(new Date(res.body.chargingRequest.slotStart).toISOString()).toBe(windowStart);
  });

  it('FR-28 T-21 AC-1 keeps the two parts independent after booking (cancelling parking does not cancel charging)', async () => {
    const ev = await createCleanEv('student1', 'CAR', 50, 'ac1c');
    const windowStart = futureIso(30 * MIN_MS);
    const windowEnd = futureIso(4 * HR_MS);

    const bookRes = await request(app)
      .post(`/api/private-evs/${ev.id}/book-parking-charging`)
      .set('Authorization', loginAs('student1'))
      .send({ hubId: 'dorm', windowStart, windowEnd, targetPct: 80 });
    expect(bookRes.status).toBe(201);

    const cancelRes = await request(app)
      .post(`/api/parking-reservations/${bookRes.body.parkingReservation.id}/cancel`)
      .set('Authorization', loginAs('student1'));
    expect(cancelRes.status).toBe(200);
    expect(cancelRes.body.status).toBe('CANCELLED');

    const dbCharging = await db.chargingRequest.findUnique({
      where: { id: bookRes.body.chargingRequest.id },
    });
    expect(dbCharging?.status).toBe('SCHEDULED');
  });

  // ---- AC-2: BR-14 all-or-nothing ----

  it('BR-14 T-21 AC-2 returns 409 NO_CAPACITY with details.missing=PARKING and alternatives when parking is full, leaving zero new rows', async () => {
    const ev = await createCleanEv('student1', 'CAR', 50, 'ac2p');
    const windowStart = futureIso(30 * MIN_MS);
    const windowEnd = futureIso(4 * HR_MS);

    // Block dorm's only PUBLIC CAR space (DOR-P-C-01) for this window
    await db.parkingReservation.create({
      data: {
        userId: 'student2',
        parkingSpaceId: 'DOR-P-C-01',
        hubId: 'dorm',
        vehicleClass: 'CAR',
        windowStart: new Date(windowStart),
        windowEnd: new Date(windowEnd),
        status: 'CONFIRMED',
        expiresAt: new Date(Date.now() + 45 * MIN_MS),
      },
    });

    const parkingBefore = await db.parkingReservation.count();
    const chargingBefore = await db.chargingRequest.count();

    const res = await request(app)
      .post(`/api/private-evs/${ev.id}/book-parking-charging`)
      .set('Authorization', loginAs('student1'))
      .send({ hubId: 'dorm', windowStart, windowEnd, targetPct: 85 });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('NO_CAPACITY');
    expect(res.body.error.details?.missing).toBe('PARKING');
    expect(res.body.error.message.toLowerCase()).toContain('parking');
    expect(Array.isArray(res.body.error.nextActions)).toBe(true);
    expect(res.body.error.nextActions.length).toBeGreaterThan(0);
    expect(Array.isArray(res.body.error.alternatives)).toBe(true);
    expect(res.body.error.alternatives.length).toBeGreaterThan(0);

    expect(await db.parkingReservation.count()).toBe(parkingBefore);
    expect(await db.chargingRequest.count()).toBe(chargingBefore);
  });

  it('BR-14 T-21 AC-2 returns 409 NO_CAPACITY with details.missing=CHARGING and alternatives when charging is full, leaving no orphan parking row', async () => {
    const ev = await createCleanEv('student1', 'CAR', 50, 'ac2c');
    const blockerEv = await createCleanEv('student2', 'CAR', 50, 'ac2cblk');
    const windowStart = futureIso(30 * MIN_MS);
    const windowEnd = futureIso(4 * HR_MS);

    // Block dorm's only CAR charging point (DOR-CP-C-01) with a SCHEDULED request
    await db.chargingRequest.create({
      data: {
        requestedById: 'student2',
        ownerId: 'student2',
        vehicleKind: 'PRIVATE',
        privateEvId: blockerEv.id,
        vehicleClass: 'CAR',
        hubId: 'dorm',
        mode: 'ADVANCE',
        status: 'SCHEDULED',
        targetPct: 90,
        startPct: 50,
        currentPct: 50,
        chargingPointId: 'DOR-CP-C-01',
        slotStart: new Date(windowStart),
        slotEnd: new Date(Date.now() + 2 * HR_MS),
      },
    });

    const parkingBefore = await db.parkingReservation.count();
    const chargingBefore = await db.chargingRequest.count();

    const res = await request(app)
      .post(`/api/private-evs/${ev.id}/book-parking-charging`)
      .set('Authorization', loginAs('student1'))
      .send({ hubId: 'dorm', windowStart, windowEnd, targetPct: 85 });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('NO_CAPACITY');
    expect(res.body.error.details?.missing).toBe('CHARGING');
    expect(res.body.error.message.toLowerCase()).toContain('charging');
    expect(Array.isArray(res.body.error.nextActions)).toBe(true);
    expect(res.body.error.nextActions.length).toBeGreaterThan(0);
    expect(Array.isArray(res.body.error.alternatives)).toBe(true);
    expect(res.body.error.alternatives.length).toBeGreaterThan(0);

    // Critical BR-14 check: parking row created in step 3 must be rolled back
    expect(await db.parkingReservation.count()).toBe(parkingBefore);
    expect(await db.chargingRequest.count()).toBe(chargingBefore);
  });

  // ---- AC-3: Rule 2.5 slotEnd > windowEnd ----

  it('T-21 AC-3 returns 400 details.field=chargeStart when charging would end after windowEnd, leaving nothing booked', async () => {
    // CAR rate = 0.5 %/min * DEMO_TIME_SCALE. From 50% to 100% takes (50 / (0.5 * scale)) min.
    const ev = await createCleanEv('student1', 'CAR', 50, 'ac3');
    const chargeDurationMin = 50 / (config.CHARGE_RATE_PCT_PER_MIN.CAR * config.DEMO_TIME_SCALE);
    // Make parking window strictly shorter than chargeDurationMin
    const windowStart = futureIso(30 * MIN_MS);
    const windowEnd = futureIso((30 + Math.max(5, Math.floor(chargeDurationMin / 2))) * MIN_MS);

    const parkingBefore = await db.parkingReservation.count();
    const chargingBefore = await db.chargingRequest.count();

    const res = await request(app)
      .post(`/api/private-evs/${ev.id}/book-parking-charging`)
      .set('Authorization', loginAs('student1'))
      .send({
        hubId: 'dorm',
        windowStart,
        windowEnd,
        targetPct: 100,
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details?.field).toBe('chargeStart');
    expect(await db.parkingReservation.count()).toBe(parkingBefore);
    expect(await db.chargingRequest.count()).toBe(chargingBefore);
  });

  // ---- AC-4: Rule 1 validation ----

  it('T-21 AC-4 rejects invalid inputs with 400 and details.field without creating any rows', async () => {
    const ev = await createCleanEv('student1', 'CAR', 50, 'ac4');
    const parkingBefore = await db.parkingReservation.count();
    const chargingBefore = await db.chargingRequest.count();

    const cases: Array<{ name: string; body: Record<string, unknown>; field: string }> = [
      {
        name: 'unknown hubId',
        body: {
          hubId: 'non-existent-hub',
          windowStart: futureIso(30 * MIN_MS),
          windowEnd: futureIso(3 * HR_MS),
          targetPct: 80,
        },
        field: 'hubId',
      },
      {
        name: 'windowEnd <= windowStart',
        body: {
          hubId: 'dorm',
          windowStart: futureIso(2 * HR_MS),
          windowEnd: futureIso(1 * HR_MS),
          targetPct: 80,
        },
        field: 'windowEnd',
      },
      {
        name: 'window exceeds PARKING_MAX_WINDOW_H',
        body: {
          hubId: 'dorm',
          windowStart: futureIso(30 * MIN_MS),
          windowEnd: futureIso((30 * MIN_MS) + (config.PARKING_MAX_WINDOW_H + 1) * HR_MS),
          targetPct: 80,
        },
        field: 'windowEnd',
      },
      {
        name: 'windowStart older than 1 min ago',
        body: {
          hubId: 'dorm',
          windowStart: futureIso(-5 * MIN_MS),
          windowEnd: futureIso(2 * HR_MS),
          targetPct: 80,
          chargeStart: futureIso(30 * MIN_MS),
        },
        field: 'windowStart',
      },
      {
        name: 'targetPct = 0',
        body: {
          hubId: 'dorm',
          windowStart: futureIso(30 * MIN_MS),
          windowEnd: futureIso(3 * HR_MS),
          targetPct: 0,
        },
        field: 'targetPct',
      },
      {
        name: 'targetPct = 101',
        body: {
          hubId: 'dorm',
          windowStart: futureIso(30 * MIN_MS),
          windowEnd: futureIso(3 * HR_MS),
          targetPct: 101,
        },
        field: 'targetPct',
      },
      {
        name: 'chargeStart before windowStart',
        body: {
          hubId: 'dorm',
          windowStart: futureIso(60 * MIN_MS),
          windowEnd: futureIso(4 * HR_MS),
          targetPct: 80,
          chargeStart: futureIso(30 * MIN_MS),
        },
        field: 'chargeStart',
      },
      {
        name: 'chargeStart equal to windowEnd',
        body: {
          hubId: 'dorm',
          windowStart: futureIso(30 * MIN_MS),
          windowEnd: futureIso(3 * HR_MS),
          targetPct: 80,
          chargeStart: futureIso(3 * HR_MS),
        },
        field: 'chargeStart',
      },
      {
        name: 'chargeStart not in the future (explicit past)',
        body: {
          hubId: 'dorm',
          windowStart: futureIso(-30_000),
          windowEnd: futureIso(3 * HR_MS),
          targetPct: 80,
          chargeStart: futureIso(-10_000),
        },
        field: 'chargeStart',
      },
      {
        name: 'omitted chargeStart when windowStart is not in the future',
        body: {
          hubId: 'dorm',
          windowStart: futureIso(-10_000),
          windowEnd: futureIso(3 * HR_MS),
          targetPct: 80,
        },
        field: 'chargeStart',
      },
    ];

    for (const c of cases) {
      const res = await request(app)
        .post(`/api/private-evs/${ev.id}/book-parking-charging`)
        .set('Authorization', loginAs('student1'))
        .send(c.body);

      expect(res.status, `case "${c.name}" status`).toBe(400);
      expect(res.body.error.code, `case "${c.name}" code`).toBe('VALIDATION_ERROR');
      expect(res.body.error.details?.field, `case "${c.name}" field`).toBe(c.field);
    }

    expect(await db.parkingReservation.count()).toBe(parkingBefore);
    expect(await db.chargingRequest.count()).toBe(chargingBefore);
  });

  // ---- AC-5: BR-10 concurrent races ----

  it('BR-10 T-21 AC-5 concurrent combined bookings for the last parking space: one 201, one 409 missing=PARKING, no orphan rows', async () => {
    const ev1 = await createCleanEv('student1', 'CAR', 50, 'racep1');
    const ev2 = await createCleanEv('student2', 'CAR', 50, 'racep2');

    // dorm has 1 CAR space (DOR-P-C-01) and 1 CAR point (DOR-CP-C-01).
    // Add a second CAR charging point so parking is the sole bottleneck.
    await db.chargingPoint.create({
      data: { id: 'DOR-CP-C-02', hubId: 'dorm', vehicleClass: 'CAR', status: 'AVAILABLE' },
    });

    const parkingBefore = await db.parkingReservation.count();
    const chargingBefore = await db.chargingRequest.count();

    const windowStart = futureIso(30 * MIN_MS);
    const windowEnd = futureIso(4 * HR_MS);

    const [res1, res2] = await Promise.all([
      request(app)
        .post(`/api/private-evs/${ev1.id}/book-parking-charging`)
        .set('Authorization', loginAs('student1'))
        .send({ hubId: 'dorm', windowStart, windowEnd, targetPct: 80 }),
      request(app)
        .post(`/api/private-evs/${ev2.id}/book-parking-charging`)
        .set('Authorization', loginAs('student2'))
        .send({ hubId: 'dorm', windowStart, windowEnd, targetPct: 80 }),
    ]);

    const statuses = [res1.status, res2.status].sort((a, b) => a - b);
    expect(statuses).toEqual([201, 409]);

    const loser = res1.status === 409 ? res1 : res2;
    expect(loser.body.error.code).toBe('NO_CAPACITY');
    expect(loser.body.error.details?.missing).toBe('PARKING');

    expect(await db.parkingReservation.count()).toBe(parkingBefore + 1);
    expect(await db.chargingRequest.count()).toBe(chargingBefore + 1);
  });

  it('BR-10 T-21 AC-5 concurrent combined bookings for the last charging point: one 201, one 409 missing=CHARGING, no orphan parking row', async () => {
    const ev1 = await createCleanEv('student1', 'CAR', 50, 'racec1');
    const ev2 = await createCleanEv('student2', 'CAR', 50, 'racec2');

    // dorm has 1 CAR point (DOR-CP-C-01) and 1 CAR space (DOR-P-C-01).
    // Add a second FREE PUBLIC CAR parking space so charging is the sole bottleneck.
    await db.parkingSpace.create({
      data: { id: 'DOR-P-C-02', hubId: 'dorm', vehicleClass: 'CAR', pool: 'PUBLIC', status: 'FREE' },
    });

    const parkingBefore = await db.parkingReservation.count();
    const chargingBefore = await db.chargingRequest.count();

    const windowStart = futureIso(30 * MIN_MS);
    const windowEnd = futureIso(4 * HR_MS);

    const [res1, res2] = await Promise.all([
      request(app)
        .post(`/api/private-evs/${ev1.id}/book-parking-charging`)
        .set('Authorization', loginAs('student1'))
        .send({ hubId: 'dorm', windowStart, windowEnd, targetPct: 80 }),
      request(app)
        .post(`/api/private-evs/${ev2.id}/book-parking-charging`)
        .set('Authorization', loginAs('student2'))
        .send({ hubId: 'dorm', windowStart, windowEnd, targetPct: 80 }),
    ]);

    const statuses = [res1.status, res2.status].sort((a, b) => a - b);
    expect(statuses).toEqual([201, 409]);

    const loser = res1.status === 409 ? res1 : res2;
    expect(loser.body.error.code).toBe('NO_CAPACITY');
    expect(loser.body.error.details?.missing).toBe('CHARGING');

    // Loser must not leave an orphan parking row behind
    expect(await db.parkingReservation.count()).toBe(parkingBefore + 1);
    expect(await db.chargingRequest.count()).toBe(chargingBefore + 1);
  });

  // ---- AC-6: NFR-08 idempotency ----

  it('NFR-08 T-21 AC-6 same Idempotency-Key twice returns identical response and creates only one row of each', async () => {
    const ev = await createCleanEv('student1', 'CAR', 50, 'ac6');
    const key = 'idem-t21-0001';
    const payload = {
      hubId: 'dorm',
      windowStart: futureIso(30 * MIN_MS),
      windowEnd: futureIso(4 * HR_MS),
      targetPct: 85,
    };

    const parkingBefore = await db.parkingReservation.count();
    const chargingBefore = await db.chargingRequest.count();

    const first = await request(app)
      .post(`/api/private-evs/${ev.id}/book-parking-charging`)
      .set('Authorization', loginAs('student1'))
      .set('Idempotency-Key', key)
      .send(payload);
    expect(first.status).toBe(201);

    const second = await request(app)
      .post(`/api/private-evs/${ev.id}/book-parking-charging`)
      .set('Authorization', loginAs('student1'))
      .set('Idempotency-Key', key)
      .send(payload);
    expect(second.status).toBe(201);

    expect(second.body.bookingGroupId).toBe(first.body.bookingGroupId);
    expect(second.body.parkingReservation.id).toBe(first.body.parkingReservation.id);
    expect(second.body.chargingRequest.id).toBe(first.body.chargingRequest.id);

    expect(await db.parkingReservation.count()).toBe(parkingBefore + 1);
    expect(await db.chargingRequest.count()).toBe(chargingBefore + 1);
  });

  // ---- AC-7: Ownership, state, auth ----

  it('T-21 AC-7 returns 404 for another student EV, removed EV, or unknown EV; 409 HAS_ACTIVE_BOOKING for live charging EV; 403 for OPERATOR; 401 without token', async () => {
    const windowStart = futureIso(30 * MIN_MS);
    const windowEnd = futureIso(4 * HR_MS);
    const body = { hubId: 'dorm', windowStart, windowEnd, targetPct: 85 };

    const parkingBefore = await db.parkingReservation.count();
    const chargingBefore = await db.chargingRequest.count();

    // 401 without token
    const noAuth = await request(app)
      .post('/api/private-evs/PEV-01/book-parking-charging')
      .send(body);
    expect(noAuth.status).toBe(401);

    // 403 for OPERATOR
    const opRes = await request(app)
      .post('/api/private-evs/PEV-01/book-parking-charging')
      .set('Authorization', loginAs('operator1'))
      .send(body);
    expect(opRes.status).toBe(403);

    // 404 for another student's EV (PEV-01 belongs to student1, called by student2)
    const otherOwner = await request(app)
      .post('/api/private-evs/PEV-01/book-parking-charging')
      .set('Authorization', loginAs('student2'))
      .send(body);
    expect(otherOwner.status).toBe(404);

    // 404 for unknown EV
    const unknownEv = await request(app)
      .post('/api/private-evs/PEV-DOES-NOT-EXIST/book-parking-charging')
      .set('Authorization', loginAs('student1'))
      .send(body);
    expect(unknownEv.status).toBe(404);

    // 404 for soft-deleted (removed) EV
    const removedEv = await db.privateEv.create({
      data: {
        id: 'PEV-REMOVED',
        ownerId: 'student1',
        type: 'CAR',
        vehicleClass: 'CAR',
        label: 'Removed Car',
        batteryCapacityKwh: 50,
        batteryPct: 50,
        deletedAt: new Date(),
      },
    });
    const removedRes = await request(app)
      .post(`/api/private-evs/${removedEv.id}/book-parking-charging`)
      .set('Authorization', loginAs('student1'))
      .send(body);
    expect(removedRes.status).toBe(404);

    // 409 HAS_ACTIVE_BOOKING for EV with live charging request (PEV-01 has CR-C-001 CHARGING)
    const activeRes = await request(app)
      .post('/api/private-evs/PEV-01/book-parking-charging')
      .set('Authorization', loginAs('student1'))
      .send(body);
    expect(activeRes.status).toBe(409);
    expect(activeRes.body.error.code).toBe('HAS_ACTIVE_BOOKING');

    // Nothing booked on any of these failures
    expect(await db.parkingReservation.count()).toBe(parkingBefore);
    expect(await db.chargingRequest.count()).toBe(chargingBefore);
  });

  // ---- AC-8: Events after commit & GET /me/history ----

  it('T-21 AC-8 emits RESERVATION_CHANGED and CHARGING_QUEUE_CHANGED on commit (not on failure or replay) and shows both parts in GET /me/history', async () => {
    const ev = await createCleanEv('student1', 'CAR', 50, 'ac8');
    const resChanged: string[] = [];
    const chgChanged: string[] = [];

    events.on('RESERVATION_CHANGED', ({ hubId }) => {
      resChanged.push(hubId);
    });
    events.on('CHARGING_QUEUE_CHANGED', ({ hubId }) => {
      chgChanged.push(hubId);
    });

    // Failed request (charging missing at campus-b where CPB-CP-C-01 is FAULTY) -> 0 events
    const failRes = await request(app)
      .post(`/api/private-evs/${ev.id}/book-parking-charging`)
      .set('Authorization', loginAs('student1'))
      .send({
        hubId: 'campus-b',
        windowStart: futureIso(30 * MIN_MS),
        windowEnd: futureIso(4 * HR_MS),
        targetPct: 85,
      });
    expect(failRes.status).toBe(409);
    expect(resChanged.length).toBe(0);
    expect(chgChanged.length).toBe(0);

    // Successful request with Idempotency-Key -> 1 event each
    const key = 'idem-t21-events';
    const payload = {
      hubId: 'dorm',
      windowStart: futureIso(30 * MIN_MS),
      windowEnd: futureIso(4 * HR_MS),
      targetPct: 85,
    };

    const okRes = await request(app)
      .post(`/api/private-evs/${ev.id}/book-parking-charging`)
      .set('Authorization', loginAs('student1'))
      .set('Idempotency-Key', key)
      .send(payload);
    expect(okRes.status).toBe(201);
    expect(resChanged).toEqual(['dorm']);
    expect(chgChanged).toEqual(['dorm']);

    // Idempotent replay -> no extra events
    const replayRes = await request(app)
      .post(`/api/private-evs/${ev.id}/book-parking-charging`)
      .set('Authorization', loginAs('student1'))
      .set('Idempotency-Key', key)
      .send(payload);
    expect(replayRes.status).toBe(201);
    expect(resChanged).toEqual(['dorm']);
    expect(chgChanged).toEqual(['dorm']);

    // GET /me/history shows both parts
    const histRes = await request(app)
      .get('/api/me/history')
      .set('Authorization', loginAs('student1'));
    expect(histRes.status).toBe(200);

    const items = histRes.body.items as Array<{ kind: string; item: { id: string } }>;
    const foundParking = items.some(
      (x) => x.kind === 'parking' && x.item.id === okRes.body.parkingReservation.id,
    );
    const foundCharging = items.some(
      (x) => x.kind === 'charging' && x.item.id === okRes.body.chargingRequest.id,
    );
    expect(foundParking).toBe(true);
    expect(foundCharging).toBe(true);
  });
});
