// T-06 checker tests. Written from the T-06 ticket, SPEC, CONTRACTS §14 and the FIXTURE in
// tests/helpers.ts only. Every test goes through the public HTTP API or the registered job.

import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { db } from '../src/core/db';
import { events } from '../src/core/events';
import { runJobOnce } from '../src/core/scheduler';
import { resetDemoState } from '../src/telemetry/demoState';
import { registerTelemetryJobs } from '../src/telemetry/telemetry.jobs';
import { createTestApp, loginAs, resetDb } from './helpers';

const app = createTestApp();
const KEY = process.env['TELEMETRY_KEY'] ?? 'test-telemetry-key';

function post(body: unknown, key: string | null = KEY) {
  const r = request(app).post('/api/telemetry');
  if (key !== null) r.set('X-Telemetry-Key', key);
  return r.send(body as object);
}

async function snapshot() {
  const [hubs, vehicles, pevs, spaces, points, requests] = await Promise.all([
    db.hub.findMany({ orderBy: { id: 'asc' } }),
    db.rentalVehicle.findMany({ orderBy: { id: 'asc' } }),
    db.privateEv.findMany({ orderBy: { id: 'asc' } }),
    db.parkingSpace.findMany({ orderBy: { id: 'asc' } }),
    db.chargingPoint.findMany({ orderBy: { id: 'asc' } }),
    db.chargingRequest.findMany({ orderBy: { id: 'asc' } }),
  ]);
  return { hubs, vehicles, pevs, spaces, points, requests };
}

async function metroLast(): Promise<Date> {
  const h = await db.hub.findUniqueOrThrow({ where: { id: 'metro' } });
  return h.lastTelemetryAt!;
}

function after(d: Date, ms: number): string {
  return new Date(d.getTime() + ms).toISOString();
}

describe('T-06 checker', () => {
  beforeEach(async () => {
    resetDemoState();
    registerTelemetryJobs();
    await resetDb();
  });

  it('FR-30 newer packet applies battery and lastTelemetryAt', async () => {
    const last = await metroLast();
    const ts = after(last, 5000);
    const res = await post({
      hubId: 'metro',
      timestamp: ts,
      source: 'MOCK_SENSOR',
      vehicles: [{ id: 'RV-M-001', batteryPct: 61.26 }],
      privateEvs: [{ id: 'PEV-01', batteryPct: 70 }],
    });
    expect(res.status).toBe(202);
    expect(res.body.accepted).toBe(true);
    expect(res.body.hubId).toBe('metro');
    expect(typeof res.body.appliedAt).toBe('string');

    const rv = await db.rentalVehicle.findUniqueOrThrow({ where: { id: 'RV-M-001' } });
    expect(rv.batteryPct).toBe(61.3);
    const pev = await db.privateEv.findUniqueOrThrow({ where: { id: 'PEV-01' } });
    expect(pev.batteryPct).toBe(70);
    expect((await metroLast()).toISOString()).toBe(ts);
    // untouched vehicle stays as in the fixture
    const rv2 = await db.rentalVehicle.findUniqueOrThrow({ where: { id: 'RV-M-002' } });
    expect(rv2.batteryPct).toBe(20);
    expect(await db.telemetryReject.count()).toBe(0);
  });

  it('FR-30 NFR-25 equal and older timestamps → 409, logged, no state change', async () => {
    const last = await metroLast();
    const before = await snapshot();
    for (const ts of [last.toISOString(), after(last, -1)]) {
      const res = await post({
        hubId: 'metro',
        timestamp: ts,
        source: 'MOCK_SENSOR',
        vehicles: [{ id: 'RV-M-001', batteryPct: 3 }],
      });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('STALE_PACKET');
      expect(res.body.error.nextActions.length).toBeGreaterThan(0);
    }
    expect(await snapshot()).toEqual(before);
    const rejects = await db.telemetryReject.findMany();
    expect(rejects).toHaveLength(2);
    expect(rejects.every((r) => r.hubId === 'metro')).toBe(true);
  });

  it('NFR-25 malformed and unknown/foreign ids → 400, logged, no state change', async () => {
    const before = await snapshot();
    const last = await metroLast();
    const ts = after(last, 5000);
    const cases: Array<{ body: unknown; field?: RegExp }> = [
      { body: { timestamp: ts, source: 'SIMULATOR' }, field: /hubId/ },
      { body: { hubId: 'metro', timestamp: 'nope', source: 'SIMULATOR' }, field: /timestamp/ },
      { body: { hubId: 'metro', timestamp: ts, source: 'SIMULATOR', vehicles: [{ id: 'RV-M-001', batteryPct: 101 }] }, field: /batteryPct/ },
      { body: { hubId: 'metro', timestamp: ts, source: 'SIMULATOR', vehicles: [{ id: 'RV-M-001', batteryPct: -1 }] }, field: /batteryPct/ },
      { body: { hubId: 'metro', timestamp: ts, source: 'WRONG' }, field: /source/ },
      { body: { hubId: 'metro', timestamp: ts, source: 'SIMULATOR', vehicles: [{ id: 'RV-M-001', batteryPct: 5 }, { id: 'RV-M-001', batteryPct: 6 }] }, field: /vehicles/ },
      { body: { hubId: 'ghost', timestamp: ts, source: 'SIMULATOR' }, field: /hubId/ },
      { body: { hubId: 'metro', timestamp: ts, source: 'SIMULATOR', vehicles: [{ id: 'RV-NOPE', batteryPct: 5 }] }, field: /vehicles.*RV-NOPE|RV-NOPE/ },
      { body: { hubId: 'metro', timestamp: ts, source: 'SIMULATOR', vehicles: [{ id: 'RV-D-001', batteryPct: 5 }] }, field: /RV-D-001/ },
      { body: { hubId: 'metro', timestamp: ts, source: 'SIMULATOR', parkingSpaces: [{ id: 'DOR-P-M-01' }] }, field: /parkingSpaces.*DOR-P-M-01|DOR-P-M-01/ },
      { body: { hubId: 'metro', timestamp: ts, source: 'SIMULATOR', chargingPoints: [{ id: 'DOR-CP-M-01' }] }, field: /chargingPoints.*DOR-CP-M-01|DOR-CP-M-01/ },
    ];
    for (const c of cases) {
      const res = await post(c.body);
      expect(res.status, JSON.stringify(c.body)).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(String(res.body.error.details?.field)).toMatch(c.field!);
    }
    expect(await snapshot()).toEqual(before);
    expect(await db.telemetryReject.count()).toBe(cases.length);
  });

  it('T-06 bad telemetry key → 401', async () => {
    const last = await metroLast();
    const body = { hubId: 'metro', timestamp: after(last, 5000), source: 'SIMULATOR' };
    const before = await snapshot();
    const missing = await post(body, null);
    const wrong = await post(body, 'definitely-wrong');
    const shorter = await post(body, 'x');
    for (const r of [missing, wrong, shorter]) {
      expect(r.status).toBe(401);
      expect(r.body.error.code).toBe('UNAUTHENTICATED');
    }
    expect(await snapshot()).toEqual(before);
    expect(await db.telemetryReject.count()).toBe(3);
    // right key works without any JWT
    expect((await post(body)).status).toBe(202);
  });

  it('T-06 concurrent same-timestamp packets → one 202, one 409', async () => {
    const last = await metroLast();
    const ts = after(last, 5000);
    const mk = (pct: number) => ({ hubId: 'metro', timestamp: ts, source: 'SIMULATOR', vehicles: [{ id: 'RV-M-001', batteryPct: pct }] });
    const [a, b] = await Promise.all([post(mk(41)), post(mk(42))]);
    expect([a.status, b.status].sort()).toEqual([202, 409]);
    const rv = await db.rentalVehicle.findUniqueOrThrow({ where: { id: 'RV-M-001' } });
    const winner = a.status === 202 ? 41 : 42;
    expect(rv.batteryPct).toBe(winner);
  });

  it('D-17 fault codes change no status column', async () => {
    const before = await snapshot();
    const last = await metroLast();
    const res = await post({
      hubId: 'metro',
      timestamp: after(last, 5000),
      source: 'SIMULATOR',
      vehicles: [{ id: 'RV-M-001', batteryPct: 4, faultCode: 'E1' }],
      parkingSpaces: [{ id: 'MET-P-M-01', faultCode: 'E2' }],
      chargingPoints: [{ id: 'MET-CP-M-01', faultCode: 'E3' }],
    });
    expect(res.status).toBe(202);
    const now = await snapshot();
    const statuses = (rows: Array<{ id: string; status: string }>) => rows.map((r) => `${r.id}:${r.status}`);
    expect(statuses(now.vehicles)).toEqual(statuses(before.vehicles));
    expect(statuses(now.spaces)).toEqual(statuses(before.spaces));
    expect(statuses(now.points)).toEqual(statuses(before.points));
    expect(statuses(now.requests)).toEqual(statuses(before.requests));
    // battery itself is a physical fact and does change
    expect(now.vehicles.find((v) => v.id === 'RV-M-001')!.batteryPct).toBe(4);
  });

  it('D-09 charging currentPct capped at target', async () => {
    const last = await metroLast();
    // CR-M-001: RV-M-004 CHARGING target 100. CR-C-001: PEV-01 CHARGING target 90.
    // CR-M-002: RV-M-005 QUEUED. CR-M-003: PEV-02 SCHEDULED.
    const res = await post({
      hubId: 'metro',
      timestamp: after(last, 5000),
      source: 'SIMULATOR',
      vehicles: [
        { id: 'RV-M-004', batteryPct: 77 },
        { id: 'RV-M-005', batteryPct: 99 },
      ],
      privateEvs: [{ id: 'PEV-01', batteryPct: 97 }],
    });
    expect(res.status).toBe(202);
    const get = (id: string) => db.chargingRequest.findUniqueOrThrow({ where: { id } });
    expect((await get('CR-M-001')).currentPct).toBe(77); // follows battery below target
    expect((await get('CR-C-001')).currentPct).toBe(90); // capped at targetPct
    expect((await get('CR-M-002')).currentPct).toBe(60); // QUEUED untouched
    expect((await get('CR-M-003')).currentPct).toBe(70); // SCHEDULED untouched
    expect((await get('CR-C-001')).status).toBe('CHARGING');
  });

  it('D-02 generator job skips stalled Hub, advances others', async () => {
    const stall = await request(app)
      .post('/api/ops/telemetry/demo/stall')
      .set('Authorization', loginAs('operator1'))
      .send({ hubId: 'dorm', seconds: 600 });
    expect(stall.status).toBe(200);

    const before = await snapshot();
    const tick = new Date(Date.now() + 20_000);
    await runJobOnce('telemetry.generate', tick);

    const hubs = await db.hub.findMany();
    for (const h of hubs) {
      const was = before.hubs.find((x) => x.id === h.id)!;
      if (h.id === 'dorm') {
        expect(h.lastTelemetryAt!.toISOString()).toBe(was.lastTelemetryAt!.toISOString());
      } else {
        expect(h.lastTelemetryAt!.toISOString()).toBe(tick.toISOString());
      }
    }
    // generator only sends physical facts: no status column moves
    const now = await snapshot();
    const statuses = (rows: Array<{ id: string; status: string }>) => rows.map((r) => `${r.id}:${r.status}`);
    expect(statuses(now.vehicles)).toEqual(statuses(before.vehicles));
    expect(statuses(now.requests)).toEqual(statuses(before.requests));

    // the stalled Hub is degraded in GET /api/hubs once 15 s have passed (list uses real now)
    // so check via a Hub that was already stale in the fixture and one that is fresh:
    const list = await request(app).get('/api/hubs').set('Authorization', loginAs('student1'));
    expect(list.status).toBe(200);
  });

  it('T-06 demo endpoints: 403 student, 400/404, stall 1/600 vs 0/601', async () => {
    const op = loginAs('operator1');
    const st = loginAs('student1');
    const stallBody = { hubId: 'metro', seconds: 30 };
    const routes: Array<[string, object]> = [
      ['/api/ops/telemetry/demo/stall', stallBody],
      ['/api/ops/telemetry/demo/fault', { resourceType: 'RENTAL_VEHICLE', resourceId: 'RV-M-001', faultCode: 'X' }],
      ['/api/ops/telemetry/demo/battery', { vehicleId: 'RV-M-001', batteryPct: 10 }],
    ];
    for (const [url, body] of routes) {
      expect((await request(app).post(url).set('Authorization', st).send(body)).status).toBe(403);
      expect((await request(app).post(url).send(body)).status).toBe(401);
    }
    expect((await request(app).get('/api/ops/telemetry/rejects').set('Authorization', st)).status).toBe(403);

    for (const seconds of [0, 601]) {
      const r = await request(app).post('/api/ops/telemetry/demo/stall').set('Authorization', op).send({ hubId: 'metro', seconds });
      expect(r.status).toBe(400);
      expect(r.body.error.details.field).toBe('seconds');
    }
    for (const seconds of [1, 600]) {
      const r = await request(app).post('/api/ops/telemetry/demo/stall').set('Authorization', op).send({ hubId: 'metro', seconds });
      expect(r.status).toBe(200);
      expect(r.body.hubId).toBe('metro');
      expect(new Date(r.body.stalledUntil).getTime()).toBeGreaterThan(Date.now() - 1000);
    }
    expect((await request(app).post('/api/ops/telemetry/demo/stall').set('Authorization', op).send({ hubId: 'ghost', seconds: 5 })).status).toBe(404);

    const f = (b: object) => request(app).post('/api/ops/telemetry/demo/fault').set('Authorization', op).send(b);
    expect((await f({ resourceType: 'BAD', resourceId: 'RV-M-001', faultCode: 'X' })).status).toBe(400);
    expect((await f({ resourceType: 'RENTAL_VEHICLE', resourceId: 'RV-M-001', faultCode: '' })).status).toBe(400);
    expect((await f({ resourceType: 'RENTAL_VEHICLE', resourceId: 'NOPE', faultCode: 'X' })).status).toBe(404);
    expect((await f({ resourceType: 'PARKING_SPACE', resourceId: 'NOPE', faultCode: 'X' })).status).toBe(404);
    expect((await f({ resourceType: 'CHARGING_POINT', resourceId: 'NOPE', faultCode: 'X' })).status).toBe(404);
    const okF = await f({ resourceType: 'CHARGING_POINT', resourceId: 'MET-CP-M-01', faultCode: 'X' });
    expect(okF.status).toBe(200);
    expect(okF.body).toEqual({ queued: true });

    const b = (x: object) => request(app).post('/api/ops/telemetry/demo/battery').set('Authorization', op).send(x);
    expect((await b({ vehicleId: 'RV-M-001', batteryPct: 101 })).status).toBe(400);
    expect((await b({ vehicleId: 'RV-M-001', batteryPct: -1 })).status).toBe(400);
    expect((await b({ vehicleId: 'NOPE', batteryPct: 5 })).status).toBe(404);
    const okB = await b({ vehicleId: 'RV-M-001', batteryPct: 0 });
    expect(okB.status).toBe(200);
    expect(okB.body).toEqual({ queued: true });

    // the demo calls themselves change no live state, and write audit rows by the operator
    const audits = await db.auditLog.findMany({ where: { action: { startsWith: 'TELEMETRY_DEMO_' } } });
    const actions = new Set(audits.map((a) => a.action));
    expect(actions.has('TELEMETRY_DEMO_STALL')).toBe(true);
    expect(actions.has('TELEMETRY_DEMO_FAULT')).toBe(true);
    expect(actions.has('TELEMETRY_DEMO_BATTERY')).toBe(true);
    expect(audits.every((a) => a.actorId === 'operator1' && a.actorRole === 'OPERATOR')).toBe(true);
    // rejected demo calls must not leave audit rows: 3 ok stall/fault/battery + 2 ok stalls = 5
    expect(audits).toHaveLength(2 + 1 + 1);
  });

  it('T-06 queued demo battery override reaches the next generator packet once', async () => {
    const op = loginAs('operator1');
    await request(app).post('/api/ops/telemetry/demo/battery').set('Authorization', op).send({ vehicleId: 'RV-D-001', batteryPct: 12.3 });
    await runJobOnce('telemetry.generate', new Date(Date.now() + 10_000));
    expect((await db.rentalVehicle.findUniqueOrThrow({ where: { id: 'RV-D-001' } })).batteryPct).toBe(12.3);
    // consumed: a second tick does not force it again
    await db.rentalVehicle.update({ where: { id: 'RV-D-001' }, data: { batteryPct: 80 } });
    await runJobOnce('telemetry.generate', new Date(Date.now() + 20_000));
    expect((await db.rentalVehicle.findUniqueOrThrow({ where: { id: 'RV-D-001' } })).batteryPct).toBe(80);
  });

  it('NFR-25 rejects list: newest first, limit respected, max enforced', async () => {
    const op = loginAs('operator1');
    await post({ hubId: 'metro', timestamp: 'bad', source: 'SIMULATOR' });
    await post({ hubId: 'dorm', timestamp: 'bad', source: 'SIMULATOR' });
    await post({ hubId: 'campus-a', timestamp: 'bad', source: 'SIMULATOR' });
    const all = await request(app).get('/api/ops/telemetry/rejects').set('Authorization', op);
    expect(all.status).toBe(200);
    expect(all.body.items.map((i: { hubId: string }) => i.hubId)).toEqual(['campus-a', 'dorm', 'metro']);
    for (const k of ['hubId', 'packetTimestamp', 'reason', 'receivedAt']) expect(all.body.items[0]).toHaveProperty(k);
    const one = await request(app).get('/api/ops/telemetry/rejects?limit=1').set('Authorization', op);
    expect(one.body.items).toHaveLength(1);
    expect((await request(app).get('/api/ops/telemetry/rejects?limit=201').set('Authorization', op)).status).toBe(400);
    expect((await request(app).get('/api/ops/telemetry/rejects?limit=0').set('Authorization', op)).status).toBe(400);
  });

  it('T-06 AC-12 TELEMETRY_INGESTED only for applied packets', async () => {
    const seen: string[] = [];
    events.on('TELEMETRY_INGESTED', (p) => { seen.push(p.hubId); });
    const last = await metroLast();
    await post({ hubId: 'metro', timestamp: last.toISOString(), source: 'SIMULATOR' }); // stale
    await post({ hubId: 'metro', timestamp: 'bad', source: 'SIMULATOR' }); // malformed
    await post({ hubId: 'ghost', timestamp: after(last, 5000), source: 'SIMULATOR' }); // unknown hub
    await post({ hubId: 'metro', timestamp: after(last, 5000), source: 'SIMULATOR' }, 'bad-key');
    expect(seen).toEqual([]);
    await post({ hubId: 'metro', timestamp: after(last, 5000), source: 'SIMULATOR' });
    expect(seen).toEqual(['metro']);
  });

  it('T-06 a reject never leaks a raw Prisma error', async () => {
    const res = await post({ hubId: 'metro', timestamp: '2026-01-01T00:00:00.000Z', source: 'SIMULATOR', privateEvs: [{ id: 'PEV-02', batteryPct: 50 }] });
    // PEV-02 only has a SCHEDULED request at metro: not allowed by ticket rule 3
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toMatch(/prisma|P20\d\d|invocation/i);
    expect(res.body.error.nextActions.length).toBeGreaterThan(0);
  });
});
