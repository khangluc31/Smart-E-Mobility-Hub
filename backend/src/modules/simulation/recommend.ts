// Pure Recommendations generator for What-if Simulation (FR-57, UC-32, ARCHITECTURE §12.4).
// ZERO @prisma/client or core/db imports (enforced by eslint.config.mjs).

import type { RecommendationType } from '../../types/enums';
import type { SimHubSummary, SimInterval, SimSnapshot } from '../../types/simulation';
import { roundTo1 } from '../hubs/hubs.metrics';

export interface RecommendConfig {
  nearCapacityPct: number;
  imbalanceMinDefault: number;
  redistributionDestLimitPct: number;
  minRentalBatteryPct: number;
}

export interface ProposedRecommendation {
  type: RecommendationType;
  payload: Record<string, unknown>;
  projectedImpact: Record<string, number>;
  reason: string;
}

export interface RecommendResult {
  recommendations: ProposedRecommendation[];
  warning: 'NETWORK_SATURATED' | null;
}

/**
 * FR-57, ARCHITECTURE §12.4: Generates actionable recommendations from simulation results.
 * Returns { recommendations: [], warning: null } when no Hub breaches (UC-32 A1),
 * and warning: 'NETWORK_SATURATED' when all Hubs breach parking >= NEAR_CAPACITY_PCT (UC-32 E1).
 */
export function generateRecommendations(
  snapshot: SimSnapshot,
  intervals: readonly SimInterval[],
  summary: readonly SimHubSummary[],
  cfg: RecommendConfig,
): RecommendResult {
  const recommendations: ProposedRecommendation[] = [];

  if (summary.length === 0) {
    return { recommendations: [], warning: null };
  }

  const allHubsSaturated = summary.every(
    (s) => s.peakParkingUtilPct >= cfg.nearCapacityPct,
  );
  const warning: 'NETWORK_SATURATED' | null = allHubsSaturated ? 'NETWORK_SATURATED' : null;

  // Threshold map per Hub for MOTORCYCLE
  const minByHub = new Map<string, number>();
  for (const t of snapshot.thresholds) {
    if (t.vehicleClass === 'MOTORCYCLE') {
      minByHub.set(t.hubId, t.minAvailable);
    }
  }

  // Compute snapshot eligible available vehicles and FLEET space headroom per Hub
  const chargingVehIds = new Set(
    snapshot.chargingRequests
      .filter((r) => (r.status === 'CHARGING' || r.status === 'SCHEDULED') && r.rentalVehicleId)
      .map((r) => r.rentalVehicleId!),
  );
  const reservedVehIds = new Set(
    snapshot.vehicleReservations
      .filter((r) => r.status === 'CONFIRMED' || r.status === 'ACTIVE')
      .map((r) => r.rentalVehicleId),
  );

  const eligibleByHub = new Map<string, number>();
  const fleetStatsByHub = new Map<string, { usable: number; used: number; free: number }>();
  const usableChargingPtsByHub = new Map<string, number>();

  for (const h of snapshot.hubs) {
    eligibleByHub.set(h.id, 0);
    fleetStatsByHub.set(h.id, { usable: 0, used: 0, free: 0 });
    usableChargingPtsByHub.set(h.id, 0);
  }

  for (const v of snapshot.vehicles) {
    if (
      v.vehicleClass === 'MOTORCYCLE' &&
      v.status === 'AVAILABLE' &&
      v.batteryPct >= cfg.minRentalBatteryPct &&
      !chargingVehIds.has(v.id) &&
      !reservedVehIds.has(v.id)
    ) {
      eligibleByHub.set(v.hubId, (eligibleByHub.get(v.hubId) ?? 0) + 1);
    }
  }

  for (const sp of snapshot.parkingSpaces) {
    if (sp.pool === 'FLEET' && sp.vehicleClass === 'MOTORCYCLE' && sp.status !== 'UNAVAILABLE') {
      const st = fleetStatsByHub.get(sp.hubId);
      if (st) {
        st.usable++;
        if (sp.status === 'FREE') st.free++;
        else if (sp.status === 'OCCUPIED' || sp.status === 'RESERVED') st.used++;
      }
    }
  }

  for (const pt of snapshot.chargingPoints) {
    if (pt.status !== 'FAULTY') {
      usableChargingPtsByHub.set(pt.hubId, (usableChargingPtsByHub.get(pt.hubId) ?? 0) + 1);
    }
  }

  // Group intervals by Hub
  const intervalsByHub = new Map<string, SimInterval[]>();
  for (const iv of intervals) {
    const arr = intervalsByHub.get(iv.hubId) ?? [];
    arr.push(iv);
    intervalsByHub.set(iv.hubId, arr);
  }

  // 1. REDISTRIBUTE: Hubs with unservedRental > 0 or min(availableVehicles) < threshold.minAvailable
  const surplusHubs = snapshot.hubs
    .map((h) => {
      const eligible = eligibleByHub.get(h.id) ?? 0;
      const minAvail = minByHub.get(h.id) ?? cfg.imbalanceMinDefault;
      return { hubId: h.id, eligible, surplus: Math.max(0, eligible - minAvail) };
    })
    .sort((a, b) => b.surplus - a.surplus || b.eligible - a.eligible || a.hubId.localeCompare(b.hubId));

  for (const hubSum of summary) {
    const hubIvs = intervalsByHub.get(hubSum.hubId) ?? [];
    const unservedRental = hubIvs.reduce((acc, iv) => acc + iv.unservedRental, 0);
    const minObservedAvail =
      hubIvs.length > 0
        ? Math.min(...hubIvs.map((iv) => iv.availableVehicles))
        : (eligibleByHub.get(hubSum.hubId) ?? 0);
    const minThreshold = minByHub.get(hubSum.hubId) ?? cfg.imbalanceMinDefault;
    const deficit = Math.max(unservedRental, Math.max(0, minThreshold - minObservedAvail));

    if (deficit > 0) {
      const destFleet = fleetStatsByHub.get(hubSum.hubId) ?? { usable: 0, used: 0, free: 0 };
      const maxAllowedUsed = Math.floor(
        (destFleet.usable * cfg.redistributionDestLimitPct) / 100,
      );
      const headroomWithinLimit = Math.max(0, Math.min(destFleet.free, maxAllowedUsed - destFleet.used));

      const source = surplusHubs.find(
        (s) => s.hubId !== hubSum.hubId && (s.surplus > 0 || s.eligible > 1),
      );

      if (source && headroomWithinLimit > 0) {
        const availableToGive = source.surplus > 0 ? source.surplus : Math.max(0, source.eligible - 1);
        const count = Math.min(deficit, availableToGive, headroomWithinLimit);
        if (count >= 1) {
          recommendations.push({
            type: 'REDISTRIBUTE',
            payload: {
              sourceHubId: source.hubId,
              destHubId: hubSum.hubId,
              vehicleClass: 'MOTORCYCLE',
              count,
            },
            projectedImpact: {
              deficitReduced: count,
              unservedRentalBefore: unservedRental,
            },
            reason: `Move ${count} MOTORCYCLE vehicle(s) from ${source.hubId} to ${hubSum.hubId} to relieve projected rental deficit (${deficit}).`,
          });
        }
      }
    }
  }

  // 2. REDIRECT: Hubs with peakParkingUtilPct >= NEAR_CAPACITY_PCT -> lowest peakParkingUtilPct < NEAR_CAPACITY_PCT
  const lowestParkingHub = [...summary]
    .filter((s) => s.peakParkingUtilPct < cfg.nearCapacityPct)
    .sort((a, b) => a.peakParkingUtilPct - b.peakParkingUtilPct || a.hubId.localeCompare(b.hubId))[0];

  if (lowestParkingHub) {
    for (const hubSum of summary) {
      if (hubSum.peakParkingUtilPct >= cfg.nearCapacityPct && hubSum.hubId !== lowestParkingHub.hubId) {
        recommendations.push({
          type: 'REDIRECT',
          payload: {
            fromHubId: hubSum.hubId,
            toHubId: lowestParkingHub.hubId,
            hours: 2,
          },
          projectedImpact: {
            fromPeakParkingUtilPct: hubSum.peakParkingUtilPct,
            toPeakParkingUtilPct: lowestParkingHub.peakParkingUtilPct,
          },
          reason: `Redirect returns and parking from ${hubSum.hubId} (peak ${hubSum.peakParkingUtilPct}%) to ${lowestParkingHub.hubId} (peak ${lowestParkingHub.peakParkingUtilPct}%) for 2h.`,
        });
      }
    }
  }

  // 3. CHARGING_ADJUST: peakChargingUtilPct >= NEAR_CAPACITY_PCT, avgChargingWaitMin >= 15, maxQueueDepth > usablePoints, or unservedCharging > 0
  for (const hubSum of summary) {
    const hubIvs = intervalsByHub.get(hubSum.hubId) ?? [];
    const maxQueue = hubIvs.reduce((m, iv) => Math.max(m, iv.maxQueueDepth), 0);
    const unservedChg = hubIvs.reduce((acc, iv) => acc + iv.unservedCharging, 0);
    const usablePts = usableChargingPtsByHub.get(hubSum.hubId) ?? 0;

    const chargingBreach =
      hubSum.peakChargingUtilPct >= cfg.nearCapacityPct ||
      hubSum.avgChargingWaitMin >= 15 ||
      (usablePts > 0 && maxQueue > usablePts) ||
      unservedChg > 0;

    if (chargingBreach) {
      // Shift weight toward urgency while keeping sum = 1.0
      const newUrgency = roundTo1(Math.min(0.6, snapshot.weights.urgency + 0.15));
      const remaining = roundTo1(Math.max(0.1, 1 - newUrgency));
      const newBattery = roundTo1(remaining * 0.6);
      const newWaiting = roundTo1(Math.max(0.05, remaining - newBattery));

      recommendations.push({
        type: 'CHARGING_ADJUST',
        payload: {
          hubId: hubSum.hubId,
          weights: {
            battery: newBattery,
            urgency: newUrgency,
            waiting: newWaiting,
          },
        },
        projectedImpact: {
          peakChargingUtilPct: hubSum.peakChargingUtilPct,
          avgChargingWaitMin: hubSum.avgChargingWaitMin,
          maxQueueDepth: maxQueue,
        },
        reason: `Increase charging urgency weight to ${newUrgency} to reduce queue wait at ${hubSum.hubId} (peak ${hubSum.peakChargingUtilPct}%, avg wait ${hubSum.avgChargingWaitMin} min).`,
      });
    }
  }

  return { recommendations, warning };
}
