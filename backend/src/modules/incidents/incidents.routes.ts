// Incident routes: operator incident reporting, lifecycle, list & detail (CONTRACTS §11,
// FR-37..FR-42) and student vehicle fault reporting (CONTRACTS §4, FR-13).
// Validates input, calls the service, sends the response. No Prisma in routes (AGENTS.md §4).

import { Router, type NextFunction, type Request, type Response } from 'express';
import {
  badRequest,
  optional,
  requireEnum,
  requireIsoDate,
  requireString,
  unauthenticated,
} from '../../core/errors';
import { parseListQuery } from '../../core/pagination';
import {
  INCIDENT_CATEGORIES,
  INCIDENT_RESOURCE_TYPES,
  INCIDENT_STATUSES,
  VEHICLE_CLASSES,
} from '../../types/enums';
import {
  getIncidentDetail,
  listIncidents,
  OPERATOR_NOTES_MAX,
  reportIncident,
  resolveIncident,
  startMaintenance,
  STUDENT_NOTES_MAX,
} from './incidents.service';

type AsyncHandler = (req: Request, res: Response, next: NextFunction) => Promise<void>;
function wrap(fn: AsyncHandler) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };
}

function asObject(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw badRequest('Request body must be a JSON object.', 'body', [
      'Send a valid JSON object in the request body.',
    ]);
  }
  return body as Record<string, unknown>;
}

// Mounted at /api/ops/incidents (requireAuth + requireRole('OPERATOR'))
export const incidentsOpsRouter = Router();

// POST /api/ops/incidents (FR-37, FR-38, FR-39, FR-40, UC-21 E2)
incidentsOpsRouter.post(
  '/',
  wrap(async (req, res) => {
    if (!req.user) throw unauthenticated();
    const body = asObject(req.body);
    const resourceType = requireEnum(body, 'resourceType', INCIDENT_RESOURCE_TYPES);
    const resourceId = requireString(body, 'resourceId', { trim: true, min: 1 });
    const hubId = requireString(body, 'hubId', { trim: true, min: 1 });
    const vehicleClass = requireEnum(body, 'vehicleClass', VEHICLE_CLASSES);
    const category = requireEnum(body, 'category', INCIDENT_CATEGORIES);
    const notes = requireString(body, 'notes', {
      trim: true,
      min: 1,
      max: OPERATOR_NOTES_MAX,
    });

    const result = await reportIncident({
      source: 'OPERATOR',
      resourceType,
      resourceId,
      hubId,
      vehicleClass,
      category,
      notes,
      reportedById: req.user.id,
    });
    res.status(201).json(result);
  }),
);

// GET /api/ops/incidents (FR-42, UC-23)
incidentsOpsRouter.get(
  '/',
  wrap(async (req, res) => {
    const q = req.query as Record<string, unknown>;
    const hubId = optional(requireString)(q, 'hubId', { trim: true, min: 1 });
    const resourceId = optional(requireString)(q, 'resourceId', { trim: true, min: 1 });
    const vehicleClass = optional(requireEnum)(q, 'vehicleClass', VEHICLE_CLASSES);
    const category = optional(requireEnum)(q, 'category', INCIDENT_CATEGORIES);
    const status = optional(requireEnum)(q, 'status', INCIDENT_STATUSES);
    const from = optional(requireIsoDate)(q, 'from');
    const to = optional(requireIsoDate)(q, 'to');
    if (from && to && from.getTime() > to.getTime()) {
      throw badRequest('to must be on or after from.', 'to');
    }
    const { limit, cursor } = parseListQuery(q);

    const result = await listIncidents(
      { hubId, resourceId, vehicleClass, category, status, from, to },
      { limit, cursor },
    );
    res.status(200).json(result);
  }),
);

// GET /api/ops/incidents/:id (UC-23)
incidentsOpsRouter.get(
  '/:id',
  wrap(async (req, res) => {
    const id = requireString(req.params as Record<string, unknown>, 'id', {
      trim: true,
      min: 1,
    });
    const detail = await getIncidentDetail(id);
    res.status(200).json(detail);
  }),
);

// POST /api/ops/incidents/:id/start-maintenance (FR-41)
incidentsOpsRouter.post(
  '/:id/start-maintenance',
  wrap(async (req, res) => {
    if (!req.user) throw unauthenticated();
    const id = requireString(req.params as Record<string, unknown>, 'id', {
      trim: true,
      min: 1,
    });
    const body =
      req.body === undefined || req.body === null ? {} : asObject(req.body);
    const notes = optional(requireString)(body, 'notes', {
      trim: true,
      max: OPERATOR_NOTES_MAX,
    });

    const updated = await startMaintenance(req.user, id, notes);
    res.status(200).json(updated);
  }),
);

// POST /api/ops/incidents/:id/resolve (FR-41)
incidentsOpsRouter.post(
  '/:id/resolve',
  wrap(async (req, res) => {
    if (!req.user) throw unauthenticated();
    const id = requireString(req.params as Record<string, unknown>, 'id', {
      trim: true,
      min: 1,
    });
    const body = asObject(req.body);
    const resolutionNotes = requireString(body, 'resolutionNotes', {
      trim: true,
      min: 1,
      max: OPERATOR_NOTES_MAX,
    });

    const resolved = await resolveIncident(req.user, id, resolutionNotes);
    res.status(200).json(resolved);
  }),
);

// Mounted at /api/vehicles (requireAuth + requireRole('STUDENT'))
export const reportFaultRouter = Router();

// POST /api/vehicles/:vehicleId/report-fault (FR-13)
reportFaultRouter.post(
  '/:vehicleId/report-fault',
  wrap(async (req, res) => {
    if (!req.user) throw unauthenticated();
    const vehicleId = requireString(req.params as Record<string, unknown>, 'vehicleId', {
      trim: true,
      min: 1,
    });
    const body = asObject(req.body);
    const category = requireEnum(body, 'category', INCIDENT_CATEGORIES);
    const notes = requireString(body, 'notes', {
      trim: true,
      min: 1,
      max: STUDENT_NOTES_MAX,
    });

    const result = await reportIncident({
      source: 'STUDENT',
      resourceType: 'RENTAL_VEHICLE',
      resourceId: vehicleId,
      category,
      notes,
      reportedById: req.user.id,
    });
    res.status(201).json({
      incidentId: result.incident.id,
      linkedToExisting: result.linkedToExisting,
    });
  }),
);
