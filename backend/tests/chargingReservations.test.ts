// Checker tests for T-19: Charging <-> reservations (D-23)
// - Charge on return (D-13, FR-12)
// - Cancel queued charging request on reserve / changeVehicle (D-18, FR-06, FR-09, FR-62)
// - Charging items in GET /me/history (FR-10)
// Written from TASKS.md, SPEC.md, ARCHITECTURE.md, and CONTRACTS.md before reading the writer's code.

import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createTestApp, resetDb, loginAs } from './helpers';
import { db } from '../src/core/db';
import { config } from '../src/core/config';
import { events } from '../src/core/events';

const app = createTestApp();

describe('T-19: Charging <-> reservations (D-13, D-18, FR-10, FR-12, FR-62, D-23)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  // Helper: pick up an available rental vehicle as a student (creates CONFIRMED -> ACTIVE rental)
  // Or build an ACTIVE rental directly / via API so we have a clean in-use vehicle.
  async function createActiveRental(user: 'student1' | 'student2', vehicleId: string, batteryPct?: number) {
    if (batteryPct !== undefined) {
      await db.rentalVehicle.update({
        where: { id: vehicleId },
        data: { batteryPct },
      });
    }
    const resReserve = await request(app)
      .post('/api/vehicle-reservations')
      .set('Authorization', loginAs(user))
      .send({ vehicleId });
    expect(resReserve.status).toBe(201);
    const reservationId: string = resReserve.body.id;

    const resPickup = await request(app)
      .post(`/api/vehicle-reservations/${reservationId}/pickup`)
      .set('Authorization', loginAs(user))
      .send();
    expect(resPickup.status).toBe(200);
    return reservationId;
  }

  // =========================================================================
  // 1. Return with charging (D-13, FR-12, AC-1, AC-2)
  // =========================================================================

  describe('Return with charging (D-13, FR-12)', () => {
    it('D-13 / FR-12 / T-19 AC-1: return with requestCharging -> 200, reservation COMPLETED, vehicle parked at return Hub, and QUEUED RENTAL request with ChargingRequestView estimates', async () => {
      // student1 reserves and picks up RV-D-002 (battery 30% in fixture)
      const reservationId = await createActiveRental('student1', 'RV-D-002', 35);
      const neededBy = new Date(Date.now() + 2 * 3600_000).toISOString();

      const emittedHubs: string[] = [];
      events.on('CHARGING_QUEUE_CHANGED', (payload) => {
        emittedHubs.push(payload.hubId);
      });

      const res = await request(app)
        .post(`/api/vehicle-reservations/${reservationId}/return`)
        .set('Authorization', loginAs('student1'))
        .send({
          hubId: 'campus-a',
          requestCharging: {
            targetPct: 90,
            neededBy,
          },
        });

      expect(res.status).toBe(200);
      expect(res.body.reservation).toBeDefined();
      expect(res.body.reservation.id).toBe(reservationId);
      expect(res.body.reservation.status).toBe('COMPLETED');
      expect(res.body.reservation.returnHubId).toBe('campus-a');
      expect(res.body.reservation.endReason).toBe('RETURNED');
      expect(res.body.reservation.endBatteryPct).toBe(35);

      const cr = res.body.chargingRequest;
      expect(cr).not.toBeNull();
      expect(cr.id).toEqual(expect.any(String));
      expect(cr.status).toBe('QUEUED');
      expect(cr.mode).toBe('QUEUE');
      expect(cr.hubId).toBe('campus-a');
      expect(cr.vehicleClass).toBe('MOTORCYCLE');
      expect(cr.vehicleKind).toBe('RENTAL');
      expect(cr.rentalVehicleId).toBe('RV-D-002');
      expect(cr.privateEvId).toBeNull();
      expect(cr.startPct).toBe(35);
      expect(cr.currentPct).toBe(35);
      expect(cr.targetPct).toBe(90);
      expect(cr.neededBy).toBe(neededBy);
      expect(cr.queuePosition).toEqual(expect.any(Number));
      expect(cr.queuePosition).toBeGreaterThanOrEqual(1);
      expect(cr.estimatedStart).toEqual(expect.any(String));
      expect(cr.estimatedEnd).toEqual(expect.any(String));
      expect(cr.serverNow).toEqual(expect.any(String));
      // Must not expose internal user ids
      expect(cr.requestedById).toBeUndefined();
      expect(cr.ownerId).toBeUndefined();

      // Check DB state: vehicle parked at campus-a occupying CPA-F-M-02
      const vehicleInDb = await db.rentalVehicle.findUniqueOrThrow({ where: { id: 'RV-D-002' } });
      expect(vehicleInDb.hubId).toBe('campus-a');
      expect(vehicleInDb.status).toBe('AVAILABLE');
      expect(vehicleInDb.parkingSpaceId).toBe('CPA-F-M-02');

      const spaceInDb = await db.parkingSpace.findUniqueOrThrow({ where: { id: 'CPA-F-M-02' } });
      expect(spaceInDb.status).toBe('OCCUPIED');

      const crInDb = await db.chargingRequest.findUniqueOrThrow({ where: { id: cr.id } });
      expect(crInDb.ownerId).toBe('student1');
      expect(crInDb.requestedById).toBe('student1');
      expect(crInDb.hubId).toBe('campus-a');
      expect(crInDb.rentalVehicleId).toBe('RV-D-002');
      expect(crInDb.currentPct).toBe(35);
      expect(crInDb.targetPct).toBe(90);

      expect(emittedHubs).toContain('campus-a');
    });

    it('D-13 / FR-12 / T-19 AC-1: return low-battery vehicle (< MIN_RENTAL_BATTERY_PCT) with requestCharging transitions vehicle to LOW_BATTERY and queues charging', async () => {
      const reservationId = await createActiveRental('student1', 'RV-D-001', 80);
      const lowBat = config.MIN_RENTAL_BATTERY_PCT - 1; // 19%
      await db.rentalVehicle.update({
        where: { id: 'RV-D-001' },
        data: { batteryPct: lowBat },
      });

      const res = await request(app)
        .post(`/api/vehicle-reservations/${reservationId}/return`)
        .set('Authorization', loginAs('student1'))
        .send({
          hubId: 'dorm',
          requestCharging: { targetPct: 80 },
        });

      expect(res.status).toBe(200);
      expect(res.body.reservation.status).toBe('COMPLETED');
      expect(res.body.reservation.vehicle.status).toBe('LOW_BATTERY');
      expect(res.body.chargingRequest).not.toBeNull();
      expect(res.body.chargingRequest.status).toBe('QUEUED');
      expect(res.body.chargingRequest.currentPct).toBe(lowBat);
      expect(res.body.chargingRequest.targetPct).toBe(80);
    });

    it('D-13 / T-19 AC-2: all-or-nothing rollback when targetPct <= vehicle batteryPct (400 requestCharging.targetPct, rental stays ACTIVE, vehicle IN_USE, space FREE, no charging_request row)', async () => {
      const reservationId = await createActiveRental('student1', 'RV-A-001', 70);

      // Equal to batteryPct (70 <= 70)
      const resEqual = await request(app)
        .post(`/api/vehicle-reservations/${reservationId}/return`)
        .set('Authorization', loginAs('student1'))
        .send({
          hubId: 'campus-b',
          requestCharging: { targetPct: 70 },
        });

      expect(resEqual.status).toBe(400);
      expect(resEqual.body.error.code).toBe('VALIDATION_ERROR');
      expect(resEqual.body.error.details?.field).toBe('requestCharging.targetPct');

      // Less than batteryPct (50 <= 70)
      const resLess = await request(app)
        .post(`/api/vehicle-reservations/${reservationId}/return`)
        .set('Authorization', loginAs('student1'))
        .send({
          hubId: 'campus-b',
          requestCharging: { targetPct: 50 },
        });

      expect(resLess.status).toBe(400);
      expect(resLess.body.error.code).toBe('VALIDATION_ERROR');
      expect(resLess.body.error.details?.field).toBe('requestCharging.targetPct');

      // Verify full rollback: reservation still ACTIVE, vehicle still IN_USE with no parkingSpaceId, CPB-F-M-02 still FREE, no chargingRequest for RV-A-001
      const reservationInDb = await db.vehicleReservation.findUniqueOrThrow({ where: { id: reservationId } });
      expect(reservationInDb.status).toBe('ACTIVE');
      expect(reservationInDb.returnedAt).toBeNull();
      expect(reservationInDb.returnHubId).toBeNull();

      const vehicleInDb = await db.rentalVehicle.findUniqueOrThrow({ where: { id: 'RV-A-001' } });
      expect(vehicleInDb.status).toBe('IN_USE');
      expect(vehicleInDb.parkingSpaceId).toBeNull();

      const spaceInDb = await db.parkingSpace.findUniqueOrThrow({ where: { id: 'CPB-F-M-02' } });
      expect(spaceInDb.status).toBe('FREE');

      const crCount = await db.chargingRequest.count({ where: { rentalVehicleId: 'RV-A-001' } });
      expect(crCount).toBe(0);
    });

    it('D-13 / T-19 AC-2: route validation rejects bad requestCharging shape, targetPct 0 or 101, and past/invalid neededBy with dotted field names and 0 state changes', async () => {
      const reservationId = await createActiveRental('student1', 'RV-A-001', 70);

      // 1. Bad requestCharging shape (not an object)
      for (const badShape of [true, 'yes', 123, []]) {
        const res = await request(app)
          .post(`/api/vehicle-reservations/${reservationId}/return`)
          .set('Authorization', loginAs('student1'))
          .send({ hubId: 'campus-a', requestCharging: badShape });
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
        expect(res.body.error.details?.field).toBe('requestCharging');
      }

      // 2. targetPct = 0 and 101 and missing
      for (const badTarget of [0, -5, 101, 'eighty', undefined]) {
        const res = await request(app)
          .post(`/api/vehicle-reservations/${reservationId}/return`)
          .set('Authorization', loginAs('student1'))
          .send({
            hubId: 'campus-a',
            requestCharging: badTarget === undefined ? {} : { targetPct: badTarget },
          });
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
        expect(res.body.error.details?.field).toBe('requestCharging.targetPct');
      }

      // 3. past neededBy or invalid ISO
      const pastIso = new Date(Date.now() - 60_000).toISOString();
      for (const badNeededBy of [pastIso, 'not-a-date']) {
        const res = await request(app)
          .post(`/api/vehicle-reservations/${reservationId}/return`)
          .set('Authorization', loginAs('student1'))
          .send({
            hubId: 'campus-a',
            requestCharging: { targetPct: 90, neededBy: badNeededBy },
          });
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
        expect(res.body.error.details?.field).toBe('requestCharging.neededBy');
      }

      // Confirm reservation is still ACTIVE
      const reservationInDb = await db.vehicleReservation.findUniqueOrThrow({ where: { id: reservationId } });
      expect(reservationInDb.status).toBe('ACTIVE');
    });

    it('FR-12 / T-19 AC-2: return without requestCharging keeps T-12 behaviour unchanged with chargingRequest: null', async () => {
      const reservationId = await createActiveRental('student1', 'RV-A-001', 70);

      const res = await request(app)
        .post(`/api/vehicle-reservations/${reservationId}/return`)
        .set('Authorization', loginAs('student1'))
        .send({ hubId: 'campus-a' });

      expect(res.status).toBe(200);
      expect(res.body.reservation.status).toBe('COMPLETED');
      expect(res.body.chargingRequest).toBeNull();

      const crCount = await db.chargingRequest.count({ where: { rentalVehicleId: 'RV-A-001' } });
      expect(crCount).toBe(0);
    });
  });

  // =========================================================================
  // 2. Reserve / changeVehicle cancels queued charging request (D-18, AC-3)
  // =========================================================================

  describe('Reserve / changeVehicle cancels a queued charging request (D-18, FR-06, FR-09, FR-62)', () => {
    it('D-18 / FR-06 / FR-62 / T-19 AC-3: reserving a vehicle with a student-owned QUEUED charging request cancels it and notifies its owner CHARGING_CANCELLED', async () => {
      // In the fixture: RV-M-005 at metro is AVAILABLE (60% battery) and has QUEUED request CR-M-002 owned by student1.
      // First clear student2's existing CONFIRMED reservation VR-001 so student2 can reserve RV-M-005.
      await request(app)
        .post('/api/vehicle-reservations/VR-001/cancel')
        .set('Authorization', loginAs('student2'))
        .send();

      const emittedHubs: string[] = [];
      events.on('CHARGING_QUEUE_CHANGED', (payload) => {
        emittedHubs.push(payload.hubId);
      });

      const res = await request(app)
        .post('/api/vehicle-reservations')
        .set('Authorization', loginAs('student2'))
        .send({ vehicleId: 'RV-M-005' });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('CONFIRMED');
      expect(res.body.vehicle.id).toBe('RV-M-005');

      // Charging request CR-M-002 must now be CANCELLED
      const cr = await db.chargingRequest.findUniqueOrThrow({ where: { id: 'CR-M-002' } });
      expect(cr.status).toBe('CANCELLED');

      // Student1 must receive exactly one CHARGING_CANCELLED notification
      const notifs = await db.notification.findMany({
        where: { userId: 'student1', type: 'CHARGING_CANCELLED' },
      });
      expect(notifs).toHaveLength(1);
      const data = notifs[0]!.data as Record<string, unknown>;
      expect(data.chargingRequestId).toBe('CR-M-002');
      expect(data.rentalVehicleId).toBe('RV-M-005');
      expect(data.hubId).toBe('metro');
      expect(data.reason).toBe('VEHICLE_RESERVED');

      expect(emittedHubs).toContain('metro');
    });

    it('D-18 / FR-06 / T-19 AC-3: idempotent replay of reserve does not fail or duplicate CHARGING_CANCELLED notification', async () => {
      await request(app)
        .post('/api/vehicle-reservations/VR-001/cancel')
        .set('Authorization', loginAs('student2'))
        .send();

      const idemKey = 'idem-d18-replay-001';
      const first = await request(app)
        .post('/api/vehicle-reservations')
        .set('Authorization', loginAs('student2'))
        .set('Idempotency-Key', idemKey)
        .send({ vehicleId: 'RV-M-005' });
      expect(first.status).toBe(201);

      const second = await request(app)
        .post('/api/vehicle-reservations')
        .set('Authorization', loginAs('student2'))
        .set('Idempotency-Key', idemKey)
        .send({ vehicleId: 'RV-M-005' });
      expect(second.status).toBe(201);
      expect(second.body.id).toBe(first.body.id);

      const notifs = await db.notification.findMany({
        where: { userId: 'student1', type: 'CHARGING_CANCELLED' },
      });
      expect(notifs).toHaveLength(1);
    });

    it('D-18 / FR-09 / FR-62 / T-19 AC-3: changing reservation to a vehicle with a QUEUED request cancels that request and notifies its owner', async () => {
      // In the fixture: student2 holds VR-001 (CONFIRMED on RV-M-006 at metro).
      // RV-M-005 at metro has QUEUED request CR-M-002 owned by student1.
      const res = await request(app)
        .patch('/api/vehicle-reservations/VR-001')
        .set('Authorization', loginAs('student2'))
        .send({ vehicleId: 'RV-M-005' });

      expect(res.status).toBe(200);
      expect(res.body.id).toBe('VR-001');
      expect(res.body.vehicle.id).toBe('RV-M-005');

      const cr = await db.chargingRequest.findUniqueOrThrow({ where: { id: 'CR-M-002' } });
      expect(cr.status).toBe('CANCELLED');

      const notifs = await db.notification.findMany({
        where: { userId: 'student1', type: 'CHARGING_CANCELLED' },
      });
      expect(notifs).toHaveLength(1);
      const data = notifs[0]!.data as Record<string, unknown>;
      expect(data.chargingRequestId).toBe('CR-M-002');
      expect(data.rentalVehicleId).toBe('RV-M-005');
      expect(data.hubId).toBe('metro');
      expect(data.reason).toBe('VEHICLE_RESERVED');
    });

    it('D-18 / T-19 AC-3: reserving a vehicle with a fleet-dispatched QUEUED request (ownerId null) cancels the request without creating a notification', async () => {
      // Create a fleet QUEUED charging request (ownerId: null) on RV-D-001 at dorm
      const fleetReq = await db.chargingRequest.create({
        data: {
          requestedById: 'operator1',
          ownerId: null,
          vehicleKind: 'RENTAL',
          rentalVehicleId: 'RV-D-001',
          vehicleClass: 'MOTORCYCLE',
          hubId: 'dorm',
          mode: 'QUEUE',
          status: 'QUEUED',
          targetPct: 100,
          startPct: 90,
          currentPct: 90,
        },
      });

      const notifCountBefore = await db.notification.count();

      const res = await request(app)
        .post('/api/vehicle-reservations')
        .set('Authorization', loginAs('student1'))
        .send({ vehicleId: 'RV-D-001' });

      expect(res.status).toBe(201);

      const updatedReq = await db.chargingRequest.findUniqueOrThrow({ where: { id: fleetReq.id } });
      expect(updatedReq.status).toBe('CANCELLED');

      const notifCountAfter = await db.notification.count();
      expect(notifCountAfter).toBe(notifCountBefore);
    });

    it('D-18 / T-19 AC-3: when reserve fails (caller already has an active reservation -> 409), the vehicle QUEUED request stays QUEUED', async () => {
      // student2 already has VR-001 CONFIRMED in fixture.
      // student2 tries to reserve RV-M-005 (which has QUEUED CR-M-002 owned by student1).
      const res = await request(app)
        .post('/api/vehicle-reservations')
        .set('Authorization', loginAs('student2'))
        .send({ vehicleId: 'RV-M-005' });

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('ACTIVE_RENTAL_EXISTS');

      // CR-M-002 must still be QUEUED and no notification created
      const cr = await db.chargingRequest.findUniqueOrThrow({ where: { id: 'CR-M-002' } });
      expect(cr.status).toBe('QUEUED');

      const notifs = await db.notification.findMany({
        where: { userId: 'student1', type: 'CHARGING_CANCELLED' },
      });
      expect(notifs).toHaveLength(0);
    });
  });

  // =========================================================================
  // 3. History with charging items (FR-10, AC-4, AC-5)
  // =========================================================================

  describe('GET /me/history with charging items (FR-10)', () => {
    // Clear existing bookings for student1 and student2 so we control exact timestamps
    async function clearBookingsForHistoryTest() {
      await db.vehicleReservation.deleteMany();
      await db.parkingReservation.deleteMany();
      await db.chargingRequest.deleteMany({ where: { ownerId: { not: null } } });
    }

    it('FR-10 / T-19 AC-4: interleaves vehicle, parking, and charging items newest first, paginates with limit=2 including a cross-kind createdAt tie, and excludes other users and fleet requests', async () => {
      await clearBookingsForHistoryTest();

      const baseMs = Date.parse('2026-11-25T00:00:00.000Z');
      const t1 = new Date(baseMs + 10_000); // oldest: student1 vehicle reservation (COMPLETED)
      const t2 = new Date(baseMs + 20_000); // student1 charging request (COMPLETED)
      const t3 = new Date(baseMs + 30_000); // TIE timestamp: student1 parking reservation AND student1 charging request
      const t4 = new Date(baseMs + 40_000); // newest: student1 vehicle reservation (CANCELLED)
      const tOther = new Date(baseMs + 50_000); // student2 charging request (must not appear)

      const vrOld = await db.vehicleReservation.create({
        data: {
          userId: 'student1',
          rentalVehicleId: 'RV-M-001',
          hubId: 'metro',
          status: 'COMPLETED',
          createdAt: t1,
          expiresAt: new Date(baseMs + 15 * 60_000),
          pickedUpAt: new Date(baseMs + 11_000),
          returnedAt: new Date(baseMs + 14_000),
          returnHubId: 'metro',
          startBatteryPct: 80,
          endBatteryPct: 75,
          endReason: 'RETURNED',
        },
      });

      const crDone = await db.chargingRequest.create({
        data: {
          requestedById: 'student1',
          ownerId: 'student1',
          vehicleKind: 'PRIVATE',
          privateEvId: 'PEV-01',
          vehicleClass: 'CAR',
          hubId: 'dorm',
          mode: 'QUEUE',
          status: 'COMPLETED',
          targetPct: 90,
          startPct: 60,
          currentPct: 90,
          finalPct: 90,
          endReason: 'TARGET_REACHED',
          createdAt: t2,
          startedAt: new Date(baseMs + 21_000),
          endedAt: new Date(baseMs + 25_000),
        },
      });

      const prTie = await db.parkingReservation.create({
        data: {
          userId: 'student1',
          parkingSpaceId: 'MET-P-M-01',
          hubId: 'metro',
          vehicleClass: 'MOTORCYCLE',
          windowStart: new Date(baseMs + 3600_000),
          windowEnd: new Date(baseMs + 7200_000),
          status: 'CONFIRMED',
          expiresAt: new Date(baseMs + 3600_000 + 15 * 60_000),
          createdAt: t3,
        },
      });

      const crTie = await db.chargingRequest.create({
        data: {
          requestedById: 'student1',
          ownerId: 'student1',
          vehicleKind: 'PRIVATE',
          privateEvId: 'PEV-03',
          vehicleClass: 'MOTORCYCLE',
          hubId: 'dorm',
          mode: 'QUEUE',
          status: 'QUEUED',
          targetPct: 85,
          startPct: 55,
          currentPct: 55,
          desiredTime: t3,
          createdAt: t3,
        },
      });

      const vrNew = await db.vehicleReservation.create({
        data: {
          userId: 'student1',
          rentalVehicleId: 'RV-M-002',
          hubId: 'metro',
          status: 'CANCELLED',
          endReason: 'CANCELLED',
          createdAt: t4,
          expiresAt: new Date(baseMs + 40_000 + 15 * 60_000),
        },
      });

      // Another student's charging request (must never be returned for student1)
      await db.chargingRequest.create({
        data: {
          requestedById: 'student2',
          ownerId: 'student2',
          vehicleKind: 'PRIVATE',
          privateEvId: 'PEV-02',
          vehicleClass: 'MOTORCYCLE',
          hubId: 'metro',
          mode: 'QUEUE',
          status: 'QUEUED',
          targetPct: 95,
          startPct: 70,
          currentPct: 70,
          createdAt: tOther,
        },
      });

      // Fetch full list in one call
      const fullRes = await request(app)
        .get('/api/me/history')
        .set('Authorization', loginAs('student1'));
      expect(fullRes.status).toBe(200);
      const fullItems: Array<{ kind: string; at: string; item: { id: string } }> = fullRes.body.items;
      expect(fullItems).toHaveLength(5);

      // Verify newest first order: vrNew (t4), then the two t3 items (prTie and crTie ordered by id DESC), then crDone (t2), then vrOld (t1)
      expect(fullItems[0]!.item.id).toBe(vrNew.id);
      expect(fullItems[0]!.kind).toBe('vehicle');
      const tieIds = [fullItems[1]!.item.id, fullItems[2]!.item.id];
      expect(tieIds.sort()).toEqual([prTie.id, crTie.id].sort());
      expect(fullItems[3]!.item.id).toBe(crDone.id);
      expect(fullItems[3]!.kind).toBe('charging');
      expect(fullItems[4]!.item.id).toBe(vrOld.id);
      expect(fullItems[4]!.kind).toBe('vehicle');

      // Paginate with limit=2 and verify concatenation equals full list without gaps or duplicates
      const pagedItems: Array<{ kind: string; at: string; item: { id: string } }> = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const url: string = cursor
          ? `/api/me/history?limit=2&cursor=${encodeURIComponent(cursor)}`
          : '/api/me/history?limit=2';
        const pageRes = await request(app)
          .get(url)
          .set('Authorization', loginAs('student1'));
        expect(pageRes.status).toBe(200);
        pagedItems.push(...pageRes.body.items);
        cursor = pageRes.body.nextCursor;
        pages += 1;
      } while (cursor !== null && pages < 10);

      expect(pagedItems.map((x) => `${x.kind}:${x.item.id}`)).toEqual(
        fullItems.map((x) => `${x.kind}:${x.item.id}`),
      );
    });

    it('FR-10 / T-19 AC-4 & AC-5: type=charging returns only charging items; live items carry estimates and finished items have null estimates', async () => {
      // In default fixture, student1 owns:
      // - CR-M-002 (QUEUED at metro, MOTORCYCLE)
      // - CR-M-004 (SCHEDULED at metro, MOTORCYCLE)
      // - CR-C-001 (CHARGING at metro, CAR)
      // Plus let's insert a COMPLETED charging request for student1
      const crCompleted = await db.chargingRequest.create({
        data: {
          requestedById: 'student1',
          ownerId: 'student1',
          vehicleKind: 'PRIVATE',
          privateEvId: 'PEV-03',
          vehicleClass: 'MOTORCYCLE',
          hubId: 'dorm',
          mode: 'QUEUE',
          status: 'COMPLETED',
          targetPct: 80,
          startPct: 50,
          currentPct: 80,
          finalPct: 80,
          endReason: 'TARGET_REACHED',
        },
      });

      const res = await request(app)
        .get('/api/me/history?type=charging')
        .set('Authorization', loginAs('student1'));

      expect(res.status).toBe(200);
      const items: Array<{ kind: string; at: string; item: Record<string, unknown> }> = res.body.items;
      expect(items.length).toBe(4);
      expect(items.every((x) => x.kind === 'charging')).toBe(true);

      const ids = items.map((x) => x.item.id);
      expect(ids).toContain('CR-M-002');
      expect(ids).toContain('CR-M-004');
      expect(ids).toContain('CR-C-001');
      expect(ids).toContain(crCompleted.id);
      // Must NOT include CR-M-001 (fleet, ownerId null) or CR-M-003 (owned by student2)
      expect(ids).not.toContain('CR-M-001');
      expect(ids).not.toContain('CR-M-003');

      // Check estimates on live vs finished items
      const queuedView = items.find((x) => x.item.id === 'CR-M-002')!.item;
      expect(queuedView.queuePosition).toBe(1);
      expect(queuedView.estimatedStart).toEqual(expect.any(String));
      expect(queuedView.estimatedEnd).toEqual(expect.any(String));

      const scheduledView = items.find((x) => x.item.id === 'CR-M-004')!.item;
      expect(scheduledView.queuePosition).toBeNull();
      expect(scheduledView.estimatedStart).toEqual(expect.any(String));
      expect(scheduledView.estimatedEnd).toEqual(expect.any(String));

      const chargingView = items.find((x) => x.item.id === 'CR-C-001')!.item;
      expect(chargingView.queuePosition).toBeNull();
      expect(chargingView.estimatedStart).toBeNull();
      expect(chargingView.estimatedEnd).toEqual(expect.any(String));

      const completedView = items.find((x) => x.item.id === crCompleted.id)!.item;
      expect(completedView.queuePosition).toBeNull();
      expect(completedView.estimatedStart).toBeNull();
      expect(completedView.estimatedEnd).toBeNull();
    });

    it('FR-10 / T-19 AC-5: status filter supports charging-only (QUEUED), reservation-only (CONFIRMED), and shared (CANCELLED) statuses, and rejects invalid status DONE with 400', async () => {
      // Seed student1 with one CANCELLED vehicle reservation, one CANCELLED parking reservation, and one CANCELLED charging request
      await db.vehicleReservation.create({
        data: {
          userId: 'student1',
          rentalVehicleId: 'RV-D-001',
          hubId: 'dorm',
          status: 'CANCELLED',
          endReason: 'CANCELLED',
          expiresAt: new Date(Date.now() + 600_000),
        },
      });
      await db.parkingReservation.create({
        data: {
          userId: 'student1',
          parkingSpaceId: 'DOR-P-M-01',
          hubId: 'dorm',
          vehicleClass: 'MOTORCYCLE',
          windowStart: new Date(Date.now() + 3600_000),
          windowEnd: new Date(Date.now() + 7200_000),
          status: 'CANCELLED',
          expiresAt: new Date(Date.now() + 3600_000 + 900_000),
        },
      });
      await db.chargingRequest.create({
        data: {
          requestedById: 'student1',
          ownerId: 'student1',
          vehicleKind: 'PRIVATE',
          privateEvId: 'PEV-03',
          vehicleClass: 'MOTORCYCLE',
          hubId: 'dorm',
          mode: 'QUEUE',
          status: 'CANCELLED',
          targetPct: 90,
          startPct: 55,
          currentPct: 55,
        },
      });

      // 1. Charging-only status: QUEUED -> only charging items
      const resQueued = await request(app)
        .get('/api/me/history?status=QUEUED')
        .set('Authorization', loginAs('student1'));
      expect(resQueued.status).toBe(200);
      expect(resQueued.body.items.length).toBeGreaterThanOrEqual(1);
      for (const entry of resQueued.body.items) {
        expect(entry.kind).toBe('charging');
        expect(entry.item.status).toBe('QUEUED');
      }

      // Charging-only status when type=vehicle -> empty list (not 400)
      const resQueuedVehicleOnly = await request(app)
        .get('/api/me/history?type=vehicle&status=QUEUED')
        .set('Authorization', loginAs('student1'));
      expect(resQueuedVehicleOnly.status).toBe(200);
      expect(resQueuedVehicleOnly.body.items).toEqual([]);

      // 2. Reservation-only status: CONFIRMED -> only vehicle/parking items
      const resConfirmed = await request(app)
        .get('/api/me/history?status=CONFIRMED')
        .set('Authorization', loginAs('student1'));
      expect(resConfirmed.status).toBe(200);
      expect(resConfirmed.body.items.length).toBeGreaterThanOrEqual(1);
      for (const entry of resConfirmed.body.items) {
        expect(['vehicle', 'parking']).toContain(entry.kind);
        expect(entry.item.status).toBe('CONFIRMED');
      }

      // Reservation-only status when type=charging -> empty list (not 400)
      const resConfirmedChargingOnly = await request(app)
        .get('/api/me/history?type=charging&status=CONFIRMED')
        .set('Authorization', loginAs('student1'));
      expect(resConfirmedChargingOnly.status).toBe(200);
      expect(resConfirmedChargingOnly.body.items).toEqual([]);

      // 3. Shared status: CANCELLED -> returns all three kinds
      const resCancelled = await request(app)
        .get('/api/me/history?status=CANCELLED')
        .set('Authorization', loginAs('student1'));
      expect(resCancelled.status).toBe(200);
      const kinds = new Set(resCancelled.body.items.map((x: { kind: string }) => x.kind));
      expect(kinds.has('vehicle')).toBe(true);
      expect(kinds.has('parking')).toBe(true);
      expect(kinds.has('charging')).toBe(true);
      for (const entry of resCancelled.body.items) {
        expect(entry.item.status).toBe('CANCELLED');
      }

      // 4. Invalid status: DONE -> 400 VALIDATION_ERROR on field 'status'
      const resInvalid = await request(app)
        .get('/api/me/history?status=DONE')
        .set('Authorization', loginAs('student1'));
      expect(resInvalid.status).toBe(400);
      expect(resInvalid.body.error.code).toBe('VALIDATION_ERROR');
      expect(resInvalid.body.error.details?.field).toBe('status');
    });
  });
});
