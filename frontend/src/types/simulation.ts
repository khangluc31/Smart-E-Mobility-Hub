// Shared What-if Simulation DTO types (CONTRACTS §13, ARCHITECTURE §12).
// Keep backend/src/types/simulation.ts and frontend/src/types/simulation.ts byte-identical.

import type { ChargingWeights } from './charging';
import type {
  ChargingPointStatus,
  ChargingRequestStatus,
  ChargingVehicleKind,
  ParkingPool,
  ParkingSpaceStatus,
  RecommendationStatus,
  RecommendationType,
  RentalVehicleStatus,
  RentalVehicleType,
  ReservationStatus,
  ScenarioTemplate,
  SimRunStatus,
  VehicleClass,
} from './enums';

export type ScenarioTemplateParamType = 'number' | 'integer' | 'hubId' | 'hubIds';

export interface ScenarioTemplateParam {
  name: string;
  type: ScenarioTemplateParamType;
  min?: number;
  max?: number;
  required: boolean;
}

export interface ScenarioTemplateSpec {
  template: ScenarioTemplate;
  label: string;
  params: ScenarioTemplateParam[];
}

export interface ScenarioCondition {
  template: ScenarioTemplate;
  params: Record<string, number | string | string[]>;
}

export interface Scenario {
  id: string;
  name: string;
  horizonH: number;
  seed: number;
  conditions: ScenarioCondition[];
  createdById: string;
  createdAt: string;
}

export interface SimInterval {
  t: string;
  hubId: string;
  parkingUtilPct: number;
  chargingUtilPct: number;
  avgChargingWaitMin: number;
  maxQueueDepth: number;
  unservedRental: number;
  unservedParking: number;
  unservedCharging: number;
  redirectedReturns: number;
  availableVehicles: number;
  breach: boolean;
}

export interface SimHubSummary {
  hubId: string;
  peakParkingUtilPct: number;
  peakChargingUtilPct: number;
  avgChargingWaitMin: number;
  unservedTotal: number;
}

export interface SimRun {
  id: string;
  scenarioId: string;
  status: SimRunStatus;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  savedName: string | null;
  snapshotTakenAt: string;
}

export interface Recommendation {
  id: string;
  runId: string;
  type: RecommendationType;
  status: RecommendationStatus;
  payload: Record<string, unknown>;
  projectedImpact: Record<string, number>;
  reason: string;
}

export interface SimRunDetail {
  run: SimRun;
  intervals: SimInterval[];
  summary: SimHubSummary[];
  recommendations: Recommendation[];
  warning: 'NETWORK_SATURATED' | null;
}

export interface RecommendationPreview {
  recommendation: Recommendation;
  liveChanges: string[];
  valid: boolean;
  problems: string[];
  confirmToken: string | null;
  expiresAt: string | null;
}

export interface RecommendationApplyResult {
  recommendation: Recommendation;
  created: {
    type: 'redistributionTask' | 'weights' | 'hubRedirect';
    id: string;
  };
}

export type SimCompareMetric =
  | 'peakParkingUtilPct'
  | 'peakChargingUtilPct'
  | 'avgChargingWaitMin'
  | 'unservedTotal';

export interface SimCompareRow {
  hubId: string;
  metric: SimCompareMetric;
  a: number;
  b: number;
  diff: number;
  diffPct: number;
}

export interface SimCompareResult {
  a: SimRun;
  b: SimRun;
  rows: SimCompareRow[];
  better: 'a' | 'b' | 'tie';
}

// Plain JSON frozen copy of live state (FR-53, ARCHITECTURE §12.2, D-07).
export interface SimSnapshot {
  takenAt: string;
  weights: ChargingWeights;
  hubs: Array<{
    id: string;
    name: string;
    lastTelemetryAt: string | null;
  }>;
  thresholds: Array<{
    hubId: string;
    vehicleClass: VehicleClass;
    minAvailable: number;
    maxAvailable: number;
  }>;
  parkingSpaces: Array<{
    id: string;
    hubId: string;
    vehicleClass: VehicleClass;
    pool: ParkingPool;
    status: ParkingSpaceStatus;
  }>;
  chargingPoints: Array<{
    id: string;
    hubId: string;
    vehicleClass: VehicleClass;
    status: ChargingPointStatus;
  }>;
  vehicles: Array<{
    id: string;
    hubId: string;
    type: RentalVehicleType;
    vehicleClass: VehicleClass;
    status: RentalVehicleStatus;
    batteryPct: number;
    parkingSpaceId: string | null;
  }>;
  vehicleReservations: Array<{
    id: string;
    rentalVehicleId: string;
    hubId: string;
    status: ReservationStatus;
    expiresAt: string;
  }>;
  parkingReservations: Array<{
    id: string;
    parkingSpaceId: string;
    hubId: string;
    vehicleClass: VehicleClass;
    status: ReservationStatus;
    windowStart: string;
    windowEnd: string;
  }>;
  chargingRequests: Array<{
    id: string;
    hubId: string;
    vehicleKind: ChargingVehicleKind;
    vehicleClass: VehicleClass;
    rentalVehicleId: string | null;
    privateEvId: string | null;
    status: ChargingRequestStatus;
    currentPct: number;
    targetPct: number;
    desiredTime: string;
    neededBy: string | null;
    createdAt: string;
    manualAdjust: number;
    chargingPointId: string | null;
    slotStart: string | null;
    slotEnd: string | null;
  }>;
}
