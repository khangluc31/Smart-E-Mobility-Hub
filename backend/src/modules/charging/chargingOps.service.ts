// Operator charging operations: fleet charging dispatch (FR-51) and manual queue
// overrides (FR-52, FR-62, FR-63, BR-06, BR-12, D-08, D-23).

import type { ChargingRequest } from '@prisma/client';
import { audit } from '../../core/audit';
import { config } from '../../core/config';
import { db, lockRow } from '../../core/db';
import {
  badRequest,
  conflict,
  InvalidStateTransitionError,
} from '../../core/errors';
import { events } from '../../core/events';
import { notify } from '../../core/notify';
import { assertTransition } from '../../core/stateMachine';
import type {
  ChargingOverrideRequest,
  ChargingOverrideResult,
  DispatchResult,
  FleetDispatchRequest,
} from '../../types/charging';
import { buildHubProjection, getQueue, getWeights, toRequestView } from './charging.service';
import { createQueueRequest, type ChargingActor } from './chargingRequests.service';
import { score, type PriorityConfig } from './priority';

// CONTRACTS §8.2 default
const FULL_CHARGE_PCT = 100;

function getPriorityConfig(): PriorityConfig {
  return {
    urgencyHorizonMin: config.URGENCY_HORIZON_MIN,
    waitingFullMin: config.WAITING_FULL_MIN,
  };
}

function compareIdsAsc(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * FR-51: Queue low-battery fleet rental vehicle(s) for charging at their Hub.
 * Single mode rejects ineligible vehicles; bulk (`allLowBattery: true`) locks candidates
 * in ascending id order, re-checks each, and silently skips ineligible ones.
 */
export async function dispatchFleet(
  actor: ChargingActor,
  input: FleetDispatchRequest,
  now: Date = new Date(),
): Promise<DispatchResult> {
  const targetPct = input.targetPct ?? FULL_CHARGE_PCT;
  if (!Number.isFinite(targetPct) || targetPct <= 0 || targetPct > FULL_CHARGE_PCT) {
    throw badRequest(`targetPct must be greater than 0 and at most ${FULL_CHARGE_PCT}.`, 'targetPct');
  }

  const hub = await db.hub.findUnique({
    where: { id: input.hubId },
    select: { id: true },
  });
  if (!hub) {
    throw badRequest(`Hub "${input.hubId}" does not exist.`, 'hubId');
  }

  const createdRows = await db.$transaction(async (tx) => {
    if ('rentalVehicleId' in input) {
      await lockRow(tx, 'rental_vehicle', input.rentalVehicleId);
      const vehicle = await tx.rentalVehicle.findUniqueOrThrow({
        where: { id: input.rentalVehicleId },
      });

      if (vehicle.hubId !== hub.id) {
        throw badRequest(
          `Vehicle "${vehicle.id}" is at Hub "${vehicle.hubId}", not Hub "${hub.id}" (wrong Hub).`,
          'hubId',
        );
      }

      if (vehicle.status !== 'LOW_BATTERY' && vehicle.status !== 'AVAILABLE') {
        throw conflict(
          'NOT_ELIGIBLE',
          `Vehicle "${vehicle.id}" has status ${vehicle.status} and cannot be dispatched for charging.`,
          { nextActions: ['Choose an unreserved LOW_BATTERY or AVAILABLE vehicle at this Hub.'] },
        );
      }

      // D-23: read-only; charging must never import reservations.
      const activeReservation = await tx.vehicleReservation.findFirst({
        where: {
          rentalVehicleId: vehicle.id,
          status: { in: ['CONFIRMED', 'ACTIVE'] },
        },
        select: { id: true },
      });
      if (activeReservation) {
        throw conflict(
          'NOT_ELIGIBLE',
          `Vehicle "${vehicle.id}" has an active reservation and cannot be dispatched.`,
          { nextActions: ['Wait until the reservation completes or is cancelled.'] },
        );
      }

      if (vehicle.batteryPct >= config.MIN_RENTAL_BATTERY_PCT) {
        throw conflict(
          'NOT_ELIGIBLE',
          `Vehicle "${vehicle.id}" battery (${vehicle.batteryPct}%) is not below ${config.MIN_RENTAL_BATTERY_PCT}%.`,
          { nextActions: ['Only rental vehicles below the low-battery threshold can be dispatched.'] },
        );
      }

      if (targetPct <= vehicle.batteryPct) {
        throw badRequest(
          `targetPct (${targetPct}) must be greater than current batteryPct (${vehicle.batteryPct}).`,
          'targetPct',
        );
      }

      const activeCharging = await tx.chargingRequest.findFirst({
        where: {
          rentalVehicleId: vehicle.id,
          status: { in: ['QUEUED', 'SCHEDULED', 'CHARGING'] },
        },
        select: { id: true },
      });
      if (activeCharging) {
        throw conflict(
          'HAS_ACTIVE_BOOKING',
          `Vehicle "${vehicle.id}" already has an active charging request.`,
          { nextActions: ['Check the charging queue or running sessions at this Hub.'] },
        );
      }

      const created = await createQueueRequest(
        tx,
        {
          requestedById: actor.id,
          ownerId: null,
          vehicleKind: 'RENTAL',
          rentalVehicleId: vehicle.id,
          vehicleClass: 'MOTORCYCLE',
          hubId: hub.id,
          targetPct,
          currentPct: vehicle.batteryPct,
        },
        now,
      );

      await audit(tx, {
        actorId: actor.id,
        actorRole: actor.role,
        action: 'CHARGING_DISPATCHED',
        entityType: 'charging_request',
        entityIds: [created.id, vehicle.id],
        details: { hubId: hub.id, targetPct },
      });

      return [created];
    }

    // Bulk mode (`allLowBattery: true`): select candidates, lock in ascending id order,
    // re-check each, and silently skip ineligible ones.
    const candidates = await tx.rentalVehicle.findMany({
      where: {
        hubId: hub.id,
        batteryPct: { lt: config.MIN_RENTAL_BATTERY_PCT },
        status: { in: ['LOW_BATTERY', 'AVAILABLE'] },
      },
      orderBy: { id: 'asc' },
      select: { id: true },
    });

    const candidateIds = candidates.map((c) => c.id).sort(compareIdsAsc);
    for (const vehicleId of candidateIds) {
      await lockRow(tx, 'rental_vehicle', vehicleId);
    }

    const createdList: ChargingRequest[] = [];

    for (const vehicleId of candidateIds) {
      const vehicle = await tx.rentalVehicle.findUnique({ where: { id: vehicleId } });
      if (
        !vehicle ||
        vehicle.hubId !== hub.id ||
        vehicle.batteryPct >= config.MIN_RENTAL_BATTERY_PCT ||
        (vehicle.status !== 'LOW_BATTERY' && vehicle.status !== 'AVAILABLE') ||
        targetPct <= vehicle.batteryPct
      ) {
        continue;
      }

      // D-23: read-only; charging must never import reservations.
      const activeReservation = await tx.vehicleReservation.findFirst({
        where: {
          rentalVehicleId: vehicle.id,
          status: { in: ['CONFIRMED', 'ACTIVE'] },
        },
        select: { id: true },
      });
      if (activeReservation) {
        continue;
      }

      const activeCharging = await tx.chargingRequest.findFirst({
        where: {
          rentalVehicleId: vehicle.id,
          status: { in: ['QUEUED', 'SCHEDULED', 'CHARGING'] },
        },
        select: { id: true },
      });
      if (activeCharging) {
        continue;
      }

      const created = await createQueueRequest(
        tx,
        {
          requestedById: actor.id,
          ownerId: null,
          vehicleKind: 'RENTAL',
          rentalVehicleId: vehicle.id,
          vehicleClass: 'MOTORCYCLE',
          hubId: hub.id,
          targetPct,
          currentPct: vehicle.batteryPct,
        },
        now,
      );

      await audit(tx, {
        actorId: actor.id,
        actorRole: actor.role,
        action: 'CHARGING_DISPATCHED',
        entityType: 'charging_request',
        entityIds: [created.id, vehicle.id],
        details: { hubId: hub.id, targetPct },
      });

      createdList.push(created);
    }

    return createdList;
  });

  if (createdRows.length === 0) {
    return { created: [] };
  }

  // Compute projection before emitting so returned views reflect current queue positions.
  const bundle = await buildHubProjection(db, hub.id, now);
  const created = createdRows.map((row) => toRequestView(row, bundle.projection, now));

  events.emit('CHARGING_QUEUE_CHANGED', { hubId: hub.id });

  return { created };
}

function assertQueuedTarget(req: ChargingRequest): void {
  if (req.status === 'CHARGING' || req.status === 'SCHEDULED') {
    throw conflict(
      'SESSION_PROTECTED',
      "Running sessions and booked slots can't be reordered.",
      { nextActions: ['Select a QUEUED charging request to override.'] },
    );
  }
  if (req.status !== 'QUEUED') {
    throw new InvalidStateTransitionError('chargingRequest', req.status, 'QUEUED');
  }
}

/**
 * FR-52, FR-62, FR-63: Operator manual override on QUEUED charging requests
 * (PROMOTE, DEFER, SWAP, CANCEL) with mandatory reason, audit row per changed request,
 * and notifications to affected owners.
 */
export async function overrideQueue(
  actor: ChargingActor,
  input: ChargingOverrideRequest,
  now: Date = new Date(),
): Promise<ChargingOverrideResult> {
  const reason = input.reason.trim();
  if (reason.length < config.OVERRIDE_REASON_MIN_CHARS) {
    throw badRequest(
      `reason must be at least ${config.OVERRIDE_REASON_MIN_CHARS} characters.`,
      'reason',
    );
  }

  let otherId: string | undefined;
  if (input.action === 'SWAP') {
    otherId = input.otherRequestId?.trim();
    if (!otherId) {
      throw badRequest('otherRequestId is required for SWAP.', 'otherRequestId');
    }
    if (otherId === input.requestId) {
      throw badRequest('otherRequestId must be different from requestId.', 'otherRequestId');
    }
  }

  const target = await db.$transaction(async (tx) => {
    const idsToLock =
      input.action === 'SWAP' && otherId
        ? [input.requestId, otherId].sort(compareIdsAsc)
        : [input.requestId];

    for (const id of idsToLock) {
      await lockRow(tx, 'charging_request', id);
    }

    const reqA = await tx.chargingRequest.findUniqueOrThrow({ where: { id: input.requestId } });
    const weightsView = await getWeights(tx);
    const weights = {
      battery: weightsView.battery,
      urgency: weightsView.urgency,
      waiting: weightsView.waiting,
    };
    const priorityCfg = getPriorityConfig();

    if (input.action === 'PROMOTE') {
      assertQueuedTarget(reqA);
      const scoreBefore = score(reqA, weights, now, priorityCfg);
      const newAdj = reqA.manualAdjust + config.MANUAL_ADJUST_STEP;
      const scoreAfter = score({ ...reqA, manualAdjust: newAdj }, weights, now, priorityCfg);

      await tx.chargingRequest.update({
        where: { id: reqA.id },
        data: { manualAdjust: newAdj },
      });

      await audit(tx, {
        actorId: actor.id,
        actorRole: actor.role,
        action: 'CHARGING_OVERRIDE',
        entityType: 'charging_request',
        entityIds: [reqA.id],
        reason,
        details: {
          action: 'PROMOTE',
          before: { manualAdjust: reqA.manualAdjust, score: scoreBefore },
          after: { manualAdjust: newAdj, score: scoreAfter },
        },
      });

      return { hubId: reqA.hubId, vehicleClass: reqA.vehicleClass };
    }

    if (input.action === 'DEFER') {
      assertQueuedTarget(reqA);
      const scoreBefore = score(reqA, weights, now, priorityCfg);
      const newAdj = reqA.manualAdjust - config.MANUAL_ADJUST_STEP;
      const scoreAfter = score({ ...reqA, manualAdjust: newAdj }, weights, now, priorityCfg);

      await tx.chargingRequest.update({
        where: { id: reqA.id },
        data: { manualAdjust: newAdj },
      });

      await audit(tx, {
        actorId: actor.id,
        actorRole: actor.role,
        action: 'CHARGING_OVERRIDE',
        entityType: 'charging_request',
        entityIds: [reqA.id],
        reason,
        details: {
          action: 'DEFER',
          before: { manualAdjust: reqA.manualAdjust, score: scoreBefore },
          after: { manualAdjust: newAdj, score: scoreAfter },
        },
      });

      if (reqA.ownerId) {
        await notify(tx, {
          userId: reqA.ownerId,
          type: 'CHARGING_DEFERRED',
          title: 'Charging request deferred',
          body: `Your queued charging request at Hub ${reqA.hubId} was deferred by an operator: ${reason}`,
          data: {
            chargingRequestId: reqA.id,
            hubId: reqA.hubId,
            action: 'DEFER',
            reason,
          },
        });
      }

      return { hubId: reqA.hubId, vehicleClass: reqA.vehicleClass };
    }

    if (input.action === 'SWAP') {
      const reqB = await tx.chargingRequest.findUniqueOrThrow({ where: { id: otherId! } });
      assertQueuedTarget(reqA);
      assertQueuedTarget(reqB);

      if (reqA.hubId !== reqB.hubId || reqA.vehicleClass !== reqB.vehicleClass) {
        throw badRequest(
          'Both requests in a SWAP must belong to the same Hub and vehicle class.',
          'otherRequestId',
        );
      }

      const scoreA = score(reqA, weights, now, priorityCfg);
      const scoreB = score(reqB, weights, now, priorityCfg);

      // FR-52: exchange scores at `now`; scores continue moving with waiting time afterwards (expected).
      const newAdjA = reqA.manualAdjust + (scoreB - scoreA);
      const newAdjB = reqB.manualAdjust + (scoreA - scoreB);
      const scoreAAfter = score({ ...reqA, manualAdjust: newAdjA }, weights, now, priorityCfg);
      const scoreBAfter = score({ ...reqB, manualAdjust: newAdjB }, weights, now, priorityCfg);

      await tx.chargingRequest.update({
        where: { id: reqA.id },
        data: { manualAdjust: newAdjA },
      });
      await tx.chargingRequest.update({
        where: { id: reqB.id },
        data: { manualAdjust: newAdjB },
      });

      // One audit row per changed request, referencing the swapped partner in details.
      await audit(tx, {
        actorId: actor.id,
        actorRole: actor.role,
        action: 'CHARGING_OVERRIDE',
        entityType: 'charging_request',
        entityIds: [reqA.id],
        reason,
        details: {
          action: 'SWAP',
          otherRequestId: reqB.id,
          before: { manualAdjust: reqA.manualAdjust, score: scoreA },
          after: { manualAdjust: newAdjA, score: scoreAAfter },
        },
      });
      await audit(tx, {
        actorId: actor.id,
        actorRole: actor.role,
        action: 'CHARGING_OVERRIDE',
        entityType: 'charging_request',
        entityIds: [reqB.id],
        reason,
        details: {
          action: 'SWAP',
          otherRequestId: reqA.id,
          before: { manualAdjust: reqB.manualAdjust, score: scoreB },
          after: { manualAdjust: newAdjB, score: scoreBAfter },
        },
      });

      // Notify only the owner of the request whose score went down (skip if ownerId is null or equal).
      const deferredReq = scoreB < scoreA ? reqA : scoreA < scoreB ? reqB : null;
      if (deferredReq?.ownerId) {
        const partnerId = deferredReq.id === reqA.id ? reqB.id : reqA.id;
        await notify(tx, {
          userId: deferredReq.ownerId,
          type: 'CHARGING_DEFERRED',
          title: 'Charging request deferred',
          body: `Your queued charging request at Hub ${deferredReq.hubId} was moved lower in the queue by an operator: ${reason}`,
          data: {
            chargingRequestId: deferredReq.id,
            otherRequestId: partnerId,
            hubId: deferredReq.hubId,
            action: 'SWAP',
            reason,
          },
        });
      }

      return { hubId: reqA.hubId, vehicleClass: reqA.vehicleClass };
    }

    // CANCEL
    if (reqA.status === 'CHARGING' || reqA.status === 'SCHEDULED') {
      throw conflict(
        'SESSION_PROTECTED',
        "Running sessions and booked slots can't be reordered.",
        { nextActions: ['Select a QUEUED charging request to cancel.'] },
      );
    }
    assertTransition('chargingRequest', reqA.status, 'CANCELLED');

    const scoreBefore = score(reqA, weights, now, priorityCfg);

    await tx.chargingRequest.update({
      where: { id: reqA.id },
      data: {
        status: 'CANCELLED',
        endedAt: now,
      },
    });

    await audit(tx, {
      actorId: actor.id,
      actorRole: actor.role,
      action: 'CHARGING_OVERRIDE',
      entityType: 'charging_request',
      entityIds: [reqA.id],
      reason,
      details: {
        action: 'CANCEL',
        before: { manualAdjust: reqA.manualAdjust, score: scoreBefore, status: reqA.status },
        after: { manualAdjust: reqA.manualAdjust, score: scoreBefore, status: 'CANCELLED' },
      },
    });

    if (reqA.ownerId) {
      await notify(tx, {
        userId: reqA.ownerId,
        type: 'CHARGING_CANCELLED',
        title: 'Charging request cancelled',
        body: `Your queued charging request at Hub ${reqA.hubId} was cancelled by an operator: ${reason}`,
        data: {
          chargingRequestId: reqA.id,
          hubId: reqA.hubId,
          action: 'CANCEL',
          reason,
        },
      });
    }

    return { hubId: reqA.hubId, vehicleClass: reqA.vehicleClass };
  });

  // Compute updated queue before emitting so the response reflects the overridden queue order.
  const queue = await getQueue({ hubId: target.hubId, vehicleClass: target.vehicleClass }, now);

  events.emit('CHARGING_QUEUE_CHANGED', { hubId: target.hubId });

  return { entries: queue.entries };
}
