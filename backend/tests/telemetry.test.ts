// Telemetry tests (T-06: FR-30, FR-03, FR-36, NFR-24, NFR-25, D-02, D-09, D-17, D-22).

import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { config } from '../src/core/config';
import { db } from '../src/core/db';
import { events } from '../src/core/events';
import { runJobOnce } from '../src/core/scheduler';
import {
  consumeHubDemoDirectives,
  enqueueBatteryOverride,
  enqueueFault,
  resetDemoState,
} from '../src/telemetry/demoState';
import { buildPacket, type HubGeneratorState } from '../src/telemetry/generator';
import { ingest } from '../src/telemetry/ingestion';
import { listHubs } from '../src/modules/hubs/hubs.service';
import {
  registerTelemetryJobs,
  TELEMETRY_GENERATE_JOB,
} from '../src/telemetry/telemetry.jobs';
import { parsePacket } from '../src/telemetry/telemetry.validate';
import { createTestApp, loginAs, resetDb } from './helpers';

const app = createTestApp();
const TELEMETRY_KEY = config.TELEMETRY_KEY;

async function snapshotLiveState() {
  const [hubs, vehicles, privateEvs, spaces, points, requests] = await Promise.all([
    db.hub.findMany({ orderBy: { id: 'asc' } }),
    db.rentalVehicle.findMany({ orderBy: { id: 'asc' } }),
    db.privateEv.findMany({ orderBy: { id: 'asc' } }),
    db.parkingSpace.findMany({ orderBy: { id: 'asc' } }),
    db.chargingPoint.findMany({ orderBy: { id: 'asc' } }),
    db.chargingRequest.findMany({ orderBy: { id: 'asc' } }),
  ]);
  return { hubs, vehicles, privateEvs, spaces, points, requests };
}

describe('T-06 Telemetry: validation, ingestion, generator, demo endpoints', () => {
  beforeEach(async () => {
    resetDemoState();
    registerTelemetryJobs();
    await resetDb();
  });

  // ---------------------------------------------------------------------------
  // AC-1: FR-30 valid packet with newer timestamp -> 202
  // ---------------------------------------------------------------------------
  it('FR-30 AC-1 applies valid packet with newer timestamp (202), updates batteries, currentPct and lastTelemetryAt', async () => {
    const hubBefore = await db.hub.findUniqueOrThrow({ where: { id: 'metro' } });
    const newerTs = new Date(hubBefore.lastTelemetryAt!.getTime() + 10_000).toISOString();

    const res = await request(app)
      .post('/api/telemetry')
      .set('X-Telemetry-Key', TELEMETRY_KEY)
      .send({
        hubId: 'metro',
        timestamp: newerTs,
        source: 'SIMULATOR',
        vehicles: [
          { id: 'RV-M-001', batteryPct: 74.26 },
          { id: 'RV-M-004', batteryPct: 68.4 }, // has CHARGING request CR-M-001 (target 100)
        ],
        privateEvs: [
          { id: 'PEV-01', batteryPct: 72.1 }, // has CHARGING request CR-C-001 at metro (target 90)
        ],
      });

    expect(res.status).toBe(202);
    expect(res.body.accepted).toBe(true);
    expect(res.body.hubId).toBe('metro');
    expect(typeof res.body.appliedAt).toBe('string');

    const [hubAfter, rv1, rv4, pev1, crMoto, crCar] = await Promise.all([
      db.hub.findUniqueOrThrow({ where: { id: 'metro' } }),
      db.rentalVehicle.findUniqueOrThrow({ where: { id: 'RV-M-001' } }),
      db.rentalVehicle.findUniqueOrThrow({ where: { id: 'RV-M-004' } }),
      db.privateEv.findUniqueOrThrow({ where: { id: 'PEV-01' } }),
      db.chargingRequest.findUniqueOrThrow({ where: { id: 'CR-M-001' } }),
      db.chargingRequest.findUniqueOrThrow({ where: { id: 'CR-C-001' } }),
    ]);

    expect(hubAfter.lastTelemetryAt?.toISOString()).toBe(newerTs);
    expect(rv1.batteryPct).toBe(74.3); // rounded to 1 decimal
    expect(rv4.batteryPct).toBe(68.4);
    expect(pev1.batteryPct).toBe(72.1);
    expect(crMoto.currentPct).toBe(68.4);
    expect(crCar.currentPct).toBe(72.1);
  });

  // ---------------------------------------------------------------------------
  // AC-2: FR-30 / NFR-25 equal and older timestamps -> 409 STALE_PACKET
  // ---------------------------------------------------------------------------
  it('FR-30 NFR-25 AC-2 rejects equal and older timestamps with 409 STALE_PACKET, logs reject, leaves live rows unchanged', async () => {
    const before = await snapshotLiveState();
    const metroLast = before.hubs.find((h) => h.id === 'metro')!.lastTelemetryAt!;
    const equalTs = metroLast.toISOString();
    const olderTs = new Date(metroLast.getTime() - 5_000).toISOString();

    const resEqual = await request(app)
      .post('/api/telemetry')
      .set('X-Telemetry-Key', TELEMETRY_KEY)
      .send({
        hubId: 'metro',
        timestamp: equalTs,
        source: 'MOCK_SENSOR',
        vehicles: [{ id: 'RV-M-001', batteryPct: 12 }],
      });

    expect(resEqual.status).toBe(409);
    expect(resEqual.body.error.code).toBe('STALE_PACKET');

    const resOlder = await request(app)
      .post('/api/telemetry')
      .set('X-Telemetry-Key', TELEMETRY_KEY)
      .send({
        hubId: 'metro',
        timestamp: olderTs,
        source: 'MOCK_SENSOR',
        vehicles: [{ id: 'RV-M-001', batteryPct: 11 }],
      });

    expect(resOlder.status).toBe(409);
    expect(resOlder.body.error.code).toBe('STALE_PACKET');

    const after = await snapshotLiveState();
    expect(after).toEqual(before);

    const rejects = await db.telemetryReject.findMany({ orderBy: { receivedAt: 'asc' } });
    expect(rejects).toHaveLength(2);
    expect(rejects[0]?.reason).toBe('STALE_PACKET');
    expect(rejects[0]?.hubId).toBe('metro');
    expect(rejects[1]?.reason).toBe('STALE_PACKET');
  });

  // ---------------------------------------------------------------------------
  // AC-3: NFR-25 malformed packets and unknown/foreign ids -> 400 + logged + no state change
  // ---------------------------------------------------------------------------
  it('NFR-25 AC-3 rejects malformed packets (missing hubId, bad timestamp, battery 101/-1, bad source, duplicate id) with 400 and details.field', async () => {
    const before = await snapshotLiveState();
    const futureTs = new Date(Date.now() + 30_000).toISOString();

    const malformedCases = [
      {
        payload: { timestamp: futureTs, source: 'SIMULATOR' },
        expectedField: 'hubId',
      },
      {
        payload: { hubId: 'metro', timestamp: 'not-a-date', source: 'SIMULATOR' },
        expectedField: 'timestamp',
      },
      {
        payload: {
          hubId: 'metro',
          timestamp: futureTs,
          source: 'SIMULATOR',
          vehicles: [{ id: 'RV-M-001', batteryPct: 101 }],
        },
        expectedField: 'vehicles[0].batteryPct',
      },
      {
        payload: {
          hubId: 'metro',
          timestamp: futureTs,
          source: 'SIMULATOR',
          vehicles: [{ id: 'RV-M-001', batteryPct: -1 }],
        },
        expectedField: 'vehicles[0].batteryPct',
      },
      {
        payload: { hubId: 'metro', timestamp: futureTs, source: 'BAD_SOURCE' },
        expectedField: 'source',
      },
      {
        payload: {
          hubId: 'metro',
          timestamp: futureTs,
          source: 'SIMULATOR',
          vehicles: [
            { id: 'RV-M-001', batteryPct: 50 },
            { id: 'RV-M-001', batteryPct: 55 },
          ],
        },
        expectedField: 'vehicles',
      },
    ];

    for (const c of malformedCases) {
      const res = await request(app)
        .post('/api/telemetry')
        .set('X-Telemetry-Key', TELEMETRY_KEY)
        .send(c.payload);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.details?.field).toBe(c.expectedField);
    }

    const after = await snapshotLiveState();
    expect(after).toEqual(before);

    const rejectCount = await db.telemetryReject.count();
    expect(rejectCount).toBe(malformedCases.length);
  });

  it('NFR-25 AC-3 rejects unknown Hub, unknown resource, and resource from another Hub with 400 and logs each reject without changing state', async () => {
    const before = await snapshotLiveState();
    const futureTs = new Date(Date.now() + 30_000).toISOString();

    const cases = [
      {
        payload: { hubId: 'no-such-hub', timestamp: futureTs, source: 'SENSOR' },
        expectedField: 'hubId',
      },
      {
        payload: {
          hubId: 'metro',
          timestamp: futureTs,
          source: 'SENSOR',
          vehicles: [{ id: 'RV-NO-SUCH', batteryPct: 50 }],
        },
        expectedField: 'vehicles.RV-NO-SUCH',
      },
      {
        // RV-D-001 belongs to dorm, not metro
        payload: {
          hubId: 'metro',
          timestamp: futureTs,
          source: 'SENSOR',
          vehicles: [{ id: 'RV-D-001', batteryPct: 50 }],
        },
        expectedField: 'vehicles.RV-D-001',
      },
      {
        // DOR-P-M-01 belongs to dorm, not metro
        payload: {
          hubId: 'metro',
          timestamp: futureTs,
          source: 'SENSOR',
          parkingSpaces: [{ id: 'DOR-P-M-01', faultCode: 'ERR_SENSOR' }],
        },
        expectedField: 'parkingSpaces.DOR-P-M-01',
      },
      {
        // DOR-CP-M-01 belongs to dorm, not metro
        payload: {
          hubId: 'metro',
          timestamp: futureTs,
          source: 'SENSOR',
          chargingPoints: [{ id: 'DOR-CP-M-01', faultCode: 'ERR_CP' }],
        },
        expectedField: 'chargingPoints.DOR-CP-M-01',
      },
      {
        // PEV-02 only has a SCHEDULED request at metro (not CHARGING or ACTIVE parking)
        payload: {
          hubId: 'metro',
          timestamp: futureTs,
          source: 'SENSOR',
          privateEvs: [{ id: 'PEV-02', batteryPct: 80 }],
        },
        expectedField: 'privateEvs.PEV-02',
      },
    ];

    for (const c of cases) {
      const res = await request(app)
        .post('/api/telemetry')
        .set('X-Telemetry-Key', TELEMETRY_KEY)
        .send(c.payload);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.details?.field).toBe(c.expectedField);
    }

    const after = await snapshotLiveState();
    expect(after).toEqual(before);

    const rejects = await db.telemetryReject.findMany();
    expect(rejects).toHaveLength(cases.length);
  });

  // ---------------------------------------------------------------------------
  // AC-4: Missing / wrong X-Telemetry-Key -> 401 + logged
  // ---------------------------------------------------------------------------
  it('T-06 AC-4 rejects missing or wrong X-Telemetry-Key with 401 UNAUTHENTICATED and logs BAD_KEY reject', async () => {
    const futureTs = new Date(Date.now() + 30_000).toISOString();

    const resMissing = await request(app).post('/api/telemetry').send({
      hubId: 'metro',
      timestamp: futureTs,
      source: 'SENSOR',
    });
    expect(resMissing.status).toBe(401);
    expect(resMissing.body.error.code).toBe('UNAUTHENTICATED');

    const resWrong = await request(app)
      .post('/api/telemetry')
      .set('X-Telemetry-Key', 'wrong-key-value')
      .send({
        hubId: 'metro',
        timestamp: futureTs,
        source: 'SENSOR',
      });
    expect(resWrong.status).toBe(401);
    expect(resWrong.body.error.code).toBe('UNAUTHENTICATED');

    const rejects = await db.telemetryReject.findMany();
    expect(rejects).toHaveLength(2);
    expect(rejects.every((r) => r.reason === 'BAD_KEY' && r.hubId === 'metro')).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // AC-5: Concurrency: two packets for the same Hub with same timestamp -> one 202, one 409
  // ---------------------------------------------------------------------------
  it('FR-30 AC-5 concurrent packets for the same Hub with the same timestamp result in one 202 and one 409', async () => {
    const futureTs = new Date(Date.now() + 30_000).toISOString();
    const packetA = {
      hubId: 'metro',
      timestamp: futureTs,
      source: 'SIMULATOR' as const,
      vehicles: [{ id: 'RV-M-001', batteryPct: 65 }],
    };
    const packetB = {
      hubId: 'metro',
      timestamp: futureTs,
      source: 'SIMULATOR' as const,
      vehicles: [{ id: 'RV-M-001', batteryPct: 66 }],
    };

    const [resA, resB] = await Promise.all([
      request(app).post('/api/telemetry').set('X-Telemetry-Key', TELEMETRY_KEY).send(packetA),
      request(app).post('/api/telemetry').set('X-Telemetry-Key', TELEMETRY_KEY).send(packetB),
    ]);

    const statuses = [resA.status, resB.status].sort();
    expect(statuses).toEqual([202, 409]);

    const rejects = await db.telemetryReject.findMany({ where: { reason: 'STALE_PACKET' } });
    expect(rejects).toHaveLength(1);
  });

  // ---------------------------------------------------------------------------
  // AC-6: D-17 no status column changed even when faultCodes and <20% battery arrive
  // ---------------------------------------------------------------------------
  it('D-17 AC-6 does not change any status column on vehicles, spaces, points or requests and returns faults in IngestResult', async () => {
    const before = await snapshotLiveState();
    const futureTs = new Date(Date.now() + 30_000).toISOString();

    const result = await ingest({
      hubId: 'metro',
      timestamp: futureTs,
      source: 'SIMULATOR',
      vehicles: [
        // Drop AVAILABLE vehicle to 5% and include faultCode: status must stay AVAILABLE (D-17)
        { id: 'RV-M-001', batteryPct: 5, faultCode: 'BAT_OVERHEAT' },
      ],
      parkingSpaces: [{ id: 'MET-P-M-01', faultCode: 'SENSOR_BLOCKED' }],
      chargingPoints: [{ id: 'MET-CP-M-01', faultCode: 'RELAY_TRIP' }],
    });

    expect(result.faults).toEqual([
      { resourceType: 'RENTAL_VEHICLE', resourceId: 'RV-M-001', faultCode: 'BAT_OVERHEAT' },
      { resourceType: 'PARKING_SPACE', resourceId: 'MET-P-M-01', faultCode: 'SENSOR_BLOCKED' },
      { resourceType: 'CHARGING_POINT', resourceId: 'MET-CP-M-01', faultCode: 'RELAY_TRIP' },
    ]);

    const after = await snapshotLiveState();
    expect(after.vehicles.map((v) => ({ id: v.id, status: v.status }))).toEqual(
      before.vehicles.map((v) => ({ id: v.id, status: v.status })),
    );
    expect(after.spaces.map((s) => ({ id: s.id, status: s.status }))).toEqual(
      before.spaces.map((s) => ({ id: s.id, status: s.status })),
    );
    expect(after.points.map((p) => ({ id: p.id, status: p.status }))).toEqual(
      before.points.map((p) => ({ id: p.id, status: p.status })),
    );
    expect(after.requests.map((r) => ({ id: r.id, status: r.status }))).toEqual(
      before.requests.map((r) => ({ id: r.id, status: r.status })),
    );
  });

  // ---------------------------------------------------------------------------
  // AC-7: Charging currentPct capped at targetPct; targetsReached populated; QUEUED/SCHEDULED untouched
  // ---------------------------------------------------------------------------
  it('D-09 AC-7 caps CHARGING request currentPct at targetPct, records targetsReached, and leaves QUEUED/SCHEDULED requests untouched', async () => {
    const futureTs = new Date(Date.now() + 30_000).toISOString();

    // CR-M-001 (RV-M-004, CHARGING, target 100), CR-M-002 (RV-M-005, QUEUED, current 60),
    // CR-C-001 (PEV-01, CHARGING, target 90)
    const result = await ingest({
      hubId: 'metro',
      timestamp: futureTs,
      source: 'SIMULATOR',
      vehicles: [
        { id: 'RV-M-004', batteryPct: 100 },
        { id: 'RV-M-005', batteryPct: 88 }, // QUEUED request must not update currentPct
      ],
      privateEvs: [
        { id: 'PEV-01', batteryPct: 95 }, // exceeds target 90 -> currentPct capped at 90
      ],
    });

    expect(result.targetsReached.sort()).toEqual(['CR-C-001', 'CR-M-001']);

    const [crM1, crM2, crC1] = await Promise.all([
      db.chargingRequest.findUniqueOrThrow({ where: { id: 'CR-M-001' } }),
      db.chargingRequest.findUniqueOrThrow({ where: { id: 'CR-M-002' } }),
      db.chargingRequest.findUniqueOrThrow({ where: { id: 'CR-C-001' } }),
    ]);

    expect(crM1.currentPct).toBe(100);
    expect(crM1.status).toBe('CHARGING'); // D-17: status unchanged
    expect(crM2.currentPct).toBe(60); // QUEUED untouched
    expect(crC1.currentPct).toBe(90); // capped at targetPct=90
  });

  // ---------------------------------------------------------------------------
  // AC-8: Pure generator buildPacket tests
  // ---------------------------------------------------------------------------
  it('D-09 AC-8 buildPacket computes IN_USE drain, charging gain, caps/floors, consumes overrides and faults once, and sends empty heartbeat when unchanged', () => {
    const now = new Date('2026-12-01T10:00:00.000Z');
    const state: HubGeneratorState = {
      hubId: 'metro',
      vehicles: [
        { id: 'RV-IN-USE', status: 'IN_USE', batteryPct: 50, chargingTargetPct: null },
        { id: 'RV-EMPTY', status: 'IN_USE', batteryPct: 0, chargingTargetPct: null },
        { id: 'RV-CHG', status: 'AVAILABLE', batteryPct: 89.99, chargingTargetPct: 90 },
        { id: 'RV-IDLE', status: 'AVAILABLE', batteryPct: 70, chargingTargetPct: null },
        { id: 'RV-OVR', status: 'AVAILABLE', batteryPct: 75, chargingTargetPct: null },
      ],
      privateEvs: [{ id: 'PEV-CAR', vehicleClass: 'CAR', batteryPct: 80, chargingTargetPct: 80 }],
      parkingSpaces: [{ id: 'SP-1' }],
      chargingPoints: [{ id: 'CP-1' }],
    };

    enqueueBatteryOverride({ vehicleId: 'RV-OVR', hubId: 'metro', batteryPct: 14.5 });
    enqueueFault({
      resourceType: 'CHARGING_POINT',
      resourceId: 'CP-1',
      hubId: 'metro',
      faultCode: 'CP_OVERCURRENT',
    });

    const demo1 = consumeHubDemoDirectives('metro');
    const pkt1 = buildPacket(state, demo1, now, () => 0);

    expect(pkt1.hubId).toBe('metro');
    expect(pkt1.source).toBe('SIMULATOR');
    expect(pkt1.timestamp).toBe(now.toISOString());
    // RV-IN-USE drains by 0.3 * 1 * 5/60 = 0.025 -> 49.975; RV-EMPTY stays at floor 0 (omitted)
    expect(pkt1.vehicles).toContainEqual({ id: 'RV-IN-USE', batteryPct: 49.975 });
    expect(pkt1.vehicles?.find((v) => v.id === 'RV-EMPTY')).toBeUndefined();
    // RV-CHG gains + cap 90; RV-OVR overridden to 14.5
    expect(pkt1.vehicles).toContainEqual({ id: 'RV-CHG', batteryPct: 90 });
    expect(pkt1.vehicles).toContainEqual({ id: 'RV-OVR', batteryPct: 14.5 });
    expect(pkt1.chargingPoints).toEqual([{ id: 'CP-1', faultCode: 'CP_OVERCURRENT' }]);
    expect(pkt1.parkingSpaces).toEqual([]);

    // Next tick with idle state and no directives -> empty heartbeat packet
    const idleState: HubGeneratorState = {
      hubId: 'metro',
      vehicles: [{ id: 'RV-IDLE', status: 'AVAILABLE', batteryPct: 70, chargingTargetPct: null }],
      privateEvs: [],
      parkingSpaces: [{ id: 'SP-1' }],
      chargingPoints: [{ id: 'CP-1' }],
    };
    const demo2 = consumeHubDemoDirectives('metro');
    const pkt2 = buildPacket(idleState, demo2, now, () => 0);
    expect(pkt2.vehicles).toEqual([]);
    expect(pkt2.privateEvs).toEqual([]);
    expect(pkt2.parkingSpaces).toEqual([]);
    expect(pkt2.chargingPoints).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // AC-9: runJobOnce('telemetry.generate') advances non-stalled Hubs, skips stalled Hub
  // ---------------------------------------------------------------------------
  it('D-02 AC-9 telemetry.generate job advances non-stalled Hubs and skips a stalled Hub so it becomes degraded after 15 s', async () => {
    const baseNow = new Date(Date.now() + 10_000);

    // Stall dorm for 120 seconds via demo endpoint
    const stallRes = await request(app)
      .post('/api/ops/telemetry/demo/stall')
      .set('Authorization', loginAs('operator1'))
      .send({ hubId: 'dorm', seconds: 120 });
    expect(stallRes.status).toBe(200);

    const dormBefore = await db.hub.findUniqueOrThrow({ where: { id: 'dorm' } });

    // Tick at baseNow + 20s (> 15s after dorm's initial lastTelemetryAt)
    const tickTime = new Date(baseNow.getTime() + 20_000);
    await runJobOnce(TELEMETRY_GENERATE_JOB, tickTime);

    const hubsAfter = await db.hub.findMany({ orderBy: { id: 'asc' } });
    for (const h of hubsAfter) {
      if (h.id === 'dorm') {
        expect(h.lastTelemetryAt?.toISOString()).toBe(dormBefore.lastTelemetryAt?.toISOString());
      } else {
        expect(h.lastTelemetryAt?.toISOString()).toBe(tickTime.toISOString());
      }
    }

    // Verify dorm is degraded in listHubs(tickTime) while non-stalled Hubs are fresh
    const summaries = await listHubs(tickTime);
    const dormSummary = summaries.find((h) => h.id === 'dorm')!;
    expect(dormSummary.degraded).toBe(true);
    for (const s of summaries.filter((h) => h.id !== 'dorm')) {
      expect(s.degraded).toBe(false);
    }

    // Verify one Hub failing inside telemetry.generate does not stop the others
    const futureCollision = new Date(tickTime.getTime() + 60_000);
    await db.hub.update({
      where: { id: 'campus-a' },
      data: { lastTelemetryAt: futureCollision },
    });
    const secondTick = new Date(tickTime.getTime() + 5_000);
    await runJobOnce(TELEMETRY_GENERATE_JOB, secondTick);

    const metroAfterSecond = await db.hub.findUniqueOrThrow({ where: { id: 'metro' } });
    expect(metroAfterSecond.lastTelemetryAt?.toISOString()).toBe(secondTick.toISOString());
  });

  // ---------------------------------------------------------------------------
  // AC-10: Demo endpoints auth, validation (stall 1/600 vs 0/601), 404s, audit rows
  // ---------------------------------------------------------------------------
  it('T-06 AC-10 enforces OPERATOR role (403 for STUDENT), validates boundaries (stall 1/600 pass, 0/601 fail), returns 404 for unknown ids, and writes audit rows', async () => {
    // STUDENT -> 403
    const stuRes = await request(app)
      .post('/api/ops/telemetry/demo/stall')
      .set('Authorization', loginAs('student1'))
      .send({ hubId: 'metro', seconds: 30 });
    expect(stuRes.status).toBe(403);

    // Stall boundary: 0 and 601 rejected (400), 1 and 600 accepted (200)
    for (const badSec of [0, 601]) {
      const r = await request(app)
        .post('/api/ops/telemetry/demo/stall')
        .set('Authorization', loginAs('operator1'))
        .send({ hubId: 'metro', seconds: badSec });
      expect(r.status).toBe(400);
      expect(r.body.error.details?.field).toBe('seconds');
    }

    for (const okSec of [1, 600]) {
      const r = await request(app)
        .post('/api/ops/telemetry/demo/stall')
        .set('Authorization', loginAs('operator1'))
        .send({ hubId: 'metro', seconds: okSec });
      expect(r.status).toBe(200);
      expect(r.body.hubId).toBe('metro');
      expect(typeof r.body.stalledUntil).toBe('string');
    }

    // Unknown Hub -> 404
    const unknownHub = await request(app)
      .post('/api/ops/telemetry/demo/stall')
      .set('Authorization', loginAs('operator1'))
      .send({ hubId: 'no-hub', seconds: 30 });
    expect(unknownHub.status).toBe(404);

    // Fault demo: valid -> 200, unknown -> 404, bad input -> 400
    const faultOk = await request(app)
      .post('/api/ops/telemetry/demo/fault')
      .set('Authorization', loginAs('operator1'))
      .send({ resourceType: 'RENTAL_VEHICLE', resourceId: 'RV-M-001', faultCode: 'ERR_BRAKE' });
    expect(faultOk.status).toBe(200);
    expect(faultOk.body).toEqual({ queued: true });

    const fault404 = await request(app)
      .post('/api/ops/telemetry/demo/fault')
      .set('Authorization', loginAs('operator1'))
      .send({ resourceType: 'PARKING_SPACE', resourceId: 'NO-SPACE', faultCode: 'ERR' });
    expect(fault404.status).toBe(404);

    const fault400 = await request(app)
      .post('/api/ops/telemetry/demo/fault')
      .set('Authorization', loginAs('operator1'))
      .send({ resourceType: 'RENTAL_VEHICLE', resourceId: 'RV-M-001', faultCode: '' });
    expect(fault400.status).toBe(400);

    // Battery demo: valid -> 200, unknown -> 404, out of range -> 400
    const batOk = await request(app)
      .post('/api/ops/telemetry/demo/battery')
      .set('Authorization', loginAs('operator1'))
      .send({ vehicleId: 'RV-M-001', batteryPct: 15 });
    expect(batOk.status).toBe(200);
    expect(batOk.body).toEqual({ queued: true });

    const bat404 = await request(app)
      .post('/api/ops/telemetry/demo/battery')
      .set('Authorization', loginAs('operator1'))
      .send({ vehicleId: 'NO-VEH', batteryPct: 15 });
    expect(bat404.status).toBe(404);

    const bat400 = await request(app)
      .post('/api/ops/telemetry/demo/battery')
      .set('Authorization', loginAs('operator1'))
      .send({ vehicleId: 'RV-M-001', batteryPct: 105 });
    expect(bat400.status).toBe(400);

    // Audit rows written for stall, fault, battery
    const audits = await db.auditLog.findMany({
      where: {
        action: {
          in: ['TELEMETRY_DEMO_STALL', 'TELEMETRY_DEMO_FAULT', 'TELEMETRY_DEMO_BATTERY'],
        },
      },
    });
    expect(audits.map((a) => a.action)).toEqual(
      expect.arrayContaining([
        'TELEMETRY_DEMO_STALL',
        'TELEMETRY_DEMO_FAULT',
        'TELEMETRY_DEMO_BATTERY',
      ]),
    );
  });

  // ---------------------------------------------------------------------------
  // AC-11: GET /api/ops/telemetry/rejects newest first, respects limit
  // ---------------------------------------------------------------------------
  it('NFR-25 AC-11 lists telemetry rejects newest first and respects the limit parameter', async () => {
    await request(app)
      .post('/api/telemetry')
      .set('X-Telemetry-Key', TELEMETRY_KEY)
      .send({ hubId: 'metro', timestamp: 'bad-1', source: 'SIMULATOR' });
    await request(app)
      .post('/api/telemetry')
      .set('X-Telemetry-Key', 'bad-key')
      .send({ hubId: 'dorm', timestamp: new Date().toISOString(), source: 'SIMULATOR' });

    const listAll = await request(app)
      .get('/api/ops/telemetry/rejects')
      .set('Authorization', loginAs('operator1'));
    expect(listAll.status).toBe(200);
    expect(listAll.body.items).toHaveLength(2);
    expect(listAll.body.items[0].hubId).toBe('dorm');
    expect(listAll.body.items[0].reason).toBe('BAD_KEY');
    expect(listAll.body.items[1].hubId).toBe('metro');

    const listOne = await request(app)
      .get('/api/ops/telemetry/rejects?limit=1')
      .set('Authorization', loginAs('operator1'));
    expect(listOne.status).toBe(200);
    expect(listOne.body.items).toHaveLength(1);
    expect(listOne.body.items[0].hubId).toBe('dorm');
  });

  // ---------------------------------------------------------------------------
  // AC-12: TELEMETRY_INGESTED emitted only after commit and only for applied packets
  // ---------------------------------------------------------------------------
  it('T-06 AC-12 emits TELEMETRY_INGESTED after commit for applied packets and never on rejected packets', async () => {
    const emitted: string[] = [];
    events.on('TELEMETRY_INGESTED', ({ hubId }) => {
      emitted.push(hubId);
    });

    // Rejected packet -> must NOT emit
    await request(app)
      .post('/api/telemetry')
      .set('X-Telemetry-Key', TELEMETRY_KEY)
      .send({ hubId: 'metro', timestamp: 'invalid-ts', source: 'SIMULATOR' });
    expect(emitted).toEqual([]);

    // Applied packet -> emits once after commit
    const futureTs = new Date(Date.now() + 30_000).toISOString();
    const okRes = await request(app)
      .post('/api/telemetry')
      .set('X-Telemetry-Key', TELEMETRY_KEY)
      .send({ hubId: 'metro', timestamp: futureTs, source: 'SIMULATOR' });
    expect(okRes.status).toBe(202);
    expect(emitted).toEqual(['metro']);
  });

  // ---------------------------------------------------------------------------
  // Extra pure unit tests for parsePacket edge cases
  // ---------------------------------------------------------------------------
  it('NFR-25 parsePacket rejects non-object body and malformed sub-items', () => {
    expect(parsePacket(null).ok).toBe(false);
    expect(parsePacket('not-json').ok).toBe(false);
    expect(
      parsePacket({
        hubId: 'metro',
        timestamp: '2026-12-01T10:00:00.000Z',
        source: 'SIMULATOR',
        parkingSpaces: [{ id: 'SP-1' }, { id: 'SP-1' }],
      }).ok,
    ).toBe(false);
  });
});
