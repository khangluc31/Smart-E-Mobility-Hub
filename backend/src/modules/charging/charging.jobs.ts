// Charging interval job and CHARGING_QUEUE_CHANGED event listener (D-02, ARCHITECTURE §9.3).
// Safe to call multiple times: registers the job and listener at most once per process.

import { config } from '../../core/config';
import { events } from '../../core/events';
import { registerJob } from '../../core/scheduler';
import { runScheduler } from './scheduler.service';

export const CHARGING_SCHEDULER_JOB = 'charging.scheduler';

let registered = false;
const inFlightByHub = new Set<string>();
const pendingByHub = new Set<string>();

async function triggerHubScheduler(hubId: string): Promise<void> {
  if (inFlightByHub.has(hubId)) {
    pendingByHub.add(hubId);
    return;
  }

  inFlightByHub.add(hubId);
  try {
    do {
      pendingByHub.delete(hubId);
      await runScheduler(hubId);
    } while (pendingByHub.has(hubId));
  } catch (err) {
    console.error(`[charging.jobs] event-triggered scheduler failed for Hub "${hubId}"`, err);
  } finally {
    inFlightByHub.delete(hubId);
  }
}

export function registerChargingJobs(): void {
  if (registered) return;

  try {
    registerJob(
      CHARGING_SCHEDULER_JOB,
      config.TELEMETRY_INTERVAL_SEC * 1000,
      async (now: Date) => {
        await runScheduler(undefined, now);
      },
    );
  } catch {
    // Already registered in core/scheduler.
  }

  events.on('CHARGING_QUEUE_CHANGED', async ({ hubId }) => {
    await triggerHubScheduler(hubId);
  });

  registered = true;
}
