// Checker tests for T-13 (Parking reservations).
// Written BEFORE reading the writer's code, strictly from:
//   docs/SPEC.md §3, §4, §5 BR-01, BR-03, BR-05, BR-10, BR-13, §6 FR-14–FR-19, §8 D-03, D-04, D-12, D-16
//   docs/ARCHITECTURE.md §4.1, §5.1, §5.2, §6.3
//   docs/CONTRACTS.md §0, §1, §5
//   backend/src/core/idempotency.ts
//   backend/src/modules/hubs/hubs.service.ts
//   the T-13 section of .orchestration/TASKS.md
//   backend/tests/helpers.ts
//
// Checker: Gemini (acting as Sonnet 4.6 Medium)

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import type { Application } from 'express';
import { createTestApp, resetDb, loginAs } from './helpers';
import { db } from '../src/core/db';
import { config } from '../src/core/config';
import {
  parkingTick,
  reserveParking,
} from '../src/modules/reservations/parkingReservations.service';
import type {
  ParkingReservation,
  ParkingAvailability,
} from '../src/types/reservations';

let app: Application;
let student1Token: string;
let student2Token: string;
let operatorToken: string;

beforeAll(() => {
  app = createTestApp();
  student1Token = loginAs('student1');
  student2Token = loginAs('student2');
  operatorToken = loginAs('operator1');
});

beforeEach(async () => {
  await resetDb();
  await db.parkingReservation.deleteMany();
});

// ============================================================================
// AC-1: FR-14 Availability counts PUBLIC free-for-window spaces
// ============================================================================
describe('FR-14 AC-1 availability counts PUBLIC free-for-window spaces; touching windows don\'t overlap', () => {
  it('FR-14 AC-1 availability counts PUBLIC free-for-window spaces; touching windows don\'t overlap', async () => {
    const now = new Date();
    await db.hub.update({ where: { id: 'campus-b' }, data: { lastTelemetryAt: now } });
    await db.parkingSpace.deleteMany({ where: { hubId: 'campus-b' } });

    // 4 PUBLIC MOTORCYCLE spaces
    await db.parkingSpace.createMany({
      data: [
        { id: 'PS-CB-P1', hubId: 'campus-b', vehicleClass: 'MOTORCYCLE', pool: 'PUBLIC', status: 'FREE' },
        { id: 'PS-CB-P2', hubId: 'campus-b', vehicleClass: 'MOTORCYCLE', pool: 'PUBLIC', status: 'FREE' },
        { id: 'PS-CB-P3', hubId: 'campus-b', vehicleClass: 'MOTORCYCLE', pool: 'PUBLIC', status: 'FREE' },
        { id: 'PS-CB-P4', hubId: 'campus-b', vehicleClass: 'MOTORCYCLE', pool: 'PUBLIC', status: 'FREE' },
        // FLEET space: should never count in availability
        { id: 'PS-CB-FLT', hubId: 'campus-b', vehicleClass: 'MOTORCYCLE', pool: 'FLEET', status: 'FREE' },
        // UNAVAILABLE PUBLIC space: should not count in free or total
        { id: 'PS-CB-UNAVAIL', hubId: 'campus-b', vehicleClass: 'MOTORCYCLE', pool: 'PUBLIC', status: 'UNAVAILABLE' },
        // CAR space: should not count for MOTORCYCLE query
        { id: 'PS-CB-CAR', hubId: 'campus-b', vehicleClass: 'CAR', pool: 'PUBLIC', status: 'FREE' },
      ],
    });

    const wStart1 = new Date(now.getTime() + 2 * 3600 * 1000);
    const wEnd1 = new Date(now.getTime() + 4 * 3600 * 1000);
    const queryFrom = new Date(now.getTime() + 4 * 3600 * 1000);
    const queryTo = new Date(now.getTime() + 6 * 3600 * 1000);

    // Reservations on spaces:
    // P1: CONFIRMED touching window [wStart1, wEnd1) vs queried [queryFrom, queryTo) -> does NOT overlap!
    await db.parkingReservation.create({
      data: {
        id: 'PR-TEST-1',
        userId: 'student1',
        hubId: 'campus-b',
        parkingSpaceId: 'PS-CB-P1',
        vehicleClass: 'MOTORCYCLE',
        windowStart: wStart1,
        windowEnd: wEnd1,
        status: 'CONFIRMED',
        expiresAt: new Date(wStart1.getTime() + 15 * 60000),
      },
    });

    // P2: CANCELLED overlapping [queryFrom, queryTo) -> does NOT reduce free
    await db.parkingReservation.create({
      data: {
        id: 'PR-TEST-2',
        userId: 'student1',
        hubId: 'campus-b',
        parkingSpaceId: 'PS-CB-P2',
        vehicleClass: 'MOTORCYCLE',
        windowStart: queryFrom,
        windowEnd: queryTo,
        status: 'CANCELLED',
        expiresAt: new Date(queryFrom.getTime() + 15 * 60000),
      },
    });

    // P3: EXPIRED overlapping [queryFrom, queryTo) -> does NOT reduce free
    await db.parkingReservation.create({
      data: {
        id: 'PR-TEST-3',
        userId: 'student1',
        hubId: 'campus-b',
        parkingSpaceId: 'PS-CB-P3',
        vehicleClass: 'MOTORCYCLE',
        windowStart: queryFrom,
        windowEnd: queryTo,
        status: 'EXPIRED',
        expiresAt: new Date(queryFrom.getTime() + 15 * 60000),
      },
    });

    // P4: ACTIVE overlapping [queryFrom, queryTo) -> DOES reduce free
    await db.parkingReservation.create({
      data: {
        id: 'PR-TEST-4',
        userId: 'student1',
        hubId: 'campus-b',
        parkingSpaceId: 'PS-CB-P4',
        vehicleClass: 'MOTORCYCLE',
        windowStart: queryFrom,
        windowEnd: queryTo,
        status: 'ACTIVE',
        expiresAt: new Date(queryFrom.getTime() + 15 * 60000),
      },
    });

    const res = await request(app)
      .get('/api/parking/availability')
      .query({
        hubId: 'campus-b',
        vehicleClass: 'MOTORCYCLE',
        from: queryFrom.toISOString(),
        to: queryTo.toISOString(),
      })
      .set('Authorization', student1Token);

    expect(res.status).toBe(200);
    const body: ParkingAvailability = res.body;

    expect(body.hubId).toBe('campus-b');
    expect(body.vehicleClass).toBe('MOTORCYCLE');
    expect(body.total).toBe(4); // P1, P2, P3, P4
    expect(body.free).toBe(3);  // P1 (touching), P2 (cancelled), P3 (expired)
    expect(body.alternatives).toEqual([]);

    // Now test free = 0 -> returns alternatives
    // Occupy P1, P2, P3 as well
    await db.parkingReservation.createMany({
      data: [
        { id: 'PR-FULL-1', userId: 'student2', hubId: 'campus-b', parkingSpaceId: 'PS-CB-P1', vehicleClass: 'MOTORCYCLE', windowStart: queryFrom, windowEnd: queryTo, status: 'CONFIRMED', expiresAt: new Date(queryFrom.getTime() + 15 * 60000) },
        { id: 'PR-FULL-2', userId: 'student2', hubId: 'campus-b', parkingSpaceId: 'PS-CB-P2', vehicleClass: 'MOTORCYCLE', windowStart: queryFrom, windowEnd: queryTo, status: 'CONFIRMED', expiresAt: new Date(queryFrom.getTime() + 15 * 60000) },
        { id: 'PR-FULL-3', userId: 'student2', hubId: 'campus-b', parkingSpaceId: 'PS-CB-P3', vehicleClass: 'MOTORCYCLE', windowStart: queryFrom, windowEnd: queryTo, status: 'CONFIRMED', expiresAt: new Date(queryFrom.getTime() + 15 * 60000) },
      ],
    });

    // Ensure dorm is non-DEGRADED and has a free PUBLIC space
    await db.hub.update({ where: { id: 'dorm' }, data: { lastTelemetryAt: new Date() } });
    await db.parkingSpace.deleteMany({ where: { hubId: 'dorm' } });
    await db.parkingSpace.create({
      data: { id: 'PS-DORM-PUB', hubId: 'dorm', vehicleClass: 'MOTORCYCLE', pool: 'PUBLIC', status: 'FREE' },
    });

    // Ensure service is DEGRADED even if it has a space
    await db.hub.update({
      where: { id: 'service' },
      data: {
        lastTelemetryAt: new Date(Date.now() - (config.STALLED_FEED_INTERVALS * config.TELEMETRY_INTERVAL_SEC + 10) * 1000),
      },
    });
    await db.parkingSpace.deleteMany({ where: { hubId: 'service' } });
    await db.parkingSpace.create({
      data: { id: 'PS-SVC-PUB', hubId: 'service', vehicleClass: 'MOTORCYCLE', pool: 'PUBLIC', status: 'FREE' },
    });

    const resZero = await request(app)
      .get('/api/parking/availability')
      .query({
        hubId: 'campus-b',
        vehicleClass: 'MOTORCYCLE',
        from: queryFrom.toISOString(),
        to: queryTo.toISOString(),
      })
      .set('Authorization', student1Token);

    expect(resZero.status).toBe(200);
    expect(resZero.body.free).toBe(0);
    expect(resZero.body.alternatives).toBeDefined();
    expect(Array.isArray(resZero.body.alternatives)).toBe(true);
    expect(resZero.body.alternatives.length).toBeGreaterThan(0);

    const altHubIds = resZero.body.alternatives.map((a: { hubId: string }) => a.hubId);
    expect(altHubIds).toContain('dorm');
    expect(altHubIds).not.toContain('service'); // service is DEGRADED
  });
});

// ============================================================================
// AC-2: FR-15 Window validation boundaries
// ============================================================================
describe('FR-15 AC-2 window validation boundaries', () => {
  it('FR-15 AC-2 window validation boundaries', async () => {
    const now = new Date();

    // 1. windowEnd === windowStart -> 400 details.field: 'windowEnd'
    const resSame = await request(app)
      .post('/api/parking-reservations')
      .set('Authorization', student1Token)
      .send({
        hubId: 'metro',
        vehicleClass: 'MOTORCYCLE',
        windowStart: new Date(now.getTime() + 60000).toISOString(),
        windowEnd: new Date(now.getTime() + 60000).toISOString(),
      });
    expect(resSame.status).toBe(400);
    expect(resSame.body.error.code).toBe('VALIDATION_ERROR');
    expect(resSame.body.error.details?.field).toBe('windowEnd');

    // 2. windowEnd < windowStart -> 400 details.field: 'windowEnd'
    const resBackwards = await request(app)
      .post('/api/parking-reservations')
      .set('Authorization', student1Token)
      .send({
        hubId: 'metro',
        vehicleClass: 'MOTORCYCLE',
        windowStart: new Date(now.getTime() + 120000).toISOString(),
        windowEnd: new Date(now.getTime() + 60000).toISOString(),
      });
    expect(resBackwards.status).toBe(400);
    expect(resBackwards.body.error.details?.field).toBe('windowEnd');

    // 3. length > PARKING_MAX_WINDOW_H -> 400 details.field: 'windowEnd'
    const overDurationMs = (config.PARKING_MAX_WINDOW_H * 60 + 1) * 60 * 1000;
    const resTooLong = await request(app)
      .post('/api/parking-reservations')
      .set('Authorization', student1Token)
      .send({
        hubId: 'metro',
        vehicleClass: 'MOTORCYCLE',
        windowStart: new Date(now.getTime() + 60000).toISOString(),
        windowEnd: new Date(now.getTime() + 60000 + overDurationMs).toISOString(),
      });
    expect(resTooLong.status).toBe(400);
    expect(resTooLong.body.error.details?.field).toBe('windowEnd');

    // 4. windowStart 2 minutes in past -> 400 details.field: 'windowStart'
    const resPast = await request(app)
      .post('/api/parking-reservations')
      .set('Authorization', student1Token)
      .send({
        hubId: 'metro',
        vehicleClass: 'MOTORCYCLE',
        windowStart: new Date(now.getTime() - 120000).toISOString(),
        windowEnd: new Date(now.getTime() + 60000).toISOString(),
      });
    expect(resPast.status).toBe(400);
    expect(resPast.body.error.details?.field).toBe('windowStart');

    // 5. Valid: window length exactly PARKING_MAX_WINDOW_H
    const exactMaxMs = config.PARKING_MAX_WINDOW_H * 60 * 60 * 1000;
    const resExactMax = await request(app)
      .post('/api/parking-reservations')
      .set('Authorization', student1Token)
      .send({
        hubId: 'metro',
        vehicleClass: 'MOTORCYCLE',
        windowStart: new Date(now.getTime() + 60000).toISOString(),
        windowEnd: new Date(now.getTime() + 60000 + exactMaxMs).toISOString(),
      });
    expect(resExactMax.status).toBe(201);

    // 6. Valid: windowStart = now
    const resNow = await request(app)
      .post('/api/parking-reservations')
      .set('Authorization', student1Token)
      .send({
        hubId: 'metro',
        vehicleClass: 'MOTORCYCLE',
        windowStart: new Date().toISOString(),
        windowEnd: new Date(Date.now() + 3600000).toISOString(),
      });
    expect(resNow.status).toBe(201);
  });
});

// ============================================================================
// AC-3: FR-15 reserve creates CONFIRMED hold, multiple reservations per student
// ============================================================================
describe('FR-15 AC-3 reserve creates a CONFIRMED hold that expires 15 min after window start', () => {
  it('FR-15 AC-3 reserve creates a CONFIRMED hold that expires 15 min after window start', async () => {
    const now = new Date();
    const wStart = new Date(now.getTime() + 2 * 3600 * 1000);
    const wEnd = new Date(now.getTime() + 4 * 3600 * 1000);

    const res = await request(app)
      .post('/api/parking-reservations')
      .set('Authorization', student1Token)
      .send({
        hubId: 'metro',
        vehicleClass: 'MOTORCYCLE',
        windowStart: wStart.toISOString(),
        windowEnd: wEnd.toISOString(),
      });

    expect(res.status).toBe(201);
    const body: ParkingReservation = res.body;

    expect(body.status).toBe('CONFIRMED');
    const expectedExpiry = new Date(wStart.getTime() + config.RESERVATION_HOLD_MIN * 60 * 1000);
    expect(new Date(body.expiresAt).toISOString()).toBe(expectedExpiry.toISOString());

    // Space status is unchanged until window start
    const space = await db.parkingSpace.findUniqueOrThrow({ where: { id: body.parkingSpaceId } });
    expect(space.pool).toBe('PUBLIC');
    expect(space.vehicleClass).toBe('MOTORCYCLE');
    expect(space.status).toBe('FREE');

    // BR-01: same student can make a second reservation
    const resSecond = await request(app)
      .post('/api/parking-reservations')
      .set('Authorization', student1Token)
      .send({
        hubId: 'metro',
        vehicleClass: 'MOTORCYCLE',
        windowStart: wStart.toISOString(),
        windowEnd: wEnd.toISOString(),
      });

    expect(resSecond.status).toBe(201);
    expect(resSecond.body.id).not.toBe(body.id);
    expect(resSecond.body.parkingSpaceId).not.toBe(body.parkingSpaceId);

    // Short window: shorter than RESERVATION_HOLD_MIN -> expiresAt = windowEnd
    const shortStart = new Date(now.getTime() + 3600 * 1000);
    const shortEnd = new Date(shortStart.getTime() + 10 * 60 * 1000); // 10 min < 15 min hold
    const resShort = await request(app)
      .post('/api/parking-reservations')
      .set('Authorization', student1Token)
      .send({
        hubId: 'metro',
        vehicleClass: 'MOTORCYCLE',
        windowStart: shortStart.toISOString(),
        windowEnd: shortEnd.toISOString(),
      });

    expect(resShort.status).toBe(201);
    expect(new Date(resShort.body.expiresAt).toISOString()).toBe(shortEnd.toISOString());
  });
});

// ============================================================================
// AC-4: BR-10 two concurrent reservations for the last space → one wins
// ============================================================================
describe('BR-10 AC-4 two concurrent reservations for the last space → one wins', () => {
  it('BR-10 AC-4 two concurrent reservations for the last space → one wins', async () => {
    const now = new Date();
    await db.hub.update({ where: { id: 'service' }, data: { lastTelemetryAt: now } });
    await db.parkingSpace.deleteMany({ where: { hubId: 'service' } });

    // Exactly 1 PUBLIC MOTORCYCLE space at service hub
    await db.parkingSpace.create({
      data: { id: 'PS-LAST-PARK', hubId: 'service', vehicleClass: 'MOTORCYCLE', pool: 'PUBLIC', status: 'FREE' },
    });

    const wStart = new Date(now.getTime() + 3600 * 1000).toISOString();
    const wEnd = new Date(now.getTime() + 3 * 3600 * 1000).toISOString();

    const [res1, res2] = await Promise.all([
      request(app)
        .post('/api/parking-reservations')
        .set('Authorization', student1Token)
        .send({ hubId: 'service', vehicleClass: 'MOTORCYCLE', windowStart: wStart, windowEnd: wEnd }),
      request(app)
        .post('/api/parking-reservations')
        .set('Authorization', student2Token)
        .send({ hubId: 'service', vehicleClass: 'MOTORCYCLE', windowStart: wStart, windowEnd: wEnd }),
    ]);

    const statuses = [res1.status, res2.status].sort();
    expect(statuses).toEqual([201, 409]);

    const winner = res1.status === 201 ? res1 : res2;
    const loser = res1.status === 409 ? res1 : res2;

    expect(winner.body.status).toBe('CONFIRMED');
    expect(loser.body.error.code).toBe('NO_CAPACITY');
    expect(loser.body.error.alternatives).toBeDefined();

    // Verify in DB: exactly one reservation on PS-LAST-PARK
    const rows = await db.parkingReservation.findMany({ where: { parkingSpaceId: 'PS-LAST-PARK' } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('CONFIRMED');
  });
});

// ============================================================================
// AC-5: BR-13 / privateEvId checks
// ============================================================================
describe('BR-13 AC-5 private EV class and ownership checks', () => {
  it('BR-13 AC-5 private EV class and ownership checks', async () => {
    const now = new Date();
    const wStart = new Date(now.getTime() + 3600 * 1000).toISOString();
    const wEnd = new Date(now.getTime() + 2 * 3600 * 1000).toISOString();

    // PEV-01: CAR owned by student1
    // PEV-02: MOTORCYCLE owned by student2
    // PEV-03: MOTORCYCLE owned by student1

    // 1. Class mismatch: request MOTORCYCLE with CAR EV
    const resMismatch = await request(app)
      .post('/api/parking-reservations')
      .set('Authorization', student1Token)
      .send({
        hubId: 'metro',
        vehicleClass: 'MOTORCYCLE',
        privateEvId: 'PEV-01',
        windowStart: wStart,
        windowEnd: wEnd,
      });
    expect(resMismatch.status).toBe(409);
    expect(resMismatch.body.error.code).toBe('CLASS_MISMATCH');

    // 2. Another student's EV -> 404 NOT_FOUND
    const resOther = await request(app)
      .post('/api/parking-reservations')
      .set('Authorization', student1Token)
      .send({
        hubId: 'metro',
        vehicleClass: 'MOTORCYCLE',
        privateEvId: 'PEV-02',
        windowStart: wStart,
        windowEnd: wEnd,
      });
    expect(resOther.status).toBe(404);
    expect(resOther.body.error.code).toBe('NOT_FOUND');

    // 3. Soft-deleted EV -> 404 NOT_FOUND
    await db.privateEv.update({ where: { id: 'PEV-03' }, data: { deletedAt: now } });
    const resDeleted = await request(app)
      .post('/api/parking-reservations')
      .set('Authorization', student1Token)
      .send({
        hubId: 'metro',
        vehicleClass: 'MOTORCYCLE',
        privateEvId: 'PEV-03',
        windowStart: wStart,
        windowEnd: wEnd,
      });
    expect(resDeleted.status).toBe(404);
    expect(resDeleted.body.error.code).toBe('NOT_FOUND');

    // Restore PEV-03
    await db.privateEv.update({ where: { id: 'PEV-03' }, data: { deletedAt: null } });

    // 4. Valid matching EV -> 201 with privateEvId
    const resValid = await request(app)
      .post('/api/parking-reservations')
      .set('Authorization', student1Token)
      .send({
        hubId: 'metro',
        vehicleClass: 'MOTORCYCLE',
        privateEvId: 'PEV-03',
        windowStart: wStart,
        windowEnd: wEnd,
      });
    expect(resValid.status).toBe(201);
    expect(resValid.body.privateEvId).toBe('PEV-03');
  });
});

// ============================================================================
// AC-6: NFR-08 Idempotency replay
// ============================================================================
describe('NFR-08 AC-6 idempotency replay', () => {
  it('NFR-08 AC-6 idempotency replay', async () => {
    const now = new Date();
    const wStart = new Date(now.getTime() + 3600 * 1000).toISOString();
    const wEnd = new Date(now.getTime() + 2 * 3600 * 1000).toISOString();
    const idemKey = 'uuid-parking-idem-1234';

    const res1 = await request(app)
      .post('/api/parking-reservations')
      .set('Authorization', student1Token)
      .set('Idempotency-Key', idemKey)
      .send({
        hubId: 'metro',
        vehicleClass: 'MOTORCYCLE',
        windowStart: wStart,
        windowEnd: wEnd,
      });
    expect(res1.status).toBe(201);
    const firstId = res1.body.id;

    const res2 = await request(app)
      .post('/api/parking-reservations')
      .set('Authorization', student1Token)
      .set('Idempotency-Key', idemKey)
      .send({
        hubId: 'metro',
        vehicleClass: 'MOTORCYCLE',
        windowStart: wStart,
        windowEnd: wEnd,
      });
    expect(res2.status).toBe(201);
    expect(res2.body.id).toBe(firstId);

    // Exactly 1 row in DB
    const count = await db.parkingReservation.count({ where: { id: firstId } });
    expect(count).toBe(1);
  });
});

// ============================================================================
// AC-7: FR-16 Cancel rules
// ============================================================================
describe('FR-16 AC-7 cancel rules', () => {
  it('FR-16 AC-7 cancel rules', async () => {
    const now = new Date();
    const wStartFuture = new Date(now.getTime() + 3600 * 1000);
    const wEndFuture = new Date(now.getTime() + 2 * 3600 * 1000);

    // 1. Cancel CONFIRMED before window start: space was FREE, stays FREE
    const createRes = await request(app)
      .post('/api/parking-reservations')
      .set('Authorization', student1Token)
      .send({
        hubId: 'metro',
        vehicleClass: 'MOTORCYCLE',
        windowStart: wStartFuture.toISOString(),
        windowEnd: wEndFuture.toISOString(),
      });
    const resvId = createRes.body.id;
    const spaceId = createRes.body.parkingSpaceId;

    const cancelRes = await request(app)
      .post(`/api/parking-reservations/${resvId}/cancel`)
      .set('Authorization', student1Token);
    expect(cancelRes.status).toBe(200);
    expect(cancelRes.body.status).toBe('CANCELLED');

    const spaceAfter1 = await db.parkingSpace.findUniqueOrThrow({ where: { id: spaceId } });
    expect(spaceAfter1.status).toBe('FREE');

    // 2. Cancel CONFIRMED after window started (space was RESERVED) -> space becomes FREE
    await db.parkingSpace.update({ where: { id: spaceId }, data: { status: 'RESERVED' } });
    await db.parkingReservation.create({
      data: {
        id: 'PR-STARTED-1',
        userId: 'student1',
        hubId: 'metro',
        parkingSpaceId: spaceId,
        vehicleClass: 'MOTORCYCLE',
        windowStart: new Date(now.getTime() - 60000), // started
        windowEnd: wEndFuture,
        status: 'CONFIRMED',
        expiresAt: new Date(now.getTime() + 60000),
      },
    });

    const cancelStartedRes = await request(app)
      .post('/api/parking-reservations/PR-STARTED-1/cancel')
      .set('Authorization', student1Token);
    expect(cancelStartedRes.status).toBe(200);
    expect(cancelStartedRes.body.status).toBe('CANCELLED');

    const spaceAfter2 = await db.parkingSpace.findUniqueOrThrow({ where: { id: spaceId } });
    expect(spaceAfter2.status).toBe('FREE');

    // 3. Cancel non-CONFIRMED -> 409 INVALID_STATE_TRANSITION
    const statuses = ['ACTIVE', 'CANCELLED', 'EXPIRED', 'COMPLETED'] as const;
    for (const st of statuses) {
      await db.parkingReservation.create({
        data: {
          id: `PR-ST-${st}`,
          userId: 'student1',
          hubId: 'metro',
          parkingSpaceId: spaceId,
          vehicleClass: 'MOTORCYCLE',
          windowStart: wStartFuture,
          windowEnd: wEndFuture,
          status: st,
          expiresAt: new Date(now.getTime() + 60000),
        },
      });

      const resSt = await request(app)
        .post(`/api/parking-reservations/PR-ST-${st}/cancel`)
        .set('Authorization', student1Token);
      expect(resSt.status).toBe(409);
      expect(resSt.body.error.code).toBe('INVALID_STATE_TRANSITION');
    }

    // 4. Cancel another student's reservation -> 404 NOT_FOUND
    await db.parkingSpace.create({
      data: { id: 'PS-OTHER-SPACE', hubId: 'metro', vehicleClass: 'MOTORCYCLE', pool: 'PUBLIC', status: 'FREE' },
    });
    await db.parkingReservation.create({
      data: {
        id: 'PR-OTHER-USER',
        userId: 'student2',
        hubId: 'metro',
        parkingSpaceId: 'PS-OTHER-SPACE',
        vehicleClass: 'MOTORCYCLE',
        windowStart: wStartFuture,
        windowEnd: wEndFuture,
        status: 'CONFIRMED',
        expiresAt: new Date(now.getTime() + 60000),
      },
    });

    const resOther = await request(app)
      .post('/api/parking-reservations/PR-OTHER-USER/cancel')
      .set('Authorization', student1Token);
    expect(resOther.status).toBe(404);
  });
});

// ============================================================================
// AC-8: FR-17 Change window is all-or-nothing
// ============================================================================
describe('FR-17 AC-8 change window is all-or-nothing', () => {
  it('FR-17 AC-8 change window is all-or-nothing', async () => {
    const now = new Date();
    const wStart = new Date(now.getTime() + 2 * 3600 * 1000);
    const wEnd = new Date(now.getTime() + 4 * 3600 * 1000);

    const createRes = await request(app)
      .post('/api/parking-reservations')
      .set('Authorization', student1Token)
      .send({
        hubId: 'metro',
        vehicleClass: 'MOTORCYCLE',
        windowStart: wStart.toISOString(),
        windowEnd: wEnd.toISOString(),
      });
    const resvId = createRes.body.id;

    // 1. Change to a free window -> 200 with new window and updated expiresAt
    const newStart = new Date(now.getTime() + 5 * 3600 * 1000);
    const newEnd = new Date(now.getTime() + 7 * 3600 * 1000);
    const changeRes = await request(app)
      .patch(`/api/parking-reservations/${resvId}`)
      .set('Authorization', student1Token)
      .send({
        windowStart: newStart.toISOString(),
        windowEnd: newEnd.toISOString(),
      });

    expect(changeRes.status).toBe(200);
    expect(new Date(changeRes.body.windowStart).toISOString()).toBe(newStart.toISOString());
    expect(new Date(changeRes.body.windowEnd).toISOString()).toBe(newEnd.toISOString());
    const expectedNewExpiry = new Date(newStart.getTime() + config.RESERVATION_HOLD_MIN * 60 * 1000);
    expect(new Date(changeRes.body.expiresAt).toISOString()).toBe(expectedNewExpiry.toISOString());

    // 2. Change to a window where Hub is full -> 409 NO_CAPACITY with alternatives
    // Isolate campus-a with 1 PUBLIC space occupied
    await db.hub.update({ where: { id: 'campus-a' }, data: { lastTelemetryAt: now } });
    await db.parkingSpace.deleteMany({ where: { hubId: 'campus-a' } });
    await db.parkingSpace.create({
      data: { id: 'PS-CPA-1', hubId: 'campus-a', vehicleClass: 'MOTORCYCLE', pool: 'PUBLIC', status: 'FREE' },
    });
    // Create reservation for student1 at campus-a
    await db.parkingReservation.create({
      data: {
        id: 'PR-CPA-CHANGE',
        userId: 'student1',
        hubId: 'campus-a',
        parkingSpaceId: 'PS-CPA-1',
        vehicleClass: 'MOTORCYCLE',
        windowStart: newStart,
        windowEnd: newEnd,
        status: 'CONFIRMED',
        expiresAt: expectedNewExpiry,
      },
    });
    // Another reservation fills the alternative slot [8h, 10h]
    const fullStart = new Date(now.getTime() + 8 * 3600 * 1000);
    const fullEnd = new Date(now.getTime() + 10 * 3600 * 1000);
    await db.parkingReservation.create({
      data: {
        id: 'PR-CPA-BLOCKER',
        userId: 'student2',
        hubId: 'campus-a',
        parkingSpaceId: 'PS-CPA-1',
        vehicleClass: 'MOTORCYCLE',
        windowStart: fullStart,
        windowEnd: fullEnd,
        status: 'CONFIRMED',
        expiresAt: new Date(fullStart.getTime() + 15 * 60000),
      },
    });

    const fullChangeRes = await request(app)
      .patch('/api/parking-reservations/PR-CPA-CHANGE')
      .set('Authorization', student1Token)
      .send({
        windowStart: fullStart.toISOString(),
        windowEnd: fullEnd.toISOString(),
      });
    expect(fullChangeRes.status).toBe(409);
    expect(fullChangeRes.body.error.code).toBe('NO_CAPACITY');
    expect(fullChangeRes.body.error.alternatives).toBeDefined();

    // Original unchanged in DB
    const cpaRow = await db.parkingReservation.findUniqueOrThrow({ where: { id: 'PR-CPA-CHANGE' } });
    expect(cpaRow.windowStart.toISOString()).toBe(newStart.toISOString());
    expect(cpaRow.windowEnd.toISOString()).toBe(newEnd.toISOString());

    // 3. Change after window has started -> 409 NOT_ELIGIBLE
    await db.parkingReservation.update({
      where: { id: resvId },
      data: { windowStart: new Date(now.getTime() - 60000) },
    });
    const startedChangeRes = await request(app)
      .patch(`/api/parking-reservations/${resvId}`)
      .set('Authorization', student1Token)
      .send({
        windowStart: new Date(now.getTime() + 3600000).toISOString(),
        windowEnd: new Date(now.getTime() + 7200000).toISOString(),
      });
    expect(startedChangeRes.status).toBe(409);
    expect(startedChangeRes.body.error.code).toBe('NOT_ELIGIBLE');
  });
});

// ============================================================================
// AC-9: FR-18 Claim window, HOLD_EXPIRED, leave, occupied space check
// ============================================================================
describe('FR-18 AC-9 claim window, HOLD_EXPIRED, leave', () => {
  it('FR-18 AC-9 claim window, HOLD_EXPIRED, leave', async () => {
    const now = new Date();

    // 1. Claim before windowStart -> 409 with details.opensAt
    const futureStart = new Date(now.getTime() + 3600 * 1000);
    const futureEnd = new Date(now.getTime() + 2 * 3600 * 1000);
    const futRes = await request(app)
      .post('/api/parking-reservations')
      .set('Authorization', student1Token)
      .send({
        hubId: 'metro',
        vehicleClass: 'MOTORCYCLE',
        windowStart: futureStart.toISOString(),
        windowEnd: futureEnd.toISOString(),
      });
    const futId = futRes.body.id;

    const earlyClaim = await request(app)
      .post(`/api/parking-reservations/${futId}/claim`)
      .set('Authorization', student1Token);
    expect(earlyClaim.status).toBe(409);
    expect(earlyClaim.body.error.details?.opensAt).toBeDefined();

    // 2. Claim between windowStart and expiresAt -> ACTIVE, space OCCUPIED
    const activeStart = new Date(now.getTime() - 60000);
    const activeEnd = new Date(now.getTime() + 3600 * 1000);
    const activeExp = new Date(now.getTime() + 14 * 60000);
    await db.parkingReservation.update({
      where: { id: futId },
      data: { windowStart: activeStart, windowEnd: activeEnd, expiresAt: activeExp },
    });

    const validClaim = await request(app)
      .post(`/api/parking-reservations/${futId}/claim`)
      .set('Authorization', student1Token);
    expect(validClaim.status).toBe(200);
    expect(validClaim.body.status).toBe('ACTIVE');
    expect(validClaim.body.claimedAt).not.toBeNull();

    const spaceAfterClaim = await db.parkingSpace.findUniqueOrThrow({ where: { id: futRes.body.parkingSpaceId } });
    expect(spaceAfterClaim.status).toBe('OCCUPIED');

    // 3. Leave -> COMPLETED, space FREE
    const leaveRes = await request(app)
      .post(`/api/parking-reservations/${futId}/leave`)
      .set('Authorization', student1Token);
    expect(leaveRes.status).toBe(200);
    expect(leaveRes.body.status).toBe('COMPLETED');

    const spaceAfterLeave = await db.parkingSpace.findUniqueOrThrow({ where: { id: futRes.body.parkingSpaceId } });
    expect(spaceAfterLeave.status).toBe('FREE');

    // 4. Claim after expiresAt -> 409 HOLD_EXPIRED and row is EXPIRED
    await db.parkingReservation.create({
      data: {
        id: 'PR-EXPIRED-CLAIM',
        userId: 'student1',
        hubId: 'metro',
        parkingSpaceId: futRes.body.parkingSpaceId,
        vehicleClass: 'MOTORCYCLE',
        windowStart: new Date(now.getTime() - 3600000),
        windowEnd: new Date(now.getTime() + 3600000),
        status: 'CONFIRMED',
        expiresAt: new Date(now.getTime() - 1000), // hold expired
      },
    });

    const lateClaim = await request(app)
      .post('/api/parking-reservations/PR-EXPIRED-CLAIM/claim')
      .set('Authorization', student1Token);
    expect(lateClaim.status).toBe(409);
    expect(lateClaim.body.error.code).toBe('HOLD_EXPIRED');

    const expRow = await db.parkingReservation.findUniqueOrThrow({ where: { id: 'PR-EXPIRED-CLAIM' } });
    expect(expRow.status).toBe('EXPIRED');

    // 5. Claim when space is still OCCUPIED by ended-but-not-completed window
    // -> 409 NOT_ELIGIBLE, nothing changed, no INVALID_TRANSITION audit row
    await db.parkingSpace.create({
      data: { id: 'PS-OCC-CLAIM', hubId: 'metro', vehicleClass: 'MOTORCYCLE', pool: 'PUBLIC', status: 'OCCUPIED' },
    });
    await db.parkingReservation.create({
      data: {
        id: 'PR-OCC-BLOCKED',
        userId: 'student1',
        hubId: 'metro',
        parkingSpaceId: 'PS-OCC-CLAIM',
        vehicleClass: 'MOTORCYCLE',
        windowStart: new Date(now.getTime() - 60000),
        windowEnd: new Date(now.getTime() + 3600000),
        status: 'CONFIRMED',
        expiresAt: new Date(now.getTime() + 600000),
      },
    });

    const auditsBefore = await db.auditLog.count({ where: { action: 'INVALID_TRANSITION' } });

    const occClaim = await request(app)
      .post('/api/parking-reservations/PR-OCC-BLOCKED/claim')
      .set('Authorization', student1Token);
    expect(occClaim.status).toBe(409);
    expect(occClaim.body.error.code).toBe('NOT_ELIGIBLE');

    const auditsAfter = await db.auditLog.count({ where: { action: 'INVALID_TRANSITION' } });
    expect(auditsAfter).toBe(auditsBefore); // No INVALID_TRANSITION audit row
  });
});

// ============================================================================
// AC-10: FR-18 parkingTick: start, expiry + notification, window end
// ============================================================================
describe('FR-18 AC-10 parking tick: start, expiry + notification, window end', () => {
  it('FR-18 AC-10 parking tick: start, expiry + notification, window end', async () => {
    const now = new Date('2026-06-01T12:00:00.000Z');

    await db.parkingSpace.create({
      data: { id: 'PS-TICK-1', hubId: 'metro', vehicleClass: 'MOTORCYCLE', pool: 'PUBLIC', status: 'FREE' },
    });
    await db.parkingSpace.create({
      data: { id: 'PS-TICK-2', hubId: 'metro', vehicleClass: 'MOTORCYCLE', pool: 'PUBLIC', status: 'RESERVED' },
    });
    await db.parkingSpace.create({
      data: { id: 'PS-TICK-3', hubId: 'metro', vehicleClass: 'MOTORCYCLE', pool: 'PUBLIC', status: 'OCCUPIED' },
    });

    // 1. Window started: CONFIRMED with windowStart <= now < expiresAt -> space RESERVED
    await db.parkingReservation.create({
      data: {
        id: 'PR-TK-START',
        userId: 'student1',
        hubId: 'metro',
        parkingSpaceId: 'PS-TICK-1',
        vehicleClass: 'MOTORCYCLE',
        windowStart: new Date('2026-06-01T11:55:00.000Z'),
        windowEnd: new Date('2026-06-01T14:00:00.000Z'),
        status: 'CONFIRMED',
        expiresAt: new Date('2026-06-01T12:10:00.000Z'),
      },
    });

    // 2. Unclaimed past expiresAt: CONFIRMED with expiresAt <= now -> EXPIRED, space FREE, notify
    await db.parkingReservation.create({
      data: {
        id: 'PR-TK-EXP',
        userId: 'student2',
        hubId: 'metro',
        parkingSpaceId: 'PS-TICK-2',
        vehicleClass: 'MOTORCYCLE',
        windowStart: new Date('2026-06-01T11:40:00.000Z'),
        windowEnd: new Date('2026-06-01T14:00:00.000Z'),
        status: 'CONFIRMED',
        expiresAt: new Date('2026-06-01T11:55:00.000Z'),
      },
    });

    // 3. ACTIVE past windowEnd: ACTIVE with windowEnd <= now -> COMPLETED, space FREE
    await db.parkingReservation.create({
      data: {
        id: 'PR-TK-END',
        userId: 'student1',
        hubId: 'metro',
        parkingSpaceId: 'PS-TICK-3',
        vehicleClass: 'MOTORCYCLE',
        windowStart: new Date('2026-06-01T10:00:00.000Z'),
        windowEnd: new Date('2026-06-01T12:00:00.000Z'),
        status: 'ACTIVE',
        expiresAt: new Date('2026-06-01T10:15:00.000Z'),
      },
    });

    await parkingTick(now);

    // Verify Pass 1 (Window start): space becomes RESERVED
    const s1After = await db.parkingSpace.findUniqueOrThrow({ where: { id: 'PS-TICK-1' } });
    expect(s1After.status).toBe('RESERVED');

    // Verify Pass 2 (Unclaimed): reservation EXPIRED, space FREE, notification row created
    const r2After = await db.parkingReservation.findUniqueOrThrow({ where: { id: 'PR-TK-EXP' } });
    expect(r2After.status).toBe('EXPIRED');
    const s2After = await db.parkingSpace.findUniqueOrThrow({ where: { id: 'PS-TICK-2' } });
    expect(s2After.status).toBe('FREE');

    const notif = await db.notification.findFirst({
      where: { userId: 'student2', type: 'RESERVATION_EXPIRED' },
    });
    expect(notif).not.toBeNull();

    // Verify Pass 3 (Window end): reservation COMPLETED, space FREE
    const r3After = await db.parkingReservation.findUniqueOrThrow({ where: { id: 'PR-TK-END' } });
    expect(r3After.status).toBe('COMPLETED');
    const s3After = await db.parkingSpace.findUniqueOrThrow({ where: { id: 'PS-TICK-3' } });
    expect(s3After.status).toBe('FREE');

    // EXPIRED row cannot be claimed or cancelled afterwards
    const claimRes = await request(app)
      .post('/api/parking-reservations/PR-TK-EXP/claim')
      .set('Authorization', student2Token);
    expect(claimRes.status).toBe(409);

    const cancelRes = await request(app)
      .post('/api/parking-reservations/PR-TK-EXP/cancel')
      .set('Authorization', student2Token);
    expect(cancelRes.status).toBe(409);

    // 4. Touching window case:
    // ACTIVE [10:00, 12:00) and CONFIRMED [12:00, 14:00) on one space, tick at 12:00
    // -> first COMPLETED, second's space RESERVED in the same tick!
    await db.parkingSpace.create({
      data: { id: 'PS-TOUCH-SP', hubId: 'metro', vehicleClass: 'MOTORCYCLE', pool: 'PUBLIC', status: 'OCCUPIED' },
    });

    await db.parkingReservation.create({
      data: {
        id: 'PR-TOUCH-ACTIVE',
        userId: 'student1',
        hubId: 'metro',
        parkingSpaceId: 'PS-TOUCH-SP',
        vehicleClass: 'MOTORCYCLE',
        windowStart: new Date('2026-06-01T10:00:00.000Z'),
        windowEnd: new Date('2026-06-01T12:00:00.000Z'),
        status: 'ACTIVE',
        expiresAt: new Date('2026-06-01T10:15:00.000Z'),
      },
    });

    await db.parkingReservation.create({
      data: {
        id: 'PR-TOUCH-CONF',
        userId: 'student2',
        hubId: 'metro',
        parkingSpaceId: 'PS-TOUCH-SP',
        vehicleClass: 'MOTORCYCLE',
        windowStart: new Date('2026-06-01T12:00:00.000Z'),
        windowEnd: new Date('2026-06-01T14:00:00.000Z'),
        status: 'CONFIRMED',
        expiresAt: new Date('2026-06-01T12:15:00.000Z'),
      },
    });

    await parkingTick(new Date('2026-06-01T12:00:00.000Z'));

    const touchActiveAfter = await db.parkingReservation.findUniqueOrThrow({ where: { id: 'PR-TOUCH-ACTIVE' } });
    expect(touchActiveAfter.status).toBe('COMPLETED');

    const touchConfAfter = await db.parkingReservation.findUniqueOrThrow({ where: { id: 'PR-TOUCH-CONF' } });
    expect(touchConfAfter.status).toBe('CONFIRMED');

    const touchSpaceAfter = await db.parkingSpace.findUniqueOrThrow({ where: { id: 'PS-TOUCH-SP' } });
    expect(touchSpaceAfter.status).toBe('RESERVED');
  });
});

// ============================================================================
// AC-11: BR-10 claim racing the tick has one outcome
// ============================================================================
describe('BR-10 AC-11 claim racing the tick has one outcome', () => {
  it('BR-10 AC-11 claim racing the tick has one outcome', async () => {
    const now = new Date('2026-06-01T12:15:00.000Z');

    await db.parkingSpace.create({
      data: { id: 'PS-RACE-CLAIM', hubId: 'metro', vehicleClass: 'MOTORCYCLE', pool: 'PUBLIC', status: 'RESERVED' },
    });

    await db.parkingReservation.create({
      data: {
        id: 'PR-RACE-CLAIM',
        userId: 'student1',
        hubId: 'metro',
        parkingSpaceId: 'PS-RACE-CLAIM',
        vehicleClass: 'MOTORCYCLE',
        windowStart: new Date('2026-06-01T12:00:00.000Z'),
        windowEnd: new Date('2026-06-01T14:00:00.000Z'),
        status: 'CONFIRMED',
        expiresAt: now, // just-due hold
      },
    });

    const [claimRes, _tickResult] = await Promise.all([
      request(app)
        .post('/api/parking-reservations/PR-RACE-CLAIM/claim')
        .set('Authorization', student1Token),
      parkingTick(now),
    ]);

    const resvAfter = await db.parkingReservation.findUniqueOrThrow({ where: { id: 'PR-RACE-CLAIM' } });
    const spaceAfter = await db.parkingSpace.findUniqueOrThrow({ where: { id: 'PS-RACE-CLAIM' } });

    if (claimRes.status === 200) {
      // Claim committed first
      expect(resvAfter.status).toBe('ACTIVE');
      expect(spaceAfter.status).toBe('OCCUPIED');
    } else {
      // Tick committed first
      expect(claimRes.status).toBe(409);
      expect(resvAfter.status).toBe('EXPIRED');
      expect(spaceAfter.status).toBe('FREE');
    }
  });
});

// ============================================================================
// AC-12: FR-61 Operator gets 403, missing token gets 401
// ============================================================================
describe('FR-61 AC-12 operator gets 403', () => {
  it('FR-61 AC-12 operator gets 403', async () => {
    // 1. Operator gets 403 FORBIDDEN
    const opAvail = await request(app)
      .get('/api/parking/availability')
      .set('Authorization', operatorToken)
      .query({ hubId: 'metro', vehicleClass: 'MOTORCYCLE', from: new Date().toISOString(), to: new Date(Date.now() + 3600000).toISOString() });
    expect(opAvail.status).toBe(403);
    expect(opAvail.body.error.code).toBe('FORBIDDEN');

    const opResv = await request(app)
      .post('/api/parking-reservations')
      .set('Authorization', operatorToken)
      .send({ hubId: 'metro', vehicleClass: 'MOTORCYCLE', windowStart: new Date().toISOString(), windowEnd: new Date(Date.now() + 3600000).toISOString() });
    expect(opResv.status).toBe(403);

    const opCancel = await request(app)
      .post('/api/parking-reservations/DUMMY/cancel')
      .set('Authorization', operatorToken);
    expect(opCancel.status).toBe(403);

    const opPatch = await request(app)
      .patch('/api/parking-reservations/DUMMY')
      .set('Authorization', operatorToken)
      .send({ windowStart: new Date().toISOString(), windowEnd: new Date(Date.now() + 3600000).toISOString() });
    expect(opPatch.status).toBe(403);

    const opClaim = await request(app)
      .post('/api/parking-reservations/DUMMY/claim')
      .set('Authorization', operatorToken);
    expect(opClaim.status).toBe(403);

    const opLeave = await request(app)
      .post('/api/parking-reservations/DUMMY/leave')
      .set('Authorization', operatorToken);
    expect(opLeave.status).toBe(403);

    // 2. Missing token gets 401 UNAUTHENTICATED
    const anonAvail = await request(app).get('/api/parking/availability');
    expect(anonAvail.status).toBe(401);

    const anonResv = await request(app).post('/api/parking-reservations').send({});
    expect(anonResv.status).toBe(401);
  });
});

// ============================================================================
// Extra: Direct service call checks
// ============================================================================
describe('Direct service call: reserveParking options constraints', () => {
  it('reserveParking called with both opts.tx and opts.idemKey throws', async () => {
    const now = new Date();
    await db.$transaction(async (tx) => {
      await expect(
        reserveParking(
          'student1',
          {
            hubId: 'metro',
            vehicleClass: 'MOTORCYCLE',
            windowStart: new Date(now.getTime() + 3600000),
            windowEnd: new Date(now.getTime() + 7200000),
          },
          { tx, idemKey: 'my-test-key' },
        ),
      ).rejects.toThrow(/cannot combine opts\.tx with opts\.idemKey/);
    });
  });
});
