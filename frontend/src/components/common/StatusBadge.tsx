// Single source of truth mapping enum status values to human labels and colours (NFR-04, AGENTS §5).
// Imports all 9 enum value arrays from types/enums.ts and uses Record<Enum, StatusMeta> so any
// missing enum member is a compile-time error.

import {
  RENTAL_VEHICLE_STATUSES,
  PARKING_SPACE_STATUSES,
  CHARGING_POINT_STATUSES,
  RESERVATION_STATUSES,
  CHARGING_REQUEST_STATUSES,
  INCIDENT_STATUSES,
  ALERT_STATUSES,
  REDISTRIBUTION_STATUSES,
  SIM_RUN_STATUSES,
  type RentalVehicleStatus,
  type ParkingSpaceStatus,
  type ChargingPointStatus,
  type ReservationStatus,
  type ChargingRequestStatus,
  type IncidentStatus,
  type AlertStatus,
  type RedistributionStatus,
  type SimRunStatus,
} from '@/types/enums';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

type Tone = 'green' | 'amber' | 'blue' | 'red' | 'grey';

interface StatusMeta {
  label: string;
  tone: Tone;
}

const TONE_CLASSES: Record<Tone, string> = {
  green: 'border-emerald-300 bg-emerald-50 text-emerald-800',
  amber: 'border-amber-300 bg-amber-50 text-amber-800',
  blue: 'border-sky-300 bg-sky-50 text-sky-800',
  red: 'border-red-300 bg-red-50 text-red-800',
  grey: 'border-neutral-300 bg-neutral-100 text-neutral-700',
};

const RENTAL_VEHICLE_MAP: Record<RentalVehicleStatus, StatusMeta> = {
  AVAILABLE: { label: 'Available', tone: 'green' },
  RESERVED: { label: 'Reserved', tone: 'amber' },
  IN_USE: { label: 'In use', tone: 'blue' },
  LOW_BATTERY: { label: 'Low battery', tone: 'amber' },
  IN_TRANSIT: { label: 'In transit', tone: 'blue' },
  FAULTY: { label: 'Faulty', tone: 'red' },
};

const PARKING_SPACE_MAP: Record<ParkingSpaceStatus, StatusMeta> = {
  FREE: { label: 'Free', tone: 'green' },
  RESERVED: { label: 'Reserved', tone: 'amber' },
  OCCUPIED: { label: 'Occupied', tone: 'blue' },
  UNAVAILABLE: { label: 'Unavailable', tone: 'red' },
};

const CHARGING_POINT_MAP: Record<ChargingPointStatus, StatusMeta> = {
  AVAILABLE: { label: 'Available', tone: 'green' },
  CHARGING: { label: 'Charging', tone: 'blue' },
  FAULTY: { label: 'Faulty', tone: 'red' },
};

const RESERVATION_MAP: Record<ReservationStatus, StatusMeta> = {
  CONFIRMED: { label: 'Confirmed', tone: 'amber' },
  ACTIVE: { label: 'Active', tone: 'blue' },
  COMPLETED: { label: 'Completed', tone: 'grey' },
  CANCELLED: { label: 'Cancelled', tone: 'grey' },
  EXPIRED: { label: 'Expired', tone: 'grey' },
};

const CHARGING_REQUEST_MAP: Record<ChargingRequestStatus, StatusMeta> = {
  QUEUED: { label: 'Queued', tone: 'amber' },
  SCHEDULED: { label: 'Scheduled', tone: 'amber' },
  CHARGING: { label: 'Charging', tone: 'blue' },
  COMPLETED: { label: 'Completed', tone: 'grey' },
  CANCELLED: { label: 'Cancelled', tone: 'grey' },
};

const INCIDENT_MAP: Record<IncidentStatus, StatusMeta> = {
  REPORTED: { label: 'Reported', tone: 'red' },
  IN_MAINTENANCE: { label: 'In maintenance', tone: 'amber' },
  RESOLVED: { label: 'Resolved', tone: 'grey' },
};

const ALERT_MAP: Record<AlertStatus, StatusMeta> = {
  OPEN: { label: 'Open', tone: 'red' },
  ACKNOWLEDGED: { label: 'Acknowledged', tone: 'amber' },
  DISMISSED: { label: 'Dismissed', tone: 'grey' },
  RESOLVED: { label: 'Resolved', tone: 'grey' },
};

const REDISTRIBUTION_MAP: Record<RedistributionStatus, StatusMeta> = {
  PROPOSED: { label: 'Proposed', tone: 'amber' },
  APPROVED: { label: 'Approved', tone: 'amber' },
  IN_PROGRESS: { label: 'In progress', tone: 'blue' },
  COMPLETED: { label: 'Completed', tone: 'grey' },
  CANCELLED: { label: 'Cancelled', tone: 'grey' },
  FAILED: { label: 'Failed', tone: 'red' },
};

const SIM_RUN_MAP: Record<SimRunStatus, StatusMeta> = {
  RUNNING: { label: 'Running', tone: 'blue' },
  COMPLETED: { label: 'Completed', tone: 'grey' },
  FAILED: { label: 'Failed', tone: 'red' },
  INCOMPLETE: { label: 'Incomplete', tone: 'amber' },
};

// Runtime reference to imported enum arrays so bundlers/linters verify every member exists.
const STATUS_ENUM_SETS = {
  rentalVehicle: RENTAL_VEHICLE_STATUSES,
  parkingSpace: PARKING_SPACE_STATUSES,
  chargingPoint: CHARGING_POINT_STATUSES,
  reservation: RESERVATION_STATUSES,
  chargingRequest: CHARGING_REQUEST_STATUSES,
  incident: INCIDENT_STATUSES,
  alert: ALERT_STATUSES,
  redistribution: REDISTRIBUTION_STATUSES,
  simRun: SIM_RUN_STATUSES,
} as const;
void STATUS_ENUM_SETS;

export type StatusBadgeProps =
  | { kind: 'rentalVehicle'; value: RentalVehicleStatus; className?: string }
  | { kind: 'parkingSpace'; value: ParkingSpaceStatus; className?: string }
  | { kind: 'chargingPoint'; value: ChargingPointStatus; className?: string }
  | { kind: 'reservation'; value: ReservationStatus; className?: string }
  | { kind: 'chargingRequest'; value: ChargingRequestStatus; className?: string }
  | { kind: 'incident'; value: IncidentStatus; className?: string }
  | { kind: 'alert'; value: AlertStatus; className?: string }
  | { kind: 'redistribution'; value: RedistributionStatus; className?: string }
  | { kind: 'simRun'; value: SimRunStatus; className?: string };

function resolveMeta(props: StatusBadgeProps): StatusMeta {
  switch (props.kind) {
    case 'rentalVehicle':
      return RENTAL_VEHICLE_MAP[props.value];
    case 'parkingSpace':
      return PARKING_SPACE_MAP[props.value];
    case 'chargingPoint':
      return CHARGING_POINT_MAP[props.value];
    case 'reservation':
      return RESERVATION_MAP[props.value];
    case 'chargingRequest':
      return CHARGING_REQUEST_MAP[props.value];
    case 'incident':
      return INCIDENT_MAP[props.value];
    case 'alert':
      return ALERT_MAP[props.value];
    case 'redistribution':
      return REDISTRIBUTION_MAP[props.value];
    case 'simRun':
      return SIM_RUN_MAP[props.value];
  }
}

export function StatusBadge(props: StatusBadgeProps) {
  const meta = resolveMeta(props);
  return (
    <Badge variant="outline" className={cn(TONE_CLASSES[meta.tone], props.className)}>
      {meta.label}
    </Badge>
  );
}
