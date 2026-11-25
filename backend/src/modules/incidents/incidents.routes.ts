// Incident routes: operator incident reporting (CONTRACTS §11, FR-37) and student vehicle
// fault reporting (CONTRACTS §4, FR-13). Validates input, calls the service, sends the response.
// No Prisma in routes (AGENTS.md §4).

import { Router, type NextFunction, type Request, type Response } from 'express';
import {
  badRequest,
  requireEnum,
  requireString,
  unauthenticated,
} from '../../core/errors';
import {
  INCIDENT_CATEGORIES,
  INCIDENT_RESOURCE_TYPES,
  VEHICLE_CLASSES,
} from '../../types/enums';
import {
  OPERATOR_NOTES_MAX,
  reportIncident,
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
