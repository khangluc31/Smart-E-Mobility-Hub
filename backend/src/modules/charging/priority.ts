// Pure charging priority scoring and queue ordering (BR-06, D-08, ARCHITECTURE §9.1).
// Imports only types/* and core/time.ts so simulation/engine.ts can import it directly.

import { clamp, minutesBetween } from '../../core/time';
import type { ChargingScoreBreakdown, ChargingWeights } from '../../types/charging';

export interface PriorityConfig {
  urgencyHorizonMin: number;
  waitingFullMin: number;
}

export interface PriorityEntry {
  id: string;
  currentPct: number;
  desiredTime: Date;
  neededBy: Date | null;
  createdAt: Date;
  manualAdjust: number;
}

// Weighted score components (D-08); sum of the four parts equals score().
export function scoreBreakdown(
  entry: PriorityEntry,
  weights: ChargingWeights,
  now: Date,
  cfg: PriorityConfig,
): ChargingScoreBreakdown {
  const batteryRaw = 100 - entry.currentPct;

  let urgencyRaw = 0;
  if (entry.neededBy) {
    const minsUntil = minutesBetween(now, entry.neededBy);
    urgencyRaw =
      cfg.urgencyHorizonMin > 0
        ? clamp(0, 100, 100 * (1 - minsUntil / cfg.urgencyHorizonMin))
        : minsUntil <= 0
          ? 100
          : 0;
  }

  // Waiting counts from max(createdAt, desiredTime): a request waits only once eligible.
  const eligibleAtMs = Math.max(entry.createdAt.getTime(), entry.desiredTime.getTime());
  const waitingMin = minutesBetween(new Date(eligibleAtMs), now);
  const waitingRaw =
    waitingMin <= 0
      ? 0
      : cfg.waitingFullMin > 0
        ? clamp(0, 100, (waitingMin / cfg.waitingFullMin) * 100)
        : 100;

  return {
    battery: weights.battery * batteryRaw,
    urgency: weights.urgency * urgencyRaw,
    waiting: weights.waiting * waitingRaw,
    manualAdjust: entry.manualAdjust,
  };
}

export function score(
  entry: PriorityEntry,
  weights: ChargingWeights,
  now: Date,
  cfg: PriorityConfig,
): number {
  const b = scoreBreakdown(entry, weights, now, cfg);
  return b.battery + b.urgency + b.waiting + b.manualAdjust;
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// BR-06: score DESC; ties -> lower currentPct, earlier neededBy (null last), earlier createdAt, id ASC.
export function rankQueue<T extends PriorityEntry>(
  entries: readonly T[],
  weights: ChargingWeights,
  now: Date,
  cfg: PriorityConfig,
): T[] {
  const scored = entries.map((entry) => ({
    entry,
    s: score(entry, weights, now, cfg),
  }));

  scored.sort((a, b) => {
    if (b.s !== a.s) return b.s - a.s;
    if (a.entry.currentPct !== b.entry.currentPct) {
      return a.entry.currentPct - b.entry.currentPct;
    }
    const aNeeded = a.entry.neededBy ? a.entry.neededBy.getTime() : Number.POSITIVE_INFINITY;
    const bNeeded = b.entry.neededBy ? b.entry.neededBy.getTime() : Number.POSITIVE_INFINITY;
    if (aNeeded !== bNeeded) return aNeeded - bNeeded;

    const aCreated = a.entry.createdAt.getTime();
    const bCreated = b.entry.createdAt.getTime();
    if (aCreated !== bCreated) return aCreated - bCreated;

    return compareStrings(a.entry.id, b.entry.id);
  });

  return scored.map((x) => x.entry);
}

// Orders QUEUED requests for one Hub and one VehicleClass:
// 1) Eligible (desiredTime <= now) ranked by rankQueue;
// 2) Not-yet-eligible (desiredTime > now) sorted by desiredTime ASC, createdAt ASC, id ASC.
// queuePosition = 1-based index in this combined list.
export function orderForHub<T extends PriorityEntry>(
  entries: readonly T[],
  weights: ChargingWeights,
  now: Date,
  cfg: PriorityConfig,
): T[] {
  const nowMs = now.getTime();
  const eligible: T[] = [];
  const future: T[] = [];

  for (const e of entries) {
    if (e.desiredTime.getTime() <= nowMs) {
      eligible.push(e);
    } else {
      future.push(e);
    }
  }

  const rankedEligible = rankQueue(eligible, weights, now, cfg);

  future.sort((a, b) => {
    const dt = a.desiredTime.getTime() - b.desiredTime.getTime();
    if (dt !== 0) return dt;
    const ct = a.createdAt.getTime() - b.createdAt.getTime();
    if (ct !== 0) return ct;
    return compareStrings(a.id, b.id);
  });

  return [...rankedEligible, ...future];
}
