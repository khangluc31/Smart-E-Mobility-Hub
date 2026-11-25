/**
 * Checker tests for T-02: Prisma schema + DB constraints
 *
 * Written from AGENTS.md, SPEC.md §4–6 §8, ARCHITECTURE.md §5, CONTRACTS.md §1,
 * and TASKS.md T-02 ONLY — before reading the implementation.
 *
 * Rules: verify only. Never change src/, prisma/, config, docs or .orchestration/.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';

const db = new PrismaClient();

afterAll(() => db.$disconnect());

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Truncate all tables. TRUNCATE is not blocked by the audit_log trigger. */
async function clean() {
  await db.$executeRawUnsafe(`
    TRUNCATE TABLE
      sim_recommendation, sim_run, sim_scenario,
      audit_log,
      telemetry_reject,
      alert,
      incident_impact, incident_report, incident,
      notification,
      redistribution_task_vehicle, redistribution_task,
      idempotency_key,
      charging_request,
      parking_reservation,
      vehicle_reservation,
      private_ev,
      charging_point,
      parking_space,
      rental_vehicle,
      hub_threshold, hub_redirect, setting,
      hub, "user"
    RESTART IDENTITY CASCADE
  `);
}

/**
 * Assert the promise rejects with a Postgres violation.
 * Checks that at least one of the given PG SQLSTATE codes appears anywhere in
 * the thrown error's message, code, or meta JSON.
 * AC-6 already confirms constraint names exist — we assert codes here.
 */
async function expectViolation(p: Promise<unknown>, ...pgCodes: string[]): Promise<void> {
  let threw = false;
  try {
    await p;
  } catch (err) {
    threw = true;
    const e = err as { message?: string; code?: string; meta?: unknown };
    const hay = [e.message ?? '', e.code ?? '', JSON.stringify(e.meta ?? '')].join(' | ');
    const matched = pgCodes.some((c) => hay.includes(c));
    if (!matched) {
      throw new Error(
        `Expected one of [${pgCodes.join(', ')}] in DB error but got: ${hay.slice(0, 500)}`,
      );
    }
  }
  if (!threw) {
    throw new Error(`Expected a DB violation (${pgCodes.join(', ')}) but the write succeeded`);
  }
}

async function mkHub(id: string) {
  await db.$executeRaw`
    INSERT INTO hub (id, name, location, "createdAt")
    VALUES (${id}, ${id}, 'loc', NOW())
    ON CONFLICT (id) DO NOTHING`;
}

async function mkUser(id: string) {
  await db.$executeRaw`
    INSERT INTO "user" (id, identifier, "passwordHash", "displayName", role, "mustChangePassword", "createdAt")
    VALUES (${id}, ${id}, 'hash', ${id}, 'STUDENT', false, NOW())
    ON CONFLICT (id) DO NOTHING`;
}

async function mkVehicle(id: string, hubId: string, batteryPct = 50) {
  await db.$executeRaw`
    INSERT INTO rental_vehicle (id, "hubId", type, "vehicleClass", status, "batteryPct", "updatedAt")
    VALUES (${id}, ${hubId}, 'E_BICYCLE', 'MOTORCYCLE', 'AVAILABLE', ${batteryPct}, NOW())
    ON CONFLICT (id) DO NOTHING`;
}

async function mkParkingSpace(id: string, hubId: string) {
  await db.$executeRaw`
    INSERT INTO parking_space (id, "hubId", "vehicleClass", pool, status)
    VALUES (${id}, ${hubId}, 'MOTORCYCLE', 'PUBLIC', 'FREE')
    ON CONFLICT (id) DO NOTHING`;
}

async function mkChargingPoint(id: string, hubId: string) {
  await db.$executeRaw`
    INSERT INTO charging_point (id, "hubId", "vehicleClass", status)
    VALUES (${id}, ${hubId}, 'MOTORCYCLE', 'AVAILABLE')
    ON CONFLICT (id) DO NOTHING`;
}

async function mkPrivateEv(id: string, ownerId: string) {
  await db.$executeRaw`
    INSERT INTO private_ev (id, "ownerId", type, "vehicleClass", label, "batteryCapacityKwh", "batteryPct")
    VALUES (${id}, ${ownerId}, 'E_MOTORCYCLE', 'MOTORCYCLE', 'ev', 10.0, 50.0)
    ON CONFLICT (id) DO NOTHING`;
}

// ---------------------------------------------------------------------------
// AC-2  All §5.1 tables exist in Postgres
// ---------------------------------------------------------------------------

describe('T-02 AC-2 all ARCHITECTURE §5.1 tables exist', () => {
  async function tableExists(name: string): Promise<boolean> {
    const rows = await db.$queryRaw<{ tablename: string }[]>`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public' AND tablename = ${name}`;
    return rows.length === 1;
  }

  const tables = [
    'user', 'hub', 'hub_threshold', 'hub_redirect', 'setting',
    'rental_vehicle', 'private_ev', 'parking_space', 'charging_point',
    'vehicle_reservation', 'parking_reservation', 'charging_request', 'idempotency_key',
    'incident', 'incident_report', 'incident_impact',
    'redistribution_task', 'redistribution_task_vehicle',
    'notification', 'audit_log', 'telemetry_reject',
    'alert',
    'sim_scenario', 'sim_run', 'sim_recommendation',
  ];

  for (const t of tables) {
    it(`table "${t}" exists`, async () => {
      expect(await tableExists(t)).toBe(true);
    });
  }

  it('charging_point has NO currentRequestId column (D-04 removed it)', async () => {
    const rows = await db.$queryRaw<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'charging_point' AND column_name = 'currentRequestId'`;
    expect(rows).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// AC-3  Enum values match CONTRACTS §1
// ---------------------------------------------------------------------------

describe('T-02 AC-3 enum values match CONTRACTS §1', () => {
  async function enumValues(typname: string): Promise<string[]> {
    const rows = await db.$queryRaw<{ enumlabel: string }[]>`
      SELECT e.enumlabel
      FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = ${typname}
      ORDER BY e.enumsortorder`;
    return rows.map((r) => r.enumlabel);
  }

  // ScenarioTemplate is intentionally omitted: the orchestrator approved keeping
  // scenario templates as free-form JSON inside sim_scenario.conditions.
  const cases: Array<[string, string[]]> = [
    ['Role', ['STUDENT', 'OPERATOR']],
    ['VehicleClass', ['MOTORCYCLE', 'CAR']],
    ['RentalVehicleType', ['E_BICYCLE', 'E_MOTORCYCLE']],
    ['PrivateEvType', ['E_MOTORCYCLE', 'CAR']],
    ['RentalVehicleStatus', ['AVAILABLE', 'RESERVED', 'IN_USE', 'LOW_BATTERY', 'IN_TRANSIT', 'FAULTY']],
    ['ReservationStatus', ['CONFIRMED', 'ACTIVE', 'COMPLETED', 'CANCELLED', 'EXPIRED']],
    ['ParkingSpaceStatus', ['FREE', 'RESERVED', 'OCCUPIED', 'UNAVAILABLE']],
    ['ParkingPool', ['FLEET', 'PUBLIC']],
    ['ChargingPointStatus', ['AVAILABLE', 'CHARGING', 'FAULTY']],
    ['ChargingRequestStatus', ['QUEUED', 'SCHEDULED', 'CHARGING', 'COMPLETED', 'CANCELLED']],
    ['ChargingMode', ['QUEUE', 'ADVANCE']],
    ['ChargingEndReason', ['TARGET_REACHED', 'USER_STOP', 'POINT_FAILURE', 'VEHICLE_FAULT']],
    ['IncidentStatus', ['REPORTED', 'IN_MAINTENANCE', 'RESOLVED']],
    ['IncidentResourceType', ['RENTAL_VEHICLE', 'PARKING_SPACE', 'CHARGING_POINT']],
    ['IncidentCategory', ['VEHICLE_FAULT', 'BATTERY_FAULT', 'CHARGER_FAULT', 'ELECTRICAL',
      'EMERGENCY_DISCONNECT', 'DAMAGE', 'OBSTRUCTION', 'OTHER']],
    ['IncidentSource', ['OPERATOR', 'STUDENT', 'TELEMETRY']],
    ['AlertType', ['NEAR_CAPACITY', 'LOW_BATTERY', 'FAULT', 'STALLED_FEED', 'SHORTAGE', 'SURPLUS']],
    ['AlertStatus', ['OPEN', 'ACKNOWLEDGED', 'DISMISSED', 'RESOLVED']],
    ['RedistributionStatus', ['PROPOSED', 'APPROVED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'FAILED']],
    ['SimRunStatus', ['RUNNING', 'COMPLETED', 'FAILED', 'INCOMPLETE']],
    ['RecommendationType', ['REDISTRIBUTE', 'CHARGING_ADJUST', 'REDIRECT']],
    ['RecommendationStatus', ['PENDING', 'APPLIED', 'DISMISSED', 'BLOCKED']],
    // from ARCHITECTURE §5.1
    ['ChargingVehicleKind', ['RENTAL', 'PRIVATE']],
    ['VehicleReservationEndReason', ['RETURNED', 'CANCELLED', 'EXPIRED', 'INCIDENT']],
    ['ImpactBookingType', ['VEHICLE_RESERVATION', 'PARKING_RESERVATION', 'CHARGING_REQUEST']],
    ['ImpactOutcome', ['REASSIGNED', 'CANCELLED', 'ENDED']],
    ['RedistributionOrigin', ['MANUAL', 'SIMULATION']],
  ];

  for (const [typname, expected] of cases) {
    it(`enum "${typname}" has exactly the CONTRACTS §1 values`, async () => {
      const actual = await enumValues(typname);
      expect(actual.sort()).toEqual(expected.slice().sort());
    });
  }
});

// ---------------------------------------------------------------------------
// AC-6  Every §5.2 object exists by name
// ---------------------------------------------------------------------------

describe('T-02 AC-6 every constraint, index, trigger and extension exists by name', () => {
  it('btree_gist extension is installed', async () => {
    const rows = await db.$queryRaw<{ extname: string }[]>`
      SELECT extname FROM pg_extension WHERE extname = 'btree_gist'`;
    expect(rows).toHaveLength(1);
  });

  const uniqueIndexes = [
    'uq_vres_active_user',
    'uq_vres_active_vehicle',
    'uq_charge_active_rental',
    'uq_charge_active_pev',
    'uq_incident_open',
    'uq_alert_open',
  ];
  for (const idx of uniqueIndexes) {
    it(`partial unique index "${idx}" exists in pg_indexes`, async () => {
      const rows = await db.$queryRaw<{ indexname: string }[]>`
        SELECT indexname FROM pg_indexes WHERE indexname = ${idx}`;
      expect(rows).toHaveLength(1);
    });
  }

  const exclusionConstraints = ['ex_parking_overlap', 'ex_charging_overlap'];
  for (const con of exclusionConstraints) {
    it(`exclusion constraint "${con}" exists in pg_constraint`, async () => {
      const rows = await db.$queryRaw<{ conname: string }[]>`
        SELECT conname FROM pg_constraint WHERE conname = ${con} AND contype = 'x'`;
      expect(rows).toHaveLength(1);
    });
  }

  const checkConstraints = [
    'ck_rv_battery',
    'ck_pev_battery',
    'ck_pr_window',
    'ck_cr_target',
    'ck_cr_slot',
  ];
  for (const ck of checkConstraints) {
    it(`check constraint "${ck}" exists in pg_constraint`, async () => {
      const rows = await db.$queryRaw<{ conname: string }[]>`
        SELECT conname FROM pg_constraint WHERE conname = ${ck} AND contype = 'c'`;
      expect(rows).toHaveLength(1);
    });
  }

  it('trigger "audit_log_no_update" exists in pg_trigger', async () => {
    const rows = await db.$queryRaw<{ tgname: string }[]>`
      SELECT tgname FROM pg_trigger WHERE tgname = 'audit_log_no_update'`;
    expect(rows).toHaveLength(1);
  });

  it('function "forbid_change" exists in pg_proc', async () => {
    const rows = await db.$queryRaw<{ proname: string }[]>`
      SELECT proname FROM pg_proc WHERE proname = 'forbid_change'`;
    expect(rows.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// AC-7  BR-01 — one active vehicle reservation per Student
// ---------------------------------------------------------------------------

describe('T-02 AC-7 BR-01 one active vehicle reservation per student', () => {
  beforeEach(async () => {
    await clean();
    await mkHub('h1');
    await mkUser('u1');
    await mkVehicle('v1', 'h1');
    await mkVehicle('v2', 'h1');
  });

  it('T-02 AC-7 BR-01 second CONFIRMED reservation for same user is rejected (uq_vres_active_user)', async () => {
    await db.$executeRaw`
      INSERT INTO vehicle_reservation
        (id, "userId", "rentalVehicleId", "hubId", status, "expiresAt", "createdAt")
      VALUES ('r1', 'u1', 'v1', 'h1', 'CONFIRMED', NOW() + INTERVAL '15 min', NOW())`;

    await expectViolation(
      db.$executeRaw`
        INSERT INTO vehicle_reservation
          (id, "userId", "rentalVehicleId", "hubId", status, "expiresAt", "createdAt")
        VALUES ('r2', 'u1', 'v2', 'h1', 'CONFIRMED', NOW() + INTERVAL '15 min', NOW())`,
      '23505',
    );
  });

  it('T-02 AC-7 BR-01 CANCELLED + CONFIRMED for same user is allowed', async () => {
    await db.$executeRaw`
      INSERT INTO vehicle_reservation
        (id, "userId", "rentalVehicleId", "hubId", status, "expiresAt", "createdAt")
      VALUES ('r1', 'u1', 'v1', 'h1', 'CANCELLED', NOW() + INTERVAL '15 min', NOW())`;

    await expect(
      db.$executeRaw`
        INSERT INTO vehicle_reservation
          (id, "userId", "rentalVehicleId", "hubId", status, "expiresAt", "createdAt")
        VALUES ('r2', 'u1', 'v2', 'h1', 'CONFIRMED', NOW() + INTERVAL '15 min', NOW())`,
    ).resolves.not.toThrow();
  });

  it('T-02 AC-7 BR-01 second ACTIVE reservation for same user is rejected', async () => {
    await db.$executeRaw`
      INSERT INTO vehicle_reservation
        (id, "userId", "rentalVehicleId", "hubId", status, "expiresAt", "createdAt")
      VALUES ('r1', 'u1', 'v1', 'h1', 'ACTIVE', NOW() + INTERVAL '15 min', NOW())`;

    await expectViolation(
      db.$executeRaw`
        INSERT INTO vehicle_reservation
          (id, "userId", "rentalVehicleId", "hubId", status, "expiresAt", "createdAt")
        VALUES ('r2', 'u1', 'v2', 'h1', 'CONFIRMED', NOW() + INTERVAL '15 min', NOW())`,
      '23505',
    );
  });
});

// ---------------------------------------------------------------------------
// AC-7  BR-01 — one active reservation per rental vehicle
// ---------------------------------------------------------------------------

describe('T-02 AC-7 BR-01 one active reservation per rental vehicle', () => {
  beforeEach(async () => {
    await clean();
    await mkHub('h1');
    await mkUser('u1');
    await mkUser('u2');
    await mkVehicle('v1', 'h1');
  });

  it('T-02 AC-7 BR-01 second CONFIRMED reservation for same vehicle is rejected (uq_vres_active_vehicle)', async () => {
    await db.$executeRaw`
      INSERT INTO vehicle_reservation
        (id, "userId", "rentalVehicleId", "hubId", status, "expiresAt", "createdAt")
      VALUES ('r1', 'u1', 'v1', 'h1', 'CONFIRMED', NOW() + INTERVAL '15 min', NOW())`;

    await expectViolation(
      db.$executeRaw`
        INSERT INTO vehicle_reservation
          (id, "userId", "rentalVehicleId", "hubId", status, "expiresAt", "createdAt")
        VALUES ('r2', 'u2', 'v1', 'h1', 'CONFIRMED', NOW() + INTERVAL '15 min', NOW())`,
      '23505',
    );
  });
});

// ---------------------------------------------------------------------------
// AC-7  BR-10 — overlapping parking windows
// parking_reservation columns: id, userId, parkingSpaceId, hubId, vehicleClass,
//   privateEvId, windowStart, windowEnd, status, claimedAt, expiresAt,
//   bookingGroupId, idempotencyKey  — no createdAt
// ---------------------------------------------------------------------------

describe('T-02 AC-7 BR-10 overlapping parking windows rejected, touching windows allowed', () => {
  beforeEach(async () => {
    await clean();
    await mkHub('h1');
    await mkUser('u1');
    await mkUser('u2');
    await mkParkingSpace('ps1', 'h1');
  });

  it('T-02 AC-7 BR-10 overlapping CONFIRMED parking reservations on same space are rejected (ex_parking_overlap)', async () => {
    await db.$executeRaw`
      INSERT INTO parking_reservation
        (id, "userId", "parkingSpaceId", "hubId", "vehicleClass", "windowStart", "windowEnd", status, "expiresAt")
      VALUES ('pr1', 'u1', 'ps1', 'h1', 'MOTORCYCLE',
              '2030-01-01T10:00:00Z', '2030-01-01T12:00:00Z',
              'CONFIRMED', '2030-01-01T10:15:00Z')`;

    await expectViolation(
      db.$executeRaw`
        INSERT INTO parking_reservation
          (id, "userId", "parkingSpaceId", "hubId", "vehicleClass", "windowStart", "windowEnd", status, "expiresAt")
        VALUES ('pr2', 'u2', 'ps1', 'h1', 'MOTORCYCLE',
                '2030-01-01T11:00:00Z', '2030-01-01T13:00:00Z',
                'CONFIRMED', '2030-01-01T11:15:00Z')`,
      '23P01',
    );
  });

  it('T-02 AC-7 BR-10 touching parking windows (non-overlapping) are allowed', async () => {
    await db.$executeRaw`
      INSERT INTO parking_reservation
        (id, "userId", "parkingSpaceId", "hubId", "vehicleClass", "windowStart", "windowEnd", status, "expiresAt")
      VALUES ('pr1', 'u1', 'ps1', 'h1', 'MOTORCYCLE',
              '2030-01-01T10:00:00Z', '2030-01-01T12:00:00Z',
              'CONFIRMED', '2030-01-01T10:15:00Z')`;

    await expect(
      db.$executeRaw`
        INSERT INTO parking_reservation
          (id, "userId", "parkingSpaceId", "hubId", "vehicleClass", "windowStart", "windowEnd", status, "expiresAt")
        VALUES ('pr2', 'u2', 'ps1', 'h1', 'MOTORCYCLE',
                '2030-01-01T12:00:00Z', '2030-01-01T14:00:00Z',
                'CONFIRMED', '2030-01-01T12:15:00Z')`,
    ).resolves.not.toThrow();
  });

  it('T-02 AC-7 BR-10 overlapping window where one is CANCELLED is allowed', async () => {
    await db.$executeRaw`
      INSERT INTO parking_reservation
        (id, "userId", "parkingSpaceId", "hubId", "vehicleClass", "windowStart", "windowEnd", status, "expiresAt")
      VALUES ('pr1', 'u1', 'ps1', 'h1', 'MOTORCYCLE',
              '2030-01-01T10:00:00Z', '2030-01-01T12:00:00Z',
              'CANCELLED', '2030-01-01T10:15:00Z')`;

    await expect(
      db.$executeRaw`
        INSERT INTO parking_reservation
          (id, "userId", "parkingSpaceId", "hubId", "vehicleClass", "windowStart", "windowEnd", status, "expiresAt")
        VALUES ('pr2', 'u2', 'ps1', 'h1', 'MOTORCYCLE',
                '2030-01-01T11:00:00Z', '2030-01-01T13:00:00Z',
                'CONFIRMED', '2030-01-01T11:15:00Z')`,
    ).resolves.not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// AC-7  FR-49 — no overlapping charging slots on one charging point
// ---------------------------------------------------------------------------

describe('T-02 AC-7 FR-49 overlapping charging slots on one point rejected', () => {
  beforeEach(async () => {
    await clean();
    await mkHub('h1');
    await mkUser('u1');
    await mkVehicle('v1', 'h1');
    await mkVehicle('v2', 'h1');
    await mkChargingPoint('cp1', 'h1');
  });

  it('T-02 AC-7 FR-49 overlapping SCHEDULED slots on one charging point are rejected (ex_charging_overlap)', async () => {
    await db.$executeRaw`
      INSERT INTO charging_request
        (id, "requestedById", "vehicleKind", "rentalVehicleId", "vehicleClass", "hubId",
         mode, status, "targetPct", "startPct", "currentPct", "desiredTime",
         "chargingPointId", "slotStart", "slotEnd", "createdAt")
      VALUES ('cr1', 'u1', 'RENTAL', 'v1', 'MOTORCYCLE', 'h1',
              'ADVANCE', 'SCHEDULED', 80, 20, 20, NOW(),
              'cp1', '2030-01-01T10:00:00Z', '2030-01-01T11:00:00Z', NOW())`;

    await expectViolation(
      db.$executeRaw`
        INSERT INTO charging_request
          (id, "requestedById", "vehicleKind", "rentalVehicleId", "vehicleClass", "hubId",
           mode, status, "targetPct", "startPct", "currentPct", "desiredTime",
           "chargingPointId", "slotStart", "slotEnd", "createdAt")
        VALUES ('cr2', 'u1', 'RENTAL', 'v2', 'MOTORCYCLE', 'h1',
                'ADVANCE', 'SCHEDULED', 80, 30, 30, NOW(),
                'cp1', '2030-01-01T10:30:00Z', '2030-01-01T11:30:00Z', NOW())`,
      '23P01',
    );
  });

  it('T-02 AC-7 FR-49 non-overlapping slots on one point are allowed', async () => {
    await db.$executeRaw`
      INSERT INTO charging_request
        (id, "requestedById", "vehicleKind", "rentalVehicleId", "vehicleClass", "hubId",
         mode, status, "targetPct", "startPct", "currentPct", "desiredTime",
         "chargingPointId", "slotStart", "slotEnd", "createdAt")
      VALUES ('cr1', 'u1', 'RENTAL', 'v1', 'MOTORCYCLE', 'h1',
              'ADVANCE', 'SCHEDULED', 80, 20, 20, NOW(),
              'cp1', '2030-01-01T10:00:00Z', '2030-01-01T11:00:00Z', NOW())`;

    await expect(
      db.$executeRaw`
        INSERT INTO charging_request
          (id, "requestedById", "vehicleKind", "rentalVehicleId", "vehicleClass", "hubId",
           mode, status, "targetPct", "startPct", "currentPct", "desiredTime",
           "chargingPointId", "slotStart", "slotEnd", "createdAt")
        VALUES ('cr2', 'u1', 'RENTAL', 'v2', 'MOTORCYCLE', 'h1',
                'ADVANCE', 'SCHEDULED', 80, 30, 30, NOW(),
                'cp1', '2030-01-01T11:00:00Z', '2030-01-01T12:00:00Z', NOW())`,
    ).resolves.not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// AC-7  one live charging request per rental vehicle
// ---------------------------------------------------------------------------

describe('T-02 AC-7 one live charging request per rental vehicle (uq_charge_active_rental)', () => {
  beforeEach(async () => {
    await clean();
    await mkHub('h1');
    await mkUser('u1');
    await mkVehicle('v1', 'h1');
  });

  it('T-02 AC-7 second QUEUED charging request for same rental vehicle is rejected', async () => {
    await db.$executeRaw`
      INSERT INTO charging_request
        (id, "requestedById", "vehicleKind", "rentalVehicleId", "vehicleClass", "hubId",
         mode, status, "targetPct", "startPct", "currentPct", "desiredTime", "createdAt")
      VALUES ('cr1', 'u1', 'RENTAL', 'v1', 'MOTORCYCLE', 'h1',
              'QUEUE', 'QUEUED', 80, 20, 20, NOW(), NOW())`;

    await expectViolation(
      db.$executeRaw`
        INSERT INTO charging_request
          (id, "requestedById", "vehicleKind", "rentalVehicleId", "vehicleClass", "hubId",
           mode, status, "targetPct", "startPct", "currentPct", "desiredTime", "createdAt")
        VALUES ('cr2', 'u1', 'RENTAL', 'v1', 'MOTORCYCLE', 'h1',
                'QUEUE', 'QUEUED', 90, 20, 20, NOW(), NOW())`,
      '23505',
    );
  });

  it('T-02 AC-7 COMPLETED charging request does not block a new QUEUED one', async () => {
    await db.$executeRaw`
      INSERT INTO charging_request
        (id, "requestedById", "vehicleKind", "rentalVehicleId", "vehicleClass", "hubId",
         mode, status, "targetPct", "startPct", "currentPct", "desiredTime", "createdAt")
      VALUES ('cr1', 'u1', 'RENTAL', 'v1', 'MOTORCYCLE', 'h1',
              'QUEUE', 'COMPLETED', 80, 20, 80, NOW(), NOW())`;

    await expect(
      db.$executeRaw`
        INSERT INTO charging_request
          (id, "requestedById", "vehicleKind", "rentalVehicleId", "vehicleClass", "hubId",
           mode, status, "targetPct", "startPct", "currentPct", "desiredTime", "createdAt")
        VALUES ('cr2', 'u1', 'RENTAL', 'v1', 'MOTORCYCLE', 'h1',
                'QUEUE', 'QUEUED', 100, 80, 80, NOW(), NOW())`,
    ).resolves.not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// AC-7  one live charging request per private EV
// ---------------------------------------------------------------------------

describe('T-02 AC-7 one live charging request per private EV (uq_charge_active_pev)', () => {
  beforeEach(async () => {
    await clean();
    await mkHub('h1');
    await mkUser('u1');
    await mkPrivateEv('pev1', 'u1');
  });

  it('T-02 AC-7 second QUEUED charging request for same private EV is rejected', async () => {
    await db.$executeRaw`
      INSERT INTO charging_request
        (id, "requestedById", "vehicleKind", "privateEvId", "vehicleClass", "hubId",
         mode, status, "targetPct", "startPct", "currentPct", "desiredTime", "createdAt")
      VALUES ('cr1', 'u1', 'PRIVATE', 'pev1', 'MOTORCYCLE', 'h1',
              'QUEUE', 'QUEUED', 80, 20, 20, NOW(), NOW())`;

    await expectViolation(
      db.$executeRaw`
        INSERT INTO charging_request
          (id, "requestedById", "vehicleKind", "privateEvId", "vehicleClass", "hubId",
           mode, status, "targetPct", "startPct", "currentPct", "desiredTime", "createdAt")
        VALUES ('cr2', 'u1', 'PRIVATE', 'pev1', 'MOTORCYCLE', 'h1',
                'QUEUE', 'QUEUED', 90, 20, 20, NOW(), NOW())`,
      '23505',
    );
  });
});

// ---------------------------------------------------------------------------
// AC-7  UC-21 E2 — one open incident per resource
// ---------------------------------------------------------------------------

describe('T-02 AC-7 UC-21 E2 one open incident per resource', () => {
  beforeEach(async () => {
    await clean();
    await mkHub('h1');
    await mkVehicle('v1', 'h1');
  });

  it('T-02 AC-7 UC-21 E2 second REPORTED incident for same resource is rejected (uq_incident_open)', async () => {
    await db.$executeRaw`
      INSERT INTO incident
        (id, "resourceType", "resourceId", "hubId", "vehicleClass", category, notes, source, status, "createdAt")
      VALUES ('inc1', 'RENTAL_VEHICLE', 'v1', 'h1', 'MOTORCYCLE', 'DAMAGE', 'notes', 'OPERATOR', 'REPORTED', NOW())`;

    await expectViolation(
      db.$executeRaw`
        INSERT INTO incident
          (id, "resourceType", "resourceId", "hubId", "vehicleClass", category, notes, source, status, "createdAt")
        VALUES ('inc2', 'RENTAL_VEHICLE', 'v1', 'h1', 'MOTORCYCLE', 'DAMAGE', 'notes', 'OPERATOR', 'REPORTED', NOW())`,
      '23505',
    );
  });

  it('T-02 AC-7 UC-21 E2 IN_MAINTENANCE incident blocks a second open incident', async () => {
    await db.$executeRaw`
      INSERT INTO incident
        (id, "resourceType", "resourceId", "hubId", "vehicleClass", category, notes, source, status, "createdAt")
      VALUES ('inc1', 'RENTAL_VEHICLE', 'v1', 'h1', 'MOTORCYCLE', 'DAMAGE', 'notes', 'OPERATOR', 'IN_MAINTENANCE', NOW())`;

    await expectViolation(
      db.$executeRaw`
        INSERT INTO incident
          (id, "resourceType", "resourceId", "hubId", "vehicleClass", category, notes, source, status, "createdAt")
        VALUES ('inc2', 'RENTAL_VEHICLE', 'v1', 'h1', 'MOTORCYCLE', 'DAMAGE', 'notes', 'OPERATOR', 'REPORTED', NOW())`,
      '23505',
    );
  });

  it('T-02 AC-7 UC-21 E2 second open incident after first is RESOLVED is allowed', async () => {
    await db.$executeRaw`
      INSERT INTO incident
        (id, "resourceType", "resourceId", "hubId", "vehicleClass", category, notes, source, status, "createdAt")
      VALUES ('inc1', 'RENTAL_VEHICLE', 'v1', 'h1', 'MOTORCYCLE', 'DAMAGE', 'notes', 'OPERATOR', 'RESOLVED', NOW())`;

    await expect(
      db.$executeRaw`
        INSERT INTO incident
          (id, "resourceType", "resourceId", "hubId", "vehicleClass", category, notes, source, status, "createdAt")
        VALUES ('inc2', 'RENTAL_VEHICLE', 'v1', 'h1', 'MOTORCYCLE', 'DAMAGE', 'notes', 'OPERATOR', 'REPORTED', NOW())`,
    ).resolves.not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// AC-7  FR-63 — audit_log is append-only
// ---------------------------------------------------------------------------

describe('T-02 AC-7 FR-63 audit_log rejects UPDATE and DELETE, allows INSERT and TRUNCATE', () => {
  beforeEach(clean);

  it('T-02 AC-7 FR-63 INSERT into audit_log is allowed', async () => {
    await expect(
      db.$executeRaw`
        INSERT INTO audit_log (at, action, "entityType", "entityIds", details)
        VALUES (NOW(), 'TEST_ACTION', 'test', '{}', '{}')`,
    ).resolves.not.toThrow();
  });

  it('T-02 AC-7 FR-63 UPDATE on audit_log row is rejected by trigger (P0001)', async () => {
    await db.$executeRaw`
      INSERT INTO audit_log (at, action, "entityType", "entityIds", details)
      VALUES (NOW(), 'TEST_UPD', 'test', '{}', '{}')`;

    await expectViolation(
      db.$executeRaw`UPDATE audit_log SET action = 'CHANGED' WHERE action = 'TEST_UPD'`,
      'P0001',
      'audit_log is append-only',
    );
  });

  it('T-02 AC-7 FR-63 DELETE on audit_log row is rejected by trigger (P0001)', async () => {
    await db.$executeRaw`
      INSERT INTO audit_log (at, action, "entityType", "entityIds", details)
      VALUES (NOW(), 'TEST_DEL', 'test', '{}', '{}')`;

    await expectViolation(
      db.$executeRaw`DELETE FROM audit_log WHERE action = 'TEST_DEL'`,
      'P0001',
      'audit_log is append-only',
    );
  });

  it('T-02 AC-7 FR-63 TRUNCATE on audit_log is allowed (not blocked by trigger)', async () => {
    await db.$executeRaw`
      INSERT INTO audit_log (at, action, "entityType", "entityIds", details)
      VALUES (NOW(), 'TRUNC_ME', 'test', '{}', '{}')`;

    await expect(
      db.$executeRawUnsafe('TRUNCATE TABLE audit_log RESTART IDENTITY CASCADE'),
    ).resolves.not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// AC-7  NFR-13 — battery constraints (ck_rv_battery, ck_pev_battery)
// ---------------------------------------------------------------------------

describe('T-02 AC-7 NFR-13 rental vehicle battery constraints (ck_rv_battery)', () => {
  beforeEach(async () => {
    await clean();
    await mkHub('h1');
  });

  it('T-02 AC-7 NFR-13 batteryPct 0 is allowed', async () => {
    await expect(
      db.$executeRaw`
        INSERT INTO rental_vehicle (id, "hubId", type, "vehicleClass", status, "batteryPct", "updatedAt")
        VALUES ('v0', 'h1', 'E_BICYCLE', 'MOTORCYCLE', 'LOW_BATTERY', 0, NOW())`,
    ).resolves.not.toThrow();
  });

  it('T-02 AC-7 NFR-13 batteryPct 100 is allowed', async () => {
    await expect(
      db.$executeRaw`
        INSERT INTO rental_vehicle (id, "hubId", type, "vehicleClass", status, "batteryPct", "updatedAt")
        VALUES ('v100', 'h1', 'E_BICYCLE', 'MOTORCYCLE', 'AVAILABLE', 100, NOW())`,
    ).resolves.not.toThrow();
  });

  it('T-02 AC-7 NFR-13 batteryPct -1 is rejected (ck_rv_battery)', async () => {
    await expectViolation(
      db.$executeRaw`
        INSERT INTO rental_vehicle (id, "hubId", type, "vehicleClass", status, "batteryPct", "updatedAt")
        VALUES ('vneg', 'h1', 'E_BICYCLE', 'MOTORCYCLE', 'AVAILABLE', -1, NOW())`,
      '23514',
    );
  });

  it('T-02 AC-7 NFR-13 batteryPct 101 is rejected (ck_rv_battery)', async () => {
    await expectViolation(
      db.$executeRaw`
        INSERT INTO rental_vehicle (id, "hubId", type, "vehicleClass", status, "batteryPct", "updatedAt")
        VALUES ('vhi', 'h1', 'E_BICYCLE', 'MOTORCYCLE', 'AVAILABLE', 101, NOW())`,
      '23514',
    );
  });
});

describe('T-02 AC-7 NFR-13 private EV battery constraints (ck_pev_battery)', () => {
  beforeEach(async () => {
    await clean();
    await mkHub('h1');
    await mkUser('u1');
  });

  it('T-02 AC-7 NFR-13 private_ev batteryPct 0 is allowed', async () => {
    await expect(
      db.$executeRaw`
        INSERT INTO private_ev (id, "ownerId", type, "vehicleClass", label, "batteryCapacityKwh", "batteryPct")
        VALUES ('pev0', 'u1', 'E_MOTORCYCLE', 'MOTORCYCLE', 'ev', 10.0, 0)`,
    ).resolves.not.toThrow();
  });

  it('T-02 AC-7 NFR-13 private_ev batteryPct 100 is allowed', async () => {
    await expect(
      db.$executeRaw`
        INSERT INTO private_ev (id, "ownerId", type, "vehicleClass", label, "batteryCapacityKwh", "batteryPct")
        VALUES ('pev100', 'u1', 'E_MOTORCYCLE', 'MOTORCYCLE', 'ev', 10.0, 100)`,
    ).resolves.not.toThrow();
  });

  it('T-02 AC-7 NFR-13 private_ev batteryPct -1 is rejected (ck_pev_battery)', async () => {
    await expectViolation(
      db.$executeRaw`
        INSERT INTO private_ev (id, "ownerId", type, "vehicleClass", label, "batteryCapacityKwh", "batteryPct")
        VALUES ('pevneg', 'u1', 'E_MOTORCYCLE', 'MOTORCYCLE', 'ev', 10.0, -1)`,
      '23514',
    );
  });

  it('T-02 AC-7 NFR-13 private_ev batteryPct 101 is rejected (ck_pev_battery)', async () => {
    await expectViolation(
      db.$executeRaw`
        INSERT INTO private_ev (id, "ownerId", type, "vehicleClass", label, "batteryCapacityKwh", "batteryPct")
        VALUES ('pevhi', 'u1', 'E_MOTORCYCLE', 'MOTORCYCLE', 'ev', 10.0, 101)`,
      '23514',
    );
  });
});

// ---------------------------------------------------------------------------
// AC-7  ck_cr_target — charging targetPct must be > 0 and <= 100
// ---------------------------------------------------------------------------

describe('T-02 AC-7 ck_cr_target charging targetPct > 0 and <= 100', () => {
  beforeEach(async () => {
    await clean();
    await mkHub('h1');
    await mkUser('u1');
    await mkVehicle('v1', 'h1');
  });

  it('T-02 AC-7 targetPct 1 is allowed', async () => {
    await expect(
      db.$executeRaw`
        INSERT INTO charging_request
          (id, "requestedById", "vehicleKind", "rentalVehicleId", "vehicleClass", "hubId",
           mode, status, "targetPct", "startPct", "currentPct", "desiredTime", "createdAt")
        VALUES ('cr1', 'u1', 'RENTAL', 'v1', 'MOTORCYCLE', 'h1',
                'QUEUE', 'QUEUED', 1, 0, 0, NOW(), NOW())`,
    ).resolves.not.toThrow();
  });

  it('T-02 AC-7 targetPct 100 is allowed', async () => {
    await expect(
      db.$executeRaw`
        INSERT INTO charging_request
          (id, "requestedById", "vehicleKind", "rentalVehicleId", "vehicleClass", "hubId",
           mode, status, "targetPct", "startPct", "currentPct", "desiredTime", "createdAt")
        VALUES ('cr100', 'u1', 'RENTAL', 'v1', 'MOTORCYCLE', 'h1',
                'QUEUE', 'QUEUED', 100, 50, 50, NOW(), NOW())`,
    ).resolves.not.toThrow();
  });

  it('T-02 AC-7 targetPct 0 is rejected (ck_cr_target)', async () => {
    await expectViolation(
      db.$executeRaw`
        INSERT INTO charging_request
          (id, "requestedById", "vehicleKind", "rentalVehicleId", "vehicleClass", "hubId",
           mode, status, "targetPct", "startPct", "currentPct", "desiredTime", "createdAt")
        VALUES ('cr0', 'u1', 'RENTAL', 'v1', 'MOTORCYCLE', 'h1',
                'QUEUE', 'QUEUED', 0, 20, 20, NOW(), NOW())`,
      '23514',
    );
  });

  it('T-02 AC-7 targetPct 101 is rejected (ck_cr_target)', async () => {
    await expectViolation(
      db.$executeRaw`
        INSERT INTO charging_request
          (id, "requestedById", "vehicleKind", "rentalVehicleId", "vehicleClass", "hubId",
           mode, status, "targetPct", "startPct", "currentPct", "desiredTime", "createdAt")
        VALUES ('cr101', 'u1', 'RENTAL', 'v1', 'MOTORCYCLE', 'h1',
                'QUEUE', 'QUEUED', 101, 20, 20, NOW(), NOW())`,
      '23514',
    );
  });
});

// ---------------------------------------------------------------------------
// AC-7  ck_pr_window — parking windowEnd must be after windowStart
// parking_reservation has no createdAt — use only real columns
// ---------------------------------------------------------------------------

describe('T-02 AC-7 ck_pr_window parking windowEnd > windowStart', () => {
  beforeEach(async () => {
    await clean();
    await mkHub('h1');
    await mkUser('u1');
    await mkParkingSpace('ps1', 'h1');
  });

  it('T-02 AC-7 windowEnd = windowStart is rejected (ck_pr_window)', async () => {
    await expectViolation(
      db.$executeRaw`
        INSERT INTO parking_reservation
          (id, "userId", "parkingSpaceId", "hubId", "vehicleClass",
           "windowStart", "windowEnd", status, "expiresAt")
        VALUES ('pr_bad', 'u1', 'ps1', 'h1', 'MOTORCYCLE',
                '2030-01-01T10:00:00Z', '2030-01-01T10:00:00Z',
                'CONFIRMED', '2030-01-01T10:15:00Z')`,
      '23514',
    );
  });

  it('T-02 AC-7 windowEnd before windowStart is rejected (ck_pr_window)', async () => {
    await expectViolation(
      db.$executeRaw`
        INSERT INTO parking_reservation
          (id, "userId", "parkingSpaceId", "hubId", "vehicleClass",
           "windowStart", "windowEnd", status, "expiresAt")
        VALUES ('pr_rev', 'u1', 'ps1', 'h1', 'MOTORCYCLE',
                '2030-01-01T12:00:00Z', '2030-01-01T10:00:00Z',
                'CONFIRMED', '2030-01-01T12:15:00Z')`,
      '23514',
    );
  });
});

// ---------------------------------------------------------------------------
// AC-7  ck_cr_slot — SCHEDULED/CHARGING with chargingPointId must have both slot ends
// ---------------------------------------------------------------------------

describe('T-02 AC-7 ck_cr_slot SCHEDULED request with point must have valid slot times', () => {
  beforeEach(async () => {
    await clean();
    await mkHub('h1');
    await mkUser('u1');
    await mkVehicle('v1', 'h1');
    await mkChargingPoint('cp1', 'h1');
  });

  it('T-02 AC-7 SCHEDULED with chargingPointId but null slotEnd is rejected (ck_cr_slot)', async () => {
    await expectViolation(
      db.$executeRaw`
        INSERT INTO charging_request
          (id, "requestedById", "vehicleKind", "rentalVehicleId", "vehicleClass", "hubId",
           mode, status, "targetPct", "startPct", "currentPct", "desiredTime",
           "chargingPointId", "slotStart", "slotEnd", "createdAt")
        VALUES ('cr_bad', 'u1', 'RENTAL', 'v1', 'MOTORCYCLE', 'h1',
                'ADVANCE', 'SCHEDULED', 80, 20, 20, NOW(),
                'cp1', '2030-01-01T10:00:00Z', NULL, NOW())`,
      '23514',
    );
  });

  it('T-02 AC-7 SCHEDULED with chargingPointId but null slotStart is rejected (ck_cr_slot)', async () => {
    await expectViolation(
      db.$executeRaw`
        INSERT INTO charging_request
          (id, "requestedById", "vehicleKind", "rentalVehicleId", "vehicleClass", "hubId",
           mode, status, "targetPct", "startPct", "currentPct", "desiredTime",
           "chargingPointId", "slotStart", "slotEnd", "createdAt")
        VALUES ('cr_bad2', 'u1', 'RENTAL', 'v1', 'MOTORCYCLE', 'h1',
                'ADVANCE', 'SCHEDULED', 80, 20, 20, NOW(),
                'cp1', NULL, '2030-01-01T11:00:00Z', NOW())`,
      '23514',
    );
  });

  it('T-02 AC-7 QUEUED request without chargingPointId and no slot times is allowed', async () => {
    await expect(
      db.$executeRaw`
        INSERT INTO charging_request
          (id, "requestedById", "vehicleKind", "rentalVehicleId", "vehicleClass", "hubId",
           mode, status, "targetPct", "startPct", "currentPct", "desiredTime", "createdAt")
        VALUES ('cr_ok', 'u1', 'RENTAL', 'v1', 'MOTORCYCLE', 'h1',
                'QUEUE', 'QUEUED', 80, 20, 20, NOW(), NOW())`,
    ).resolves.not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// AC-7  uq_alert_open — one OPEN alert per dedupeKey
// ---------------------------------------------------------------------------

describe('T-02 AC-7 uq_alert_open one OPEN alert per dedupeKey', () => {
  beforeEach(async () => {
    await clean();
    await mkHub('h1');
  });

  it('T-02 AC-7 second OPEN alert with same dedupeKey is rejected (uq_alert_open)', async () => {
    await db.$executeRaw`
      INSERT INTO alert
        (id, type, "hubId", "resourceIds", metric, message, "dedupeKey", status, "createdAt", "lastSeenAt")
      VALUES ('a1', 'NEAR_CAPACITY', 'h1', '{}', '{}', 'msg', 'NEAR:h1:PARKING:MOTORCYCLE', 'OPEN', NOW(), NOW())`;

    await expectViolation(
      db.$executeRaw`
        INSERT INTO alert
          (id, type, "hubId", "resourceIds", metric, message, "dedupeKey", status, "createdAt", "lastSeenAt")
        VALUES ('a2', 'NEAR_CAPACITY', 'h1', '{}', '{}', 'msg', 'NEAR:h1:PARKING:MOTORCYCLE', 'OPEN', NOW(), NOW())`,
      '23505',
    );
  });

  it('T-02 AC-7 ACKNOWLEDGED + OPEN with same dedupeKey is rejected, RESOLVED/DISMISSED + OPEN is allowed', async () => {
    await db.$executeRaw`
      INSERT INTO alert
        (id, type, "hubId", "resourceIds", metric, message, "dedupeKey", status, "createdAt", "lastSeenAt")
      VALUES ('a1', 'NEAR_CAPACITY', 'h1', '{}', '{}', 'msg', 'NEAR:h1:PARKING:MOTORCYCLE', 'ACKNOWLEDGED', NOW(), NOW())`;

    await expectViolation(
      db.$executeRaw`
        INSERT INTO alert
          (id, type, "hubId", "resourceIds", metric, message, "dedupeKey", status, "createdAt", "lastSeenAt")
        VALUES ('a2', 'NEAR_CAPACITY', 'h1', '{}', '{}', 'msg', 'NEAR:h1:PARKING:MOTORCYCLE', 'OPEN', NOW(), NOW())`,
      '23505',
    );

    await db.$executeRaw`
      INSERT INTO alert
        (id, type, "hubId", "resourceIds", metric, message, "dedupeKey", status, "createdAt", "lastSeenAt")
      VALUES ('a3', 'NEAR_CAPACITY', 'h1', '{}', '{}', 'msg', 'NEAR:h1:PARKING:CAR', 'RESOLVED', NOW(), NOW())`;

    await expect(
      db.$executeRaw`
        INSERT INTO alert
          (id, type, "hubId", "resourceIds", metric, message, "dedupeKey", status, "createdAt", "lastSeenAt")
        VALUES ('a4', 'NEAR_CAPACITY', 'h1', '{}', '{}', 'msg', 'NEAR:h1:PARKING:CAR', 'OPEN', NOW(), NOW())`,
    ).resolves.not.toThrow();

    await db.$executeRaw`
      INSERT INTO alert
        (id, type, "hubId", "resourceIds", metric, message, "dedupeKey", status, "createdAt", "lastSeenAt")
      VALUES ('a5', 'NEAR_CAPACITY', 'h1', '{}', '{}', 'msg', 'NEAR:h1:CHARGING:MOTORCYCLE', 'DISMISSED', NOW(), NOW())`;

    await expect(
      db.$executeRaw`
        INSERT INTO alert
          (id, type, "hubId", "resourceIds", metric, message, "dedupeKey", status, "createdAt", "lastSeenAt")
        VALUES ('a6', 'NEAR_CAPACITY', 'h1', '{}', '{}', 'msg', 'NEAR:h1:CHARGING:MOTORCYCLE', 'OPEN', NOW(), NOW())`,
    ).resolves.not.toThrow();
  });
});
