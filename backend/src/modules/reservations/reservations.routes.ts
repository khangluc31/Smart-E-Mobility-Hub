// Vehicle search, recommendation, and reservation routes (CONTRACTS §4).
// Validates input, calls the service, sends the response. No Prisma in routes (AGENTS.md §4).

import { Router, type Request, type Response, type NextFunction } from 'express';
import {
  badRequest,
  optional,
  requireBoolean,
  requireEnum,
  requireIsoDate,
  requireNumber,
  requireString,
} from '../../core/errors';
import { parseIdempotencyKey } from '../../core/idempotency';
import { RENTAL_VEHICLE_TYPES } from '../../types/enums';
import { recommend, searchVehicles } from './vehicles.service';
import {
  cancelReservation,
  changeVehicle,
  getCurrent,
  reserveVehicle,
} from './vehicleReservations.service';

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

export const vehiclesRouter = Router();

// GET /api/vehicles/search (FR-04, BR-02)
vehiclesRouter.get(
  '/search',
  wrap(async (req, res) => {
    const q = req.query as Record<string, unknown>;
    const hubId = optional(requireString)(q, 'hubId', { trim: true, min: 1 });
    const type = optional(requireEnum)(q, 'type', RENTAL_VEHICLE_TYPES);
    const minBattery = optional(requireNumber)(q, 'minBattery', { min: 0, max: 100 });
    const availableOnly = optional(requireBoolean)(q, 'availableOnly') ?? true;

    const vehicles = await searchVehicles({
      hubId,
      type,
      minBattery,
      availableOnly,
    });
    res.status(200).json(vehicles);
  }),
);

// GET /api/vehicles/recommend (FR-05)
vehiclesRouter.get(
  '/recommend',
  wrap(async (req, res) => {
    const q = req.query as Record<string, unknown>;
    const originHubId = requireString(q, 'originHubId', { trim: true, min: 1 });
    const destinationHubId = requireString(q, 'destinationHubId', { trim: true, min: 1 });
    const time = optional(requireIsoDate)(q, 'time');

    const result = await recommend({
      originHubId,
      destinationHubId,
      time,
    });
    res.status(200).json(result);
  }),
);

export const vehicleReservationsRouter = Router();

// POST /api/vehicle-reservations (FR-06, BR-01/02/10, NFR-08)
vehicleReservationsRouter.post(
  '/',
  wrap(async (req, res) => {
    const body = asObject(req.body);
    const vehicleId = requireString(body, 'vehicleId', { trim: true, min: 1 });
    const idemKey = parseIdempotencyKey(req.headers['idempotency-key']);

    const reservation = await reserveVehicle(req.user!.id, vehicleId, idemKey);
    res.status(201).json(reservation);
  }),
);

// GET /api/vehicle-reservations/current (FR-07) — declared BEFORE /:id routes
vehicleReservationsRouter.get(
  '/current',
  wrap(async (req, res) => {
    const current = await getCurrent(req.user!.id);
    res.status(200).json(current);
  }),
);

// POST /api/vehicle-reservations/:id/cancel (FR-08)
vehicleReservationsRouter.post(
  '/:id/cancel',
  wrap(async (req, res) => {
    const cancelled = await cancelReservation(req.user!.id, req.params.id as string);
    res.status(200).json(cancelled);
  }),
);

// PATCH /api/vehicle-reservations/:id (FR-09)
vehicleReservationsRouter.patch(
  '/:id',
  wrap(async (req, res) => {
    const body = asObject(req.body);
    const vehicleId = requireString(body, 'vehicleId', { trim: true, min: 1 });

    const updated = await changeVehicle(req.user!.id, req.params.id as string, vehicleId);
    res.status(200).json(updated);
  }),
);
