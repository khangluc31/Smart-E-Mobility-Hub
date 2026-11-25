// Read-only Operator Audit Log route (CONTRACTS §15, FR-63, NFR-14).
// Mounted under /api/ops/audit (behind requireAuth + requireRole('OPERATOR')).

import { Router, type NextFunction, type Request, type Response } from 'express';
import { optional, requireIsoDate, requireString } from './errors';
import { parseListQuery } from './pagination';
import { listAuditLogs } from './audit';

export const auditOpsRouter = Router();

auditOpsRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const q = req.query as Record<string, unknown>;
    const entityType = optional(requireString)(q, 'entityType', { trim: true, min: 1 });
    const entityId = optional(requireString)(q, 'entityId', { trim: true, min: 1 });
    const actorId = optional(requireString)(q, 'actorId', { trim: true, min: 1 });
    const action = optional(requireString)(q, 'action', { trim: true, min: 1 });
    const from = optional(requireIsoDate)(q, 'from');
    const to = optional(requireIsoDate)(q, 'to');
    const page = parseListQuery(q);

    const result = await listAuditLogs(
      { entityType, entityId, actorId, action, from, to },
      page,
    );
    res.json(result);
  } catch (err) {
    next(err);
  }
});
