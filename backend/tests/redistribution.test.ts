// T-28 Redistribution, Imbalance Detection, Monitoring SHORTAGE/SURPLUS Wiring & GET /ops/audit tests.
// Covers all 10 Orchestrator Test Matrix groups (FR-43..FR-47, FR-61, FR-63, BR-05, BR-08, BR-10, BR-12, BR-15, D-16..D-19).

import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { config } from '../src/core/config';
import { db } from '../src/core/db';
import { encodeCursor } from '../src/core/pagination';
import { evaluateHub } from '../src/modules/monitoring/monitoring.service';
import { createTestApp, loginAs, resetDb } from './helpers';

const app = createTestApp();
const opsAuth = () => loginAs('operator1');
const stu1Auth = () => loginAs('student1');

beforeEach(async () => {
  await resetDb();
});

// ============================================================================
// Group 1: Imbalance boundaries + Monitoring cross-ticket (FR-43, BR-15, T-24 + T-28)
// ============================================================================

describe('Group 1: FR-43 imbalance detection & monitoring SHORTAGE/SURPLUS wiring', () => {
  it('FR-43 detects exact OK / SHORTAGE / SURPLUS boundaries against hub_threshold and omits DEGRADED Hubs', async () => {
    await db.hubThreshold.create({
      data: { hubId: 'metro', vehicleClass: 'MOTORCYCLE', minAvailable: 3, maxAvailable: 5 },
    });

    // Fixture metro has 3 available (RV-M-001, RV-M-002, RV-M-005) -> OK
    let res = await request(app)
      .get('/api/ops/redistribution/imbalances')
      .set('Authorization', opsAuth());
    expect(res.status).toBe(200);
    // Degraded service hub must be omitted
    expect(res.body.some((i: { hubId: string }) => i.hubId === 'service')).toBe(false);

    const metroOk = res.body.find(
      (i: { hubId: string; vehicleClass: string }) =>
        i.hubId === 'metro' && i.vehicleClass === 'MOTORCYCLE',
    );
    expect(metroOk).toEqual({
      hubId: 'metro',
      vehicleClass: 'MOTORCYCLE',
      available: 3,
      min: 3,
      max: 5,
      state: 'OK',
      amount: 0,
    });

    // Drop available to 2 -> SHORTAGE (amount 1)
    await db.rentalVehicle.update({
      where: { id: 'RV-M-001' },
      data: { status: 'FAULTY' },
    });
    res = await request(app)
      .get('/api/ops/redistribution/imbalances')
      .set('Authorization', opsAuth());
    const metroShort = res.body.find(
      (i: { hubId: string; vehicleClass: string }) =>
        i.hubId === 'metro' && i.vehicleClass === 'MOTORCYCLE',
    );
    expect(metroShort).toMatchObject({ available: 2, state: 'SHORTAGE', amount: 1 });

    // Restore to 3 and add 2 more -> 5 (exact max -> OK)
    await db.rentalVehicle.update({
      where: { id: 'RV-M-001' },
      data: { status: 'AVAILABLE' },
    });
    await db.rentalVehicle.createMany({
      data: [
        {
          id: 'RV-M-X1',
          hubId: 'metro',
          type: 'E_MOTORCYCLE',
          vehicleClass: 'MOTORCYCLE',
          status: 'AVAILABLE',
          batteryPct: 80,
        },
        {
          id: 'RV-M-X2',
          hubId: 'metro',
          type: 'E_MOTORCYCLE',
          vehicleClass: 'MOTORCYCLE',
          status: 'AVAILABLE',
          batteryPct: 80,
        },
      ],
    });
    res = await request(app)
      .get('/api/ops/redistribution/imbalances')
      .set('Authorization', opsAuth());
    const metroMaxOk = res.body.find(
      (i: { hubId: string; vehicleClass: string }) =>
        i.hubId === 'metro' && i.vehicleClass === 'MOTORCYCLE',
    );
    expect(metroMaxOk).toMatchObject({ available: 5, state: 'OK', amount: 0 });

    // Add 1 more -> 6 (> max 5 -> SURPLUS, amount 1)
    await db.rentalVehicle.create({
      data: {
        id: 'RV-M-X3',
        hubId: 'metro',
        type: 'E_MOTORCYCLE',
        vehicleClass: 'MOTORCYCLE',
        status: 'AVAILABLE',
        batteryPct: 80,
      },
    });
    res = await request(app)
      .get('/api/ops/redistribution/imbalances')
      .set('Authorization', opsAuth());
    const metroSurplus = res.body.find(
      (i: { hubId: string; vehicleClass: string }) =>
        i.hubId === 'metro' && i.vehicleClass === 'MOTORCYCLE',
    );
    expect(metroSurplus).toMatchObject({ available: 6, state: 'SURPLUS', amount: 1 });
  });

  it('FR-43 monitoring evaluateHub raises SHORTAGE and SURPLUS alerts and auto-resolves them after redistribution completes', async () => {
    const now = new Date();
    // Make metro have 2 available (SHORTAGE vs min 3) and dorm have 2 available (SURPLUS vs max 1)
    await db.hubThreshold.createMany({
      data: [
        { hubId: 'metro', vehicleClass: 'MOTORCYCLE', minAvailable: 3, maxAvailable: 5 },
        { hubId: 'dorm', vehicleClass: 'MOTORCYCLE', minAvailable: 1, maxAvailable: 1 },
      ],
    });
    await db.rentalVehicle.update({
      where: { id: 'RV-M-001' },
      data: { status: 'FAULTY' },
    });

    await evaluateHub('metro', now);
    await evaluateHub('dorm', now);

    const shortageAlert = await db.alert.findFirst({
      where: { dedupeKey: 'SHORTAGE:metro:MOTORCYCLE', status: 'OPEN' },
    });
    const surplusAlert = await db.alert.findFirst({
      where: { dedupeKey: 'SURPLUS:dorm:MOTORCYCLE', status: 'OPEN' },
    });
    expect(shortageAlert).not.toBeNull();
    expect(surplusAlert).not.toBeNull();

    // Redistribute 1 vehicle from dorm -> metro (override: true since metro FLEET is 7/9 -> 8/9 = 88.9% > 85%)
    const created = await request(app)
      .post('/api/ops/redistribution/tasks')
      .set('Authorization', opsAuth())
      .send({
        sourceHubId: 'dorm',
        destHubId: 'metro',
        vehicleClass: 'MOTORCYCLE',
        count: 1,
        override: true,
        reason: 'Resolve metro shortage and dorm surplus',
      });
    expect(created.status).toBe(201);
    const taskId = created.body.id as string;

    expect(
      (await request(app).post(`/api/ops/redistribution/tasks/${taskId}/approve`).set('Authorization', opsAuth())).status,
    ).toBe(200);
    expect(
      (await request(app).post(`/api/ops/redistribution/tasks/${taskId}/start`).set('Authorization', opsAuth())).status,
    ).toBe(200);
    expect(
      (await request(app).post(`/api/ops/redistribution/tasks/${taskId}/complete`).set('Authorization', opsAuth())).status,
    ).toBe(200);

    // Re-evaluate both hubs -> both SHORTAGE and SURPLUS auto-resolve
    const t2 = new Date(now.getTime() + 1000);
    await evaluateHub('metro', t2);
    await evaluateHub('dorm', t2);

    const resolvedShortage = await db.alert.findUnique({ where: { id: shortageAlert!.id } });
    const resolvedSurplus = await db.alert.findUnique({ where: { id: surplusAlert!.id } });
    expect(resolvedShortage!.status).toBe('RESOLVED');
    expect(resolvedSurplus!.status).toBe('RESOLVED');
  });

  it('FR-43 UC-24 E1 monitoring evaluateHub suspends SHORTAGE and SURPLUS evaluation on DEGRADED Hubs', async () => {
    const now = new Date();
    // Fixture service Hub is degraded (lastTelemetryAt = now - 60s) and has only 1 available vs min 5
    await db.hubThreshold.create({
      data: { hubId: 'service', vehicleClass: 'MOTORCYCLE', minAvailable: 5, maxAvailable: 10 },
    });

    await evaluateHub('service', now);

    const imbalanceAlerts = await db.alert.findMany({
      where: { hubId: 'service', type: { in: ['SHORTAGE', 'SURPLUS'] } },
    });
    expect(imbalanceAlerts).toHaveLength(0);
  });
});

// ============================================================================
// Group 2: Vehicle eligibility across Reservations & Charging (FR-45, D-18, BR-08)
// ============================================================================

describe('Group 2: FR-45 vehicle eligibility & BR-08 Private EV exclusion', () => {
  it('FR-45 preview, create, and start count and attach only eligible AVAILABLE >= 20% unreserved non-charging rental vehicles (vehicleType filter, CAR 0 eligible, PrivateEv untouched)', async () => {
    // Make RV-M-001 an E_BICYCLE and add an IN_USE vehicle at metro so every non-eligible state is present
    await db.rentalVehicle.update({
      where: { id: 'RV-M-001' },
      data: { type: 'E_BICYCLE' },
    });
    await db.rentalVehicle.create({
      data: {
        id: 'RV-M-INUSE',
        hubId: 'metro',
        type: 'E_MOTORCYCLE',
        vehicleClass: 'MOTORCYCLE',
        status: 'IN_USE',
        batteryPct: 80,
      },
    });
    // Add extra free FLEET spaces at campus-a so destination capacity isn't the blocker
    await db.parkingSpace.createMany({
      data: [
        { id: 'CPA-F-M-10', hubId: 'campus-a', vehicleClass: 'MOTORCYCLE', pool: 'FLEET', status: 'FREE' },
        { id: 'CPA-F-M-11', hubId: 'campus-a', vehicleClass: 'MOTORCYCLE', pool: 'FLEET', status: 'FREE' },
        { id: 'CPA-F-M-12', hubId: 'campus-a', vehicleClass: 'MOTORCYCLE', pool: 'FLEET', status: 'FREE' },
        { id: 'CPA-F-M-13', hubId: 'campus-a', vehicleClass: 'MOTORCYCLE', pool: 'FLEET', status: 'FREE' },
        { id: 'CPA-F-M-14', hubId: 'campus-a', vehicleClass: 'MOTORCYCLE', pool: 'FLEET', status: 'FREE' },
      ],
    });

    // Eligible at metro: RV-M-001 (E_BICYCLE, 80%), RV-M-002 (E_MOTORCYCLE, 20%), RV-M-005 (E_MOTORCYCLE, 60%, QUEUED)
    // Excluded: RV-M-003 (19% LOW_BATTERY), RV-M-004 (CHARGING), RV-M-006 (RESERVED), RV-M-007 (FAULTY), RV-M-INUSE (IN_USE), PEV-01/02/03 (PrivateEv)
    const previewAll = await request(app)
      .get('/api/ops/redistribution/preview')
      .query({ sourceHubId: 'metro', destHubId: 'campus-a', vehicleClass: 'MOTORCYCLE', count: 3 })
      .set('Authorization', opsAuth());
    expect(previewAll.status).toBe(200);
    expect(previewAll.body.eligibleAtSource).toBe(3);
    expect(previewAll.body.ok).toBe(true);

    // Filter by E_BICYCLE -> only 1 (RV-M-001)
    const previewBike = await request(app)
      .get('/api/ops/redistribution/preview')
      .query({
        sourceHubId: 'metro',
        destHubId: 'campus-a',
        vehicleClass: 'MOTORCYCLE',
        vehicleType: 'E_BICYCLE',
        count: 1,
      })
      .set('Authorization', opsAuth());
    expect(previewBike.status).toBe(200);
    expect(previewBike.body.eligibleAtSource).toBe(1);

    // vehicleClass CAR -> 0 eligible -> POST /tasks returns 409 NOT_ELIGIBLE (PrivateEv PEV-01 never counted)
    const carCreate = await request(app)
      .post('/api/ops/redistribution/tasks')
      .set('Authorization', opsAuth())
      .send({
        sourceHubId: 'metro',
        destHubId: 'campus-a',
        vehicleClass: 'CAR',
        count: 1,
      });
    expect(carCreate.status).toBe(409);
    expect(carCreate.body.error.code).toBe('NOT_ELIGIBLE');

    // Create + approve + start E_BICYCLE task -> must attach ONLY RV-M-001
    const created = await request(app)
      .post('/api/ops/redistribution/tasks')
      .set('Authorization', opsAuth())
      .send({
        sourceHubId: 'metro',
        destHubId: 'campus-a',
        vehicleClass: 'MOTORCYCLE',
        vehicleType: 'E_BICYCLE',
        count: 1,
      });
    expect(created.status).toBe(201);
    const id = created.body.id as string;

    await request(app).post(`/api/ops/redistribution/tasks/${id}/approve`).set('Authorization', opsAuth());
    const started = await request(app)
      .post(`/api/ops/redistribution/tasks/${id}/start`)
      .set('Authorization', opsAuth());
    expect(started.status).toBe(200);
    expect(started.body.vehicleIds).toEqual(['RV-M-001']);

    // Verify Private EVs untouched
    const privateEvs = await db.privateEv.findMany({ orderBy: { id: 'asc' } });
    expect(privateEvs).toHaveLength(3);
  });
});

// ============================================================================
// Group 3: Destination capacity & BR-08 override boundaries (FR-44, FR-46, BR-08)
// ============================================================================

describe('Group 3: FR-44 / FR-46 / BR-08 capacity boundaries & validation', () => {
  it('FR-46 BR-08 enforces 85.0% OK, 85.1%-100% override + reason required, and > 100% always 409 CAPACITY_EXCEEDED', async () => {
    // Configure campus-b with EXACTLY 20 usable FLEET moto spaces: 15 OCCUPIED + 5 FREE
    // Fixture campus-b already has CPB-F-M-01 (OCCUPIED) and CPB-F-M-02 (FREE). Add 14 OCC + 4 FREE.
    const extraSpaces = [
      ...Array.from({ length: 14 }, (_, i) => ({
        id: `CPB-F-OCC-${i + 1}`,
        hubId: 'campus-b',
        vehicleClass: 'MOTORCYCLE' as const,
        pool: 'FLEET' as const,
        status: 'OCCUPIED' as const,
      })),
      ...Array.from({ length: 4 }, (_, i) => ({
        id: `CPB-F-FREE-${i + 1}`,
        hubId: 'campus-b',
        vehicleClass: 'MOTORCYCLE' as const,
        pool: 'FLEET' as const,
        status: 'FREE' as const,
      })),
    ];
    await db.parkingSpace.createMany({ data: extraSpaces });

    // Ensure metro has 6 eligible vehicles (already has 3 -> add 3 more)
    await db.rentalVehicle.createMany({
      data: Array.from({ length: 3 }, (_, i) => ({
        id: `RV-M-CAP-${i + 1}`,
        hubId: 'metro',
        type: 'E_MOTORCYCLE' as const,
        vehicleClass: 'MOTORCYCLE' as const,
        status: 'AVAILABLE' as const,
        batteryPct: 80,
      })),
    });

    // Case 1: count = 2 -> (15 + 2) / 20 = 85.0% -> ok: true, needsOverride: false
    const p85 = await request(app)
      .get('/api/ops/redistribution/preview')
      .query({ sourceHubId: 'metro', destHubId: 'campus-b', vehicleClass: 'MOTORCYCLE', count: 2 })
      .set('Authorization', opsAuth());
    expect(p85.status).toBe(200);
    expect(p85.body).toMatchObject({
      destFreeFleetSpaces: 5,
      predictedDestOccupancyPct: config.REDISTRIBUTION_DEST_LIMIT_PCT,
      ok: true,
      needsOverride: false,
      problems: [],
    });

    const create85 = await request(app)
      .post('/api/ops/redistribution/tasks')
      .set('Authorization', opsAuth())
      .send({ sourceHubId: 'metro', destHubId: 'campus-b', vehicleClass: 'MOTORCYCLE', count: 2 });
    expect(create85.status).toBe(201);

    // Case 2: count = 3 -> (15 + 3) / 20 = 90.0% -> ok: false, needsOverride: true
    const p90 = await request(app)
      .get('/api/ops/redistribution/preview')
      .query({ sourceHubId: 'metro', destHubId: 'campus-b', vehicleClass: 'MOTORCYCLE', count: 3 })
      .set('Authorization', opsAuth());
    expect(p90.status).toBe(200);
    expect(p90.body).toMatchObject({
      predictedDestOccupancyPct: 90,
      ok: false,
      needsOverride: true,
    });

    // Without override -> 409 CAPACITY_EXCEEDED
    const create90NoOv = await request(app)
      .post('/api/ops/redistribution/tasks')
      .set('Authorization', opsAuth())
      .send({ sourceHubId: 'metro', destHubId: 'campus-b', vehicleClass: 'MOTORCYCLE', count: 3 });
    expect(create90NoOv.status).toBe(409);
    expect(create90NoOv.body.error.code).toBe('CAPACITY_EXCEEDED');

    // With override: true + empty/whitespace reason -> 400 details.field: 'reason'
    const create90BlankReason = await request(app)
      .post('/api/ops/redistribution/tasks')
      .set('Authorization', opsAuth())
      .send({
        sourceHubId: 'metro',
        destHubId: 'campus-b',
        vehicleClass: 'MOTORCYCLE',
        count: 3,
        override: true,
        reason: '   ',
      });
    expect(create90BlankReason.status).toBe(400);
    expect(create90BlankReason.body.error.details.field).toBe('reason');

    // With override: true + valid reason -> 201 PROPOSED
    const create90Ok = await request(app)
      .post('/api/ops/redistribution/tasks')
      .set('Authorization', opsAuth())
      .send({
        sourceHubId: 'metro',
        destHubId: 'campus-b',
        vehicleClass: 'MOTORCYCLE',
        count: 3,
        override: true,
        reason: 'Event surge at Campus B',
      });
    expect(create90Ok.status).toBe(201);
    expect(create90Ok.body.override).toBe(true);

    // Case 3: count = 6 (> 5 free spaces -> 105%) -> 409 CAPACITY_EXCEEDED even with override: true
    const create105 = await request(app)
      .post('/api/ops/redistribution/tasks')
      .set('Authorization', opsAuth())
      .send({
        sourceHubId: 'metro',
        destHubId: 'campus-b',
        vehicleClass: 'MOTORCYCLE',
        count: 6,
        override: true,
        reason: 'Cannot exceed physical capacity',
      });
    expect(create105.status).toBe(409);
    expect(create105.body.error.code).toBe('CAPACITY_EXCEEDED');
  });

  it('FR-44 validates sourceHubId != destHubId, count >= 1, known Hubs, and required fields with 400 details.field', async () => {
    const sameHub = await request(app)
      .post('/api/ops/redistribution/tasks')
      .set('Authorization', opsAuth())
      .send({ sourceHubId: 'metro', destHubId: 'metro', vehicleClass: 'MOTORCYCLE', count: 1 });
    expect(sameHub.status).toBe(400);
    expect(sameHub.body.error.details.field).toBe('destHubId');

    const zeroCount = await request(app)
      .post('/api/ops/redistribution/tasks')
      .set('Authorization', opsAuth())
      .send({ sourceHubId: 'metro', destHubId: 'dorm', vehicleClass: 'MOTORCYCLE', count: 0 });
    expect(zeroCount.status).toBe(400);
    expect(zeroCount.body.error.details.field).toBe('count');

    const unknownHub = await request(app)
      .post('/api/ops/redistribution/tasks')
      .set('Authorization', opsAuth())
      .send({ sourceHubId: 'metro', destHubId: 'unknown', vehicleClass: 'MOTORCYCLE', count: 1 });
    expect(unknownHub.status).toBe(400);
    expect(unknownHub.body.error.details.field).toBe('destHubId');

    const missingField = await request(app)
      .post('/api/ops/redistribution/tasks')
      .set('Authorization', opsAuth())
      .send({ sourceHubId: 'metro', destHubId: 'dorm', count: 1 });
    expect(missingField.status).toBe(400);
    expect(missingField.body.error.details.field).toBe('vehicleClass');
  });
});

// ============================================================================
// Group 4: Full lifecycle + D-19 + FR-47 Hub counts (T-04 + T-11 + T-28)
// ============================================================================

describe('Group 4: FR-47 lifecycle, D-19 deferred locking & GET /api/hubs invariants', () => {
  it('FR-47 D-19 PROPOSED -> APPROVED -> IN_PROGRESS -> COMPLETED updates GET /api/hubs counts without double-counting and hides IN_TRANSIT from vehicle search', async () => {
    // Add free FLEET spaces at campus-a so 2 vehicles stay <= 85% (1 occ + 2 = 3/5 = 60%)
    await db.parkingSpace.createMany({
      data: [
        { id: 'CPA-F-M-L1', hubId: 'campus-a', vehicleClass: 'MOTORCYCLE', pool: 'FLEET', status: 'FREE' },
        { id: 'CPA-F-M-L2', hubId: 'campus-a', vehicleClass: 'MOTORCYCLE', pool: 'FLEET', status: 'FREE' },
        { id: 'CPA-F-M-L3', hubId: 'campus-a', vehicleClass: 'MOTORCYCLE', pool: 'FLEET', status: 'FREE' },
      ],
    });

    const hubsBefore = await request(app).get('/api/hubs').set('Authorization', opsAuth());
    const metroBefore = hubsBefore.body.find((h: { id: string }) => h.id === 'metro');
    const cpaBefore = hubsBefore.body.find((h: { id: string }) => h.id === 'campus-a');
    expect(metroBefore.availableRentalVehicles).toBe(3);
    expect(cpaBefore.availableRentalVehicles).toBe(1);

    // PROPOSED -> APPROVED: D-19 holds 0 resources
    const created = await request(app)
      .post('/api/ops/redistribution/tasks')
      .set('Authorization', opsAuth())
      .send({ sourceHubId: 'metro', destHubId: 'campus-a', vehicleClass: 'MOTORCYCLE', count: 2 });
    expect(created.status).toBe(201);
    expect(created.body.vehicleIds).toEqual([]);
    const id = created.body.id as string;

    const approved = await request(app)
      .post(`/api/ops/redistribution/tasks/${id}/approve`)
      .set('Authorization', opsAuth());
    expect(approved.status).toBe(200);
    expect(approved.body.status).toBe('APPROVED');
    expect(approved.body.vehicleIds).toEqual([]);

    const hubsAfterApprove = await request(app).get('/api/hubs').set('Authorization', opsAuth());
    expect(hubsAfterApprove.body.find((h: { id: string }) => h.id === 'metro').availableRentalVehicles).toBe(3);

    // APPROVED -> IN_PROGRESS: vehicles IN_TRANSIT, gone from source, not yet at dest, hidden from search
    const started = await request(app)
      .post(`/api/ops/redistribution/tasks/${id}/start`)
      .set('Authorization', opsAuth());
    expect(started.status).toBe(200);
    expect(started.body.status).toBe('IN_PROGRESS');
    expect(started.body.vehicleIds).toHaveLength(2);
    const movedIds = started.body.vehicleIds as string[];

    const hubsInProgress = await request(app).get('/api/hubs').set('Authorization', opsAuth());
    expect(hubsInProgress.body.find((h: { id: string }) => h.id === 'metro').availableRentalVehicles).toBe(1);
    expect(hubsInProgress.body.find((h: { id: string }) => h.id === 'campus-a').availableRentalVehicles).toBe(1);

    // Hidden from student vehicle search
    const search = await request(app)
      .get('/api/vehicles/search')
      .query({ hubId: 'metro', availableOnly: 'true' })
      .set('Authorization', stu1Auth());
    expect(search.status).toBe(200);
    for (const vid of movedIds) {
      expect(search.body.some((v: { id: string }) => v.id === vid)).toBe(false);
    }

    // Dest FLEET spaces are RESERVED with reservedForTaskId = id
    const reservedDest = await db.parkingSpace.findMany({
      where: { reservedForTaskId: id },
    });
    expect(reservedDest).toHaveLength(2);
    expect(reservedDest.every((s) => s.status === 'RESERVED')).toBe(true);

    // IN_PROGRESS -> COMPLETED: vehicles AVAILABLE at campus-a, dest spaces OCCUPIED, reservedForTaskId null
    const completed = await request(app)
      .post(`/api/ops/redistribution/tasks/${id}/complete`)
      .set('Authorization', opsAuth());
    expect(completed.status).toBe(200);
    expect(completed.body.status).toBe('COMPLETED');

    const hubsAfterComplete = await request(app).get('/api/hubs').set('Authorization', opsAuth());
    expect(hubsAfterComplete.body.find((h: { id: string }) => h.id === 'metro').availableRentalVehicles).toBe(1);
    expect(hubsAfterComplete.body.find((h: { id: string }) => h.id === 'campus-a').availableRentalVehicles).toBe(3);

    const parkedAtDest = await db.rentalVehicle.findMany({ where: { id: { in: movedIds } } });
    expect(parkedAtDest.every((v) => v.hubId === 'campus-a' && v.status === 'AVAILABLE' && v.parkingSpaceId !== null)).toBe(true);
    const stillReserved = await db.parkingSpace.findMany({ where: { reservedForTaskId: id } });
    expect(stillReserved).toHaveLength(0);
  });

  it('FR-47 IN_PROGRESS -> FAILED returns vehicles to source and releases reserved dest spaces; requires reason', async () => {
    await db.parkingSpace.createMany({
      data: [
        { id: 'CPA-F-M-F1', hubId: 'campus-a', vehicleClass: 'MOTORCYCLE', pool: 'FLEET', status: 'FREE' },
        { id: 'CPA-F-M-F2', hubId: 'campus-a', vehicleClass: 'MOTORCYCLE', pool: 'FLEET', status: 'FREE' },
      ],
    });

    const created = await request(app)
      .post('/api/ops/redistribution/tasks')
      .set('Authorization', opsAuth())
      .send({ sourceHubId: 'metro', destHubId: 'campus-a', vehicleClass: 'MOTORCYCLE', count: 1 });
    const id = created.body.id as string;
    await request(app).post(`/api/ops/redistribution/tasks/${id}/approve`).set('Authorization', opsAuth());
    const started = await request(app)
      .post(`/api/ops/redistribution/tasks/${id}/start`)
      .set('Authorization', opsAuth());
    const [vid] = started.body.vehicleIds as string[];

    // Missing reason -> 400
    const badFail = await request(app)
      .post(`/api/ops/redistribution/tasks/${id}/fail`)
      .set('Authorization', opsAuth())
      .send({ reason: '   ' });
    expect(badFail.status).toBe(400);
    expect(badFail.body.error.details.field).toBe('reason');

    // Valid fail -> vehicles back AVAILABLE at metro, dest space FREE
    const failed = await request(app)
      .post(`/api/ops/redistribution/tasks/${id}/fail`)
      .set('Authorization', opsAuth())
      .send({ reason: 'Transport truck breakdown' });
    expect(failed.status).toBe(200);
    expect(failed.body.status).toBe('FAILED');
    expect(failed.body.reason).toBe('Transport truck breakdown');

    const veh = await db.rentalVehicle.findUnique({ where: { id: vid! } });
    expect(veh!.hubId).toBe('metro');
    expect(veh!.status).toBe('AVAILABLE');

    const stillReserved = await db.parkingSpace.findMany({ where: { reservedForTaskId: id } });
    expect(stillReserved).toHaveLength(0);
  });

  it('FR-47 UC-25 A1 PROPOSED/APPROVED -> CANCELLED with reason; IN_PROGRESS -> CANCELLED rejected with 409 INVALID_STATE_TRANSITION and audit row', async () => {
    await db.parkingSpace.createMany({
      data: [
        { id: 'CPA-F-M-C1', hubId: 'campus-a', vehicleClass: 'MOTORCYCLE', pool: 'FLEET', status: 'FREE' },
        { id: 'CPA-F-M-C2', hubId: 'campus-a', vehicleClass: 'MOTORCYCLE', pool: 'FLEET', status: 'FREE' },
      ],
    });

    // PROPOSED -> CANCELLED
    const t1 = await request(app)
      .post('/api/ops/redistribution/tasks')
      .set('Authorization', opsAuth())
      .send({ sourceHubId: 'metro', destHubId: 'campus-a', vehicleClass: 'MOTORCYCLE', count: 1 });
    const badCancel = await request(app)
      .post(`/api/ops/redistribution/tasks/${t1.body.id}/cancel`)
      .set('Authorization', opsAuth())
      .send({});
    expect(badCancel.status).toBe(400);
    expect(badCancel.body.error.details.field).toBe('reason');

    const c1 = await request(app)
      .post(`/api/ops/redistribution/tasks/${t1.body.id}/cancel`)
      .set('Authorization', opsAuth())
      .send({ reason: 'No longer needed' });
    expect(c1.status).toBe(200);
    expect(c1.body.status).toBe('CANCELLED');

    // APPROVED -> CANCELLED
    const t2 = await request(app)
      .post('/api/ops/redistribution/tasks')
      .set('Authorization', opsAuth())
      .send({ sourceHubId: 'metro', destHubId: 'campus-a', vehicleClass: 'MOTORCYCLE', count: 1 });
    await request(app).post(`/api/ops/redistribution/tasks/${t2.body.id}/approve`).set('Authorization', opsAuth());
    const c2 = await request(app)
      .post(`/api/ops/redistribution/tasks/${t2.body.id}/cancel`)
      .set('Authorization', opsAuth())
      .send({ reason: 'Superseded by another plan' });
    expect(c2.status).toBe(200);
    expect(c2.body.status).toBe('CANCELLED');

    // IN_PROGRESS -> CANCELLED rejected with 409 INVALID_STATE_TRANSITION + INVALID_TRANSITION audit row
    const t3 = await request(app)
      .post('/api/ops/redistribution/tasks')
      .set('Authorization', opsAuth())
      .send({ sourceHubId: 'metro', destHubId: 'campus-a', vehicleClass: 'MOTORCYCLE', count: 1 });
    await request(app).post(`/api/ops/redistribution/tasks/${t3.body.id}/approve`).set('Authorization', opsAuth());
    await request(app).post(`/api/ops/redistribution/tasks/${t3.body.id}/start`).set('Authorization', opsAuth());

    const c3 = await request(app)
      .post(`/api/ops/redistribution/tasks/${t3.body.id}/cancel`)
      .set('Authorization', opsAuth())
      .send({ reason: 'Cannot cancel in transit' });
    expect(c3.status).toBe(409);
    expect(c3.body.error.code).toBe('INVALID_STATE_TRANSITION');

    const invalidAudit = await db.auditLog.findFirst({
      where: { action: 'INVALID_TRANSITION' },
      orderBy: { id: 'desc' },
    });
    expect(invalidAudit).not.toBeNull();
  });

  it('FR-47 list tasks supports status filter and limit=1 cursor pagination; detail returns vehicleIds and 404 on unknown id', async () => {
    await db.parkingSpace.createMany({
      data: [
        { id: 'CPA-F-M-P1', hubId: 'campus-a', vehicleClass: 'MOTORCYCLE', pool: 'FLEET', status: 'FREE' },
        { id: 'CPA-F-M-P2', hubId: 'campus-a', vehicleClass: 'MOTORCYCLE', pool: 'FLEET', status: 'FREE' },
      ],
    });

    const t1 = await request(app)
      .post('/api/ops/redistribution/tasks')
      .set('Authorization', opsAuth())
      .send({ sourceHubId: 'metro', destHubId: 'campus-a', vehicleClass: 'MOTORCYCLE', count: 1 });
    const t2 = await request(app)
      .post('/api/ops/redistribution/tasks')
      .set('Authorization', opsAuth())
      .send({ sourceHubId: 'metro', destHubId: 'campus-a', vehicleClass: 'MOTORCYCLE', count: 1 });
    await request(app).post(`/api/ops/redistribution/tasks/${t2.body.id}/approve`).set('Authorization', opsAuth());

    // Page 1 (limit=1)
    const p1 = await request(app)
      .get('/api/ops/redistribution/tasks')
      .query({ limit: 1 })
      .set('Authorization', opsAuth());
    expect(p1.status).toBe(200);
    expect(p1.body.items).toHaveLength(1);
    expect(p1.body.nextCursor).not.toBeNull();

    // Page 2
    const p2 = await request(app)
      .get('/api/ops/redistribution/tasks')
      .query({ limit: 1, cursor: p1.body.nextCursor })
      .set('Authorization', opsAuth());
    expect(p2.status).toBe(200);
    expect(p2.body.items).toHaveLength(1);
    expect(p2.body.items[0].id).not.toBe(p1.body.items[0].id);

    // Status filter
    const approvedOnly = await request(app)
      .get('/api/ops/redistribution/tasks')
      .query({ status: 'APPROVED' })
      .set('Authorization', opsAuth());
    expect(approvedOnly.status).toBe(200);
    expect(approvedOnly.body.items.map((i: { id: string }) => i.id)).toEqual([t2.body.id]);

    // Detail + 404
    const detail = await request(app)
      .get(`/api/ops/redistribution/tasks/${t1.body.id}`)
      .set('Authorization', opsAuth());
    expect(detail.status).toBe(200);
    expect(detail.body.vehicleIds).toEqual([]);

    const missing = await request(app)
      .get('/api/ops/redistribution/tasks/non-existent-id')
      .set('Authorization', opsAuth());
    expect(missing.status).toBe(404);
  });
});

// ============================================================================
// Group 5: Cross-ticket Race 1 — start vs student reserveVehicle (BR-10, T-11 + T-28)
// ============================================================================

describe('Group 5: BR-10 Race 1 — redistribution start vs student reserveVehicle', () => {
  it('BR-10 Race 1: concurrent redistribution start vs student reserveVehicle for last vehicle has exactly one winner', async () => {
    // campus-a has exactly 1 eligible vehicle: RV-A-001. Give campus-b plenty of free FLEET spaces.
    await db.parkingSpace.createMany({
      data: [
        { id: 'CPB-F-R1-1', hubId: 'campus-b', vehicleClass: 'MOTORCYCLE', pool: 'FLEET', status: 'FREE' },
        { id: 'CPB-F-R1-2', hubId: 'campus-b', vehicleClass: 'MOTORCYCLE', pool: 'FLEET', status: 'FREE' },
      ],
    });

    const created = await request(app)
      .post('/api/ops/redistribution/tasks')
      .set('Authorization', opsAuth())
      .send({ sourceHubId: 'campus-a', destHubId: 'campus-b', vehicleClass: 'MOTORCYCLE', count: 1 });
    expect(created.status).toBe(201);
    const taskId = created.body.id as string;
    await request(app).post(`/api/ops/redistribution/tasks/${taskId}/approve`).set('Authorization', opsAuth());

    const [startRes, reserveRes] = await Promise.all([
      request(app)
        .post(`/api/ops/redistribution/tasks/${taskId}/start`)
        .set('Authorization', opsAuth()),
      request(app)
        .post('/api/vehicle-reservations')
        .set('Authorization', stu1Auth())
        .set('Idempotency-Key', 'race1-reserve-key')
        .send({ vehicleId: 'RV-A-001' }),
    ]);

    expect([200, 409]).toContain(startRes.status);
    expect([201, 409]).toContain(reserveRes.status);
    const startWon = startRes.status === 200;
    const reserveWon = reserveRes.status === 201;
    expect(startWon !== reserveWon).toBe(true);

    const veh = await db.rentalVehicle.findUnique({ where: { id: 'RV-A-001' } });
    if (startWon) {
      expect(reserveRes.body.error.code).toBe('RESOURCE_TAKEN');
      expect(veh!.status).toBe('IN_TRANSIT');
    } else {
      expect(startRes.body.error.code).toBe('NOT_ELIGIBLE');
      expect(veh!.status).toBe('RESERVED');
    }
  });
});

// ============================================================================
// Group 6: Cross-ticket Race 2 — start vs student returnVehicle (BR-04, BR-10, T-12 + T-28)
// ============================================================================

describe('Group 6: BR-10 Race 2 — redistribution start vs student returnVehicle for last dest FLEET space', () => {
  it('BR-10 Race 2: concurrent redistribution start vs student returnVehicle for last dest FLEET space has exactly one winner', async () => {
    // Fixture dorm has exactly 1 FREE FLEET space: DOR-F-M-03 (2 OCC + 1 FREE).
    // Give student1 an ACTIVE rental on RV-A-001 (from campus-a) to return to dorm.
    const resv = await request(app)
      .post('/api/vehicle-reservations')
      .set('Authorization', stu1Auth())
      .set('Idempotency-Key', 'race2-setup-key')
      .send({ vehicleId: 'RV-A-001' });
    expect(resv.status).toBe(201);
    const resvId = resv.body.id as string;
    const pickup = await request(app)
      .post(`/api/vehicle-reservations/${resvId}/pickup`)
      .set('Authorization', stu1Auth());
    expect(pickup.status).toBe(200);

    // Create + approve an override redistribution task metro -> dorm (count 1)
    const created = await request(app)
      .post('/api/ops/redistribution/tasks')
      .set('Authorization', opsAuth())
      .send({
        sourceHubId: 'metro',
        destHubId: 'dorm',
        vehicleClass: 'MOTORCYCLE',
        count: 1,
        override: true,
        reason: 'Race 2 fill last dorm FLEET space',
      });
    expect(created.status).toBe(201);
    const taskId = created.body.id as string;
    await request(app).post(`/api/ops/redistribution/tasks/${taskId}/approve`).set('Authorization', opsAuth());

    const [startRes, returnRes] = await Promise.all([
      request(app)
        .post(`/api/ops/redistribution/tasks/${taskId}/start`)
        .set('Authorization', opsAuth()),
      request(app)
        .post(`/api/vehicle-reservations/${resvId}/return`)
        .set('Authorization', stu1Auth())
        .send({ hubId: 'dorm' }),
    ]);

    expect([200, 409]).toContain(startRes.status);
    expect([200, 409]).toContain(returnRes.status);
    const startWon = startRes.status === 200;
    const returnWon = returnRes.status === 200;
    expect(startWon !== returnWon).toBe(true);

    const space = await db.parkingSpace.findUnique({ where: { id: 'DOR-F-M-03' } });
    if (startWon) {
      expect(returnRes.body.error.code).toBe('HUB_FULL');
      expect(space!.status).toBe('RESERVED');
      expect(space!.reservedForTaskId).toBe(taskId);
    } else {
      expect(startRes.body.error.code).toBe('CAPACITY_EXCEEDED');
      expect(space!.status).toBe('OCCUPIED');
      expect(space!.reservedForTaskId).toBeNull();
    }
  });
});

// ============================================================================
// Group 7: Race 3 — Competing redistribution starts (last vehicle & 85% dest cap)
// ============================================================================

describe('Group 7: BR-10 Race 3 — competing redistribution starts', () => {
  it('BR-10 Race 3A: two competing APPROVED redistribution starts for last eligible source vehicle have exactly one winner', async () => {
    // campus-a has 1 eligible vehicle (RV-A-001). Give campus-b and dorm extra free FLEET spaces.
    await db.parkingSpace.createMany({
      data: [
        { id: 'CPB-F-R3A-1', hubId: 'campus-b', vehicleClass: 'MOTORCYCLE', pool: 'FLEET', status: 'FREE' },
        { id: 'CPB-F-R3A-2', hubId: 'campus-b', vehicleClass: 'MOTORCYCLE', pool: 'FLEET', status: 'FREE' },
        { id: 'DOR-F-R3A-1', hubId: 'dorm', vehicleClass: 'MOTORCYCLE', pool: 'FLEET', status: 'FREE' },
        { id: 'DOR-F-R3A-2', hubId: 'dorm', vehicleClass: 'MOTORCYCLE', pool: 'FLEET', status: 'FREE' },
        { id: 'DOR-F-R3A-3', hubId: 'dorm', vehicleClass: 'MOTORCYCLE', pool: 'FLEET', status: 'FREE' },
      ],
    });

    const t1 = await request(app)
      .post('/api/ops/redistribution/tasks')
      .set('Authorization', opsAuth())
      .send({ sourceHubId: 'campus-a', destHubId: 'campus-b', vehicleClass: 'MOTORCYCLE', count: 1 });
    const t2 = await request(app)
      .post('/api/ops/redistribution/tasks')
      .set('Authorization', opsAuth())
      .send({ sourceHubId: 'campus-a', destHubId: 'dorm', vehicleClass: 'MOTORCYCLE', count: 1 });
    await request(app).post(`/api/ops/redistribution/tasks/${t1.body.id}/approve`).set('Authorization', opsAuth());
    await request(app).post(`/api/ops/redistribution/tasks/${t2.body.id}/approve`).set('Authorization', opsAuth());

    const [r1, r2] = await Promise.all([
      request(app).post(`/api/ops/redistribution/tasks/${t1.body.id}/start`).set('Authorization', opsAuth()),
      request(app).post(`/api/ops/redistribution/tasks/${t2.body.id}/start`).set('Authorization', opsAuth()),
    ]);

    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([200, 409]);
    const loser = r1.status === 409 ? r1 : r2;
    expect(loser.body.error.code).toBe('NOT_ELIGIBLE');

    const links = await db.redistributionTaskVehicle.findMany();
    expect(links).toHaveLength(1);
  });

  it('BR-10 Race 3B: two competing non-override redistribution starts exceeding 85% dest cap together serialize on hub lock with exactly one winner', async () => {
    // Configure campus-b with 10 usable FLEET spaces: 7 OCCUPIED + 3 FREE (70% now).
    // Each count=1 task alone -> 8/10 = 80% <= 85% (OK). Together -> 9/10 = 90% > 85% (second MUST fail 409!).
    await db.parkingSpace.createMany({
      data: [
        ...Array.from({ length: 6 }, (_, i) => ({
          id: `CPB-R3B-OCC-${i + 1}`,
          hubId: 'campus-b',
          vehicleClass: 'MOTORCYCLE' as const,
          pool: 'FLEET' as const,
          status: 'OCCUPIED' as const,
        })),
        ...Array.from({ length: 2 }, (_, i) => ({
          id: `CPB-R3B-FREE-${i + 1}`,
          hubId: 'campus-b',
          vehicleClass: 'MOTORCYCLE' as const,
          pool: 'FLEET' as const,
          status: 'FREE' as const,
        })),
      ],
    });

    const t1 = await request(app)
      .post('/api/ops/redistribution/tasks')
      .set('Authorization', opsAuth())
      .send({ sourceHubId: 'metro', destHubId: 'campus-b', vehicleClass: 'MOTORCYCLE', count: 1 });
    const t2 = await request(app)
      .post('/api/ops/redistribution/tasks')
      .set('Authorization', opsAuth())
      .send({ sourceHubId: 'dorm', destHubId: 'campus-b', vehicleClass: 'MOTORCYCLE', count: 1 });
    expect(t1.status).toBe(201);
    expect(t2.status).toBe(201);
    await request(app).post(`/api/ops/redistribution/tasks/${t1.body.id}/approve`).set('Authorization', opsAuth());
    await request(app).post(`/api/ops/redistribution/tasks/${t2.body.id}/approve`).set('Authorization', opsAuth());

    const [r1, r2] = await Promise.all([
      request(app).post(`/api/ops/redistribution/tasks/${t1.body.id}/start`).set('Authorization', opsAuth()),
      request(app).post(`/api/ops/redistribution/tasks/${t2.body.id}/start`).set('Authorization', opsAuth()),
    ]);

    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([200, 409]);
    const loser = r1.status === 409 ? r1 : r2;
    expect(loser.body.error.code).toBe('CAPACITY_EXCEEDED');

    // Only 1 dest space reserved -> total used = 8/10 = 80% <= 85%
    const reservedCount = await db.parkingSpace.count({
      where: { hubId: 'campus-b', pool: 'FLEET', status: 'RESERVED' },
    });
    expect(reservedCount).toBe(1);
  });
});

// ============================================================================
// Group 8: Race 4 — Concurrent start vs start and start vs cancel on SAME task
// ============================================================================

describe('Group 8: BR-10 Race 4 — same-task concurrent transitions', () => {
  it('BR-10 Race 4: concurrent start vs start and start vs cancel on the same task have exactly one winner and one audit row', async () => {
    await db.parkingSpace.createMany({
      data: [
        { id: 'CPA-F-R4-1', hubId: 'campus-a', vehicleClass: 'MOTORCYCLE', pool: 'FLEET', status: 'FREE' },
        { id: 'CPA-F-R4-2', hubId: 'campus-a', vehicleClass: 'MOTORCYCLE', pool: 'FLEET', status: 'FREE' },
        { id: 'CPA-F-R4-3', hubId: 'campus-a', vehicleClass: 'MOTORCYCLE', pool: 'FLEET', status: 'FREE' },
      ],
    });

    // Sub-case A: start vs start
    const tA = await request(app)
      .post('/api/ops/redistribution/tasks')
      .set('Authorization', opsAuth())
      .send({ sourceHubId: 'metro', destHubId: 'campus-a', vehicleClass: 'MOTORCYCLE', count: 1 });
    await request(app).post(`/api/ops/redistribution/tasks/${tA.body.id}/approve`).set('Authorization', opsAuth());

    const [sa1, sa2] = await Promise.all([
      request(app).post(`/api/ops/redistribution/tasks/${tA.body.id}/start`).set('Authorization', opsAuth()),
      request(app).post(`/api/ops/redistribution/tasks/${tA.body.id}/start`).set('Authorization', opsAuth()),
    ]);
    expect([sa1.status, sa2.status].sort()).toEqual([200, 409]);
    const startedAudits = await db.auditLog.findMany({
      where: { action: 'REDISTRIBUTION_STARTED', entityIds: { has: tA.body.id } },
    });
    expect(startedAudits).toHaveLength(1);

    // Sub-case B: start vs cancel
    const tB = await request(app)
      .post('/api/ops/redistribution/tasks')
      .set('Authorization', opsAuth())
      .send({ sourceHubId: 'metro', destHubId: 'campus-a', vehicleClass: 'MOTORCYCLE', count: 1 });
    await request(app).post(`/api/ops/redistribution/tasks/${tB.body.id}/approve`).set('Authorization', opsAuth());

    const [sbStart, sbCancel] = await Promise.all([
      request(app).post(`/api/ops/redistribution/tasks/${tB.body.id}/start`).set('Authorization', opsAuth()),
      request(app)
        .post(`/api/ops/redistribution/tasks/${tB.body.id}/cancel`)
        .set('Authorization', opsAuth())
        .send({ reason: 'Concurrent cancel race' }),
    ]);
    expect([sbStart.status, sbCancel.status].sort()).toEqual([200, 409]);
    const winnerAudits = await db.auditLog.findMany({
      where: {
        action: { in: ['REDISTRIBUTION_STARTED', 'REDISTRIBUTION_CANCELLED'] },
        entityIds: { has: tB.body.id },
      },
    });
    expect(winnerAudits).toHaveLength(1);
  });
});

// ============================================================================
// Group 9: GET /api/ops/audit (FR-63, NFR-14, CONTRACTS §15)
// ============================================================================

describe('Group 9: FR-63 GET /api/ops/audit filters & cursor pagination', () => {
  it('FR-63 every redistribution lifecycle step writes its REDISTRIBUTION_* audit row queryable via GET /api/ops/audit', async () => {
    await db.parkingSpace.createMany({
      data: [
        { id: 'CPA-F-AUD-1', hubId: 'campus-a', vehicleClass: 'MOTORCYCLE', pool: 'FLEET', status: 'FREE' },
        { id: 'CPA-F-AUD-2', hubId: 'campus-a', vehicleClass: 'MOTORCYCLE', pool: 'FLEET', status: 'FREE' },
      ],
    });

    const created = await request(app)
      .post('/api/ops/redistribution/tasks')
      .set('Authorization', opsAuth())
      .send({ sourceHubId: 'metro', destHubId: 'campus-a', vehicleClass: 'MOTORCYCLE', count: 1 });
    const id = created.body.id as string;
    await request(app).post(`/api/ops/redistribution/tasks/${id}/approve`).set('Authorization', opsAuth());
    await request(app).post(`/api/ops/redistribution/tasks/${id}/start`).set('Authorization', opsAuth());
    await request(app).post(`/api/ops/redistribution/tasks/${id}/complete`).set('Authorization', opsAuth());

    const auditRes = await request(app)
      .get('/api/ops/audit')
      .query({ entityType: 'redistribution_task', entityId: id })
      .set('Authorization', opsAuth());
    expect(auditRes.status).toBe(200);
    const actions = auditRes.body.items.map((r: { action: string }) => r.action);
    expect(actions).toEqual([
      'REDISTRIBUTION_COMPLETED',
      'REDISTRIBUTION_STARTED',
      'REDISTRIBUTION_APPROVED',
      'REDISTRIBUTION_CREATED',
    ]);
    // BigInt id serialized as numeric string
    expect(typeof auditRes.body.items[0].id).toBe('string');
    expect(/^\d+$/.test(auditRes.body.items[0].id)).toBe(true);
  });

  it('FR-63 GET /api/ops/audit filters by entityType, entityId, actorId, action, from/to and paginates newest-first with BigInt cursor validation', async () => {
    const t0 = new Date('2026-11-25T10:00:00.000Z');
    const t1 = new Date('2026-11-25T10:01:00.000Z');
    const t2 = new Date('2026-11-25T10:02:00.000Z');

    await db.auditLog.createMany({
      data: [
        { at: t0, actorId: 'operator1', actorRole: 'OPERATOR', action: 'REDISTRIBUTION_CREATED', entityType: 'redistribution_task', entityIds: ['T-1'], details: {} },
        { at: t1, actorId: 'operator1', actorRole: 'OPERATOR', action: 'REDISTRIBUTION_APPROVED', entityType: 'redistribution_task', entityIds: ['T-1'], details: {} },
        { at: t1, actorId: 'operator1', actorRole: 'OPERATOR', action: 'REDISTRIBUTION_STARTED', entityType: 'redistribution_task', entityIds: ['T-1'], details: {} },
        { at: t2, actorId: 'student1', actorRole: 'STUDENT', action: 'SECURITY_DENIED', entityType: 'route', entityIds: ['R-1'], details: {} },
      ],
    });

    // Cursor pagination with limit=2 across all 4 rows (includes timestamp tie at t1)
    const p1 = await request(app)
      .get('/api/ops/audit')
      .query({ limit: 2 })
      .set('Authorization', opsAuth());
    expect(p1.status).toBe(200);
    expect(p1.body.items).toHaveLength(2);
    expect(p1.body.nextCursor).not.toBeNull();

    const p2 = await request(app)
      .get('/api/ops/audit')
      .query({ limit: 2, cursor: p1.body.nextCursor })
      .set('Authorization', opsAuth());
    expect(p2.status).toBe(200);
    expect(p2.body.items).toHaveLength(2);
    expect(p2.body.nextCursor).toBeNull();

    const allIds = [...p1.body.items, ...p2.body.items].map((r: { id: string }) => BigInt(r.id));
    expect(new Set(allIds).size).toBe(4);
    expect(p1.body.items[0].action).toBe('SECURITY_DENIED');

    // Filters: actorId, action, from..to inclusive
    const filtered = await request(app)
      .get('/api/ops/audit')
      .query({
        actorId: 'operator1',
        action: 'REDISTRIBUTION_STARTED',
        from: t1.toISOString(),
        to: t1.toISOString(),
      })
      .set('Authorization', opsAuth());
    expect(filtered.status).toBe(200);
    expect(filtered.body.items).toHaveLength(1);
    expect(filtered.body.items[0].action).toBe('REDISTRIBUTION_STARTED');

    // Validation: from > to -> 400
    const badRange = await request(app)
      .get('/api/ops/audit')
      .query({ from: t2.toISOString(), to: t0.toISOString() })
      .set('Authorization', opsAuth());
    expect(badRange.status).toBe(400);
    expect(badRange.body.error.details.field).toBe('to');

    // Validation: non-numeric BigInt cursor -> 400
    const badBigIntCursor = encodeCursor({ createdAt: t1, id: 'not-a-bigint' });
    const badCursorRes = await request(app)
      .get('/api/ops/audit')
      .query({ cursor: badBigIntCursor })
      .set('Authorization', opsAuth());
    expect(badCursorRes.status).toBe(400);
    expect(badCursorRes.body.error.details.field).toBe('cursor');

    // Validation: invalid ISO date -> 400
    const badDate = await request(app)
      .get('/api/ops/audit')
      .query({ from: 'not-a-date' })
      .set('Authorization', opsAuth());
    expect(badDate.status).toBe(400);
    expect(badDate.body.error.details.field).toBe('from');
  });
});

// ============================================================================
// Group 10: Role & auth enforcement (FR-61, BR-12)
// ============================================================================

describe('Group 10: FR-61 BR-12 role & auth enforcement', () => {
  it('FR-61 BR-12 rejects STUDENT with 403 + SECURITY_DENIED and unauthenticated with 401 on all 10 redistribution routes and GET /ops/audit', async () => {
    const routes: Array<{ method: 'get' | 'post'; path: string }> = [
      { method: 'get', path: '/api/ops/redistribution/imbalances' },
      { method: 'get', path: '/api/ops/redistribution/preview' },
      { method: 'post', path: '/api/ops/redistribution/tasks' },
      { method: 'get', path: '/api/ops/redistribution/tasks' },
      { method: 'get', path: '/api/ops/redistribution/tasks/fake-id' },
      { method: 'post', path: '/api/ops/redistribution/tasks/fake-id/approve' },
      { method: 'post', path: '/api/ops/redistribution/tasks/fake-id/start' },
      { method: 'post', path: '/api/ops/redistribution/tasks/fake-id/complete' },
      { method: 'post', path: '/api/ops/redistribution/tasks/fake-id/fail' },
      { method: 'post', path: '/api/ops/redistribution/tasks/fake-id/cancel' },
      { method: 'get', path: '/api/ops/audit' },
    ];

    for (const r of routes) {
      const noAuth = await request(app)[r.method](r.path);
      expect(noAuth.status).toBe(401);

      const stu = await request(app)[r.method](r.path).set('Authorization', stu1Auth());
      expect(stu.status).toBe(403);
    }

    const deniedCount = await db.auditLog.count({ where: { action: 'SECURITY_DENIED' } });
    expect(deniedCount).toBeGreaterThanOrEqual(routes.length);
  });
});
