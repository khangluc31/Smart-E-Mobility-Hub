// Charging routes: student lifecycle routes (CONTRACTS §8.1, FR-20/22/23/24)
// and operator engine routes (CONTRACTS §8.2, FR-48/49/50).

import { Router, type NextFunction, type Request, type Response } from 'express';
import {
  badRequest,
  optional,
  requireBoolean,
  requireEnum,
  requireIsoDate,
  requireString,
  unauthenticated,
} from '../../core/errors';
import { CHARGING_VEHICLE_KINDS, VEHICLE_CLASSES } from '../../types/enums';
import {
  getQueue,
  getSchedule,
  getWeights,
  resetWeights,
  setWeights,
} from './charging.service';
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
