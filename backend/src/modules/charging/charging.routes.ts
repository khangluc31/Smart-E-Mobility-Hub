// Operator charging engine routes (CONTRACTS §8.2, FR-48, FR-49, FR-50).
// Mounted under /api/ops/charging (requireAuth + requireRole('OPERATOR') applied by ops router).

import { Router, type NextFunction, type Request, type Response } from 'express';
import {
  badRequest,
  optional,
  requireEnum,
  requireString,
  unauthenticated,
} from '../../core/errors';
import { VEHICLE_CLASSES } from '../../types/enums';
import {
  getQueue,
  getSchedule,
  getWeights,
  resetWeights,
  setWeights,
} from './charging.service';

export const chargingOpsRouter = Router();

function requireStrictNumber(source: Record<string, unknown>, field: string): number {
  const val = source[field];
  if (val === undefined || val === null) {
    throw badRequest(`${field} is required.`, field);
  }
  if (typeof val !== 'number' || !Number.isFinite(val)) {
    throw badRequest(`${field} must be a number.`, field);
  }
  if (val < 0) {
    throw badRequest(`${field} must be at least 0.`, field);
  }
  return val;
}

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
    const battery = requireStrictNumber(body, 'battery');
    const urgency = requireStrictNumber(body, 'urgency');
    const waiting = requireStrictNumber(body, 'waiting');
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
