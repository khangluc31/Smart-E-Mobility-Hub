// Notification routes (CONTRACTS §9). Validates input, calls the service, sends the response.
// No Prisma calls in routes (AGENTS.md §4).

import { Router, type Request, type Response, type NextFunction } from 'express';
import { optional, requireBoolean } from '../../core/errors';
import { parseListQuery } from '../../core/pagination';
import { listNotifications, markAllRead, markRead } from './notifications.service';

type AsyncHandler = (req: Request, res: Response, next: NextFunction) => Promise<void>;
function wrap(fn: AsyncHandler) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };
}

export const notificationsRouter = Router();

// GET /api/notifications — list own notifications with unread count and cursor pagination
notificationsRouter.get(
  '/',
  wrap(async (req, res) => {
    const q = req.query as Record<string, unknown>;
    const unreadOnly = optional(requireBoolean)(q, 'unreadOnly') ?? false;
    const { limit, cursor } = parseListQuery(q);

    const result = await listNotifications(req.user!.id, {
      unreadOnly,
      limit,
      cursor,
    });
    res.status(200).json(result);
  }),
);

// POST /api/notifications/read-all — must be declared BEFORE /:id/read
notificationsRouter.post(
  '/read-all',
  wrap(async (req, res) => {
    await markAllRead(req.user!.id);
    res.status(204).end();
  }),
);

// POST /api/notifications/:id/read — mark one own notification as read
notificationsRouter.post(
  '/:id/read',
  wrap(async (req, res) => {
    await markRead(req.user!.id, req.params.id as string);
    res.status(204).end();
  }),
);
