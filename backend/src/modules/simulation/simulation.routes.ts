// Operator What-if Simulation routes (CONTRACTS §13, FR-53–FR-59).
// Mounted under /api/ops/simulation (behind requireAuth + requireRole('OPERATOR')).

import { Router, type NextFunction, type Request, type Response } from 'express';
import {
  optional,
  requireBoolean,
  requireInt,
  requireString,
} from '../../core/errors';
import {
  applyRecommendation,
  compareRuns,
  createScenario,
  dismissRecommendation,
  getRunDetail,
  getScenario,
  listRuns,
  listScenarios,
  listTemplates,
  previewRecommendation,
  saveRun,
  startRun,
  unsaveRun,
} from './simulation.service';

export const simulationOpsRouter = Router();

// GET /api/ops/simulation/templates (FR-54)
simulationOpsRouter.get('/templates', (_req: Request, res: Response) => {
  res.json(listTemplates());
});

// POST /api/ops/simulation/scenarios (FR-54, UC-29)
simulationOpsRouter.post(
  '/scenarios',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const name = requireString(body, 'name', { trim: true, min: 1 });
      const horizonH = requireInt(body, 'horizonH');
      const seed = optional(requireInt)(body, 'seed');
      const scenario = await createScenario(
        { id: req.user!.id, role: req.user!.role },
        { name, horizonH, seed, conditions: body['conditions'] },
      );
      res.status(201).json(scenario);
    } catch (err) {
      next(err);
    }
  },
);

// GET /api/ops/simulation/scenarios (UC-29 A1)
simulationOpsRouter.get(
  '/scenarios',
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const items = await listScenarios();
      res.json(items);
    } catch (err) {
      next(err);
    }
  },
);

// GET /api/ops/simulation/scenarios/:id (UC-29)
simulationOpsRouter.get(
  '/scenarios/:id',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const scenario = await getScenario(String(req.params['id']));
      res.json(scenario);
    } catch (err) {
      next(err);
    }
  },
);

// POST /api/ops/simulation/runs (FR-53, FR-55) -> 202 RUNNING
simulationOpsRouter.post(
  '/runs',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const scenarioId = requireString(body, 'scenarioId', { trim: true, min: 1 });
      const run = await startRun({ id: req.user!.id, role: req.user!.role }, scenarioId);
      res.status(202).json(run);
    } catch (err) {
      next(err);
    }
  },
);

// GET /api/ops/simulation/runs (FR-59)
simulationOpsRouter.get(
  '/runs',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const q = req.query as Record<string, unknown>;
      const saved = optional(requireBoolean)(q, 'saved');
      const items = await listRuns({ saved });
      res.json(items);
    } catch (err) {
      next(err);
    }
  },
);

// GET /api/ops/simulation/runs/:id (FR-55, FR-56, FR-57)
simulationOpsRouter.get(
  '/runs/:id',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const detail = await getRunDetail(String(req.params['id']));
      res.json(detail);
    } catch (err) {
      next(err);
    }
  },
);

// POST /api/ops/simulation/runs/:id/save (FR-59)
simulationOpsRouter.post(
  '/runs/:id/save',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const name = requireString(body, 'name', { trim: true, min: 1 });
      const run = await saveRun(String(req.params['id']), name);
      res.json(run);
    } catch (err) {
      next(err);
    }
  },
);

// DELETE /api/ops/simulation/runs/:id/save (UC-34 A1) -> 204
simulationOpsRouter.delete(
  '/runs/:id/save',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await unsaveRun(String(req.params['id']));
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  },
);

// GET /api/ops/simulation/recommendations/:id/preview (FR-58, D-20)
simulationOpsRouter.get(
  '/recommendations/:id/preview',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const preview = await previewRecommendation(String(req.params['id']));
      res.json(preview);
    } catch (err) {
      next(err);
    }
  },
);

// POST /api/ops/simulation/recommendations/:id/apply (FR-58, UC-33)
simulationOpsRouter.post(
  '/recommendations/:id/apply',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const confirmToken = requireString(body, 'confirmToken', { trim: true, min: 1 });
      const result = await applyRecommendation(
        { id: req.user!.id, role: req.user!.role },
        String(req.params['id']),
        confirmToken,
      );
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

// POST /api/ops/simulation/recommendations/:id/dismiss (UC-33 A1)
simulationOpsRouter.post(
  '/recommendations/:id/dismiss',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const rec = await dismissRecommendation(
        { id: req.user!.id, role: req.user!.role },
        String(req.params['id']),
      );
      res.json(rec);
    } catch (err) {
      next(err);
    }
  },
);

// GET /api/ops/simulation/compare?runA=&runB= (FR-59)
simulationOpsRouter.get(
  '/compare',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const q = req.query as Record<string, unknown>;
      const runA = requireString(q, 'runA', { trim: true, min: 1 });
      const runB = requireString(q, 'runB', { trim: true, min: 1 });
      const comparison = await compareRuns(runA, runB);
      res.json(comparison);
    } catch (err) {
      next(err);
    }
  },
);
