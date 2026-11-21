import dotenv from 'dotenv';
dotenv.config();

import { createApp } from './app';
import { config } from './core/config';
import { startJobs, stopJobs } from './core/scheduler';

const app = createApp();

const server = app.listen(config.PORT, () => {
  console.log(`[server] listening on http://localhost:${config.PORT}`);
  console.log(`[server] JOBS_ENABLED=${config.JOBS_ENABLED}`);
  if (config.JOBS_ENABLED) {
    startJobs();
    console.log('[server] interval jobs started');
  }
});

function shutdown(signal: string): void {
  console.log(`[server] ${signal} received, shutting down`);
  stopJobs();
  server.close(() => process.exit(0));
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
