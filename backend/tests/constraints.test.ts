import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import {
  AlertType,
  ChargingMode,
  ChargingRequestStatus,
  ChargingVehicleKind,
  IncidentCategory,
  IncidentResourceType,
  IncidentSource,
  IncidentStatus,
  ParkingPool,
  ParkingSpaceStatus,
  ReservationStatus,
  RentalVehicleStatus,
  RentalVehicleType,
  VehicleClass,
  PrivateEvType,
} from '@prisma/client';
import { db } from '../src/core/db';

// Every table, so beforeEach starts from an empty DB. TRUNCATE (not DELETE) because
// the audit_log trigger forbids DELETE but allows TRUNCATE (ARCHITECTURE §5.2).
const ALL_TABLES = [
  'user',
  'hub',
  'hub_threshold',
  'hub_redirect',
  'setting',
  'rental_vehicle',
  'private_ev',
  'parking_space',
  'charging_point',
  'vehicle_reservation',
  'parking_reservation',
  'charging_request',
  'idempotency_key',
  'incident',
  'incident_report',
  'incident_impact',
  'alert',
  'redistribution_task',
  'redistribution_task_vehicle',
  'notification',
  'audit_log',
  'telemetry_reject',
  'sim_scenario',
  'sim_run',
  'sim_recommendation',
];

async function resetDb(): Promise<void> {
  const list = ALL_TABLES.map((t) => `"${t}"`).join(', ');
  await db.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}

// Asserts a write fails with a DB error that mentions the constraint name or SQL code.
// Prisma surfaces different codes for unique (P2002) vs exclusion/check/trigger, so we
// match on the name or Postgres code appearing anywhere in the error (per T-02 notes).
async function expectDbError(p: Promise<unknown>, needles: string[]): Promise<void> {
  let threw = false;
  try {
    await p;
  } catch (err) {
    threw = true;
    const e = err as { message?: string; code?: string; meta?: unknown };
    const hay = [e.message, e.code, JSON.stringify(e.meta)].filter(Boolean).join(' | ');
    const ok = needles.some((n) => hay.includes(n));
    if (!ok) throw new Error(`DB error did not mention ${needles.join(' / ')}. Got: ${hay}`);
  }
  if (!threw) {
    throw new Error(`Expected a DB error mentioning ${needles.join(' / ')}, but the write succeeded`);
  }
}

const T = (hour: number): Date => new Date(Date.UTC(2026, 11, 1, hour, 0, 0));

// First row's count (noUncheckedIndexedAccess makes rows[0] possibly undefined).
function countOf(rows: { n: number }[]): number {
  const row = rows[0];
  if (!row) throw new Error('expected a count row');
  return row.n;
}

// --- minimal row builders (each test creates only what it needs) ---
function makeHub(id = 'hub-1') {
  return db.hub.create({ data: { id, name: `Hub ${id}`, location: 'campus' } });
}
function makeUser(identifier = 'student1') {
  return db.user.create({ data: { identifier, passwordHash: 'x', displayName: identifier } });
}
function makeVehicle(id: string, hubId: string, batteryPct = 50) {
  return db.rentalVehicle.create({
    data: {
      id,
      hubId,
      type: RentalVehicleType.E_MOTORCYCLE,
      status: RentalVehicleStatus.AVAILABLE,
      batteryPct,
    },
  });
}
function makeSpace(id: string, hubId: string) {
  return db.parkingSpace.create({
    data: {
      id,
      hubId,
      vehicleClass: VehicleClass.MOTORCYCLE,
      pool: ParkingPool.PUBLIC,
      status: ParkingSpaceStatus.FREE,
    },
  });
}
function makePoint(id: string, hubId: string) {
  return db.chargingPoint.create({
    data: { id, hubId, vehicleClass: VehicleClass.MOTORCYCLE, status: 'AVAILABLE' },
  });
}
function makePev(id: string, ownerId: string, batteryPct = 50) {
  return db.privateEv.create({
    data: {
      id,
      ownerId,
      type: PrivateEvType.CAR,
      vehicleClass: VehicleClass.CAR,
      label: 'My EV',
      batteryCapacityKwh: 40,
      batteryPct,
    },
  });
}
function makeVehicleRes(
  id: string,
  userId: string,
  rentalVehicleId: string,
  hubId: string,
  status: ReservationStatus,
) {
  return db.vehicleReservation.create({
    data: { id, userId, rentalVehicleId, hubId, status, expiresAt: T(23) },
  });
}
function makeParkingRes(
  id: string,
  parkingSpaceId: string,
  userId: string,
  hubId: string,
  startHour: number,
  endHour: number,
  status: ReservationStatus,
) {
  return db.parkingReservation.create({
    data: {
      id,
      userId,
      parkingSpaceId,
      hubId,
      vehicleClass: VehicleClass.MOTORCYCLE,
      windowStart: T(startHour),
      windowEnd: T(endHour),
      status,
      expiresAt: T(startHour),
    },
  });
}

// Raw-SQL inserts for the rows that must VIOLATE a partial unique index. Prisma maps
// those to P2002 and hides the native code/index name, so we insert via raw SQL to let
// Postgres surface 23505 and the index name (per the T-02 error-matching note).
function rawVehicleRes(id: string, userId: string, rentalVehicleId: string, hubId: string, status: string) {
  return db.$executeRawUnsafe(
    `INSERT INTO vehicle_reservation (id, "userId", "rentalVehicleId", "hubId", status, "expiresAt")
     VALUES ($1, $2, $3, $4, '${status}', $5)`,
    id,
    userId,
    rentalVehicleId,
    hubId,
    T(23),
  );
}
function rawChargeRental(id: string, requestedById: string, hubId: string, rentalVehicleId: string, status: string) {
  return db.$executeRawUnsafe(
    `INSERT INTO charging_request (id, "requestedById", "vehicleKind", "rentalVehicleId", "vehicleClass", "hubId", mode, status, "targetPct", "startPct", "currentPct")
     VALUES ($1, $2, 'RENTAL', $3, 'MOTORCYCLE', $4, 'QUEUE', '${status}', 80, 20, 20)`,
    id,
    requestedById,
    rentalVehicleId,
    hubId,
  );
}
function rawChargePev(id: string, requestedById: string, hubId: string, privateEvId: string, status: string) {
  return db.$executeRawUnsafe(
    `INSERT INTO charging_request (id, "requestedById", "vehicleKind", "privateEvId", "vehicleClass", "hubId", mode, status, "targetPct", "startPct", "currentPct")
     VALUES ($1, $2, 'PRIVATE', $3, 'MOTORCYCLE', $4, 'QUEUE', '${status}', 80, 20, 20)`,
    id,
    requestedById,
    privateEvId,
    hubId,
  );
}
function rawIncident(id: string, resourceId: string, hubId: string, status: string) {
  return db.$executeRawUnsafe(
    `INSERT INTO incident (id, "resourceType", "resourceId", "hubId", "vehicleClass", category, notes, source, status)
     VALUES ($1, 'RENTAL_VEHICLE', $2, $3, 'MOTORCYCLE', 'OTHER', 'note', 'OPERATOR', '${status}')`,
    id,
    resourceId,
    hubId,
  );
}
function rawAlert(id: string, dedupeKey: string, hubId: string, status: string) {
  return db.$executeRawUnsafe(
    `INSERT INTO alert (id, type, "hubId", "dedupeKey", message, status)
     VALUES ($1, 'LOW_BATTERY', $3, $2, 'm', '${status}')`,
    id,
    dedupeKey,
    hubId,
  );
}

beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
});

// ---------------------------------------------------------------------------
// AC-6 — every §5.2 object exists by name
// ---------------------------------------------------------------------------
describe('T-02 AC-6 schema objects exist', () => {
  it('T-02 AC-6 every constraint, index, trigger, function and extension exists by name', async () => {
    const extension = await db.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM pg_extension WHERE extname = 'btree_gist'`,
    );
    expect(countOf(extension)).toBe(1);

    const indexNames = [
      'uq_vres_active_user',
      'uq_vres_active_vehicle',
      'uq_charge_active_rental',
      'uq_charge_active_pev',
      'uq_incident_open',
      'uq_alert_open',
    ];
    const indexes = await db.$queryRawUnsafe<{ indexname: string }[]>(
      `SELECT indexname FROM pg_indexes WHERE indexname = ANY($1::text[])`,
      indexNames,
    );
    expect(indexes.map((r) => r.indexname).sort()).toEqual([...indexNames].sort());

    const constraintNames = [
      'ex_parking_overlap',
      'ex_charging_overlap',
      'ck_rv_battery',
      'ck_pev_battery',
      'ck_pr_window',
      'ck_cr_target',
      'ck_cr_slot',
    ];
    const constraints = await db.$queryRawUnsafe<{ conname: string }[]>(
      `SELECT conname FROM pg_constraint WHERE conname = ANY($1::text[])`,
      constraintNames,
    );
    expect(constraints.map((r) => r.conname).sort()).toEqual([...constraintNames].sort());

    const fn = await db.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM pg_proc WHERE proname = 'forbid_change'`,
    );
    expect(countOf(fn)).toBe(1);

    const trigger = await db.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM pg_trigger WHERE tgname = 'audit_log_no_update'`,
    );
    expect(countOf(trigger)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// AC-3 — every enum type has exactly the documented values
// ---------------------------------------------------------------------------
describe('T-02 AC-3 enum values match CONTRACTS §1', () => {
  const expectedEnums: Record<string, string[]> = {
    Role: ['STUDENT', 'OPERATOR'],
    VehicleClass: ['MOTORCYCLE', 'CAR'],
    RentalVehicleType: ['E_BICYCLE', 'E_MOTORCYCLE'],
    PrivateEvType: ['E_MOTORCYCLE', 'CAR'],
    RentalVehicleStatus: ['AVAILABLE', 'RESERVED', 'IN_USE', 'LOW_BATTERY', 'IN_TRANSIT', 'FAULTY'],
    ReservationStatus: ['CONFIRMED', 'ACTIVE', 'COMPLETED', 'CANCELLED', 'EXPIRED'],
    ParkingSpaceStatus: ['FREE', 'RESERVED', 'OCCUPIED', 'UNAVAILABLE'],
    ParkingPool: ['FLEET', 'PUBLIC'],
    ChargingPointStatus: ['AVAILABLE', 'CHARGING', 'FAULTY'],
    ChargingRequestStatus: ['QUEUED', 'SCHEDULED', 'CHARGING', 'COMPLETED', 'CANCELLED'],
    ChargingMode: ['QUEUE', 'ADVANCE'],
    ChargingEndReason: ['TARGET_REACHED', 'USER_STOP', 'POINT_FAILURE', 'VEHICLE_FAULT'],
    IncidentStatus: ['REPORTED', 'IN_MAINTENANCE', 'RESOLVED'],
    IncidentResourceType: ['RENTAL_VEHICLE', 'PARKING_SPACE', 'CHARGING_POINT'],
    IncidentCategory: [
      'VEHICLE_FAULT',
      'BATTERY_FAULT',
      'CHARGER_FAULT',
      'ELECTRICAL',
      'EMERGENCY_DISCONNECT',
      'DAMAGE',
      'OBSTRUCTION',
      'OTHER',
    ],
    IncidentSource: ['OPERATOR', 'STUDENT', 'TELEMETRY'],
    AlertType: ['NEAR_CAPACITY', 'LOW_BATTERY', 'FAULT', 'STALLED_FEED', 'SHORTAGE', 'SURPLUS'],
    AlertStatus: ['OPEN', 'ACKNOWLEDGED', 'DISMISSED', 'RESOLVED'],
    RedistributionStatus: ['PROPOSED', 'APPROVED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'FAILED'],
    SimRunStatus: ['RUNNING', 'COMPLETED', 'FAILED', 'INCOMPLETE'],
    RecommendationType: ['REDISTRIBUTE', 'CHARGING_ADJUST', 'REDIRECT'],
    RecommendationStatus: ['PENDING', 'APPLIED', 'DISMISSED', 'BLOCKED'],
    ChargingVehicleKind: ['RENTAL', 'PRIVATE'],
    VehicleReservationEndReason: ['RETURNED', 'CANCELLED', 'EXPIRED', 'INCIDENT'],
    ImpactBookingType: ['VEHICLE_RESERVATION', 'PARKING_RESERVATION', 'CHARGING_REQUEST'],
    ImpactOutcome: ['REASSIGNED', 'CANCELLED', 'ENDED'],
    RedistributionOrigin: ['MANUAL', 'SIMULATION'],
  };

  it('T-02 AC-3 enum values match CONTRACTS §1 (pg_enum, order preserved)', async () => {
    for (const [typeName, values] of Object.entries(expectedEnums)) {
      const rows = await db.$queryRawUnsafe<{ label: string }[]>(
        `SELECT e.enumlabel AS label
           FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
          WHERE t.typname = $1
          ORDER BY e.enumsortorder`,
        typeName,
      );
      expect(rows.map((r) => r.label), `enum ${typeName}`).toEqual(values);
    }
  });
});

// ---------------------------------------------------------------------------
// AC-7 — constraints actually reject bad rows
// ---------------------------------------------------------------------------
describe('T-02 AC-7 BR-01 one active vehicle reservation per student and per vehicle', () => {
  it('T-02 AC-7 BR-01 a second CONFIRMED/ACTIVE reservation for the same user is rejected', async () => {
    const hub = await makeHub();
    const user = await makeUser();
    await makeVehicle('RV-1', hub.id);
    await makeVehicle('RV-2', hub.id);
    await makeVehicleRes('vr-1', user.id, 'RV-1', hub.id, ReservationStatus.CONFIRMED);
    await expectDbError(rawVehicleRes('vr-2', user.id, 'RV-2', hub.id, 'ACTIVE'), [
      'uq_vres_active_user',
      '23505',
    ]);
  });

  it('T-02 AC-7 BR-01 a CANCELLED plus a CONFIRMED reservation for the same user is allowed', async () => {
    const hub = await makeHub();
    const user = await makeUser();
    await makeVehicle('RV-1', hub.id);
    await makeVehicle('RV-2', hub.id);
    await makeVehicleRes('vr-1', user.id, 'RV-1', hub.id, ReservationStatus.CANCELLED);
    const ok = await makeVehicleRes('vr-2', user.id, 'RV-2', hub.id, ReservationStatus.CONFIRMED);
    expect(ok.status).toBe(ReservationStatus.CONFIRMED);
  });

  it('T-02 AC-7 BR-01 a second active reservation for the same vehicle is rejected', async () => {
    const hub = await makeHub();
    const u1 = await makeUser('student1');
    const u2 = await makeUser('student2');
    await makeVehicle('RV-1', hub.id);
    await makeVehicleRes('vr-1', u1.id, 'RV-1', hub.id, ReservationStatus.CONFIRMED);
    await expectDbError(rawVehicleRes('vr-2', u2.id, 'RV-1', hub.id, 'CONFIRMED'), [
      'uq_vres_active_vehicle',
      '23505',
    ]);
  });
});

describe('T-02 AC-7 BR-10 parking window overlap', () => {
  it('T-02 AC-7 BR-10 overlapping CONFIRMED windows on one space are rejected', async () => {
    const hub = await makeHub();
    const user = await makeUser();
    await makeSpace('PS-1', hub.id);
    await makeParkingRes('pr-1', 'PS-1', user.id, hub.id, 10, 12, ReservationStatus.CONFIRMED);
    await expectDbError(
      makeParkingRes('pr-2', 'PS-1', user.id, hub.id, 11, 13, ReservationStatus.CONFIRMED),
      ['ex_parking_overlap', '23P01'],
    );
  });

  it('T-02 AC-7 BR-10 touching windows [10,12) and [12,14) on one space are allowed', async () => {
    const hub = await makeHub();
    const user = await makeUser();
    await makeSpace('PS-1', hub.id);
    await makeParkingRes('pr-1', 'PS-1', user.id, hub.id, 10, 12, ReservationStatus.CONFIRMED);
    const ok = await makeParkingRes('pr-2', 'PS-1', user.id, hub.id, 12, 14, ReservationStatus.CONFIRMED);
    expect(ok.id).toBe('pr-2');
  });

  it('T-02 AC-7 BR-10 overlap is allowed when one reservation is CANCELLED', async () => {
    const hub = await makeHub();
    const user = await makeUser();
    await makeSpace('PS-1', hub.id);
    await makeParkingRes('pr-1', 'PS-1', user.id, hub.id, 10, 12, ReservationStatus.CANCELLED);
    const ok = await makeParkingRes('pr-2', 'PS-1', user.id, hub.id, 11, 13, ReservationStatus.CONFIRMED);
    expect(ok.id).toBe('pr-2');
  });

  it('T-02 AC-7 ck_pr_window rejects windowEnd equal to windowStart', async () => {
    const hub = await makeHub();
    const user = await makeUser();
    await makeSpace('PS-1', hub.id);
    await expectDbError(
      makeParkingRes('pr-1', 'PS-1', user.id, hub.id, 12, 12, ReservationStatus.CONFIRMED),
      ['ck_pr_window', '23514'],
    );
  });
});

describe('T-02 AC-7 FR-49 charging slot and live-request constraints', () => {
  function makeCharge(opts: {
    id: string;
    hubId: string;
    requestedById: string;
    rentalVehicleId?: string;
    privateEvId?: string;
    status: ChargingRequestStatus;
    chargingPointId?: string;
    slotStart?: Date;
    slotEnd?: Date;
    targetPct?: number;
  }) {
    return db.chargingRequest.create({
      data: {
        id: opts.id,
        hubId: opts.hubId,
        requestedById: opts.requestedById,
        vehicleKind: opts.privateEvId ? ChargingVehicleKind.PRIVATE : ChargingVehicleKind.RENTAL,
        rentalVehicleId: opts.rentalVehicleId,
        privateEvId: opts.privateEvId,
        vehicleClass: VehicleClass.MOTORCYCLE,
        mode: ChargingMode.QUEUE,
        status: opts.status,
        targetPct: opts.targetPct ?? 80,
        startPct: 20,
        currentPct: 20,
        chargingPointId: opts.chargingPointId,
        slotStart: opts.slotStart,
        slotEnd: opts.slotEnd,
      },
    });
  }

  it('T-02 AC-7 FR-49 overlapping SCHEDULED slots on one point are rejected', async () => {
    const hub = await makeHub();
    const user = await makeUser();
    await makeVehicle('RV-1', hub.id);
    await makeVehicle('RV-2', hub.id);
    await makePoint('CP-1', hub.id);
    await makeCharge({
      id: 'cr-1',
      hubId: hub.id,
      requestedById: user.id,
      rentalVehicleId: 'RV-1',
      status: ChargingRequestStatus.SCHEDULED,
      chargingPointId: 'CP-1',
      slotStart: T(10),
      slotEnd: T(12),
    });
    await expectDbError(
      makeCharge({
        id: 'cr-2',
        hubId: hub.id,
        requestedById: user.id,
        rentalVehicleId: 'RV-2',
        status: ChargingRequestStatus.SCHEDULED,
        chargingPointId: 'CP-1',
        slotStart: T(11),
        slotEnd: T(13),
      }),
      ['ex_charging_overlap', '23P01'],
    );
  });

  it('T-02 AC-7 uq_charge_active_rental rejects a second live request for the same rental vehicle', async () => {
    const hub = await makeHub();
    const user = await makeUser();
    await makeVehicle('RV-1', hub.id);
    await makeCharge({
      id: 'cr-1',
      hubId: hub.id,
      requestedById: user.id,
      rentalVehicleId: 'RV-1',
      status: ChargingRequestStatus.QUEUED,
    });
    await expectDbError(rawChargeRental('cr-2', user.id, hub.id, 'RV-1', 'QUEUED'), [
      'uq_charge_active_rental',
      '23505',
    ]);
  });

  it('T-02 AC-7 uq_charge_active_pev rejects a second live request for the same private EV', async () => {
    const hub = await makeHub();
    const user = await makeUser();
    await makePev('PEV-1', user.id);
    await makeCharge({
      id: 'cr-1',
      hubId: hub.id,
      requestedById: user.id,
      privateEvId: 'PEV-1',
      status: ChargingRequestStatus.CHARGING,
      targetPct: 80,
    });
    await expectDbError(rawChargePev('cr-2', user.id, hub.id, 'PEV-1', 'QUEUED'), [
      'uq_charge_active_pev',
      '23505',
    ]);
  });

  it('T-02 AC-7 ck_cr_slot rejects a SCHEDULED request on a point with a null slotEnd', async () => {
    const hub = await makeHub();
    const user = await makeUser();
    await makeVehicle('RV-1', hub.id);
    await makePoint('CP-1', hub.id);
    await expectDbError(
      makeCharge({
        id: 'cr-1',
        hubId: hub.id,
        requestedById: user.id,
        rentalVehicleId: 'RV-1',
        status: ChargingRequestStatus.SCHEDULED,
        chargingPointId: 'CP-1',
        slotStart: T(10),
      }),
      ['ck_cr_slot', '23514'],
    );
  });

  it('T-02 AC-7 ck_cr_target rejects targetPct outside (0, 100]', async () => {
    const hub = await makeHub();
    const user = await makeUser();
    await makeVehicle('RV-1', hub.id);
    await expectDbError(
      makeCharge({
        id: 'cr-1',
        hubId: hub.id,
        requestedById: user.id,
        rentalVehicleId: 'RV-1',
        status: ChargingRequestStatus.QUEUED,
        targetPct: 0,
      }),
      ['ck_cr_target', '23514'],
    );
  });
});

describe('T-02 AC-7 UC-21 E2 one open incident per resource', () => {
  function makeIncident(id: string, resourceId: string, hubId: string, status: IncidentStatus) {
    return db.incident.create({
      data: {
        id,
        resourceType: IncidentResourceType.RENTAL_VEHICLE,
        resourceId,
        hubId,
        vehicleClass: VehicleClass.MOTORCYCLE,
        category: IncidentCategory.OTHER,
        notes: 'note',
        source: IncidentSource.OPERATOR,
        status,
      },
    });
  }

  it('T-02 AC-7 UC-21 E2 a second open incident for the same resource is rejected', async () => {
    const hub = await makeHub();
    await makeIncident('inc-1', 'RV-1', hub.id, IncidentStatus.REPORTED);
    await expectDbError(rawIncident('inc-2', 'RV-1', hub.id, 'REPORTED'), [
      'uq_incident_open',
      '23505',
    ]);
  });

  it('T-02 AC-7 UC-21 E2 a new incident is allowed once the first is RESOLVED', async () => {
    const hub = await makeHub();
    await makeIncident('inc-1', 'RV-1', hub.id, IncidentStatus.RESOLVED);
    const ok = await makeIncident('inc-2', 'RV-1', hub.id, IncidentStatus.REPORTED);
    expect(ok.id).toBe('inc-2');
  });
});

describe('T-02 AC-7 UC-20 E2 one open alert per condition', () => {
  function makeAlert(id: string, dedupeKey: string, hubId: string, status: 'OPEN' | 'RESOLVED') {
    return db.alert.create({
      data: { id, type: AlertType.LOW_BATTERY, hubId, dedupeKey, message: 'm', status },
    });
  }

  it('T-02 AC-7 UC-20 E2 a second OPEN alert with the same dedupeKey is rejected', async () => {
    const hub = await makeHub();
    await makeAlert('al-1', 'LOW_BATTERY:hub-1', hub.id, 'OPEN');
    await expectDbError(rawAlert('al-2', 'LOW_BATTERY:hub-1', hub.id, 'OPEN'), [
      'uq_alert_open',
      '23505',
    ]);
  });
});

describe('T-02 AC-7 FR-63 audit_log is append-only', () => {
  it('T-02 AC-7 FR-63 audit_log rejects UPDATE and DELETE but allows INSERT and TRUNCATE', async () => {
    await db.auditLog.create({ data: { action: 'TEST', entityType: 'test', entityIds: [] } });

    await expectDbError(db.$executeRawUnsafe(`UPDATE audit_log SET reason = 'x'`), [
      'audit_log is append-only',
      'P0001',
    ]);
    await expectDbError(db.$executeRawUnsafe(`DELETE FROM audit_log`), [
      'audit_log is append-only',
      'P0001',
    ]);

    // TRUNCATE is not blocked by the row-level trigger.
    await db.$executeRawUnsafe(`TRUNCATE audit_log RESTART IDENTITY CASCADE`);
    const after = await db.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM audit_log`,
    );
    expect(countOf(after)).toBe(0);
  });
});

describe('T-02 AC-7 NFR-13 battery range checks', () => {
  it('T-02 AC-7 NFR-13 rental batteryPct 0 and 100 are allowed, -1 and 101 are rejected', async () => {
    const hub = await makeHub();
    const ok0 = await makeVehicle('RV-0', hub.id, 0);
    const ok100 = await makeVehicle('RV-100', hub.id, 100);
    expect(ok0.batteryPct).toBe(0);
    expect(ok100.batteryPct).toBe(100);
    await expectDbError(makeVehicle('RV-neg', hub.id, -1), ['ck_rv_battery', '23514']);
    await expectDbError(makeVehicle('RV-over', hub.id, 101), ['ck_rv_battery', '23514']);
  });

  it('T-02 AC-7 NFR-13 ck_pev_battery rejects a private EV batteryPct of 101', async () => {
    const user = await makeUser();
    await expectDbError(makePev('PEV-bad', user.id, 101), ['ck_pev_battery', '23514']);
  });
});
