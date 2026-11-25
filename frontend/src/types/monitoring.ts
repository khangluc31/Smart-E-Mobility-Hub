// Shared Monitoring & Alerts DTO types (CONTRACTS §10).
// Keep backend/src/types/monitoring.ts and frontend/src/types/monitoring.ts byte-identical.

import type { AlertStatus, AlertType, VehicleClass } from './enums';
import type { ChargingPoint, HubDetail, ParkingSpace, RentalVehicle } from './hubs';

export interface DashboardHub {
  hubId: string;
  name: string;
  degraded: boolean;
  lastTelemetryAt: string | null;
  availableRentalVehicles: Record<VehicleClass, number>;
  parkingUtilPct: Record<VehicleClass, number>;
  chargingUtilPct: Record<VehicleClass, number>;
  activeRentals: number;
  queueDepth: Record<VehicleClass, number>;
  openAlerts: number;
}

export interface DashboardTotals {
  rentalVehicles: number;
  chargingPoints: number;
  activeRentals: number;
}

export interface DashboardResponse {
  hubs: DashboardHub[];
  totals: DashboardTotals;
  serverNow: string;
}

export interface ResourceOccupant {
  kind: 'rentalVehicle' | 'parkingReservation' | 'chargingRequest';
  id: string;
  userDisplayName?: string;
}

export interface OpsRentalVehicle extends RentalVehicle {
  occupiedBy: ResourceOccupant | null;
}

export interface OpsParkingSpace extends ParkingSpace {
  occupiedBy: ResourceOccupant | null;
}

export interface OpsChargingPoint extends ChargingPoint {
  occupiedBy: ResourceOccupant | null;
}

export interface OpsHubDetail
  extends Omit<HubDetail, 'vehicles' | 'parkingSpaces' | 'chargingPoints'> {
  vehicles: OpsRentalVehicle[];
  parkingSpaces: OpsParkingSpace[];
  chargingPoints: OpsChargingPoint[];
}

export interface Alert {
  id: string;
  type: AlertType;
  status: AlertStatus;
  hubId: string;
  vehicleClass: VehicleClass | null;
  resourceIds: string[];
  metric: Record<string, number | string>;
  message: string;
  createdAt: string;
  lastSeenAt: string;
  closedAt: string | null;
  closedById: string | null;
}

export interface AlertList {
  items: Alert[];
  nextCursor: string | null;
}
