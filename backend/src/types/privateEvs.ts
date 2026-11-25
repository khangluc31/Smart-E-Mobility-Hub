// Shared Private EV DTO types (CONTRACTS §1, §7).
// Keep backend/src/types/privateEvs.ts and frontend/src/types/privateEvs.ts byte-identical.

import type { ChargingRequestView } from './charging';
import type { PrivateEvType, VehicleClass } from './enums';
import type { ParkingReservation } from './reservations';

export interface PrivateEv {
  id: string;
  type: PrivateEvType;
  vehicleClass: VehicleClass;
  label: string;
  batteryCapacityKwh: number;
  batteryPct: number;
  hasActiveBooking: boolean;
}

export interface CombinedBookingResult {
  bookingGroupId: string;
  parkingReservation: ParkingReservation;
  chargingRequest: ChargingRequestView;
}
