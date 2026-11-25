// Pure What-if Simulation Engine (FR-55, FR-56, BR-11, D-07, D-09, ARCHITECTURE §12.3).
// ZERO @prisma/client or core/db imports (enforced by eslint.config.mjs).

import { addMinutes } from '../../core/time';
import type { ChargingWeights } from '../../types/charging';
import type { VehicleClass } from '../../types/enums';
import type {
  ScenarioCondition,
  SimHubSummary,
  SimInterval,
  SimSnapshot,
} from '../../types/simulation';
import { rankQueue, type PriorityEntry } from '../charging/priority';
import { roundTo1, utilPct } from '../hubs/hubs.metrics';
import {
  getHourlyDemand,
  PARKING_STAY_MIN_RANGE,
  pickDestinationHub,
  TRIP_DURATION_MIN_RANGE,
} from './demandProfile';

export interface SimEngineConfig {
  simIntervalMin: number;
  simMaxRuntimeSec: number;
  nearCapacityPct: number;
  minRentalBatteryPct: number;
  chargeRatePctPerMin: Readonly<Record<VehicleClass, number>>;
  batteryDrainPctPerMin: number;
  urgencyHorizonMin: number;
  waitingFullMin: number;
}

export interface SimScenarioInput {
  horizonH: number;
  seed: number;
  conditions: readonly ScenarioCondition[];
}

export interface SimRunOptions {
  maxRuntimeMs?: number;
}

export interface SimEngineResult {
  status: 'COMPLETED' | 'INCOMPLETE';
  intervals: SimInterval[];
  summary: SimHubSummary[];
}

/**
 * Deterministic 32-bit PRNG (mulberry32, ARCHITECTURE §12.3).
 */
export function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function samplePoisson(lambda: number, rand: () => number): number {
  if (lambda <= 0) return 0;
  if (lambda > 20) {
    // Normal approximation for high arrival rates
    const u1 = Math.max(1e-9, rand());
    const u2 = rand();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * z));
  }
  const L = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= rand();
  } while (p > L);
  return k - 1;
}

interface SimVehicle {
  id: string;
  hubId: string;
  status: 'AVAILABLE' | 'RESERVED' | 'IN_USE' | 'LOW_BATTERY' | 'IN_TRANSIT' | 'FAULTY';
  batteryPct: number;
  parkingSpaceId: string | null;
  charging: boolean;
}

interface SimSpace {
  id: string;
  hubId: string;
  vehicleClass: VehicleClass;
  pool: 'FLEET' | 'PUBLIC';
  status: 'FREE' | 'RESERVED' | 'OCCUPIED' | 'UNAVAILABLE';
}

interface SimPoint {
  id: string;
  hubId: string;
  vehicleClass: VehicleClass;
  baseFaulty: boolean;
  outageFaulty: boolean;
  busy: boolean;
}

interface ActiveTrip {
  vehicleId: string;
  destHubId: string;
  endMinute: number;
  drainPct: number;
}

interface ActiveParkingStay {
  spaceId: string;
  endMinute: number;
}

interface SimChargingJob extends PriorityEntry {
  hubId: string;
  vehicleClass: VehicleClass;
  rentalVehicleId: string | null;
  targetPct: number;
  enqueuedMinute: number;
}

interface ActiveChargingSession {
  job: SimChargingJob;
  pointId: string;
  endMinute: number;
}

interface IntervalAccumulator {
  unservedRental: number;
  unservedParking: number;
  unservedCharging: number;
  redirectedReturns: number;
  maxQueueDepth: number;
  waitMinutesSum: number;
  waitCount: number;
}

function isWindowActive(
  minute: number,
  params: Record<string, number | string | string[]>,
): boolean {
  const startHour = Number(params['startHour'] ?? 0);
  const durationH = Number(params['durationH'] ?? 0);
  const startMin = startHour * 60;
  const endMin = (startHour + durationH) * 60;
  return minute >= startMin && minute < endMin;
}

/**
 * Pure 1-minute discrete-event simulation over a cloned JSON snapshot (FR-55, FR-56, D-07).
 */
export function runSimulation(
  snapshot: SimSnapshot,
  scenario: SimScenarioInput,
  cfg: SimEngineConfig,
  opts?: SimRunOptions,
): SimEngineResult {
  const startMs = Date.now();
  const maxRuntimeMs = opts?.maxRuntimeMs ?? cfg.simMaxRuntimeSec * 1000;
  const rand = mulberry32(scenario.seed);

  // Deep-clone snapshot so input is never mutated
  const snap = structuredClone(snapshot);
  const baseTime = new Date(snap.takenAt);
  const hubIds = snap.hubs.map((h) => h.id);
  const weights: ChargingWeights = snap.weights;
  const priorityCfg = {
    urgencyHorizonMin: cfg.urgencyHorizonMin,
    waitingFullMin: cfg.waitingFullMin,
  };

  // Build mutable simulation state
  const spacesById = new Map<string, SimSpace>();
  const spacesByHub = new Map<string, SimSpace[]>();
  for (const hId of hubIds) spacesByHub.set(hId, []);
  for (const s of snap.parkingSpaces) {
    const sp: SimSpace = {
      id: s.id,
      hubId: s.hubId,
      vehicleClass: s.vehicleClass,
      pool: s.pool,
      status: s.status,
    };
    spacesById.set(sp.id, sp);
    spacesByHub.get(sp.hubId)?.push(sp);
  }

  const pointsById = new Map<string, SimPoint>();
  const pointsByHub = new Map<string, SimPoint[]>();
  for (const hId of hubIds) pointsByHub.set(hId, []);
  for (const p of snap.chargingPoints) {
    const pt: SimPoint = {
      id: p.id,
      hubId: p.hubId,
      vehicleClass: p.vehicleClass,
      baseFaulty: p.status === 'FAULTY',
      outageFaulty: false,
      busy: p.status === 'CHARGING',
    };
    pointsById.set(pt.id, pt);
    pointsByHub.get(pt.hubId)?.push(pt);
  }

  const vehiclesById = new Map<string, SimVehicle>();
  const vehiclesByHub = new Map<string, SimVehicle[]>();
  for (const hId of hubIds) vehiclesByHub.set(hId, []);

  const chargingVehicleIds = new Set(
    snap.chargingRequests
      .filter((r) => r.status === 'CHARGING' && r.rentalVehicleId)
      .map((r) => r.rentalVehicleId!),
  );

  for (const v of snap.vehicles) {
    const sv: SimVehicle = {
      id: v.id,
      hubId: v.hubId,
      status: v.status,
      batteryPct: v.batteryPct,
      parkingSpaceId: v.parkingSpaceId,
      charging: chargingVehicleIds.has(v.id),
    };
    vehiclesById.set(sv.id, sv);
    vehiclesByHub.get(sv.hubId)?.push(sv);
  }

  const waitingQueueByHub = new Map<string, SimChargingJob[]>();
  for (const hId of hubIds) waitingQueueByHub.set(hId, []);

  const activeSessions: ActiveChargingSession[] = [];
  for (const r of snap.chargingRequests) {
    const job: SimChargingJob = {
      id: r.id,
      hubId: r.hubId,
      vehicleClass: r.vehicleClass,
      rentalVehicleId: r.rentalVehicleId,
      currentPct: r.currentPct,
      targetPct: r.targetPct,
      desiredTime: new Date(r.desiredTime),
      neededBy: r.neededBy ? new Date(r.neededBy) : null,
      createdAt: new Date(r.createdAt),
      manualAdjust: r.manualAdjust,
      enqueuedMinute: 0,
    };
    if (r.status === 'CHARGING' && r.chargingPointId && pointsById.has(r.chargingPointId)) {
      const rate = cfg.chargeRatePctPerMin[r.vehicleClass] || 1;
      const dur = Math.max(1, Math.ceil((r.targetPct - r.currentPct) / rate));
      activeSessions.push({ job, pointId: r.chargingPointId, endMinute: dur });
      pointsById.get(r.chargingPointId)!.busy = true;
    } else if (r.status === 'QUEUED') {
      waitingQueueByHub.get(r.hubId)?.push(job);
    }
  }

  // Apply t0 conditions: HUB_PARKING_FULL and VEHICLE_IMBALANCE
  let syntheticSeq = 1;
  for (const cond of scenario.conditions) {
    if (cond.template === 'HUB_PARKING_FULL') {
      const targetHub = String(cond.params['hubId'] ?? '');
      for (const sp of spacesByHub.get(targetHub) ?? []) {
        if (sp.status !== 'UNAVAILABLE') {
          sp.status = 'OCCUPIED';
        }
      }
    } else if (cond.template === 'VEHICLE_IMBALANCE') {
      const targetHub = String(cond.params['hubId'] ?? '');
      const delta = Number(cond.params['deltaVehicles'] ?? 0);
      const hubVehicles = vehiclesByHub.get(targetHub);
      const hubSpaces = spacesByHub.get(targetHub);
      if (hubVehicles && hubSpaces) {
        if (delta > 0) {
          for (let i = 0; i < delta; i++) {
            const freeFleet = hubSpaces.find(
              (s) => s.pool === 'FLEET' && s.vehicleClass === 'MOTORCYCLE' && s.status === 'FREE',
            );
            if (freeFleet) freeFleet.status = 'OCCUPIED';
            const sv: SimVehicle = {
              id: `SIM-RV-${syntheticSeq++}`,
              hubId: targetHub,
              status: 'AVAILABLE',
              batteryPct: 80,
              parkingSpaceId: freeFleet ? freeFleet.id : null,
              charging: false,
            };
            vehiclesById.set(sv.id, sv);
            hubVehicles.push(sv);
          }
        } else if (delta < 0) {
          let toRemove = -delta;
          for (let i = hubVehicles.length - 1; i >= 0 && toRemove > 0; i--) {
            const v = hubVehicles[i]!;
            if (v.status === 'AVAILABLE' && !v.charging) {
              if (v.parkingSpaceId) {
                const sp = spacesById.get(v.parkingSpaceId);
                if (sp && sp.status === 'OCCUPIED') sp.status = 'FREE';
              }
              vehiclesById.delete(v.id);
              hubVehicles.splice(i, 1);
              toRemove--;
            }
          }
        }
      }
    }
  }

  const activeTrips: ActiveTrip[] = [];
  const activeParkingStays: ActiveParkingStay[] = [];
  const intervals: SimInterval[] = [];

  const intervalAcc = new Map<string, IntervalAccumulator>();
  const resetIntervalAcc = () => {
    for (const hId of hubIds) {
      intervalAcc.set(hId, {
        unservedRental: 0,
        unservedParking: 0,
        unservedCharging: 0,
        redirectedReturns: 0,
        maxQueueDepth: 0,
        waitMinutesSum: 0,
        waitCount: 0,
      });
    }
  };
  resetIntervalAcc();

  const totalMinutes = scenario.horizonH * 60;
  let status: 'COMPLETED' | 'INCOMPLETE' = 'COMPLETED';

  const findFreeFleetSpace = (hId: string): SimSpace | undefined =>
    (spacesByHub.get(hId) ?? []).find(
      (s) => s.pool === 'FLEET' && s.vehicleClass === 'MOTORCYCLE' && s.status === 'FREE',
    );

  const countFreeFleetSpaces = (hId: string): number =>
    (spacesByHub.get(hId) ?? []).filter(
      (s) => s.pool === 'FLEET' && s.vehicleClass === 'MOTORCYCLE' && s.status === 'FREE',
    ).length;

  for (let m = 0; m < totalMinutes; m++) {
    // Wall-clock timeout check (FR-55, NFR-26)
    if (Date.now() - startMs >= maxRuntimeMs) {
      status = 'INCOMPLETE';
      break;
    }

    const simNow = addMinutes(baseTime, m);
    const hourOfDay = simNow.getUTCHours();

    // 1. Apply active window conditions
    const rentalMultByHub = new Map<string, number>();
    const chargingMultByHub = new Map<string, number>();
    const outagePctByHub = new Map<string, number>();

    for (const cond of scenario.conditions) {
      if (cond.template === 'METRO_SURGE' && isWindowActive(m, cond.params)) {
        const mult = 1 + Number(cond.params['multiplierPct'] ?? 0) / 100;
        rentalMultByHub.set('metro', (rentalMultByHub.get('metro') ?? 1) * mult);
      } else if (cond.template === 'CHARGING_SPIKE' && isWindowActive(m, cond.params)) {
        const mult = 1 + Number(cond.params['multiplierPct'] ?? 0) / 100;
        const targets = Array.isArray(cond.params['hubIds'])
          ? (cond.params['hubIds'] as string[])
          : [];
        for (const hId of targets) {
          chargingMultByHub.set(hId, (chargingMultByHub.get(hId) ?? 1) * mult);
        }
      } else if (cond.template === 'POINT_OUTAGE' && isWindowActive(m, cond.params)) {
        const hId = String(cond.params['hubId'] ?? '');
        const pct = Number(cond.params['pctOfPoints'] ?? 0);
        outagePctByHub.set(hId, Math.max(outagePctByHub.get(hId) ?? 0, pct));
      }
    }

    // Update outage flags on charging points
    for (const hId of hubIds) {
      const pts = pointsByHub.get(hId) ?? [];
      const usablePts = pts.filter((p) => !p.baseFaulty);
      const pct = outagePctByHub.get(hId) ?? 0;
      const outageCount = pct > 0 ? Math.min(usablePts.length, Math.ceil((usablePts.length * pct) / 100)) : 0;
      for (let i = 0; i < usablePts.length; i++) {
        usablePts[i]!.outageFaulty = i < outageCount;
      }
    }

    // 2. Complete finished trips
    for (let i = activeTrips.length - 1; i >= 0; i--) {
      const trip = activeTrips[i]!;
      if (trip.endMinute > m) continue;
      activeTrips.splice(i, 1);

      const v = vehiclesById.get(trip.vehicleId);
      if (!v) continue;

      let targetHubId = trip.destHubId;
      let space = findFreeFleetSpace(targetHubId);
      if (!space) {
        // Redirect return to Hub with most free FLEET spaces
        let bestHub = targetHubId;
        let bestFree = 0;
        for (const candidate of hubIds) {
          if (candidate === targetHubId) continue;
          const free = countFreeFleetSpaces(candidate);
          if (free > bestFree) {
            bestFree = free;
            bestHub = candidate;
          }
        }
        if (bestFree > 0) {
          targetHubId = bestHub;
          space = findFreeFleetSpace(bestHub);
        }
        const acc = intervalAcc.get(trip.destHubId);
        if (acc) acc.redirectedReturns++;
      }

      if (space) {
        space.status = 'OCCUPIED';
        v.parkingSpaceId = space.id;
      } else {
        v.parkingSpaceId = null;
      }

      v.hubId = targetHubId;
      v.batteryPct = Math.max(0, roundTo1(v.batteryPct - trip.drainPct));
      v.status = v.batteryPct < cfg.minRentalBatteryPct ? 'LOW_BATTERY' : 'AVAILABLE';
      vehiclesByHub.get(targetHubId)?.push(v);

      // Auto-queue fleet vehicle if below MIN_RENTAL_BATTERY_PCT (ARCHITECTURE §12.3)
      if (v.batteryPct < cfg.minRentalBatteryPct) {
        waitingQueueByHub.get(targetHubId)?.push({
          id: `SIM-CHG-${syntheticSeq++}`,
          hubId: targetHubId,
          vehicleClass: 'MOTORCYCLE',
          rentalVehicleId: v.id,
          currentPct: v.batteryPct,
          targetPct: 100,
          desiredTime: simNow,
          neededBy: null,
          createdAt: simNow,
          manualAdjust: 0,
          enqueuedMinute: m,
        });
      }
    }

    // 3. Complete finished Private EV parking stays
    for (let i = activeParkingStays.length - 1; i >= 0; i--) {
      const stay = activeParkingStays[i]!;
      if (stay.endMinute > m) continue;
      activeParkingStays.splice(i, 1);
      const sp = spacesById.get(stay.spaceId);
      if (sp && sp.status === 'OCCUPIED') sp.status = 'FREE';
    }

    // 4. Complete finished charging sessions
    for (let i = activeSessions.length - 1; i >= 0; i--) {
      const sess = activeSessions[i]!;
      if (sess.endMinute > m) continue;
      activeSessions.splice(i, 1);
      const pt = pointsById.get(sess.pointId);
      if (pt) pt.busy = false;
      if (sess.job.rentalVehicleId) {
        const v = vehiclesById.get(sess.job.rentalVehicleId);
        if (v) {
          v.charging = false;
          v.batteryPct = sess.job.targetPct;
          if (v.status === 'LOW_BATTERY' && v.batteryPct >= cfg.minRentalBatteryPct) {
            v.status = 'AVAILABLE';
          }
        }
      }
    }

    // 5. Generate arrivals per Hub
    for (const hId of hubIds) {
      const acc = intervalAcc.get(hId)!;
      const demand = getHourlyDemand(hId, hourOfDay);
      const rentalLambda = (demand.rentalPerHour * (rentalMultByHub.get(hId) ?? 1)) / 60;
      const parkingLambda = demand.parkingPerHour / 60;
      const chargingLambda = (demand.chargingPerHour * (chargingMultByHub.get(hId) ?? 1)) / 60;

      // 5a. Rental arrivals
      const rentalArrivals = samplePoisson(rentalLambda, rand);
      const hubVehicles = vehiclesByHub.get(hId) ?? [];
      for (let a = 0; a < rentalArrivals; a++) {
        const idx = hubVehicles.findIndex(
          (v) =>
            v.status === 'AVAILABLE' &&
            !v.charging &&
            v.batteryPct >= cfg.minRentalBatteryPct,
        );
        if (idx === -1) {
          acc.unservedRental++;
          continue;
        }
        const v = hubVehicles.splice(idx, 1)[0]!;
        if (v.parkingSpaceId) {
          const sp = spacesById.get(v.parkingSpaceId);
          if (sp && sp.status === 'OCCUPIED') sp.status = 'FREE';
          v.parkingSpaceId = null;
        }
        v.status = 'IN_USE';
        const dur =
          TRIP_DURATION_MIN_RANGE.min +
          Math.floor(rand() * (TRIP_DURATION_MIN_RANGE.max - TRIP_DURATION_MIN_RANGE.min + 1));
        const destHubId = pickDestinationHub(hId, hubIds, rand);
        activeTrips.push({
          vehicleId: v.id,
          destHubId,
          endMinute: m + dur,
          drainPct: dur * cfg.batteryDrainPctPerMin,
        });
      }

      // 5b. Private EV parking arrivals (2–4 h stay in PUBLIC space)
      const parkingArrivals = samplePoisson(parkingLambda, rand);
      const hubSpaces = spacesByHub.get(hId) ?? [];
      for (let a = 0; a < parkingArrivals; a++) {
        const vc: VehicleClass = rand() < 0.7 ? 'MOTORCYCLE' : 'CAR';
        const freePub = hubSpaces.find(
          (s) => s.pool === 'PUBLIC' && s.vehicleClass === vc && s.status === 'FREE',
        );
        if (!freePub) {
          acc.unservedParking++;
          continue;
        }
        freePub.status = 'OCCUPIED';
        const stayMin =
          PARKING_STAY_MIN_RANGE.min +
          Math.floor(rand() * (PARKING_STAY_MIN_RANGE.max - PARKING_STAY_MIN_RANGE.min + 1));
        activeParkingStays.push({ spaceId: freePub.id, endMinute: m + stayMin });
      }

      // 5c. Charging arrivals
      const chargingArrivals = samplePoisson(chargingLambda, rand);
      const hubPts = pointsByHub.get(hId) ?? [];
      for (let a = 0; a < chargingArrivals; a++) {
        const vc: VehicleClass = rand() < 0.75 ? 'MOTORCYCLE' : 'CAR';
        const hasOperationalPointOfClass = hubPts.some(
          (p) => p.vehicleClass === vc && !p.baseFaulty && !p.outageFaulty,
        );
        if (!hasOperationalPointOfClass) {
          acc.unservedCharging++;
          continue;
        }
        const currentPct = 15 + Math.floor(rand() * 45);
        waitingQueueByHub.get(hId)!.push({
          id: `SIM-CHG-${syntheticSeq++}`,
          hubId: hId,
          vehicleClass: vc,
          rentalVehicleId: null,
          currentPct,
          targetPct: 90,
          desiredTime: simNow,
          neededBy: rand() < 0.4 ? addMinutes(simNow, 60 + Math.floor(rand() * 120)) : null,
          createdAt: simNow,
          manualAdjust: 0,
          enqueuedMinute: m,
        });
      }

      // 5d. Rank waiting queue via charging/priority.ts rankQueue (BR-06) & allocate matching-class points (BR-13)
      const queue = waitingQueueByHub.get(hId)!;
      if (queue.length > 0) {
        const remaining: SimChargingJob[] = [];
        for (const vc of ['MOTORCYCLE', 'CAR'] as const) {
          const classJobs = queue.filter((j) => j.vehicleClass === vc);
          if (classJobs.length === 0) continue;
          const ranked = rankQueue(classJobs, weights, simNow, priorityCfg);
          for (const job of ranked) {
            const freePt = hubPts.find(
              (p) =>
                p.vehicleClass === vc && !p.baseFaulty && !p.outageFaulty && !p.busy,
            );
            if (!freePt) {
              remaining.push(job);
              continue;
            }
            freePt.busy = true;
            if (job.rentalVehicleId) {
              const rv = vehiclesById.get(job.rentalVehicleId);
              if (rv) rv.charging = true;
            }
            const rate = cfg.chargeRatePctPerMin[vc] || 1;
            const dur = Math.max(1, Math.ceil((job.targetPct - job.currentPct) / rate));
            activeSessions.push({ job, pointId: freePt.id, endMinute: m + dur });
            acc.waitMinutesSum += Math.max(0, m - job.enqueuedMinute);
            acc.waitCount++;
          }
        }
        waitingQueueByHub.set(hId, remaining);
        if (remaining.length > acc.maxQueueDepth) {
          acc.maxQueueDepth = remaining.length;
        }
      }
    }

    // 6. Emit 15-minute interval metrics (FR-56)
    if ((m + 1) % cfg.simIntervalMin === 0 || m === totalMinutes - 1) {
      const tIso = addMinutes(baseTime, m + 1).toISOString();
      for (const hId of hubIds) {
        const acc = intervalAcc.get(hId)!;
        const hubSpaces = spacesByHub.get(hId) ?? [];
        const pTotal = hubSpaces.length;
        let pUsed = 0;
        let pUnavail = 0;
        for (const s of hubSpaces) {
          if (s.status === 'OCCUPIED' || s.status === 'RESERVED') pUsed++;
          else if (s.status === 'UNAVAILABLE') pUnavail++;
        }
        const rawParkingUtil = utilPct(pUsed, pTotal, pUnavail);

        const hubPts = pointsByHub.get(hId) ?? [];
        const cTotal = hubPts.length;
        let cBusy = 0;
        let cFaulty = 0;
        for (const p of hubPts) {
          if (p.baseFaulty || p.outageFaulty) cFaulty++;
          else if (p.busy) cBusy++;
        }
        const rawChargingUtil = utilPct(cBusy, cTotal, cFaulty);

        const availableVehicles = (vehiclesByHub.get(hId) ?? []).filter(
          (v) =>
            v.status === 'AVAILABLE' &&
            !v.charging &&
            v.batteryPct >= cfg.minRentalBatteryPct,
        ).length;

        const avgWait = acc.waitCount > 0 ? roundTo1(acc.waitMinutesSum / acc.waitCount) : 0;
        const unservedAny =
          acc.unservedRental + acc.unservedParking + acc.unservedCharging > 0;
        const breach =
          (pTotal > 0 && rawParkingUtil >= cfg.nearCapacityPct) ||
          (cTotal > 0 && rawChargingUtil >= cfg.nearCapacityPct) ||
          unservedAny;

        intervals.push({
          t: tIso,
          hubId: hId,
          parkingUtilPct: roundTo1(rawParkingUtil),
          chargingUtilPct: roundTo1(rawChargingUtil),
          avgChargingWaitMin: avgWait,
          maxQueueDepth: acc.maxQueueDepth,
          unservedRental: acc.unservedRental,
          unservedParking: acc.unservedParking,
          unservedCharging: acc.unservedCharging,
          redirectedReturns: acc.redirectedReturns,
          availableVehicles,
          breach,
        });
      }
      resetIntervalAcc();
    }
  }

  // Compute per-Hub summary (CONTRACTS §13)
  const summary: SimHubSummary[] = hubIds.map((hId) => {
    const hubIntervals = intervals.filter((iv) => iv.hubId === hId);
    let peakParking = 0;
    let peakCharging = 0;
    let waitSum = 0;
    let unservedTotal = 0;
    for (const iv of hubIntervals) {
      if (iv.parkingUtilPct > peakParking) peakParking = iv.parkingUtilPct;
      if (iv.chargingUtilPct > peakCharging) peakCharging = iv.chargingUtilPct;
      waitSum += iv.avgChargingWaitMin;
      unservedTotal += iv.unservedRental + iv.unservedParking + iv.unservedCharging;
    }
    return {
      hubId: hId,
      peakParkingUtilPct: roundTo1(peakParking),
      peakChargingUtilPct: roundTo1(peakCharging),
      avgChargingWaitMin:
        hubIntervals.length > 0 ? roundTo1(waitSum / hubIntervals.length) : 0,
      unservedTotal,
    };
  });

  return { status, intervals, summary };
}
