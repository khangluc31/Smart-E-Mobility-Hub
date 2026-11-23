// Vehicle reservation and recommendation DTOs (CONTRACTS §1 / §4).
// Imports only ./enums, ./hubs, and ./common so it can be copied byte-for-byte to the frontend.

import type { ReservationStatus, VehicleReservationEndReason } from './enums';
import type { RentalVehicle } from './hubs';
import type { Alternative } from './common';

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

// TODO(M6): becomes ChargingRequestView | null with the charging module (CONTRACTS §4)
export interface VehicleReturnResult {
  reservation: VehicleReservation;
  chargingRequest: null;
}
