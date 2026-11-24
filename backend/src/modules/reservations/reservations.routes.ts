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
import { parseListQuery } from '../../core/pagination';
import { RENTAL_VEHICLE_TYPES, VEHICLE_CLASSES } from '../../types/enums';
import { HISTORY_STATUSES, HISTORY_TYPES } from '../../types/reservations';
import { getHistory } from './history.service';
import { recommend, searchVehicles } from './vehicles.service';
import {
  cancelReservation,
  changeVehicle,
  getCurrent,
  pickUp,
  reserveVehicle,
  returnVehicle,
  type ReturnRequestChargingInput,
} from './vehicleReservations.service';
import {
  cancelParking,
  changeWindow,
  claimParking,
  getAvailability,
  leaveParking,
  reserveParking,
} from './parkingReservations.service';

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

// POST /api/vehicle-reservations/:id/pickup (FR-11)
vehicleReservationsRouter.post(
  '/:id/pickup',
  wrap(async (req, res) => {
    const active = await pickUp(req.user!.id, req.params.id as string);
    res.status(200).json(active);
  }),
);

function parseReturnRequestCharging(
  raw: unknown,
  now: Date,
): ReturnRequestChargingInput | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw badRequest('requestCharging must be a JSON object.', 'requestCharging', [
      'Provide requestCharging as an object with targetPct (and optional neededBy), or omit it.',
    ]);
  }
  const obj = raw as Record<string, unknown>;
  const targetRaw = obj['targetPct'];
  if (targetRaw === undefined || targetRaw === null) {
    throw badRequest('requestCharging.targetPct is required.', 'requestCharging.targetPct');
  }
  if (typeof targetRaw !== 'number' || !Number.isFinite(targetRaw)) {
    throw badRequest('requestCharging.targetPct must be a number.', 'requestCharging.targetPct');
  }
  if (targetRaw <= 0 || targetRaw > 100) {
    throw badRequest(
      'requestCharging.targetPct must be greater than 0 and at most 100.',
      'requestCharging.targetPct',
    );
  }

  let neededBy: Date | undefined;
  if (obj['neededBy'] !== undefined && obj['neededBy'] !== null) {
    try {
      neededBy = requireIsoDate(obj, 'neededBy');
    } catch {
      throw badRequest(
        'requestCharging.neededBy must be a valid ISO-8601 date.',
        'requestCharging.neededBy',
      );
    }
    if (neededBy.getTime() <= now.getTime()) {
      throw badRequest(
        'requestCharging.neededBy must be in the future.',
        'requestCharging.neededBy',
      );
    }
  }

  return { targetPct: targetRaw, neededBy };
}

// POST /api/vehicle-reservations/:id/return (FR-12, FR-19, D-13)
vehicleReservationsRouter.post(
  '/:id/return',
  wrap(async (req, res) => {
    const body = asObject(req.body);
    const hubId = requireString(body, 'hubId', { trim: true, min: 1 });
    const now = new Date();
    const requestCharging = parseReturnRequestCharging(body['requestCharging'], now);

    const result = await returnVehicle(
      req.user!.id,
      req.params.id as string,
      {
        hubId,
        requestCharging,
      },
      now,
    );
    res.status(200).json(result);
  }),
);

// ---------------------------------------------------------------------------
// Parking availability & parking reservations (CONTRACTS §5, FR-14..FR-18)
// ---------------------------------------------------------------------------

export const parkingRouter = Router();

// GET /api/parking/availability (FR-14)
parkingRouter.get(
  '/availability',
  wrap(async (req, res) => {
    const q = req.query as Record<string, unknown>;
    const hubId = requireString(q, 'hubId', { trim: true, min: 1 });
    const vehicleClass = requireEnum(q, 'vehicleClass', VEHICLE_CLASSES);
    const from = requireIsoDate(q, 'from');
    const to = requireIsoDate(q, 'to');

    const result = await getAvailability({ hubId, vehicleClass, from, to });
    res.status(200).json(result);
  }),
);

export const parkingReservationsRouter = Router();

// POST /api/parking-reservations (FR-15, BR-10, BR-13, NFR-08)
parkingReservationsRouter.post(
  '/',
  wrap(async (req, res) => {
    const body = asObject(req.body);
    const hubId = requireString(body, 'hubId', { trim: true, min: 1 });
    const vehicleClass = requireEnum(body, 'vehicleClass', VEHICLE_CLASSES);
    const privateEvId = optional(requireString)(body, 'privateEvId', { trim: true, min: 1 });
    const windowStart = requireIsoDate(body, 'windowStart');
    const windowEnd = requireIsoDate(body, 'windowEnd');
    const idemKey = parseIdempotencyKey(req.headers['idempotency-key']);

    const reservation = await reserveParking(
      req.user!.id,
      { hubId, vehicleClass, privateEvId, windowStart, windowEnd },
      { idemKey },
    );
    res.status(201).json(reservation);
  }),
);

// POST /api/parking-reservations/:id/cancel (FR-16)
parkingReservationsRouter.post(
  '/:id/cancel',
  wrap(async (req, res) => {
    const cancelled = await cancelParking(req.user!.id, req.params.id as string);
    res.status(200).json(cancelled);
  }),
);

// PATCH /api/parking-reservations/:id (FR-17)
parkingReservationsRouter.patch(
  '/:id',
  wrap(async (req, res) => {
    const body = asObject(req.body);
    const windowStart = requireIsoDate(body, 'windowStart');
    const windowEnd = requireIsoDate(body, 'windowEnd');

    const updated = await changeWindow(req.user!.id, req.params.id as string, {
      windowStart,
      windowEnd,
    });
    res.status(200).json(updated);
  }),
);

// POST /api/parking-reservations/:id/claim (FR-18)
parkingReservationsRouter.post(
  '/:id/claim',
  wrap(async (req, res) => {
    const claimed = await claimParking(req.user!.id, req.params.id as string);
    res.status(200).json(claimed);
  }),
);

// POST /api/parking-reservations/:id/leave (FR-18)
parkingReservationsRouter.post(
  '/:id/leave',
  wrap(async (req, res) => {
    const completed = await leaveParking(req.user!.id, req.params.id as string);
    res.status(200).json(completed);
  }),
);

// ---------------------------------------------------------------------------
// User history (CONTRACTS §6, FR-10, UC-07 E1)
// ---------------------------------------------------------------------------

export const meRouter = Router();

// GET /api/me/history — always scoped to req.user.id; any userId query param is ignored
meRouter.get(
  '/history',
  wrap(async (req, res) => {
    const q = req.query as Record<string, unknown>;
    const type = optional(requireEnum)(q, 'type', HISTORY_TYPES) ?? 'all';
    const status = optional(requireEnum)(q, 'status', HISTORY_STATUSES);
    const { limit, cursor } = parseListQuery(q);

    const page = await getHistory(req.user!.id, {
      type,
      status,
      limit,
      cursor,
    });
    res.status(200).json(page);
  }),
);
