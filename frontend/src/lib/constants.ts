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

// SPEC §3 / D-13: minutes after returning a rental vehicle during which the student may queue it for charging.
export const CHARGE_AFTER_RETURN_MIN = 30;

// SPEC §3 / BR-09: utilisation threshold (%) at or above which a Hub is highlighted near capacity.
export const NEAR_CAPACITY_PCT = 85;

// CONTRACTS §10 / §11: maximum character length for operator alert/incident notes and resolution notes.
export const OPERATOR_NOTES_MAX = 1000;


