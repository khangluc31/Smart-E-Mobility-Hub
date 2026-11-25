// Incident lifecycle, list, and detail tests (T-23: FR-41, FR-42, FR-63, BR-05, BR-12, UC-22, UC-23).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { config } from '../src/core/config';
import { db } from '../src/core/db';
import { events } from '../src/core/events';
import {
  OPERATOR_NOTES_MAX,
  reportIncident,
} from '../src/modules/incidents/incidents.service';
import type { Incident } from '../src/types/incidents';
import { createTestApp, loginAs, resetDb } from './helpers';

const app = createTestApp();
const op = () => loginAs('operator1');
const stu = () => loginAs('student1');

async function createOperatorIncident(body: {
  resourceType: 'RENTAL_VEHICLE' | 'PARKING_SPACE' | 'CHARGING_POINT';
  resourceId: string;
  hubId: string;
  vehicleClass: 'MOTORCYCLE' | 'CAR';
  category:
    | 'VEHICLE_FAULT'
    | 'BATTERY_FAULT'
    | 'CHARGER_FAULT'
    | 'ELECTRICAL'
    | 'EMERGENCY_DISCONNECT'
    | 'DAMAGE'
    | 'OBSTRUCTION'
    | 'OTHER';
  notes: string;
}): Promise<{ incident: Incident; linkedToExisting: boolean; impacts: unknown[] }> {
  const res = await request(app)
    .post('/api/ops/incidents')
    .set('Authorization', op())
    .send(body);
  expect(res.status).toBe(201);
  return res.body as { incident: Incident; linkedToExisting: boolean; impacts: unknown[] };
}

describe('T-23 Incident lifecycle, list, and detail', () => {
  beforeEach(async () => {
    await resetDb();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ---------------------------------------------------------------------------
  // AC-1 & AC-4: REPORTED -> IN_MAINTENANCE + audit + resource stays withdrawn
  // ---------------------------------------------------------------------------
  it('FR-41 T-23 AC-1 AC-4 start-maintenance moves REPORTED to IN_MAINTENANCE, sets inMaintenanceAt, keeps resource withdrawn, and audits with reason', async () => {
    const { incident } = await createOperatorIncident({
      resourceType: 'RENTAL_VEHICLE',
      resourceId: 'RV-D-001',
      hubId: 'dorm',
      vehicleClass: 'MOTORCYCLE',
      category: 'VEHICLE_FAULT',
      notes: 'Brake lever loose',
    });

    const res = await request(app)
      .post(`/api/ops/incidents/${incident.id}/start-maintenance`)
      .set('Authorization', op())
      .send({ notes: '  Moved to service bay  ' });

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(incident.id);
    expect(res.body.status).toBe('IN_MAINTENANCE');
    expect(typeof res.body.inMaintenanceAt).toBe('string');
    expect(res.body.resolvedAt).toBeNull();

    // Resource stays withdrawn until resolved
    const vehicle = await db.rentalVehicle.findUniqueOrThrow({ where: { id: 'RV-D-001' } });
    expect(vehicle.status).toBe('FAULTY');

    // Audit row written with operator id, entityIds, and trimmed reason
    const audits = await db.auditLog.findMany({
      where: { action: 'INCIDENT_MAINTENANCE_STARTED' },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]?.actorId).toBe('operator1');
    expect(audits[0]?.actorRole).toBe('OPERATOR');
    expect(audits[0]?.entityType).toBe('incident');
    expect(audits[0]?.entityIds).toEqual([incident.id, 'RV-D-001']);
    expect(audits[0]?.reason).toBe('Moved to service bay');

    // Optional notes omitted (empty body) also works on another incident
    const { incident: inc2 } = await createOperatorIncident({
      resourceType: 'CHARGING_POINT',
      resourceId: 'DOR-CP-M-01',
      hubId: 'dorm',
      vehicleClass: 'MOTORCYCLE',
      category: 'CHARGER_FAULT',
      notes: 'Connector stuck',
    });
    const res2 = await request(app)
      .post(`/api/ops/incidents/${inc2.id}/start-maintenance`)
      .set('Authorization', op());
    expect(res2.status).toBe(200);
    expect(res2.body.status).toBe('IN_MAINTENANCE');

    // Over-length notes on start-maintenance -> 400 details.field: 'notes'
    const { incident: inc3 } = await createOperatorIncident({
      resourceType: 'PARKING_SPACE',
      resourceId: 'DOR-P-M-01',
      hubId: 'dorm',
      vehicleClass: 'MOTORCYCLE',
      category: 'OBSTRUCTION',
      notes: 'Debris',
    });
    const tooLong = await request(app)
      .post(`/api/ops/incidents/${inc3.id}/start-maintenance`)
      .set('Authorization', op())
      .send({ notes: 'x'.repeat(OPERATOR_NOTES_MAX + 1) });
    expect(tooLong.status).toBe(400);
    expect(tooLong.body.error.code).toBe('VALIDATION_ERROR');
    expect(tooLong.body.error.details?.field).toBe('notes');
  });

  // ---------------------------------------------------------------------------
  // AC-1: Invalid transitions (409) & unknown id (404) + empty notes on unknown id (400)
  // ---------------------------------------------------------------------------
  it('FR-41 T-23 AC-1 rejects invalid lifecycle transitions with 409 and unknown id with 404 (notes checked before DB read)', async () => {
    const { incident } = await createOperatorIncident({
      resourceType: 'CHARGING_POINT',
      resourceId: 'DOR-CP-M-01',
      hubId: 'dorm',
      vehicleClass: 'MOTORCYCLE',
      category: 'CHARGER_FAULT',
      notes: 'Display blank',
    });

    // Resolve while REPORTED -> 409 INVALID_STATE_TRANSITION
    const resolveReported = await request(app)
      .post(`/api/ops/incidents/${incident.id}/resolve`)
      .set('Authorization', op())
      .send({ resolutionNotes: 'Trying to skip maintenance' });
    expect(resolveReported.status).toBe(409);
    expect(resolveReported.body.error.code).toBe('INVALID_STATE_TRANSITION');

    // Start maintenance -> 200
    const start1 = await request(app)
      .post(`/api/ops/incidents/${incident.id}/start-maintenance`)
      .set('Authorization', op())
      .send({});
    expect(start1.status).toBe(200);

    // Start maintenance again -> 409 INVALID_STATE_TRANSITION
    const start2 = await request(app)
      .post(`/api/ops/incidents/${incident.id}/start-maintenance`)
      .set('Authorization', op())
      .send({});
    expect(start2.status).toBe(409);
    expect(start2.body.error.code).toBe('INVALID_STATE_TRANSITION');

    // Resolve -> 200
    const res1 = await request(app)
      .post(`/api/ops/incidents/${incident.id}/resolve`)
      .set('Authorization', op())
      .send({ resolutionNotes: 'Replaced display cable' });
    expect(res1.status).toBe(200);
    expect(res1.body.status).toBe('RESOLVED');

    // Resolve twice -> 409 INVALID_STATE_TRANSITION
    const res2 = await request(app)
      .post(`/api/ops/incidents/${incident.id}/resolve`)
      .set('Authorization', op())
      .send({ resolutionNotes: 'Second resolve attempt' });
    expect(res2.status).toBe(409);
    expect(res2.body.error.code).toBe('INVALID_STATE_TRANSITION');

    // Start maintenance on RESOLVED -> 409
    const startResolved = await request(app)
      .post(`/api/ops/incidents/${incident.id}/start-maintenance`)
      .set('Authorization', op())
      .send({});
    expect(startResolved.status).toBe(409);
    expect(startResolved.body.error.code).toBe('INVALID_STATE_TRANSITION');

    // Unknown id separately on start-maintenance, resolve (valid notes), and GET /:id -> 404
    const unknownStart = await request(app)
      .post('/api/ops/incidents/non-existent-id/start-maintenance')
      .set('Authorization', op())
      .send({});
    expect(unknownStart.status).toBe(404);
    expect(unknownStart.body.error.code).toBe('NOT_FOUND');

    const unknownResolve = await request(app)
      .post('/api/ops/incidents/non-existent-id/resolve')
      .set('Authorization', op())
      .send({ resolutionNotes: 'Valid notes' });
    expect(unknownResolve.status).toBe(404);
    expect(unknownResolve.body.error.code).toBe('NOT_FOUND');

    const unknownDetail = await request(app)
      .get('/api/ops/incidents/non-existent-id')
      .set('Authorization', op());
    expect(unknownDetail.status).toBe(404);
    expect(unknownDetail.body.error.code).toBe('NOT_FOUND');

    // Unknown id + empty notes on resolve -> 400 resolutionNotes (checked before any DB read)
    const unknownEmptyNotes = await request(app)
      .post('/api/ops/incidents/non-existent-id/resolve')
      .set('Authorization', op())
      .send({ resolutionNotes: '   ' });
    expect(unknownEmptyNotes.status).toBe(400);
    expect(unknownEmptyNotes.body.error.code).toBe('VALIDATION_ERROR');
    expect(unknownEmptyNotes.body.error.details?.field).toBe('resolutionNotes');
  });

  // ---------------------------------------------------------------------------
  // AC-2: Resolve notes validation boundaries, no state change, no audit row
  // ---------------------------------------------------------------------------
  it('FR-41 T-23 AC-2 resolve rejects missing, empty, whitespace, and >OPERATOR_NOTES_MAX notes with 400 and no state change or audit; accepts exact OPERATOR_NOTES_MAX', async () => {
    const { incident } = await createOperatorIncident({
      resourceType: 'CHARGING_POINT',
      resourceId: 'DOR-CP-M-01',
      hubId: 'dorm',
      vehicleClass: 'MOTORCYCLE',
      category: 'ELECTRICAL',
      notes: 'Tripped breaker',
    });

    await request(app)
      .post(`/api/ops/incidents/${incident.id}/start-maintenance`)
      .set('Authorization', op())
      .send({});

    const badPayloads = [
      {},
      { resolutionNotes: '' },
      { resolutionNotes: '    \t\n  ' },
      { resolutionNotes: 'a'.repeat(OPERATOR_NOTES_MAX + 1) },
    ];

    for (const payload of badPayloads) {
      const res = await request(app)
        .post(`/api/ops/incidents/${incident.id}/resolve`)
        .set('Authorization', op())
        .send(payload);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.details?.field).toBe('resolutionNotes');
    }

    // Incident still IN_MAINTENANCE, resource still FAULTY, 0 INCIDENT_RESOLVED audit rows
    const incAfterBad = await db.incident.findUniqueOrThrow({ where: { id: incident.id } });
    expect(incAfterBad.status).toBe('IN_MAINTENANCE');
    expect(incAfterBad.resolvedAt).toBeNull();
    const pointAfterBad = await db.chargingPoint.findUniqueOrThrow({
      where: { id: 'DOR-CP-M-01' },
    });
    expect(pointAfterBad.status).toBe('FAULTY');
    const resolvedAudits = await db.auditLog.count({
      where: { action: 'INCIDENT_RESOLVED' },
    });
    expect(resolvedAudits).toBe(0);

    // Exact OPERATOR_NOTES_MAX boundary -> 200 RESOLVED
    const maxNotes = 'r'.repeat(OPERATOR_NOTES_MAX);
    const okRes = await request(app)
      .post(`/api/ops/incidents/${incident.id}/resolve`)
      .set('Authorization', op())
      .send({ resolutionNotes: maxNotes });
    expect(okRes.status).toBe(200);
    expect(okRes.body.status).toBe('RESOLVED');
    expect(okRes.body.resolutionNotes).toBe(maxNotes);
  });

  // ---------------------------------------------------------------------------
  // AC-3 & AC-4: Vehicle return boundary (MIN vs MIN - 1) + audit
  // ---------------------------------------------------------------------------
  it('FR-41 T-23 AC-3 AC-4 resolve returns vehicle to AVAILABLE at MIN_RENTAL_BATTERY_PCT and LOW_BATTERY at MIN_RENTAL_BATTERY_PCT - 1 and writes INCIDENT_RESOLVED audit', async () => {
    // Boundary 1: battery === MIN_RENTAL_BATTERY_PCT -> AVAILABLE
    await db.rentalVehicle.update({
      where: { id: 'RV-D-001' },
      data: { batteryPct: config.MIN_RENTAL_BATTERY_PCT },
    });
    const { incident: incAvail } = await createOperatorIncident({
      resourceType: 'RENTAL_VEHICLE',
      resourceId: 'RV-D-001',
      hubId: 'dorm',
      vehicleClass: 'MOTORCYCLE',
      category: 'VEHICLE_FAULT',
      notes: 'Flat tire',
    });
    await request(app)
      .post(`/api/ops/incidents/${incAvail.id}/start-maintenance`)
      .set('Authorization', op())
      .send({});
    const resAvail = await request(app)
      .post(`/api/ops/incidents/${incAvail.id}/resolve`)
      .set('Authorization', op())
      .send({ resolutionNotes: 'Replaced tire' });
    expect(resAvail.status).toBe(200);
    expect(resAvail.body.status).toBe('RESOLVED');
    expect(typeof resAvail.body.resolvedAt).toBe('string');

    const vAvail = await db.rentalVehicle.findUniqueOrThrow({ where: { id: 'RV-D-001' } });
    expect(vAvail.status).toBe('AVAILABLE');

    // Boundary 2: battery === MIN_RENTAL_BATTERY_PCT - 1 -> LOW_BATTERY
    await db.rentalVehicle.update({
      where: { id: 'RV-D-002' },
      data: { batteryPct: config.MIN_RENTAL_BATTERY_PCT - 1 },
    });
    const { incident: incLow } = await createOperatorIncident({
      resourceType: 'RENTAL_VEHICLE',
      resourceId: 'RV-D-002',
      hubId: 'dorm',
      vehicleClass: 'MOTORCYCLE',
      category: 'BATTERY_FAULT',
      notes: 'Battery sensor reset needed',
    });
    await request(app)
      .post(`/api/ops/incidents/${incLow.id}/start-maintenance`)
      .set('Authorization', op())
      .send({});
    const resLow = await request(app)
      .post(`/api/ops/incidents/${incLow.id}/resolve`)
      .set('Authorization', op())
      .send({ resolutionNotes: 'Reset BMS' });
    expect(resLow.status).toBe(200);

    const vLow = await db.rentalVehicle.findUniqueOrThrow({ where: { id: 'RV-D-002' } });
    expect(vLow.status).toBe('LOW_BATTERY');

    const audits = await db.auditLog.findMany({
      where: { action: 'INCIDENT_RESOLVED' },
      orderBy: { id: 'asc' },
    });
    expect(audits).toHaveLength(2);
    expect(audits[0]?.actorId).toBe('operator1');
    expect(audits[0]?.entityIds).toEqual([incAvail.id, 'RV-D-001']);
    expect(audits[0]?.reason).toBe('Replaced tire');
    expect(audits[0]?.details).toEqual({ resourceStatus: 'AVAILABLE' });
    expect(audits[1]?.entityIds).toEqual([incLow.id, 'RV-D-002']);
    expect(audits[1]?.reason).toBe('Reset BMS');
    expect(audits[1]?.details).toEqual({ resourceStatus: 'LOW_BATTERY' });
  });

  // ---------------------------------------------------------------------------
  // AC-3: Parking space return (FREE vs OCCUPIED when linked rental vehicle)
  // ---------------------------------------------------------------------------
  it('FR-41 T-23 AC-3 resolve returns unlinked parking space to FREE and space with linked rental vehicle to OCCUPIED', async () => {
    // 1) Unlinked PUBLIC space DOR-P-M-01 -> UNAVAILABLE -> FREE
    const { incident: incFree } = await createOperatorIncident({
      resourceType: 'PARKING_SPACE',
      resourceId: 'DOR-P-M-01',
      hubId: 'dorm',
      vehicleClass: 'MOTORCYCLE',
      category: 'OBSTRUCTION',
      notes: 'Fallen sign',
    });
    await request(app)
      .post(`/api/ops/incidents/${incFree.id}/start-maintenance`)
      .set('Authorization', op())
      .send({});
    const resFree = await request(app)
      .post(`/api/ops/incidents/${incFree.id}/resolve`)
      .set('Authorization', op())
      .send({ resolutionNotes: 'Cleared sign' });
    expect(resFree.status).toBe(200);
    expect(
      (await db.parkingSpace.findUniqueOrThrow({ where: { id: 'DOR-P-M-01' } })).status,
    ).toBe('FREE');

    // 2) FLEET space DOR-F-M-01 occupied by RV-D-001 -> UNAVAILABLE -> OCCUPIED (still linked)
    const { incident: incOcc } = await createOperatorIncident({
      resourceType: 'PARKING_SPACE',
      resourceId: 'DOR-F-M-01',
      hubId: 'dorm',
      vehicleClass: 'MOTORCYCLE',
      category: 'DAMAGE',
      notes: 'Loose bollard',
    });
    expect(
      (await db.parkingSpace.findUniqueOrThrow({ where: { id: 'DOR-F-M-01' } })).status,
    ).toBe('UNAVAILABLE');
    await request(app)
      .post(`/api/ops/incidents/${incOcc.id}/start-maintenance`)
      .set('Authorization', op())
      .send({});
    const resOcc = await request(app)
      .post(`/api/ops/incidents/${incOcc.id}/resolve`)
      .set('Authorization', op())
      .send({ resolutionNotes: 'Bolted down' });
    expect(resOcc.status).toBe(200);
    expect(
      (await db.parkingSpace.findUniqueOrThrow({ where: { id: 'DOR-F-M-01' } })).status,
    ).toBe('OCCUPIED');
  });

  // ---------------------------------------------------------------------------
  // AC-3: Charging point return -> AVAILABLE + reappears in /charging/availability
  // ---------------------------------------------------------------------------
  it('FR-41 T-23 AC-3 resolve returns charging point to AVAILABLE and makes it available again in GET /charging/availability', async () => {
    // dorm has 1 CAR charging point: DOR-CP-C-01; PEV-01 (student1, CAR, battery 60)
    const slotStart = new Date(Date.now() + 2 * 3_600_000).toISOString();

    const { incident } = await createOperatorIncident({
      resourceType: 'CHARGING_POINT',
      resourceId: 'DOR-CP-C-01',
      hubId: 'dorm',
      vehicleClass: 'CAR',
      category: 'CHARGER_FAULT',
      notes: 'Connector fault',
    });

    const availWhileFaulty = await request(app)
      .get('/api/charging/availability')
      .set('Authorization', stu())
      .query({ hubId: 'dorm', privateEvId: 'PEV-01', slotStart, targetPct: 80 });
    expect(availWhileFaulty.status).toBe(200);
    expect(availWhileFaulty.body.available).toBe(false);

    await request(app)
      .post(`/api/ops/incidents/${incident.id}/start-maintenance`)
      .set('Authorization', op())
      .send({});
    const resolved = await request(app)
      .post(`/api/ops/incidents/${incident.id}/resolve`)
      .set('Authorization', op())
      .send({ resolutionNotes: 'Replaced connector' });
    expect(resolved.status).toBe(200);

    expect(
      (await db.chargingPoint.findUniqueOrThrow({ where: { id: 'DOR-CP-C-01' } })).status,
    ).toBe('AVAILABLE');

    const availAfterResolve = await request(app)
      .get('/api/charging/availability')
      .set('Authorization', stu())
      .query({ hubId: 'dorm', privateEvId: 'PEV-01', slotStart, targetPct: 80 });
    expect(availAfterResolve.status).toBe(200);
    expect(availAfterResolve.body.available).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // AC-5: Concurrent resolve -> one 200, one 409, one INCIDENT_RESOLVED audit row
  // ---------------------------------------------------------------------------
  it('FR-41 T-23 AC-5 concurrent resolves (Promise.all) produce one 200 and one 409 with one INCIDENT_RESOLVED audit row', async () => {
    const { incident } = await createOperatorIncident({
      resourceType: 'CHARGING_POINT',
      resourceId: 'DOR-CP-M-01',
      hubId: 'dorm',
      vehicleClass: 'MOTORCYCLE',
      category: 'CHARGER_FAULT',
      notes: 'Relay stuck',
    });
    await request(app)
      .post(`/api/ops/incidents/${incident.id}/start-maintenance`)
      .set('Authorization', op())
      .send({});

    const [a, b] = await Promise.all([
      request(app)
        .post(`/api/ops/incidents/${incident.id}/resolve`)
        .set('Authorization', op())
        .send({ resolutionNotes: 'Fix A' }),
      request(app)
        .post(`/api/ops/incidents/${incident.id}/resolve`)
        .set('Authorization', op())
        .send({ resolutionNotes: 'Fix B' }),
    ]);

    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const loser = a.status === 409 ? a : b;
    expect(loser.body.error.code).toBe('INVALID_STATE_TRANSITION');

    const audits = await db.auditLog.findMany({ where: { action: 'INCIDENT_RESOLVED' } });
    expect(audits).toHaveLength(1);
    expect(
      (await db.chargingPoint.findUniqueOrThrow({ where: { id: 'DOR-CP-M-01' } })).status,
    ).toBe('AVAILABLE');
  });

  // ---------------------------------------------------------------------------
  // AC-1: After resolve, new report on same resource creates a NEW incident
  // ---------------------------------------------------------------------------
  it('FR-41 T-23 AC-1 after resolve, a new report on the same resource creates a new incident (linkedToExisting: false)', async () => {
    const { incident: first } = await createOperatorIncident({
      resourceType: 'CHARGING_POINT',
      resourceId: 'DOR-CP-M-01',
      hubId: 'dorm',
      vehicleClass: 'MOTORCYCLE',
      category: 'CHARGER_FAULT',
      notes: 'First fault',
    });
    await request(app)
      .post(`/api/ops/incidents/${first.id}/start-maintenance`)
      .set('Authorization', op())
      .send({});
    await request(app)
      .post(`/api/ops/incidents/${first.id}/resolve`)
      .set('Authorization', op())
      .send({ resolutionNotes: 'Fixed first fault' });

    const second = await createOperatorIncident({
      resourceType: 'CHARGING_POINT',
      resourceId: 'DOR-CP-M-01',
      hubId: 'dorm',
      vehicleClass: 'MOTORCYCLE',
      category: 'ELECTRICAL',
      notes: 'Second unrelated fault',
    });
    expect(second.linkedToExisting).toBe(false);
    expect(second.incident.id).not.toBe(first.id);
    expect(second.incident.status).toBe('REPORTED');
  });

  // ---------------------------------------------------------------------------
  // AC-6: List filters (individually + combined AND), ordering, limit=1 paging with createdAt tie
  // ---------------------------------------------------------------------------
  it('FR-42 T-23 AC-6 list filters each field alone and combined with AND, orders newest first, and pages with limit=1 including createdAt tie-break', async () => {
    const t1 = new Date('2026-12-01T08:00:00.000Z');
    const tTie = new Date('2026-12-01T09:00:00.000Z');
    const t3 = new Date('2026-12-01T10:00:00.000Z');

    const r1 = await reportIncident(
      {
        source: 'OPERATOR',
        resourceType: 'RENTAL_VEHICLE',
        resourceId: 'RV-D-001',
        hubId: 'dorm',
        vehicleClass: 'MOTORCYCLE',
        category: 'VEHICLE_FAULT',
        notes: 'First at dorm',
        reportedById: 'operator1',
      },
      t1,
    );
    // Two incidents with the exact same createdAt (tTie) to exercise id DESC tie-break
    const rTieA = await reportIncident(
      {
        source: 'OPERATOR',
        resourceType: 'CHARGING_POINT',
        resourceId: 'DOR-CP-C-01',
        hubId: 'dorm',
        vehicleClass: 'CAR',
        category: 'CHARGER_FAULT',
        notes: 'Tie A at dorm CAR',
        reportedById: 'operator1',
      },
      tTie,
    );
    const rTieB = await reportIncident(
      {
        source: 'OPERATOR',
        resourceType: 'PARKING_SPACE',
        resourceId: 'CPA-P-C-01',
        hubId: 'campus-a',
        vehicleClass: 'CAR',
        category: 'OBSTRUCTION',
        notes: 'Tie B at campus-a CAR',
        reportedById: 'operator1',
      },
      tTie,
    );
    const r3 = await reportIncident(
      {
        source: 'OPERATOR',
        resourceType: 'CHARGING_POINT',
        resourceId: 'CPA-CP-M-01',
        hubId: 'campus-a',
        vehicleClass: 'MOTORCYCLE',
        category: 'ELECTRICAL',
        notes: 'Newest at campus-a',
        reportedById: 'operator1',
      },
      t3,
    );

    // Move r1 to IN_MAINTENANCE -> RESOLVED so we have distinct statuses
    await request(app)
      .post(`/api/ops/incidents/${r1.incident.id}/start-maintenance`)
      .set('Authorization', op())
      .send({});
    await request(app)
      .post(`/api/ops/incidents/${r1.incident.id}/resolve`)
      .set('Authorization', op())
      .send({ resolutionNotes: 'Done' });
    await request(app)
      .post(`/api/ops/incidents/${rTieA.incident.id}/start-maintenance`)
      .set('Authorization', op())
      .send({});

    // Expected order: createdAt DESC, id DESC
    const expectedIds = [r1.incident, rTieA.incident, rTieB.incident, r3.incident]
      .sort((a, b) => {
        const dt = Date.parse(b.createdAt) - Date.parse(a.createdAt);
        if (dt !== 0) return dt;
        return b.id > a.id ? 1 : b.id < a.id ? -1 : 0;
      })
      .map((i) => i.id);

    // Walk every row with limit=1 using nextCursor
    const walked: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 10; guard++) {
      const q: Record<string, string> = { limit: '1' };
      if (cursor) q['cursor'] = cursor;
      const page = await request(app)
        .get('/api/ops/incidents')
        .set('Authorization', op())
        .query(q);
      expect(page.status).toBe(200);
      expect(page.body.items).toHaveLength(1);
      walked.push(page.body.items[0].id as string);
      cursor = page.body.nextCursor as string | null;
      if (!cursor) break;
    }
    expect(cursor).toBeNull();
    expect(walked).toEqual(expectedIds);
    expect(new Set(walked).size).toBe(expectedIds.length);

    // Each filter alone
    const byHub = await request(app)
      .get('/api/ops/incidents')
      .set('Authorization', op())
      .query({ hubId: 'dorm' });
    expect(byHub.body.items.map((i: Incident) => i.id).sort()).toEqual(
      [r1.incident.id, rTieA.incident.id].sort(),
    );

    const byResource = await request(app)
      .get('/api/ops/incidents')
      .set('Authorization', op())
      .query({ resourceId: 'CPA-P-C-01' });
    expect(byResource.body.items.map((i: Incident) => i.id)).toEqual([rTieB.incident.id]);

    const byClass = await request(app)
      .get('/api/ops/incidents')
      .set('Authorization', op())
      .query({ vehicleClass: 'CAR' });
    expect(byClass.body.items.map((i: Incident) => i.id).sort()).toEqual(
      [rTieA.incident.id, rTieB.incident.id].sort(),
    );

    const byCategory = await request(app)
      .get('/api/ops/incidents')
      .set('Authorization', op())
      .query({ category: 'ELECTRICAL' });
    expect(byCategory.body.items.map((i: Incident) => i.id)).toEqual([r3.incident.id]);

    const byStatus = await request(app)
      .get('/api/ops/incidents')
      .set('Authorization', op())
      .query({ status: 'RESOLVED' });
    expect(byStatus.body.items.map((i: Incident) => i.id)).toEqual([r1.incident.id]);

    const byRange = await request(app)
      .get('/api/ops/incidents')
      .set('Authorization', op())
      .query({ from: tTie.toISOString(), to: tTie.toISOString() });
    expect(byRange.body.items.map((i: Incident) => i.id).sort()).toEqual(
      [rTieA.incident.id, rTieB.incident.id].sort(),
    );

    // Combined filters with AND
    const combined = await request(app)
      .get('/api/ops/incidents')
      .set('Authorization', op())
      .query({ hubId: 'dorm', vehicleClass: 'CAR', status: 'IN_MAINTENANCE' });
    expect(combined.body.items.map((i: Incident) => i.id)).toEqual([rTieA.incident.id]);

    // Unknown hubId / resourceId simply yields empty list
    const empty = await request(app)
      .get('/api/ops/incidents')
      .set('Authorization', op())
      .query({ hubId: 'unknown-hub' });
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual({ items: [], nextCursor: null });
  });

  // ---------------------------------------------------------------------------
  // AC-6: List query validation errors -> 400 with details.field
  // ---------------------------------------------------------------------------
  it('FR-42 T-23 AC-6 list rejects invalid enum, bad ISO date, from > to, bad limit, and bad cursor with 400 details.field', async () => {
    const cases: Array<{ query: Record<string, string>; field: string }> = [
      { query: { vehicleClass: 'TRUCK' }, field: 'vehicleClass' },
      { query: { category: 'ALIEN_ATTACK' }, field: 'category' },
      { query: { status: 'CLOSED' }, field: 'status' },
      { query: { from: 'not-a-date' }, field: 'from' },
      { query: { to: 'not-a-date' }, field: 'to' },
      {
        query: {
          from: '2026-12-02T10:00:00.000Z',
          to: '2026-12-01T10:00:00.000Z',
        },
        field: 'to',
      },
      { query: { limit: '0' }, field: 'limit' },
      { query: { limit: String(config.LIST_LIMIT_MAX + 1) }, field: 'limit' },
      { query: { cursor: '!!!not-valid-cursor!!!' }, field: 'cursor' },
    ];

    for (const c of cases) {
      const res = await request(app)
        .get('/api/ops/incidents')
        .set('Authorization', op())
        .query(c.query);
      expect(res.status, JSON.stringify(c.query)).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.details?.field).toBe(c.field);
    }
  });

  // ---------------------------------------------------------------------------
  // AC-7: Detail returns incident, reports oldest-first, impacts matching DB rows
  // ---------------------------------------------------------------------------
  it('UC-23 T-23 AC-7 detail returns incident, linked duplicate reports oldest-first, and impacts matching DB rows', async () => {
    // RV-M-006 has CONFIRMED reservation VR-001 (student2) in resetDb() -> will produce an impact
    const tFirst = new Date('2026-12-01T08:00:00.000Z');
    const tSecond = new Date('2026-12-01T08:05:00.000Z');

    const first = await reportIncident(
      {
        source: 'OPERATOR',
        resourceType: 'RENTAL_VEHICLE',
        resourceId: 'RV-M-006',
        hubId: 'metro',
        vehicleClass: 'MOTORCYCLE',
        category: 'VEHICLE_FAULT',
        notes: 'Initial operator report',
        reportedById: 'operator1',
      },
      tFirst,
    );

    const dup = await reportIncident(
      {
        source: 'TELEMETRY',
        resourceType: 'RENTAL_VEHICLE',
        resourceId: 'RV-M-006',
        hubId: 'metro',
        category: 'VEHICLE_FAULT',
        notes: 'Telemetry fault code: E_BRAKE',
      },
      tSecond,
    );
    expect(dup.linkedToExisting).toBe(true);

    const detailRes = await request(app)
      .get(`/api/ops/incidents/${first.incident.id}`)
      .set('Authorization', op());

    expect(detailRes.status).toBe(200);
    expect(detailRes.body.incident.id).toBe(first.incident.id);
    expect(detailRes.body.reports).toHaveLength(2);
    expect(detailRes.body.reports[0]).toEqual({
      source: 'OPERATOR',
      reportedById: 'operator1',
      notes: 'Initial operator report',
      createdAt: tFirst.toISOString(),
    });
    expect(detailRes.body.reports[1]).toEqual({
      source: 'TELEMETRY',
      reportedById: null,
      notes: 'Telemetry fault code: E_BRAKE',
      createdAt: tSecond.toISOString(),
    });

    const dbImpacts = await db.incidentImpact.findMany({
      where: { incidentId: first.incident.id },
      orderBy: { id: 'asc' },
    });
    expect(dbImpacts.length).toBeGreaterThanOrEqual(1);
    expect(detailRes.body.impacts).toEqual(
      dbImpacts.map((imp) => ({
        bookingType: imp.bookingType,
        bookingId: imp.bookingId,
        userId: imp.userId ?? null,
        outcome: imp.outcome,
        newResourceId: imp.newResourceId ?? null,
      })),
    );
  });

  // ---------------------------------------------------------------------------
  // AC-8: Role enforcement (student -> 403 + SECURITY_DENIED, no token -> 401)
  // ---------------------------------------------------------------------------
  it('FR-61 T-23 AC-8 student token gets 403 + SECURITY_DENIED on all four /ops/incidents routes and unauthenticated gets 401', async () => {
    const routes: Array<() => request.Test> = [
      () => request(app).get('/api/ops/incidents'),
      () => request(app).get('/api/ops/incidents/some-id'),
      () => request(app).post('/api/ops/incidents/some-id/start-maintenance').send({}),
      () =>
        request(app)
          .post('/api/ops/incidents/some-id/resolve')
          .send({ resolutionNotes: 'Fixed' }),
    ];

    for (const makeReq of routes) {
      const unauth = await makeReq();
      expect(unauth.status).toBe(401);

      const forbidden = await makeReq().set('Authorization', stu());
      expect(forbidden.status).toBe(403);
      expect(forbidden.body.error.code).toBe('FORBIDDEN');
    }

    const deniedAudits = await db.auditLog.findMany({
      where: { action: 'SECURITY_DENIED', actorId: 'student1' },
    });
    expect(deniedAudits).toHaveLength(4);
  });

  // ---------------------------------------------------------------------------
  // AC-9: Post-commit events on resolve only (none on start-maintenance or failed resolve)
  // ---------------------------------------------------------------------------
  it('T-23 AC-9 emits RESERVATION_CHANGED on vehicle/space resolve and CHARGING_QUEUE_CHANGED on point resolve after commit only', async () => {
    const { incident: incVeh } = await createOperatorIncident({
      resourceType: 'RENTAL_VEHICLE',
      resourceId: 'RV-D-001',
      hubId: 'dorm',
      vehicleClass: 'MOTORCYCLE',
      category: 'VEHICLE_FAULT',
      notes: 'Mirror broken',
    });
    const { incident: incSpace } = await createOperatorIncident({
      resourceType: 'PARKING_SPACE',
      resourceId: 'CPA-P-M-01',
      hubId: 'campus-a',
      vehicleClass: 'MOTORCYCLE',
      category: 'OBSTRUCTION',
      notes: 'Cone',
    });
    const { incident: incPoint } = await createOperatorIncident({
      resourceType: 'CHARGING_POINT',
      resourceId: 'CPB-CP-M-01',
      hubId: 'campus-b',
      vehicleClass: 'MOTORCYCLE',
      category: 'CHARGER_FAULT',
      notes: 'Fuse blown',
    });

    const emitSpy = vi.spyOn(events, 'emit');

    // Failed resolve (REPORTED -> 409) must NOT emit
    const failRes = await request(app)
      .post(`/api/ops/incidents/${incVeh.id}/resolve`)
      .set('Authorization', op())
      .send({ resolutionNotes: 'Too early' });
    expect(failRes.status).toBe(409);
    expect(emitSpy).not.toHaveBeenCalled();

    // start-maintenance must NOT emit
    for (const id of [incVeh.id, incSpace.id, incPoint.id]) {
      const r = await request(app)
        .post(`/api/ops/incidents/${id}/start-maintenance`)
        .set('Authorization', op())
        .send({});
      expect(r.status).toBe(200);
    }
    expect(emitSpy).not.toHaveBeenCalled();

    // Vehicle resolve -> RESERVATION_CHANGED { hubId: 'dorm' }
    await request(app)
      .post(`/api/ops/incidents/${incVeh.id}/resolve`)
      .set('Authorization', op())
      .send({ resolutionNotes: 'Replaced mirror' });
    expect(emitSpy).toHaveBeenCalledTimes(1);
    expect(emitSpy).toHaveBeenLastCalledWith('RESERVATION_CHANGED', { hubId: 'dorm' });

    // Space resolve -> RESERVATION_CHANGED { hubId: 'campus-a' }
    await request(app)
      .post(`/api/ops/incidents/${incSpace.id}/resolve`)
      .set('Authorization', op())
      .send({ resolutionNotes: 'Removed cone' });
    expect(emitSpy).toHaveBeenCalledTimes(2);
    expect(emitSpy).toHaveBeenLastCalledWith('RESERVATION_CHANGED', { hubId: 'campus-a' });

    // Charging point resolve -> CHARGING_QUEUE_CHANGED { hubId: 'campus-b' }
    await request(app)
      .post(`/api/ops/incidents/${incPoint.id}/resolve`)
      .set('Authorization', op())
      .send({ resolutionNotes: 'Replaced fuse' });
    expect(emitSpy).toHaveBeenCalledTimes(3);
    expect(emitSpy).toHaveBeenLastCalledWith('CHARGING_QUEUE_CHANGED', { hubId: 'campus-b' });

    // Second resolve (409) must NOT emit
    const failRes2 = await request(app)
      .post(`/api/ops/incidents/${incPoint.id}/resolve`)
      .set('Authorization', op())
      .send({ resolutionNotes: 'Already resolved' });
    expect(failRes2.status).toBe(409);
    expect(emitSpy).toHaveBeenCalledTimes(3);
  });
});
