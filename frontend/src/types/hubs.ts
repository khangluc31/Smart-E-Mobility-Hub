// Hub DTOs (CONTRACTS §1 / §3).
// No imports except ./enums so the file can be copied byte-for-byte to the frontend.

import type {
  VehicleClass,
  RentalVehicleType,
  RentalVehicleStatus,
  ParkingSpaceStatus,
  ParkingPool,
  ChargingPointStatus,
} from './enums';

export interface ClassCount {
  free: number;
  total: number;
  utilPct: number;
}

export interface HubSummary {
  id: string;
  name: string;
  location: string;
  lastTelemetryAt: string | null;
  degraded: boolean;
  availableRentalVehicles: number;
  parking: Record<VehicleClass, ClassCount>;
  publicParking: Record<VehicleClass, ClassCount>;
  charging: Record<VehicleClass, ClassCount>;
  nearCapacity: boolean;
  redirectToHubId: string | null;
}

export interface RentalVehicle {
  id: string;
  hubId: string;
  type: RentalVehicleType;
  vehicleClass: 'MOTORCYCLE';
  status: RentalVehicleStatus;
  batteryPct: number;
  charging: boolean;
}

export interface ParkingSpace {
  id: string;
  hubId: string;
  vehicleClass: VehicleClass;
  pool: ParkingPool;
  status: ParkingSpaceStatus;
}

export interface ChargingPoint {
  id: string;
  hubId: string;
  vehicleClass: VehicleClass;
  status: ChargingPointStatus;
}

export interface HubDetail extends HubSummary {
  vehicles: RentalVehicle[];
  parkingSpaces: ParkingSpace[];
  chargingPoints: ChargingPoint[];
}

export const ALTERNATIVE_NEEDS = ['FLEET_PARKING', 'PUBLIC_PARKING', 'CHARGING'] as const;
export type AlternativeNeed = (typeof ALTERNATIVE_NEEDS)[number];
