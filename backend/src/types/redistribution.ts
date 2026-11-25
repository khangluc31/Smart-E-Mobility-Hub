// Shared Redistribution & Imbalance DTO types (CONTRACTS §12).
// Keep backend/src/types/redistribution.ts and frontend/src/types/redistribution.ts byte-identical.

import type {
  RedistributionOrigin,
  RedistributionStatus,
  RentalVehicleType,
  VehicleClass,
} from './enums';

export type ImbalanceState = 'SHORTAGE' | 'SURPLUS' | 'OK';

export interface Imbalance {
  hubId: string;
  vehicleClass: VehicleClass;
  available: number;
  min: number;
  max: number;
  state: ImbalanceState;
  amount: number;
}

export interface RedistributionPreview {
  eligibleAtSource: number;
  destFreeFleetSpaces: number;
  predictedDestOccupancyPct: number;
  ok: boolean;
  needsOverride: boolean;
  problems: string[];
}

export interface RedistributionTask {
  id: string;
  status: RedistributionStatus;
  sourceHubId: string;
  destHubId: string;
  vehicleClass: VehicleClass;
  vehicleType: RentalVehicleType | null;
  count: number;
  override: boolean;
  reason: string | null;
  origin: RedistributionOrigin;
  recommendationId: string | null;
  vehicleIds: string[];
  createdById: string;
  createdAt: string;
  updatedAt: string;
}

export interface RedistributionTaskList {
  items: RedistributionTask[];
  nextCursor: string | null;
}
