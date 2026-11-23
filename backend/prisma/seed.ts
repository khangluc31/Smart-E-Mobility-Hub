// Idempotent, deterministic database seed (ARCHITECTURE §5.3, T-07).
// Writes in FK order: hub → hub_threshold → setting → user → private_ev →
// parking_space → charging_point → rental_vehicle.
// On re-run, refreshes only static fields and never overwrites live state
// (status, batteryPct, parkingSpaceId, lastTelemetryAt, passwordHash).

import 'dotenv/config';
import bcrypt from 'bcryptjs';
import type { PrismaClient } from '@prisma/client';
import { config } from '../src/core/config';
import { db } from '../src/core/db';
import type {
  ChargingPointStatus,
  ParkingPool,
  ParkingSpaceStatus,
  RentalVehicleStatus,
  RentalVehicleType,
  VehicleClass,
} from '../src/types/enums';
import { SEED_DATA, type HubSeedRow, type SeedData } from './seed-data';

const BCRYPT_COST = 10;
const PRNG_SEED = 0x5eed_2026;
const BATCH_CHUNK_SIZE = 100;

export interface SeedOptions {
  data?: SeedData;
}

export interface SeedSummary {
  hubs: number;
  hubThresholds: number;
  settings: number;
  users: number;
  privateEvs: number;
  parkingSpaces: number;
  chargingPoints: number;
  rentalVehicles: number;
}

/** Deterministic mulberry32 PRNG (no Math.random). */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function resolveSeedPassword(): string {
  const raw = process.env['SEED_PASSWORD'];
  const nodeEnv = process.env['NODE_ENV'] ?? config.NODE_ENV;
  if (raw === undefined || raw.trim() === '') {
    if (nodeEnv === 'production') {
      throw new Error('Seed: SEED_PASSWORD is required when NODE_ENV=production');
    }
    console.warn('[seed] Warning: SEED_PASSWORD is not set; using default dev password.');
    return 'change-me';
  }
  return raw;
}

interface GeneratedParkingSpace {
  id: string;
  hubId: string;
  vehicleClass: VehicleClass;
  pool: ParkingPool;
  status: ParkingSpaceStatus;
}

interface GeneratedChargingPoint {
  id: string;
  hubId: string;
  vehicleClass: VehicleClass;
  status: ChargingPointStatus;
}

interface GeneratedRentalVehicle {
  id: string;
  hubId: string;
  type: RentalVehicleType;
  vehicleClass: VehicleClass;
  status: RentalVehicleStatus;
  batteryPct: number;
  parkingSpaceId: string;
}

function validateHubRow(hub: HubSeedRow): void {
  if (hub.rentalVehicles > hub.fleetMotoSpaces) {
    throw new Error(
      `Seed: Hub "${hub.id}" (${hub.code}) has rentalVehicles (${hub.rentalVehicles}) > fleetMotoSpaces (${hub.fleetMotoSpaces}).`,
    );
  }
}

function buildResources(hubs: readonly HubSeedRow[]): {
  parkingSpaces: GeneratedParkingSpace[];
  chargingPoints: GeneratedChargingPoint[];
  rentalVehicles: GeneratedRentalVehicle[];
} {
  const rng = mulberry32(PRNG_SEED);
  const parkingSpaces: GeneratedParkingSpace[] = [];
  const chargingPoints: GeneratedChargingPoint[] = [];
  const rentalVehicles: GeneratedRentalVehicle[] = [];

  let globalVehicleIdx = 0;

  for (const hub of hubs) {
    validateHubRow(hub);

    // 1. Parking spaces: FLEET moto (<CODE>-PF-M-001), PUBLIC moto (<CODE>-PP-M-001), PUBLIC car (<CODE>-PP-C-001)
    for (let i = 1; i <= hub.fleetMotoSpaces; i++) {
      const spaceId = `${hub.code}-PF-M-${String(i).padStart(3, '0')}`;
      // First `hub.rentalVehicles` FLEET spaces are OCCUPIED by that Hub's vehicles (D-14)
      const isOccupied = i <= hub.rentalVehicles;
      parkingSpaces.push({
        id: spaceId,
        hubId: hub.id,
        vehicleClass: 'MOTORCYCLE',
        pool: 'FLEET',
        status: isOccupied ? 'OCCUPIED' : 'FREE',
      });
    }

    for (let i = 1; i <= hub.publicMotoSpaces; i++) {
      parkingSpaces.push({
        id: `${hub.code}-PP-M-${String(i).padStart(3, '0')}`,
        hubId: hub.id,
        vehicleClass: 'MOTORCYCLE',
        pool: 'PUBLIC',
        status: 'FREE',
      });
    }

    for (let i = 1; i <= hub.publicCarSpaces; i++) {
      parkingSpaces.push({
        id: `${hub.code}-PP-C-${String(i).padStart(3, '0')}`,
        hubId: hub.id,
        vehicleClass: 'CAR',
        pool: 'PUBLIC',
        status: 'FREE',
      });
    }

    // 2. Charging points: moto (<CODE>-CP-M-01), car (<CODE>-CP-C-01) — all AVAILABLE
    for (let i = 1; i <= hub.motoChargingPoints; i++) {
      chargingPoints.push({
        id: `${hub.code}-CP-M-${String(i).padStart(2, '0')}`,
        hubId: hub.id,
        vehicleClass: 'MOTORCYCLE',
        status: 'AVAILABLE',
      });
    }

    for (let i = 1; i <= hub.carChargingPoints; i++) {
      chargingPoints.push({
        id: `${hub.code}-CP-C-${String(i).padStart(2, '0')}`,
        hubId: hub.id,
        vehicleClass: 'CAR',
        status: 'AVAILABLE',
      });
    }

    // 3. Rental vehicles: RV-0001..RV-0300 across Hubs in Hub order
    for (let localIdx = 0; localIdx < hub.rentalVehicles; localIdx++) {
      globalVehicleIdx += 1;
      const vehicleId = `RV-${String(globalVehicleIdx).padStart(4, '0')}`;
      const fleetSpaceId = `${hub.code}-PF-M-${String(localIdx + 1).padStart(3, '0')}`;

      // Deterministic ~60% E_MOTORCYCLE, ~40% E_BICYCLE per Hub
      const type: RentalVehicleType = localIdx % 5 < 3 ? 'E_MOTORCYCLE' : 'E_BICYCLE';

      // Deterministic battery spread across 10.0–100.0 (1 decimal):
      // Every 10th vehicle at the Hub is placed in [10.0, 19.5] (< 20 → LOW_BATTERY, BR-02);
      // remaining vehicles are spread across [20.0, 100.0] (≥ 20 → AVAILABLE).
      const u = rng();
      const rawBattery =
        localIdx % 10 === 0 ? 10 + u * 9.5 : 20 + u * 80;
      const batteryPct = Math.min(100, Math.max(10, round1(rawBattery)));

      // BR-02: batteryPct < MIN_RENTAL_BATTERY_PCT → LOW_BATTERY, else AVAILABLE
      const status: RentalVehicleStatus =
        batteryPct < config.MIN_RENTAL_BATTERY_PCT ? 'LOW_BATTERY' : 'AVAILABLE';

      rentalVehicles.push({
        id: vehicleId,
        hubId: hub.id,
        type,
        vehicleClass: 'MOTORCYCLE',
        status,
        batteryPct,
        parkingSpaceId: fleetSpaceId,
      });
    }
  }

  return { parkingSpaces, chargingPoints, rentalVehicles };
}

function chunkArray<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

export async function seed(
  client: PrismaClient = db,
  opts?: SeedOptions,
): Promise<SeedSummary> {
  const data = opts?.data ?? SEED_DATA;
  const { parkingSpaces, chargingPoints, rentalVehicles } = buildResources(data.hubs);

  const seedPassword = resolveSeedPassword();
  const passwordHash = await bcrypt.hash(seedPassword, BCRYPT_COST);

  // 1. hub (FK order #1) — on update: only name and location (never lastTelemetryAt)
  await client.$transaction(
    data.hubs.map((h) =>
      client.hub.upsert({
        where: { id: h.id },
        create: {
          id: h.id,
          name: h.name,
          location: h.location,
        },
        update: {
          name: h.name,
          location: h.location,
        },
      }),
    ),
  );

  // 2. hub_threshold (FK order #2) — MOTORCYCLE min/max per Hub
  await client.$transaction(
    data.hubs.map((h) =>
      client.hubThreshold.upsert({
        where: {
          hubId_vehicleClass: {
            hubId: h.id,
            vehicleClass: 'MOTORCYCLE',
          },
        },
        create: {
          id: `HT-${h.id}-MOTORCYCLE`,
          hubId: h.id,
          vehicleClass: 'MOTORCYCLE',
          minAvailable: h.minAvailable,
          maxAvailable: h.maxAvailable,
        },
        update: {
          minAvailable: h.minAvailable,
          maxAvailable: h.maxAvailable,
        },
      }),
    ),
  );

  // 3. setting (FK order #3) — charging.weights from config.CHARGING_WEIGHTS
  const weightsValue = {
    battery: config.CHARGING_WEIGHTS.battery,
    urgency: config.CHARGING_WEIGHTS.urgency,
    waiting: config.CHARGING_WEIGHTS.waiting,
  };
  await client.setting.upsert({
    where: { key: 'charging.weights' },
    create: {
      key: 'charging.weights',
      value: weightsValue,
    },
    update: {
      value: weightsValue,
    },
  });

  // 4. user (FK order #4) — on update: only displayName and role (never passwordHash)
  await client.$transaction(
    data.accounts.map((acc) =>
      client.user.upsert({
        where: { id: acc.id },
        create: {
          id: acc.id,
          identifier: acc.identifier,
          passwordHash,
          displayName: acc.displayName,
          role: acc.role,
          mustChangePassword: acc.mustChangePassword,
        },
        update: {
          displayName: acc.displayName,
          role: acc.role,
        },
      }),
    ),
  );

  // 5. private_ev (FK order #5) — on update: static fields only (never batteryPct or deletedAt)
  await client.$transaction(
    data.privateEvs.map((pev) =>
      client.privateEv.upsert({
        where: { id: pev.id },
        create: {
          id: pev.id,
          ownerId: pev.ownerId,
          type: pev.type,
          vehicleClass: pev.vehicleClass,
          label: pev.label,
          batteryCapacityKwh: pev.batteryCapacityKwh,
          batteryPct: pev.batteryPct,
        },
        update: {
          ownerId: pev.ownerId,
          type: pev.type,
          vehicleClass: pev.vehicleClass,
          label: pev.label,
          batteryCapacityKwh: pev.batteryCapacityKwh,
        },
      }),
    ),
  );

  // 6. parking_space (FK order #6) — on update: static fields only (never status or reservedForTaskId)
  const existingSpaces = await client.parkingSpace.findMany({ select: { id: true } });
  const existingSpaceIds = new Set(existingSpaces.map((s) => s.id));
  const newSpaces = parkingSpaces.filter((s) => !existingSpaceIds.has(s.id));
  const spacesToUpdate = parkingSpaces.filter((s) => existingSpaceIds.has(s.id));

  if (newSpaces.length > 0) {
    await client.parkingSpace.createMany({ data: newSpaces, skipDuplicates: true });
  }
  for (const chunk of chunkArray(spacesToUpdate, BATCH_CHUNK_SIZE)) {
    await client.$transaction(
      chunk.map((s) =>
        client.parkingSpace.update({
          where: { id: s.id },
          data: {
            hubId: s.hubId,
            vehicleClass: s.vehicleClass,
            pool: s.pool,
          },
        }),
      ),
    );
  }

  // 7. charging_point (FK order #7) — on update: static fields only (never status)
  const existingPoints = await client.chargingPoint.findMany({ select: { id: true } });
  const existingPointIds = new Set(existingPoints.map((p) => p.id));
  const newPoints = chargingPoints.filter((p) => !existingPointIds.has(p.id));
  const pointsToUpdate = chargingPoints.filter((p) => existingPointIds.has(p.id));

  if (newPoints.length > 0) {
    await client.chargingPoint.createMany({ data: newPoints, skipDuplicates: true });
  }
  for (const chunk of chunkArray(pointsToUpdate, BATCH_CHUNK_SIZE)) {
    await client.$transaction(
      chunk.map((p) =>
        client.chargingPoint.update({
          where: { id: p.id },
          data: {
            hubId: p.hubId,
            vehicleClass: p.vehicleClass,
          },
        }),
      ),
    );
  }

  // 8. rental_vehicle (FK order #8, after spaces) — on update: static fields only
  // (never overwrite status, batteryPct, parkingSpaceId, or live hubId)
  const existingVehicles = await client.rentalVehicle.findMany({ select: { id: true } });
  const existingVehicleIds = new Set(existingVehicles.map((v) => v.id));
  const newVehicles = rentalVehicles.filter((v) => !existingVehicleIds.has(v.id));
  const vehiclesToUpdate = rentalVehicles.filter((v) => existingVehicleIds.has(v.id));

  if (newVehicles.length > 0) {
    await client.rentalVehicle.createMany({ data: newVehicles, skipDuplicates: true });
  }
  for (const chunk of chunkArray(vehiclesToUpdate, BATCH_CHUNK_SIZE)) {
    await client.$transaction(
      chunk.map((v) =>
        client.rentalVehicle.update({
          where: { id: v.id },
          data: {
            type: v.type,
            vehicleClass: v.vehicleClass,
          },
        }),
      ),
    );
  }

  const summary: SeedSummary = {
    hubs: data.hubs.length,
    hubThresholds: data.hubs.length,
    settings: 1,
    users: data.accounts.length,
    privateEvs: data.privateEvs.length,
    parkingSpaces: parkingSpaces.length,
    chargingPoints: chargingPoints.length,
    rentalVehicles: rentalVehicles.length,
  };

  console.log(`[seed] hub: ${summary.hubs}`);
  console.log(`[seed] hub_threshold: ${summary.hubThresholds}`);
  console.log(`[seed] setting: ${summary.settings}`);
  console.log(`[seed] user: ${summary.users}`);
  console.log(`[seed] private_ev: ${summary.privateEvs}`);
  console.log(`[seed] parking_space: ${summary.parkingSpaces}`);
  console.log(`[seed] charging_point: ${summary.chargingPoints}`);
  console.log(`[seed] rental_vehicle: ${summary.rentalVehicles}`);

  return summary;
}

if (require.main === module) {
  seed(db)
    .then(async () => {
      await db.$disconnect();
    })
    .catch(async (err: unknown) => {
      console.error('[seed] Failed:', err);
      await db.$disconnect();
      process.exit(1);
    });
}
