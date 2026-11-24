// Charging scheduler: starts due advance-booked slots and assigns free charging points
// to the highest-ranked eligible queued request that fits before the point's next booking
// (ARCHITECTURE §9.3, BR-06, BR-10, FR-49, FR-50, FR-62).

import { config } from '../../core/config';
import { db, lockRow } from '../../core/db';
import { notify } from '../../core/notify';
import { assertTransition } from '../../core/stateMachine';
import { VEHICLE_CLASSES } from '../../types/enums';
import { getWeights } from './charging.service';
import { orderForHub, type PriorityConfig } from './priority';
import { estimateDurationMs, type ScheduleConfig } from './schedule';

function isOverlapViolation(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('23P01') || msg.includes('ex_charging_overlap');
}

function getPriorityConfig(): PriorityConfig {
  return {
    urgencyHorizonMin: config.URGENCY_HORIZON_MIN,
    waitingFullMin: config.WAITING_FULL_MIN,
  };
}

function getScheduleConfig(): ScheduleConfig {
  return {
    chargeRatePctPerMin: config.CHARGE_RATE_PCT_PER_MIN,
    demoTimeScale: config.DEMO_TIME_SCALE,
  };
}

async function startDueBookedSlots(hubId: string, now: Date): Promise<void> {
  const dueRequests = await db.chargingRequest.findMany({
    where: {
      hubId,
      status: 'SCHEDULED',
      chargingPointId: { not: null },
      slotStart: { lte: now },
    },
    orderBy: [{ slotStart: 'asc' }, { id: 'asc' }],
  });

  for (const due of dueRequests) {
    if (!due.chargingPointId) continue;
    const pointId = due.chargingPointId;

    try {
      await db.$transaction(async (tx) => {
        // Rule 9 lock order: vehicle -> charging_point -> charging_request.
        if (due.rentalVehicleId) {
          await lockRow(tx, 'rental_vehicle', due.rentalVehicleId);
        } else if (due.privateEvId) {
          await lockRow(tx, 'private_ev', due.privateEvId);
        }
        await lockRow(tx, 'charging_point', pointId);
        await lockRow(tx, 'charging_request', due.id);

        const req = await tx.chargingRequest.findUnique({ where: { id: due.id } });
        const point = await tx.chargingPoint.findUnique({ where: { id: pointId } });
        if (!req || !point) return;

        if (
          req.status !== 'SCHEDULED' ||
          req.chargingPointId !== pointId ||
          !req.slotStart ||
          req.slotStart.getTime() > now.getTime()
        ) {
          return;
        }

        if (point.status !== 'AVAILABLE') {
          console.warn(
            `[charging.scheduler] point ${point.id} is ${point.status}; leaving SCHEDULED request ${req.id} for retry`,
          );
          return;
        }

        const runningOnPoint = await tx.chargingRequest.findFirst({
          where: { chargingPointId: point.id, status: 'CHARGING' },
          select: { id: true },
        });
        if (runningOnPoint) {
          console.warn(
            `[charging.scheduler] point ${point.id} still has CHARGING request ${runningOnPoint.id}; leaving ${req.id} SCHEDULED`,
          );
          return;
        }

        if (req.vehicleKind === 'RENTAL' && req.rentalVehicleId) {
          const vehicle = await tx.rentalVehicle.findUnique({
            where: { id: req.rentalVehicleId },
          });
          if (
            !vehicle ||
            vehicle.hubId !== hubId ||
            (vehicle.status !== 'AVAILABLE' && vehicle.status !== 'LOW_BATTERY')
          ) {
            return;
          }
        }

        assertTransition('chargingRequest', req.status, 'CHARGING');
        assertTransition('chargingPoint', point.status, 'CHARGING');

        await tx.chargingRequest.update({
          where: { id: req.id },
          data: {
            status: 'CHARGING',
            startedAt: now,
          },
        });

        await tx.chargingPoint.update({
          where: { id: point.id },
          data: { status: 'CHARGING' },
        });

        if (req.ownerId) {
          await notify(tx, {
            userId: req.ownerId,
            type: 'CHARGING_STARTED',
            title: 'Charging started',
            body: `Your scheduled charging session started on point ${point.id} at Hub ${hubId}.`,
            data: {
              chargingRequestId: req.id,
              hubId,
              chargingPointId: point.id,
            },
          });
        }
      });
    } catch (err) {
      if (isOverlapViolation(err)) {
        console.warn(
          `[charging.scheduler] overlap starting SCHEDULED request ${due.id} on ${pointId}; skipped`,
        );
      } else {
        console.error(`[charging.scheduler] failed starting SCHEDULED request ${due.id}`, err);
      }
    }
  }
}

async function assignFreePointsForHub(hubId: string, now: Date): Promise<void> {
  const [weightsView, availablePoints, liveRequests] = await Promise.all([
    getWeights(db),
    db.chargingPoint.findMany({
      where: { hubId, status: 'AVAILABLE' },
      orderBy: { id: 'asc' },
    }),
    db.chargingRequest.findMany({
      where: {
        hubId,
        status: { in: ['QUEUED', 'SCHEDULED', 'CHARGING'] },
      },
    }),
  ]);

  if (availablePoints.length === 0) return;

  const busyPointIds = new Set<string>();
  const bookedByPoint = new Map<string, { slotStart: Date; slotEnd: Date }[]>();
  const eligibleQueuedByClass: Record<(typeof VEHICLE_CLASSES)[number], typeof liveRequests> = {
    MOTORCYCLE: [],
    CAR: [],
  };

  const nowMs = now.getTime();
  for (const r of liveRequests) {
    if (r.status === 'CHARGING' && r.chargingPointId) {
      busyPointIds.add(r.chargingPointId);
    } else if (r.status === 'SCHEDULED' && r.chargingPointId && r.slotStart && r.slotEnd) {
      if (r.slotEnd.getTime() > nowMs) {
        const list = bookedByPoint.get(r.chargingPointId) ?? [];
        list.push({ slotStart: r.slotStart, slotEnd: r.slotEnd });
        bookedByPoint.set(r.chargingPointId, list);
      }
    } else if (r.status === 'QUEUED' && r.desiredTime.getTime() <= nowMs) {
      eligibleQueuedByClass[r.vehicleClass].push(r);
    }
  }

  const weights = {
    battery: weightsView.battery,
    urgency: weightsView.urgency,
    waiting: weightsView.waiting,
  };
  const priorityCfg = getPriorityConfig();
  const scheduleCfg = getScheduleConfig();

  for (const vc of VEHICLE_CLASSES) {
    const freePoints = availablePoints.filter(
      (pt) => pt.vehicleClass === vc && !busyPointIds.has(pt.id),
    );
    if (freePoints.length === 0) continue;

    const ranked = orderForHub(eligibleQueuedByClass[vc], weights, now, priorityCfg);
    if (ranked.length === 0) continue;

    const assignedRequestIds = new Set<string>();

    for (const point of freePoints) {
      const pointBooked = bookedByPoint.get(point.id) ?? [];
      let nbMs = Number.POSITIVE_INFINITY;
      for (const slot of pointBooked) {
        const startMs = slot.slotStart.getTime();
        if (startMs < nbMs) nbMs = startMs;
      }

      // Walk ranked eligible requests and pick the first that finishes by nb.
      let chosen: (typeof ranked)[number] | null = null;
      let chosenSlotEndMs = 0;

      for (const cand of ranked) {
        if (assignedRequestIds.has(cand.id)) continue;
        const durMs = estimateDurationMs(cand.currentPct, cand.targetPct, vc, scheduleCfg);
        // ck_cr_slot requires slotEnd > slotStart.
        const effectiveDurMs = Math.max(1000, Math.ceil(durMs));
        const endMs = nowMs + effectiveDurMs;
        if (endMs <= nbMs) {
          chosen = cand;
          chosenSlotEndMs = endMs;
          break;
        }
      }

      if (!chosen) continue;

      const candidate = chosen;
      const slotEnd = new Date(chosenSlotEndMs);

      try {
        const assigned = await db.$transaction(async (tx) => {
          // Rule 9 lock order: vehicle -> charging_point -> charging_request.
          if (candidate.rentalVehicleId) {
            await lockRow(tx, 'rental_vehicle', candidate.rentalVehicleId);
          } else if (candidate.privateEvId) {
            await lockRow(tx, 'private_ev', candidate.privateEvId);
          }
          await lockRow(tx, 'charging_point', point.id);
          await lockRow(tx, 'charging_request', candidate.id);

          const ptRow = await tx.chargingPoint.findUnique({ where: { id: point.id } });
          const reqRow = await tx.chargingRequest.findUnique({ where: { id: candidate.id } });
          if (!ptRow || !reqRow) return false;

          if (ptRow.status !== 'AVAILABLE' || ptRow.vehicleClass !== vc) return false;

          const existingRunning = await tx.chargingRequest.findFirst({
            where: { chargingPointId: ptRow.id, status: 'CHARGING' },
            select: { id: true },
          });
          if (existingRunning) return false;

          if (
            reqRow.status !== 'QUEUED' ||
            reqRow.hubId !== hubId ||
            reqRow.vehicleClass !== vc ||
            reqRow.desiredTime.getTime() > nowMs
          ) {
            return false;
          }

          if (reqRow.vehicleKind === 'RENTAL' && reqRow.rentalVehicleId) {
            const vehicle = await tx.rentalVehicle.findUnique({
              where: { id: reqRow.rentalVehicleId },
            });
            if (
              !vehicle ||
              vehicle.hubId !== hubId ||
              (vehicle.status !== 'AVAILABLE' && vehicle.status !== 'LOW_BATTERY')
            ) {
              return false;
            }
          }

          // Re-check booked slot overlap inside tx (ex_charging_overlap is the final DB guard).
          const overlappingBooked = await tx.chargingRequest.findFirst({
            where: {
              chargingPointId: ptRow.id,
              status: 'SCHEDULED',
              slotStart: { lt: slotEnd },
              slotEnd: { gt: now },
            },
            select: { id: true },
          });
          if (overlappingBooked) return false;

          assertTransition('chargingRequest', reqRow.status, 'CHARGING');
          assertTransition('chargingPoint', ptRow.status, 'CHARGING');

          await tx.chargingRequest.update({
            where: { id: reqRow.id },
            data: {
              status: 'CHARGING',
              chargingPointId: ptRow.id,
              slotStart: now,
              slotEnd,
              startedAt: now,
            },
          });

          await tx.chargingPoint.update({
            where: { id: ptRow.id },
            data: { status: 'CHARGING' },
          });

          if (reqRow.ownerId) {
            await notify(tx, {
              userId: reqRow.ownerId,
              type: 'CHARGING_STARTED',
              title: 'Charging started',
              body: `Your charging session started on point ${ptRow.id} at Hub ${hubId}.`,
              data: {
                chargingRequestId: reqRow.id,
                hubId,
                chargingPointId: ptRow.id,
              },
            });
          }

          return true;
        });

        if (assigned) {
          assignedRequestIds.add(candidate.id);
        }
      } catch (err) {
        if (isOverlapViolation(err)) {
          console.warn(
            `[charging.scheduler] overlap assigning request ${candidate.id} to ${point.id}; skipped`,
          );
        } else {
          console.error(
            `[charging.scheduler] failed assigning request ${candidate.id} to ${point.id}`,
            err,
          );
        }
      }
    }
  }
}

export async function runScheduler(hubId?: string, now: Date = new Date()): Promise<void> {
  const hubIds = hubId
    ? [hubId]
    : (await db.hub.findMany({ select: { id: true }, orderBy: { id: 'asc' } })).map((h) => h.id);

  for (const hid of hubIds) {
    try {
      await startDueBookedSlots(hid, now);
      await assignFreePointsForHub(hid, now);
    } catch (err) {
      console.error(`[charging.scheduler] failed for Hub "${hid}"`, err);
    }
  }
}
