// Charging routes: student lifecycle & advance booking routes (CONTRACTS §8.1, FR-20..24)
// and operator engine, dispatch & override routes (CONTRACTS §8.2, FR-48..52).

import { Router, type NextFunction, type Request, type Response } from 'express';
import { config } from '../../core/config';
import {
  badRequest,
  optional,
  requireBoolean,
  requireEnum,
  requireIsoDate,
  requireNumber,
  requireString,
  unauthenticated,
} from '../../core/errors';
import { parseIdempotencyKey } from '../../core/idempotency';
import { CHARGING_OVERRIDE_ACTIONS } from '../../types/charging';
import { CHARGING_VEHICLE_KINDS, VEHICLE_CLASSES } from '../../types/enums';
import { bookAdvanceSlot, checkAvailability } from './advanceBooking.service';
import {
  getQueue,
  getSchedule,
  getWeights,
  resetWeights,
  setWeights,
} from './charging.service';
import { dispatchFleet, overrideQueue } from './chargingOps.service';
import {
  cancelRequest,
  getMine,
  listMine,
  stopSession,
  submitRequest,
} from './chargingRequests.service';

export const chargingRouter = Router();
export const chargingOpsRouter = Router();

function requireStrictNumber(
  source: Record<string, unknown>,
  field: string,
  opts: { min?: number; max?: number; gt?: number } = {},
): number {
  const val = source[field];
  if (val === undefined || val === null) {
    throw badRequest(`${field} is required.`, field);
  }
  if (typeof val !== 'number' || !Number.isFinite(val)) {
    throw badRequest(`${field} must be a number.`, field);
  }
  if (opts.min !== undefined && val < opts.min) {
    throw badRequest(`${field} must be at least ${opts.min}.`, field);
  }
  if (opts.gt !== undefined && val <= opts.gt) {
    throw badRequest(`${field} must be greater than ${opts.gt}.`, field);
  }
  if (opts.max !== undefined && val > opts.max) {
    throw badRequest(`${field} must be at most ${opts.max}.`, field);
  }
  return val;
}

// ---------------------------------------------------------------------------
// Student routes: mounted at /api/charging (requireAuth + requireRole('STUDENT'))
// ---------------------------------------------------------------------------

chargingRouter.get('/availability', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) throw unauthenticated();
    const query = req.query as Record<string, unknown>;
    const hubId = requireString(query, 'hubId', { min: 1, trim: true });
    const privateEvId = requireString(query, 'privateEvId', { min: 1, trim: true });
    const slotStart = requireIsoDate(query, 'slotStart');
    const targetPct = requireNumber(query, 'targetPct', { max: 100 });
    if (targetPct <= 0) {
      throw badRequest('targetPct must be greater than 0.', 'targetPct');
    }
    const data = await checkAvailability(req.user, {
      hubId,
      privateEvId,
      slotStart,
      targetPct,
    });
    res.json(data);
  } catch (err) {
    next(err);
  }
});

chargingRouter.post(
  '/advance-bookings',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) throw unauthenticated();
      const idemKey = parseIdempotencyKey(req.header('Idempotency-Key'));
      const body = (req.body ?? {}) as Record<string, unknown>;
      const privateEvId = requireString(body, 'privateEvId', { min: 1, trim: true });
      const hubId = requireString(body, 'hubId', { min: 1, trim: true });
      const slotStart = requireIsoDate(body, 'slotStart');
      const targetPct = requireStrictNumber(body, 'targetPct', { gt: 0, max: 100 });
      const created = await bookAdvanceSlot(
        req.user,
        { privateEvId, hubId, slotStart, targetPct },
        { idemKey },
      );
      res.status(201).json(created);
    } catch (err) {
      next(err);
    }
  },
);

chargingRouter.post('/requests', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) throw unauthenticated();
    const body = (req.body ?? {}) as Record<string, unknown>;
    const vehicleKind = requireEnum(body, 'vehicleKind', CHARGING_VEHICLE_KINDS);
    const hubId = requireString(body, 'hubId', { min: 1, trim: true });
    const targetPct = requireStrictNumber(body, 'targetPct', { gt: 0, max: 100 });
    const neededBy = optional(requireIsoDate)(body, 'neededBy') ?? null;

    if (vehicleKind === 'PRIVATE') {
      const privateEvId = requireString(body, 'privateEvId', { min: 1, trim: true });
      const desiredTime = optional(requireIsoDate)(body, 'desiredTime');
      const created = await submitRequest(req.user, {
        vehicleKind: 'PRIVATE',
        privateEvId,
        hubId,
        targetPct,
        desiredTime,
        neededBy,
      });
      res.status(201).json(created);
      return;
    }

    const rentalVehicleId = requireString(body, 'rentalVehicleId', { min: 1, trim: true });
    const created = await submitRequest(req.user, {
      vehicleKind: 'RENTAL',
      rentalVehicleId,
      hubId,
      targetPct,
      neededBy,
    });
    res.status(201).json(created);
  } catch (err) {
    next(err);
  }
});

// /requests/mine must be declared before /requests/:id.
chargingRouter.get('/requests/mine', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) throw unauthenticated();
    const query = req.query as Record<string, unknown>;
    const active = optional(requireBoolean)(query, 'active') ?? true;
    const data = await listMine(req.user.id, { active });
    res.json(data);
  } catch (err) {
    next(err);
  }
});

chargingRouter.get('/requests/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) throw unauthenticated();
    const id = requireString(req.params as Record<string, unknown>, 'id', { min: 1, trim: true });
    const data = await getMine(req.user.id, id);
    res.json(data);
  } catch (err) {
    next(err);
  }
});

chargingRouter.post(
  '/requests/:id/stop',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) throw unauthenticated();
      const id = requireString(req.params as Record<string, unknown>, 'id', { min: 1, trim: true });
      const data = await stopSession(req.user.id, id);
      res.json(data);
    } catch (err) {
      next(err);
    }
  },
);

chargingRouter.post(
  '/requests/:id/cancel',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) throw unauthenticated();
      const id = requireString(req.params as Record<string, unknown>, 'id', { min: 1, trim: true });
      const data = await cancelRequest(req.user.id, id);
      res.json(data);
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// Operator routes: mounted at /api/ops/charging (requireAuth + requireRole('OPERATOR'))
// ---------------------------------------------------------------------------

chargingOpsRouter.get('/queue', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const query = req.query as Record<string, unknown>;
    const hubId = requireString(query, 'hubId', { min: 1, trim: true });
    const vehicleClass = optional(requireEnum)(query, 'vehicleClass', VEHICLE_CLASSES);
    const data = await getQueue({ hubId, vehicleClass });
    res.json(data);
  } catch (err) {
    next(err);
  }
});

chargingOpsRouter.get('/schedule', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const query = req.query as Record<string, unknown>;
    const hubId = optional(requireString)(query, 'hubId', { min: 1, trim: true });
    const data = await getSchedule({ hubId });
    res.json(data);
  } catch (err) {
    next(err);
  }
});

chargingOpsRouter.get('/weights', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await getWeights();
    res.json(data);
  } catch (err) {
    next(err);
  }
});

chargingOpsRouter.put('/weights', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) throw unauthenticated();
    const body = (req.body ?? {}) as Record<string, unknown>;
    const battery = requireStrictNumber(body, 'battery', { min: 0 });
    const urgency = requireStrictNumber(body, 'urgency', { min: 0 });
    const waiting = requireStrictNumber(body, 'waiting', { min: 0 });
    const data = await setWeights(req.user, { battery, urgency, waiting });
    res.json(data);
  } catch (err) {
    next(err);
  }
});

chargingOpsRouter.post(
  '/weights/reset',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) throw unauthenticated();
      const data = await resetWeights(req.user);
      res.json(data);
    } catch (err) {
      next(err);
    }
  },
);

chargingOpsRouter.post('/dispatch', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) throw unauthenticated();
    const body = (req.body ?? {}) as Record<string, unknown>;
    const hubId = requireString(body, 'hubId', { min: 1, trim: true });
    const targetPct =
      body['targetPct'] !== undefined && body['targetPct'] !== null
        ? requireStrictNumber(body, 'targetPct', { gt: 0, max: 100 })
        : undefined;
    const allLowBattery = optional(requireBoolean)(body, 'allLowBattery');
    const rentalVehicleId = optional(requireString)(body, 'rentalVehicleId', {
      min: 1,
      trim: true,
    });

    if (allLowBattery === true && rentalVehicleId !== undefined) {
      throw badRequest(
        'Provide either rentalVehicleId or allLowBattery: true, not both.',
        'allLowBattery',
      );
    }

    if (allLowBattery === true) {
      const data = await dispatchFleet(req.user, { hubId, allLowBattery: true, targetPct });
      res.status(201).json(data);
      return;
    }

    if (rentalVehicleId !== undefined) {
      const data = await dispatchFleet(req.user, { hubId, rentalVehicleId, targetPct });
      res.status(201).json(data);
      return;
    }

    throw badRequest('Either rentalVehicleId or allLowBattery: true is required.', 'rentalVehicleId');
  } catch (err) {
    next(err);
  }
});

chargingOpsRouter.post('/override', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) throw unauthenticated();
    const body = (req.body ?? {}) as Record<string, unknown>;
    const action = requireEnum(body, 'action', CHARGING_OVERRIDE_ACTIONS);
    const requestId = requireString(body, 'requestId', { min: 1, trim: true });
    const reason = requireString(body, 'reason', {
      min: config.OVERRIDE_REASON_MIN_CHARS,
      trim: true,
    });
    const otherRequestId =
      action === 'SWAP'
        ? requireString(body, 'otherRequestId', { min: 1, trim: true })
        : undefined;

    if (action === 'SWAP' && otherRequestId === requestId) {
      throw badRequest('otherRequestId must be different from requestId.', 'otherRequestId');
    }

    const data = await overrideQueue(req.user, {
      action,
      requestId,
      otherRequestId,
      reason,
    });
    res.json(data);
  } catch (err) {
    next(err);
  }
});
