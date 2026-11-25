// Monitoring & alerts integration tests (T-24: FR-31..FR-35, BR-09, UC-19, UC-20).

import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../src/core/config';
import { db } from '../src/core/db';
import { events } from '../src/core/events';
import { runJobOnce } from '../src/core/scheduler';
import {
  MONITORING_EVALUATE_JOB,
  registerMonitoringJobs,
} from '../src/modules/monitoring/monitoring.jobs';
import {
  ALERT_NOTE_MAX,
  SUPPRESSED_SETTING_PREFIX,
  evaluateAllHubs,
  evaluateHub,
} from '../src/modules/monitoring/monitoring.service';
import type { Alert, AlertList, DashboardResponse, OpsHubDetail } from '../src/types/monitoring';
import { FIXTURE, createTestApp, loginAs, resetDb } from './helpers';

const app = createTestApp();
const operatorAuth = loginAs('operator1');
const studentAuth = loginAs('student1');

const STALLED_MS = config.STALLED_FEED_INTERVALS * config.TELEMETRY_INTERVAL_SEC * 1000;

async function waitForCondition(
  check: () => Promise<boolean>,
  timeoutMs = 2000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return check();
}

beforeAll(() => {
  registerMonitoringJobs();
});

beforeEach(async () => {
  await resetDb();
});

// ============================================================================
// FR-31: Network monitoring dashboard (GET /api/ops/dashboard)
// ============================================================================

describe('FR-31 GET /api/ops/dashboard', () => {
  it('FR-31 returns all 5 Hubs with metrics, activeRentals, queueDepth, OPEN-only openAlerts, totals, and serverNow', async () => {
    const now = new Date();

    // Add one ACTIVE rental at dorm so activeRentals > 0
    await db.rentalVehicle.update({
      where: { id: 'RV-D-001' },
      data: { status: 'IN_USE', parkingSpaceId: null },
    });
    await db.parkingSpace.update({
      where: { id: 'DOR-F-M-01' },
      data: { status: 'FREE' },
    });
    await db.vehicleReservation.create({
      data: {
        id: 'VR-ACTIVE-DORM',
        userId: 'student1',
        rentalVehicleId: 'RV-D-001',
        hubId: 'dorm',
        status: 'ACTIVE',
        expiresAt: new Date(now.getTime() + 15 * 60_000),
      },
    });

    // Seed alerts at metro: 1 OPEN, 1 ACKNOWLEDGED, 1 DISMISSED, 1 RESOLVED
    await db.alert.createMany({
      data: [
        {
          id: 'al-open',
          type: 'LOW_BATTERY',
          hubId: 'metro',
          resourceIds: ['RV-M-003'],
          metric: { count: 1 },
          message: 'open',
          dedupeKey: 'LOW_BATTERY:metro',
          status: 'OPEN',
        },
        {
          id: 'al-ack',
          type: 'STALLED_FEED',
          hubId: 'metro',
          resourceIds: [],
          metric: {},
          message: 'ack',
          dedupeKey: 'STALLED:metro',
          status: 'ACKNOWLEDGED',
        },
        {
          id: 'al-dis',
          type: 'FAULT',
          hubId: 'metro',
          resourceIds: ['RV-M-007'],
          metric: {},
          message: 'dis',
          dedupeKey: 'FAULT:RV-M-007',
          status: 'DISMISSED',
        },
        {
          id: 'al-res',
          type: 'NEAR_CAPACITY',
          hubId: 'metro',
          resourceIds: [],
          metric: {},
          message: 'res',
          dedupeKey: 'NEAR_CAPACITY:metro:CHARGING:CAR',
          status: 'RESOLVED',
        },
      ],
    });

    const res = await request(app)
      .get('/api/ops/dashboard')
      .set('Authorization', operatorAuth);

    expect(res.status).toBe(200);
    const body = res.body as DashboardResponse;

    expect(typeof body.serverNow).toBe('string');
    expect(Number.isNaN(Date.parse(body.serverNow))).toBe(false);
    expect(body.hubs.map((h) => h.hubId)).toEqual([...FIXTURE.hubs]);

    const metro = body.hubs.find((h) => h.hubId === 'metro')!;
    expect(metro.availableRentalVehicles).toEqual({
      MOTORCYCLE: FIXTURE.metro.availableRentalVehicles,
      CAR: 0,
    });
    expect(metro.parkingUtilPct).toEqual({
      MOTORCYCLE: FIXTURE.metro.parking.MOTORCYCLE.utilPct,
      CAR: FIXTURE.metro.parking.CAR.utilPct,
    });
    expect(metro.chargingUtilPct).toEqual({
      MOTORCYCLE: FIXTURE.metro.charging.MOTORCYCLE.utilPct,
      CAR: FIXTURE.metro.charging.CAR.utilPct,
    });
    expect(metro.degraded).toBe(FIXTURE.metro.degraded);
    expect(metro.activeRentals).toBe(0);
    // CR-M-002 is QUEUED at metro (MOTORCYCLE)
    expect(metro.queueDepth).toEqual({ MOTORCYCLE: 1, CAR: 0 });
    // Only OPEN alerts counted (not ACKNOWLEDGED / DISMISSED / RESOLVED)
    expect(metro.openAlerts).toBe(1);

    const dorm = body.hubs.find((h) => h.hubId === 'dorm')!;
    expect(dorm.activeRentals).toBe(1);
    expect(dorm.queueDepth).toEqual({ MOTORCYCLE: 0, CAR: 0 });
    expect(dorm.openAlerts).toBe(0);

    const service = body.hubs.find((h) => h.hubId === 'service')!;
    expect(service.degraded).toBe(true);

    expect(body.totals).toEqual({
      rentalVehicles: 12,
      chargingPoints: 13,
      activeRentals: 1,
    });
  });
});

// ============================================================================
// FR-32: Operator Hub drill-down (GET /api/ops/hubs/:hubId)
// ============================================================================

describe('FR-32 GET /api/ops/hubs/:hubId', () => {
  it('FR-32 returns Hub resources with occupiedBy for rental vehicles, parking spaces, and charging points', async () => {
    const res = await request(app)
      .get('/api/ops/hubs/metro')
      .set('Authorization', operatorAuth);

    expect(res.status).toBe(200);
    const body = res.body as OpsHubDetail;

    expect(body.id).toBe('metro');
    expect(body.vehicles).toHaveLength(FIXTURE.metro.vehicleCount);
    expect(body.parkingSpaces).toHaveLength(FIXTURE.metro.parkingSpaceCount);
    expect(body.chargingPoints).toHaveLength(FIXTURE.metro.chargingPointCount);

    // FLEET space with parked rental vehicle (no userDisplayName)
    const fleetSpace = body.parkingSpaces.find((s) => s.id === 'MET-F-M-01')!;
    expect(fleetSpace.occupiedBy).toEqual({ kind: 'rentalVehicle', id: 'RV-M-001' });

    // PUBLIC space with ACTIVE parking reservation
    const activePublicSpace = body.parkingSpaces.find((s) => s.id === 'MET-P-M-04')!;
    expect(activePublicSpace.occupiedBy).toEqual({
      kind: 'parkingReservation',
      id: 'PR-M-003',
      userDisplayName: 'Student One',
    });

    // PUBLIC space with current CONFIRMED (RESERVED) parking reservation
    const reservedPublicSpace = body.parkingSpaces.find((s) => s.id === 'MET-P-M-03')!;
    expect(reservedPublicSpace.occupiedBy).toEqual({
      kind: 'parkingReservation',
      id: 'PR-M-002',
      userDisplayName: 'Student One',
    });

    // FREE space → null
    const freeSpace = body.parkingSpaces.find((s) => s.id === 'MET-P-M-01')!;
    expect(freeSpace.occupiedBy).toBeNull();

    // Fleet charging point (no userDisplayName)
    const fleetCharger = body.chargingPoints.find((c) => c.id === 'MET-CP-M-02')!;
    expect(fleetCharger.occupiedBy).toEqual({ kind: 'chargingRequest', id: 'CR-M-001' });

    // Private EV charging point (has userDisplayName)
    const privateCharger = body.chargingPoints.find((c) => c.id === 'MET-CP-C-01')!;
    expect(privateCharger.occupiedBy).toEqual({
      kind: 'chargingRequest',
      id: 'CR-C-001',
      userDisplayName: 'Student One',
    });

    // Free charging point → null
    const freeCharger = body.chargingPoints.find((c) => c.id === 'MET-CP-M-01')!;
    expect(freeCharger.occupiedBy).toBeNull();

    // Rental vehicle currently charging vs not charging
    const chargingVehicle = body.vehicles.find((v) => v.id === 'RV-M-004')!;
    expect(chargingVehicle.occupiedBy).toEqual({ kind: 'chargingRequest', id: 'CR-M-001' });

    const idleVehicle = body.vehicles.find((v) => v.id === 'RV-M-001')!;
    expect(idleVehicle.occupiedBy).toBeNull();
  });

  it('FR-32 returns 404 NOT_FOUND for an unknown Hub', async () => {
    const res = await request(app)
      .get('/api/ops/hubs/does-not-exist')
      .set('Authorization', operatorAuth);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});

// ============================================================================
// FR-33 / BR-09 / FR-35: Alert evaluation & boundaries
// ============================================================================

describe('FR-33 & BR-09 alert evaluation', () => {
  it('FR-33 BR-09 NEAR_CAPACITY parking boundary: 84/100 does not fire, 85/100 fires and dedupes on re-eval', async () => {
    const t0 = new Date();
    const threshold = config.NEAR_CAPACITY_PCT; // 85

    // Reset dorm MOTORCYCLE parking spaces to exactly 100 spaces: 84 OCCUPIED, 16 FREE
    await db.rentalVehicle.updateMany({
      where: { hubId: 'dorm' },
      data: { parkingSpaceId: null },
    });
    await db.parkingSpace.deleteMany({
      where: { hubId: 'dorm', vehicleClass: 'MOTORCYCLE' },
    });

    const spaces = Array.from({ length: 100 }, (_, i) => ({
      id: `DOR-CAP-${String(i + 1).padStart(3, '0')}`,
      hubId: 'dorm',
      vehicleClass: 'MOTORCYCLE' as const,
      pool: 'PUBLIC' as const,
      status: i < threshold - 1 ? ('OCCUPIED' as const) : ('FREE' as const),
    }));
    await db.parkingSpace.createMany({ data: spaces });

    await evaluateHub('dorm', t0);
    const dedupeKey = 'NEAR_CAPACITY:dorm:PARKING:MOTORCYCLE';
    expect(await db.alert.findMany({ where: { dedupeKey } })).toHaveLength(0);

    // Push to 85/100 (exact threshold)
    await db.parkingSpace.update({
      where: { id: `DOR-CAP-${String(threshold).padStart(3, '0')}` },
      data: { status: 'OCCUPIED' },
    });

    const t1 = new Date(t0.getTime() + 5000);
    await evaluateHub('dorm', t1);

    const afterFire = await db.alert.findMany({ where: { dedupeKey } });
    expect(afterFire).toHaveLength(1);
    expect(afterFire[0]!.status).toBe('OPEN');
    expect(afterFire[0]!.type).toBe('NEAR_CAPACITY');
    expect(afterFire[0]!.vehicleClass).toBe('MOTORCYCLE');
    expect(afterFire[0]!.metric).toMatchObject({ used: threshold, usable: 100, utilPct: threshold });

    // Re-evaluate later with 86/100: still 1 row, lastSeenAt & metric updated
    await db.parkingSpace.update({
      where: { id: `DOR-CAP-${String(threshold + 1).padStart(3, '0')}` },
      data: { status: 'OCCUPIED' },
    });
    const t2 = new Date(t1.getTime() + 5000);
    await evaluateHub('dorm', t2);

    const afterReeval = await db.alert.findMany({ where: { dedupeKey } });
    expect(afterReeval).toHaveLength(1);
    expect(afterReeval[0]!.id).toBe(afterFire[0]!.id);
    expect(afterReeval[0]!.lastSeenAt.getTime()).toBe(t2.getTime());
    expect(afterReeval[0]!.metric).toMatchObject({ used: threshold + 1, usable: 100 });
  });

  it('FR-33 BR-09 NEAR_CAPACITY edge cases: 0 spaces = 0% (no alert), all spaces UNAVAILABLE = 100% (alert), charging NEAR_CAPACITY fires', async () => {
    const now = new Date();

    // service has 0 CAR spaces and 0 CAR charging points → no CAR NEAR_CAPACITY alerts
    await evaluateHub('service', now);
    const serviceCarAlerts = await db.alert.findMany({
      where: { hubId: 'service', type: 'NEAR_CAPACITY', vehicleClass: 'CAR' },
    });
    expect(serviceCarAlerts).toHaveLength(0);

    // campus-a has 1 CAR space (CPA-P-C-01); mark it UNAVAILABLE → 100% → fires NEAR_CAPACITY
    await db.parkingSpace.update({
      where: { id: 'CPA-P-C-01' },
      data: { status: 'UNAVAILABLE' },
    });
    await evaluateHub('campus-a', now);
    const cpaCarParking = await db.alert.findFirst({
      where: { dedupeKey: 'NEAR_CAPACITY:campus-a:PARKING:CAR', status: 'OPEN' },
    });
    expect(cpaCarParking).not.toBeNull();
    expect(cpaCarParking!.metric).toMatchObject({ utilPct: 100 });

    // metro has 1 CAR charging point (MET-CP-C-01) CHARGING → 100% → fires charging NEAR_CAPACITY
    await evaluateHub('metro', now);
    const metroCarCharging = await db.alert.findFirst({
      where: { dedupeKey: 'NEAR_CAPACITY:metro:CHARGING:CAR', status: 'OPEN' },
    });
    expect(metroCarCharging).not.toBeNull();
    expect(metroCarCharging!.metric).toMatchObject({ used: 1, usable: 1, utilPct: 100 });
  });

  it('FR-33 LOW_BATTERY boundary: 20% does not fire, 19% fires with sorted resourceIds, FAULTY at 10% is ignored', async () => {
    const now = new Date();

    // In dorm: RV-D-001 (90%), RV-D-002 (30%). Set RV-D-001 to exact min (20%) and RV-D-002 to FAULTY at 10%.
    await db.rentalVehicle.update({
      where: { id: 'RV-D-001' },
      data: { status: 'AVAILABLE', batteryPct: config.MIN_RENTAL_BATTERY_PCT },
    });
    await db.rentalVehicle.update({
      where: { id: 'RV-D-002' },
      data: { status: 'FAULTY', batteryPct: 10 },
    });

    await evaluateHub('dorm', now);
    expect(await db.alert.findMany({ where: { dedupeKey: 'LOW_BATTERY:dorm' } })).toHaveLength(0);

    // Drop RV-D-001 to 19% (min - 1) and add a second low-battery vehicle to check sorting
    await db.rentalVehicle.update({
      where: { id: 'RV-D-001' },
      data: { status: 'LOW_BATTERY', batteryPct: config.MIN_RENTAL_BATTERY_PCT - 1 },
    });
    await db.rentalVehicle.create({
      data: {
        id: 'RV-D-000',
        hubId: 'dorm',
        type: 'E_MOTORCYCLE',
        vehicleClass: 'MOTORCYCLE',
        status: 'AVAILABLE',
        batteryPct: config.MIN_RENTAL_BATTERY_PCT - 2,
        parkingSpaceId: null,
      },
    });

    await evaluateHub('dorm', now);
    const alerts = await db.alert.findMany({ where: { dedupeKey: 'LOW_BATTERY:dorm' } });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.status).toBe('OPEN');
    expect(alerts[0]!.resourceIds).toEqual(['RV-D-000', 'RV-D-001']); // sorted; RV-D-002 (FAULTY) excluded
    expect(alerts[0]!.metric).toMatchObject({
      count: 2,
      lowestBatteryPct: config.MIN_RENTAL_BATTERY_PCT - 2,
      thresholdPct: config.MIN_RENTAL_BATTERY_PCT,
    });
  });

  it('FR-33 FAULT alert fires only for withdrawn resources with an open incident and auto-resolves when resolved', async () => {
    const now = new Date();

    // Fixture has RV-M-007 FAULTY, MET-P-M-05 UNAVAILABLE, MET-CP-M-03 FAULTY — none have incidents yet
    await evaluateHub('metro', now);
    expect(await db.alert.findMany({ where: { hubId: 'metro', type: 'FAULT' } })).toHaveLength(0);

    // Open incidents for all three resource types
    await db.incident.createMany({
      data: [
        {
          id: 'INC-RV',
          resourceType: 'RENTAL_VEHICLE',
          resourceId: 'RV-M-007',
          hubId: 'metro',
          vehicleClass: 'MOTORCYCLE',
          category: 'VEHICLE_FAULT',
          status: 'REPORTED',
          notes: 'Motor error',
          source: 'OPERATOR',
        },
        {
          id: 'INC-PS',
          resourceType: 'PARKING_SPACE',
          resourceId: 'MET-P-M-05',
          hubId: 'metro',
          vehicleClass: 'MOTORCYCLE',
          category: 'OBSTRUCTION',
          status: 'IN_MAINTENANCE',
          notes: 'Blocked space',
          source: 'OPERATOR',
        },
        {
          id: 'INC-CP',
          resourceType: 'CHARGING_POINT',
          resourceId: 'MET-CP-M-03',
          hubId: 'metro',
          vehicleClass: 'MOTORCYCLE',
          category: 'CHARGER_FAULT',
          status: 'REPORTED',
          notes: 'Charger offline',
          source: 'OPERATOR',
        },
      ],
    });

    await evaluateHub('metro', now);
    const faultAlerts = await db.alert.findMany({
      where: { hubId: 'metro', type: 'FAULT', status: 'OPEN' },
      orderBy: { dedupeKey: 'asc' },
    });
    expect(faultAlerts.map((a) => a.dedupeKey)).toEqual([
      'FAULT:MET-CP-M-03',
      'FAULT:MET-P-M-05',
      'FAULT:RV-M-007',
    ]);

    // Resolve INC-RV → FAULT:RV-M-007 auto-resolves while the other two remain OPEN
    await db.incident.update({
      where: { id: 'INC-RV' },
      data: { status: 'RESOLVED', resolvedAt: now },
    });

    await evaluateHub('metro', new Date(now.getTime() + 5000));
    const rvAlert = await db.alert.findFirst({ where: { dedupeKey: 'FAULT:RV-M-007' } });
    expect(rvAlert!.status).toBe('RESOLVED');
    expect(
      await db.alert.count({ where: { hubId: 'metro', type: 'FAULT', status: 'OPEN' } }),
    ).toBe(2);
  });

  it('FR-35 STALLED_FEED boundary: 14.999 s no alert, 15.000 s fires, null fires, fresh telemetry auto-resolves', async () => {
    const now = new Date();
    const dedupeKey = 'STALLED:dorm';

    // 14.999 s ago → NOT stalled
    await db.hub.update({
      where: { id: 'dorm' },
      data: { lastTelemetryAt: new Date(now.getTime() - (STALLED_MS - 1)) },
    });
    await evaluateHub('dorm', now);
    expect(await db.alert.findMany({ where: { dedupeKey } })).toHaveLength(0);

    // Exact 15.000 s ago → STALLED_FEED fires
    await db.hub.update({
      where: { id: 'dorm' },
      data: { lastTelemetryAt: new Date(now.getTime() - STALLED_MS) },
    });
    await evaluateHub('dorm', now);
    const stalled = await db.alert.findMany({ where: { dedupeKey } });
    expect(stalled).toHaveLength(1);
    expect(stalled[0]!.status).toBe('OPEN');
    expect(stalled[0]!.type).toBe('STALLED_FEED');

    // Fresh telemetry → auto-resolves
    const t2 = new Date(now.getTime() + 5000);
    await db.hub.update({
      where: { id: 'dorm' },
      data: { lastTelemetryAt: new Date(t2.getTime() - 1000) },
    });
    await evaluateHub('dorm', t2);
    const resolved = await db.alert.findUnique({ where: { id: stalled[0]!.id } });
    expect(resolved!.status).toBe('RESOLVED');

    // null lastTelemetryAt → fires a new OPEN STALLED_FEED alert
    const t3 = new Date(t2.getTime() + 5000);
    await db.hub.update({
      where: { id: 'dorm' },
      data: { lastTelemetryAt: null },
    });
    await evaluateHub('dorm', t3);
    const openAfterNull = await db.alert.findMany({ where: { dedupeKey, status: 'OPEN' } });
    expect(openAfterNull).toHaveLength(1);
  });

  it('FR-43 UC-24 E1 evaluateHub suspends SHORTAGE and SURPLUS evaluation on a DEGRADED Hub', async () => {
    const now = new Date();
    // Mark dorm DEGRADED so imbalance evaluation is suspended (UC-24 E1)
    await db.hub.update({
      where: { id: 'dorm' },
      data: { lastTelemetryAt: new Date(now.getTime() - STALLED_MS) },
    });
    await db.alert.createMany({
      data: [
        {
          id: 'al-shortage',
          type: 'SHORTAGE',
          hubId: 'dorm',
          resourceIds: [],
          metric: { available: 1, min: 3 },
          message: 'shortage',
          dedupeKey: 'SHORTAGE:dorm:MOTORCYCLE',
          status: 'OPEN',
        },
        {
          id: 'al-surplus',
          type: 'SURPLUS',
          hubId: 'dorm',
          resourceIds: [],
          metric: { available: 20, max: 15 },
          message: 'surplus',
          dedupeKey: 'SURPLUS:dorm:MOTORCYCLE',
          status: 'OPEN',
        },
      ],
    });

    await evaluateHub('dorm', now);

    const stillOpen = await db.alert.findMany({
      where: { id: { in: ['al-shortage', 'al-surplus'] } },
      orderBy: { id: 'asc' },
    });
    expect(stillOpen.map((a) => a.status)).toEqual(['OPEN', 'OPEN']);
  });
});

// ============================================================================
// FR-34: Alert dedupe, acknowledge, dismiss & suppression lifecycle
// ============================================================================

describe('FR-34 acknowledge, dismiss, suppression lifecycle, and validation', () => {
  it('FR-34 walks full 5-step dedupe/ack/dismiss/suppression lifecycle with audit rows', async () => {
    const t0 = new Date();
    const dedupeKey = 'STALLED:dorm';
    const suppressionKey = `${SUPPRESSED_SETTING_PREFIX}${dedupeKey}`;

    // Step 1: condition triggers → 1 OPEN row
    await db.hub.update({
      where: { id: 'dorm' },
      data: { lastTelemetryAt: new Date(t0.getTime() - STALLED_MS) },
    });
    await evaluateHub('dorm', t0);
    const step1 = await db.alert.findMany({ where: { dedupeKey } });
    expect(step1).toHaveLength(1);
    expect(step1[0]!.status).toBe('OPEN');
    expect(await db.setting.findUnique({ where: { key: suppressionKey } })).toBeNull();

    // Step 2: operator acknowledges with note → stays ACKNOWLEDGED across next eval while persisting
    const ackRes = await request(app)
      .post(`/api/ops/alerts/${step1[0]!.id}/acknowledge`)
      .set('Authorization', operatorAuth)
      .send({ note: 'Investigating telemetry gateway' });

    expect(ackRes.status).toBe(200);
    const acked = ackRes.body as Alert;
    expect(acked.status).toBe('ACKNOWLEDGED');
    expect(acked.closedById).toBe('operator1');
    expect(acked.closedAt).not.toBeNull();

    const ackAudit = await db.auditLog.findFirst({
      where: { action: 'ALERT_ACKNOWLEDGED', entityIds: { has: step1[0]!.id } },
    });
    expect(ackAudit).not.toBeNull();
    expect(ackAudit!.reason).toBe('Investigating telemetry gateway');

    const t1 = new Date(t0.getTime() + 5000);
    await evaluateHub('dorm', t1);
    const step2 = await db.alert.findMany({ where: { dedupeKey } });
    expect(step2).toHaveLength(1);
    expect(step2[0]!.id).toBe(step1[0]!.id);
    expect(step2[0]!.status).toBe('ACKNOWLEDGED');
    expect(step2[0]!.lastSeenAt.getTime()).toBe(t1.getTime());

    // Step 3: condition clears → ACKNOWLEDGED row transitions to RESOLVED
    const t2 = new Date(t1.getTime() + 5000);
    await db.hub.update({
      where: { id: 'dorm' },
      data: { lastTelemetryAt: new Date(t2.getTime() - 1000) },
    });
    await evaluateHub('dorm', t2);
    const step3 = await db.alert.findUnique({ where: { id: step1[0]!.id } });
    expect(step3!.status).toBe('RESOLVED');

    // Step 4: condition returns → new OPEN row; operator dismisses → suppressed while persisting
    const t3 = new Date(t2.getTime() + 5000);
    await db.hub.update({
      where: { id: 'dorm' },
      data: { lastTelemetryAt: new Date(t3.getTime() - STALLED_MS) },
    });
    await evaluateHub('dorm', t3);
    const openAgain = await db.alert.findMany({ where: { dedupeKey, status: 'OPEN' } });
    expect(openAgain).toHaveLength(1);
    expect(openAgain[0]!.id).not.toBe(step1[0]!.id);

    const dismissRes = await request(app)
      .post(`/api/ops/alerts/${openAgain[0]!.id}/dismiss`)
      .set('Authorization', operatorAuth)
      .send({ note: 'Planned gateway restart' });

    expect(dismissRes.status).toBe(200);
    expect((dismissRes.body as Alert).status).toBe('DISMISSED');
    expect((dismissRes.body as Alert).closedById).toBe('operator1');

    const dismissAudit = await db.auditLog.findFirst({
      where: { action: 'ALERT_DISMISSED', entityIds: { has: openAgain[0]!.id } },
    });
    expect(dismissAudit).not.toBeNull();
    expect(dismissAudit!.reason).toBe('Planned gateway restart');
    expect(await db.setting.findUnique({ where: { key: suppressionKey } })).not.toBeNull();

    // Next eval while condition STILL active → suppressed (no new OPEN row)
    const t4 = new Date(t3.getTime() + 5000);
    await evaluateHub('dorm', t4);
    expect(await db.alert.findMany({ where: { dedupeKey, status: 'OPEN' } })).toHaveLength(0);

    // Step 5: condition clears once → suppression key cleared; condition returns → fresh OPEN row
    const t5 = new Date(t4.getTime() + 5000);
    await db.hub.update({
      where: { id: 'dorm' },
      data: { lastTelemetryAt: new Date(t5.getTime() - 1000) },
    });
    await evaluateHub('dorm', t5);
    expect(await db.setting.findUnique({ where: { key: suppressionKey } })).toBeNull();

    const t6 = new Date(t5.getTime() + 5000);
    await db.hub.update({
      where: { id: 'dorm' },
      data: { lastTelemetryAt: new Date(t6.getTime() - STALLED_MS) },
    });
    await evaluateHub('dorm', t6);
    const finalOpen = await db.alert.findMany({ where: { dedupeKey, status: 'OPEN' } });
    expect(finalOpen).toHaveLength(1);
    expect(finalOpen[0]!.id).not.toBe(openAgain[0]!.id);
  });

  it('FR-34 rejects acknowledge/dismiss on non-OPEN alerts with 409 and unknown id with 404', async () => {
    await db.alert.createMany({
      data: [
        {
          id: 'al-ack',
          type: 'LOW_BATTERY',
          hubId: 'dorm',
          resourceIds: [],
          metric: {},
          message: 'ack',
          dedupeKey: 'LOW_BATTERY:dorm',
          status: 'ACKNOWLEDGED',
        },
        {
          id: 'al-dis',
          type: 'STALLED_FEED',
          hubId: 'dorm',
          resourceIds: [],
          metric: {},
          message: 'dis',
          dedupeKey: 'STALLED:dorm',
          status: 'DISMISSED',
        },
        {
          id: 'al-res',
          type: 'FAULT',
          hubId: 'dorm',
          resourceIds: [],
          metric: {},
          message: 'res',
          dedupeKey: 'FAULT:RV-D-001',
          status: 'RESOLVED',
        },
      ],
    });

    for (const id of ['al-ack', 'al-dis', 'al-res']) {
      for (const action of ['acknowledge', 'dismiss']) {
        const res = await request(app)
          .post(`/api/ops/alerts/${id}/${action}`)
          .set('Authorization', operatorAuth)
          .send({});
        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe('INVALID_STATE_TRANSITION');
      }
    }

    for (const action of ['acknowledge', 'dismiss']) {
      const res = await request(app)
        .post(`/api/ops/alerts/non-existent/${action}`)
        .set('Authorization', operatorAuth)
        .send({});
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    }
  });

  it('FR-34 enforces note max length boundary (1000 OK, 1001 → 400 details.field=note)', async () => {
    await db.alert.create({
      data: {
        id: 'al-note',
        type: 'LOW_BATTERY',
        hubId: 'dorm',
        resourceIds: [],
        metric: {},
        message: 'msg',
        dedupeKey: 'LOW_BATTERY:dorm',
        status: 'OPEN',
      },
    });

    const tooLong = await request(app)
      .post('/api/ops/alerts/al-note/acknowledge')
      .set('Authorization', operatorAuth)
      .send({ note: 'a'.repeat(ALERT_NOTE_MAX + 1) });

    expect(tooLong.status).toBe(400);
    expect(tooLong.body.error.code).toBe('VALIDATION_ERROR');
    expect(tooLong.body.error.details.field).toBe('note');

    const exact = await request(app)
      .post('/api/ops/alerts/al-note/acknowledge')
      .set('Authorization', operatorAuth)
      .send({ note: 'a'.repeat(ALERT_NOTE_MAX) });

    expect(exact.status).toBe(200);
    const noteAudit = await db.auditLog.findFirst({
      where: { action: 'ALERT_ACKNOWLEDGED', entityIds: { has: 'al-note' } },
    });
    expect(noteAudit!.reason).toHaveLength(ALERT_NOTE_MAX);
  });
});

// ============================================================================
// FR-34: Alert inbox listing, filtering & cursor pagination
// ============================================================================

describe('FR-34 GET /api/ops/alerts', () => {
  it('FR-34 defaults to OPEN, applies AND filters, and paginates with createdAt DESC + id DESC tie-break', async () => {
    const tSame = new Date('2026-11-25T10:00:00.000Z');
    const tOlder = new Date('2026-11-25T09:00:00.000Z');

    await db.alert.createMany({
      data: [
        {
          id: 'al-1',
          type: 'LOW_BATTERY',
          hubId: 'metro',
          resourceIds: [],
          metric: {},
          message: 'm1',
          dedupeKey: 'LOW_BATTERY:metro',
          status: 'OPEN',
          createdAt: tOlder,
          lastSeenAt: tOlder,
        },
        {
          id: 'al-2',
          type: 'STALLED_FEED',
          hubId: 'metro',
          resourceIds: [],
          metric: {},
          message: 'm2',
          dedupeKey: 'STALLED:metro',
          status: 'OPEN',
          createdAt: tSame,
          lastSeenAt: tSame,
        },
        {
          id: 'al-3',
          type: 'STALLED_FEED',
          hubId: 'dorm',
          resourceIds: [],
          metric: {},
          message: 'm3',
          dedupeKey: 'STALLED:dorm',
          status: 'OPEN',
          createdAt: tSame,
          lastSeenAt: tSame,
        },
        {
          id: 'al-4',
          type: 'STALLED_FEED',
          hubId: 'service',
          resourceIds: [],
          metric: {},
          message: 'm4',
          dedupeKey: 'STALLED:service',
          status: 'ACKNOWLEDGED',
          createdAt: tSame,
          lastSeenAt: tSame,
        },
      ],
    });

    // Default returns only OPEN, ordered by createdAt DESC, id DESC → al-3, al-2, al-1
    const defRes = await request(app)
      .get('/api/ops/alerts')
      .set('Authorization', operatorAuth);
    expect(defRes.status).toBe(200);
    expect((defRes.body as AlertList).items.map((a) => a.id)).toEqual(['al-3', 'al-2', 'al-1']);
    expect((defRes.body as AlertList).nextCursor).toBeNull();

    // AND filter: status=OPEN & type=STALLED_FEED & hubId=metro → only al-2
    const filtered = await request(app)
      .get('/api/ops/alerts?status=OPEN&type=STALLED_FEED&hubId=metro')
      .set('Authorization', operatorAuth);
    expect(filtered.status).toBe(200);
    expect((filtered.body as AlertList).items.map((a) => a.id)).toEqual(['al-2']);

    // Filter by ACKNOWLEDGED → al-4
    const ackOnly = await request(app)
      .get('/api/ops/alerts?status=ACKNOWLEDGED')
      .set('Authorization', operatorAuth);
    expect(ackOnly.status).toBe(200);
    expect((ackOnly.body as AlertList).items.map((a) => a.id)).toEqual(['al-4']);

    // Cursor walk with limit=1 across all 3 OPEN rows (exercises createdAt tie-break)
    const walked: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 5; i++) {
      const url = cursor ? `/api/ops/alerts?limit=1&cursor=${encodeURIComponent(cursor)}` : '/api/ops/alerts?limit=1';
      const page = await request(app).get(url).set('Authorization', operatorAuth);
      expect(page.status).toBe(200);
      const body = page.body as AlertList;
      walked.push(...body.items.map((a) => a.id));
      cursor = body.nextCursor;
      if (!cursor) break;
    }
    expect(walked).toEqual(['al-3', 'al-2', 'al-1']);
  });

  it('FR-34 rejects invalid query params with 400 VALIDATION_ERROR', async () => {
    for (const qs of [
      'status=BOGUS',
      'type=BOGUS',
      'limit=0',
      'limit=abc',
      'cursor=not-valid-base64',
    ]) {
      const res = await request(app)
        .get(`/api/ops/alerts?${qs}`)
        .set('Authorization', operatorAuth);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }
  });
});

// ============================================================================
// Concurrency (NFR-27 / uq_alert_open & lockRow)
// ============================================================================

describe('FR-33 & FR-34 concurrency', () => {
  it('FR-33 concurrent evaluateHub calls create exactly one OPEN alert without error', async () => {
    const now = new Date();
    await db.hub.update({
      where: { id: 'dorm' },
      data: { lastTelemetryAt: new Date(now.getTime() - STALLED_MS) },
    });

    await Promise.all([evaluateHub('dorm', now), evaluateHub('dorm', now)]);

    const rows = await db.alert.findMany({ where: { dedupeKey: 'STALLED:dorm' } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('OPEN');
  });

  it('FR-34 concurrent acknowledge/dismiss on same OPEN alert returns one 200, one 409, and one audit row', async () => {
    await db.alert.create({
      data: {
        id: 'al-race',
        type: 'LOW_BATTERY',
        hubId: 'dorm',
        resourceIds: [],
        metric: {},
        message: 'race',
        dedupeKey: 'LOW_BATTERY:dorm',
        status: 'OPEN',
      },
    });

    const [r1, r2] = await Promise.all([
      request(app)
        .post('/api/ops/alerts/al-race/acknowledge')
        .set('Authorization', operatorAuth)
        .send({ note: 'ack' }),
      request(app)
        .post('/api/ops/alerts/al-race/dismiss')
        .set('Authorization', operatorAuth)
        .send({ note: 'dismiss' }),
    ]);

    const statuses = [r1.status, r2.status].sort((a, b) => a - b);
    expect(statuses).toEqual([200, 409]);

    const audits = await db.auditLog.findMany({
      where: {
        entityIds: { has: 'al-race' },
        action: { in: ['ALERT_ACKNOWLEDGED', 'ALERT_DISMISSED'] },
      },
    });
    expect(audits).toHaveLength(1);
  });
});

// ============================================================================
// Roles & authentication (401 / 403 + SECURITY_DENIED)
// ============================================================================

describe('FR-31..FR-34 role and auth guards', () => {
  const routes: Array<{ method: 'get' | 'post'; path: string }> = [
    { method: 'get', path: '/api/ops/dashboard' },
    { method: 'get', path: '/api/ops/hubs/metro' },
    { method: 'get', path: '/api/ops/alerts' },
    { method: 'post', path: '/api/ops/alerts/al-1/acknowledge' },
    { method: 'post', path: '/api/ops/alerts/al-1/dismiss' },
  ];

  it('FR-31 returns 401 UNAUTHENTICATED without a token on all 5 monitoring routes', async () => {
    for (const r of routes) {
      const res = await request(app)[r.method](r.path);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHENTICATED');
    }
  });

  it('FR-31 returns 403 FORBIDDEN and writes SECURITY_DENIED audit row for a student on all 5 monitoring routes', async () => {
    for (const r of routes) {
      const beforeCount = await db.auditLog.count({ where: { action: 'SECURITY_DENIED' } });
      const res = await request(app)[r.method](r.path).set('Authorization', studentAuth);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
      const afterCount = await db.auditLog.count({ where: { action: 'SECURITY_DENIED' } });
      expect(afterCount).toBe(beforeCount + 1);
    }
  });
});

// ============================================================================
// Scheduler job & post-commit event wiring
// ============================================================================

describe('FR-33 & FR-35 monitoring job and event listeners', () => {
  it('FR-33 registerMonitoringJobs is idempotent and runJobOnce evaluates all Hubs', async () => {
    expect(() => registerMonitoringJobs()).not.toThrow();

    await runJobOnce(MONITORING_EVALUATE_JOB, new Date());

    // Fixture has service degraded (STALLED_FEED) and metro RV-M-003 at 19% (LOW_BATTERY)
    const stalledService = await db.alert.findFirst({
      where: { dedupeKey: 'STALLED:service', status: 'OPEN' },
    });
    expect(stalledService).not.toBeNull();

    const lowBatMetro = await db.alert.findFirst({
      where: { dedupeKey: 'LOW_BATTERY:metro', status: 'OPEN' },
    });
    expect(lowBatMetro).not.toBeNull();
    expect(lowBatMetro!.resourceIds).toEqual(['RV-M-003']);
  });

  it('FR-33 post-commit event triggers Hub evaluation asynchronously', async () => {
    await db.hub.update({
      where: { id: 'dorm' },
      data: { lastTelemetryAt: new Date(Date.now() - STALLED_MS - 5000) },
    });

    events.emit('TELEMETRY_INGESTED', { hubId: 'dorm' });

    const found = await waitForCondition(async () => {
      const a = await db.alert.findFirst({
        where: { dedupeKey: 'STALLED:dorm', status: 'OPEN' },
      });
      return a !== null;
    });
    expect(found).toBe(true);
  });

  it('FR-33 evaluateAllHubs evaluates all 5 Hubs cleanly', async () => {
    await evaluateAllHubs(new Date());
    const openAlerts = await db.alert.findMany({ where: { status: 'OPEN' } });
    expect(openAlerts.some((a) => a.dedupeKey === 'STALLED:service')).toBe(true);
    expect(openAlerts.some((a) => a.dedupeKey === 'NEAR_CAPACITY:metro:CHARGING:CAR')).toBe(true);
  });
});
