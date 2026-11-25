// Incident report and recovery tests (T-22, FR-13, FR-36..40, FR-62, FR-63, BR-07, D-06, UC-21 E2, UC-22 A1).
// Written from SPEC, ARCHITECTURE, CONTRACTS, and T-22 ticket before reading writer code.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { config } from '../src/core/config';
import { db } from '../src/core/db';
import { events } from '../src/core/events';
import * as chargingRequestsService from '../src/modules/charging/chargingRequests.service';
import * as incidentsService from '../src/modules/incidents/incidents.service';
import { createTestApp, loginAs, resetDb } from './helpers';

const app = createTestApp();

const MIN_MS = 60_000;
const HR_MS = 3_600_000;

function relIso(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

describe('T-22 Incident report and recovery', () => {
  beforeEach(async () => {
    await resetDb();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ---- AC-1: FR-37 operator create & validation ----

  it('FR-37 T-22 AC-1 operator creates REPORTED incident with INCIDENT_CREATED audit row', async () => {
    const res = await request(app)
      .post('/api/ops/incidents')
      .set('Authorization', loginAs('operator1'))
      .send({
        resourceType: 'RENTAL_VEHICLE',
        resourceId: 'RV-D-001',
        hubId: 'dorm',
        vehicleClass: 'MOTORCYCLE',
        category: 'VEHICLE_FAULT',
        notes: 'Front brake squeaking loudly',
      });

    expect(res.status).toBe(201);
    expect(res.body.linkedToExisting).toBe(false);
    expect(res.body.incident.status).toBe('REPORTED');
    expect(res.body.incident.source).toBe('OPERATOR');
    expect(res.body.incident.reportedById).toBe('operator1');
    expect(res.body.incident.resourceId).toBe('RV-D-001');
    expect(res.body.incident.hubId).toBe('dorm');
    expect(res.body.incident.vehicleClass).toBe('MOTORCYCLE');
    expect(res.body.incident.category).toBe('VEHICLE_FAULT');
    expect(Array.isArray(res.body.impacts)).toBe(true);

    const audit = await db.auditLog.findFirst({
      where: { action: 'INCIDENT_CREATED', actorId: 'operator1' },
      orderBy: { at: 'desc' },
    });
    expect(audit).not.toBeNull();
    expect(audit?.entityType).toBe('incident');
    expect(audit?.entityIds).toContain(res.body.incident.id);
    expect(audit?.entityIds).toContain('RV-D-001');
  });

  it('FR-37 T-22 AC-1 rejects missing field, unknown resource, wrong Hub, class mismatch, and too-long notes with 400 and details.field', async () => {
    const beforeCount = await db.incident.count();

    const cases: Array<{ name: string; body: Record<string, unknown>; field: string }> = [
      {
        name: 'empty notes',
        body: {
          resourceType: 'RENTAL_VEHICLE',
          resourceId: 'RV-D-001',
          hubId: 'dorm',
          vehicleClass: 'MOTORCYCLE',
          category: 'VEHICLE_FAULT',
          notes: '   ',
        },
        field: 'notes',
      },
      {
        name: 'notes > 1000 chars',
        body: {
          resourceType: 'RENTAL_VEHICLE',
          resourceId: 'RV-D-001',
          hubId: 'dorm',
          vehicleClass: 'MOTORCYCLE',
          category: 'VEHICLE_FAULT',
          notes: 'x'.repeat(1001),
        },
        field: 'notes',
      },
      {
        name: 'unknown resourceId',
        body: {
          resourceType: 'RENTAL_VEHICLE',
          resourceId: 'RV-DOES-NOT-EXIST',
          hubId: 'dorm',
          vehicleClass: 'MOTORCYCLE',
          category: 'VEHICLE_FAULT',
          notes: 'Missing bike',
        },
        field: 'resourceId',
      },
      {
        name: 'resource at wrong hub',
        body: {
          resourceType: 'RENTAL_VEHICLE',
          resourceId: 'RV-D-001',
          hubId: 'campus-a',
          vehicleClass: 'MOTORCYCLE',
          category: 'VEHICLE_FAULT',
          notes: 'Wrong hub',
        },
        field: 'hubId',
      },
      {
        name: 'vehicleClass mismatch',
        body: {
          resourceType: 'RENTAL_VEHICLE',
          resourceId: 'RV-D-001',
          hubId: 'dorm',
          vehicleClass: 'CAR',
          category: 'VEHICLE_FAULT',
          notes: 'Wrong class',
        },
        field: 'vehicleClass',
      },
    ];

    for (const c of cases) {
      const res = await request(app)
        .post('/api/ops/incidents')
        .set('Authorization', loginAs('operator1'))
        .send(c.body);

      expect(res.status, `case "${c.name}" status`).toBe(400);
      expect(res.body.error.code, `case "${c.name}" code`).toBe('VALIDATION_ERROR');
      expect(res.body.error.details?.field, `case "${c.name}" field`).toBe(c.field);
    }

    expect(await db.incident.count()).toBe(beforeCount);
  });

  // ---- AC-2: UC-21 E2 duplicate -> link & race ----

  it('UC-21 E2 T-22 AC-2 links a second report on a resource with an open incident without duplicating incident or withdrawal', async () => {
    const first = await request(app)
      .post('/api/ops/incidents')
      .set('Authorization', loginAs('operator1'))
      .send({
        resourceType: 'CHARGING_POINT',
        resourceId: 'DOR-CP-M-01',
        hubId: 'dorm',
        vehicleClass: 'MOTORCYCLE',
        category: 'CHARGER_FAULT',
        notes: 'First report',
      });
    expect(first.status).toBe(201);
    expect(first.body.linkedToExisting).toBe(false);

    const second = await request(app)
      .post('/api/ops/incidents')
      .set('Authorization', loginAs('operator1'))
      .send({
        resourceType: 'CHARGING_POINT',
        resourceId: 'DOR-CP-M-01',
        hubId: 'dorm',
        vehicleClass: 'MOTORCYCLE',
        category: 'ELECTRICAL',
        notes: 'Second report on same point',
      });
    expect(second.status).toBe(201);
    expect(second.body.linkedToExisting).toBe(true);
    expect(second.body.incident.id).toBe(first.body.incident.id);
    expect(second.body.impacts).toEqual([]);

    const incidents = await db.incident.findMany({
      where: { resourceType: 'CHARGING_POINT', resourceId: 'DOR-CP-M-01' },
    });
    expect(incidents.length).toBe(1);

    const reports = await db.incidentReport.findMany({
      where: { incidentId: first.body.incident.id },
    });
    expect(reports.length).toBe(2);
  });

  it('UC-21 E2 T-22 AC-2 concurrent duplicate reports produce one incident and two incident_report rows', async () => {
    const payload = {
      resourceType: 'PARKING_SPACE',
      resourceId: 'DOR-P-M-01',
      hubId: 'dorm',
      vehicleClass: 'MOTORCYCLE',
      category: 'OBSTRUCTION',
      notes: 'Blocked by fallen branch',
    };

    const [r1, r2] = await Promise.all([
      request(app).post('/api/ops/incidents').set('Authorization', loginAs('operator1')).send(payload),
      request(app).post('/api/ops/incidents').set('Authorization', loginAs('operator1')).send(payload),
    ]);

    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    expect(r1.body.incident.id).toBe(r2.body.incident.id);
    expect([r1.body.linkedToExisting, r2.body.linkedToExisting].sort()).toEqual([false, true]);

    const incidents = await db.incident.findMany({
      where: { resourceType: 'PARKING_SPACE', resourceId: 'DOR-P-M-01' },
    });
    expect(incidents.length).toBe(1);

    const reports = await db.incidentReport.findMany({
      where: { incidentId: r1.body.incident.id },
    });
    expect(reports.length).toBe(2);
  });

  // ---- AC-3: FR-38 withdrawal from search / availability ----

  it('FR-38 T-22 AC-3 withdraws faulty vehicle, unavailable space, and faulty point from availability/recommend', async () => {
    // 1) Withdraw dorm's only CAR space DOR-P-C-01
    const spaceRes = await request(app)
      .post('/api/ops/incidents')
      .set('Authorization', loginAs('operator1'))
      .send({
        resourceType: 'PARKING_SPACE',
        resourceId: 'DOR-P-C-01',
        hubId: 'dorm',
        vehicleClass: 'CAR',
        category: 'DAMAGE',
        notes: 'Pothole',
      });
    expect(spaceRes.status).toBe(201);

    const dbSpace = await db.parkingSpace.findUnique({ where: { id: 'DOR-P-C-01' } });
    expect(dbSpace?.status).toBe('UNAVAILABLE');

    const parkAvail = await request(app)
      .get('/api/parking/availability')
      .set('Authorization', loginAs('student1'))
      .query({
        hubId: 'dorm',
        vehicleClass: 'CAR',
        from: relIso(30 * MIN_MS),
        to: relIso(2 * HR_MS),
      });
    expect(parkAvail.status).toBe(200);
    expect(parkAvail.body.free).toBe(0);

    // 2) Withdraw dorm's only CAR charging point DOR-CP-C-01
    const pointRes = await request(app)
      .post('/api/ops/incidents')
      .set('Authorization', loginAs('operator1'))
      .send({
        resourceType: 'CHARGING_POINT',
        resourceId: 'DOR-CP-C-01',
        hubId: 'dorm',
        vehicleClass: 'CAR',
        category: 'CHARGER_FAULT',
        notes: 'No power',
      });
    expect(pointRes.status).toBe(201);

    const dbPoint = await db.chargingPoint.findUnique({ where: { id: 'DOR-CP-C-01' } });
    expect(dbPoint?.status).toBe('FAULTY');

    const cleanEv = await db.privateEv.create({
      data: {
        id: 'PEV-AC3',
        ownerId: 'student1',
        type: 'CAR',
        vehicleClass: 'CAR',
        label: 'AC3 Car',
        batteryCapacityKwh: 50,
        batteryPct: 50,
      },
    });
    const chgAvail = await request(app)
      .get('/api/charging/availability')
      .set('Authorization', loginAs('student1'))
      .query({
        hubId: 'dorm',
        privateEvId: cleanEv.id,
        slotStart: relIso(30 * MIN_MS),
        targetPct: 80,
      });
    expect(chgAvail.status).toBe(200);
    expect(chgAvail.body.available).toBe(false);

    // 3) Withdraw RV-D-001 -> FAULTY and absent from /vehicles/recommend
    const vehRes = await request(app)
      .post('/api/ops/incidents')
      .set('Authorization', loginAs('operator1'))
      .send({
        resourceType: 'RENTAL_VEHICLE',
        resourceId: 'RV-D-001',
        hubId: 'dorm',
        vehicleClass: 'MOTORCYCLE',
        category: 'VEHICLE_FAULT',
        notes: 'Flat tire',
      });
    expect(vehRes.status).toBe(201);

    const dbVeh = await db.rentalVehicle.findUnique({ where: { id: 'RV-D-001' } });
    expect(dbVeh?.status).toBe('FAULTY');

    const recRes = await request(app)
      .get('/api/vehicles/recommend')
      .set('Authorization', loginAs('student1'))
      .query({ originHubId: 'dorm', destinationHubId: 'campus-a' });
    expect(recRes.status).toBe(200);
    const ids = (recRes.body.vehicles as Array<{ id: string }>).map((v) => v.id);
    expect(ids).not.toContain('RV-D-001');
  });

  // ---- AC-4: FR-39 / FR-40 rental vehicle recovery ----

  it('FR-39 FR-40 T-22 AC-4 reassigns CONFIRMED vehicle reservation respecting MIN_RENTAL_BATTERY_PCT and not-charging, keeping expiresAt', async () => {
    // At dorm: RV-D-001 (90%) and RV-D-002 (30%).
    // Set RV-D-002 to MIN_RENTAL_BATTERY_PCT - 1 (19%) -> ineligible!
    // Add RV-D-003 at MIN_RENTAL_BATTERY_PCT (20%) and RV-D-004 (80%) with CHARGING request -> RV-D-003 must be picked.
    await db.rentalVehicle.update({
      where: { id: 'RV-D-002' },
      data: { batteryPct: config.MIN_RENTAL_BATTERY_PCT - 1 },
    });
    await db.parkingSpace.createMany({
      data: [
        { id: 'DOR-F-M-04', hubId: 'dorm', vehicleClass: 'MOTORCYCLE', pool: 'FLEET', status: 'OCCUPIED' },
        { id: 'DOR-F-M-05', hubId: 'dorm', vehicleClass: 'MOTORCYCLE', pool: 'FLEET', status: 'OCCUPIED' },
      ],
    });
    await db.rentalVehicle.createMany({
      data: [
        {
          id: 'RV-D-003',
          hubId: 'dorm',
          type: 'E_MOTORCYCLE',
          vehicleClass: 'MOTORCYCLE',
          status: 'AVAILABLE',
          batteryPct: config.MIN_RENTAL_BATTERY_PCT,
          parkingSpaceId: 'DOR-F-M-04',
        },
        {
          id: 'RV-D-004',
          hubId: 'dorm',
          type: 'E_MOTORCYCLE',
          vehicleClass: 'MOTORCYCLE',
          status: 'AVAILABLE',
          batteryPct: 80,
          parkingSpaceId: 'DOR-F-M-05',
        },
      ],
    });
    await db.chargingRequest.create({
      data: {
        id: 'CR-D-BLOCK',
        requestedById: 'operator1',
        vehicleKind: 'RENTAL',
        rentalVehicleId: 'RV-D-004',
        vehicleClass: 'MOTORCYCLE',
        hubId: 'dorm',
        mode: 'QUEUE',
        status: 'CHARGING',
        targetPct: 100,
        startPct: 60,
        currentPct: 80,
        chargingPointId: 'DOR-CP-M-01',
        slotStart: new Date(Date.now() - 10 * MIN_MS),
        slotEnd: new Date(Date.now() + 20 * MIN_MS),
        startedAt: new Date(Date.now() - 10 * MIN_MS),
      },
    });

    const expiresAt = new Date(Date.now() + 12 * MIN_MS);
    await db.rentalVehicle.update({ where: { id: 'RV-D-001' }, data: { status: 'RESERVED' } });
    const vr = await db.vehicleReservation.create({
      data: {
        id: 'VR-D-CONF',
        userId: 'student1',
        rentalVehicleId: 'RV-D-001',
        hubId: 'dorm',
        status: 'CONFIRMED',
        expiresAt,
      },
    });

    const res = await request(app)
      .post('/api/ops/incidents')
      .set('Authorization', loginAs('operator1'))
      .send({
        resourceType: 'RENTAL_VEHICLE',
        resourceId: 'RV-D-001',
        hubId: 'dorm',
        vehicleClass: 'MOTORCYCLE',
        category: 'VEHICLE_FAULT',
        notes: 'Mirror broken',
      });

    expect(res.status).toBe(201);
    expect(res.body.impacts).toEqual([
      {
        bookingType: 'VEHICLE_RESERVATION',
        bookingId: vr.id,
        userId: 'student1',
        outcome: 'REASSIGNED',
        newResourceId: 'RV-D-003',
      },
    ]);

    const updatedVr = await db.vehicleReservation.findUnique({ where: { id: vr.id } });
    expect(updatedVr?.status).toBe('CONFIRMED');
    expect(updatedVr?.rentalVehicleId).toBe('RV-D-003');
    expect(updatedVr?.expiresAt.toISOString()).toBe(expiresAt.toISOString());

    const oldVeh = await db.rentalVehicle.findUnique({ where: { id: 'RV-D-001' } });
    const newVeh = await db.rentalVehicle.findUnique({ where: { id: 'RV-D-003' } });
    expect(oldVeh?.status).toBe('FAULTY');
    expect(newVeh?.status).toBe('RESERVED');

    const notif = await db.notification.findFirst({
      where: { userId: 'student1', type: 'RESERVATION_REASSIGNED' },
    });
    expect(notif).not.toBeNull();
  });

  it('FR-39 FR-40 T-22 AC-4 cancels CONFIRMED vehicle reservation when no replacement exists, and ends ACTIVE rental with INCIDENT', async () => {
    // 1) Campus-a has only RV-A-001 -> CONFIRMED reservation must be CANCELLED
    await db.rentalVehicle.update({ where: { id: 'RV-A-001' }, data: { status: 'RESERVED' } });
    const vrConf = await db.vehicleReservation.create({
      data: {
        id: 'VR-A-CONF',
        userId: 'student1',
        rentalVehicleId: 'RV-A-001',
        hubId: 'campus-a',
        status: 'CONFIRMED',
        expiresAt: new Date(Date.now() + 15 * MIN_MS),
      },
    });

    const resConf = await request(app)
      .post('/api/ops/incidents')
      .set('Authorization', loginAs('operator1'))
      .send({
        resourceType: 'RENTAL_VEHICLE',
        resourceId: 'RV-A-001',
        hubId: 'campus-a',
        vehicleClass: 'MOTORCYCLE',
        category: 'BATTERY_FAULT',
        notes: 'No replacement',
      });
    expect(resConf.status).toBe(201);
    expect(resConf.body.impacts[0]).toMatchObject({
      bookingType: 'VEHICLE_RESERVATION',
      bookingId: vrConf.id,
      userId: 'student1',
      outcome: 'CANCELLED',
      newResourceId: null,
    });

    const dbConf = await db.vehicleReservation.findUnique({ where: { id: vrConf.id } });
    expect(dbConf?.status).toBe('CANCELLED');
    expect(dbConf?.endReason).toBe('INCIDENT');

    const cancelNotif = await db.notification.findFirst({
      where: { userId: 'student1', type: 'RESERVATION_CANCELLED' },
    });
    expect(cancelNotif).not.toBeNull();

    // 2) Campus-b: RV-B-001 has ACTIVE rental -> COMPLETED with endReason INCIDENT
    // Cancel student2's fixture VR-001 first (uq_vehicle_res_user allows 1 live reservation per user)
    await db.vehicleReservation.update({
      where: { id: 'VR-001' },
      data: { status: 'CANCELLED', endReason: 'CANCELLED' },
    });
    await db.rentalVehicle.update({
      where: { id: 'RV-B-001' },
      data: { status: 'IN_USE', batteryPct: 48, parkingSpaceId: null },
    });
    const vrAct = await db.vehicleReservation.create({
      data: {
        id: 'VR-B-ACT',
        userId: 'student2',
        rentalVehicleId: 'RV-B-001',
        hubId: 'campus-b',
        status: 'ACTIVE',
        expiresAt: new Date(Date.now() - 10 * MIN_MS),
        pickedUpAt: new Date(Date.now() - 20 * MIN_MS),
        startBatteryPct: 55,
      },
    });

    const resAct = await request(app)
      .post('/api/ops/incidents')
      .set('Authorization', loginAs('operator1'))
      .send({
        resourceType: 'RENTAL_VEHICLE',
        resourceId: 'RV-B-001',
        hubId: 'campus-b',
        vehicleClass: 'MOTORCYCLE',
        category: 'DAMAGE',
        notes: 'Mid-ride flat',
      });
    expect(resAct.status).toBe(201);
    expect(resAct.body.impacts[0]).toMatchObject({
      bookingType: 'VEHICLE_RESERVATION',
      bookingId: vrAct.id,
      userId: 'student2',
      outcome: 'ENDED',
      newResourceId: null,
    });

    const dbAct = await db.vehicleReservation.findUnique({ where: { id: vrAct.id } });
    expect(dbAct?.status).toBe('COMPLETED');
    expect(dbAct?.endReason).toBe('INCIDENT');
    expect(dbAct?.endBatteryPct).toBe(48);

    const endedNotif = await db.notification.findFirst({
      where: { userId: 'student2', type: 'RENTAL_ENDED_INCIDENT' },
    });
    expect(endedNotif).not.toBeNull();
  });

  it('FR-39 FR-40 FR-62 T-22 AC-4 AC-7 cancels QUEUED and ends CHARGING requests on a faulty vehicle (point freed, 0 notifications for null ownerId)', async () => {
    // Fixture: RV-M-004 has CR-M-001 (CHARGING on MET-CP-M-02, ownerId=null)
    // Fixture: RV-M-005 has CR-M-002 (QUEUED, ownerId='student1')
    const notifsBefore = await db.notification.count();

    const res1 = await request(app)
      .post('/api/ops/incidents')
      .set('Authorization', loginAs('operator1'))
      .send({
        resourceType: 'RENTAL_VEHICLE',
        resourceId: 'RV-M-004',
        hubId: 'metro',
        vehicleClass: 'MOTORCYCLE',
        category: 'BATTERY_FAULT',
        notes: 'Overheating while charging',
      });
    expect(res1.status).toBe(201);
    expect(res1.body.impacts).toEqual([
      {
        bookingType: 'CHARGING_REQUEST',
        bookingId: 'CR-M-001',
        userId: null,
        outcome: 'ENDED',
        newResourceId: null,
      },
    ]);

    const cr1 = await db.chargingRequest.findUnique({ where: { id: 'CR-M-001' } });
    expect(cr1?.status).toBe('COMPLETED');
    expect(cr1?.endReason).toBe('VEHICLE_FAULT');
    const cp2 = await db.chargingPoint.findUnique({ where: { id: 'MET-CP-M-02' } });
    expect(cp2?.status).toBe('AVAILABLE');
    // Fleet request (ownerId null) produces 0 notifications
    expect(await db.notification.count()).toBe(notifsBefore);

    // Now report RV-M-005 (has CR-M-002 QUEUED with ownerId='student1')
    const res2 = await request(app)
      .post('/api/ops/incidents')
      .set('Authorization', loginAs('operator1'))
      .send({
        resourceType: 'RENTAL_VEHICLE',
        resourceId: 'RV-M-005',
        hubId: 'metro',
        vehicleClass: 'MOTORCYCLE',
        category: 'VEHICLE_FAULT',
        notes: 'Faulty queued bike',
      });
    expect(res2.status).toBe(201);
    expect(res2.body.impacts).toEqual([
      {
        bookingType: 'CHARGING_REQUEST',
        bookingId: 'CR-M-002',
        userId: 'student1',
        outcome: 'CANCELLED',
        newResourceId: null,
      },
    ]);

    const cr2 = await db.chargingRequest.findUnique({ where: { id: 'CR-M-002' } });
    expect(cr2?.status).toBe('CANCELLED');
    const chgCancelNotif = await db.notification.findFirst({
      where: { userId: 'student1', type: 'CHARGING_CANCELLED' },
    });
    expect(chgCancelNotif).not.toBeNull();
  });

  // ---- AC-5: FR-39 / FR-40 parking space recovery ----

  it('FR-39 FR-40 T-22 AC-5 moves CONFIRMED/ACTIVE parking reservations to free PUBLIC space, ignores ended windows, and cancels/completes when none free', async () => {
    // At dorm: DOR-P-M-01 (FREE PUBLIC MOTO) and DOR-P-M-02 (FREE PUBLIC MOTO)
    // Create:
    // 1) future CONFIRMED on DOR-P-M-01 (windowStart = +30m, windowEnd = +2h) -> moved to DOR-P-M-02, DOR-P-M-02 stays FREE
    // 2) ended CONFIRMED on DOR-P-M-01 (windowEnd = -5m) -> NOT touched
    await db.parkingReservation.createMany({
      data: [
        {
          id: 'PR-D-FUT',
          userId: 'student1',
          parkingSpaceId: 'DOR-P-M-01',
          hubId: 'dorm',
          vehicleClass: 'MOTORCYCLE',
          windowStart: new Date(Date.now() + 30 * MIN_MS),
          windowEnd: new Date(Date.now() + 2 * HR_MS),
          status: 'CONFIRMED',
          expiresAt: new Date(Date.now() + 45 * MIN_MS),
        },
        {
          id: 'PR-D-PAST',
          userId: 'student2',
          parkingSpaceId: 'DOR-P-M-01',
          hubId: 'dorm',
          vehicleClass: 'MOTORCYCLE',
          windowStart: new Date(Date.now() - 2 * HR_MS),
          windowEnd: new Date(Date.now() - 5 * MIN_MS),
          status: 'CONFIRMED',
          expiresAt: new Date(Date.now() - 105 * MIN_MS),
        },
      ],
    });

    const resMove = await request(app)
      .post('/api/ops/incidents')
      .set('Authorization', loginAs('operator1'))
      .send({
        resourceType: 'PARKING_SPACE',
        resourceId: 'DOR-P-M-01',
        hubId: 'dorm',
        vehicleClass: 'MOTORCYCLE',
        category: 'OBSTRUCTION',
        notes: 'Cones blocking space',
      });
    expect(resMove.status).toBe(201);
    expect(resMove.body.impacts).toEqual([
      {
        bookingType: 'PARKING_RESERVATION',
        bookingId: 'PR-D-FUT',
        userId: 'student1',
        outcome: 'REASSIGNED',
        newResourceId: 'DOR-P-M-02',
      },
    ]);

    const movedPr = await db.parkingReservation.findUnique({ where: { id: 'PR-D-FUT' } });
    expect(movedPr?.parkingSpaceId).toBe('DOR-P-M-02');
    const pastPr = await db.parkingReservation.findUnique({ where: { id: 'PR-D-PAST' } });
    expect(pastPr?.parkingSpaceId).toBe('DOR-P-M-01');
    expect(pastPr?.status).toBe('CONFIRMED');
    const newSpace = await db.parkingSpace.findUnique({ where: { id: 'DOR-P-M-02' } });
    expect(newSpace?.status).toBe('FREE');

    // Now DOR-P-M-02 is the ONLY PUBLIC MOTO space at dorm. Add an ACTIVE reservation on it and report DOR-P-M-02:
    // Both PR-D-FUT (CONFIRMED) -> CANCELLED, and PR-D-ACT (ACTIVE) -> COMPLETED.
    await db.parkingSpace.update({ where: { id: 'DOR-P-M-02' }, data: { status: 'OCCUPIED' } });
    await db.parkingReservation.create({
      data: {
        id: 'PR-D-ACT',
        userId: 'student2',
        parkingSpaceId: 'DOR-P-M-02',
        hubId: 'dorm',
        vehicleClass: 'MOTORCYCLE',
        windowStart: new Date(Date.now() - 15 * MIN_MS),
        windowEnd: new Date(Date.now() + 15 * MIN_MS),
        status: 'ACTIVE',
        claimedAt: new Date(Date.now() - 10 * MIN_MS),
        expiresAt: new Date(Date.now()),
      },
    });

    const resNone = await request(app)
      .post('/api/ops/incidents')
      .set('Authorization', loginAs('operator1'))
      .send({
        resourceType: 'PARKING_SPACE',
        resourceId: 'DOR-P-M-02',
        hubId: 'dorm',
        vehicleClass: 'MOTORCYCLE',
        category: 'DAMAGE',
        notes: 'Oil spill',
      });
    expect(resNone.status).toBe(201);
    expect(resNone.body.impacts).toHaveLength(2);

    const futAfter = await db.parkingReservation.findUnique({ where: { id: 'PR-D-FUT' } });
    const actAfter = await db.parkingReservation.findUnique({ where: { id: 'PR-D-ACT' } });
    expect(futAfter?.status).toBe('CANCELLED');
    expect(actAfter?.status).toBe('COMPLETED');
  });

  // ---- AC-6: FR-39 / FR-40 charging point recovery ----

  it('FR-39 FR-40 UC-22 A1 T-22 AC-6 moves SCHEDULED to free point, or cancels, and ends CHARGING POINT_FAILURE + requeues with MANUAL_ADJUST_STEP', async () => {
    // At dorm: DOR-CP-M-01 (AVAILABLE MOTO). Add DOR-CP-M-02 (AVAILABLE MOTO).
    await db.chargingPoint.create({
      data: { id: 'DOR-CP-M-02', hubId: 'dorm', vehicleClass: 'MOTORCYCLE', status: 'AVAILABLE' },
    });
    const evSched = await db.privateEv.create({
      data: {
        id: 'PEV-SCHED',
        ownerId: 'student1',
        type: 'E_MOTORCYCLE',
        vehicleClass: 'MOTORCYCLE',
        label: 'Sched Bike',
        batteryCapacityKwh: 4,
        batteryPct: 40,
      },
    });
    const evChg = await db.privateEv.create({
      data: {
        id: 'PEV-CHG',
        ownerId: 'student2',
        type: 'E_MOTORCYCLE',
        vehicleClass: 'MOTORCYCLE',
        label: 'Chg Bike',
        batteryCapacityKwh: 4,
        batteryPct: 30,
      },
    });

    await db.chargingPoint.update({ where: { id: 'DOR-CP-M-01' }, data: { status: 'CHARGING' } });
    const crChg = await db.chargingRequest.create({
      data: {
        id: 'CR-D-CHG',
        requestedById: 'student2',
        ownerId: 'student2',
        vehicleKind: 'PRIVATE',
        privateEvId: evChg.id,
        vehicleClass: 'MOTORCYCLE',
        hubId: 'dorm',
        mode: 'QUEUE',
        status: 'CHARGING',
        targetPct: 90,
        startPct: 30,
        currentPct: 45,
        chargingPointId: 'DOR-CP-M-01',
        slotStart: new Date(Date.now() - 15 * MIN_MS),
        slotEnd: new Date(Date.now() + 45 * MIN_MS),
        startedAt: new Date(Date.now() - 15 * MIN_MS),
      },
    });
    const crSched = await db.chargingRequest.create({
      data: {
        id: 'CR-D-SCHED',
        requestedById: 'student1',
        ownerId: 'student1',
        vehicleKind: 'PRIVATE',
        privateEvId: evSched.id,
        vehicleClass: 'MOTORCYCLE',
        hubId: 'dorm',
        mode: 'ADVANCE',
        status: 'SCHEDULED',
        targetPct: 80,
        startPct: 40,
        currentPct: 40,
        chargingPointId: 'DOR-CP-M-01',
        slotStart: new Date(Date.now() + 2 * HR_MS),
        slotEnd: new Date(Date.now() + 3 * HR_MS),
      },
    });

    const res = await request(app)
      .post('/api/ops/incidents')
      .set('Authorization', loginAs('operator1'))
      .send({
        resourceType: 'CHARGING_POINT',
        resourceId: 'DOR-CP-M-01',
        hubId: 'dorm',
        vehicleClass: 'MOTORCYCLE',
        category: 'CHARGER_FAULT',
        notes: 'Relay tripped',
      });

    expect(res.status).toBe(201);
    expect(res.body.impacts).toHaveLength(2);

    const schedImpact = res.body.impacts.find((i: { bookingId: string }) => i.bookingId === crSched.id);
    expect(schedImpact).toMatchObject({
      bookingType: 'CHARGING_REQUEST',
      userId: 'student1',
      outcome: 'REASSIGNED',
      newResourceId: 'DOR-CP-M-02',
    });

    const chgImpact = res.body.impacts.find((i: { bookingId: string }) => i.bookingId === crChg.id);
    expect(chgImpact).toMatchObject({
      bookingType: 'CHARGING_REQUEST',
      userId: 'student2',
      outcome: 'ENDED',
      newResourceId: null,
    });

    const dbSched = await db.chargingRequest.findUnique({ where: { id: crSched.id } });
    expect(dbSched?.chargingPointId).toBe('DOR-CP-M-02');
    expect(dbSched?.status).toBe('SCHEDULED');

    const dbChg = await db.chargingRequest.findUnique({ where: { id: crChg.id } });
    expect(dbChg?.status).toBe('COMPLETED');
    expect(dbChg?.endReason).toBe('POINT_FAILURE');
    expect(dbChg?.finalPct).toBe(45);

    const requeued = await db.chargingRequest.findFirst({
      where: { privateEvId: evChg.id, status: 'QUEUED' },
    });
    expect(requeued).not.toBeNull();
    expect(requeued?.manualAdjust).toBe(config.MANUAL_ADJUST_STEP);
    expect(requeued?.targetPct).toBe(90);

    const schedNotif = await db.notification.findFirst({
      where: { userId: 'student1', type: 'RESERVATION_REASSIGNED' },
    });
    expect(schedNotif).not.toBeNull();

    const requeueNotif = await db.notification.findFirst({
      where: { userId: 'student2', type: 'CHARGING_REQUEUED' },
    });
    expect(requeueNotif).not.toBeNull();

    // Verify DB incident_impact rows match response impacts
    const dbImpacts = await db.incidentImpact.findMany({
      where: { incidentId: res.body.incident.id },
    });
    expect(dbImpacts).toHaveLength(res.body.impacts.length);
  });

  // ---- AC-8: D-06 atomicity / rollback ----

  it('D-06 T-22 AC-8 rolls back incident, withdrawal, and impacts if a failure occurs late in recovery', async () => {
    vi.spyOn(chargingRequestsService, 'recoverChargingForVehicle').mockRejectedValueOnce(
      new Error('Simulated recovery failure'),
    );

    const incidentsBefore = await db.incident.count();
    const impactsBefore = await db.incidentImpact.count();

    const res = await request(app)
      .post('/api/ops/incidents')
      .set('Authorization', loginAs('operator1'))
      .send({
        resourceType: 'RENTAL_VEHICLE',
        resourceId: 'RV-D-001',
        hubId: 'dorm',
        vehicleClass: 'MOTORCYCLE',
        category: 'VEHICLE_FAULT',
        notes: 'Should roll back',
      });

    expect(res.status).toBe(500);
    expect(await db.incident.count()).toBe(incidentsBefore);
    expect(await db.incidentImpact.count()).toBe(impactsBefore);

    const veh = await db.rentalVehicle.findUnique({ where: { id: 'RV-D-001' } });
    expect(veh?.status).toBe('AVAILABLE');
  });

  // ---- AC-9: FR-13 student report-fault ----

  it('FR-13 T-22 AC-9 student with CONFIRMED or ACTIVE reservation reports fault -> 201 and recovers; otherwise 404; bad notes -> 400', async () => {
    // Bad notes (> 500 chars) -> 400
    await db.rentalVehicle.update({ where: { id: 'RV-D-001' }, data: { status: 'RESERVED' } });
    await db.vehicleReservation.create({
      data: {
        id: 'VR-STU-1',
        userId: 'student1',
        rentalVehicleId: 'RV-D-001',
        hubId: 'dorm',
        status: 'CONFIRMED',
        expiresAt: new Date(Date.now() + 15 * MIN_MS),
      },
    });

    const badNotes = await request(app)
      .post('/api/vehicles/RV-D-001/report-fault')
      .set('Authorization', loginAs('student1'))
      .send({ category: 'VEHICLE_FAULT', notes: 'a'.repeat(501) });
    expect(badNotes.status).toBe(400);
    expect(badNotes.body.error.details?.field).toBe('notes');

    // Another student without reservation -> 404
    const otherStudent = await request(app)
      .post('/api/vehicles/RV-D-001/report-fault')
      .set('Authorization', loginAs('student2'))
      .send({ category: 'VEHICLE_FAULT', notes: 'Not my bike' });
    expect(otherStudent.status).toBe(404);

    // Unknown vehicle -> 404
    const unknownVeh = await request(app)
      .post('/api/vehicles/RV-NONE/report-fault')
      .set('Authorization', loginAs('student1'))
      .send({ category: 'VEHICLE_FAULT', notes: 'Does not exist' });
    expect(unknownVeh.status).toBe(404);

    // Own CONFIRMED reservation -> 201 { incidentId, linkedToExisting: false } + reassignment to RV-D-002
    const okRes = await request(app)
      .post('/api/vehicles/RV-D-001/report-fault')
      .set('Authorization', loginAs('student1'))
      .send({ category: 'VEHICLE_FAULT', notes: 'Handlebar loose' });
    expect(okRes.status).toBe(201);
    expect(typeof okRes.body.incidentId).toBe('string');
    expect(okRes.body.linkedToExisting).toBe(false);

    const dbInc = await db.incident.findUnique({ where: { id: okRes.body.incidentId } });
    expect(dbInc?.source).toBe('STUDENT');
    expect(dbInc?.reportedById).toBe('student1');

    const updatedVr = await db.vehicleReservation.findUnique({ where: { id: 'VR-STU-1' } });
    expect(updatedVr?.rentalVehicleId).toBe('RV-D-002');
  });

  // ---- AC-10: FR-36 telemetry fault ----

  it('FR-36 T-22 AC-10 telemetry packet with faultCode creates TELEMETRY incident and links repeat fault; ingestion still 202 if reportIncident throws', async () => {
    const t1 = new Date().toISOString();
    const res1 = await request(app)
      .post('/api/telemetry')
      .set('X-Telemetry-Key', config.TELEMETRY_KEY)
      .send({
        hubId: 'dorm',
        timestamp: t1,
        source: 'SIMULATOR',
        chargingPoints: [{ id: 'DOR-CP-M-01', faultCode: 'RELAY_TRIP' }],
      });
    expect(res1.status).toBe(202);

    const incidents = await db.incident.findMany({
      where: { resourceType: 'CHARGING_POINT', resourceId: 'DOR-CP-M-01' },
    });
    expect(incidents).toHaveLength(1);
    expect(incidents[0]?.source).toBe('TELEMETRY');
    expect(incidents[0]?.category).toBe('CHARGER_FAULT');

    // Repeat fault with newer timestamp -> linked
    const t2 = new Date(Date.now() + 5000).toISOString();
    const res2 = await request(app)
      .post('/api/telemetry')
      .set('X-Telemetry-Key', config.TELEMETRY_KEY)
      .send({
        hubId: 'dorm',
        timestamp: t2,
        source: 'SIMULATOR',
        chargingPoints: [{ id: 'DOR-CP-M-01', faultCode: 'ELECTRICAL' }],
      });
    expect(res2.status).toBe(202);

    const incidentsAfter = await db.incident.findMany({
      where: { resourceType: 'CHARGING_POINT', resourceId: 'DOR-CP-M-01' },
    });
    expect(incidentsAfter).toHaveLength(1);
    const reports = await db.incidentReport.findMany({
      where: { incidentId: incidents[0]!.id },
    });
    expect(reports).toHaveLength(2);

    // If reportIncident throws during telemetry afterCommit, ingestion still returns 202
    vi.spyOn(incidentsService, 'reportIncident').mockRejectedValueOnce(
      new Error('Simulated incident hook error'),
    );
    const t3 = new Date(Date.now() + 10_000).toISOString();
    const res3 = await request(app)
      .post('/api/telemetry')
      .set('X-Telemetry-Key', config.TELEMETRY_KEY)
      .send({
        hubId: 'dorm',
        timestamp: t3,
        source: 'SIMULATOR',
        vehicles: [{ id: 'RV-D-001', batteryPct: 88, faultCode: 'BRAKE_ERROR' }],
      });
    expect(res3.status).toBe(202);
  });

  // ---- AC-11: Role checks & events ----

  it('T-22 AC-11 enforces OPERATOR role on /ops/incidents (403 + SECURITY_DENIED) and STUDENT role on report-fault (403), and emits events on commit', async () => {
    const withdrawn: string[] = [];
    events.on('RESOURCE_WITHDRAWN', ({ hubId }) => {
      withdrawn.push(hubId);
    });

    const stuOps = await request(app)
      .post('/api/ops/incidents')
      .set('Authorization', loginAs('student1'))
      .send({
        resourceType: 'RENTAL_VEHICLE',
        resourceId: 'RV-D-001',
        hubId: 'dorm',
        vehicleClass: 'MOTORCYCLE',
        category: 'VEHICLE_FAULT',
        notes: 'Unauthorized',
      });
    expect(stuOps.status).toBe(403);

    const secAudit = await db.auditLog.findFirst({
      where: { action: 'SECURITY_DENIED', actorId: 'student1' },
    });
    expect(secAudit).not.toBeNull();

    const opFault = await request(app)
      .post('/api/vehicles/RV-D-001/report-fault')
      .set('Authorization', loginAs('operator1'))
      .send({ category: 'VEHICLE_FAULT', notes: 'Operator on student route' });
    expect(opFault.status).toBe(403);

    const noAuthOps = await request(app).post('/api/ops/incidents').send({});
    expect(noAuthOps.status).toBe(401);

    const okOp = await request(app)
      .post('/api/ops/incidents')
      .set('Authorization', loginAs('operator1'))
      .send({
        resourceType: 'RENTAL_VEHICLE',
        resourceId: 'RV-D-001',
        hubId: 'dorm',
        vehicleClass: 'MOTORCYCLE',
        category: 'VEHICLE_FAULT',
        notes: 'Event check',
      });
    expect(okOp.status).toBe(201);
    expect(withdrawn).toEqual(['dorm']);
  });
});
