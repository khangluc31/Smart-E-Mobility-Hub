// Hub routes (CONTRACTS §3). Validates input, calls the service, sends the response.

import { Router, type Request, type Response, type NextFunction } from 'express';
import { requireEnum, requireIsoDate, optional, badRequest } from '../../core/errors';
import { VEHICLE_CLASSES } from '../../types/enums';
import { ALTERNATIVE_NEEDS } from '../../types/hubs';
import { listHubs, getHub, alternativeHubs } from './hubs.service';

type AsyncHandler = (req: Request, res: Response, next: NextFunction) => Promise<void>;
function wrap(fn: AsyncHandler) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };
}

export const hubsRouter = Router();

hubsRouter.get(
  '/',
  wrap(async (_req, res) => {
    const hubs = await listHubs();
    res.json(hubs);
  }),
);

hubsRouter.get(
  '/alternatives',
  wrap(async (req, res) => {
    const q = req.query as Record<string, unknown>;
    const need = requireEnum(q, 'need', ALTERNATIVE_NEEDS);
    const vehicleClass = requireEnum(q, 'vehicleClass', VEHICLE_CLASSES);
    const excludeHubId = optional(function requireStr(s: Record<string, unknown>, f: string) {
      const v = s[f];
      if (typeof v !== 'string' || v === '') throw badRequest(`${f} must be a non-empty string.`, f);
      return v;
    })(q, 'excludeHubId');
    const from = optional(requireIsoDate)(q, 'from');
    const to = optional(requireIsoDate)(q, 'to');

    if ((from && !to) || (!from && to)) {
      throw badRequest('Both from and to are required when filtering by time window.', from ? 'to' : 'from');
    }
    if (from && to && to <= from) {
      throw badRequest('to must be after from.', 'to');
    }

    const alternatives = await alternativeHubs({ need, vehicleClass, excludeHubId, from: from ?? undefined, to: to ?? undefined });
    res.json(alternatives);
  }),
);

hubsRouter.get(
  '/:hubId',
  wrap(async (req, res) => {
    const hub = await getHub(req.params.hubId as string);
    res.json(hub);
  }),
);
