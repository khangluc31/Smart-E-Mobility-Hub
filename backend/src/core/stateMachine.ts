// State transition tables (BR-05, D-05, SPEC §4). The only place a status change
// is validated; services call assertTransition before every status write.
// "any→X" is expanded to every source state; same-state (X→X) is never allowed.
import { InvalidStateTransitionError } from './errors';

type TransitionTable = Record<string, readonly string[]>;

export const transitions = {
  rentalVehicle: {
    AVAILABLE: ['RESERVED', 'IN_TRANSIT', 'FAULTY'],
    RESERVED: ['AVAILABLE', 'IN_USE', 'FAULTY'],
    IN_USE: ['AVAILABLE', 'LOW_BATTERY', 'FAULTY'],
    LOW_BATTERY: ['AVAILABLE', 'FAULTY'],
    IN_TRANSIT: ['AVAILABLE', 'FAULTY'],
    FAULTY: ['AVAILABLE', 'LOW_BATTERY'],
  },
  reservation: {
    CONFIRMED: ['ACTIVE', 'CANCELLED', 'EXPIRED'],
    ACTIVE: ['COMPLETED'],
    COMPLETED: [],
    CANCELLED: [],
    EXPIRED: [],
  },
  parkingSpace: {
    FREE: ['RESERVED', 'OCCUPIED', 'UNAVAILABLE'],
    RESERVED: ['FREE', 'OCCUPIED', 'UNAVAILABLE'],
    OCCUPIED: ['FREE', 'UNAVAILABLE'],
    UNAVAILABLE: ['FREE'],
  },
  chargingRequest: {
    QUEUED: ['CHARGING', 'CANCELLED'],
    SCHEDULED: ['CHARGING', 'CANCELLED'],
    CHARGING: ['COMPLETED'],
    COMPLETED: [],
    CANCELLED: [],
  },
  chargingPoint: {
    AVAILABLE: ['CHARGING', 'FAULTY'],
    CHARGING: ['AVAILABLE', 'FAULTY'],
    FAULTY: ['AVAILABLE'],
  },
  incident: {
    REPORTED: ['IN_MAINTENANCE'],
    IN_MAINTENANCE: ['RESOLVED'],
    RESOLVED: [],
  },
  redistributionTask: {
    PROPOSED: ['APPROVED', 'CANCELLED'],
    APPROVED: ['IN_PROGRESS', 'CANCELLED'],
    IN_PROGRESS: ['COMPLETED', 'FAILED'],
    COMPLETED: [],
    CANCELLED: [],
    FAILED: [],
  },
  // System tables (SPEC §4). alert ACKNOWLEDGED→RESOLVED added per SPEC §4 update.
  alert: {
    OPEN: ['ACKNOWLEDGED', 'DISMISSED', 'RESOLVED'],
    ACKNOWLEDGED: ['RESOLVED'],
    DISMISSED: [],
    RESOLVED: [],
  },
  simRun: {
    RUNNING: ['COMPLETED', 'FAILED', 'INCOMPLETE'],
    COMPLETED: [],
    FAILED: [],
    INCOMPLETE: [],
  },
  recommendation: {
    PENDING: ['APPLIED', 'DISMISSED', 'BLOCKED'],
    APPLIED: [],
    DISMISSED: [],
    BLOCKED: [],
  },
} as const satisfies Record<string, TransitionTable>;

export type Entity = keyof typeof transitions;

export function canTransition(entity: Entity, from: string, to: string): boolean {
  const table = transitions[entity] as TransitionTable;
  const allowed = table[from];
  return allowed !== undefined && allowed.includes(to);
}

// Pure: only throws, never touches the DB. The error handler writes the audit row (D-22).
export function assertTransition(entity: Entity, from: string, to: string): void {
  if (!canTransition(entity, from, to)) {
    throw new InvalidStateTransitionError(entity, from, to);
  }
}
