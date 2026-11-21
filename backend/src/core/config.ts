// Single source of business + runtime configuration (NFR-17). Every value comes
// from env with a SPEC §3 default; no business number is hard-coded elsewhere.
// loadConfig is pure (takes env) so tests can exercise defaults and overrides.

type Env = Record<string, string | undefined>;

function numberFrom(env: Env, key: string, def: number): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`Config: ${key} must be a number, got "${raw}"`);
  if (n < 0) throw new Error(`Config: ${key} must not be negative, got ${n}`);
  return n;
}

function stringFrom(env: Env, key: string, def: string): string {
  const raw = env[key];
  return raw === undefined || raw === '' ? def : raw;
}

function boolFrom(env: Env, key: string, def: boolean): boolean {
  const raw = env[key];
  if (raw === undefined || raw === '') return def;
  return raw === 'true';
}

export function loadConfig(env: Env) {
  const NODE_ENV = stringFrom(env, 'NODE_ENV', 'development');

  // JWT_SECRET: required in production; fixed dev value otherwise.
  const jwtSecretRaw = env['JWT_SECRET'];
  let JWT_SECRET: string;
  if (jwtSecretRaw !== undefined && jwtSecretRaw !== '') {
    JWT_SECRET = jwtSecretRaw;
  } else if (NODE_ENV === 'production') {
    throw new Error('Config: JWT_SECRET is required when NODE_ENV=production');
  } else {
    JWT_SECRET = 'dev-insecure-jwt-secret';
  }

  const config = {
    // runtime
    NODE_ENV,
    PORT: numberFrom(env, 'PORT', 3000),
    DATABASE_URL: stringFrom(env, 'DATABASE_URL', ''),
    CORS_ORIGIN: stringFrom(env, 'CORS_ORIGIN', 'http://localhost:5173'),
    JOBS_ENABLED: boolFrom(env, 'JOBS_ENABLED', false),
    JWT_SECRET,
    JWT_EXPIRES_IN: stringFrom(env, 'JWT_EXPIRES_IN', '8h'),
    TELEMETRY_KEY: stringFrom(env, 'TELEMETRY_KEY', 'change-me'),
    SEED_PASSWORD: stringFrom(env, 'SEED_PASSWORD', 'change-me'),

    // SPEC §3 business constants
    HUB_COUNT: numberFrom(env, 'HUB_COUNT', 5),
    RENTAL_VEHICLE_COUNT: numberFrom(env, 'RENTAL_VEHICLE_COUNT', 300),
    CHARGING_POINT_COUNT: numberFrom(env, 'CHARGING_POINT_COUNT', 60),
    RESERVATION_HOLD_MIN: numberFrom(env, 'RESERVATION_HOLD_MIN', 15),
    MIN_RENTAL_BATTERY_PCT: numberFrom(env, 'MIN_RENTAL_BATTERY_PCT', 20),
    NEAR_CAPACITY_PCT: numberFrom(env, 'NEAR_CAPACITY_PCT', 85),
    TELEMETRY_INTERVAL_SEC: numberFrom(env, 'TELEMETRY_INTERVAL_SEC', 5),
    STALLED_FEED_INTERVALS: numberFrom(env, 'STALLED_FEED_INTERVALS', 3),
    MAX_ACTIVE_RENTALS_PER_STUDENT: numberFrom(env, 'MAX_ACTIVE_RENTALS_PER_STUDENT', 1),
    CHARGING_WEIGHTS: Object.freeze({
      battery: numberFrom(env, 'CHARGING_WEIGHT_BATTERY', 0.5),
      urgency: numberFrom(env, 'CHARGING_WEIGHT_URGENCY', 0.3),
      waiting: numberFrom(env, 'CHARGING_WEIGHT_WAITING', 0.2),
    }),
    IMBALANCE_MIN_DEFAULT: numberFrom(env, 'IMBALANCE_MIN_DEFAULT', 15),
    IMBALANCE_MAX_DEFAULT: numberFrom(env, 'IMBALANCE_MAX_DEFAULT', 80),
    REDISTRIBUTION_DEST_LIMIT_PCT: numberFrom(env, 'REDISTRIBUTION_DEST_LIMIT_PCT', 85),
    OVERRIDE_REASON_MIN_CHARS: numberFrom(env, 'OVERRIDE_REASON_MIN_CHARS', 10),
    SIM_MAX_HORIZON_H: numberFrom(env, 'SIM_MAX_HORIZON_H', 24),
    SIM_MAX_RUNTIME_SEC: numberFrom(env, 'SIM_MAX_RUNTIME_SEC', 60),
    SIM_INTERVAL_MIN: numberFrom(env, 'SIM_INTERVAL_MIN', 15),
    CHARGE_RATE_PCT_PER_MIN: Object.freeze({
      MOTORCYCLE: numberFrom(env, 'CHARGE_RATE_MOTORCYCLE', 1.0),
      CAR: numberFrom(env, 'CHARGE_RATE_CAR', 0.5),
    }),
    DEMO_TIME_SCALE: numberFrom(env, 'DEMO_TIME_SCALE', 1),
    URGENCY_HORIZON_MIN: numberFrom(env, 'URGENCY_HORIZON_MIN', 240),
    WAITING_FULL_MIN: numberFrom(env, 'WAITING_FULL_MIN', 120),
    MANUAL_ADJUST_STEP: numberFrom(env, 'MANUAL_ADJUST_STEP', 1000),
    CHARGE_AFTER_RETURN_MIN: numberFrom(env, 'CHARGE_AFTER_RETURN_MIN', 30),
    CONFIRM_TOKEN_TTL_MIN: numberFrom(env, 'CONFIRM_TOKEN_TTL_MIN', 5),
    BATTERY_DRAIN_PCT_PER_MIN: numberFrom(env, 'BATTERY_DRAIN_PCT_PER_MIN', 0.3),
    FAULT_PROBABILITY: numberFrom(env, 'FAULT_PROBABILITY', 0),
    PARKING_MAX_WINDOW_H: numberFrom(env, 'PARKING_MAX_WINDOW_H', 12),
    ALTERNATIVE_SLOTS_COUNT: numberFrom(env, 'ALTERNATIVE_SLOTS_COUNT', 3),
    LIST_LIMIT_DEFAULT: numberFrom(env, 'LIST_LIMIT_DEFAULT', 50),
    LIST_LIMIT_MAX: numberFrom(env, 'LIST_LIMIT_MAX', 200),
  };

  return Object.freeze(config);
}

export type Config = ReturnType<typeof loadConfig>;

export const config = loadConfig(process.env);
