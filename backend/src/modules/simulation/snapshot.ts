// Read-only live-state snapshot for What-if Simulation (FR-53, BR-11, ARCHITECTURE §12.2, D-07).
// Runs one REPEATABLE READ, READ ONLY transaction taking zero row locks and returning plain JSON.

import { config } from '../../core/config';
import { db } from '../../core/db';
import type { ChargingWeights } from '../../types/charging';
import type { SimSnapshot } from '../../types/simulation';
import { CHARGING_WEIGHTS_SETTING_KEY } from '../charging/charging.service';

function parseWeights(val: unknown): ChargingWeights {
  if (val && typeof val === 'object' && !Array.isArray(val)) {
    const o = val as Record<string, unknown>;
    const b = o['battery'];
    const u = o['urgency'];
    const w = o['waiting'];
    if (
      typeof b === 'number' &&
      Number.isFinite(b) &&
      b >= 0 &&
      typeof u === 'number' &&
      Number.isFinite(u) &&
      u >= 0 &&
      typeof w === 'number' &&
      Number.isFinite(w) &&
      w >= 0 &&
      b + u + w > 0
    ) {
      return { battery: b, urgency: u, waiting: w };
    }
  }
  return {
    battery: config.CHARGING_WEIGHTS.battery,
    urgency: config.CHARGING_WEIGHTS.urgency,
    waiting: config.CHARGING_WEIGHTS.waiting,
  };
}

/**
 * FR-53, BR-11: Takes a consistent, non-blocking, read-only snapshot of live operational state.
 */
export async function takeSnapshot(now: Date = new Date()): Promise<SimSnapshot> {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`;

    const [
      hubs,
      thresholds,
      parkingSpaces,
      chargingPoints,
      vehicles,
      vehicleReservations,
      parkingReservations,
      chargingRequests,
      weightsSetting,
    ] = await Promise.all([
      tx.hub.findMany({
        orderBy: { id: 'asc' },
        select: { id: true, name: true, lastTelemetryAt: true },
      }),
      tx.hubThreshold.findMany({
        orderBy: [{ hubId: 'asc' }, { vehicleClass: 'asc' }],
        select: { hubId: true, vehicleClass: true, minAvailable: true, maxAvailable: true },
      }),
      tx.parkingSpace.findMany({
        orderBy: { id: 'asc' },
        select: { id: true, hubId: true, vehicleClass: true, pool: true, status: true },
      }),
      tx.chargingPoint.findMany({
        orderBy: { id: 'asc' },
        select: { id: true, hubId: true, vehicleClass: true, status: true },
      }),
      tx.rentalVehicle.findMany({
        orderBy: { id: 'asc' },
        select: {
          id: true,
          hubId: true,
          type: true,
          vehicleClass: true,
          status: true,
          batteryPct: true,
          parkingSpaceId: true,
        },
      }),
      tx.vehicleReservation.findMany({
        where: { status: { in: ['CONFIRMED', 'ACTIVE'] } },
        orderBy: { id: 'asc' },
        select: { id: true, rentalVehicleId: true, hubId: true, status: true, expiresAt: true },
      }),
      tx.parkingReservation.findMany({
        where: { status: { in: ['CONFIRMED', 'ACTIVE'] } },
        orderBy: { id: 'asc' },
        select: {
          id: true,
          parkingSpaceId: true,
          hubId: true,
          vehicleClass: true,
          status: true,
          windowStart: true,
          windowEnd: true,
        },
      }),
      tx.chargingRequest.findMany({
        where: { status: { in: ['QUEUED', 'SCHEDULED', 'CHARGING'] } },
        orderBy: { id: 'asc' },
        select: {
          id: true,
          hubId: true,
          vehicleKind: true,
          vehicleClass: true,
          rentalVehicleId: true,
          privateEvId: true,
          status: true,
          currentPct: true,
          targetPct: true,
          desiredTime: true,
          neededBy: true,
          createdAt: true,
          manualAdjust: true,
          chargingPointId: true,
          slotStart: true,
          slotEnd: true,
        },
      }),
      tx.setting.findUnique({
        where: { key: CHARGING_WEIGHTS_SETTING_KEY },
        select: { value: true },
      }),
    ]);

    return {
      takenAt: now.toISOString(),
      weights: parseWeights(weightsSetting?.value),
      hubs: hubs.map((h) => ({
        id: h.id,
        name: h.name,
        lastTelemetryAt: h.lastTelemetryAt ? h.lastTelemetryAt.toISOString() : null,
      })),
      thresholds: thresholds.map((t) => ({
        hubId: t.hubId,
        vehicleClass: t.vehicleClass,
        minAvailable: t.minAvailable,
        maxAvailable: t.maxAvailable,
      })),
      parkingSpaces: parkingSpaces.map((s) => ({
        id: s.id,
        hubId: s.hubId,
        vehicleClass: s.vehicleClass,
        pool: s.pool,
        status: s.status,
      })),
      chargingPoints: chargingPoints.map((p) => ({
        id: p.id,
        hubId: p.hubId,
        vehicleClass: p.vehicleClass,
        status: p.status,
      })),
      vehicles: vehicles.map((v) => ({
        id: v.id,
        hubId: v.hubId,
        type: v.type,
        vehicleClass: v.vehicleClass,
        status: v.status,
        batteryPct: v.batteryPct,
        parkingSpaceId: v.parkingSpaceId,
      })),
      vehicleReservations: vehicleReservations.map((r) => ({
        id: r.id,
        rentalVehicleId: r.rentalVehicleId,
        hubId: r.hubId,
        status: r.status,
        expiresAt: r.expiresAt.toISOString(),
      })),
      parkingReservations: parkingReservations.map((r) => ({
        id: r.id,
        parkingSpaceId: r.parkingSpaceId,
        hubId: r.hubId,
        vehicleClass: r.vehicleClass,
        status: r.status,
        windowStart: r.windowStart.toISOString(),
        windowEnd: r.windowEnd.toISOString(),
      })),
      chargingRequests: chargingRequests.map((r) => ({
        id: r.id,
        hubId: r.hubId,
        vehicleKind: r.vehicleKind,
        vehicleClass: r.vehicleClass,
        rentalVehicleId: r.rentalVehicleId,
        privateEvId: r.privateEvId,
        status: r.status,
        currentPct: r.currentPct,
        targetPct: r.targetPct,
        desiredTime: r.desiredTime.toISOString(),
        neededBy: r.neededBy ? r.neededBy.toISOString() : null,
        createdAt: r.createdAt.toISOString(),
        manualAdjust: r.manualAdjust,
        chargingPointId: r.chargingPointId,
        slotStart: r.slotStart ? r.slotStart.toISOString() : null,
        slotEnd: r.slotEnd ? r.slotEnd.toISOString() : null,
      })),
    };
  });
}
