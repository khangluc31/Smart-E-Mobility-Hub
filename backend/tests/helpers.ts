// Shared test helpers and fixture (T-04). Every module's test file imports these.
// resetDb() truncates everything and inserts the canonical fixture with relative
// timestamps so tests don't drift. createTestApp() creates a fresh Express app.
// loginAs() returns an Authorization header for the named user.

import { db } from '../src/core/db';
import { createApp } from '../src/app';
import { signToken } from '../src/core/auth';

// ---- createTestApp ----

export function createTestApp() {
  return createApp();
}

// ---- loginAs ----

const USERS = {
  student1: { id: 'student1', role: 'STUDENT' as const },
  student2: { id: 'student2', role: 'STUDENT' as const },
  operator1: { id: 'operator1', role: 'OPERATOR' as const },
};

export function loginAs(name: keyof typeof USERS): string {
  return `Bearer ${signToken(USERS[name])}`;
}

// ---- time helpers ----

function min(n: number): number { return n * 60_000; }
function sec(n: number): number { return n * 1_000; }
function hr(n: number): number { return n * 3_600_000; }

function rel(now: Date, offsetMs: number): Date {
  return new Date(now.getTime() + offsetMs);
}

// ---- resetDb ----

export async function resetDb(): Promise<void> {
  const now = new Date();

  // TRUNCATE all application tables (audit_log trigger blocks DELETE).
  await db.$executeRawUnsafe(`
    TRUNCATE TABLE
      hub_redirect, sim_recommendation, sim_run, sim_scenario,
      redistribution_task_vehicle, redistribution_task,
      incident_impact, incident_report, incident,
      idempotency_key,
      charging_request, parking_reservation, vehicle_reservation,
      notification, alert, audit_log, telemetry_reject,
      rental_vehicle, private_ev, parking_space, charging_point,
      hub_threshold, setting,
      "user", hub
    RESTART IDENTITY CASCADE
  `);

  // ---- users ----
  await db.user.createMany({
    data: [
      { id: 'student1', identifier: 'student1', passwordHash: '$placeholder$', displayName: 'Student One', role: 'STUDENT' },
      { id: 'student2', identifier: 'student2', passwordHash: '$placeholder$', displayName: 'Student Two', role: 'STUDENT' },
      { id: 'operator1', identifier: 'operator1', passwordHash: '$placeholder$', displayName: 'Operator One', role: 'OPERATOR' },
    ],
  });

  // ---- hubs ----
  // metro/dorm/campus-a/campus-b: lastTelemetryAt = now - 2 s (fresh)
  // service: lastTelemetryAt = now - 60 s (stale → degraded, threshold = 3 × 5 s = 15 s)
  await db.hub.createMany({
    data: [
      { id: 'metro', name: 'Metro Station Hub', location: 'Central Station, Platform 2', lastTelemetryAt: rel(now, -sec(2)) },
      { id: 'dorm', name: 'Dormitory Hub', location: 'West Campus Dormitory B', lastTelemetryAt: rel(now, -sec(2)) },
      { id: 'campus-a', name: 'Campus A Hub', location: 'Engineering Faculty, Lot A', lastTelemetryAt: rel(now, -sec(2)) },
      { id: 'campus-b', name: 'Campus B Hub', location: 'Science Faculty, Lot B', lastTelemetryAt: rel(now, -sec(2)) },
      { id: 'service', name: 'Service Area Hub', location: 'Maintenance Depot, South Gate', lastTelemetryAt: rel(now, -sec(60)) },
    ],
  });

  // ---- private EVs ----
  await db.privateEv.createMany({
    data: [
      { id: 'PEV-01', ownerId: 'student1', type: 'CAR', vehicleClass: 'CAR', label: 'My Car', batteryCapacityKwh: 50, batteryPct: 60 },
      { id: 'PEV-02', ownerId: 'student2', type: 'E_MOTORCYCLE', vehicleClass: 'MOTORCYCLE', label: 'Scooter', batteryCapacityKwh: 4, batteryPct: 70 },
      { id: 'PEV-03', ownerId: 'student1', type: 'E_MOTORCYCLE', vehicleClass: 'MOTORCYCLE', label: 'E-Bike', batteryCapacityKwh: 3, batteryPct: 55 },
    ],
  });

  // ========================================================================
  // PARKING SPACES
  // ========================================================================
  // Legend: F=FLEET, P=PUBLIC | M=MOTORCYCLE, C=CAR
  //
  //   Hub       | FLEET M         | PUBLIC M                              | PUBLIC C
  // ------------|-----------------|---------------------------------------|------------------
  //   metro     | 7 OCC + 2 FREE  | 3 FREE + 1 RES + 1 OCC + 1 UNAVAIL  | 1 FREE + 1 RES + 1 OCC
  //   dorm      | 2 OCC + 1 FREE  | 2 FREE                               | 1 FREE
  //   campus-a  | 1 OCC + 1 FREE  | 1 FREE                               | 1 FREE
  //   campus-b  | 1 OCC + 1 FREE  | 1 FREE                               | 1 FREE
  //   service   | 1 OCC + 1 FREE  | 1 FREE                               | —
  // ========================================================================
  await db.parkingSpace.createMany({
    data: [
      // ---- metro FLEET MOTORCYCLE (9 total: 7 OCCUPIED + 2 FREE) ----
      { id: 'MET-F-M-01', hubId: 'metro', vehicleClass: 'MOTORCYCLE', pool: 'FLEET', status: 'OCCUPIED' },
      { id: 'MET-F-M-02', hubId: 'metro', vehicleClass: 'MOTORCYCLE', pool: 'FLEET', status: 'OCCUPIED' },
      { id: 'MET-F-M-03', hubId: 'metro', vehicleClass: 'MOTORCYCLE', pool: 'FLEET', status: 'OCCUPIED' },
      { id: 'MET-F-M-04', hubId: 'metro', vehicleClass: 'MOTORCYCLE', pool: 'FLEET', status: 'OCCUPIED' },
      { id: 'MET-F-M-05', hubId: 'metro', vehicleClass: 'MOTORCYCLE', pool: 'FLEET', status: 'OCCUPIED' },
      { id: 'MET-F-M-06', hubId: 'metro', vehicleClass: 'MOTORCYCLE', pool: 'FLEET', status: 'OCCUPIED' },
      { id: 'MET-F-M-07', hubId: 'metro', vehicleClass: 'MOTORCYCLE', pool: 'FLEET', status: 'OCCUPIED' },
      { id: 'MET-F-M-08', hubId: 'metro', vehicleClass: 'MOTORCYCLE', pool: 'FLEET', status: 'FREE' },
      { id: 'MET-F-M-09', hubId: 'metro', vehicleClass: 'MOTORCYCLE', pool: 'FLEET', status: 'FREE' },
      // ---- metro PUBLIC MOTORCYCLE (6 total: 3 FREE + 1 RESERVED + 1 OCCUPIED + 1 UNAVAILABLE) ----
      { id: 'MET-P-M-01', hubId: 'metro', vehicleClass: 'MOTORCYCLE', pool: 'PUBLIC', status: 'FREE' },
      { id: 'MET-P-M-02', hubId: 'metro', vehicleClass: 'MOTORCYCLE', pool: 'PUBLIC', status: 'FREE' },
      { id: 'MET-P-M-03', hubId: 'metro', vehicleClass: 'MOTORCYCLE', pool: 'PUBLIC', status: 'RESERVED' },
      { id: 'MET-P-M-04', hubId: 'metro', vehicleClass: 'MOTORCYCLE', pool: 'PUBLIC', status: 'OCCUPIED' },
      { id: 'MET-P-M-05', hubId: 'metro', vehicleClass: 'MOTORCYCLE', pool: 'PUBLIC', status: 'UNAVAILABLE' },
      { id: 'MET-P-M-06', hubId: 'metro', vehicleClass: 'MOTORCYCLE', pool: 'PUBLIC', status: 'FREE' },
      // ---- metro PUBLIC CAR (3 total: 1 FREE + 1 RESERVED + 1 OCCUPIED) ----
      { id: 'MET-P-C-01', hubId: 'metro', vehicleClass: 'CAR', pool: 'PUBLIC', status: 'FREE' },
      { id: 'MET-P-C-02', hubId: 'metro', vehicleClass: 'CAR', pool: 'PUBLIC', status: 'RESERVED' },
      { id: 'MET-P-C-03', hubId: 'metro', vehicleClass: 'CAR', pool: 'PUBLIC', status: 'OCCUPIED' },
      // ---- dorm FLEET MOTORCYCLE (3 total: 2 OCC + 1 FREE) ----
      { id: 'DOR-F-M-01', hubId: 'dorm', vehicleClass: 'MOTORCYCLE', pool: 'FLEET', status: 'OCCUPIED' },
      { id: 'DOR-F-M-02', hubId: 'dorm', vehicleClass: 'MOTORCYCLE', pool: 'FLEET', status: 'OCCUPIED' },
      { id: 'DOR-F-M-03', hubId: 'dorm', vehicleClass: 'MOTORCYCLE', pool: 'FLEET', status: 'FREE' },
      // ---- dorm PUBLIC MOTORCYCLE (2 FREE) ----
      { id: 'DOR-P-M-01', hubId: 'dorm', vehicleClass: 'MOTORCYCLE', pool: 'PUBLIC', status: 'FREE' },
      { id: 'DOR-P-M-02', hubId: 'dorm', vehicleClass: 'MOTORCYCLE', pool: 'PUBLIC', status: 'FREE' },
      // ---- dorm PUBLIC CAR (1 FREE) ----
      { id: 'DOR-P-C-01', hubId: 'dorm', vehicleClass: 'CAR', pool: 'PUBLIC', status: 'FREE' },
      // ---- campus-a FLEET MOTORCYCLE (2 total) ----
      { id: 'CPA-F-M-01', hubId: 'campus-a', vehicleClass: 'MOTORCYCLE', pool: 'FLEET', status: 'OCCUPIED' },
      { id: 'CPA-F-M-02', hubId: 'campus-a', vehicleClass: 'MOTORCYCLE', pool: 'FLEET', status: 'FREE' },
      // ---- campus-a PUBLIC MOTORCYCLE (1 FREE) ----
      { id: 'CPA-P-M-01', hubId: 'campus-a', vehicleClass: 'MOTORCYCLE', pool: 'PUBLIC', status: 'FREE' },
      // ---- campus-a PUBLIC CAR (1 FREE) ----
      { id: 'CPA-P-C-01', hubId: 'campus-a', vehicleClass: 'CAR', pool: 'PUBLIC', status: 'FREE' },
      // ---- campus-b FLEET MOTORCYCLE (2 total) ----
      { id: 'CPB-F-M-01', hubId: 'campus-b', vehicleClass: 'MOTORCYCLE', pool: 'FLEET', status: 'OCCUPIED' },
      { id: 'CPB-F-M-02', hubId: 'campus-b', vehicleClass: 'MOTORCYCLE', pool: 'FLEET', status: 'FREE' },
      // ---- campus-b PUBLIC MOTORCYCLE (1 FREE) ----
      { id: 'CPB-P-M-01', hubId: 'campus-b', vehicleClass: 'MOTORCYCLE', pool: 'PUBLIC', status: 'FREE' },
      // ---- campus-b PUBLIC CAR (1 FREE) ----
      { id: 'CPB-P-C-01', hubId: 'campus-b', vehicleClass: 'CAR', pool: 'PUBLIC', status: 'FREE' },
      // ---- service FLEET MOTORCYCLE (2 total) ----
      { id: 'SVC-F-M-01', hubId: 'service', vehicleClass: 'MOTORCYCLE', pool: 'FLEET', status: 'OCCUPIED' },
      { id: 'SVC-F-M-02', hubId: 'service', vehicleClass: 'MOTORCYCLE', pool: 'FLEET', status: 'FREE' },
      // ---- service PUBLIC MOTORCYCLE (1 FREE) ----
      { id: 'SVC-P-M-01', hubId: 'service', vehicleClass: 'MOTORCYCLE', pool: 'PUBLIC', status: 'FREE' },
    ],
  });

  // ========================================================================
  // CHARGING POINTS
  // ========================================================================
  //   Hub       | MOTO                                               | CAR
  // ------------|----------------------------------------------------|--------------
  //   metro     | 3 AVAIL + 1 CHARGING + 1 FAULTY  (5 total)        | 1 CHARGING
  //   dorm      | 1 AVAILABLE                                        | 1 AVAILABLE
  //   campus-a  | 1 AVAILABLE                                        | 1 AVAILABLE
  //   campus-b  | 1 AVAILABLE                                        | 1 FAULTY
  //   service   | 1 AVAILABLE                                        | —
  // ========================================================================
  await db.chargingPoint.createMany({
    data: [
      { id: 'MET-CP-M-01', hubId: 'metro', vehicleClass: 'MOTORCYCLE', status: 'AVAILABLE' },
      { id: 'MET-CP-M-02', hubId: 'metro', vehicleClass: 'MOTORCYCLE', status: 'CHARGING' },
      { id: 'MET-CP-M-03', hubId: 'metro', vehicleClass: 'MOTORCYCLE', status: 'FAULTY' },
      { id: 'MET-CP-M-04', hubId: 'metro', vehicleClass: 'MOTORCYCLE', status: 'AVAILABLE' },
      { id: 'MET-CP-M-05', hubId: 'metro', vehicleClass: 'MOTORCYCLE', status: 'AVAILABLE' },
      { id: 'MET-CP-C-01', hubId: 'metro', vehicleClass: 'CAR', status: 'CHARGING' },
      { id: 'DOR-CP-M-01', hubId: 'dorm', vehicleClass: 'MOTORCYCLE', status: 'AVAILABLE' },
      { id: 'DOR-CP-C-01', hubId: 'dorm', vehicleClass: 'CAR', status: 'AVAILABLE' },
      { id: 'CPA-CP-M-01', hubId: 'campus-a', vehicleClass: 'MOTORCYCLE', status: 'AVAILABLE' },
      { id: 'CPA-CP-C-01', hubId: 'campus-a', vehicleClass: 'CAR', status: 'AVAILABLE' },
      { id: 'CPB-CP-M-01', hubId: 'campus-b', vehicleClass: 'MOTORCYCLE', status: 'AVAILABLE' },
      { id: 'CPB-CP-C-01', hubId: 'campus-b', vehicleClass: 'CAR', status: 'FAULTY' },
      { id: 'SVC-CP-M-01', hubId: 'service', vehicleClass: 'MOTORCYCLE', status: 'AVAILABLE' },
    ],
  });

  // ========================================================================
  // RENTAL VEHICLES (all MOTORCYCLE class)   D-14: each parked vehicle → FLEET OCCUPIED space
  // ========================================================================
  //   Hub    | ID         | Status      | Bat% | Space       | Available? (≥20%, AVAILABLE, not charging)
  // ---------|------------|-------------|------|-------------|---
  //   metro  | RV-M-001  | AVAILABLE   | 80   | MET-F-M-01  | YES
  //   metro  | RV-M-002  | AVAILABLE   | 20   | MET-F-M-02  | YES (boundary: 20 ≥ 20)
  //   metro  | RV-M-003  | LOW_BATTERY | 19   | MET-F-M-03  | NO (LOW_BATTERY)
  //   metro  | RV-M-004  | AVAILABLE   | 50   | MET-F-M-04  | NO (CHARGING request, D-18)
  //   metro  | RV-M-005  | AVAILABLE   | 60   | MET-F-M-05  | YES (QUEUED ≠ CHARGING, D-18)
  //   metro  | RV-M-006  | RESERVED    | 75   | MET-F-M-06  | NO (RESERVED)
  //   metro  | RV-M-007  | FAULTY      | 45   | MET-F-M-07  | NO (FAULTY)
  //   dorm   | RV-D-001  | AVAILABLE   | 90   | DOR-F-M-01  | YES
  //   dorm   | RV-D-002  | AVAILABLE   | 30   | DOR-F-M-02  | YES
  //   camp-a | RV-A-001  | AVAILABLE   | 70   | CPA-F-M-01  | YES
  //   camp-b | RV-B-001  | AVAILABLE   | 55   | CPB-F-M-01  | YES
  //   service| RV-S-001  | AVAILABLE   | 40   | SVC-F-M-01  | YES
  //                                                           metro=3, dorm=2, campus-a=1, campus-b=1, service=1
  // ========================================================================
  await db.rentalVehicle.createMany({
    data: [
      { id: 'RV-M-001', hubId: 'metro', type: 'E_MOTORCYCLE', vehicleClass: 'MOTORCYCLE', status: 'AVAILABLE', batteryPct: 80, parkingSpaceId: 'MET-F-M-01' },
      { id: 'RV-M-002', hubId: 'metro', type: 'E_MOTORCYCLE', vehicleClass: 'MOTORCYCLE', status: 'AVAILABLE', batteryPct: 20, parkingSpaceId: 'MET-F-M-02' },
      { id: 'RV-M-003', hubId: 'metro', type: 'E_MOTORCYCLE', vehicleClass: 'MOTORCYCLE', status: 'LOW_BATTERY', batteryPct: 19, parkingSpaceId: 'MET-F-M-03' },
      { id: 'RV-M-004', hubId: 'metro', type: 'E_MOTORCYCLE', vehicleClass: 'MOTORCYCLE', status: 'AVAILABLE', batteryPct: 50, parkingSpaceId: 'MET-F-M-04' },
      { id: 'RV-M-005', hubId: 'metro', type: 'E_MOTORCYCLE', vehicleClass: 'MOTORCYCLE', status: 'AVAILABLE', batteryPct: 60, parkingSpaceId: 'MET-F-M-05' },
      { id: 'RV-M-006', hubId: 'metro', type: 'E_MOTORCYCLE', vehicleClass: 'MOTORCYCLE', status: 'RESERVED', batteryPct: 75, parkingSpaceId: 'MET-F-M-06' },
      { id: 'RV-M-007', hubId: 'metro', type: 'E_MOTORCYCLE', vehicleClass: 'MOTORCYCLE', status: 'FAULTY', batteryPct: 45, parkingSpaceId: 'MET-F-M-07' },
      { id: 'RV-D-001', hubId: 'dorm', type: 'E_MOTORCYCLE', vehicleClass: 'MOTORCYCLE', status: 'AVAILABLE', batteryPct: 90, parkingSpaceId: 'DOR-F-M-01' },
      { id: 'RV-D-002', hubId: 'dorm', type: 'E_MOTORCYCLE', vehicleClass: 'MOTORCYCLE', status: 'AVAILABLE', batteryPct: 30, parkingSpaceId: 'DOR-F-M-02' },
      { id: 'RV-A-001', hubId: 'campus-a', type: 'E_MOTORCYCLE', vehicleClass: 'MOTORCYCLE', status: 'AVAILABLE', batteryPct: 70, parkingSpaceId: 'CPA-F-M-01' },
      { id: 'RV-B-001', hubId: 'campus-b', type: 'E_MOTORCYCLE', vehicleClass: 'MOTORCYCLE', status: 'AVAILABLE', batteryPct: 55, parkingSpaceId: 'CPB-F-M-01' },
      { id: 'RV-S-001', hubId: 'service', type: 'E_MOTORCYCLE', vehicleClass: 'MOTORCYCLE', status: 'AVAILABLE', batteryPct: 40, parkingSpaceId: 'SVC-F-M-01' },
    ],
  });

  // ---- vehicle reservation (CONFIRMED for RV-M-006 by student2) ----
  await db.vehicleReservation.create({
    data: {
      id: 'VR-001',
      userId: 'student2',
      rentalVehicleId: 'RV-M-006',
      hubId: 'metro',
      status: 'CONFIRMED',
      expiresAt: rel(now, min(15)),
    },
  });

  // ---- parking reservations ----
  // PR-M-001: future CONFIRMED on MET-P-M-02 — overlaps test window [now+2h, now+4h]
  // PR-M-002: current CONFIRMED on MET-P-M-03 — does NOT overlap test window
  // PR-M-003: current ACTIVE on MET-P-M-04 — does NOT overlap test window
  // PR-M-004: CANCELLED on MET-P-M-06 — overlaps test window but CANCELLED → ignored
  // PR-C-001: CONFIRMED on MET-P-C-02
  // PR-C-002: ACTIVE on MET-P-C-03
  await db.parkingReservation.createMany({
    data: [
      { id: 'PR-M-001', userId: 'student1', parkingSpaceId: 'MET-P-M-02', hubId: 'metro', vehicleClass: 'MOTORCYCLE', windowStart: rel(now, hr(2.5)), windowEnd: rel(now, hr(3.5)), status: 'CONFIRMED', expiresAt: rel(now, hr(2.5) + min(15)) },
      { id: 'PR-M-002', userId: 'student1', parkingSpaceId: 'MET-P-M-03', hubId: 'metro', vehicleClass: 'MOTORCYCLE', windowStart: rel(now, -min(5)), windowEnd: rel(now, hr(1)), status: 'CONFIRMED', expiresAt: rel(now, min(10)) },
      { id: 'PR-M-003', userId: 'student1', parkingSpaceId: 'MET-P-M-04', hubId: 'metro', vehicleClass: 'MOTORCYCLE', windowStart: rel(now, -min(30)), windowEnd: rel(now, hr(1.5)), status: 'ACTIVE', claimedAt: rel(now, -min(25)), expiresAt: rel(now, -min(15)) },
      { id: 'PR-M-004', userId: 'student2', parkingSpaceId: 'MET-P-M-06', hubId: 'metro', vehicleClass: 'MOTORCYCLE', windowStart: rel(now, hr(2)), windowEnd: rel(now, hr(4)), status: 'CANCELLED', expiresAt: rel(now, hr(2) + min(15)) },
      { id: 'PR-C-001', userId: 'student2', parkingSpaceId: 'MET-P-C-02', hubId: 'metro', vehicleClass: 'CAR', windowStart: rel(now, -min(5)), windowEnd: rel(now, hr(2)), status: 'CONFIRMED', expiresAt: rel(now, min(10)) },
      { id: 'PR-C-002', userId: 'student2', parkingSpaceId: 'MET-P-C-03', hubId: 'metro', vehicleClass: 'CAR', windowStart: rel(now, -min(30)), windowEnd: rel(now, hr(3)), status: 'ACTIVE', claimedAt: rel(now, -min(25)), expiresAt: rel(now, -min(15)) },
    ],
  });

  // ---- charging requests ----
  // CR-M-001: CHARGING on MET-CP-M-02 for RV-M-004 (makes RV-M-004 not available, D-18)
  // CR-M-002: QUEUED for RV-M-005 — no point (QUEUED ≠ CHARGING, so RV-M-005 stays available)
  // CR-M-003: SCHEDULED on MET-CP-M-04, PEV-02, slot [now+2.5h, now+3.5h] — overlaps test window
  // CR-M-004: SCHEDULED on MET-CP-M-05, PEV-03, slot [now+1h, now+2h] — touches but doesn't overlap [now+2h, now+4h]
  // CR-C-001: CHARGING on MET-CP-C-01 for PEV-01 — drives CAR charging to 100%
  await db.chargingRequest.createMany({
    data: [
      { id: 'CR-M-001', requestedById: 'operator1', vehicleKind: 'RENTAL', rentalVehicleId: 'RV-M-004', vehicleClass: 'MOTORCYCLE', hubId: 'metro', mode: 'QUEUE', status: 'CHARGING', targetPct: 100, startPct: 40, currentPct: 50, chargingPointId: 'MET-CP-M-02', slotStart: rel(now, -min(10)), slotEnd: rel(now, min(30)), startedAt: rel(now, -min(10)) },
      { id: 'CR-M-002', requestedById: 'student1', ownerId: 'student1', vehicleKind: 'RENTAL', rentalVehicleId: 'RV-M-005', vehicleClass: 'MOTORCYCLE', hubId: 'metro', mode: 'QUEUE', status: 'QUEUED', targetPct: 100, startPct: 60, currentPct: 60, desiredTime: rel(now, -min(5)) },
      { id: 'CR-M-003', requestedById: 'student2', ownerId: 'student2', vehicleKind: 'PRIVATE', privateEvId: 'PEV-02', vehicleClass: 'MOTORCYCLE', hubId: 'metro', mode: 'ADVANCE', status: 'SCHEDULED', targetPct: 90, startPct: 70, currentPct: 70, chargingPointId: 'MET-CP-M-04', slotStart: rel(now, hr(2.5)), slotEnd: rel(now, hr(3.5)) },
      { id: 'CR-M-004', requestedById: 'student1', ownerId: 'student1', vehicleKind: 'PRIVATE', privateEvId: 'PEV-03', vehicleClass: 'MOTORCYCLE', hubId: 'metro', mode: 'ADVANCE', status: 'SCHEDULED', targetPct: 85, startPct: 55, currentPct: 55, chargingPointId: 'MET-CP-M-05', slotStart: rel(now, hr(1)), slotEnd: rel(now, hr(2)) },
      { id: 'CR-C-001', requestedById: 'student1', ownerId: 'student1', vehicleKind: 'PRIVATE', privateEvId: 'PEV-01', vehicleClass: 'CAR', hubId: 'metro', mode: 'QUEUE', status: 'CHARGING', targetPct: 90, startPct: 50, currentPct: 60, chargingPointId: 'MET-CP-C-01', slotStart: rel(now, -min(5)), slotEnd: rel(now, min(45)), startedAt: rel(now, -min(5)) },
    ],
  });

  // ---- hub redirect: metro → dorm ----
  await db.hubRedirect.create({
    data: {
      id: 'HR-001',
      fromHubId: 'metro',
      toHubId: 'dorm',
      activeUntil: rel(now, hr(1)),
      createdById: 'operator1',
    },
  });
}

// ========================================================================
// FIXTURE expected counts per Hub
// ========================================================================
//
//  Hub       | avail | prk MOTO (both)  | prk MOTO (pub) | prk CAR (=pub)  | chg MOTO       | chg CAR        | near | deg  | redir
//            | veh   | f  t  util       | f  t  util     | f  t  util      | f  t  util     | f  t  util     | cap  |      |
//  ----------|-------|------------------|----------------|-----------------|----------------|----------------|------|------|------
//  metro     |  3    | 5  15 64.3       | 3  6  40.0     | 1  3  66.7      | 3  5  25.0     | 0  1 100.0     | true | false| dorm
//  dorm      |  2    | 3  5  40.0       | 2  2   0.0     | 1  1   0.0      | 1  1   0.0     | 1  1   0.0     | false| false| null
//  campus-a  |  1    | 2  3  33.3       | 1  1   0.0     | 1  1   0.0      | 1  1   0.0     | 1  1   0.0     | false| false| null
//  campus-b  |  1    | 2  3  33.3       | 1  1   0.0     | 1  1   0.0      | 1  1   0.0     | 0  1 100.0     | true | false| null
//  service   |  1    | 2  3  33.3       | 1  1   0.0     | 0  0   0.0      | 1  1   0.0     | 0  0   0.0     | false| true | null
//
// ========================================================================

export const FIXTURE = {
  hubs: ['campus-a', 'campus-b', 'dorm', 'metro', 'service'],
  metro: {
    availableRentalVehicles: 3,
    parking: {
      MOTORCYCLE: { free: 5, total: 15, utilPct: 64.3 },
      CAR: { free: 1, total: 3, utilPct: 66.7 },
    },
    publicParking: {
      MOTORCYCLE: { free: 3, total: 6, utilPct: 40.0 },
      CAR: { free: 1, total: 3, utilPct: 66.7 },
    },
    charging: {
      MOTORCYCLE: { free: 3, total: 5, utilPct: 25.0 },
      CAR: { free: 0, total: 1, utilPct: 100.0 },
    },
    nearCapacity: true,
    degraded: false,
    redirectToHubId: 'dorm',
    vehicleCount: 7,
    parkingSpaceCount: 18,
    chargingPointCount: 6,
  },
  dorm: {
    availableRentalVehicles: 2,
    parking: {
      MOTORCYCLE: { free: 3, total: 5, utilPct: 40.0 },
      CAR: { free: 1, total: 1, utilPct: 0.0 },
    },
    publicParking: {
      MOTORCYCLE: { free: 2, total: 2, utilPct: 0.0 },
      CAR: { free: 1, total: 1, utilPct: 0.0 },
    },
    charging: {
      MOTORCYCLE: { free: 1, total: 1, utilPct: 0.0 },
      CAR: { free: 1, total: 1, utilPct: 0.0 },
    },
    nearCapacity: false,
    degraded: false,
    redirectToHubId: null,
  },
  'campus-a': {
    availableRentalVehicles: 1,
    parking: {
      MOTORCYCLE: { free: 2, total: 3, utilPct: 33.3 },
      CAR: { free: 1, total: 1, utilPct: 0.0 },
    },
    publicParking: {
      MOTORCYCLE: { free: 1, total: 1, utilPct: 0.0 },
      CAR: { free: 1, total: 1, utilPct: 0.0 },
    },
    charging: {
      MOTORCYCLE: { free: 1, total: 1, utilPct: 0.0 },
      CAR: { free: 1, total: 1, utilPct: 0.0 },
    },
    nearCapacity: false,
    degraded: false,
    redirectToHubId: null,
  },
  'campus-b': {
    availableRentalVehicles: 1,
    parking: {
      MOTORCYCLE: { free: 2, total: 3, utilPct: 33.3 },
      CAR: { free: 1, total: 1, utilPct: 0.0 },
    },
    publicParking: {
      MOTORCYCLE: { free: 1, total: 1, utilPct: 0.0 },
      CAR: { free: 1, total: 1, utilPct: 0.0 },
    },
    charging: {
      MOTORCYCLE: { free: 1, total: 1, utilPct: 0.0 },
      CAR: { free: 0, total: 1, utilPct: 100.0 },
    },
    nearCapacity: true,
    degraded: false,
    redirectToHubId: null,
  },
  service: {
    availableRentalVehicles: 1,
    parking: {
      MOTORCYCLE: { free: 2, total: 3, utilPct: 33.3 },
      CAR: { free: 0, total: 0, utilPct: 0.0 },
    },
    publicParking: {
      MOTORCYCLE: { free: 1, total: 1, utilPct: 0.0 },
      CAR: { free: 0, total: 0, utilPct: 0.0 },
    },
    charging: {
      MOTORCYCLE: { free: 1, total: 1, utilPct: 0.0 },
      CAR: { free: 0, total: 0, utilPct: 0.0 },
    },
    nearCapacity: false,
    degraded: true,
    redirectToHubId: null,
  },
} as const;
