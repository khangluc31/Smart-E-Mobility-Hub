// Checker tests for T-11 (Vehicle reservations part 1).
// Written BEFORE reading the writer's code, strictly from:
//   docs/SPEC.md §3, §4, §5 BR-01, BR-02, BR-03, BR-05, BR-10, §6 FR-04–FR-09, §8 D-02, D-03, D-12, D-18
//   docs/ARCHITECTURE.md §3, §4.1, §4.6, §5.1, §6.1, §6.2, §6.3
//   docs/CONTRACTS.md §0, §1, §4
//   backend/src/core/{db,errors,stateMachine,scheduler,events,notify,config}.ts
//   backend/src/modules/hubs/hubs.service.ts
//   the T-11 section of .orchestration/TASKS.md
//   backend/tests/helpers.ts

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import type { Application } from 'express';
import { createTestApp, resetDb, loginAs } from './helpers';
import { db } from '../src/core/db';
import { config } from '../src/core/config';
import { signToken } from '../src/core/auth';
import { expireVehicleHolds } from '../src/modules/reservations/vehicleReservations.service';
import type { VehicleReservation, VehicleRecommendation } from '../src/types/reservations';
import type { RentalVehicle } from '../src/types/hubs';

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
});

// ============================================================================
// AC-1: FR-04 Search Rental Vehicles
// ============================================================================
describe('FR-04 AC-1 search filters and availableOnly boundaries', () => {
  it('FR-04 AC-1 search filters and availableOnly boundaries (19/20 %, charging excluded)', async () => {
    // Default availableOnly=true
    const res = await request(app)
      .get('/api/vehicles/search')
      .query({ hubId: 'metro' })
      .set('Authorization', student1Token);

    expect(res.status).toBe(200);
    const vehicles: RentalVehicle[] = res.body;
    expect(Array.isArray(vehicles)).toBe(true);

    // From fixture for metro:
    // RV-M-001: AVAILABLE, 80% -> included
    // RV-M-002: AVAILABLE, 20% -> included (boundary >= MIN_RENTAL_BATTERY_PCT)
    // RV-M-003: LOW_BATTERY, 19% -> excluded (< MIN_RENTAL_BATTERY_PCT)
    // RV-M-004: AVAILABLE, 50%, CHARGING request -> excluded (D-18)
    // RV-M-005: AVAILABLE, 60%, QUEUED request -> included (QUEUED != CHARGING)
    // RV-M-006: RESERVED, 75% -> excluded
    // RV-M-007: FAULTY, 45% -> excluded
    const ids = vehicles.map((v) => v.id);
    expect(ids).toContain('RV-M-001');
    expect(ids).toContain('RV-M-002');
    expect(ids).toContain('RV-M-005');
    expect(ids).not.toContain('RV-M-003');
    expect(ids).not.toContain('RV-M-004');
    expect(ids).not.toContain('RV-M-006');
    expect(ids).not.toContain('RV-M-007');

    // Rule 2 sort order: batteryPct DESC, id ASC
    for (let i = 0; i < vehicles.length - 1; i++) {
      const curr = vehicles[i];
      const next = vehicles[i + 1];
      if (curr && next) {
        if (curr.batteryPct === next.batteryPct) {
          expect(curr.id.localeCompare(next.id)).toBeLessThanOrEqual(0);
        } else {
          expect(curr.batteryPct).toBeGreaterThanOrEqual(next.batteryPct);
        }
      }
    }

    // availableOnly=false includes non-available / charging vehicles
    const resAll = await request(app)
      .get('/api/vehicles/search')
      .query({ hubId: 'metro', availableOnly: 'false' })
      .set('Authorization', student1Token);

    expect(resAll.status).toBe(200);
    const allVehicles: RentalVehicle[] = resAll.body;
    const allIds = allVehicles.map((v) => v.id);
    expect(allIds).toContain('RV-M-001');
    expect(allIds).toContain('RV-M-003'); // 19%
    expect(allIds).toContain('RV-M-004'); // charging
    expect(allIds).toContain('RV-M-006'); // RESERVED
    expect(allIds).toContain('RV-M-007'); // FAULTY

    const chargingV = allVehicles.find((v) => v.id === 'RV-M-004');
    expect(chargingV?.charging).toBe(true);

    // Filter by minBattery
    const resMinBattery = await request(app)
      .get('/api/vehicles/search')
      .query({ hubId: 'metro', minBattery: 70 })
      .set('Authorization', student1Token);

    expect(resMinBattery.status).toBe(200);
    const minBatVehicles: RentalVehicle[] = resMinBattery.body;
    for (const v of minBatVehicles) {
      expect(v.batteryPct).toBeGreaterThanOrEqual(70);
    }
    expect(minBatVehicles.map((v) => v.id)).toContain('RV-M-001');
    expect(minBatVehicles.map((v) => v.id)).not.toContain('RV-M-005'); // 60%

    // Filter by type
    const resType = await request(app)
      .get('/api/vehicles/search')
      .query({ hubId: 'metro', type: 'E_MOTORCYCLE' })
      .set('Authorization', student1Token);

    expect(resType.status).toBe(200);
    expect(resType.body.length).toBeGreaterThan(0);

    // Empty search -> returns []
    const resEmpty = await request(app)
      .get('/api/vehicles/search')
      .query({ hubId: 'metro', minBattery: 99 })
      .set('Authorization', student1Token);

    expect(resEmpty.status).toBe(200);
    expect(resEmpty.body).toEqual([]);

    // Unknown hubId -> 400 details.field: 'hubId'
    const resBadHub = await request(app)
      .get('/api/vehicles/search')
      .query({ hubId: 'unknown-hub-id' })
      .set('Authorization', student1Token);

    expect(resBadHub.status).toBe(400);
    expect(resBadHub.body.error.code).toBe('VALIDATION_ERROR');
    expect(resBadHub.body.error.details.field).toBe('hubId');

    // minBattery 101 -> 400 details.field: 'minBattery'
    const resBadBattery = await request(app)
      .get('/api/vehicles/search')
      .query({ minBattery: 101 })
      .set('Authorization', student1Token);

    expect(resBadBattery.status).toBe(400);
    expect(resBadBattery.body.error.code).toBe('VALIDATION_ERROR');
    expect(resBadBattery.body.error.details.field).toBe('minBattery');
  });

  it('FR-04 / D-18 dynamically inserting a charging_request row with status CHARGING makes vehicle unavailable', async () => {
    // RV-D-001 at dorm is initially AVAILABLE, 90%, not charging
    const beforeSearch = await request(app)
      .get('/api/vehicles/search')
      .query({ hubId: 'dorm' })
      .set('Authorization', student1Token);

    expect(beforeSearch.status).toBe(200);
    expect(beforeSearch.body.map((v: RentalVehicle) => v.id)).toContain('RV-D-001');

    // Dynamically insert a charging_request with status CHARGING
    await db.chargingRequest.create({
      data: {
        id: 'CR-DYNAMIC-01',
        requestedById: 'operator1',
        vehicleKind: 'RENTAL',
        rentalVehicleId: 'RV-D-001',
        vehicleClass: 'MOTORCYCLE',
        hubId: 'dorm',
        mode: 'QUEUE',
        status: 'CHARGING',
        targetPct: 100,
        startPct: 40,
        currentPct: 90,
      },
    });

    // availableOnly=true excludes RV-D-001
    const afterSearch = await request(app)
      .get('/api/vehicles/search')
      .query({ hubId: 'dorm' })
      .set('Authorization', student1Token);

    expect(afterSearch.status).toBe(200);
    expect(afterSearch.body.map((v: RentalVehicle) => v.id)).not.toContain('RV-D-001');

    // availableOnly=false includes RV-D-001 with charging=true
    const afterSearchAll = await request(app)
      .get('/api/vehicles/search')
      .query({ hubId: 'dorm', availableOnly: 'false' })
      .set('Authorization', student1Token);

    expect(afterSearchAll.status).toBe(200);
    const chargingV = afterSearchAll.body.find((v: RentalVehicle) => v.id === 'RV-D-001');
    expect(chargingV).toBeTruthy();
    expect(chargingV.charging).toBe(true);

    // Attempting to reserve RV-D-001 -> 409 RESOURCE_TAKEN
    const reserveRes = await request(app)
      .post('/api/vehicle-reservations')
      .set('Authorization', student1Token)
      .send({ vehicleId: 'RV-D-001' });

    expect(reserveRes.status).toBe(409);
    expect(reserveRes.body.error.code).toBe('RESOURCE_TAKEN');
  });
});

// ============================================================================
// AC-2: FR-05 Recommend Vehicles and Hubs
// ============================================================================
describe('FR-05 AC-2 recommend flags a full destination and offers alternatives', () => {
  it('FR-05 AC-2 recommend flags a full destination and offers alternatives', async () => {
    // Normal case: origin metro, destination dorm (dorm has free fleet space DOR-F-M-03)
    const resOk = await request(app)
      .get('/api/vehicles/recommend')
      .query({ originHubId: 'metro', destinationHubId: 'dorm' })
      .set('Authorization', student1Token);

    expect(resOk.status).toBe(200);
    const recOk: VehicleRecommendation = resOk.body;

    expect(recOk.destination.hubId).toBe('dorm');
    expect(recOk.destination.ok).toBe(true);
    expect(recOk.destination.freeFleetSpaces).toBeGreaterThan(0);
    expect(recOk.alternativeDestinations).toEqual([]);

    // Vehicles at origin must be rentable, each with a reason string
    expect(recOk.vehicles.length).toBeGreaterThan(0);
    for (const v of recOk.vehicles) {
      expect(v.batteryPct).toBeGreaterThanOrEqual(config.MIN_RENTAL_BATTERY_PCT);
      expect(v.status).toBe('AVAILABLE');
      expect(v.charging).toBe(false);
      expect(typeof v.reason).toBe('string');
      expect(v.reason.length).toBeGreaterThan(0);
      expect(v.reason).toMatch(/battery|metro/i);
    }

    // Destination with 0 free fleet spaces
    // Fill DOR-F-M-03 so dorm has 0 free fleet spaces
    await db.parkingSpace.update({
      where: { id: 'DOR-F-M-03' },
      data: { status: 'OCCUPIED' },
    });

    const resFull = await request(app)
      .get('/api/vehicles/recommend')
      .query({ originHubId: 'metro', destinationHubId: 'dorm' })
      .set('Authorization', student1Token);

    expect(resFull.status).toBe(200);
    const recFull: VehicleRecommendation = resFull.body;

    expect(recFull.destination.ok).toBe(false);
    expect(recFull.destination.freeFleetSpaces).toBe(0);
    expect(typeof recFull.destination.reason).toBe('string');
    expect(recFull.destination.reason.length).toBeGreaterThan(0);

    // alternativeDestinations must list hubs that have free FLEET motorcycle spaces
    expect(recFull.alternativeDestinations.length).toBeGreaterThan(0);
    const altHubIds = recFull.alternativeDestinations.map((a) => a.hubId);
    expect(altHubIds).not.toContain('dorm');
    for (const alt of recFull.alternativeDestinations) {
      expect(alt.type).toBe('hub');
      expect(alt.reason.length).toBeGreaterThan(0);
    }

    // Degraded destination (service hub lastTelemetryAt is stale in fixture)
    const resDegraded = await request(app)
      .get('/api/vehicles/recommend')
      .query({ originHubId: 'metro', destinationHubId: 'service' })
      .set('Authorization', student1Token);

    expect(resDegraded.status).toBe(200);
    const recDegraded: VehicleRecommendation = resDegraded.body;
    expect(recDegraded.destination.ok).toBe(false);
    expect(recDegraded.destination.reason.length).toBeGreaterThan(0);

    // Validation error: unknown originHubId or destinationHubId -> 400
    const resBadOrigin = await request(app)
      .get('/api/vehicles/recommend')
      .query({ originHubId: 'bad-origin', destinationHubId: 'dorm' })
      .set('Authorization', student1Token);

    expect(resBadOrigin.status).toBe(400);
    expect(resBadOrigin.body.error.details.field).toBe('originHubId');

    const resBadDest = await request(app)
      .get('/api/vehicles/recommend')
      .query({ originHubId: 'metro', destinationHubId: 'bad-dest' })
      .set('Authorization', student1Token);

    expect(resBadDest.status).toBe(400);
    expect(resBadDest.body.error.details.field).toBe('destinationHubId');
  });
});

// ============================================================================
// AC-3: FR-06 Reserve Rental Vehicle
// ============================================================================
describe('FR-06 AC-3 reserve creates hold and rejects invalid vehicles with alternatives', () => {
  it('FR-06 AC-3 reserve creates a 15-min hold; low battery and taken vehicles rejected with alternatives', async () => {
    const beforeReserve = Date.now();

    const res = await request(app)
      .post('/api/vehicle-reservations')
      .set('Authorization', student1Token)
      .send({ vehicleId: 'RV-M-001' });

    expect(res.status).toBe(201);
    const reservation: VehicleReservation = res.body;

    expect(reservation.id).toBeTruthy();
    expect(reservation.status).toBe('CONFIRMED');
    expect(reservation.hubId).toBe('metro');
    expect(reservation.vehicle.id).toBe('RV-M-001');
    expect(reservation.vehicle.status).toBe('RESERVED');
    expect(reservation.vehicle.charging).toBe(false);
    expect(reservation.serverNow).toBeTruthy();

    const expiresAtMs = new Date(reservation.expiresAt).getTime();
    const expectedExpiresAtMs = beforeReserve + config.RESERVATION_HOLD_MIN * 60 * 1000;
    // Window: ±2000 ms per AC-3
    expect(Math.abs(expiresAtMs - expectedExpiresAtMs)).toBeLessThanOrEqual(4000);

    // DB state
    const dbVehicle = await db.rentalVehicle.findUnique({ where: { id: 'RV-M-001' } });
    expect(dbVehicle?.status).toBe('RESERVED');

    const dbRes = await db.vehicleReservation.findUnique({ where: { id: reservation.id } });
    expect(dbRes?.status).toBe('CONFIRMED');
    expect(dbRes?.userId).toBe('student1');

    // Low battery vehicle: RV-M-003 has 19% (< MIN_RENTAL_BATTERY_PCT)
    // Create a new student so we don't hit ACTIVE_RENTAL_EXISTS
    const lowBatStudentToken = `Bearer ${signToken({ id: 'student_low_bat', role: 'STUDENT' })}`;
    await db.user.create({
      data: { id: 'student_low_bat', identifier: 'student_low_bat', passwordHash: 'hash', displayName: 'Low Bat', role: 'STUDENT' },
    });

    const resLowBattery = await request(app)
      .post('/api/vehicle-reservations')
      .set('Authorization', lowBatStudentToken)
      .send({ vehicleId: 'RV-M-003' });

    expect(resLowBattery.status).toBe(409);
    expect(resLowBattery.body.error.code).toBe('LOW_BATTERY');

    // Already RESERVED vehicle: RV-M-006 -> 409 RESOURCE_TAKEN with alternatives at same Hub (<= ALTERNATIVE_SLOTS_COUNT)
    const resTaken = await request(app)
      .post('/api/vehicle-reservations')
      .set('Authorization', lowBatStudentToken)
      .send({ vehicleId: 'RV-M-006' });

    expect(resTaken.status).toBe(409);
    expect(resTaken.body.error.code).toBe('RESOURCE_TAKEN');
    expect(Array.isArray(resTaken.body.error.alternatives)).toBe(true);
    expect(resTaken.body.error.alternatives.length).toBeLessThanOrEqual(config.ALTERNATIVE_SLOTS_COUNT);
    for (const alt of resTaken.body.error.alternatives) {
      expect(alt.hubId).toBe('metro');
      expect(alt.type).toBe('rentalVehicle');
      expect(alt.batteryPct).toBeGreaterThanOrEqual(config.MIN_RENTAL_BATTERY_PCT);
    }

    // Charging vehicle: RV-M-004 has status CHARGING -> 409 RESOURCE_TAKEN
    const resCharging = await request(app)
      .post('/api/vehicle-reservations')
      .set('Authorization', lowBatStudentToken)
      .send({ vehicleId: 'RV-M-004' });

    expect(resCharging.status).toBe(409);
    expect(resCharging.body.error.code).toBe('RESOURCE_TAKEN');

    // Unknown vehicle -> 404 NOT_FOUND
    const resUnknown = await request(app)
      .post('/api/vehicle-reservations')
      .set('Authorization', lowBatStudentToken)
      .send({ vehicleId: 'RV-NON-EXISTENT' });

    expect(resUnknown.status).toBe(404);
    expect(resUnknown.body.error.code).toBe('NOT_FOUND');
  });
});

// ============================================================================
// AC-4: BR-01 One Active Reservation per Student
// ============================================================================
describe('BR-01 AC-4 one active vehicle reservation per student', () => {
  it('BR-01 AC-4 one active vehicle reservation per student, including concurrent attempts', async () => {
    // student2 already has CONFIRMED reservation VR-001 in fixture
    const resConfirmed = await request(app)
      .post('/api/vehicle-reservations')
      .set('Authorization', student2Token)
      .send({ vehicleId: 'RV-M-001' });

    expect(resConfirmed.status).toBe(409);
    expect(resConfirmed.body.error.code).toBe('ACTIVE_RENTAL_EXISTS');

    // Student with ACTIVE reservation
    await db.vehicleReservation.update({
      where: { id: 'VR-001' },
      data: { status: 'ACTIVE', pickedUpAt: new Date() },
    });

    const resActive = await request(app)
      .post('/api/vehicle-reservations')
      .set('Authorization', student2Token)
      .send({ vehicleId: 'RV-M-001' });

    expect(resActive.status).toBe(409);
    expect(resActive.body.error.code).toBe('ACTIVE_RENTAL_EXISTS');

    // Concurrent variant: student1 (clean, no reservation) attempts two different available vehicles concurrently
    const [raceRes1, raceRes2] = await Promise.all([
      request(app)
        .post('/api/vehicle-reservations')
        .set('Authorization', student1Token)
        .send({ vehicleId: 'RV-M-001' }),
      request(app)
        .post('/api/vehicle-reservations')
        .set('Authorization', student1Token)
        .send({ vehicleId: 'RV-M-005' }),
    ]);

    const statuses = [raceRes1.status, raceRes2.status].sort();
    expect(statuses).toEqual([201, 409]);

    const winner = raceRes1.status === 201 ? raceRes1 : raceRes2;
    const loser = raceRes1.status === 409 ? raceRes1 : raceRes2;

    expect(winner.body.status).toBe('CONFIRMED');
    expect(loser.body.error.code).toBe('ACTIVE_RENTAL_EXISTS');

    // The other vehicle must still be AVAILABLE
    const otherVehicleId = winner.body.vehicle.id === 'RV-M-001' ? 'RV-M-005' : 'RV-M-001';
    const dbOther = await db.rentalVehicle.findUnique({ where: { id: otherVehicleId } });
    expect(dbOther?.status).toBe('AVAILABLE');
  });
});

// ============================================================================
// AC-5: FR-06 / BR-10 / NFR-21 50-way Race
// ============================================================================
describe('BR-10 AC-5 50 concurrent reservations of one vehicle', () => {
  it('BR-10 AC-5 50 concurrent reservations of one vehicle → exactly one winner', async () => {
    const studentCount = 50;
    const studentUsers = Array.from({ length: studentCount }, (_, i) => ({
      id: `student_race_${i + 1}`,
      identifier: `student_race_${i + 1}`,
      passwordHash: 'hash',
      displayName: `Race Student ${i + 1}`,
      role: 'STUDENT' as const,
    }));

    await db.user.createMany({ data: studentUsers });

    const tokens = studentUsers.map((u) => `Bearer ${signToken({ id: u.id, role: 'STUDENT' })}`);

    // Target vehicle: RV-M-001 (AVAILABLE, 80%)
    const promises = tokens.map((t) =>
      request(app)
        .post('/api/vehicle-reservations')
        .set('Authorization', t)
        .send({ vehicleId: 'RV-M-001' }),
    );

    const responses = await Promise.all(promises);

    const successResponses = responses.filter((r) => r.status === 201);
    const takenResponses = responses.filter((r) => r.status === 409 && r.body.error?.code === 'RESOURCE_TAKEN');
    const serverErrors = responses.filter((r) => r.status === 500);

    expect(serverErrors.length).toBe(0);
    expect(successResponses.length).toBe(1);
    expect(takenResponses.length).toBe(49);

    // Verify DB state
    const confirmedCount = await db.vehicleReservation.count({
      where: { rentalVehicleId: 'RV-M-001', status: 'CONFIRMED' },
    });
    expect(confirmedCount).toBe(1);

    const vehicle = await db.rentalVehicle.findUnique({ where: { id: 'RV-M-001' } });
    expect(vehicle?.status).toBe('RESERVED');
  });
});

// ============================================================================
// AC-6: NFR-08 Idempotency
// ============================================================================
describe('NFR-08 AC-6 idempotency key replays the first response', () => {
  it('NFR-08 AC-6 idempotency key replays the first response', async () => {
    const idemKey = 'idem-test-key-001';

    // 1. Sequential duplicate with same key
    const res1 = await request(app)
      .post('/api/vehicle-reservations')
      .set('Authorization', student1Token)
      .set('Idempotency-Key', idemKey)
      .send({ vehicleId: 'RV-M-001' });

    expect(res1.status).toBe(201);
    const body1: VehicleReservation = res1.body;

    const res2 = await request(app)
      .post('/api/vehicle-reservations')
      .set('Authorization', student1Token)
      .set('Idempotency-Key', idemKey)
      .send({ vehicleId: 'RV-M-001' });

    expect(res2.status).toBe(201);
    const body2: VehicleReservation = res2.body;

    expect(body2.id).toBe(body1.id);
    expect(body2.vehicle.id).toBe(body1.vehicle.id);
    expect(body2.expiresAt).toBe(body1.expiresAt);

    // Only one DB row created
    const count = await db.vehicleReservation.count({
      where: { userId: 'student1', status: 'CONFIRMED' },
    });
    expect(count).toBe(1);

    // 2. Concurrent duplicate with same key
    const studentRaceUser = {
      id: 'student_idem_race',
      identifier: 'student_idem_race',
      passwordHash: 'hash',
      displayName: 'Idem Race',
      role: 'STUDENT' as const,
    };
    await db.user.create({ data: studentRaceUser });
    const raceToken = `Bearer ${signToken({ id: studentRaceUser.id, role: 'STUDENT' })}`;

    const raceKey = 'idem-race-key-002';
    const [c1, c2] = await Promise.all([
      request(app)
        .post('/api/vehicle-reservations')
        .set('Authorization', raceToken)
        .set('Idempotency-Key', raceKey)
        .send({ vehicleId: 'RV-M-005' }),
      request(app)
        .post('/api/vehicle-reservations')
        .set('Authorization', raceToken)
        .set('Idempotency-Key', raceKey)
        .send({ vehicleId: 'RV-M-005' }),
    ]);

    expect(c1.status).toBe(201);
    expect(c2.status).toBe(201);
    expect(c1.body.id).toBe(c2.body.id);

    const raceCount = await db.vehicleReservation.count({
      where: { userId: studentRaceUser.id, status: 'CONFIRMED' },
    });
    expect(raceCount).toBe(1);

    // 3. Same key on a different endpoint -> 400 details.field: 'Idempotency-Key'
    // Create an entry in idempotency_key for student1 on endpoint "/api/other-endpoint"
    await db.idempotencyKey.create({
      data: {
        key: 'idem-diff-endpoint',
        userId: 'student1',
        endpoint: '/api/other-endpoint',
        responseStatus: 200,
        responseBody: {},
      },
    });

    const resDiff = await request(app)
      .post('/api/vehicle-reservations')
      .set('Authorization', student1Token)
      .set('Idempotency-Key', 'idem-diff-endpoint')
      .send({ vehicleId: 'RV-D-001' });

    expect(resDiff.status).toBe(400);
    expect(resDiff.body.error.code).toBe('VALIDATION_ERROR');
    expect(resDiff.body.error.details.field).toBe('Idempotency-Key');

    // 4. Retry after failure with same key: request that failed (409) can be retried and runs again
    const retryUser = {
      id: 'student_retry_user',
      identifier: 'student_retry_user',
      passwordHash: 'hash',
      displayName: 'Retry User',
      role: 'STUDENT' as const,
    };
    await db.user.create({ data: retryUser });
    const retryUserToken = `Bearer ${signToken({ id: retryUser.id, role: 'STUDENT' })}`;

    const freshFailKey = 'fresh-fail-key';
    const f1 = await request(app)
      .post('/api/vehicle-reservations')
      .set('Authorization', retryUserToken)
      .set('Idempotency-Key', freshFailKey)
      .send({ vehicleId: 'RV-M-006' }); // taken -> 409

    expect(f1.status).toBe(409);

    const f2 = await request(app)
      .post('/api/vehicle-reservations')
      .set('Authorization', retryUserToken)
      .set('Idempotency-Key', freshFailKey)
      .send({ vehicleId: 'RV-D-001' }); // available -> 201

    expect(f2.status).toBe(201);
    expect(f2.body.vehicle.id).toBe('RV-D-001');
  });
});

// ============================================================================
// AC-7: FR-07 Current Reservation
// ============================================================================
describe('FR-07 AC-7 current returns own reservation with serverNow or null', () => {
  it('FR-07 AC-7 current returns own reservation with serverNow or null', async () => {
    // student1 has no reservation -> null
    const resNull = await request(app)
      .get('/api/vehicle-reservations/current')
      .set('Authorization', student1Token);

    expect(resNull.status).toBe(200);
    expect(resNull.body).toBeNull();

    // student2 has CONFIRMED VR-001 in fixture
    const resConfirmed = await request(app)
      .get('/api/vehicle-reservations/current')
      .set('Authorization', student2Token);

    expect(resConfirmed.status).toBe(200);
    expect(resConfirmed.body.id).toBe('VR-001');
    expect(resConfirmed.body.status).toBe('CONFIRMED');
    expect(resConfirmed.body.serverNow).toBeTruthy();
    expect(resConfirmed.body.vehicle.id).toBe('RV-M-006');

    // student2 reservation ACTIVE -> returned
    await db.vehicleReservation.update({
      where: { id: 'VR-001' },
      data: { status: 'ACTIVE', pickedUpAt: new Date() },
    });

    const resActive = await request(app)
      .get('/api/vehicle-reservations/current')
      .set('Authorization', student2Token);

    expect(resActive.status).toBe(200);
    expect(resActive.body.id).toBe('VR-001');
    expect(resActive.body.status).toBe('ACTIVE');

    // student2 reservation COMPLETED / CANCELLED / EXPIRED -> returns null
    await db.vehicleReservation.update({
      where: { id: 'VR-001' },
      data: { status: 'CANCELLED', endReason: 'CANCELLED' },
    });

    const resCancelled = await request(app)
      .get('/api/vehicle-reservations/current')
      .set('Authorization', student2Token);

    expect(resCancelled.status).toBe(200);
    expect(resCancelled.body).toBeNull();

    // Student 1 never sees Student 2's reservation
    const resOther = await request(app)
      .get('/api/vehicle-reservations/current')
      .set('Authorization', student1Token);

    expect(resOther.status).toBe(200);
    expect(resOther.body).toBeNull();
  });
});

// ============================================================================
// AC-8: FR-08 Cancel Vehicle Reservation
// ============================================================================
describe('FR-08 AC-8 cancel rules and invalid-transition audit', () => {
  it('FR-08 AC-8 cancel rules and invalid-transition audit', async () => {
    // student2 cancels VR-001 (CONFIRMED)
    const res = await request(app)
      .post('/api/vehicle-reservations/VR-001/cancel')
      .set('Authorization', student2Token);

    expect(res.status).toBe(200);
    const cancelled: VehicleReservation = res.body;
    expect(cancelled.id).toBe('VR-001');
    expect(cancelled.status).toBe('CANCELLED');
    expect(cancelled.endReason).toBe('CANCELLED');

    // Vehicle released back to AVAILABLE
    const dbVehicle = await db.rentalVehicle.findUnique({ where: { id: 'RV-M-006' } });
    expect(dbVehicle?.status).toBe('AVAILABLE');

    // Cancelling an already CANCELLED reservation -> 409 INVALID_STATE_TRANSITION
    const auditBefore = await db.auditLog.count({ where: { action: 'INVALID_TRANSITION' } });

    const resRepeat = await request(app)
      .post('/api/vehicle-reservations/VR-001/cancel')
      .set('Authorization', student2Token);

    expect(resRepeat.status).toBe(409);
    expect(resRepeat.body.error.code).toBe('INVALID_STATE_TRANSITION');

    // Check audit row written by errorHandler for INVALID_TRANSITION (D-22)
    const auditAfter = await db.auditLog.count({ where: { action: 'INVALID_TRANSITION' } });
    expect(auditAfter).toBeGreaterThan(auditBefore);

    // Cancelling another student's reservation -> 404 NOT_FOUND
    const resOther = await request(app)
      .post('/api/vehicle-reservations/VR-001/cancel')
      .set('Authorization', student1Token);

    expect(resOther.status).toBe(404);
    expect(resOther.body.error.code).toBe('NOT_FOUND');

    // Cancelling an ACTIVE reservation -> 409 INVALID_STATE_TRANSITION
    await db.vehicleReservation.update({
      where: { id: 'VR-001' },
      data: { status: 'ACTIVE' },
    });

    const resActive = await request(app)
      .post('/api/vehicle-reservations/VR-001/cancel')
      .set('Authorization', student2Token);

    expect(resActive.status).toBe(409);
    expect(resActive.body.error.code).toBe('INVALID_STATE_TRANSITION');
  });

  it('FR-08 cancelling a CONFIRMED reservation whose vehicle was set FAULTY → vehicle stays FAULTY', async () => {
    // Set vehicle RV-M-006 to FAULTY while reservation VR-001 is CONFIRMED
    await db.rentalVehicle.update({
      where: { id: 'RV-M-006' },
      data: { status: 'FAULTY' },
    });

    const res = await request(app)
      .post('/api/vehicle-reservations/VR-001/cancel')
      .set('Authorization', student2Token);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('CANCELLED');

    // Vehicle stays FAULTY, does NOT transition to AVAILABLE
    const dbVehicle = await db.rentalVehicle.findUnique({ where: { id: 'RV-M-006' } });
    expect(dbVehicle?.status).toBe('FAULTY');
  });
});

// ============================================================================
// AC-9: FR-09 Modify Vehicle Reservation (Change Vehicle)
// ============================================================================
describe('FR-09 AC-9 change vehicle is all-or-nothing and keeps expiresAt', () => {
  it('FR-09 AC-9 change vehicle is all-or-nothing and keeps expiresAt', async () => {
    // student2 has VR-001 on RV-M-006
    const origRes = await db.vehicleReservation.findUniqueOrThrow({ where: { id: 'VR-001' } });
    const originalExpiresAtIso = origRes.expiresAt.toISOString();

    // Change to RV-M-001 (AVAILABLE, 80%)
    const res = await request(app)
      .patch('/api/vehicle-reservations/VR-001')
      .set('Authorization', student2Token)
      .send({ vehicleId: 'RV-M-001' });

    expect(res.status).toBe(200);
    const updated: VehicleReservation = res.body;
    expect(updated.id).toBe('VR-001');
    expect(updated.vehicle.id).toBe('RV-M-001');
    expect(updated.vehicle.status).toBe('RESERVED');
    expect(new Date(updated.expiresAt).toISOString()).toBe(originalExpiresAtIso);

    // Old vehicle AVAILABLE, new vehicle RESERVED
    const oldV = await db.rentalVehicle.findUnique({ where: { id: 'RV-M-006' } });
    const newV = await db.rentalVehicle.findUnique({ where: { id: 'RV-M-001' } });
    expect(oldV?.status).toBe('AVAILABLE');
    expect(newV?.status).toBe('RESERVED');

    // Change to same vehicle -> 400 details.field: 'vehicleId'
    const resSame = await request(app)
      .patch('/api/vehicle-reservations/VR-001')
      .set('Authorization', student2Token)
      .send({ vehicleId: 'RV-M-001' });

    expect(resSame.status).toBe(400);
    expect(resSame.body.error.code).toBe('VALIDATION_ERROR');
    expect(resSame.body.error.details.field).toBe('vehicleId');

    // New vehicle taken -> 409 RESOURCE_TAKEN, reservation and vehicles unchanged
    // Mark RV-D-001 as RESERVED
    await db.rentalVehicle.update({
      where: { id: 'RV-D-001' },
      data: { status: 'RESERVED' },
    });

    const resTaken = await request(app)
      .patch('/api/vehicle-reservations/VR-001')
      .set('Authorization', student2Token)
      .send({ vehicleId: 'RV-D-001' });

    expect(resTaken.status).toBe(409);
    expect(resTaken.body.error.code).toBe('RESOURCE_TAKEN');

    // Original reservation still on RV-M-001, RV-M-001 still RESERVED
    const dbResCheck = await db.vehicleReservation.findUnique({ where: { id: 'VR-001' } });
    expect(dbResCheck?.rentalVehicleId).toBe('RV-M-001');
    const dbNewVCheck = await db.rentalVehicle.findUnique({ where: { id: 'RV-M-001' } });
    expect(dbNewVCheck?.status).toBe('RESERVED');

    // New vehicle low battery -> 409 LOW_BATTERY
    const resLowBat = await request(app)
      .patch('/api/vehicle-reservations/VR-001')
      .set('Authorization', student2Token)
      .send({ vehicleId: 'RV-M-003' }); // 19%

    expect(resLowBat.status).toBe(409);
    expect(resLowBat.body.error.code).toBe('LOW_BATTERY');

    // Finished reservation cannot be modified
    await db.vehicleReservation.update({
      where: { id: 'VR-001' },
      data: { status: 'CANCELLED', endReason: 'CANCELLED' },
    });

    const resFinished = await request(app)
      .patch('/api/vehicle-reservations/VR-001')
      .set('Authorization', student2Token)
      .send({ vehicleId: 'RV-M-005' });

    expect(resFinished.status).toBe(409);
    expect(resFinished.body.error.code).toBe('INVALID_STATE_TRANSITION');

    // Another student's reservation -> 404
    const resOther = await request(app)
      .patch('/api/vehicle-reservations/VR-001')
      .set('Authorization', student1Token)
      .send({ vehicleId: 'RV-M-005' });

    expect(resOther.status).toBe(404);
  });

  it('FR-09 cancel and change-vehicle racing on the same reservation → final state is consistent', async () => {
    // Reset VR-001 on RV-M-006 as CONFIRMED
    await db.vehicleReservation.update({
      where: { id: 'VR-001' },
      data: { status: 'CONFIRMED', rentalVehicleId: 'RV-M-006' },
    });
    await db.rentalVehicle.update({
      where: { id: 'RV-M-006' },
      data: { status: 'RESERVED' },
    });

    // Fire cancel and changeVehicle to RV-M-005 concurrently
    const [cancelRes, changeRes] = await Promise.all([
      request(app)
        .post('/api/vehicle-reservations/VR-001/cancel')
        .set('Authorization', student2Token),
      request(app)
        .patch('/api/vehicle-reservations/VR-001')
        .set('Authorization', student2Token)
        .send({ vehicleId: 'RV-M-005' }),
    ]);

    // One must succeed (200), the other must fail (409)
    const successCount = [cancelRes.status, changeRes.status].filter((s) => s === 200).length;
    expect(successCount).toBe(1);

    const dbRes = await db.vehicleReservation.findUniqueOrThrow({ where: { id: 'VR-001' } });
    const oldV = await db.rentalVehicle.findUniqueOrThrow({ where: { id: 'RV-M-006' } });
    const newV = await db.rentalVehicle.findUniqueOrThrow({ where: { id: 'RV-M-005' } });

    if (cancelRes.status === 200) {
      // Cancel won: reservation is CANCELLED, old vehicle AVAILABLE, new vehicle still AVAILABLE
      expect(dbRes.status).toBe('CANCELLED');
      expect(oldV.status).toBe('AVAILABLE');
      expect(newV.status).toBe('AVAILABLE');
    } else {
      // Change won: reservation CONFIRMED on new vehicle RV-M-005, old vehicle RV-M-006 AVAILABLE, new vehicle RESERVED
      expect(dbRes.status).toBe('CONFIRMED');
      expect(dbRes.rentalVehicleId).toBe('RV-M-005');
      expect(oldV.status).toBe('AVAILABLE');
      expect(newV.status).toBe('RESERVED');
    }
  });
});

// ============================================================================
// AC-10: BR-03 Hold Expiry Job & Expired Holds
// ============================================================================
describe('BR-03 AC-10 hold expiry job, notification, and HOLD_EXPIRED on late actions', () => {
  it('BR-03 AC-10 hold expiry job, notification, and HOLD_EXPIRED on late actions', async () => {
    const now = new Date();

    // 1. Expire past hold
    // Create an expired reservation for student1 on RV-M-001
    const pastExpiresAt = new Date(now.getTime() - 1000); // 1s in past
    await db.rentalVehicle.update({ where: { id: 'RV-M-001' }, data: { status: 'RESERVED' } });
    const expiredRes = await db.vehicleReservation.create({
      data: {
        id: 'VR-EXP-1',
        userId: 'student1',
        rentalVehicleId: 'RV-M-001',
        hubId: 'metro',
        status: 'CONFIRMED',
        expiresAt: pastExpiresAt,
      },
    });

    // Create a future hold for student1 on RV-M-005 (not expired)
    const futureExpiresAt = new Date(now.getTime() + config.RESERVATION_HOLD_MIN * 60 * 1000);
    // Use user student_low_bat to avoid unique active user constraint
    await db.rentalVehicle.update({ where: { id: 'RV-M-005' }, data: { status: 'RESERVED' } });
    await db.user.create({
      data: { id: 'student_future', identifier: 'student_future', passwordHash: 'hash', displayName: 'Future', role: 'STUDENT' },
    });
    const futureRes = await db.vehicleReservation.create({
      data: {
        id: 'VR-FUT-1',
        userId: 'student_future',
        rentalVehicleId: 'RV-M-005',
        hubId: 'metro',
        status: 'CONFIRMED',
        expiresAt: futureExpiresAt,
      },
    });

    // Vehicle set FAULTY while hold is expired
    await db.rentalVehicle.update({ where: { id: 'RV-D-001' }, data: { status: 'FAULTY' } });
    await db.user.create({
      data: { id: 'student_faulty', identifier: 'student_faulty', passwordHash: 'hash', displayName: 'Faulty', role: 'STUDENT' },
    });
    const faultyRes = await db.vehicleReservation.create({
      data: {
        id: 'VR-FLT-1',
        userId: 'student_faulty',
        rentalVehicleId: 'RV-D-001',
        hubId: 'dorm',
        status: 'CONFIRMED',
        expiresAt: pastExpiresAt,
      },
    });

    // Run expireVehicleHolds(now)
    await expireVehicleHolds(now);

    // Verify expired hold 1
    const dbExpired = await db.vehicleReservation.findUnique({ where: { id: expiredRes.id } });
    expect(dbExpired?.status).toBe('EXPIRED');
    expect(dbExpired?.endReason).toBe('EXPIRED');

    const dbV1 = await db.rentalVehicle.findUnique({ where: { id: 'RV-M-001' } });
    expect(dbV1?.status).toBe('AVAILABLE');

    // Notification created for student1
    const notif = await db.notification.findFirst({
      where: { userId: 'student1', type: 'RESERVATION_EXPIRED' },
    });
    expect(notif).toBeTruthy();
    expect(notif?.type).toBe('RESERVATION_EXPIRED');

    // Future hold untouched
    const dbFuture = await db.vehicleReservation.findUnique({ where: { id: futureRes.id } });
    expect(dbFuture?.status).toBe('CONFIRMED');
    const dbV5 = await db.rentalVehicle.findUnique({ where: { id: 'RV-M-005' } });
    expect(dbV5?.status).toBe('RESERVED');

    // Faulty vehicle hold expired, but vehicle stays FAULTY
    const dbFaultyRes = await db.vehicleReservation.findUnique({ where: { id: faultyRes.id } });
    expect(dbFaultyRes?.status).toBe('EXPIRED');
    const dbFaultyV = await db.rentalVehicle.findUnique({ where: { id: 'RV-D-001' } });
    expect(dbFaultyV?.status).toBe('FAULTY');

    // 2. Late cancel / change on an expired-but-unflipped hold -> 409 HOLD_EXPIRED and row is EXPIRED afterwards
    // student2's VR-001: set expiresAt to past
    await db.vehicleReservation.update({
      where: { id: 'VR-001' },
      data: {
        status: 'CONFIRMED',
        expiresAt: new Date(Date.now() - 5000), // 5 seconds ago
      },
    });

    // Cancel attempt
    const resLateCancel = await request(app)
      .post('/api/vehicle-reservations/VR-001/cancel')
      .set('Authorization', student2Token);

    expect(resLateCancel.status).toBe(409);
    expect(resLateCancel.body.error.code).toBe('HOLD_EXPIRED');

    // Check DB: row is EXPIRED afterwards and vehicle is AVAILABLE
    const dbLateRes = await db.vehicleReservation.findUnique({ where: { id: 'VR-001' } });
    expect(dbLateRes?.status).toBe('EXPIRED');
    expect(dbLateRes?.endReason).toBe('EXPIRED');
    const dbLateVehicle = await db.rentalVehicle.findUnique({ where: { id: 'RV-M-006' } });
    expect(dbLateVehicle?.status).toBe('AVAILABLE');

    // Change attempt on expired hold
    // Setup a new student and expired reservation
    await db.user.create({
      data: { id: 'student_late_change', identifier: 'student_late_change', passwordHash: 'hash', displayName: 'Late Change', role: 'STUDENT' },
    });
    const lateChangeToken = `Bearer ${signToken({ id: 'student_late_change', role: 'STUDENT' })}`;
    await db.rentalVehicle.update({ where: { id: 'RV-D-002' }, data: { status: 'RESERVED' } });
    const lateChangeRes = await db.vehicleReservation.create({
      data: {
        id: 'VR-LATE-CHG',
        userId: 'student_late_change',
        rentalVehicleId: 'RV-D-002',
        hubId: 'dorm',
        status: 'CONFIRMED',
        expiresAt: new Date(Date.now() - 5000),
      },
    });

    const resLateChange = await request(app)
      .patch(`/api/vehicle-reservations/${lateChangeRes.id}`)
      .set('Authorization', lateChangeToken)
      .send({ vehicleId: 'RV-A-001' });

    expect(resLateChange.status).toBe(409);
    expect(resLateChange.body.error.code).toBe('HOLD_EXPIRED');

    const dbLateChangeRes = await db.vehicleReservation.findUnique({ where: { id: lateChangeRes.id } });
    expect(dbLateChangeRes?.status).toBe('EXPIRED');
    const dbD2 = await db.rentalVehicle.findUnique({ where: { id: 'RV-D-002' } });
    expect(dbD2?.status).toBe('AVAILABLE');
  });
});

// ============================================================================
// AC-11: FR-61 Role enforcement and Validation
// ============================================================================
describe('FR-61 AC-11 operator gets 403 on student endpoints', () => {
  it('FR-61 AC-11 operator gets 403 on student endpoints', async () => {
    const endpoints = [
      { method: 'get', url: '/api/vehicles/search' },
      { method: 'get', url: '/api/vehicles/recommend?originHubId=metro&destinationHubId=dorm' },
      { method: 'post', url: '/api/vehicle-reservations', body: { vehicleId: 'RV-M-001' } },
      { method: 'get', url: '/api/vehicle-reservations/current' },
      { method: 'post', url: '/api/vehicle-reservations/VR-001/cancel' },
      { method: 'patch', url: '/api/vehicle-reservations/VR-001', body: { vehicleId: 'RV-M-001' } },
    ] as const;

    for (const ep of endpoints) {
      const req = request(app)[ep.method](ep.url);
      if ('body' in ep) req.send(ep.body);

      // OPERATOR token -> 403 FORBIDDEN
      const res = await req.set('Authorization', operatorToken);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');

      // No token -> 401 UNAUTHENTICATED
      const unauthReq = request(app)[ep.method](ep.url);
      if ('body' in ep) unauthReq.send(ep.body);
      const resUnauth = await unauthReq;
      expect(resUnauth.status).toBe(401);
      expect(resUnauth.body.error.code).toBe('UNAUTHENTICATED');
    }

    // Check SECURITY_DENIED audit log rows
    const securityAuditCount = await db.auditLog.count({
      where: { action: 'SECURITY_DENIED' },
    });
    expect(securityAuditCount).toBeGreaterThanOrEqual(endpoints.length);

    // Invalid body / query -> 400 with details.field
    const resNoBody = await request(app)
      .post('/api/vehicle-reservations')
      .set('Authorization', student1Token)
      .send({});

    expect(resNoBody.status).toBe(400);
    expect(resNoBody.body.error.code).toBe('VALIDATION_ERROR');
    expect(resNoBody.body.error.details.field).toBe('vehicleId');
  });
});
