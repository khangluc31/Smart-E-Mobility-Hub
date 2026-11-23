import express, { Router, type Request, type Response } from 'express';
import cors from 'cors';
import { config } from './core/config';
import { db } from './core/db';
import { requireAuth, requireRole } from './core/auth';
import { errorHandler, notFoundHandler } from './core/errorHandler';
import { authRouter } from './modules/auth/auth.routes';
import { hubsRouter } from './modules/hubs/hubs.routes';
import { notificationsRouter } from './modules/notifications/notifications.routes';
import { privateEvsRouter } from './modules/private-evs/privateEvs.routes';
import {
  parkingReservationsRouter,
  parkingRouter,
  vehicleReservationsRouter,
  vehiclesRouter,
} from './modules/reservations/reservations.routes';
import { telemetryOpsRouter, telemetryRouter } from './telemetry/telemetry.routes';

export function createApp(opts?: { corsOrigins?: readonly string[] }) {
  const app = express();
  const allowedOrigins = opts?.corsOrigins ?? config.CORS_ORIGINS;

  app.use(express.json());
  app.use(
    cors({
      origin: (origin, callback) => {
        if (!origin || allowedOrigins.includes(origin)) {
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
  api.use('/auth', authRouter);
  api.use('/hubs', requireAuth, hubsRouter);
  api.use('/notifications', requireAuth, notificationsRouter);
  api.use('/vehicles', requireAuth, requireRole('STUDENT'), vehiclesRouter);
  api.use(
    '/vehicle-reservations',
    requireAuth,
    requireRole('STUDENT'),
    vehicleReservationsRouter,
  );
  api.use('/parking', requireAuth, requireRole('STUDENT'), parkingRouter);
  api.use(
    '/parking-reservations',
    requireAuth,
    requireRole('STUDENT'),
    parkingReservationsRouter,
  );
  api.use('/private-evs', requireAuth, requireRole('STUDENT'), privateEvsRouter);

  app.use('/api/ops', requireAuth, requireRole('OPERATOR'), ops);
  app.use('/api', api);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
