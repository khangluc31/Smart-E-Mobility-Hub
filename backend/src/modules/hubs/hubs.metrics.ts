// Pure functions for Hub utilisation, degradation and alternatives ranking.
// No Prisma, no Express, no side effects — testable in isolation.

import type { Alternative } from '../../types/common';
import type { ClassCount } from '../../types/hubs';
import type { VehicleClass } from '../../types/enums';

export function utilPct(used: number, total: number, withdrawn: number): number {
  if (total === 0) return 0;
  const usable = total - withdrawn;
  if (usable === 0) return 100;
  return (used / usable) * 100;
}

export function roundTo1(n: number): number {
  return Math.round(n * 10) / 10;
}

export function classCount(free: number, total: number, rawUtil: number): ClassCount {
  return { free, total, utilPct: roundTo1(rawUtil) };
}

export function isDegraded(
  lastTelemetryAt: Date | null,
  now: Date,
  stalledIntervals: number,
  intervalSec: number,
): boolean {
  if (lastTelemetryAt === null) return true;
  const elapsedSec = (now.getTime() - lastTelemetryAt.getTime()) / 1000;
  return elapsedSec >= stalledIntervals * intervalSec;
}

export function isNearCapacity(
  parking: Record<VehicleClass, ClassCount>,
  publicParking: Record<VehicleClass, ClassCount>,
  charging: Record<VehicleClass, ClassCount>,
  rawUtils: { parkingRaw: Record<VehicleClass, number>; chargingRaw: Record<VehicleClass, number> },
  threshold: number,
): boolean {
  for (const vc of Object.keys(parking) as VehicleClass[]) {
    if (parking[vc].total > 0 && rawUtils.parkingRaw[vc] >= threshold) return true;
  }
  for (const vc of Object.keys(charging) as VehicleClass[]) {
    if (charging[vc].total > 0 && rawUtils.chargingRaw[vc] >= threshold) return true;
  }
  return false;
}

export function rankAlternatives(
  items: Array<{ hubId: string; hubName: string; free: number }>,
  redirectTargetHubId: string | null,
  excludeHubName: string | null,
  needLabel: string,
): Alternative[] {
  return [...items]
    .sort((a, b) => {
      if (redirectTargetHubId) {
        if (a.hubId === redirectTargetHubId && b.hubId !== redirectTargetHubId) return -1;
        if (b.hubId === redirectTargetHubId && a.hubId !== redirectTargetHubId) return 1;
      }
      if (a.free !== b.free) return b.free - a.free;
      return a.hubId.localeCompare(b.hubId);
    })
    .map((h) => ({
      type: 'hub' as const,
      hubId: h.hubId,
      hubName: h.hubName,
      free: h.free,
      reason:
        h.hubId === redirectTargetHubId && excludeHubName
          ? `Recommended redirect from ${excludeHubName}. ${h.free} ${needLabel}.`
          : `${h.free} ${needLabel}.`,
    }));
}
