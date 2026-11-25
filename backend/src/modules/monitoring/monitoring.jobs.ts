// Monitoring interval job and coalesced post-commit event listeners
// (D-02, ARCHITECTURE §2, §4.6, §8). Safe to call multiple times per process.

import { config } from '../../core/config';
import { events } from '../../core/events';
import { registerJob } from '../../core/scheduler';
import { evaluateAllHubs, evaluateHub } from './monitoring.service';

export const MONITORING_EVALUATE_JOB = 'monitoring.evaluate';

let registered = false;
const inFlightByHub = new Set<string>();
const pendingByHub = new Set<string>();

async function triggerHubEvaluation(hubId: string): Promise<void> {
  if (inFlightByHub.has(hubId)) {
    pendingByHub.add(hubId);
    return;
  }

  inFlightByHub.add(hubId);
  try {
    do {
      pendingByHub.delete(hubId);
      await evaluateHub(hubId);
    } while (pendingByHub.has(hubId));
  } catch (err) {
    console.error(`[monitoring.jobs] event-triggered evaluation failed for Hub "${hubId}"`, err);
  } finally {
    inFlightByHub.delete(hubId);
  }
}

export function registerMonitoringJobs(): void {
  if (registered) return;

  try {
    registerJob(
      MONITORING_EVALUATE_JOB,
      config.TELEMETRY_INTERVAL_SEC * 1000,
      async (now: Date) => {
        await evaluateAllHubs(now);
      },
    );
  } catch {
    // Already registered in core/scheduler.
  }

  events.on('TELEMETRY_INGESTED', async ({ hubId }) => {
    await triggerHubEvaluation(hubId);
  });
  events.on('RESOURCE_WITHDRAWN', async ({ hubId }) => {
    await triggerHubEvaluation(hubId);
  });
  events.on('RESERVATION_CHANGED', async ({ hubId }) => {
    await triggerHubEvaluation(hubId);
  });

  registered = true;
}
