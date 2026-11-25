// Incidents service: report, withdraw, and atomic single-transaction recovery
// (FR-13, FR-36..FR-40, FR-62, FR-63, BR-05, BR-07, D-06, UC-21 E2, UC-22 A1).
// Lock order: withdrawn resource first -> affected bookings; replacement resources are
// picked via FOR UPDATE SKIP LOCKED (never waiting, so deadlock-free).

import {
  Prisma,
  type Incident as PrismaIncident,
  type IncidentImpact as PrismaIncidentImpact,
  type IncidentReport as PrismaIncidentReport,
} from '@prisma/client';
import { audit } from '../../core/audit';
import { config } from '../../core/config';
import { db, lockRow, type LockableTable, type Tx } from '../../core/db';
import { AppError, badRequest, notFound } from '../../core/errors';
import { events } from '../../core/events';
import { encodeCursor, type ListCursor } from '../../core/pagination';
import { assertTransition } from '../../core/stateMachine';
import {
  INCIDENT_CATEGORIES,
  type IncidentCategory,
  type IncidentResourceType,
  type IncidentSource,
  type IncidentStatus,
  type Role,
  type VehicleClass,
} from '../../types/enums';
import type {
  Incident,
  IncidentDetail,
  IncidentImpact,
  IncidentList,
  IncidentReportView,
  ReportIncidentResult,
} from '../../types/incidents';
import * as chargingRequestsService from '../charging/chargingRequests.service';
import * as parkingReservationsService from '../reservations/parkingReservations.service';
import * as vehicleReservationsService from '../reservations/vehicleReservations.service';

export const OPERATOR_NOTES_MAX = 1000;
export const STUDENT_NOTES_MAX = 500;

export type ReportIncidentInput =
  | {
      source: 'OPERATOR';
      resourceType: IncidentResourceType;
      resourceId: string;
      hubId: string;
      vehicleClass: VehicleClass;
      category: IncidentCategory;
      notes: string;
      reportedById: string;
    }
  | {
      source: 'STUDENT';
      resourceType: 'RENTAL_VEHICLE';
      resourceId: string;
      category: IncidentCategory;
      notes: string;
      reportedById: string;
    }
  | {
      source: 'TELEMETRY';
      resourceType: IncidentResourceType;
      resourceId: string;
      hubId: string;
      vehicleClass?: VehicleClass;
      category: IncidentCategory;
      notes: string;
      reportedById?: null;
    };

export function toIncidentDto(row: PrismaIncident): Incident {
  return {
    id: row.id,
    status: row.status,
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    hubId: row.hubId,
    vehicleClass: row.vehicleClass,
    category: row.category,
    notes: row.notes,
    source: row.source,
    reportedById: row.reportedById ?? null,
    resolutionNotes: row.resolutionNotes ?? null,
    createdAt: row.createdAt.toISOString(),
    inMaintenanceAt: row.inMaintenanceAt ? row.inMaintenanceAt.toISOString() : null,
    resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
  };
}

/**
 * FR-36 (T-22 Rule 1): Map a telemetry fault code to an IncidentCategory.
 * Returns the code itself when it equals a known IncidentCategory; otherwise uses
 * the default category for the resource type.
 */
export function categoryForFault(
  resourceType: IncidentResourceType,
  faultCode: string,
): IncidentCategory {
  if ((INCIDENT_CATEGORIES as readonly string[]).includes(faultCode)) {
    return faultCode as IncidentCategory;
  }
  switch (resourceType) {
    case 'RENTAL_VEHICLE':
      return 'VEHICLE_FAULT';
    case 'CHARGING_POINT':
      return 'CHARGER_FAULT';
    case 'PARKING_SPACE':
      return 'OBSTRUCTION';
  }
}

function tableForResourceType(resourceType: IncidentResourceType): LockableTable {
  switch (resourceType) {
    case 'RENTAL_VEHICLE':
      return 'rental_vehicle';
    case 'PARKING_SPACE':
      return 'parking_space';
    case 'CHARGING_POINT':
      return 'charging_point';
  }
}

function isOpenIncidentUniqueError(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
    const metaText = err.meta ? JSON.stringify(err.meta) : '';
    return metaText.includes('uq_incident_open') || err.message.includes('uq_incident_open');
  }
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('uq_incident_open');
}

function validateNotes(source: IncidentSource, rawNotes: string): string {
  const trimmed = rawNotes.trim();
  const maxLen = source === 'STUDENT' ? STUDENT_NOTES_MAX : OPERATOR_NOTES_MAX;
  if (trimmed.length < 1) {
    throw badRequest('notes must not be empty.', 'notes');
  }
  if (trimmed.length > maxLen) {
    throw badRequest(`notes must be at most ${maxLen} characters.`, 'notes');
  }
  return trimmed;
}

async function linkToExistingOpenIncident(
  tx: Tx,
  resourceType: IncidentResourceType,
  resourceId: string,
  source: IncidentSource,
  reportedById: string | null,
  notes: string,
  now: Date,
): Promise<{ hubId: string; result: ReportIncidentResult } | null> {
  const existing = await tx.incident.findFirst({
    where: {
      resourceType,
      resourceId,
      status: { in: ['REPORTED', 'IN_MAINTENANCE'] },
    },
  });
  if (!existing) {
    return null;
  }

  await tx.incidentReport.create({
    data: {
      incidentId: existing.id,
      source,
      reportedById,
      notes,
      createdAt: now,
    },
  });

  return {
    hubId: existing.hubId,
    result: {
      incident: toIncidentDto(existing),
      linkedToExisting: true,
      impacts: [],
    },
  };
}

/**
 * FR-13, FR-36..FR-40, FR-62, FR-63, BR-07, D-06, UC-21 E2:
 * Report an incident for a rental vehicle, parking space, or charging point.
 * In one transaction: locks the resource, links to any open incident (UC-21 E2) or creates
 * a new REPORTED incident + initial report, withdraws the resource (FR-38), recovers every
 * active booking (FR-39/FR-40) with incident_impact rows + notifications, and audits
 * Operator-created incidents. Emits post-commit events only when a new incident was created.
 */
export async function reportIncident(
  input: ReportIncidentInput,
  now: Date = new Date(),
): Promise<ReportIncidentResult> {
  const notes = validateNotes(input.source, input.notes);
  const reportedById = input.reportedById ?? null;
  const table = tableForResourceType(input.resourceType);

  let outcome: { hubId: string; result: ReportIncidentResult };

  try {
    outcome = await db.$transaction(async (tx) => {
      // Step 1: Lock the withdrawn resource row first (T-22 Rule 2, ARCHITECTURE §4.1).
      try {
        await lockRow(tx, table, input.resourceId);
      } catch (err: unknown) {
        if (err instanceof AppError && err.code === 'NOT_FOUND') {
          if (input.source === 'OPERATOR') {
            throw badRequest(
              `${input.resourceType} "${input.resourceId}" does not exist.`,
              'resourceId',
            );
          }
          if (input.source === 'STUDENT') {
            throw notFound('Rental vehicle');
          }
        }
        throw err;
      }

      // Step 2: Load the locked resource and validate Hub / class / student reservation ownership.
      let resolvedHubId: string;
      let resolvedVehicleClass: VehicleClass;

      if (input.resourceType === 'RENTAL_VEHICLE') {
        const vehicle = await tx.rentalVehicle.findUniqueOrThrow({
          where: { id: input.resourceId },
        });
        if (input.source === 'OPERATOR') {
          if (vehicle.hubId !== input.hubId) {
            throw badRequest(
              `Rental vehicle "${vehicle.id}" does not belong to Hub "${input.hubId}".`,
              'hubId',
            );
          }
          if (vehicle.vehicleClass !== input.vehicleClass) {
            throw badRequest(
              `Rental vehicle "${vehicle.id}" has class ${vehicle.vehicleClass}, expected ${input.vehicleClass}.`,
              'vehicleClass',
            );
          }
        } else if (input.source === 'STUDENT') {
          // FR-13: caller must have a CONFIRMED or ACTIVE reservation for this vehicle, else 404.
          const activeReservation = await tx.vehicleReservation.findFirst({
            where: {
              userId: input.reportedById,
              rentalVehicleId: vehicle.id,
              status: { in: ['CONFIRMED', 'ACTIVE'] },
            },
            select: { id: true },
          });
          if (!activeReservation) {
            throw notFound('Rental vehicle');
          }
        } else {
          if (vehicle.hubId !== input.hubId) {
            throw badRequest(
              `Rental vehicle "${vehicle.id}" does not belong to Hub "${input.hubId}".`,
              'hubId',
            );
          }
          if (input.vehicleClass !== undefined && vehicle.vehicleClass !== input.vehicleClass) {
            throw badRequest(
              `Rental vehicle "${vehicle.id}" has class ${vehicle.vehicleClass}, expected ${input.vehicleClass}.`,
              'vehicleClass',
            );
          }
        }
        resolvedHubId = vehicle.hubId;
        resolvedVehicleClass = vehicle.vehicleClass;

        // Step 3: Duplicate -> link to existing open incident (UC-21 E2).
        const linked = await linkToExistingOpenIncident(
          tx,
          input.resourceType,
          input.resourceId,
          input.source,
          reportedById,
          notes,
          now,
        );
        if (linked) {
          return linked;
        }

        // Step 4: Create REPORTED incident + initial incident_report.
        const created = await tx.incident.create({
          data: {
            resourceType: input.resourceType,
            resourceId: vehicle.id,
            hubId: resolvedHubId,
            vehicleClass: resolvedVehicleClass,
            category: input.category,
            notes,
            source: input.source,
            reportedById,
            status: 'REPORTED',
            createdAt: now,
          },
        });
        await tx.incidentReport.create({
          data: {
            incidentId: created.id,
            source: input.source,
            reportedById,
            notes,
            createdAt: now,
          },
        });

        // Step 5: Withdraw vehicle -> FAULTY (skip status write if already FAULTY).
        if (vehicle.status !== 'FAULTY') {
          assertTransition('rentalVehicle', vehicle.status, 'FAULTY');
          await tx.rentalVehicle.update({
            where: { id: vehicle.id },
            data: { status: 'FAULTY' },
          });
        }

        // Step 6: Recover vehicle reservations and charging requests inside the same transaction.
        const vehicleImpacts = await vehicleReservationsService.recoverVehicleBookings(
          tx,
          {
            id: vehicle.id,
            hubId: vehicle.hubId,
            type: vehicle.type,
            batteryPct: vehicle.batteryPct,
          },
          now,
        );
        const chargingImpacts = await chargingRequestsService.recoverChargingForVehicle(
          tx,
          { rentalVehicleId: vehicle.id },
          now,
        );
        const impacts: IncidentImpact[] = [...vehicleImpacts, ...chargingImpacts];

        if (impacts.length > 0) {
          await tx.incidentImpact.createMany({
            data: impacts.map((imp) => ({
              incidentId: created.id,
              bookingType: imp.bookingType,
              bookingId: imp.bookingId,
              userId: imp.userId,
              outcome: imp.outcome,
              newResourceId: imp.newResourceId,
            })),
          });
        }

        if (input.source === 'OPERATOR') {
          await audit(tx, {
            actorId: input.reportedById,
            actorRole: 'OPERATOR',
            action: 'INCIDENT_CREATED',
            entityType: 'incident',
            entityIds: [created.id, vehicle.id],
            details: {
              category: input.category,
              impacts: impacts.length,
            },
          });
        }

        return {
          hubId: resolvedHubId,
          result: {
            incident: toIncidentDto(created),
            linkedToExisting: false,
            impacts,
          },
        };
      }

      if (input.resourceType === 'PARKING_SPACE') {
        const space = await tx.parkingSpace.findUniqueOrThrow({
          where: { id: input.resourceId },
        });
        if (space.hubId !== input.hubId) {
          throw badRequest(
            `Parking space "${space.id}" does not belong to Hub "${input.hubId}".`,
            'hubId',
          );
        }
        if (input.vehicleClass !== undefined && space.vehicleClass !== input.vehicleClass) {
          throw badRequest(
            `Parking space "${space.id}" has class ${space.vehicleClass}, expected ${input.vehicleClass}.`,
            'vehicleClass',
          );
        }
        resolvedHubId = space.hubId;
        resolvedVehicleClass = space.vehicleClass;

        const linked = await linkToExistingOpenIncident(
          tx,
          input.resourceType,
          input.resourceId,
          input.source,
          reportedById,
          notes,
          now,
        );
        if (linked) {
          return linked;
        }

        const created = await tx.incident.create({
          data: {
            resourceType: input.resourceType,
            resourceId: space.id,
            hubId: resolvedHubId,
            vehicleClass: resolvedVehicleClass,
            category: input.category,
            notes,
            source: input.source,
            reportedById,
            status: 'REPORTED',
            createdAt: now,
          },
        });
        await tx.incidentReport.create({
          data: {
            incidentId: created.id,
            source: input.source,
            reportedById,
            notes,
            createdAt: now,
          },
        });

        // Withdraw space -> UNAVAILABLE (skip status write if already UNAVAILABLE).
        if (space.status !== 'UNAVAILABLE') {
          assertTransition('parkingSpace', space.status, 'UNAVAILABLE');
          await tx.parkingSpace.update({
            where: { id: space.id },
            data: { status: 'UNAVAILABLE' },
          });
        }

        const impacts = await parkingReservationsService.recoverParkingBookings(
          tx,
          {
            id: space.id,
            hubId: space.hubId,
            vehicleClass: space.vehicleClass,
          },
          now,
        );

        if (impacts.length > 0) {
          await tx.incidentImpact.createMany({
            data: impacts.map((imp) => ({
              incidentId: created.id,
              bookingType: imp.bookingType,
              bookingId: imp.bookingId,
              userId: imp.userId,
              outcome: imp.outcome,
              newResourceId: imp.newResourceId,
            })),
          });
        }

        if (input.source === 'OPERATOR') {
          await audit(tx, {
            actorId: input.reportedById,
            actorRole: 'OPERATOR',
            action: 'INCIDENT_CREATED',
            entityType: 'incident',
            entityIds: [created.id, space.id],
            details: {
              category: input.category,
              impacts: impacts.length,
            },
          });
        }

        return {
          hubId: resolvedHubId,
          result: {
            incident: toIncidentDto(created),
            linkedToExisting: false,
            impacts,
          },
        };
      }

      // CHARGING_POINT
      const point = await tx.chargingPoint.findUniqueOrThrow({
        where: { id: input.resourceId },
      });
      if (point.hubId !== input.hubId) {
        throw badRequest(
          `Charging point "${point.id}" does not belong to Hub "${input.hubId}".`,
          'hubId',
        );
      }
      if (input.vehicleClass !== undefined && point.vehicleClass !== input.vehicleClass) {
        throw badRequest(
          `Charging point "${point.id}" has class ${point.vehicleClass}, expected ${input.vehicleClass}.`,
          'vehicleClass',
        );
      }
      resolvedHubId = point.hubId;
      resolvedVehicleClass = point.vehicleClass;

      const linked = await linkToExistingOpenIncident(
        tx,
        input.resourceType,
        input.resourceId,
        input.source,
        reportedById,
        notes,
        now,
      );
      if (linked) {
        return linked;
      }

      const created = await tx.incident.create({
        data: {
          resourceType: input.resourceType,
          resourceId: point.id,
          hubId: resolvedHubId,
          vehicleClass: resolvedVehicleClass,
          category: input.category,
          notes,
          source: input.source,
          reportedById,
          status: 'REPORTED',
          createdAt: now,
        },
      });
      await tx.incidentReport.create({
        data: {
          incidentId: created.id,
          source: input.source,
          reportedById,
          notes,
          createdAt: now,
        },
      });

      // Withdraw charging point -> FAULTY (skip status write if already FAULTY).
      if (point.status !== 'FAULTY') {
        assertTransition('chargingPoint', point.status, 'FAULTY');
        await tx.chargingPoint.update({
          where: { id: point.id },
          data: { status: 'FAULTY' },
        });
      }

      const impacts = await chargingRequestsService.recoverChargingForPoint(
        tx,
        {
          id: point.id,
          hubId: point.hubId,
          vehicleClass: point.vehicleClass,
        },
        now,
      );

      if (impacts.length > 0) {
        await tx.incidentImpact.createMany({
          data: impacts.map((imp) => ({
            incidentId: created.id,
            bookingType: imp.bookingType,
            bookingId: imp.bookingId,
            userId: imp.userId,
            outcome: imp.outcome,
            newResourceId: imp.newResourceId,
          })),
        });
      }

      if (input.source === 'OPERATOR') {
        await audit(tx, {
          actorId: input.reportedById,
          actorRole: 'OPERATOR',
          action: 'INCIDENT_CREATED',
          entityType: 'incident',
          entityIds: [created.id, point.id],
          details: {
            category: input.category,
            impacts: impacts.length,
          },
        });
      }

      return {
        hubId: resolvedHubId,
        result: {
          incident: toIncidentDto(created),
          linkedToExisting: false,
          impacts,
        },
      };
    });
  } catch (err: unknown) {
    // UC-21 E2 fallback: if a concurrent report somehow tripped uq_incident_open after rollback,
    // link to the existing open incident in a follow-up transaction (never return 500).
    if (isOpenIncidentUniqueError(err)) {
      const linked = await db.$transaction(async (tx) => {
        await lockRow(tx, table, input.resourceId);
        return linkToExistingOpenIncident(
          tx,
          input.resourceType,
          input.resourceId,
          input.source,
          reportedById,
          notes,
          now,
        );
      });
      if (linked) {
        return linked.result;
      }
    }
    throw err;
  }

  // Post-commit events only when a new incident withdrew a resource (linked reports emit nothing).
  if (!outcome.result.linkedToExisting) {
    events.emit('RESOURCE_WITHDRAWN', { hubId: outcome.hubId });
    events.emit('RESERVATION_CHANGED', { hubId: outcome.hubId });
    events.emit('CHARGING_QUEUE_CHANGED', { hubId: outcome.hubId });
  }

  return outcome.result;
}

export interface IncidentActor {
  id: string;
  role: Role;
}

export interface IncidentListFilters {
  hubId?: string;
  resourceId?: string;
  vehicleClass?: VehicleClass;
  category?: IncidentCategory;
  status?: IncidentStatus;
  from?: Date;
  to?: Date;
}

export interface IncidentListPageOptions {
  limit: number;
  cursor: ListCursor | null;
}

function toIncidentReportView(row: PrismaIncidentReport): IncidentReportView {
  return {
    source: row.source,
    reportedById: row.reportedById ?? null,
    notes: row.notes,
    createdAt: row.createdAt.toISOString(),
  };
}

function toIncidentImpactDto(row: PrismaIncidentImpact): IncidentImpact {
  return {
    bookingType: row.bookingType,
    bookingId: row.bookingId,
    userId: row.userId ?? null,
    outcome: row.outcome,
    newResourceId: row.newResourceId ?? null,
  };
}

/**
 * FR-41, FR-63, BR-05 (T-23 Rule 1): Move a REPORTED incident to IN_MAINTENANCE.
 * Resource stays withdrawn; no post-commit events.
 */
export async function startMaintenance(
  actor: IncidentActor,
  incidentId: string,
  notes?: string,
  now: Date = new Date(),
): Promise<Incident> {
  let trimmedNotes: string | undefined;
  if (notes !== undefined) {
    const trimmed = notes.trim();
    if (trimmed.length > OPERATOR_NOTES_MAX) {
      throw badRequest(`notes must be at most ${OPERATOR_NOTES_MAX} characters.`, 'notes');
    }
    trimmedNotes = trimmed.length > 0 ? trimmed : undefined;
  }

  return db.$transaction(async (tx) => {
    await lockRow(tx, 'incident', incidentId);
    const inc = await tx.incident.findUniqueOrThrow({ where: { id: incidentId } });

    assertTransition('incident', inc.status, 'IN_MAINTENANCE');

    const updated = await tx.incident.update({
      where: { id: inc.id },
      data: {
        status: 'IN_MAINTENANCE',
        inMaintenanceAt: now,
      },
    });

    // Incident has no maintenance notes column; optional operator notes live only in the audit row.
    await audit(tx, {
      actorId: actor.id,
      actorRole: actor.role,
      action: 'INCIDENT_MAINTENANCE_STARTED',
      entityType: 'incident',
      entityIds: [inc.id, inc.resourceId],
      reason: trimmedNotes,
    });

    return toIncidentDto(updated);
  });
}

/**
 * FR-41, FR-63, BR-05 (T-23 Rule 2): Resolve an IN_MAINTENANCE incident with mandatory notes,
 * returning the resource to service in the same transaction.
 * Lock order: resource -> incident (matches reportIncident so resolve and new report cannot deadlock).
 */
export async function resolveIncident(
  actor: IncidentActor,
  incidentId: string,
  resolutionNotes: string,
  now: Date = new Date(),
): Promise<Incident> {
  // Rule 2: validate resolutionNotes before any DB read (no state change on invalid notes).
  const trimmedNotes = typeof resolutionNotes === 'string' ? resolutionNotes.trim() : '';
  if (trimmedNotes.length < 1) {
    throw badRequest('resolutionNotes is required.', 'resolutionNotes');
  }
  if (trimmedNotes.length > OPERATOR_NOTES_MAX) {
    throw badRequest(
      `resolutionNotes must be at most ${OPERATOR_NOTES_MAX} characters.`,
      'resolutionNotes',
    );
  }

  const outcome = await db.$transaction(async (tx) => {
    // 1. Unlocked read to learn resourceType / resourceId before taking locks in order.
    const meta = await tx.incident.findUnique({
      where: { id: incidentId },
      select: { id: true, resourceType: true, resourceId: true },
    });
    if (!meta) {
      throw notFound('Incident');
    }

    // 2. Lock resource first, then incident — same order as reportIncident so concurrent
    // resolve and new report on the same resource cannot deadlock.
    await lockRow(tx, tableForResourceType(meta.resourceType), meta.resourceId);
    await lockRow(tx, 'incident', incidentId);

    // 3. Re-read incident under the lock and validate state transition.
    const inc = await tx.incident.findUniqueOrThrow({ where: { id: incidentId } });
    assertTransition('incident', inc.status, 'RESOLVED');

    // 4. Mark incident RESOLVED.
    const updated = await tx.incident.update({
      where: { id: inc.id },
      data: {
        status: 'RESOLVED',
        resolutionNotes: trimmedNotes,
        resolvedAt: now,
      },
    });

    // 5. Return the resource to service via assertTransition only if still in the withdrawn state;
    // if already changed out of band, skip the status write to avoid an invalid same-state/other move.
    let resourceStatus: string;
    if (inc.resourceType === 'RENTAL_VEHICLE') {
      const vehicle = await tx.rentalVehicle.findUniqueOrThrow({
        where: { id: inc.resourceId },
      });
      if (vehicle.status === 'FAULTY') {
        const nextStatus =
          vehicle.batteryPct >= config.MIN_RENTAL_BATTERY_PCT ? 'AVAILABLE' : 'LOW_BATTERY';
        assertTransition('rentalVehicle', vehicle.status, nextStatus);
        await tx.rentalVehicle.update({
          where: { id: vehicle.id },
          data: { status: nextStatus },
        });
        resourceStatus = nextStatus;
      } else {
        // Already outside FAULTY; keep its current status rather than forcing a transition.
        resourceStatus = vehicle.status;
      }
    } else if (inc.resourceType === 'PARKING_SPACE') {
      const space = await tx.parkingSpace.findUniqueOrThrow({
        where: { id: inc.resourceId },
      });
      if (space.status === 'UNAVAILABLE') {
        assertTransition('parkingSpace', space.status, 'FREE');
        // Read-only check on linked rental vehicle (do NOT lockRow it: locking rental_vehicle after
        // parking_space would invert T-12's rental_vehicle -> parking_space lock order; the space lock suffices).
        const linkedVehicle = await tx.rentalVehicle.findUnique({
          where: { parkingSpaceId: space.id },
          select: { id: true },
        });
        if (linkedVehicle) {
          assertTransition('parkingSpace', 'FREE', 'OCCUPIED');
          await tx.parkingSpace.update({
            where: { id: space.id },
            data: { status: 'OCCUPIED' },
          });
          resourceStatus = 'OCCUPIED';
        } else {
          await tx.parkingSpace.update({
            where: { id: space.id },
            data: { status: 'FREE' },
          });
          resourceStatus = 'FREE';
        }
      } else {
        // Already outside UNAVAILABLE; keep its current status.
        resourceStatus = space.status;
      }
    } else {
      const point = await tx.chargingPoint.findUniqueOrThrow({
        where: { id: inc.resourceId },
      });
      if (point.status === 'FAULTY') {
        assertTransition('chargingPoint', point.status, 'AVAILABLE');
        await tx.chargingPoint.update({
          where: { id: point.id },
          data: { status: 'AVAILABLE' },
        });
        resourceStatus = 'AVAILABLE';
      } else {
        // Already outside FAULTY; keep its current status.
        resourceStatus = point.status;
      }
    }

    // 6. Audit inside the same transaction.
    await audit(tx, {
      actorId: actor.id,
      actorRole: actor.role,
      action: 'INCIDENT_RESOLVED',
      entityType: 'incident',
      entityIds: [inc.id, inc.resourceId],
      reason: trimmedNotes,
      details: { resourceStatus },
    });

    // Take hubId from the locked incident row for post-commit event emission.
    return {
      dto: toIncidentDto(updated),
      hubId: inc.hubId,
      resourceType: inc.resourceType,
    };
  });

  // Post-commit events only after db.$transaction resolves.
  if (outcome.resourceType === 'CHARGING_POINT') {
    events.emit('CHARGING_QUEUE_CHANGED', { hubId: outcome.hubId });
  } else {
    events.emit('RESERVATION_CHANGED', { hubId: outcome.hubId });
  }

  return outcome.dto;
}

/**
 * FR-42, UC-23 (T-23 Rule 3): Search the incident log with optional exact/range filters
 * and cursor pagination (`createdAt DESC, id DESC`). Read-only, no transaction.
 */
export async function listIncidents(
  filters: IncidentListFilters,
  page: IncidentListPageOptions,
): Promise<IncidentList> {
  if (filters.from && filters.to && filters.from.getTime() > filters.to.getTime()) {
    throw badRequest('to must be on or after from.', 'to');
  }

  const createdAtRange: Prisma.DateTimeFilter = {};
  if (filters.from) createdAtRange.gte = filters.from;
  if (filters.to) createdAtRange.lte = filters.to;

  const where: Prisma.IncidentWhereInput = {
    ...(filters.hubId ? { hubId: filters.hubId } : {}),
    ...(filters.resourceId ? { resourceId: filters.resourceId } : {}),
    ...(filters.vehicleClass ? { vehicleClass: filters.vehicleClass } : {}),
    ...(filters.category ? { category: filters.category } : {}),
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.from || filters.to ? { createdAt: createdAtRange } : {}),
    ...(page.cursor
      ? {
          OR: [
            { createdAt: { lt: page.cursor.createdAt } },
            { createdAt: page.cursor.createdAt, id: { lt: page.cursor.id } },
          ],
        }
      : {}),
  };

  const rows = await db.incident.findMany({
    where,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: page.limit + 1,
  });

  const hasMore = rows.length > page.limit;
  const pageRows = hasMore ? rows.slice(0, page.limit) : rows;
  const lastRow = pageRows[pageRows.length - 1];
  const nextCursor = hasMore && lastRow ? encodeCursor(lastRow) : null;

  return {
    items: pageRows.map(toIncidentDto),
    nextCursor,
  };
}

/**
 * UC-23 (T-23 Rule 4): Get one incident with its reports (oldest first) and impacts.
 */
export async function getIncidentDetail(incidentId: string): Promise<IncidentDetail> {
  const row = await db.incident.findUnique({
    where: { id: incidentId },
    include: {
      reports: {
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      },
      impacts: {
        orderBy: { id: 'asc' },
      },
    },
  });

  if (!row) {
    throw notFound('Incident');
  }

  return {
    incident: toIncidentDto(row),
    reports: row.reports.map(toIncidentReportView),
    impacts: row.impacts.map(toIncidentImpactDto),
  };
}
