// Monitoring & alert routes (CONTRACTS §10, FR-31..FR-35).
// Mounted under /api/ops (requireAuth + requireRole('OPERATOR')). No Prisma in routes (AGENTS.md §4).

import { Router, type NextFunction, type Request, type Response } from 'express';
import {
  badRequest,
  optional,
  requireEnum,
  requireString,
  unauthenticated,
} from '../../core/errors';
import { parseListQuery } from '../../core/pagination';
import { ALERT_STATUSES, ALERT_TYPES } from '../../types/enums';
import {
  acknowledgeAlert,
  ALERT_NOTE_MAX,
  dismissAlert,
  getDashboard,
  getOpsHubDetail,
  listAlerts,
} from './monitoring.service';

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

export const monitoringOpsRouter = Router();

// GET /api/ops/dashboard (FR-31)
monitoringOpsRouter.get(
  '/dashboard',
  wrap(async (_req, res) => {
    const dashboard = await getDashboard();
    res.status(200).json(dashboard);
  }),
);

// GET /api/ops/hubs/:hubId (FR-32)
monitoringOpsRouter.get(
  '/hubs/:hubId',
  wrap(async (req, res) => {
    const hubId = requireString(req.params as Record<string, unknown>, 'hubId', {
      trim: true,
      min: 1,
    });
    const detail = await getOpsHubDetail(hubId);
    res.status(200).json(detail);
  }),
);

// GET /api/ops/alerts (FR-33, FR-35)
monitoringOpsRouter.get(
  '/alerts',
  wrap(async (req, res) => {
    const q = req.query as Record<string, unknown>;
    const status = optional(requireEnum)(q, 'status', ALERT_STATUSES);
    const type = optional(requireEnum)(q, 'type', ALERT_TYPES);
    const hubId = optional(requireString)(q, 'hubId', { trim: true, min: 1 });
    const { limit, cursor } = parseListQuery(q);

    const list = await listAlerts({ status, type, hubId }, { limit, cursor });
    res.status(200).json(list);
  }),
);

// POST /api/ops/alerts/:id/acknowledge (FR-34)
monitoringOpsRouter.post(
  '/alerts/:id/acknowledge',
  wrap(async (req, res) => {
    if (!req.user) throw unauthenticated();
    const id = requireString(req.params as Record<string, unknown>, 'id', {
      trim: true,
      min: 1,
    });
    const body = req.body === undefined || req.body === null ? {} : asObject(req.body);
    const note = optional(requireString)(body, 'note', {
      trim: true,
      max: ALERT_NOTE_MAX,
    });

    const updated = await acknowledgeAlert(req.user, id, note);
    res.status(200).json(updated);
  }),
);

// POST /api/ops/alerts/:id/dismiss (FR-34)
monitoringOpsRouter.post(
  '/alerts/:id/dismiss',
  wrap(async (req, res) => {
    if (!req.user) throw unauthenticated();
    const id = requireString(req.params as Record<string, unknown>, 'id', {
      trim: true,
      min: 1,
    });
    const body = req.body === undefined || req.body === null ? {} : asObject(req.body);
    const note = optional(requireString)(body, 'note', {
      trim: true,
      max: ALERT_NOTE_MAX,
    });

    const updated = await dismissAlert(req.user, id, note);
    res.status(200).json(updated);
  }),
);
