// Reservation interval job registration (ARCHITECTURE §2 / §6.3, BR-03, D-02).
// Safe to call multiple times: registers 'reservations.tick' at most once per process.

import { config } from '../../core/config';
import { registerJob } from '../../core/scheduler';
import { expireVehicleHolds } from './vehicleReservations.service';
import { parkingTick } from './parkingReservations.service';

export const RESERVATIONS_TICK_JOB = 'reservations.tick';

let registered = false;

export function registerReservationJobs(): void {
  if (registered) return;
  try {
    registerJob(
      RESERVATIONS_TICK_JOB,
      config.TELEMETRY_INTERVAL_SEC * 1000,
      async (now: Date) => {
        await expireVehicleHolds(now);
        await parkingTick(now);
      },
    );
  } catch {
    // Already registered in core/scheduler.
  }
  registered = true;
}
