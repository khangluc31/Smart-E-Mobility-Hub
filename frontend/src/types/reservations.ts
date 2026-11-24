// Vehicle reservation and recommendation DTOs (CONTRACTS §1 / §4 / §6).
// Imports only ./enums, ./hubs, ./common, and ./charging so it can be copied byte-for-byte to the frontend.

import {
  CHARGING_REQUEST_STATUSES,
  RESERVATION_STATUSES,
  type ChargingRequestStatus,
  type ReservationStatus,
  type VehicleClass,
  type VehicleReservationEndReason,
} from './enums';
import type { RentalVehicle } from './hubs';
import type { Alternative } from './common';
import type { ChargingRequestView } from './charging';

export interface VehicleReservation {
  id: string;
  status: ReservationStatus;
  hubId: string;
  vehicle: RentalVehicle;
  createdAt: string;
  expiresAt: string;
  pickedUpAt: string | null;
  returnedAt: string | null;
  returnHubId: string | null;
  startBatteryPct: number | null;
  endBatteryPct: number | null;
  endReason: VehicleReservationEndReason | null;
  serverNow: string;
}

export interface RecommendedVehicle extends RentalVehicle {
  reason: string;
}

export interface DestinationSuitability {
  hubId: string;
  freeFleetSpaces: number;
  ok: boolean;
  reason: string;
}

export interface VehicleRecommendation {
  vehicles: RecommendedVehicle[];
  destination: DestinationSuitability;
  alternativeDestinations: Alternative[];
}

export interface VehicleReturnResult {
  reservation: VehicleReservation;
  chargingRequest: ChargingRequestView | null;
}

export interface ParkingReservation {
  id: string;
  status: ReservationStatus;
  hubId: string;
  parkingSpaceId: string;
  vehicleClass: VehicleClass;
  privateEvId: string | null;
  windowStart: string;
  windowEnd: string;
  expiresAt: string;
  claimedAt: string | null;
  bookingGroupId: string | null;
  serverNow: string;
}

export interface ParkingAvailability {
  hubId: string;
  vehicleClass: VehicleClass;
  free: number;
  total: number;
  alternatives: Alternative[];
}

export const HISTORY_TYPES = ['all', 'vehicle', 'parking', 'charging'] as const;
export type HistoryType = (typeof HISTORY_TYPES)[number];

export type HistoryStatus = ReservationStatus | ChargingRequestStatus;
export const HISTORY_STATUSES: readonly HistoryStatus[] = Array.from(
  new Set<HistoryStatus>([...RESERVATION_STATUSES, ...CHARGING_REQUEST_STATUSES]),
);

export type HistoryItem =
  | { kind: 'vehicle'; at: string; item: VehicleReservation }
  | { kind: 'parking'; at: string; item: ParkingReservation }
  | { kind: 'charging'; at: string; item: ChargingRequestView };

export interface HistoryPage {
  items: HistoryItem[];
  nextCursor: string | null;
}
