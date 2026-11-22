import 'dotenv/config'; // must be first: core/config reads process.env at import time

import { createApp } from './app';
import { config } from './core/config';
import { startJobs, stopJobs } from './core/scheduler';
import { registerTelemetryJobs } from './telemetry/telemetry.jobs';

const app = createApp();

registerTelemetryJobs();

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
