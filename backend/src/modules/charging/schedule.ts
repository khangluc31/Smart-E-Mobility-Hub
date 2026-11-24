// Pure charging duration estimator and overlap-free schedule projection
// (BR-06, FR-22, FR-49, FR-50, D-09, D-10, ARCHITECTURE §9.2).
// Imports only types/* and core/time.ts so simulation/engine.ts can import it directly.

import { VEHICLE_CLASSES, type ChargingPointStatus, type VehicleClass } from '../../types/enums';

export interface ScheduleConfig {
  chargeRatePctPerMin: Record<VehicleClass, number>;
  demoTimeScale: number;
}

export interface SchedulePointInput {
  id: string;
  vehicleClass: VehicleClass;
  status: ChargingPointStatus;
}

export interface ScheduleRunningInput {
  id: string;
  chargingPointId: string;
  vehicleClass: VehicleClass;
  currentPct: number;
  targetPct: number;
}

export interface ScheduleBookedInput {
  id: string;
  chargingPointId: string;
  vehicleClass: VehicleClass;
  slotStart: Date;
  slotEnd: Date;
}

export interface ScheduleQueuedInput {
  id: string;
  vehicleClass: VehicleClass;
  currentPct: number;
  targetPct: number;
  desiredTime: Date;
}

export interface ProjectedAssignment {
  requestId: string;
  pointId: string;
  start: Date;
  end: Date;
}

export interface PointScheduleResult {
  pointId: string;
  currentId: string | null;
  bookedIds: string[];
  projected: ProjectedAssignment[];
}

export interface RequestProjectionResult {
  queuePosition: number;
  pointId: string | null;
  estimatedStart: Date | null;
  estimatedEnd: Date | null;
}

export interface ScheduleProjection {
  byPoint: Map<string, PointScheduleResult>;
  byRequest: Map<string, RequestProjectionResult>;
  runningEndByRequest: Map<string, Date>;
}

const MS_PER_MIN = 60_000;

// D-09 / D-10: estimated duration = max(0, toPct - fromPct) / (rate * demoTimeScale) minutes -> ms.
export function estimateDurationMs(
  fromPct: number,
  toPct: number,
  vehicleClass: VehicleClass,
  cfg: ScheduleConfig,
): number {
  const delta = toPct - fromPct;
  if (delta <= 0) return 0;
  const effectiveRate = cfg.chargeRatePctPerMin[vehicleClass] * cfg.demoTimeScale;
  if (effectiveRate <= 0) return 0;
  return (delta / effectiveRate) * MS_PER_MIN;
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

interface PointState {
  id: string;
  freeAtMs: number;
  booked: { startMs: number; endMs: number }[];
  projected: ProjectedAssignment[];
}

export function projectSchedule(input: {
  points: readonly SchedulePointInput[];
  running: readonly ScheduleRunningInput[];
  booked: readonly ScheduleBookedInput[];
  ordered: readonly ScheduleQueuedInput[];
  now: Date;
  cfg: ScheduleConfig;
}): ScheduleProjection {
  const { points, running, booked, ordered, now, cfg } = input;
  const nowMs = now.getTime();

  const byPoint = new Map<string, PointScheduleResult>();
  const byRequest = new Map<string, RequestProjectionResult>();
  const runningEndByRequest = new Map<string, Date>();

  // Index running session per point
  const runningByPoint = new Map<string, ScheduleRunningInput>();
  for (const r of running) {
    runningByPoint.set(r.chargingPointId, r);
    const durMs = estimateDurationMs(r.currentPct, r.targetPct, r.vehicleClass, cfg);
    runningEndByRequest.set(r.id, new Date(nowMs + durMs));
  }

  // Index booked slots per point, sorted by slotStart ASC
  const bookedByPoint = new Map<string, ScheduleBookedInput[]>();
  for (const b of booked) {
    const list = bookedByPoint.get(b.chargingPointId) ?? [];
    list.push(b);
    bookedByPoint.set(b.chargingPointId, list);
  }
  for (const list of bookedByPoint.values()) {
    list.sort((a, b) => a.slotStart.getTime() - b.slotStart.getTime() || compareStrings(a.id, b.id));
  }

  // Initialize result entries for every point (including FAULTY points, which get empty projected)
  for (const pt of points) {
    const cur = runningByPoint.get(pt.id) ?? null;
    const ptBooked = bookedByPoint.get(pt.id) ?? [];
    byPoint.set(pt.id, {
      pointId: pt.id,
      currentId: cur ? cur.id : null,
      bookedIds: ptBooked.map((b) => b.id),
      projected: [],
    });
  }

  // Run greedy projection independently per vehicle class (FR-50 class match)
  for (const vc of VEHICLE_CLASSES) {
    const classOrdered = ordered.filter((q) => q.vehicleClass === vc);

    // Record 1-based queuePosition per Hub and class even if no usable points exist
    for (const [i, q] of classOrdered.entries()) {
      byRequest.set(q.id, {
        queuePosition: i + 1,
        pointId: null,
        estimatedStart: null,
        estimatedEnd: null,
      });
    }

    const usablePoints = points
      .filter((pt) => pt.vehicleClass === vc && pt.status !== 'FAULTY')
      .sort((a, b) => compareStrings(a.id, b.id));

    if (usablePoints.length === 0 || classOrdered.length === 0) {
      continue;
    }

    const pointStates: PointState[] = usablePoints.map((pt) => {
      const cur = runningByPoint.get(pt.id);
      const curEnd = cur ? runningEndByRequest.get(cur.id) : undefined;
      const freeAtMs = curEnd ? Math.max(nowMs, curEnd.getTime()) : nowMs;
      const ptBooked = (bookedByPoint.get(pt.id) ?? []).map((b) => ({
        startMs: b.slotStart.getTime(),
        endMs: b.slotEnd.getTime(),
      }));
      return {
        id: pt.id,
        freeAtMs,
        booked: ptBooked,
        projected: [],
      };
    });

    const remaining = classOrdered.map((q) => ({
      req: q,
      durationMs: estimateDurationMs(q.currentPct, q.targetPct, vc, cfg),
    }));

    while (remaining.length > 0) {
      // Pick the point with earliest freeAt (tie: point id ASC)
      let best = pointStates[0];
      if (!best) break;
      for (const candidate of pointStates) {
        if (
          candidate.freeAtMs < best.freeAtMs ||
          (candidate.freeAtMs === best.freeAtMs && compareStrings(candidate.id, best.id) < 0)
        ) {
          best = candidate;
        }
      }

      // If freeAt is inside one of its booked slots -> advance to that slot's end and repeat
      const containing = best.booked.find(
        (slot) => slot.startMs <= best.freeAtMs && best.freeAtMs < slot.endMs,
      );
      if (containing) {
        best.freeAtMs = containing.endMs;
        continue;
      }

      // Next booked slot starting strictly after freeAt (infinity if none)
      const nextBooked = best.booked.find((slot) => slot.startMs > best.freeAtMs);
      const nbMs = nextBooked ? nextBooked.startMs : Number.POSITIVE_INFINITY;

      // Pick the first request in rule-3 order whose [start, start + dur] fits before nb
      let pickedIdx = -1;
      let pickedStartMs = 0;
      let pickedEndMs = 0;

      for (const [i, item] of remaining.entries()) {
        const startMs = Math.max(best.freeAtMs, item.req.desiredTime.getTime());
        const endMs = startMs + item.durationMs;
        if (endMs <= nbMs) {
          pickedIdx = i;
          pickedStartMs = startMs;
          pickedEndMs = endMs;
          break;
        }
      }

      if (pickedIdx >= 0) {
        const [picked] = remaining.splice(pickedIdx, 1);
        if (!picked) break;
        const start = new Date(pickedStartMs);
        const end = new Date(pickedEndMs);
        const assignment: ProjectedAssignment = {
          requestId: picked.req.id,
          pointId: best.id,
          start,
          end,
        };
        best.projected.push(assignment);
        best.freeAtMs = pickedEndMs;

        const existing = byRequest.get(picked.req.id);
        if (existing) {
          existing.pointId = best.id;
          existing.estimatedStart = start;
          existing.estimatedEnd = end;
        }
      } else if (nextBooked) {
        // Nothing fits before the next booked slot; skip past it
        best.freeAtMs = nextBooked.endMs;
      } else {
        // Defensive guard: unreachable with finite durations and nb = +Infinity
        break;
      }
    }

    for (const ps of pointStates) {
      const res = byPoint.get(ps.id);
      if (res) {
        res.projected = ps.projected;
      }
    }
  }

  return { byPoint, byRequest, runningEndByRequest };
}
