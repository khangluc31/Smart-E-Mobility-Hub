// Checker tests for T-12 (Vehicle reservations part 2: pick-up and return).
// Written BEFORE reading the writer's code, strictly from:
//   docs/SPEC.md §3, §4, §5 BR-02, BR-04, BR-05, BR-10, BR-13, §6 FR-11, FR-12, FR-19, §8 D-03, D-04, D-12, D-13, D-14, D-16, D-17
//   docs/ARCHITECTURE.md §4.1, §5.1, §6.2
//   docs/CONTRACTS.md §0, §1, §4
//   backend/src/modules/hubs/hubs.service.ts, hubs.metrics.ts
//   the T-12 section of .orchestration/TASKS.md
//   backend/tests/helpers.ts
//
// Checker: Gemini (acting as Sonnet 4.6 Medium)

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import type { Application } from 'express';
import { createTestApp, resetDb, loginAs } from './helpers';
import { db } from '../src/core/db';
import { config } from '../src/core/config';
import { expireVehicleHolds } from '../src/modules/reservations/vehicleReservations.service';
import type { VehicleReservation, VehicleReturnResult } from '../src/types/reservations';

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
  await db.vehicleReservation.deleteMany();
});

/**
 * Rule 5 / D-04 Invariant check:
 * After every successful pick-up/return:
 * 1. No vehicle points at a FREE space.
 * 2. No OCCUPIED FLEET space is left without a rental_vehicle occupying it.
 */
async function assertDerivedCountsInvariant(): Promise<void> {
  const invalidVehicle = await db.rentalVehicle.findFirst({
    where: {
      parkingSpace: {
        status: 'FREE',
      },
    },
    include: { parkingSpace: true },
  });
  expect(invalidVehicle, 'No rental_vehicle should point to a FREE parking space').toBeNull();

  const orphanFleetSpaces = await db.parkingSpace.findMany({
    where: {
      pool: 'FLEET',
      status: 'OCCUPIED',
      occupant: null,
    },
  });
  expect(orphanFleetSpaces, 'No OCCUPIED FLEET space should be without a rental vehicle').toHaveLength(0);
}

// ============================================================================
// AC-1: FR-11 pick-up activates rental and frees the FLEET space
// ============================================================================
describe('FR-11 AC-1 pick-up activates the rental and frees the FLEET space', () => {
  it('FR-11 AC-1 pick-up activates the rental and frees the FLEET space', async () => {
    const now = new Date();

    // Setup: Space PS-PU-1 (FLEET, OCCUPIED) holding RV-PU-1 (RESERVED)
    await db.parkingSpace.create({
      data: {
        id: 'PS-PU-1',
        hubId: 'metro',
        vehicleClass: 'MOTORCYCLE',
        pool: 'FLEET',
        status: 'OCCUPIED',
      },
    });

    await db.rentalVehicle.create({
      data: {
        id: 'RV-PU-1',
        hubId: 'metro',
        type: 'E_BICYCLE',
        vehicleClass: 'MOTORCYCLE',
        status: 'RESERVED',
        batteryPct: 85,
        parkingSpaceId: 'PS-PU-1',
      },
    });

    await db.vehicleReservation.create({
      data: {
        id: 'VR-PU-1',
        userId: 'student1',
        rentalVehicleId: 'RV-PU-1',
        hubId: 'metro',
        status: 'CONFIRMED',
        expiresAt: new Date(now.getTime() + config.RESERVATION_HOLD_MIN * 60 * 1000),
      },
    });

    const res = await request(app)
      .post('/api/vehicle-reservations/VR-PU-1/pickup')
      .set('Authorization', student1Token);

    expect(res.status).toBe(200);
    const body: VehicleReservation = res.body;

    expect(body.id).toBe('VR-PU-1');
    expect(body.status).toBe('ACTIVE');
    expect(body.pickedUpAt).not.toBeNull();
    expect(body.startBatteryPct).toBe(85);
    expect(body.vehicle.status).toBe('IN_USE');

    // DB asserts
    const resvAfter = await db.vehicleReservation.findUniqueOrThrow({ where: { id: 'VR-PU-1' } });
    expect(resvAfter.status).toBe('ACTIVE');
    expect(resvAfter.pickedUpAt).not.toBeNull();
    expect(resvAfter.startBatteryPct).toBe(85);

    const vehAfter = await db.rentalVehicle.findUniqueOrThrow({ where: { id: 'RV-PU-1' } });
    expect(vehAfter.status).toBe('IN_USE');
    expect(vehAfter.parkingSpaceId).toBeNull();

    const spaceAfter = await db.parkingSpace.findUniqueOrThrow({ where: { id: 'PS-PU-1' } });
    expect(spaceAfter.status).toBe('FREE');

    await assertDerivedCountsInvariant();
  });
});

// ============================================================================
// AC-2: FR-11 late, finished, faulty and foreign pick-ups are rejected
// ============================================================================
describe('FR-11 AC-2 late, finished, faulty and foreign pick-ups are rejected', () => {
  it('FR-11 AC-2 late, finished, faulty and foreign pick-ups are rejected', async () => {
    const now = new Date();

    // 1. Late pick-up (expiresAt in past)
    await db.parkingSpace.create({
      data: { id: 'PS-PU-LATE', hubId: 'metro', vehicleClass: 'MOTORCYCLE', pool: 'FLEET', status: 'OCCUPIED' },
    });
    await db.rentalVehicle.create({
      data: { id: 'RV-PU-LATE', hubId: 'metro', type: 'E_BICYCLE', vehicleClass: 'MOTORCYCLE', status: 'RESERVED', batteryPct: 80, parkingSpaceId: 'PS-PU-LATE' },
    });
    await db.vehicleReservation.create({
      data: {
        id: 'VR-PU-LATE',
        userId: 'student1',
        rentalVehicleId: 'RV-PU-LATE',
        hubId: 'metro',
        status: 'CONFIRMED',
        expiresAt: new Date(now.getTime() - 1000), // past
      },
    });

    const lateRes = await request(app)
      .post('/api/vehicle-reservations/VR-PU-LATE/pickup')
      .set('Authorization', student1Token);

    expect(lateRes.status).toBe(409);
    expect(lateRes.body.error.code).toBe('HOLD_EXPIRED');

    // Afterwards reservation is EXPIRED and vehicle is AVAILABLE
    const lateResv = await db.vehicleReservation.findUniqueOrThrow({ where: { id: 'VR-PU-LATE' } });
    expect(lateResv.status).toBe('EXPIRED');
    const lateVeh = await db.rentalVehicle.findUniqueOrThrow({ where: { id: 'RV-PU-LATE' } });
    expect(lateVeh.status).toBe('AVAILABLE');

    // 2. Finished/Invalid state pick-ups
    const statuses = ['CANCELLED', 'EXPIRED', 'ACTIVE', 'COMPLETED'] as const;
    for (const st of statuses) {
      await db.vehicleReservation.deleteMany({ where: { userId: 'student1' } });
      await db.rentalVehicle.create({
        data: { id: `RV-ST-${st}`, hubId: 'metro', type: 'E_BICYCLE', vehicleClass: 'MOTORCYCLE', status: 'AVAILABLE', batteryPct: 80 },
      });
      await db.vehicleReservation.create({
        data: {
          id: `VR-ST-${st}`,
          userId: 'student1',
          rentalVehicleId: `RV-ST-${st}`,
          hubId: 'metro',
          status: st,
          expiresAt: new Date(now.getTime() + 60000),
        },
      });

      const stRes = await request(app)
        .post(`/api/vehicle-reservations/VR-ST-${st}/pickup`)
        .set('Authorization', student1Token);
      expect(stRes.status).toBe(409);
      expect(stRes.body.error.code).toBe('INVALID_STATE_TRANSITION');
    }

    await db.vehicleReservation.deleteMany({ where: { userId: 'student1' } });

    // 3. FAULTY vehicle
    await db.rentalVehicle.create({
      data: { id: 'RV-PU-FAULTY', hubId: 'metro', type: 'E_BICYCLE', vehicleClass: 'MOTORCYCLE', status: 'FAULTY', batteryPct: 80 },
    });
    await db.vehicleReservation.create({
      data: {
        id: 'VR-PU-FAULTY',
        userId: 'student1',
        rentalVehicleId: 'RV-PU-FAULTY',
        hubId: 'metro',
        status: 'CONFIRMED',
        expiresAt: new Date(now.getTime() + 60000),
      },
    });

    const faultyRes = await request(app)
      .post('/api/vehicle-reservations/VR-PU-FAULTY/pickup')
      .set('Authorization', student1Token);
    expect(faultyRes.status).toBe(409);
    expect(faultyRes.body.error.code).toBe('NOT_ELIGIBLE');

    // State unchanged
    const faultyVeh = await db.rentalVehicle.findUniqueOrThrow({ where: { id: 'RV-PU-FAULTY' } });
    expect(faultyVeh.status).toBe('FAULTY');
    const faultyResv = await db.vehicleReservation.findUniqueOrThrow({ where: { id: 'VR-PU-FAULTY' } });
    expect(faultyResv.status).toBe('CONFIRMED');

    // 4. Another student's id
    await db.rentalVehicle.create({
      data: { id: 'RV-PU-OTHER', hubId: 'metro', type: 'E_BICYCLE', vehicleClass: 'MOTORCYCLE', status: 'RESERVED', batteryPct: 80 },
    });
    await db.vehicleReservation.create({
      data: {
        id: 'VR-PU-OTHER',
        userId: 'student2',
        rentalVehicleId: 'RV-PU-OTHER',
        hubId: 'metro',
        status: 'CONFIRMED',
        expiresAt: new Date(now.getTime() + 60000),
      },
    });

    const otherRes = await request(app)
      .post('/api/vehicle-reservations/VR-PU-OTHER/pickup')
      .set('Authorization', student1Token);
    expect(otherRes.status).toBe(404);
    expect(otherRes.body.error.code).toBe('NOT_FOUND');

    // Unknown id -> same 404
    const unknownRes = await request(app)
      .post('/api/vehicle-reservations/VR-DOES-NOT-EXIST/pickup')
      .set('Authorization', student1Token);
    expect(unknownRes.status).toBe(404);
    expect(unknownRes.body.error.code).toBe('NOT_FOUND');
  });
});

// ============================================================================
// AC-3: BR-10 pick-up racing the expiry job has exactly one outcome
// ============================================================================
describe('BR-10 AC-3 pick-up racing the expiry job has exactly one outcome', () => {
  it('BR-10 AC-3 pick-up racing the expiry job has exactly one outcome', async () => {
    const now = new Date();

    await db.parkingSpace.create({
      data: { id: 'PS-RACE-1', hubId: 'metro', vehicleClass: 'MOTORCYCLE', pool: 'FLEET', status: 'OCCUPIED' },
    });
    await db.rentalVehicle.create({
      data: { id: 'RV-RACE-1', hubId: 'metro', type: 'E_BICYCLE', vehicleClass: 'MOTORCYCLE', status: 'RESERVED', batteryPct: 80, parkingSpaceId: 'PS-RACE-1' },
    });
    await db.vehicleReservation.create({
      data: {
        id: 'VR-RACE-1',
        userId: 'student1',
        rentalVehicleId: 'RV-RACE-1',
        hubId: 'metro',
        status: 'CONFIRMED',
        expiresAt: now, // just-due hold
      },
    });

    const [pickupResult, _expiryResult] = await Promise.all([
      request(app)
        .post('/api/vehicle-reservations/VR-RACE-1/pickup')
        .set('Authorization', student1Token),
      expireVehicleHolds(now),
    ]);

    const resvAfter = await db.vehicleReservation.findUniqueOrThrow({ where: { id: 'VR-RACE-1' } });
    const vehAfter = await db.rentalVehicle.findUniqueOrThrow({ where: { id: 'RV-RACE-1' } });

    if (pickupResult.status === 200) {
      // Pick-up committed first
      expect(resvAfter.status).toBe('ACTIVE');
      expect(vehAfter.status).toBe('IN_USE');
      expect(vehAfter.parkingSpaceId).toBeNull();
    } else {
      // Expiry committed first
      expect(pickupResult.status).toBe(409);
      expect(['HOLD_EXPIRED', 'INVALID_STATE_TRANSITION']).toContain(pickupResult.body.error.code);
      expect(resvAfter.status).toBe('EXPIRED');
      expect(vehAfter.status).toBe('AVAILABLE');
    }

    await assertDerivedCountsInvariant();
  });
});

// ============================================================================
// AC-4: FR-12 return completes rental with telemetry battery and occupies a FLEET space
// ============================================================================
describe('FR-12 AC-4 return completes the rental with telemetry battery and occupies a FLEET space', () => {
  it('FR-12 AC-4 return completes the rental with telemetry battery and occupies a FLEET space', async () => {
    const now = new Date();

    // Fresh telemetry on dorm
    await db.hub.update({
      where: { id: 'dorm' },
      data: { lastTelemetryAt: now },
    });

    // Clear spaces at dorm so PS-RET-DORM is the only space
    await db.parkingSpace.deleteMany({ where: { hubId: 'dorm' } });
    await db.parkingSpace.create({
      data: { id: 'PS-RET-DORM', hubId: 'dorm', vehicleClass: 'MOTORCYCLE', pool: 'FLEET', status: 'FREE' },
    });

    // Vehicle currently IN_USE with telemetry battery 65
    await db.rentalVehicle.create({
      data: { id: 'RV-RET-1', hubId: 'metro', type: 'E_BICYCLE', vehicleClass: 'MOTORCYCLE', status: 'IN_USE', batteryPct: 65, parkingSpaceId: null },
    });

    await db.vehicleReservation.create({
      data: {
        id: 'VR-RET-1',
        userId: 'student1',
        rentalVehicleId: 'RV-RET-1',
        hubId: 'metro',
        status: 'ACTIVE',
        pickedUpAt: new Date(now.getTime() - 3600000),
        expiresAt: new Date(now.getTime() - 3600000 + config.RESERVATION_HOLD_MIN * 60000),
      },
    });

    // Send batteryPct in body - must be ignored!
    const res = await request(app)
      .post('/api/vehicle-reservations/VR-RET-1/return')
      .set('Authorization', student1Token)
      .send({ hubId: 'dorm', batteryPct: 10 });

    expect(res.status).toBe(200);
    const body: VehicleReturnResult = res.body;

    expect(body.chargingRequest).toBeNull();
    expect(body.reservation.id).toBe('VR-RET-1');
    expect(body.reservation.status).toBe('COMPLETED');
    expect(body.reservation.returnHubId).toBe('dorm');
    expect(body.reservation.returnedAt).not.toBeNull();
    expect(body.reservation.endBatteryPct).toBe(65); // Ignored the 10 in body!
    expect(body.reservation.endReason).toBe('RETURNED');

    // DB checks
    const resvAfter = await db.vehicleReservation.findUniqueOrThrow({ where: { id: 'VR-RET-1' } });
    expect(resvAfter.status).toBe('COMPLETED');
    expect(resvAfter.returnHubId).toBe('dorm');
    expect(resvAfter.endBatteryPct).toBe(65);
    expect(resvAfter.endReason).toBe('RETURNED');

    const vehAfter = await db.rentalVehicle.findUniqueOrThrow({ where: { id: 'RV-RET-1' } });
    expect(vehAfter.status).toBe('AVAILABLE');
    expect(vehAfter.hubId).toBe('dorm');
    expect(vehAfter.parkingSpaceId).toBe('PS-RET-DORM');

    const spaceAfter = await db.parkingSpace.findUniqueOrThrow({ where: { id: 'PS-RET-DORM' } });
    expect(spaceAfter.status).toBe('OCCUPIED');

    await assertDerivedCountsInvariant();
  });
});

// ============================================================================
// AC-5: BR-02 return battery 19 → LOW_BATTERY, 20 → AVAILABLE
// ============================================================================
describe('BR-02 AC-5 return battery 19 → LOW_BATTERY, 20 → AVAILABLE', () => {
  it('BR-02 AC-5 return battery 19 → LOW_BATTERY, 20 → AVAILABLE', async () => {
    const now = new Date();
    await db.hub.update({ where: { id: 'campus-a' }, data: { lastTelemetryAt: now } });

    // Space 1 & 2 at campus-a
    await db.parkingSpace.createMany({
      data: [
        { id: 'PS-BATT-19', hubId: 'campus-a', vehicleClass: 'MOTORCYCLE', pool: 'FLEET', status: 'FREE' },
        { id: 'PS-BATT-20', hubId: 'campus-a', vehicleClass: 'MOTORCYCLE', pool: 'FLEET', status: 'FREE' },
      ],
    });

    // 1. Boundary: MIN_RENTAL_BATTERY_PCT - 1 (19) -> LOW_BATTERY
    await db.rentalVehicle.create({
      data: { id: 'RV-BATT-19', hubId: 'metro', type: 'E_BICYCLE', vehicleClass: 'MOTORCYCLE', status: 'IN_USE', batteryPct: config.MIN_RENTAL_BATTERY_PCT - 1, parkingSpaceId: null },
    });
    await db.vehicleReservation.create({
      data: {
        id: 'VR-BATT-19',
        userId: 'student1',
        rentalVehicleId: 'RV-BATT-19',
        hubId: 'metro',
        status: 'ACTIVE',
        expiresAt: now,
      },
    });

    const res19 = await request(app)
      .post('/api/vehicle-reservations/VR-BATT-19/return')
      .set('Authorization', student1Token)
      .send({ hubId: 'campus-a' });

    expect(res19.status).toBe(200);
    const veh19 = await db.rentalVehicle.findUniqueOrThrow({ where: { id: 'RV-BATT-19' } });
    expect(veh19.status).toBe('LOW_BATTERY');

    // 2. Boundary: MIN_RENTAL_BATTERY_PCT (20) -> AVAILABLE
    await db.rentalVehicle.create({
      data: { id: 'RV-BATT-20', hubId: 'metro', type: 'E_BICYCLE', vehicleClass: 'MOTORCYCLE', status: 'IN_USE', batteryPct: config.MIN_RENTAL_BATTERY_PCT, parkingSpaceId: null },
    });
    await db.vehicleReservation.create({
      data: {
        id: 'VR-BATT-20',
        userId: 'student2',
        rentalVehicleId: 'RV-BATT-20',
        hubId: 'metro',
        status: 'ACTIVE',
        expiresAt: now,
      },
    });

    const res20 = await request(app)
      .post('/api/vehicle-reservations/VR-BATT-20/return')
      .set('Authorization', student2Token)
      .send({ hubId: 'campus-a' });

    expect(res20.status).toBe(200);
    const veh20 = await db.rentalVehicle.findUniqueOrThrow({ where: { id: 'RV-BATT-20' } });
    expect(veh20.status).toBe('AVAILABLE');

    await assertDerivedCountsInvariant();
  });
});

// ============================================================================
// AC-6: BR-04 / FR-19 full Hub → HUB_FULL with FLEET alternatives, nothing changed
// ============================================================================
describe('BR-04 AC-6 full Hub → HUB_FULL with FLEET alternatives, nothing changed', () => {
  it('BR-04 AC-6 full Hub → HUB_FULL with FLEET alternatives, nothing changed', async () => {
    const now = new Date();

    // Make campus-b the return target. Clear its FLEET spaces so it has 0 free FLEET spaces
    await db.parkingSpace.deleteMany({ where: { hubId: 'campus-b' } });
    await db.hub.update({ where: { id: 'campus-b' }, data: { lastTelemetryAt: now } });

    // Create a redistribution task to attach to a space
    const task = await db.redistributionTask.create({
      data: {
        sourceHubId: 'metro',
        destHubId: 'campus-b',
        vehicleClass: 'MOTORCYCLE',
        count: 1,
        status: 'PROPOSED',
        origin: 'MANUAL',
        createdById: 'operator1',
      },
    });

    // Add spaces at campus-b that do NOT count as free FLEET MOTORCYCLE space:
    // 1. PUBLIC space
    await db.parkingSpace.create({
      data: { id: 'PS-CB-PUB', hubId: 'campus-b', vehicleClass: 'MOTORCYCLE', pool: 'PUBLIC', status: 'FREE' },
    });
    // 2. CAR FLEET space
    await db.parkingSpace.create({
      data: { id: 'PS-CB-CAR', hubId: 'campus-b', vehicleClass: 'CAR', pool: 'FLEET', status: 'FREE' },
    });
    // 3. FLEET MOTORCYCLE space reservedForTaskId
    await db.parkingSpace.create({
      data: { id: 'PS-CB-RES', hubId: 'campus-b', vehicleClass: 'MOTORCYCLE', pool: 'FLEET', status: 'FREE', reservedForTaskId: task.id },
    });

    // Make dorm have 1 free FLEET MOTORCYCLE space and non-DEGRADED (lastTelemetryAt = now)
    await db.parkingSpace.deleteMany({ where: { hubId: 'dorm' } });
    await db.hub.update({ where: { id: 'dorm' }, data: { lastTelemetryAt: now } });
    await db.parkingSpace.create({
      data: { id: 'PS-DORM-FREE', hubId: 'dorm', vehicleClass: 'MOTORCYCLE', pool: 'FLEET', status: 'FREE' },
    });

    // Make service DEGRADED (lastTelemetryAt = null or older than 15s) even if it has free space
    await db.parkingSpace.deleteMany({ where: { hubId: 'service' } });
    await db.hub.update({
      where: { id: 'service' },
      data: {
        lastTelemetryAt: new Date(now.getTime() - (config.STALLED_FEED_INTERVALS * config.TELEMETRY_INTERVAL_SEC + 5) * 1000),
      },
    });
    await db.parkingSpace.create({
      data: { id: 'PS-SVC-FREE', hubId: 'service', vehicleClass: 'MOTORCYCLE', pool: 'FLEET', status: 'FREE' },
    });

    // Student has ACTIVE rental
    await db.rentalVehicle.create({
      data: { id: 'RV-FULL-1', hubId: 'metro', type: 'E_BICYCLE', vehicleClass: 'MOTORCYCLE', status: 'IN_USE', batteryPct: 50, parkingSpaceId: null },
    });
    await db.vehicleReservation.create({
      data: { id: 'VR-FULL-1', userId: 'student1', rentalVehicleId: 'RV-FULL-1', hubId: 'metro', status: 'ACTIVE', expiresAt: now },
    });

    const res = await request(app)
      .post('/api/vehicle-reservations/VR-FULL-1/return')
      .set('Authorization', student1Token)
      .send({ hubId: 'campus-b' });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('HUB_FULL');
    expect(res.body.error.alternatives).toBeDefined();
    expect(Array.isArray(res.body.error.alternatives)).toBe(true);

    const altHubIds = res.body.error.alternatives.map((a: { hubId: string }) => a.hubId);
    expect(altHubIds).toContain('dorm');
    expect(altHubIds).not.toContain('service'); // service is DEGRADED

    // Nothing changed
    const veh = await db.rentalVehicle.findUniqueOrThrow({ where: { id: 'RV-FULL-1' } });
    expect(veh.status).toBe('IN_USE');
    const resv = await db.vehicleReservation.findUniqueOrThrow({ where: { id: 'VR-FULL-1' } });
    expect(resv.status).toBe('ACTIVE');
  });
});

// ============================================================================
// AC-7: BR-10 two concurrent returns for the last space → one wins
// ============================================================================
describe('BR-10 AC-7 two concurrent returns for the last space → one wins', () => {
  it('BR-10 AC-7 two concurrent returns for the last space → one wins', async () => {
    const now = new Date();

    // Prepare service hub: exactly 1 free FLEET space, fresh telemetry
    await db.parkingSpace.deleteMany({ where: { hubId: 'service' } });
    await db.hub.update({ where: { id: 'service' }, data: { lastTelemetryAt: now } });
    await db.parkingSpace.create({
      data: { id: 'PS-LAST-SPACE', hubId: 'service', vehicleClass: 'MOTORCYCLE', pool: 'FLEET', status: 'FREE' },
    });

    // 2 students with active rentals
    await db.rentalVehicle.createMany({
      data: [
        { id: 'RV-CONC-1', hubId: 'metro', type: 'E_BICYCLE', vehicleClass: 'MOTORCYCLE', status: 'IN_USE', batteryPct: 70, parkingSpaceId: null },
        { id: 'RV-CONC-2', hubId: 'metro', type: 'E_BICYCLE', vehicleClass: 'MOTORCYCLE', status: 'IN_USE', batteryPct: 70, parkingSpaceId: null },
      ],
    });

    await db.vehicleReservation.createMany({
      data: [
        { id: 'VR-CONC-1', userId: 'student1', rentalVehicleId: 'RV-CONC-1', hubId: 'metro', status: 'ACTIVE', expiresAt: now },
        { id: 'VR-CONC-2', userId: 'student2', rentalVehicleId: 'RV-CONC-2', hubId: 'metro', status: 'ACTIVE', expiresAt: now },
      ],
    });

    const [res1, res2] = await Promise.all([
      request(app)
        .post('/api/vehicle-reservations/VR-CONC-1/return')
        .set('Authorization', student1Token)
        .send({ hubId: 'service' }),
      request(app)
        .post('/api/vehicle-reservations/VR-CONC-2/return')
        .set('Authorization', student2Token)
        .send({ hubId: 'service' }),
    ]);

    const statuses = [res1.status, res2.status].sort();
    expect(statuses).toEqual([200, 409]);

    const winnerRes = res1.status === 200 ? res1 : res2;
    const loserRes = res1.status === 409 ? res1 : res2;

    expect(winnerRes.body.reservation.status).toBe('COMPLETED');
    expect(loserRes.body.error.code).toBe('HUB_FULL');

    // Space is now OCCUPIED
    const space = await db.parkingSpace.findUniqueOrThrow({ where: { id: 'PS-LAST-SPACE' } });
    expect(space.status).toBe('OCCUPIED');

    // Exactly one vehicle parked in PS-LAST-SPACE
    const parkedVehicles = await db.rentalVehicle.findMany({ where: { parkingSpaceId: 'PS-LAST-SPACE' } });
    expect(parkedVehicles).toHaveLength(1);

    await assertDerivedCountsInvariant();
  });
});

// ============================================================================
// AC-8: FR-12 return validation: unknown/degraded Hub, requestCharging, wrong state
// ============================================================================
describe('FR-12 AC-8 return validation: unknown/degraded Hub, requestCharging, wrong state', () => {
  it('FR-12 AC-8 return validation: unknown/degraded Hub, requestCharging, wrong state', async () => {
    const now = new Date();

    await db.rentalVehicle.create({
      data: { id: 'RV-VAL-1', hubId: 'metro', type: 'E_BICYCLE', vehicleClass: 'MOTORCYCLE', status: 'IN_USE', batteryPct: 70, parkingSpaceId: null },
    });
    await db.vehicleReservation.create({
      data: { id: 'VR-VAL-1', userId: 'student1', rentalVehicleId: 'RV-VAL-1', hubId: 'metro', status: 'ACTIVE', expiresAt: now },
    });

    // 1. Unknown hubId -> 400 details.field: 'hubId'
    const unkRes = await request(app)
      .post('/api/vehicle-reservations/VR-VAL-1/return')
      .set('Authorization', student1Token)
      .send({ hubId: 'non-existent-hub' });

    expect(unkRes.status).toBe(400);
    expect(unkRes.body.error.code).toBe('VALIDATION_ERROR');
    expect(unkRes.body.error.details?.field).toBe('hubId');

    // 2. DEGRADED hub -> 400 details.field: 'hubId' with alternatives
    await db.hub.update({
      where: { id: 'service' },
      data: {
        lastTelemetryAt: new Date(now.getTime() - (config.STALLED_FEED_INTERVALS * config.TELEMETRY_INTERVAL_SEC + 10) * 1000),
      },
    });

    const degRes = await request(app)
      .post('/api/vehicle-reservations/VR-VAL-1/return')
      .set('Authorization', student1Token)
      .send({ hubId: 'service' });

    expect(degRes.status).toBe(400);
    expect(degRes.body.error.code).toBe('VALIDATION_ERROR');
    expect(degRes.body.error.details?.field).toBe('hubId');
    expect(degRes.body.error.alternatives).toBeDefined();

    // 3. requestCharging present -> 400 details.field: 'requestCharging'
    const rcRes = await request(app)
      .post('/api/vehicle-reservations/VR-VAL-1/return')
      .set('Authorization', student1Token)
      .send({ hubId: 'metro', requestCharging: { targetPct: 80 } });

    expect(rcRes.status).toBe(400);
    expect(rcRes.body.error.code).toBe('VALIDATION_ERROR');
    expect(rcRes.body.error.details?.field).toBe('requestCharging');

    // 4. Return of CONFIRMED or COMPLETED reservation -> 409 INVALID_STATE_TRANSITION
    // Clear VR-VAL-1 first so student1 has no conflicting active reservation
    await db.vehicleReservation.deleteMany({ where: { userId: 'student1' } });

    await db.rentalVehicle.createMany({
      data: [
        { id: 'RV-VAL-CONF', hubId: 'metro', type: 'E_BICYCLE', vehicleClass: 'MOTORCYCLE', status: 'RESERVED', batteryPct: 70 },
        { id: 'RV-VAL-COMP', hubId: 'metro', type: 'E_BICYCLE', vehicleClass: 'MOTORCYCLE', status: 'AVAILABLE', batteryPct: 70 },
      ],
    });

    await db.vehicleReservation.create({
      data: { id: 'VR-VAL-CONF', userId: 'student1', rentalVehicleId: 'RV-VAL-CONF', hubId: 'metro', status: 'CONFIRMED', expiresAt: now },
    });

    const confRes = await request(app)
      .post('/api/vehicle-reservations/VR-VAL-CONF/return')
      .set('Authorization', student1Token)
      .send({ hubId: 'metro' });
    expect(confRes.status).toBe(409);
    expect(confRes.body.error.code).toBe('INVALID_STATE_TRANSITION');

    await db.vehicleReservation.deleteMany({ where: { userId: 'student1' } });

    await db.vehicleReservation.create({
      data: { id: 'VR-VAL-COMP', userId: 'student1', rentalVehicleId: 'RV-VAL-COMP', hubId: 'metro', status: 'COMPLETED', expiresAt: now },
    });

    const compRes = await request(app)
      .post('/api/vehicle-reservations/VR-VAL-COMP/return')
      .set('Authorization', student1Token)
      .send({ hubId: 'metro' });
    expect(compRes.status).toBe(409);
    expect(compRes.body.error.code).toBe('INVALID_STATE_TRANSITION');

    // 5. Missing hubId -> 400 details.field: 'hubId'
    // Recreate active reservation VR-VAL-1 for missing hubId test
    await db.vehicleReservation.deleteMany({ where: { userId: 'student1' } });
    await db.vehicleReservation.create({
      data: { id: 'VR-VAL-1', userId: 'student1', rentalVehicleId: 'RV-VAL-1', hubId: 'metro', status: 'ACTIVE', expiresAt: now },
    });

    const missRes = await request(app)
      .post('/api/vehicle-reservations/VR-VAL-1/return')
      .set('Authorization', student1Token)
      .send({});
    expect(missRes.status).toBe(400);
    expect(missRes.body.error.code).toBe('VALIDATION_ERROR');
    expect(missRes.body.error.details?.field).toBe('hubId');

    // No state change on VR-VAL-1
    const originalResv = await db.vehicleReservation.findUniqueOrThrow({ where: { id: 'VR-VAL-1' } });
    expect(originalResv.status).toBe('ACTIVE');
  });
});

// ============================================================================
// AC-9: FR-61 operator gets 403, missing token gets 401
// ============================================================================
describe('FR-61 AC-9 operator gets 403', () => {
  it('FR-61 AC-9 operator gets 403', async () => {
    // 1. Operator gets 403 FORBIDDEN
    const opPickup = await request(app)
      .post('/api/vehicle-reservations/VR-DUMMY/pickup')
      .set('Authorization', operatorToken);
    expect(opPickup.status).toBe(403);
    expect(opPickup.body.error.code).toBe('FORBIDDEN');

    const opReturn = await request(app)
      .post('/api/vehicle-reservations/VR-DUMMY/return')
      .set('Authorization', operatorToken)
      .send({ hubId: 'metro' });
    expect(opReturn.status).toBe(403);
    expect(opReturn.body.error.code).toBe('FORBIDDEN');

    // 2. Missing token gets 401 UNAUTHENTICATED
    const anonPickup = await request(app).post('/api/vehicle-reservations/VR-DUMMY/pickup');
    expect(anonPickup.status).toBe(401);
    expect(anonPickup.body.error.code).toBe('UNAUTHENTICATED');

    const anonReturn = await request(app).post('/api/vehicle-reservations/VR-DUMMY/return').send({ hubId: 'metro' });
    expect(anonReturn.status).toBe(401);
    expect(anonReturn.body.error.code).toBe('UNAUTHENTICATED');
  });
});
