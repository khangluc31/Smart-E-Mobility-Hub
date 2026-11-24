// Frontend mirror of business constants (SPEC §3, NFR-17).
// Do not hard-code business numbers inside components.

// SPEC §3: minimum battery percentage for a rental vehicle to be eligible (BR-02).
export const MIN_RENTAL_BATTERY_PCT = 20;

// SPEC §3 / D-01: live view polling interval (5 seconds).
export const POLL_INTERVAL_MS = 5000;

// SPEC §3: telemetry interval and stalled feed threshold (FR-03).
export const TELEMETRY_INTERVAL_SEC = 5;
export const STALLED_FEED_INTERVALS = 3;

// SPEC §3: maximum parking reservation window in hours (client-side hint only; server decides).
export const PARKING_MAX_WINDOW_H = 12;

