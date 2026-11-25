// Charging DTOs (CONTRACTS §1, §8.1, §8.2).
// Imports only ./common, ./enums and ./hubs so backend and frontend copies stay byte-identical.

import type { Alternative } from './common';
import type {
  ChargingEndReason,
  ChargingMode,
  ChargingRequestStatus,
  ChargingVehicleKind,
  VehicleClass,
} from './enums';
import type { ChargingPoint } from './hubs';

export interface ChargingRequestView {
  id: string;
  status: ChargingRequestStatus;
  mode: ChargingMode;
  hubId: string;
  vehicleClass: VehicleClass;
  vehicleKind: ChargingVehicleKind;
  rentalVehicleId: string | null;
  privateEvId: string | null;
  startPct: number;
  currentPct: number;
  targetPct: number;
  desiredTime: string;
  neededBy: string | null;
  chargingPointId: string | null;
  slotStart: string | null;
  slotEnd: string | null;
  queuePosition: number | null;
  estimatedStart: string | null;
  estimatedEnd: string | null;
  endReason: ChargingEndReason | null;
  finalPct: number | null;
  createdAt: string;
  serverNow: string;
}

export interface ChargingWeights {
  battery: number;
  urgency: number;
  waiting: number;
}

export interface ChargingWeightsView extends ChargingWeights {
  isDefault: boolean;
}

export interface ChargingScoreBreakdown {
  battery: number;
  urgency: number;
  waiting: number;
  manualAdjust: number;
}

export interface ChargingQueueEntry {
  rank: number;
  score: number;
  breakdown: ChargingScoreBreakdown;
  request: ChargingRequestView;
}

export interface ChargingQueue {
  weights: ChargingWeights;
  entries: ChargingQueueEntry[];
}

export interface ProjectedChargingSlot {
  requestId: string;
  estimatedStart: string;
  estimatedEnd: string;
}

export interface ChargingSchedulePoint {
  point: ChargingPoint;
  current: ChargingRequestView | null;
  booked: ChargingRequestView[];
  projected: ProjectedChargingSlot[];
}

export interface ChargingSchedule {
  generatedAt: string;
  points: ChargingSchedulePoint[];
}

export type SubmitChargingRequest =
  | {
      vehicleKind: 'PRIVATE';
      privateEvId: string;
      hubId: string;
      targetPct: number;
      desiredTime?: string;
      neededBy?: string;
    }
  | {
      vehicleKind: 'RENTAL';
      rentalVehicleId: string;
      hubId: string;
      targetPct: number;
      neededBy?: string;
    };

export interface ChargingAvailability {
  available: boolean;
  slotEnd: string;
  suggestions: Alternative[];
}

export interface BookAdvanceChargingRequest {
  privateEvId: string;
  hubId: string;
  slotStart: string;
  targetPct: number;
}

export interface DispatchResult {
  created: ChargingRequestView[];
}

export type FleetDispatchRequest =
  | {
      rentalVehicleId: string;
      hubId: string;
      targetPct?: number;
    }
  | {
      hubId: string;
      allLowBattery: true;
      targetPct?: number;
    };

export const CHARGING_OVERRIDE_ACTIONS = ['PROMOTE', 'DEFER', 'SWAP', 'CANCEL'] as const;
export type ChargingOverrideAction = (typeof CHARGING_OVERRIDE_ACTIONS)[number];

export interface ChargingOverrideRequest {
  action: ChargingOverrideAction;
  requestId: string;
  otherRequestId?: string;
  reason: string;
}

export interface ChargingOverrideResult {
  entries: ChargingQueueEntry[];
}
