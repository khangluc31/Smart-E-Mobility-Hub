import express, { Router, type Request, type Response } from 'express';
import cors from 'cors';
import { config } from './core/config';
import { db } from './core/db';
import { requireAuth, requireRole } from './core/auth';
import { errorHandler, notFoundHandler } from './core/errorHandler';

// Routers later tickets attach routes to. The ops router already has the auth +
// OPERATOR guards applied at mount (FR-61), so ops routes never re-add them.
export const apiRouter = Router();
export const opsRouter = Router();

export function createApp() {
  const app = express();

  app.use(express.json());
  app.use(
    cors({
      origin: (origin, callback) => {
        if (!origin || origin === config.CORS_ORIGIN) {
          callback(null, true);
        } else {
          callback(null, false);
        }
      },
    }),
  );

  // Health check (CONTRACTS §2) — public, kept inline.
  app.get('/api/health', async (_req: Request, res: Response) => {
    try {
      await db.$queryRawUnsafe('SELECT 1');
      res.json({
        status: 'ok',
        db: 'ok',
        jobsEnabled: config.JOBS_ENABLED,
        serverNow: new Date().toISOString(),
      });
    } catch {
      res.status(503).json({
        error: {
          code: 'DB_UNAVAILABLE',
          message: 'Cannot reach the database.',
          nextActions: ['Check that Postgres is running and DATABASE_URL is correct.'],
        },
      });
    }
  });

  // Operator routes mount first so the guards run once for every /api/ops/* route.
  app.use('/api/ops', requireAuth, requireRole('OPERATOR'), opsRouter);
  app.use('/api', apiRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
