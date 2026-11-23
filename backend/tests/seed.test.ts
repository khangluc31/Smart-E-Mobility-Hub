// Checker tests for T-07 — written from the ticket ACs, BEFORE reading seed.ts.
// Pattern: truncateAll() → seed(db) → assertions → resetDb() so the fixture is restored.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcrypt from 'bcryptjs';
import { db } from '../src/core/db';
import { config } from '../src/core/config';
import { truncateAll, resetDb } from './helpers';
import { seed } from '../prisma/seed';
import { SEED_DATA, type HubSeedRow } from '../prisma/seed-data';

// ---- ARCHITECTURE §5.3 expected counts ----
const HUB_SPECS = {
  metro:      { vehicles: 90, fleetMoto: 110, pubMoto: 40, pubCar: 10, cpMoto: 12, cpCar: 4, min: 15, max: 100 },
  dorm:       { vehicles: 70, fleetMoto: 85,  pubMoto: 40, pubCar: 8,  cpMoto: 10, cpCar: 2, min: 10, max: 75  },
  'campus-a': { vehicles: 50, fleetMoto: 65,  pubMoto: 30, pubCar: 8,  cpMoto: 8,  cpCar: 3, min: 10, max: 60  },
  'campus-b': { vehicles: 50, fleetMoto: 65,  pubMoto: 30, pubCar: 8,  cpMoto: 8,  cpCar: 3, min: 10, max: 60  },
  service:    { vehicles: 40, fleetMoto: 55,  pubMoto: 25, pubCar: 6,  cpMoto: 7,  cpCar: 3, min: 8,  max: 50  },
};
type HubId = keyof typeof HUB_SPECS;
const HUB_IDS = Object.keys(HUB_SPECS) as HubId[];

const TOTAL_VEHICLES   = 300;
const TOTAL_FLEET_MOTO = 380;
const TOTAL_PUB_MOTO   = 165;
const TOTAL_PUB_CAR    = 40;
const TOTAL_CP_MOTO    = 45;
const TOTAL_CP_CAR     = 15;

describe('T-07 seed', () => {
  beforeAll(async () => {
    await truncateAll();
    await seed(db);
  });

  afterAll(async () => {
    await resetDb(); // restore fixture for later test files
  });

  // -------------------------------------------------------------------------
  // AC-1  Exact counts per Hub and totals
  // -------------------------------------------------------------------------
  it('T-07 AC-1 seeds exact counts per Hub and totals', async () => {
    const hubs = await db.hub.findMany();
    expect(hubs).toHaveLength(5);
    expect(hubs.map(h => h.id).sort()).toEqual(
      ['campus-a', 'campus-b', 'dorm', 'metro', 'service'],
    );

    // Total vehicles
    const totalVehicles = await db.rentalVehicle.count();
    expect(totalVehicles).toBe(TOTAL_VEHICLES);

    // Per-hub vehicle counts
    for (const hubId of HUB_IDS) {
      const count = await db.rentalVehicle.count({ where: { hubId } });
      expect(count, `vehicles at ${hubId}`).toBe(HUB_SPECS[hubId].vehicles);
    }

    // Total parking spaces by pool+class
    const fleetMoto = await db.parkingSpace.count({ where: { pool: 'FLEET', vehicleClass: 'MOTORCYCLE' } });
    const pubMoto   = await db.parkingSpace.count({ where: { pool: 'PUBLIC', vehicleClass: 'MOTORCYCLE' } });
    const pubCar    = await db.parkingSpace.count({ where: { pool: 'PUBLIC', vehicleClass: 'CAR' } });
    expect(fleetMoto).toBe(TOTAL_FLEET_MOTO);
    expect(pubMoto).toBe(TOTAL_PUB_MOTO);
    expect(pubCar).toBe(TOTAL_PUB_CAR);

    // Per-hub parking space counts
    for (const hubId of HUB_IDS) {
      const spec = HUB_SPECS[hubId];
      const hFleet = await db.parkingSpace.count({ where: { hubId, pool: 'FLEET', vehicleClass: 'MOTORCYCLE' } });
      const hPubM  = await db.parkingSpace.count({ where: { hubId, pool: 'PUBLIC', vehicleClass: 'MOTORCYCLE' } });
      const hPubC  = await db.parkingSpace.count({ where: { hubId, pool: 'PUBLIC', vehicleClass: 'CAR' } });
      expect(hFleet, `fleet moto at ${hubId}`).toBe(spec.fleetMoto);
      expect(hPubM,  `public moto at ${hubId}`).toBe(spec.pubMoto);
      expect(hPubC,  `public car at ${hubId}`).toBe(spec.pubCar);
    }

    // Total charging points
    const totalCpMoto = await db.chargingPoint.count({ where: { vehicleClass: 'MOTORCYCLE' } });
    const totalCpCar  = await db.chargingPoint.count({ where: { vehicleClass: 'CAR' } });
    expect(totalCpMoto).toBe(TOTAL_CP_MOTO);
    expect(totalCpCar).toBe(TOTAL_CP_CAR);

    // Per-hub charging point counts
    for (const hubId of HUB_IDS) {
      const spec = HUB_SPECS[hubId];
      const hCpM = await db.chargingPoint.count({ where: { hubId, vehicleClass: 'MOTORCYCLE' } });
      const hCpC = await db.chargingPoint.count({ where: { hubId, vehicleClass: 'CAR' } });
      expect(hCpM, `moto cp at ${hubId}`).toBe(spec.cpMoto);
      expect(hCpC, `car cp at ${hubId}`).toBe(spec.cpCar);
    }

    // No FLEET CAR spaces (rental vehicles are MOTORCYCLE only, rule 2)
    const fleetCar = await db.parkingSpace.count({ where: { pool: 'FLEET', vehicleClass: 'CAR' } });
    expect(fleetCar).toBe(0);
  });

  // -------------------------------------------------------------------------
  // AC-2  D-14: each vehicle occupies its own FLEET space at its Hub
  // -------------------------------------------------------------------------
  it('T-07 AC-2 D-14 each vehicle occupies its own FLEET space at its Hub', async () => {
    const vehicles = await db.rentalVehicle.findMany({
      select: { id: true, hubId: true, vehicleClass: true, parkingSpaceId: true },
    });

    // Every vehicle must reference a parking space
    for (const v of vehicles) {
      expect(v.parkingSpaceId, `${v.id} has no parkingSpaceId`).not.toBeNull();

      const space = await db.parkingSpace.findUnique({ where: { id: v.parkingSpaceId! } });
      expect(space, `space ${v.parkingSpaceId} not found`).not.toBeNull();
      expect(space!.pool, `${v.id} space pool`).toBe('FLEET');
      expect(space!.vehicleClass, `${v.id} space class`).toBe('MOTORCYCLE');
      expect(space!.status, `${v.id} space status`).toBe('OCCUPIED');
      expect(space!.hubId, `${v.id} space hub`).toBe(v.hubId);
    }

    // No two vehicles share a space
    const spaceIds = vehicles.map(v => v.parkingSpaceId!);
    expect(new Set(spaceIds).size).toBe(spaceIds.length);

    // Per Hub: OCCUPIED FLEET count = vehicle count
    for (const hubId of HUB_IDS) {
      const vCount  = await db.rentalVehicle.count({ where: { hubId } });
      const occCount = await db.parkingSpace.count({
        where: { hubId, pool: 'FLEET', vehicleClass: 'MOTORCYCLE', status: 'OCCUPIED' },
      });
      expect(occCount, `occupied fleet spaces at ${hubId}`).toBe(vCount);
    }

    // All non-occupied FLEET spaces are FREE
    const freeFleet  = await db.parkingSpace.count({ where: { pool: 'FLEET', status: 'FREE' } });
    const totalFleet = await db.parkingSpace.count({ where: { pool: 'FLEET' } });
    expect(freeFleet).toBe(totalFleet - TOTAL_VEHICLES);

    // All PUBLIC spaces start FREE
    const pubSpaces = await db.parkingSpace.findMany({ where: { pool: 'PUBLIC' } });
    for (const s of pubSpaces) {
      expect(s.status, `${s.id} should be FREE`).toBe('FREE');
    }

    // All charging points start AVAILABLE
    const cps = await db.chargingPoint.findMany();
    for (const cp of cps) {
      expect(cp.status, `${cp.id} should be AVAILABLE`).toBe('AVAILABLE');
    }
  });

  // -------------------------------------------------------------------------
  // AC-3  BR-02: status ↔ battery, type mix per Hub
  // -------------------------------------------------------------------------
  it('T-07 AC-3 BR-02 LOW_BATTERY below 20, AVAILABLE from 20; type mix', async () => {
    const vehicles = await db.rentalVehicle.findMany();

    // Battery constraints: 10–100
    for (const v of vehicles) {
      expect(v.batteryPct, `${v.id} battery`).toBeGreaterThanOrEqual(10);
      expect(v.batteryPct, `${v.id} battery`).toBeLessThanOrEqual(100);
    }

    // Status follows BR-02
    const lowBattery = vehicles.filter(v => v.batteryPct < config.MIN_RENTAL_BATTERY_PCT);
    const available  = vehicles.filter(v => v.batteryPct >= config.MIN_RENTAL_BATTERY_PCT);

    for (const v of lowBattery) {
      expect(v.status, `${v.id} (bat ${v.batteryPct}%) should be LOW_BATTERY`).toBe('LOW_BATTERY');
    }
    for (const v of available) {
      expect(v.status, `${v.id} (bat ${v.batteryPct}%) should be AVAILABLE`).toBe('AVAILABLE');
    }

    expect(lowBattery.length).toBeGreaterThan(0);
    expect(available.length).toBeGreaterThan(0);

    // All MOTORCYCLE class
    for (const v of vehicles) {
      expect(v.vehicleClass, `${v.id} class`).toBe('MOTORCYCLE');
    }

    // Type mix per Hub: 50–70 % E_MOTORCYCLE (spec says ≈60%)
    for (const hubId of HUB_IDS) {
      const hubVehicles = vehicles.filter(v => v.hubId === hubId);
      const motoCount = hubVehicles.filter(v => v.type === 'E_MOTORCYCLE').length;
      const pct = motoCount / hubVehicles.length;
      expect(pct, `E_MOTORCYCLE pct at ${hubId}`).toBeGreaterThanOrEqual(0.50);
      expect(pct, `E_MOTORCYCLE pct at ${hubId}`).toBeLessThanOrEqual(0.70);
    }
  });

  // -------------------------------------------------------------------------
  // AC-4  Thresholds and charging-weights setting
  // -------------------------------------------------------------------------
  it('T-07 AC-4 thresholds and charging weights', async () => {
    // One MOTORCYCLE threshold per Hub
    const thresholds = await db.hubThreshold.findMany({ where: { vehicleClass: 'MOTORCYCLE' } });
    expect(thresholds).toHaveLength(5);

    for (const hubId of HUB_IDS) {
      const t = thresholds.find(th => th.hubId === hubId);
      expect(t, `threshold for ${hubId}`).toBeDefined();
      expect(t!.minAvailable, `${hubId} min`).toBe(HUB_SPECS[hubId].min);
      expect(t!.maxAvailable, `${hubId} max`).toBe(HUB_SPECS[hubId].max);
    }

    // No CAR thresholds seeded
    const carThresholds = await db.hubThreshold.count({ where: { vehicleClass: 'CAR' } });
    expect(carThresholds).toBe(0);

    // Charging weights setting
    const setting = await db.setting.findUnique({ where: { key: 'charging.weights' } });
    expect(setting, 'charging.weights setting').not.toBeNull();
    const weights = setting!.value as { battery: number; urgency: number; waiting: number };
    expect(weights.battery).toBe(config.CHARGING_WEIGHTS.battery);
    expect(weights.urgency).toBe(config.CHARGING_WEIGHTS.urgency);
    expect(weights.waiting).toBe(config.CHARGING_WEIGHTS.waiting);
  });

  // -------------------------------------------------------------------------
  // AC-5  Accounts: 2 operators + 20 students, bcrypt passwords
  // -------------------------------------------------------------------------
  it('T-07 AC-5 accounts and bcrypt password', async () => {
    const users = await db.user.findMany();

    const operators = users.filter(u => u.role === 'OPERATOR');
    const students  = users.filter(u => u.role === 'STUDENT');
    expect(operators).toHaveLength(2);
    expect(students).toHaveLength(20);

    expect(operators.map(u => u.identifier).sort()).toEqual(['operator1', 'operator2']);
    const studentIdentifiers = Array.from({ length: 20 }, (_, i) => `student${i + 1}`);
    expect(students.map(u => u.identifier).sort()).toEqual(studentIdentifiers.sort());

    // mustChangePassword = false for all
    for (const u of users) {
      expect(u.mustChangePassword, `${u.identifier} mustChangePassword`).toBe(false);
    }

    // Password must be bcrypt-hashed, not plain
    const seedPw = process.env.SEED_PASSWORD ?? 'change-me';
    const op1 = users.find(u => u.identifier === 'operator1')!;
    const valid = await bcrypt.compare(seedPw, op1.passwordHash);
    expect(valid, 'operator1 bcrypt check').toBe(true);

    // Plain password never stored; all hashes start with bcrypt signature
    for (const u of users) {
      expect(u.passwordHash).not.toBe(seedPw);
      expect(u.passwordHash.startsWith('$2'), `${u.identifier} hash prefix`).toBe(true);
    }
  });

  // -------------------------------------------------------------------------
  // AC-6  Private EVs: 5, owned by student1-5, 2 CAR + 3 E_MOTORCYCLE
  // -------------------------------------------------------------------------
  it('T-07 AC-6 private EVs', async () => {
    const evs = await db.privateEv.findMany();
    expect(evs).toHaveLength(5);

    const cars  = evs.filter(e => e.type === 'CAR');
    const motos = evs.filter(e => e.type === 'E_MOTORCYCLE');
    expect(cars).toHaveLength(2);
    expect(motos).toHaveLength(3);

    // Class follows type
    for (const ev of cars)  { expect(ev.vehicleClass, `${ev.id} class`).toBe('CAR'); }
    for (const ev of motos) { expect(ev.vehicleClass, `${ev.id} class`).toBe('MOTORCYCLE'); }

    // Battery in 30–80
    for (const ev of evs) {
      expect(ev.batteryPct, `${ev.id} battery`).toBeGreaterThanOrEqual(30);
      expect(ev.batteryPct, `${ev.id} battery`).toBeLessThanOrEqual(80);
    }

    // Owners are u-student1 through u-student5 (one each)
    const ownerIds = evs.map(e => e.ownerId).sort();
    expect(ownerIds).toEqual(
      ['u-student1', 'u-student2', 'u-student3', 'u-student4', 'u-student5'].sort(),
    );
  });

  // -------------------------------------------------------------------------
  // AC-7  Idempotency: re-run keeps live-state changes, row counts unchanged
  // -------------------------------------------------------------------------
  it('T-07 AC-7 re-run is idempotent and keeps live state', async () => {
    // Record counts before
    const countsBefore = {
      hubs:     await db.hub.count(),
      vehicles: await db.rentalVehicle.count(),
      spaces:   await db.parkingSpace.count(),
      points:   await db.chargingPoint.count(),
      users:    await db.user.count(),
      evs:      await db.privateEv.count(),
      thresh:   await db.hubThreshold.count(),
    };

    // Mutate live state: change a vehicle's battery and status
    const rv = await db.rentalVehicle.findFirst({ where: { status: 'AVAILABLE' } });
    expect(rv).not.toBeNull();
    await db.rentalVehicle.update({
      where: { id: rv!.id },
      data: { batteryPct: 5.5, status: 'LOW_BATTERY' },
    });

    // Re-run seed
    await seed(db);

    // Row counts unchanged
    expect(await db.hub.count()).toBe(countsBefore.hubs);
    expect(await db.rentalVehicle.count()).toBe(countsBefore.vehicles);
    expect(await db.parkingSpace.count()).toBe(countsBefore.spaces);
    expect(await db.chargingPoint.count()).toBe(countsBefore.points);
    expect(await db.user.count()).toBe(countsBefore.users);
    expect(await db.privateEv.count()).toBe(countsBefore.evs);
    expect(await db.hubThreshold.count()).toBe(countsBefore.thresh);

    // Changed live state must NOT be overwritten
    const rvAfter = await db.rentalVehicle.findUnique({ where: { id: rv!.id } });
    expect(rvAfter!.batteryPct).toBe(5.5);
    expect(rvAfter!.status).toBe('LOW_BATTERY');
  });

  // -------------------------------------------------------------------------
  // AC-8  Deterministic: two seeds of empty DBs give identical vehicle ids/types/batteries
  // -------------------------------------------------------------------------
  it('T-07 AC-8 deterministic', async () => {
    // First fresh seed
    await truncateAll();
    await seed(db);
    const before = await db.rentalVehicle.findMany({ orderBy: { id: 'asc' } });

    // Second fresh seed
    await truncateAll();
    await seed(db);

    const after = await db.rentalVehicle.findMany({ orderBy: { id: 'asc' } });

    expect(after).toHaveLength(before.length);
    for (let i = 0; i < before.length; i++) {
      const b = before[i]!;
      const a = after[i]!;
      expect(a.id,         `[${i}] id`).toBe(b.id);
      expect(a.type,       `[${i}] type`).toBe(b.type);
      expect(a.batteryPct, `[${i}] battery`).toBe(b.batteryPct);
      expect(a.hubId,      `[${i}] hub`).toBe(b.hubId);
    }
  });

  // -------------------------------------------------------------------------
  // AC-9  NFR-18: sixth Hub from data only (no code change)
  // -------------------------------------------------------------------------
  it('T-07 AC-9 NFR-18 sixth Hub from data only', async () => {
    const sixthHub: HubSeedRow = {
      id:                 'test-hub-6',
      code:               'TST',
      name:               'Test Hub 6',
      location:           'Test Location 6',
      rentalVehicles:     1,
      fleetMotoSpaces:    2,
      publicMotoSpaces:   1,
      publicCarSpaces:    0,
      motoChargingPoints: 1,
      carChargingPoints:  0,
      minAvailable:       1,
      maxAvailable:       10,
    };

    const sixHubData = {
      ...SEED_DATA,
      hubs: [...SEED_DATA.hubs, sixthHub],
    };

    await truncateAll();
    await seed(db, { data: sixHubData });

    const hubs = await db.hub.findMany();
    expect(hubs).toHaveLength(6);
    const h6 = hubs.find(h => h.id === 'test-hub-6');
    expect(h6, 'sixth Hub created').toBeDefined();
    expect(h6!.name).toBe('Test Hub 6');

    // Vehicles for the 6th Hub seeded too
    const v6Count = await db.rentalVehicle.count({ where: { hubId: 'test-hub-6' } });
    expect(v6Count, 'sixth Hub vehicle count').toBe(1);
  });
});
