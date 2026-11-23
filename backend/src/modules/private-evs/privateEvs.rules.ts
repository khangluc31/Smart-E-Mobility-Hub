// Pure rules for Private EVs (BR-13, FR-25, FR-26). No DB or Express imports.

import type { PrivateEvType, VehicleClass } from '../../types/enums';

// TODO(M4): confirm label limits
export const PRIVATE_EV_LABEL_MIN = 1;
export const PRIVATE_EV_LABEL_MAX = 64;

/** Derive the parking/charging vehicle class from a Private EV type (BR-13). */
export function classForType(type: PrivateEvType): VehicleClass {
  return type === 'E_MOTORCYCLE' ? 'MOTORCYCLE' : 'CAR';
}
