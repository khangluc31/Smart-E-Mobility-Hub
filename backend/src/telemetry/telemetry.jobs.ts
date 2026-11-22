// Telemetry interval job registration (ARCHITECTURE §2, D-02).
// Safe to call multiple times: registers 'telemetry.generate' at most once per process.

import { config } from '../core/config';
import { registerJob } from '../core/scheduler';
import { generateAll } from './generator';

export const TELEMETRY_GENERATE_JOB = 'telemetry.generate';

let registered = false;

export function registerTelemetryJobs(): void {
  if (registered) return;
  try {
    registerJob(
      TELEMETRY_GENERATE_JOB,
      config.TELEMETRY_INTERVAL_SEC * 1000,
      async (now: Date) => {
        await generateAll(now);
      },
    );
  } catch {
    // Already registered in core/scheduler.
  }
  registered = true;
}
