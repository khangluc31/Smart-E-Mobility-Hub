// Telemetry generator (ARCHITECTURE §7.2, D-02, D-09, D-10, D-17).
// buildPacket() is pure (no Prisma/Express); readHubState() reads one Hub's resources;
// generateAll() runs every tick for all non-stalled Hubs.

import { config } from '../core/config';
import { db, type DbClient } from '../core/db';
import type { RentalVehicleStatus, VehicleClass } from '../types/enums';
import type {
  TelemetryPacket,
  TelemetryPrivateEvItem,
  TelemetryResourceFaultItem,
  TelemetryVehicleItem,
} from '../types/telemetry';
import {
  consumeHubDemoDirectives,
  isHubStalled,
  type HubDemoDirectives,
  type QueuedFault,
} from './demoState';
import { ingest } from './ingestion';

export interface GeneratorRentalVehicle {
  id: string;
  status: RentalVehicleStatus;
  batteryPct: number;
  chargingTargetPct?: number | null;
}

export interface GeneratorPrivateEv {
  id: string;
  vehicleClass: VehicleClass;
  batteryPct: number;
  chargingTargetPct: number;
}

export interface GeneratorResource {
  id: string;
}

export interface HubGeneratorState {
  hubId: string;
  vehicles: GeneratorRentalVehicle[];
  privateEvs: GeneratorPrivateEv[];
  parkingSpaces: GeneratorResource[];
  chargingPoints: GeneratorResource[];
}

export interface DemoDirectivesInput {
  batteryOverrides?: Map<string, number> | Record<string, number>;
  faults?: QueuedFault[];
}

function cleanFloat(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}

function clamp(min: number, max: number, val: number): number {
  return Math.max(min, Math.min(max, val));
}

function takeBatteryOverride(
  overrides: Map<string, number> | Record<string, number> | undefined,
  vehicleId: string,
): number | undefined {
  if (!overrides) return undefined;
  if (overrides instanceof Map) {
    const val = overrides.get(vehicleId);
    if (val !== undefined) overrides.delete(vehicleId);
    return val;
  }
  const val = overrides[vehicleId];
  if (val !== undefined) delete overrides[vehicleId];
  return val;
}

function takeQueuedFault(
  faults: QueuedFault[] | undefined,
  resourceType: QueuedFault['resourceType'],
  resourceId: string,
): string | undefined {
  if (!faults || faults.length === 0) return undefined;
  const idx = faults.findIndex(
    (f) => f.resourceType === resourceType && f.resourceId === resourceId,
  );
  if (idx < 0) return undefined;
  const [match] = faults.splice(idx, 1);
  return match?.faultCode;
}

// Pure packet builder (Rule 6, AC-8). Computes battery drain/gain, consumes demo overrides
// and queued faults, rolls random faults via rng, and returns a SIMULATOR packet.
export function buildPacket(
  hubState: HubGeneratorState,
  demo: DemoDirectivesInput | HubDemoDirectives = {},
  now: Date = new Date(),
  rng: () => number = Math.random,
): TelemetryPacket {
  const dtMinutes = (config.TELEMETRY_INTERVAL_SEC * config.DEMO_TIME_SCALE) / 60;
  const drainDelta = config.BATTERY_DRAIN_PCT_PER_MIN * dtMinutes;
  const motoChargeDelta = config.CHARGE_RATE_PCT_PER_MIN.MOTORCYCLE * dtMinutes;

  const vehicles: TelemetryVehicleItem[] = [];
  for (const v of hubState.vehicles) {
    const override = takeBatteryOverride(demo.batteryOverrides, v.id);
    let nextBattery = v.batteryPct;
    let batteryChanged = false;

    if (override !== undefined) {
      nextBattery = cleanFloat(clamp(0, 100, override));
      batteryChanged = true;
    } else if (v.chargingTargetPct !== undefined && v.chargingTargetPct !== null) {
      const cap = Math.min(100, v.chargingTargetPct);
      if (v.batteryPct < cap) {
        nextBattery = cleanFloat(Math.min(cap, v.batteryPct + motoChargeDelta));
        batteryChanged = nextBattery !== v.batteryPct;
      }
    } else if (v.status === 'IN_USE') {
      nextBattery = cleanFloat(Math.max(0, v.batteryPct - drainDelta));
      batteryChanged = nextBattery !== v.batteryPct;
    }

    let faultCode = takeQueuedFault(demo.faults, 'RENTAL_VEHICLE', v.id);
    if (!faultCode && config.FAULT_PROBABILITY > 0 && rng() < config.FAULT_PROBABILITY) {
      faultCode = 'SIM_VEHICLE_FAULT';
    }

    if (batteryChanged || faultCode) {
      const entry: TelemetryVehicleItem = { id: v.id, batteryPct: nextBattery };
      if (faultCode) entry.faultCode = faultCode;
      vehicles.push(entry);
    }
  }

  const privateEvs: TelemetryPrivateEvItem[] = [];
  for (const pev of hubState.privateEvs) {
    const rate = config.CHARGE_RATE_PCT_PER_MIN[pev.vehicleClass];
    const gainDelta = rate * dtMinutes;
    const cap = Math.min(100, pev.chargingTargetPct);
    if (pev.batteryPct < cap) {
      const nextBattery = cleanFloat(Math.min(cap, pev.batteryPct + gainDelta));
      if (nextBattery !== pev.batteryPct) {
        privateEvs.push({ id: pev.id, batteryPct: nextBattery });
      }
    }
  }

  const parkingSpaces: TelemetryResourceFaultItem[] = [];
  for (const s of hubState.parkingSpaces) {
    let faultCode = takeQueuedFault(demo.faults, 'PARKING_SPACE', s.id);
    if (!faultCode && config.FAULT_PROBABILITY > 0 && rng() < config.FAULT_PROBABILITY) {
      faultCode = 'SIM_SPACE_FAULT';
    }
    if (faultCode) {
      parkingSpaces.push({ id: s.id, faultCode });
    }
  }

  const chargingPoints: TelemetryResourceFaultItem[] = [];
  for (const pt of hubState.chargingPoints) {
    let faultCode = takeQueuedFault(demo.faults, 'CHARGING_POINT', pt.id);
    if (!faultCode && config.FAULT_PROBABILITY > 0 && rng() < config.FAULT_PROBABILITY) {
      faultCode = 'SIM_POINT_FAULT';
    }
    if (faultCode) {
      chargingPoints.push({ id: pt.id, faultCode });
    }
  }

  return {
    hubId: hubState.hubId,
    timestamp: now.toISOString(),
    source: 'SIMULATOR',
    vehicles,
    privateEvs,
    parkingSpaces,
    chargingPoints,
  };
}

export async function readHubState(
  hubId: string,
  client: DbClient = db,
): Promise<HubGeneratorState> {
  const [vehicles, chargingRequests, parkingSpaces, chargingPoints] = await Promise.all([
    client.rentalVehicle.findMany({
      where: { hubId },
      orderBy: { id: 'asc' },
      select: { id: true, status: true, batteryPct: true },
    }),
    client.chargingRequest.findMany({
      where: { hubId, status: 'CHARGING' },
      select: {
        rentalVehicleId: true,
        privateEvId: true,
        targetPct: true,
        privateEv: {
          select: { id: true, vehicleClass: true, batteryPct: true, deletedAt: true },
        },
      },
    }),
    client.parkingSpace.findMany({
      where: { hubId },
      orderBy: { id: 'asc' },
      select: { id: true },
    }),
    client.chargingPoint.findMany({
      where: { hubId },
      orderBy: { id: 'asc' },
      select: { id: true },
    }),
  ]);

  const rentalChargingTarget = new Map<string, number>();
  const privateEvs: GeneratorPrivateEv[] = [];
  for (const cr of chargingRequests) {
    if (cr.rentalVehicleId) {
      rentalChargingTarget.set(cr.rentalVehicleId, cr.targetPct);
    }
    if (cr.privateEvId && cr.privateEv && cr.privateEv.deletedAt === null) {
      privateEvs.push({
        id: cr.privateEv.id,
        vehicleClass: cr.privateEv.vehicleClass,
        batteryPct: cr.privateEv.batteryPct,
        chargingTargetPct: cr.targetPct,
      });
    }
  }

  return {
    hubId,
    vehicles: vehicles.map((v) => ({
      id: v.id,
      status: v.status,
      batteryPct: v.batteryPct,
      chargingTargetPct: rentalChargingTarget.get(v.id) ?? null,
    })),
    privateEvs,
    parkingSpaces,
    chargingPoints,
  };
}

export async function generateAll(now: Date = new Date()): Promise<void> {
  const hubs = await db.hub.findMany({
    orderBy: { id: 'asc' },
    select: { id: true },
  });

  for (const hub of hubs) {
    if (isHubStalled(hub.id, now)) {
      continue;
    }
    try {
      const state = await readHubState(hub.id, db);
      const demo = consumeHubDemoDirectives(hub.id);
      const packet = buildPacket(state, demo, now);
      await ingest(packet, now, db);
    } catch (err) {
      console.error(`[telemetry.generate] failed for Hub "${hub.id}"`, err);
    }
  }
}
