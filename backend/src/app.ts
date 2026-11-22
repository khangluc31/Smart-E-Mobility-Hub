import express, { Router, type Request, type Response } from 'express';
import cors from 'cors';
import { config } from './core/config';
import { db } from './core/db';
import { requireAuth, requireRole } from './core/auth';
import { errorHandler, notFoundHandler } from './core/errorHandler';
import { hubsRouter } from './modules/hubs/hubs.routes';
import { telemetryOpsRouter, telemetryRouter } from './telemetry/telemetry.routes';

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

  // Module routers — created per createApp() call so tests don't stack mounts.
  const api = Router();
  const ops = Router();

  // Telemetry ingestion (CONTRACTS §14) — X-Telemetry-Key header, no JWT.
  app.use('/api/telemetry', telemetryRouter);

  ops.use('/telemetry', telemetryOpsRouter);
  api.use('/hubs', requireAuth, hubsRouter);

  app.use('/api/ops', requireAuth, requireRole('OPERATOR'), ops);
  app.use('/api', api);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
