// Operator Redistribution routes (CONTRACTS §12, FR-43–FR-47).
// Mounted under /api/ops/redistribution (behind requireAuth + requireRole('OPERATOR')).

import { Router, type NextFunction, type Request, type Response } from 'express';
import {
  optional,
  requireBoolean,
  requireEnum,
  requireInt,
  requireString,
} from '../../core/errors';
import { parseListQuery } from '../../core/pagination';
import {
  REDISTRIBUTION_STATUSES,
  RENTAL_VEHICLE_TYPES,
  VEHICLE_CLASSES,
} from '../../types/enums';
import {
  approveRedistributionTask,
  cancelRedistributionTask,
  completeRedistributionTask,
  createRedistributionTask,
  failRedistributionTask,
  getRedistributionTask,
  listImbalances,
  listRedistributionTasks,
  previewRedistribution,
  startRedistributionTask,
} from './redistribution.service';

export const redistributionOpsRouter = Router();

// GET /api/ops/redistribution/imbalances (FR-43)
redistributionOpsRouter.get(
  '/imbalances',
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const items = await listImbalances();
      res.json(items);
    } catch (err) {
      next(err);
    }
  },
);

// GET /api/ops/redistribution/preview (FR-45, FR-46)
redistributionOpsRouter.get(
  '/preview',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const q = req.query as Record<string, unknown>;
      const sourceHubId = requireString(q, 'sourceHubId', { trim: true, min: 1 });
      const destHubId = requireString(q, 'destHubId', { trim: true, min: 1 });
      const vehicleClass = requireEnum(q, 'vehicleClass', VEHICLE_CLASSES);
      const vehicleType = optional(requireEnum)(q, 'vehicleType', RENTAL_VEHICLE_TYPES);
      const count = requireInt(q, 'count', { min: 1 });

      const preview = await previewRedistribution({
        sourceHubId,
        destHubId,
        vehicleClass,
        vehicleType,
        count,
      });
      res.json(preview);
    } catch (err) {
      next(err);
    }
  },
);

// POST /api/ops/redistribution/tasks (FR-44, FR-45, FR-46)
redistributionOpsRouter.post(
  '/tasks',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const sourceHubId = requireString(body, 'sourceHubId', { trim: true, min: 1 });
      const destHubId = requireString(body, 'destHubId', { trim: true, min: 1 });
      const vehicleClass = requireEnum(body, 'vehicleClass', VEHICLE_CLASSES);
      const vehicleType = optional(requireEnum)(body, 'vehicleType', RENTAL_VEHICLE_TYPES);
      const count = requireInt(body, 'count', { min: 1 });
      const override = optional(requireBoolean)(body, 'override');
      const reason = optional(requireString)(body, 'reason');

      const task = await createRedistributionTask(
        { id: req.user!.id, role: req.user!.role },
        { sourceHubId, destHubId, vehicleClass, vehicleType, count, override, reason },
      );
      res.status(201).json(task);
    } catch (err) {
      next(err);
    }
  },
);

// GET /api/ops/redistribution/tasks (FR-47)
redistributionOpsRouter.get(
  '/tasks',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const q = req.query as Record<string, unknown>;
      const status = optional(requireEnum)(q, 'status', REDISTRIBUTION_STATUSES);
      const page = parseListQuery(q);
      const list = await listRedistributionTasks({ status }, page);
      res.json(list);
    } catch (err) {
      next(err);
    }
  },
);

// GET /api/ops/redistribution/tasks/:id (FR-47)
redistributionOpsRouter.get(
  '/tasks/:id',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const task = await getRedistributionTask(String(req.params['id']));
      res.json(task);
    } catch (err) {
      next(err);
    }
  },
);

// POST /api/ops/redistribution/tasks/:id/approve (FR-47)
redistributionOpsRouter.post(
  '/tasks/:id/approve',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const task = await approveRedistributionTask(
        { id: req.user!.id, role: req.user!.role },
        String(req.params['id']),
      );
      res.json(task);
    } catch (err) {
      next(err);
    }
  },
);

// POST /api/ops/redistribution/tasks/:id/start (FR-47)
redistributionOpsRouter.post(
  '/tasks/:id/start',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const task = await startRedistributionTask(
        { id: req.user!.id, role: req.user!.role },
        String(req.params['id']),
      );
      res.json(task);
    } catch (err) {
      next(err);
    }
  },
);

// POST /api/ops/redistribution/tasks/:id/complete (FR-47)
redistributionOpsRouter.post(
  '/tasks/:id/complete',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const task = await completeRedistributionTask(
        { id: req.user!.id, role: req.user!.role },
        String(req.params['id']),
      );
      res.json(task);
    } catch (err) {
      next(err);
    }
  },
);

// POST /api/ops/redistribution/tasks/:id/fail (FR-47)
redistributionOpsRouter.post(
  '/tasks/:id/fail',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const reason = requireString(body, 'reason', { trim: true, min: 1 });
      const task = await failRedistributionTask(
        { id: req.user!.id, role: req.user!.role },
        String(req.params['id']),
        reason,
      );
      res.json(task);
    } catch (err) {
      next(err);
    }
  },
);

// POST /api/ops/redistribution/tasks/:id/cancel (UC-25 A1)
redistributionOpsRouter.post(
  '/tasks/:id/cancel',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const reason = requireString(body, 'reason', { trim: true, min: 1 });
      const task = await cancelRedistributionTask(
        { id: req.user!.id, role: req.user!.role },
        String(req.params['id']),
        reason,
      );
      res.json(task);
    } catch (err) {
      next(err);
    }
  },
);
