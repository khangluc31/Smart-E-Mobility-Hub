// Plain-TS mirror of the Prisma enums (D-21). Values and order match schema.prisma.
// This file has NO imports so it can be copied byte-for-byte to the frontend.
// enums.test.ts checks every array against the matching @prisma/client enum.

export const ROLES = ['STUDENT', 'OPERATOR'] as const;
export type Role = (typeof ROLES)[number];

export const VEHICLE_CLASSES = ['MOTORCYCLE', 'CAR'] as const;
export type VehicleClass = (typeof VEHICLE_CLASSES)[number];

export const RENTAL_VEHICLE_TYPES = ['E_BICYCLE', 'E_MOTORCYCLE'] as const;
export type RentalVehicleType = (typeof RENTAL_VEHICLE_TYPES)[number];

export const PRIVATE_EV_TYPES = ['E_MOTORCYCLE', 'CAR'] as const;
export type PrivateEvType = (typeof PRIVATE_EV_TYPES)[number];

export const RENTAL_VEHICLE_STATUSES = [
  'AVAILABLE',
  'RESERVED',
  'IN_USE',
  'LOW_BATTERY',
  'IN_TRANSIT',
  'FAULTY',
] as const;
export type RentalVehicleStatus = (typeof RENTAL_VEHICLE_STATUSES)[number];

export const RESERVATION_STATUSES = [
  'CONFIRMED',
  'ACTIVE',
  'COMPLETED',
  'CANCELLED',
  'EXPIRED',
] as const;
export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];

export const PARKING_SPACE_STATUSES = ['FREE', 'RESERVED', 'OCCUPIED', 'UNAVAILABLE'] as const;
export type ParkingSpaceStatus = (typeof PARKING_SPACE_STATUSES)[number];

export const PARKING_POOLS = ['FLEET', 'PUBLIC'] as const;
export type ParkingPool = (typeof PARKING_POOLS)[number];

export const CHARGING_POINT_STATUSES = ['AVAILABLE', 'CHARGING', 'FAULTY'] as const;
export type ChargingPointStatus = (typeof CHARGING_POINT_STATUSES)[number];

export const CHARGING_REQUEST_STATUSES = [
  'QUEUED',
  'SCHEDULED',
  'CHARGING',
  'COMPLETED',
  'CANCELLED',
] as const;
export type ChargingRequestStatus = (typeof CHARGING_REQUEST_STATUSES)[number];

export const CHARGING_MODES = ['QUEUE', 'ADVANCE'] as const;
export type ChargingMode = (typeof CHARGING_MODES)[number];

export const CHARGING_END_REASONS = [
  'TARGET_REACHED',
  'USER_STOP',
  'POINT_FAILURE',
  'VEHICLE_FAULT',
] as const;
export type ChargingEndReason = (typeof CHARGING_END_REASONS)[number];

export const INCIDENT_STATUSES = ['REPORTED', 'IN_MAINTENANCE', 'RESOLVED'] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];

export const INCIDENT_RESOURCE_TYPES = [
  'RENTAL_VEHICLE',
  'PARKING_SPACE',
  'CHARGING_POINT',
] as const;
export type IncidentResourceType = (typeof INCIDENT_RESOURCE_TYPES)[number];

export const INCIDENT_CATEGORIES = [
  'VEHICLE_FAULT',
  'BATTERY_FAULT',
  'CHARGER_FAULT',
  'ELECTRICAL',
  'EMERGENCY_DISCONNECT',
  'DAMAGE',
  'OBSTRUCTION',
  'OTHER',
] as const;
export type IncidentCategory = (typeof INCIDENT_CATEGORIES)[number];

export const INCIDENT_SOURCES = ['OPERATOR', 'STUDENT', 'TELEMETRY'] as const;
export type IncidentSource = (typeof INCIDENT_SOURCES)[number];

export const ALERT_TYPES = [
  'NEAR_CAPACITY',
  'LOW_BATTERY',
  'FAULT',
  'STALLED_FEED',
  'SHORTAGE',
  'SURPLUS',
] as const;
export type AlertType = (typeof ALERT_TYPES)[number];

export const ALERT_STATUSES = ['OPEN', 'ACKNOWLEDGED', 'DISMISSED', 'RESOLVED'] as const;
export type AlertStatus = (typeof ALERT_STATUSES)[number];

export const REDISTRIBUTION_STATUSES = [
  'PROPOSED',
  'APPROVED',
  'IN_PROGRESS',
  'COMPLETED',
  'CANCELLED',
  'FAILED',
] as const;
export type RedistributionStatus = (typeof REDISTRIBUTION_STATUSES)[number];

export const SIM_RUN_STATUSES = ['RUNNING', 'COMPLETED', 'FAILED', 'INCOMPLETE'] as const;
export type SimRunStatus = (typeof SIM_RUN_STATUSES)[number];

export const RECOMMENDATION_TYPES = ['REDISTRIBUTE', 'CHARGING_ADJUST', 'REDIRECT'] as const;
export type RecommendationType = (typeof RECOMMENDATION_TYPES)[number];

export const RECOMMENDATION_STATUSES = ['PENDING', 'APPLIED', 'DISMISSED', 'BLOCKED'] as const;
export type RecommendationStatus = (typeof RECOMMENDATION_STATUSES)[number];

export const CHARGING_VEHICLE_KINDS = ['RENTAL', 'PRIVATE'] as const;
export type ChargingVehicleKind = (typeof CHARGING_VEHICLE_KINDS)[number];

export const VEHICLE_RESERVATION_END_REASONS = [
  'RETURNED',
  'CANCELLED',
  'EXPIRED',
  'INCIDENT',
] as const;
export type VehicleReservationEndReason = (typeof VEHICLE_RESERVATION_END_REASONS)[number];

export const IMPACT_BOOKING_TYPES = [
  'VEHICLE_RESERVATION',
  'PARKING_RESERVATION',
  'CHARGING_REQUEST',
] as const;
export type ImpactBookingType = (typeof IMPACT_BOOKING_TYPES)[number];

export const IMPACT_OUTCOMES = ['REASSIGNED', 'CANCELLED', 'ENDED'] as const;
export type ImpactOutcome = (typeof IMPACT_OUTCOMES)[number];

export const REDISTRIBUTION_ORIGINS = ['MANUAL', 'SIMULATION'] as const;
export type RedistributionOrigin = (typeof REDISTRIBUTION_ORIGINS)[number];

// --- Not Prisma enums, but shared vocabularies ---

// CONTRACTS §9 — notification.type values.
export const NOTIFICATION_TYPES = [
  'RESERVATION_EXPIRED',
  'RESERVATION_REASSIGNED',
  'RESERVATION_CANCELLED',
  'RENTAL_ENDED_INCIDENT',
  'CHARGING_STARTED',
  'CHARGING_COMPLETED',
  'CHARGING_ENDED_FAULT',
  'CHARGING_REQUEUED',
  'CHARGING_DEFERRED',
  'CHARGING_CANCELLED',
  'HUB_REDIRECT',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

// audit_log.action values. Starts with the two core actions; modules add theirs via M1.
export const AUDIT_ACTIONS = [
  'SECURITY_DENIED',
  'INVALID_TRANSITION',
  'TELEMETRY_DEMO_STALL',
  'TELEMETRY_DEMO_FAULT',
  'TELEMETRY_DEMO_BATTERY',
  'CHARGING_WEIGHTS_SET',
  'CHARGING_WEIGHTS_RESET',
  'CHARGING_DISPATCHED',
  'CHARGING_OVERRIDE',
  'INCIDENT_CREATED',
  'INCIDENT_MAINTENANCE_STARTED',
  'INCIDENT_RESOLVED',
  'ALERT_ACKNOWLEDGED',
  'ALERT_DISMISSED',
  'REDISTRIBUTION_CREATED',
  'REDISTRIBUTION_APPROVED',
  'REDISTRIBUTION_STARTED',
  'REDISTRIBUTION_COMPLETED',
  'REDISTRIBUTION_FAILED',
  'REDISTRIBUTION_CANCELLED',
  'SIM_RECOMMENDATION_APPLIED',
  'SIM_RECOMMENDATION_DISMISSED',
  'SIM_RECOMMENDATION_BLOCKED',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

// Simulation scenario templates (stored inside sim_scenario.conditions JSON, not a DB enum).
export const SCENARIO_TEMPLATES = [
  'METRO_SURGE',
  'HUB_PARKING_FULL',
  'CHARGING_SPIKE',
  'POINT_OUTAGE',
  'VEHICLE_IMBALANCE',
] as const;
export type ScenarioTemplate = (typeof SCENARIO_TEMPLATES)[number];
