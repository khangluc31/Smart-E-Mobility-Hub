import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { config } from './core/config';
import { db } from './core/db';

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

  // --- Health check (CONTRACTS §2, AC-4/5) ---
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

  // --- 404 handler (ARCHITECTURE §4.4 shape, AC-6) ---
  app.use((_req: Request, res: Response) => {
    res.status(404).json({
      error: {
        code: 'NOT_FOUND',
        message: `Route not found.`,
        nextActions: ['Check the URL and HTTP method.', 'See docs/CONTRACTS.md for valid endpoints.'],
      },
    });
  });

  // --- Global error handler (ARCHITECTURE §4.4 shape) ---
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error('[error]', err);
    res.status(500).json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred.',
        nextActions: ['Retry the request.', 'If the problem persists, contact the team.'],
      },
    });
  });

  return app;
}
