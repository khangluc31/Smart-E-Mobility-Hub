// Shared DTOs used across modules (CONTRACTS §1).
// No imports except ./enums so the file can be copied byte-for-byte to the frontend.

export interface Alternative {
  type: 'hub' | 'rentalVehicle' | 'time';
  hubId?: string;
  hubName?: string;
  id?: string;
  batteryPct?: number;
  free?: number;
  start?: string;
  end?: string;
  reason: string;
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    nextActions: string[];
    alternatives?: Alternative[];
    details?: Record<string, unknown>;
  };
}
