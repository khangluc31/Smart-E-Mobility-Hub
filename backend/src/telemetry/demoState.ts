// In-memory demo state for telemetry simulation controls (D-02: single backend instance).
// Controls Hub stalls, queued fault injections (FR-36), and queued battery overrides (FR-33).

import type { IncidentResourceType } from '../types/enums';

export interface QueuedFault {
  resourceType: IncidentResourceType;
  resourceId: string;
  hubId: string;
  faultCode: string;
}

export interface QueuedBatteryOverride {
  vehicleId: string;
  hubId: string;
  batteryPct: number;
}

export interface HubDemoDirectives {
  batteryOverrides: Map<string, number>;
  faults: QueuedFault[];
}

const stalledUntilByHub = new Map<string, Date>();
const queuedFaults: QueuedFault[] = [];
const queuedBatteryOverrides = new Map<string, QueuedBatteryOverride>();

export function setHubStall(hubId: string, stalledUntil: Date): void {
  stalledUntilByHub.set(hubId, stalledUntil);
}

export function isHubStalled(hubId: string, now: Date): boolean {
  const until = stalledUntilByHub.get(hubId);
  if (!until) return false;
  if (now < until) return true;
  stalledUntilByHub.delete(hubId);
  return false;
}

export function getHubStalledUntil(hubId: string): Date | undefined {
  return stalledUntilByHub.get(hubId);
}

export function enqueueFault(fault: QueuedFault): void {
  const existingIdx = queuedFaults.findIndex(
    (f) => f.resourceType === fault.resourceType && f.resourceId === fault.resourceId,
  );
  if (existingIdx >= 0) {
    queuedFaults[existingIdx] = fault;
  } else {
    queuedFaults.push(fault);
  }
}

export function enqueueBatteryOverride(override: QueuedBatteryOverride): void {
  queuedBatteryOverrides.set(override.vehicleId, override);
}

// Reads and removes all queued battery overrides and faults for one Hub (consumed on generator tick).
export function consumeHubDemoDirectives(hubId: string): HubDemoDirectives {
  const batteryOverrides = new Map<string, number>();
  for (const [vehicleId, entry] of queuedBatteryOverrides.entries()) {
    if (entry.hubId === hubId) {
      batteryOverrides.set(vehicleId, entry.batteryPct);
      queuedBatteryOverrides.delete(vehicleId);
    }
  }

  const faults: QueuedFault[] = [];
  for (let i = queuedFaults.length - 1; i >= 0; i--) {
    const item = queuedFaults[i];
    if (item && item.hubId === hubId) {
      faults.unshift(item);
      queuedFaults.splice(i, 1);
    }
  }

  return { batteryOverrides, faults };
}

export function resetDemoState(): void {
  stalledUntilByHub.clear();
  queuedFaults.length = 0;
  queuedBatteryOverrides.clear();
}
