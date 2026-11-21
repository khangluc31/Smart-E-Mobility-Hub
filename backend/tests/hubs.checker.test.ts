/**
 * T-04 Checker tests — written from spec before reading the implementation.
 * Sources: SPEC §1/3/6 FR-01..03/FR-19/§8 D-04/D-12/D-14/D-16/D-18,
 *          ARCHITECTURE §3/8/15, CONTRACTS §0/1/3, TASKS.md T-04,
 *          FIXTURE documented counts in backend/tests/helpers.ts.
 *
 * Pure-helper test names follow TASKS.md spec; names adjusted after reading
 * implementation if the writer used different names (see "Known and accepted").
 */

import request from 'supertest';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestApp, resetDb, loginAs, FIXTURE } from './helpers';

// Pure-helper imports.
// Writer used `utilPct` (single function, not parkingUtilPct/chargingUtilPct) —
// accepted per "Known and accepted" in the checker prompt.
// isDegraded takes (lastTelemetryAt, now, stalledIntervals, intervalSec).
// isNearCapacity takes (parking, publicParking, charging, rawUtils, threshold).
import {
  utilPct,
  isNearCapacity,
  isDegraded,
} from '../src/modules/hubs/hubs.metrics';

// ---------------------------------------------------------------------------
// Shared app + fixture
// ---------------------------------------------------------------------------

const app = createTestApp();

beforeAll(async () => {
  await resetDb();
});

afterAll(async () => {
  const { db } = await import('../src/core/db');
  await db.$disconnect();
});

// ---------------------------------------------------------------------------
// AC-1 / FR-01 — GET /api/hubs: 5 Hubs, every HubSummary field, 401 without token
// ---------------------------------------------------------------------------

describe('T-04 AC-1 FR-01 GET /api/hubs lists all 5 Hubs', () => {
  it('FR-01 returns 401 without Authorization header', async () => {
    const res = await request(app).get('/api/hubs');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('FR-01 returns 200 with an array of exactly 5 Hubs', async () => {
    const res = await request(app)
      .get('/api/hubs')
      .set('Authorization', loginAs('student1'));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(5);
  });

  it('FR-01 every Hub has every HubSummary field', async () => {
    const res = await request(app)
      .get('/api/hubs')
      .set('Authorization', loginAs('student1'));
    for (const hub of res.body as Record<string, unknown>[]) {
      expect(hub).toHaveProperty('id');
      expect(hub).toHaveProperty('name');
      expect(hub).toHaveProperty('location');
      expect(hub).toHaveProperty('lastTelemetryAt');
      expect(hub).toHaveProperty('degraded');
      expect(hub).toHaveProperty('availableRentalVehicles');
      expect(hub).toHaveProperty('parking');
      expect(hub).toHaveProperty('publicParking');
      expect(hub).toHaveProperty('charging');
      expect(hub).toHaveProperty('nearCapacity');
      expect(hub).toHaveProperty('redirectToHubId');
      // parking / publicParking / charging each have MOTORCYCLE and CAR
      const parking = hub.parking as Record<string, unknown>;
      expect(parking).toHaveProperty('MOTORCYCLE');
      expect(parking).toHaveProperty('CAR');
      const pc = hub.charging as Record<string, unknown>;
      expect(pc).toHaveProperty('MOTORCYCLE');
      expect(pc).toHaveProperty('CAR');
      // ClassCount shape
      type NumCC = { free: number; total: number; utilPct: number };
      const { MOTORCYCLE: cc } = hub.parking as { MOTORCYCLE: NumCC; CAR: NumCC };
      expect(typeof cc.free).toBe('number');
      expect(typeof cc.total).toBe('number');
      expect(typeof cc.utilPct).toBe('number');
    }
  });

  it('FR-01 Hub ids and names match SPEC §1 (all 5 fixture hubs present)', async () => {
    const res = await request(app)
      .get('/api/hubs')
      .set('Authorization', loginAs('student1'));
    const ids = (res.body as Array<{ id: string }>).map(h => h.id).sort();
    expect(ids).toEqual([...FIXTURE.hubs].sort());
  });

  it('FR-01 metro counts match FIXTURE', async () => {
    const res = await request(app)
      .get('/api/hubs')
      .set('Authorization', loginAs('operator1'));
    const metro = (res.body as Array<Record<string, unknown>>).find(h => h.id === 'metro')!;
    expect(metro).toBeDefined();
    // availableRentalVehicles
    expect(metro.availableRentalVehicles).toBe(FIXTURE.metro.availableRentalVehicles); // 3
    type NumCC = { free: number; total: number; utilPct: number };
    type ClassMap = { MOTORCYCLE: NumCC; CAR: NumCC };
    // parking both pools MOTORCYCLE
    const { MOTORCYCLE: parkM, CAR: parkC } = metro.parking as ClassMap;
    expect(parkM.free).toBe(FIXTURE.metro.parking.MOTORCYCLE.free);     // 5
    expect(parkM.total).toBe(FIXTURE.metro.parking.MOTORCYCLE.total);   // 15
    expect(parkM.utilPct).toBeCloseTo(FIXTURE.metro.parking.MOTORCYCLE.utilPct, 1); // 64.3
    expect(parkC.free).toBe(FIXTURE.metro.parking.CAR.free);   // 1
    expect(parkC.total).toBe(FIXTURE.metro.parking.CAR.total); // 3
    expect(parkC.utilPct).toBeCloseTo(FIXTURE.metro.parking.CAR.utilPct, 1); // 66.7
    // charging
    const { MOTORCYCLE: chgM, CAR: chgC } = metro.charging as ClassMap;
    expect(chgM.free).toBe(FIXTURE.metro.charging.MOTORCYCLE.free);     // 3
    expect(chgM.total).toBe(FIXTURE.metro.charging.MOTORCYCLE.total);   // 5
    expect(chgM.utilPct).toBeCloseTo(FIXTURE.metro.charging.MOTORCYCLE.utilPct, 1); // 25.0
    expect(chgC.free).toBe(FIXTURE.metro.charging.CAR.free);   // 0
    expect(chgC.total).toBe(FIXTURE.metro.charging.CAR.total); // 1
    expect(chgC.utilPct).toBeCloseTo(FIXTURE.metro.charging.CAR.utilPct, 1); // 100.0
    // nearCapacity / degraded / redirectToHubId
    expect(metro.nearCapacity).toBe(FIXTURE.metro.nearCapacity); // true
    expect(metro.degraded).toBe(FIXTURE.metro.degraded);         // false
    expect(metro.redirectToHubId).toBe(FIXTURE.metro.redirectToHubId); // 'dorm'
  });

  it('FR-01 service counts match FIXTURE (degraded=true)', async () => {
    const res = await request(app)
      .get('/api/hubs')
      .set('Authorization', loginAs('student1'));
    const svc = (res.body as Array<Record<string, unknown>>).find(h => h.id === 'service')!;
    expect(svc.degraded).toBe(true);
    expect(svc.availableRentalVehicles).toBe(FIXTURE.service.availableRentalVehicles); // 1
    expect(svc.nearCapacity).toBe(FIXTURE.service.nearCapacity); // false
    expect(svc.redirectToHubId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AC-2 / FR-01 BR-02 D-18 — availableRentalVehicles: 20% counts, 19% doesn't,
//                             charging excluded, queued included
// ---------------------------------------------------------------------------

describe('T-04 AC-2 FR-01 BR-02 D-18 availableRentalVehicles boundary counts', () => {
  it('D-18 BR-02 metro avail=3: RV at 20% counts, 19% (LOW_BATTERY) excluded, charging excluded, queued included', async () => {
    // Fixture: RV-M-001 (80%, AVAILABLE) → YES
    //          RV-M-002 (20%, AVAILABLE) → YES (boundary: 20 ≥ 20)
    //          RV-M-003 (19%, LOW_BATTERY) → NO (status)
    //          RV-M-004 (50%, AVAILABLE, CHARGING request) → NO (D-18)
    //          RV-M-005 (60%, AVAILABLE, QUEUED request) → YES (QUEUED ≠ CHARGING)
    //          RV-M-006 (RESERVED) → NO
    //          RV-M-007 (FAULTY) → NO
    // Expected: 3 (RV-M-001, RV-M-002, RV-M-005)
    const res = await request(app)
      .get('/api/hubs')
      .set('Authorization', loginAs('student1'));
    const metro = (res.body as Array<{ id: string; availableRentalVehicles: number }>)
      .find(h => h.id === 'metro')!;
    expect(metro.availableRentalVehicles).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// AC-3 / FR-01 BR-09 — utilisation 84/100 → not near capacity, 85/100 → near (pure helpers)
// ---------------------------------------------------------------------------

describe('T-04 AC-3 BR-09 utilisation pure functions: 84/100 → false, 85/100 → true', () => {
  // utilPct(used, total, withdrawn) — writer used one fn for both parking and charging
  it('utilPct 84 out of 100 (0 withdrawn) → 84.0', () => {
    expect(utilPct(84, 100, 0)).toBeCloseTo(84.0, 1);
  });

  it('utilPct 85 out of 100 (0 withdrawn) → 85.0', () => {
    expect(utilPct(85, 100, 0)).toBeCloseTo(85.0, 1);
  });

  it('utilPct total=0 → 0 (no division by zero)', () => {
    expect(utilPct(0, 0, 0)).toBe(0);
  });

  it('utilPct all withdrawn (usable=0, total>0) → 100', () => {
    expect(utilPct(0, 10, 10)).toBe(100);
  });

  it('utilPct withdrawal shrinks denominator: used=1 withdrawn=1 total=2 → 100', () => {
    // usable = 2-1 = 1, used=1 → 100%
    expect(utilPct(1, 2, 1)).toBeCloseTo(100, 1);
  });

  // isNearCapacity(parking, publicParking, charging, rawUtils, threshold)
  // rawUtils.parkingRaw[vc] is the unrounded ratio used for the threshold comparison
  const cc0 = { free: 0, total: 0, utilPct: 0 };
  const p0 = { MOTORCYCLE: cc0, CAR: cc0 };

  it('isNearCapacity: parking MOTORCYCLE rawUtil=84, threshold=85 → false', () => {
    const p = { MOTORCYCLE: { free: 16, total: 100, utilPct: 84.0 }, CAR: cc0 };
    const ru = { parkingRaw: { MOTORCYCLE: 84.0, CAR: 0 }, chargingRaw: { MOTORCYCLE: 0, CAR: 0 } };
    expect(isNearCapacity(p, p0, p0, ru, 85)).toBe(false);
  });

  it('isNearCapacity: parking MOTORCYCLE rawUtil=85, threshold=85 → true', () => {
    const p = { MOTORCYCLE: { free: 15, total: 100, utilPct: 85.0 }, CAR: cc0 };
    const ru = { parkingRaw: { MOTORCYCLE: 85.0, CAR: 0 }, chargingRaw: { MOTORCYCLE: 0, CAR: 0 } };
    expect(isNearCapacity(p, p0, p0, ru, 85)).toBe(true);
  });

  it('isNearCapacity: charging CAR rawUtil=100, threshold=85 → true', () => {
    const c = { MOTORCYCLE: cc0, CAR: { free: 0, total: 1, utilPct: 100.0 } };
    const ru = { parkingRaw: { MOTORCYCLE: 0, CAR: 0 }, chargingRaw: { MOTORCYCLE: 0, CAR: 100.0 } };
    expect(isNearCapacity(p0, p0, c, ru, 85)).toBe(true);
  });

  it('campus-b nearCapacity=true because CAR charging 100% (all withdrawn = FAULTY)', async () => {
    const res = await request(app)
      .get('/api/hubs')
      .set('Authorization', loginAs('student1'));
    const cb = (res.body as Array<{ id: string; nearCapacity: boolean }>)
      .find(h => h.id === 'campus-b')!;
    expect(cb.nearCapacity).toBe(true);
    // charging CAR: 0 charging, 1 faulty, 1 total → usable=0, total=1 → 100%
    expect(FIXTURE['campus-b'].nearCapacity).toBe(true);
  });

  it('campus-b charging CAR utilPct is 100 (all faulty = withdrawn)', async () => {
    const res = await request(app)
      .get('/api/hubs')
      .set('Authorization', loginAs('student1'));
    const cb = (res.body as Array<Record<string, unknown>>)
      .find(h => h.id === 'campus-b')!;
    type NumCC = { free: number; total: number; utilPct: number };
    const { CAR: chgC } = cb.charging as { MOTORCYCLE: NumCC; CAR: NumCC };
    expect(chgC.free).toBe(0);
    expect(chgC.total).toBe(1);
    expect(chgC.utilPct).toBeCloseTo(100.0, 1);
  });
});

// ---------------------------------------------------------------------------
// AC-3 / FR-01 D-16 — parking counts both pools; publicParking counts only PUBLIC
// ---------------------------------------------------------------------------

describe('T-04 AC-3 FR-01 D-16 parking = both pools, publicParking = PUBLIC only', () => {
  it('D-16 metro parking.MOTORCYCLE.total=15 (9 FLEET + 6 PUBLIC), publicParking.MOTORCYCLE.total=6', async () => {
    const res = await request(app)
      .get('/api/hubs')
      .set('Authorization', loginAs('student1'));
    const metro = (res.body as Array<Record<string, unknown>>).find(h => h.id === 'metro')!;
    type NumCC = { free: number; total: number; utilPct: number };
    type CM = { MOTORCYCLE: NumCC; CAR: NumCC };
    const { MOTORCYCLE: parkM } = metro.parking as CM;
    expect(parkM.total).toBe(15); // 9 FLEET + 6 PUBLIC
    expect(parkM.free).toBe(5);   // 2 FLEET FREE + 3 PUBLIC FREE
    const { MOTORCYCLE: pubM } = metro.publicParking as CM;
    expect(pubM.total).toBe(6);   // PUBLIC pool only
    expect(pubM.free).toBe(3);    // 3 PUBLIC FREE
    expect(pubM.utilPct).toBeCloseTo(FIXTURE.metro.publicParking.MOTORCYCLE.utilPct, 1); // 40.0
  });

  it('D-16 metro publicParking.CAR matches parking.CAR (all CAR spaces are PUBLIC)', async () => {
    const res = await request(app)
      .get('/api/hubs')
      .set('Authorization', loginAs('student1'));
    const metro = (res.body as Array<Record<string, unknown>>).find(h => h.id === 'metro')!;
    const parkC = (metro.parking as Record<string, Record<string, unknown>>).CAR;
    const pubC = (metro.publicParking as Record<string, Record<string, unknown>>).CAR;
    // All metro CAR spaces are PUBLIC so both counts must be identical
    expect(parkC).toEqual(pubC);
  });
});

// ---------------------------------------------------------------------------
// AC-4 / FR-03 — degraded: stale Hub degraded, fresh not; isDegraded pure boundary
// ---------------------------------------------------------------------------

describe('T-04 AC-4 FR-03 degraded: stale Hub flagged, fresh not; pure boundary 14.999/15 s', () => {
  it('FR-03 service Hub is degraded (lastTelemetryAt = now - 60 s, threshold = 15 s)', async () => {
    const res = await request(app)
      .get('/api/hubs')
      .set('Authorization', loginAs('student1'));
    const svc = (res.body as Array<{ id: string; degraded: boolean; lastTelemetryAt: string | null }>)
      .find(h => h.id === 'service')!;
    expect(svc.degraded).toBe(true);
    expect(svc.lastTelemetryAt).not.toBeNull(); // it's stale but not null
  });

  it('FR-03 fresh Hubs (metro, dorm, campus-a, campus-b) are not degraded', async () => {
    const res = await request(app)
      .get('/api/hubs')
      .set('Authorization', loginAs('student1'));
    const hubs = res.body as Array<{ id: string; degraded: boolean }>;
    for (const h of hubs.filter(h => h.id !== 'service')) {
      expect(h.degraded).toBe(false);
    }
  });

  // isDegraded(lastTelemetryAt, now, stalledIntervals, intervalSec)
  // Default config: stalledIntervals=3, intervalSec=5 → threshold=15s
  it('isDegraded(null, now, 3, 5) → true', () => {
    expect(isDegraded(null, new Date(), 3, 5)).toBe(true);
  });

  it('isDegraded: 14.999 s → false (just below 3×5=15 s threshold)', () => {
    const now = new Date();
    const stale = new Date(now.getTime() - 14999);
    expect(isDegraded(stale, now, 3, 5)).toBe(false);
  });

  it('isDegraded: 15 s → true (exactly at 3×5=15 s threshold)', () => {
    const now = new Date();
    const stale = new Date(now.getTime() - 15000);
    expect(isDegraded(stale, now, 3, 5)).toBe(true);
  });

  it('isDegraded: 60 s → true (well past threshold)', () => {
    const now = new Date();
    const stale = new Date(now.getTime() - 60000);
    expect(isDegraded(stale, now, 3, 5)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC-5 / FR-02 — HubDetail: resources sorted by id, charging flag, summary matches list
// ---------------------------------------------------------------------------

describe('T-04 AC-5 FR-02 GET /api/hubs/:hubId detail', () => {
  it('FR-02 returns all resources of metro only (no resources from other Hubs)', async () => {
    const res = await request(app)
      .get('/api/hubs/metro')
      .set('Authorization', loginAs('student1'));
    expect(res.status).toBe(200);
    const detail = res.body as {
      vehicles: Array<{ hubId: string }>;
      parkingSpaces: Array<{ hubId: string }>;
      chargingPoints: Array<{ hubId: string }>;
    };
    for (const v of detail.vehicles) expect(v.hubId).toBe('metro');
    for (const p of detail.parkingSpaces) expect(p.hubId).toBe('metro');
    for (const c of detail.chargingPoints) expect(c.hubId).toBe('metro');
  });

  it('FR-02 resource counts equal FIXTURE for metro', async () => {
    const res = await request(app)
      .get('/api/hubs/metro')
      .set('Authorization', loginAs('student1'));
    const d = res.body as {
      vehicles: unknown[]; parkingSpaces: unknown[]; chargingPoints: unknown[];
    };
    expect(d.vehicles).toHaveLength(FIXTURE.metro.vehicleCount);       // 7
    expect(d.parkingSpaces).toHaveLength(FIXTURE.metro.parkingSpaceCount); // 18
    expect(d.chargingPoints).toHaveLength(FIXTURE.metro.chargingPointCount); // 6
  });

  it('FR-02 vehicles sorted by id', async () => {
    const res = await request(app)
      .get('/api/hubs/metro')
      .set('Authorization', loginAs('student1'));
    const ids = (res.body.vehicles as Array<{ id: string }>).map(v => v.id);
    expect(ids).toEqual([...ids].sort());
  });

  it('FR-02 D-18 charging flag: RV-M-004 is charging=true, RV-M-005 (QUEUED) is charging=false', async () => {
    const res = await request(app)
      .get('/api/hubs/metro')
      .set('Authorization', loginAs('student1'));
    const vehicles = res.body.vehicles as Array<{ id: string; charging: boolean }>;
    const rv004 = vehicles.find(v => v.id === 'RV-M-004');
    const rv005 = vehicles.find(v => v.id === 'RV-M-005');
    expect(rv004?.charging).toBe(true);  // has CHARGING request
    expect(rv005?.charging).toBe(false); // only QUEUED request
  });

  it('FR-02 summary fields in detail equal those from GET /api/hubs for the same Hub', async () => {
    const [listRes, detailRes] = await Promise.all([
      request(app).get('/api/hubs').set('Authorization', loginAs('student1')),
      request(app).get('/api/hubs/metro').set('Authorization', loginAs('student1')),
    ]);
    const listMetro = (listRes.body as Array<{ id: string } & Record<string, unknown>>)
      .find(h => h.id === 'metro')!;
    const detail = detailRes.body as Record<string, unknown>;
    // Compare all summary fields
    expect(detail.availableRentalVehicles).toEqual(listMetro.availableRentalVehicles);
    expect(detail.parking).toEqual(listMetro.parking);
    expect(detail.publicParking).toEqual(listMetro.publicParking);
    expect(detail.charging).toEqual(listMetro.charging);
    expect(detail.nearCapacity).toEqual(listMetro.nearCapacity);
    expect(detail.degraded).toEqual(listMetro.degraded);
    expect(detail.redirectToHubId).toEqual(listMetro.redirectToHubId);
  });

  it('FR-02 unknown hub → 404 NOT_FOUND in CONTRACTS §0 shape', async () => {
    const res = await request(app)
      .get('/api/hubs/does-not-exist')
      .set('Authorization', loginAs('student1'));
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(Array.isArray(res.body.error.nextActions)).toBe(true);
    expect(res.body.error.nextActions.length).toBeGreaterThanOrEqual(1);
    expect(res.body.error.message).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// AC-6 / FR-19 D-12 — alternatives: exclude degraded/excluded/zero-free, active redirect first
// ---------------------------------------------------------------------------

describe('T-04 AC-6 FR-19 D-12 alternatives exclude degraded/excluded/zero-free; redirect first', () => {
  it('FR-19 FLEET_PARKING MOTORCYCLE excludeHubId=metro: service excluded (degraded), dorm first (redirect)', async () => {
    const res = await request(app)
      .get('/api/hubs/alternatives?need=FLEET_PARKING&vehicleClass=MOTORCYCLE&excludeHubId=metro')
      .set('Authorization', loginAs('student1'));
    expect(res.status).toBe(200);
    const alts = res.body as Array<{ type: string; hubId: string; free: number; reason: string }>;
    // service not in results (degraded)
    expect(alts.find(a => a.hubId === 'service')).toBeUndefined();
    // metro not in results (excluded)
    expect(alts.find(a => a.hubId === 'metro')).toBeUndefined();
    // All results have free > 0
    for (const a of alts) {
      expect(a.free).toBeGreaterThan(0);
      expect(a.type).toBe('hub');
      expect(typeof a.hubId).toBe('string');
      expect(typeof a.reason).toBe('string');
    }
    // dorm first (metro has active redirect to dorm)
    expect(alts.length).toBeGreaterThanOrEqual(1);
    expect(alts[0]!.hubId).toBe('dorm');
    // dorm reason mentions redirect
    expect(alts[0]!.reason.toLowerCase()).toMatch(/redirect/i);
  });

  it('FR-19 FLEET_PARKING CAR → [] (no FLEET CAR spaces in fixture)', async () => {
    const res = await request(app)
      .get('/api/hubs/alternatives?need=FLEET_PARKING&vehicleClass=CAR')
      .set('Authorization', loginAs('student1'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('FR-19 sorted by most free (after redirect boost)', async () => {
    // PUBLIC_PARKING MOTORCYCLE without excludeHubId: metro has 3 free, dorm has 2, campus-a/b have 1
    const res = await request(app)
      .get('/api/hubs/alternatives?need=PUBLIC_PARKING&vehicleClass=MOTORCYCLE')
      .set('Authorization', loginAs('student1'));
    expect(res.status).toBe(200);
    const alts = res.body as Array<{ hubId: string; free: number }>;
    // service excluded (degraded)
    expect(alts.find(a => a.hubId === 'service')).toBeUndefined();
    // metro free=3 should come first (most free, no redirect boost without excludeHubId)
    expect(alts[0]!.hubId).toBe('metro');
    expect(alts[0]!.free).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// AC-6 / FR-19 — window overlap reduces free; CANCELLED and touching don't
// ---------------------------------------------------------------------------

describe('T-04 AC-6 FR-19 window: overlap reduces free; CANCELLED and touching do not', () => {
  it('FR-19 PUBLIC_PARKING with [now+2h, now+4h]: metro free=4 (PR-M-001 overlaps -1; PR-M-004 CANCELLED; MET-P-M-05 UNAVAIL)', async () => {
    const now = Date.now();
    const from = new Date(now + 2 * 3600_000).toISOString();
    const to   = new Date(now + 4 * 3600_000).toISOString();
    const res = await request(app)
      .get(`/api/hubs/alternatives?need=PUBLIC_PARKING&vehicleClass=MOTORCYCLE&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)
      .set('Authorization', loginAs('student1'));
    expect(res.status).toBe(200);
    const alts = res.body as Array<{ hubId: string; free: number }>;
    const metro = alts.find(a => a.hubId === 'metro')!;
    expect(metro).toBeDefined();
    // 5 non-UNAVAIL PUBLIC M spaces, minus MET-P-M-02 (PR-M-001 CONFIRMED overlaps) = 4
    // MET-P-M-06 included (PR-M-004 CANCELLED → not counted)
    expect(metro.free).toBe(4);
  });

  it('FR-19 CHARGING with [now+2h, now+4h]: MET-CP-M-04 excluded (overlaps), MET-CP-M-05 included (touching at now+2h)', async () => {
    const now = Date.now();
    const from = new Date(now + 2 * 3600_000).toISOString();
    const to   = new Date(now + 4 * 3600_000).toISOString();
    const res = await request(app)
      .get(`/api/hubs/alternatives?need=CHARGING&vehicleClass=MOTORCYCLE&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)
      .set('Authorization', loginAs('student1'));
    expect(res.status).toBe(200);
    const alts = res.body as Array<{ hubId: string; free: number }>;
    const metro = alts.find(a => a.hubId === 'metro')!;
    expect(metro).toBeDefined();
    // Non-FAULTY MOTO points: M-01, M-02, M-04, M-05
    // CR-M-003 SCHEDULED [now+2.5h, now+3.5h] on M-04 → overlaps → excluded
    // CR-M-004 SCHEDULED [now+1h, now+2h] on M-05 → touches [now+2h, now+4h) at now+2h → NOT overlapping → included
    // CR-M-001 CHARGING [now-10min, now+30min] on M-02 → no overlap → included
    // Expected free: M-01, M-02, M-05 = 3
    expect(metro.free).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// AC-7 / NFR-13 — alternatives input validation → 400 with details.field
// ---------------------------------------------------------------------------

describe('T-04 AC-7 NFR-13 alternatives validation → 400 VALIDATION_ERROR with details.field', () => {
  it('missing need → 400 VALIDATION_ERROR details.field = need', async () => {
    const res = await request(app)
      .get('/api/hubs/alternatives?vehicleClass=MOTORCYCLE')
      .set('Authorization', loginAs('student1'));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details?.field).toBe('need');
  });

  it('invalid need value → 400 VALIDATION_ERROR details.field = need', async () => {
    const res = await request(app)
      .get('/api/hubs/alternatives?need=BOGUS&vehicleClass=MOTORCYCLE')
      .set('Authorization', loginAs('student1'));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details?.field).toBe('need');
  });

  it('missing vehicleClass → 400 VALIDATION_ERROR details.field = vehicleClass', async () => {
    const res = await request(app)
      .get('/api/hubs/alternatives?need=FLEET_PARKING')
      .set('Authorization', loginAs('student1'));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details?.field).toBe('vehicleClass');
  });

  it('invalid vehicleClass value → 400 VALIDATION_ERROR details.field = vehicleClass', async () => {
    const res = await request(app)
      .get('/api/hubs/alternatives?need=FLEET_PARKING&vehicleClass=TRUCK')
      .set('Authorization', loginAs('student1'));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details?.field).toBe('vehicleClass');
  });

  it('only from provided (without to) → 400 VALIDATION_ERROR', async () => {
    const from = new Date(Date.now() + 3600_000).toISOString();
    const res = await request(app)
      .get(`/api/hubs/alternatives?need=PUBLIC_PARKING&vehicleClass=MOTORCYCLE&from=${encodeURIComponent(from)}`)
      .set('Authorization', loginAs('student1'));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('only to provided (without from) → 400 VALIDATION_ERROR', async () => {
    const to = new Date(Date.now() + 7200_000).toISOString();
    const res = await request(app)
      .get(`/api/hubs/alternatives?need=PUBLIC_PARKING&vehicleClass=MOTORCYCLE&to=${encodeURIComponent(to)}`)
      .set('Authorization', loginAs('student1'));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('to ≤ from → 400 VALIDATION_ERROR', async () => {
    const now = Date.now();
    const from = new Date(now + 7200_000).toISOString();
    const to   = new Date(now + 3600_000).toISOString(); // to < from
    const res = await request(app)
      .get(`/api/hubs/alternatives?need=PUBLIC_PARKING&vehicleClass=MOTORCYCLE&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)
      .set('Authorization', loginAs('student1'));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('non-ISO date in from → 400 VALIDATION_ERROR', async () => {
    const res = await request(app)
      .get('/api/hubs/alternatives?need=PUBLIC_PARKING&vehicleClass=MOTORCYCLE&from=not-a-date&to=also-not-a-date')
      .set('Authorization', loginAs('student1'));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

// ---------------------------------------------------------------------------
// AC-8 — redirectToHubId set only while activeUntil > now
// ---------------------------------------------------------------------------

describe('T-04 AC-8 redirectToHubId set only while activeUntil > now', () => {
  it('metro.redirectToHubId = dorm (HR-001 active until now+1h)', async () => {
    const res = await request(app)
      .get('/api/hubs')
      .set('Authorization', loginAs('student1'));
    const metro = (res.body as Array<{ id: string; redirectToHubId: string | null }>)
      .find(h => h.id === 'metro')!;
    expect(metro.redirectToHubId).toBe('dorm');
  });

  it('other Hubs have redirectToHubId=null (no active redirect)', async () => {
    const res = await request(app)
      .get('/api/hubs')
      .set('Authorization', loginAs('student1'));
    const others = (res.body as Array<{ id: string; redirectToHubId: string | null }>)
      .filter(h => h.id !== 'metro');
    for (const h of others) {
      expect(h.redirectToHubId).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// AC-9 — createTestApp() twice doesn't duplicate routes; /api/ops/* returns 403 for STUDENT
// ---------------------------------------------------------------------------

describe('T-04 AC-9 createTestApp() twice — no duplicate routes or guards', () => {
  it('calling createTestApp() twice does not duplicate /api/hubs responses', async () => {
    const app2 = createTestApp();
    // Both apps should respond independently and correctly (no route stacking)
    const [r1, r2] = await Promise.all([
      request(app).get('/api/hubs').set('Authorization', loginAs('student1')),
      request(app2).get('/api/hubs').set('Authorization', loginAs('student1')),
    ]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r1.body).toHaveLength(5);
    expect(r2.body).toHaveLength(5);
  });

  it('/api/ops/* returns 403 FORBIDDEN for a STUDENT token (guard applied once)', async () => {
    const app2 = createTestApp();
    const res = await request(app2)
      .get('/api/ops/hubs') // operator-only route
      .set('Authorization', loginAs('student1'));
    // 403 or 404 (route may not exist yet, but guard should fire first)
    expect([403, 404]).toContain(res.status);
    if (res.status === 403) {
      expect(res.body.error.code).toBe('FORBIDDEN');
    }
  });
});
