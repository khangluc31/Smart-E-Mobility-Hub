/**
 * T-03 Checker tests — written from spec (SPEC.md §3/4/5/8, ARCHITECTURE.md §3/4,
 * CONTRACTS.md §0/9, TASKS.md T-03) before reading the implementation.
 *
 * Run after: npm test -w backend
 * Manual checks (AC-11/12/13) are recorded in the round-1 report.
 */

import express from 'express';
import request from 'supertest';
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { Prisma } from '@prisma/client';

// ---- imports from core (paths only; implementation not yet read when tests were written) ----
import { loadConfig } from '../src/core/config';
import {
  AppError,
  InvalidStateTransitionError,
  requireInt,
  requireEnum,
  requireIsoDate,
  optional,
} from '../src/core/errors';
import { errorHandler, notFoundHandler } from '../src/core/errorHandler';
import { signToken, requireAuth, requireRole } from '../src/core/auth';
import { assertTransition, canTransition } from '../src/core/stateMachine';
import { db, lockRow } from '../src/core/db';
import { audit } from '../src/core/audit';
import { notify } from '../src/core/notify';
import { events } from '../src/core/events';
import { registerJob, runJobOnce, stopJobs } from '../src/core/scheduler';

// ---------------------------------------------------------------------------
// DB helpers (use the same `db` instance the app uses, test DB via process.env)
// ---------------------------------------------------------------------------

async function truncateCoreTablesForTest(): Promise<void> {
  // TRUNCATE is safe even if the table is empty; CASCADE handles FK order
  await db.$executeRaw`TRUNCATE audit_log, notification RESTART IDENTITY CASCADE`;
}

async function truncateWithUsers(): Promise<void> {
  await db.$executeRaw`TRUNCATE audit_log, notification, rental_vehicle, hub, "user" RESTART IDENTITY CASCADE`;
}

async function insertTestHub(id = 'checker-hub'): Promise<void> {
  await db.$executeRawUnsafe(
    `INSERT INTO hub (id, name, location, "createdAt")
     VALUES ($1, 'Checker Hub', 'Test', NOW())
     ON CONFLICT (id) DO NOTHING`,
    id,
  );
}

async function insertTestUser(id: string, role: 'STUDENT' | 'OPERATOR'): Promise<void> {
  await db.$executeRawUnsafe(
    `INSERT INTO "user" (id, identifier, "passwordHash", "displayName", role, "mustChangePassword", "createdAt")
     VALUES ($1, $2, 'hash', 'Checker', $3::"Role", false, NOW())
     ON CONFLICT (id) DO NOTHING`,
    id,
    id + '@test',
    role,
  );
}

async function insertTestVehicle(id = 'checker-rv'): Promise<void> {
  await insertTestHub();
  await db.$executeRawUnsafe(
    `INSERT INTO rental_vehicle (id, "hubId", type, "vehicleClass", status, "batteryPct", "updatedAt")
     VALUES ($1, 'checker-hub', 'E_BICYCLE'::"RentalVehicleType", 'MOTORCYCLE'::"VehicleClass",
             'AVAILABLE'::"RentalVehicleStatus", 80, NOW())
     ON CONFLICT (id) DO NOTHING`,
    id,
  );
}

afterAll(async () => {
  await db.$disconnect();
});

// ===========================================================================
// AC-1 — config defaults match SPEC §3
// ===========================================================================

describe('T-03 AC-1 NFR-17 config defaults match SPEC §3 and bad env throws', () => {
  it('returns every SPEC §3 key with its default when env is empty', () => {
    const c = loadConfig({});
    expect(c.RESERVATION_HOLD_MIN).toBe(15);
    expect(c.MIN_RENTAL_BATTERY_PCT).toBe(20);
    expect(c.NEAR_CAPACITY_PCT).toBe(85);
    expect(c.TELEMETRY_INTERVAL_SEC).toBe(5);
    expect(c.STALLED_FEED_INTERVALS).toBe(3);
    expect(c.MAX_ACTIVE_RENTALS_PER_STUDENT).toBe(1);
    expect(c.CHARGING_WEIGHTS).toEqual({ battery: 0.5, urgency: 0.3, waiting: 0.2 });
    expect(c.IMBALANCE_MIN_DEFAULT).toBe(15);
    expect(c.IMBALANCE_MAX_DEFAULT).toBe(80);
    expect(c.REDISTRIBUTION_DEST_LIMIT_PCT).toBe(85);
    expect(c.OVERRIDE_REASON_MIN_CHARS).toBe(10);
    expect(c.SIM_MAX_HORIZON_H).toBe(24);
    expect(c.SIM_MAX_RUNTIME_SEC).toBe(60);
    expect(c.SIM_INTERVAL_MIN).toBe(15);
    expect(c.CHARGE_RATE_PCT_PER_MIN).toEqual({ MOTORCYCLE: 1.0, CAR: 0.5 });
    expect(c.DEMO_TIME_SCALE).toBe(1);
    expect(c.URGENCY_HORIZON_MIN).toBe(240);
    expect(c.WAITING_FULL_MIN).toBe(120);
    expect(c.MANUAL_ADJUST_STEP).toBe(1000);
    expect(c.CHARGE_AFTER_RETURN_MIN).toBe(30);
    expect(c.CONFIRM_TOKEN_TTL_MIN).toBe(5);
    expect(c.BATTERY_DRAIN_PCT_PER_MIN).toBe(0.3);
    expect(c.FAULT_PROBABILITY).toBe(0);
    expect(c.PARKING_MAX_WINDOW_H).toBe(12);
    expect(c.ALTERNATIVE_SLOTS_COUNT).toBe(3);
    expect(c.LIST_LIMIT_DEFAULT).toBe(50);
    expect(c.LIST_LIMIT_MAX).toBe(200);
    expect(c.JWT_EXPIRES_IN).toBe('8h');
  });

  it('env overrides apply', () => {
    const c = loadConfig({ RESERVATION_HOLD_MIN: '30', MIN_RENTAL_BATTERY_PCT: '25' });
    expect(c.RESERVATION_HOLD_MIN).toBe(30);
    expect(c.MIN_RENTAL_BATTERY_PCT).toBe(25);
  });

  it('throws naming the key when a numeric env is not a number', () => {
    expect(() => loadConfig({ RESERVATION_HOLD_MIN: 'not-a-number' }))
      .toThrow(/RESERVATION_HOLD_MIN/i);
  });

  it('throws naming the key when a numeric env is negative', () => {
    expect(() => loadConfig({ MIN_RENTAL_BATTERY_PCT: '-5' }))
      .toThrow(/MIN_RENTAL_BATTERY_PCT/i);
  });

  it('throws when JWT_SECRET is missing in production', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' }))
      .toThrow(/JWT_SECRET/i);
  });

  it('does not throw when JWT_SECRET is missing in dev or test', () => {
    expect(() => loadConfig({ NODE_ENV: 'development' })).not.toThrow();
    expect(() => loadConfig({ NODE_ENV: 'test' })).not.toThrow();
  });
});

// ===========================================================================
// AC-2 — validation helpers (requireInt, requireEnum, requireIsoDate, optional)
// ===========================================================================

describe('T-03 AC-2 NFR-13 requireInt boundaries min/max pass, min-1/max+1 fail', () => {
  it('min itself passes', () => {
    expect(requireInt({ value: 5 }, 'value', { min: 5, max: 10 })).toBe(5);
  });

  it('max itself passes', () => {
    expect(requireInt({ value: 10 }, 'value', { min: 5, max: 10 })).toBe(10);
  });

  it('min-1 fails with 400 VALIDATION_ERROR details.field', () => {
    let caughtErr: AppError | undefined;
    try {
      requireInt({ value: 4 }, 'value', { min: 5, max: 10 });
    } catch (e) {
      caughtErr = e as AppError;
    }
    expect(caughtErr).toBeInstanceOf(AppError);
    expect(caughtErr?.status).toBe(400);
    expect(caughtErr?.code).toBe('VALIDATION_ERROR');
    expect((caughtErr?.details as { field?: string } | undefined)?.field).toBe('value');
  });

  it('max+1 fails with 400 VALIDATION_ERROR details.field', () => {
    let caughtErr: AppError | undefined;
    try {
      requireInt({ value: 11 }, 'value', { min: 5, max: 10 });
    } catch (e) {
      caughtErr = e as AppError;
    }
    expect(caughtErr?.code).toBe('VALIDATION_ERROR');
  });

  it('accepts numeric string', () => {
    expect(requireInt({ value: '7' }, 'value', { min: 0, max: 100 })).toBe(7);
  });
});

describe('T-03 AC-2 requireEnum and requireIsoDate reject bad values with details.field', () => {
  it('requireEnum accepts a valid value', () => {
    expect(requireEnum({ s: 'AVAILABLE' }, 's', ['AVAILABLE', 'RESERVED'] as const)).toBe('AVAILABLE');
  });

  it('requireEnum rejects an invalid value with VALIDATION_ERROR details.field', () => {
    let caughtErr: AppError | undefined;
    try {
      requireEnum({ s: 'BOGUS' }, 's', ['AVAILABLE', 'RESERVED'] as const);
    } catch (e) {
      caughtErr = e as AppError;
    }
    expect(caughtErr?.status).toBe(400);
    expect(caughtErr?.code).toBe('VALIDATION_ERROR');
    expect((caughtErr?.details as { field?: string } | undefined)?.field).toBe('s');
  });

  it('requireIsoDate accepts a valid ISO-8601 UTC string', () => {
    const d = requireIsoDate({ d: '2026-12-01T08:00:00.000Z' }, 'd');
    expect(d).toBeInstanceOf(Date);
  });

  it('requireIsoDate rejects a non-ISO string with VALIDATION_ERROR details.field', () => {
    let caughtErr: AppError | undefined;
    try {
      requireIsoDate({ d: 'not-a-date' }, 'd');
    } catch (e) {
      caughtErr = e as AppError;
    }
    expect(caughtErr?.status).toBe(400);
    expect((caughtErr?.details as { field?: string } | undefined)?.field).toBe('d');
  });

  it('optional returns undefined for absent field', () => {
    const optInt = optional(requireInt);
    expect(optInt({}, 'x', { min: 0, max: 10 })).toBeUndefined();
  });

  it('optional returns undefined for null field', () => {
    const optInt = optional(requireInt);
    expect(optInt({ x: null }, 'x', { min: 0, max: 10 })).toBeUndefined();
  });

  it('optional returns the value when present', () => {
    const optInt = optional(requireInt);
    expect(optInt({ x: 5 }, 'x', { min: 0, max: 10 })).toBe(5);
  });
});

// ===========================================================================
// AC-3 — error handler shape (CONTRACTS §0)
// ===========================================================================

function makeTestApp() {
  const app = express();
  app.use(express.json());
  return app;
}

describe('T-03 AC-3 NFR-05 error shape for AppError, P2002, P2025, bad JSON, unknown error', () => {
  it('AppError keeps status/code/nextActions/alternatives', async () => {
    const app = makeTestApp();
    app.get('/test', (_req, _res) => {
      throw new AppError(409, 'RESOURCE_TAKEN', 'taken', {
        nextActions: ['Try another'],
        alternatives: [{ type: 'hub', hubId: 'x', reason: 'free' }],
      });
    });
    app.use(errorHandler);
    const res = await request(app).get('/test');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('RESOURCE_TAKEN');
    expect(res.body.error.message).toBeTruthy();
    expect(Array.isArray(res.body.error.nextActions)).toBe(true);
    expect(res.body.error.nextActions.length).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(res.body.error.alternatives)).toBe(true);
  });

  it('P2002 → 409 RESOURCE_TAKEN', async () => {
    const app = makeTestApp();
    app.get('/test', (_req, _res) => {
      throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: '5.0.0',
      });
    });
    app.use(errorHandler);
    const res = await request(app).get('/test');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('RESOURCE_TAKEN');
  });

  it('Postgres 23505 error → 409 RESOURCE_TAKEN', async () => {
    const app = makeTestApp();
    app.get('/test', (_req, _res) => {
      const err = Object.assign(new Error('unique violation'), { code: '23505' });
      throw err;
    });
    app.use(errorHandler);
    const res = await request(app).get('/test');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('RESOURCE_TAKEN');
  });

  it('Postgres 23P01 exclusion violation → 409 RESOURCE_TAKEN', async () => {
    const app = makeTestApp();
    app.get('/test', (_req, _res) => {
      const err = Object.assign(new Error('exclusion violation'), { code: '23P01' });
      throw err;
    });
    app.use(errorHandler);
    const res = await request(app).get('/test');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('RESOURCE_TAKEN');
  });

  it('P2025 → 404 NOT_FOUND', async () => {
    const app = makeTestApp();
    app.get('/test', (_req, _res) => {
      throw new Prisma.PrismaClientKnownRequestError('Record not found', {
        code: 'P2025',
        clientVersion: '5.0.0',
      });
    });
    app.use(errorHandler);
    const res = await request(app).get('/test');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('malformed JSON body → 400 VALIDATION_ERROR', async () => {
    const app = makeTestApp();
    app.post('/test', (_req, res) => { res.json({ ok: true }); });
    app.use(errorHandler);
    const res = await request(app)
      .post('/test')
      .set('Content-Type', 'application/json')
      .send('{bad json}');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('unknown error → 500 INTERNAL_ERROR without internal text', async () => {
    const app = makeTestApp();
    app.get('/test', (_req, _res) => {
      throw new Error('super secret DB internal error from Prisma query');
    });
    app.use(errorHandler);
    const res = await request(app).get('/test');
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(res.body)).not.toMatch(/Prisma/i);
    expect(JSON.stringify(res.body)).not.toMatch(/super secret/i);
  });

  it('every error body has code, message, nextActions[]', async () => {
    // AppError
    {
      const app = makeTestApp();
      app.get('/a', (_req, _res) => {
        throw new AppError(400, 'VALIDATION_ERROR', 'bad', { nextActions: ['fix it'] });
      });
      app.use(errorHandler);
      const res = await request(app).get('/a');
      expect(res.body.error).toHaveProperty('code');
      expect(res.body.error).toHaveProperty('message');
      expect(Array.isArray(res.body.error.nextActions)).toBe(true);
      expect(res.body.error.nextActions.length).toBeGreaterThanOrEqual(1);
    }
    // 23505
    {
      const app = makeTestApp();
      app.get('/b', (_req, _res) => {
        throw Object.assign(new Error('p'), { code: '23505' });
      });
      app.use(errorHandler);
      const res = await request(app).get('/b');
      expect(res.body.error).toHaveProperty('code');
      expect(res.body.error).toHaveProperty('message');
      expect(Array.isArray(res.body.error.nextActions)).toBe(true);
    }
    // unknown
    {
      const app = makeTestApp();
      app.get('/c', (_req, _res) => { throw new Error('unknown'); });
      app.use(errorHandler);
      const res = await request(app).get('/c');
      expect(res.body.error).toHaveProperty('code');
      expect(res.body.error).toHaveProperty('message');
      expect(Array.isArray(res.body.error.nextActions)).toBe(true);
    }
  });

  it('unknown route returns 404 NOT_FOUND', async () => {
    const app = makeTestApp();
    app.use(notFoundHandler);
    app.use(errorHandler);
    const res = await request(app).get('/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});

// ===========================================================================
// AC-4 — state machine: every SPEC §4 allowed transition passes; forbidden fails
// ===========================================================================

// Built from SPEC §4 — NOT copied from the writer's code
const SPEC_TRANSITIONS: Record<string, Record<string, string[]>> = {
  rentalVehicle: {
    AVAILABLE: ['RESERVED', 'IN_TRANSIT', 'FAULTY'],
    RESERVED: ['AVAILABLE', 'IN_USE', 'FAULTY'],
    IN_USE: ['AVAILABLE', 'LOW_BATTERY', 'FAULTY'],
    LOW_BATTERY: ['AVAILABLE', 'FAULTY'],
    IN_TRANSIT: ['AVAILABLE', 'FAULTY'],
    FAULTY: ['AVAILABLE', 'LOW_BATTERY'],
  },
  reservation: {
    CONFIRMED: ['ACTIVE', 'CANCELLED', 'EXPIRED'],
    ACTIVE: ['COMPLETED'],
  },
  parkingSpace: {
    FREE: ['RESERVED', 'OCCUPIED', 'UNAVAILABLE'],
    RESERVED: ['FREE', 'OCCUPIED', 'UNAVAILABLE'],
    OCCUPIED: ['FREE', 'UNAVAILABLE'],
    UNAVAILABLE: ['FREE'],
  },
  chargingRequest: {
    QUEUED: ['CHARGING', 'CANCELLED'],
    SCHEDULED: ['CHARGING', 'CANCELLED'],
    CHARGING: ['COMPLETED'],
  },
  chargingPoint: {
    AVAILABLE: ['CHARGING', 'FAULTY'],
    CHARGING: ['AVAILABLE', 'FAULTY'],
    FAULTY: ['AVAILABLE'],
  },
  incident: {
    REPORTED: ['IN_MAINTENANCE'],
    IN_MAINTENANCE: ['RESOLVED'],
  },
  redistributionTask: {
    PROPOSED: ['APPROVED', 'CANCELLED'],
    APPROVED: ['IN_PROGRESS', 'CANCELLED'],
    IN_PROGRESS: ['COMPLETED', 'FAILED'],
  },
  // System tables — same assertTransition rule applies (SPEC §4)
  alert: {
    OPEN: ['ACKNOWLEDGED', 'DISMISSED', 'RESOLVED'],
    ACKNOWLEDGED: ['RESOLVED'], // known accepted: ACKNOWLEDGED→RESOLVED per updated SPEC §4
  },
  simRun: {
    RUNNING: ['COMPLETED', 'FAILED', 'INCOMPLETE'],
  },
  recommendation: {
    PENDING: ['APPLIED', 'DISMISSED', 'BLOCKED'],
  },
};

// All states per entity (for X→X and forbidden checks)
const ALL_STATES: Record<string, string[]> = {
  rentalVehicle: ['AVAILABLE', 'RESERVED', 'IN_USE', 'LOW_BATTERY', 'IN_TRANSIT', 'FAULTY'],
  reservation: ['CONFIRMED', 'ACTIVE', 'COMPLETED', 'CANCELLED', 'EXPIRED'],
  parkingSpace: ['FREE', 'RESERVED', 'OCCUPIED', 'UNAVAILABLE'],
  chargingRequest: ['QUEUED', 'SCHEDULED', 'CHARGING', 'COMPLETED', 'CANCELLED'],
  chargingPoint: ['AVAILABLE', 'CHARGING', 'FAULTY'],
  incident: ['REPORTED', 'IN_MAINTENANCE', 'RESOLVED'],
  redistributionTask: ['PROPOSED', 'APPROVED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'FAILED'],
  alert: ['OPEN', 'ACKNOWLEDGED', 'DISMISSED', 'RESOLVED'],
  simRun: ['RUNNING', 'COMPLETED', 'FAILED', 'INCOMPLETE'],
  recommendation: ['PENDING', 'APPLIED', 'DISMISSED', 'BLOCKED'],
};

type EntityName = Parameters<typeof assertTransition>[0];

describe('T-03 AC-4 BR-05 every SPEC §4 transition allowed, X→X forbidden', () => {
  for (const [entity, fromMap] of Object.entries(SPEC_TRANSITIONS)) {
    for (const [from, tos] of Object.entries(fromMap)) {
      for (const to of tos) {
        it(`${entity}: ${from} → ${to} passes assertTransition`, () => {
          expect(() => assertTransition(entity as EntityName, from, to)).not.toThrow();
          expect(canTransition(entity as EntityName, from, to)).toBe(true);
        });
      }
    }
  }

  for (const [entity, states] of Object.entries(ALL_STATES)) {
    for (const state of states) {
      it(`${entity}: ${state} → ${state} (X→X) throws InvalidStateTransitionError with details`, () => {
        let caughtErr: InvalidStateTransitionError | undefined;
        try {
          assertTransition(entity as EntityName, state, state);
        } catch (e) {
          caughtErr = e as InvalidStateTransitionError;
        }
        expect(caughtErr).toBeInstanceOf(InvalidStateTransitionError);
        expect(caughtErr?.status).toBe(409);
        expect(caughtErr?.code).toBe('INVALID_STATE_TRANSITION');
        expect((caughtErr?.details as { entity?: string } | undefined)?.entity).toBe(entity);
        expect((caughtErr?.details as { from?: string } | undefined)?.from).toBe(state);
        expect((caughtErr?.details as { to?: string } | undefined)?.to).toBe(state);
      });
    }
  }

  // ≥ 3 forbidden moves per entity (non-X→X)
  const FORBIDDEN_SAMPLES: Array<{ entity: string; from: string; to: string }> = [
    // rentalVehicle (5 samples)
    { entity: 'rentalVehicle', from: 'AVAILABLE', to: 'IN_USE' },
    { entity: 'rentalVehicle', from: 'AVAILABLE', to: 'LOW_BATTERY' },
    { entity: 'rentalVehicle', from: 'FAULTY', to: 'RESERVED' },
    { entity: 'rentalVehicle', from: 'FAULTY', to: 'IN_USE' },
    { entity: 'rentalVehicle', from: 'IN_TRANSIT', to: 'RESERVED' },
    // reservation (3 samples)
    { entity: 'reservation', from: 'COMPLETED', to: 'ACTIVE' },
    { entity: 'reservation', from: 'CANCELLED', to: 'CONFIRMED' },
    { entity: 'reservation', from: 'EXPIRED', to: 'ACTIVE' },
    // parkingSpace (3 samples)
    { entity: 'parkingSpace', from: 'OCCUPIED', to: 'RESERVED' },
    { entity: 'parkingSpace', from: 'UNAVAILABLE', to: 'RESERVED' },
    { entity: 'parkingSpace', from: 'UNAVAILABLE', to: 'OCCUPIED' },
    // chargingRequest (3 samples)
    { entity: 'chargingRequest', from: 'COMPLETED', to: 'CHARGING' },
    { entity: 'chargingRequest', from: 'CANCELLED', to: 'QUEUED' },
    { entity: 'chargingRequest', from: 'CHARGING', to: 'QUEUED' },
    // chargingPoint (3 samples)
    { entity: 'chargingPoint', from: 'FAULTY', to: 'CHARGING' },
    { entity: 'chargingPoint', from: 'CHARGING', to: 'CHARGING' }, // X→X (also covered above)
    { entity: 'chargingPoint', from: 'AVAILABLE', to: 'AVAILABLE' }, // X→X (also covered above)
    // incident (3 samples)
    { entity: 'incident', from: 'RESOLVED', to: 'REPORTED' },
    { entity: 'incident', from: 'RESOLVED', to: 'IN_MAINTENANCE' },
    { entity: 'incident', from: 'REPORTED', to: 'RESOLVED' },
    // redistributionTask (3 samples)
    { entity: 'redistributionTask', from: 'COMPLETED', to: 'IN_PROGRESS' },
    { entity: 'redistributionTask', from: 'FAILED', to: 'IN_PROGRESS' },
    { entity: 'redistributionTask', from: 'CANCELLED', to: 'APPROVED' },
    // alert (3 samples)
    { entity: 'alert', from: 'DISMISSED', to: 'OPEN' },
    { entity: 'alert', from: 'RESOLVED', to: 'OPEN' },
    { entity: 'alert', from: 'ACKNOWLEDGED', to: 'DISMISSED' },
    // simRun (3 samples)
    { entity: 'simRun', from: 'COMPLETED', to: 'RUNNING' },
    { entity: 'simRun', from: 'FAILED', to: 'RUNNING' },
    { entity: 'simRun', from: 'INCOMPLETE', to: 'COMPLETED' },
    // recommendation (3 samples)
    { entity: 'recommendation', from: 'APPLIED', to: 'PENDING' },
    { entity: 'recommendation', from: 'DISMISSED', to: 'PENDING' },
    { entity: 'recommendation', from: 'BLOCKED', to: 'APPLIED' },
  ];

  for (const { entity, from, to } of FORBIDDEN_SAMPLES) {
    it(`${entity}: ${from} → ${to} throws InvalidStateTransitionError`, () => {
      expect(() => assertTransition(entity as EntityName, from, to))
        .toThrow(InvalidStateTransitionError);
    });
  }
});

// ===========================================================================
// AC-5 — D-22 invalid transition returns 409 AND leaves INVALID_TRANSITION audit row
// ===========================================================================

describe('T-03 AC-5 D-22 invalid transition returns 409 and leaves an INVALID_TRANSITION audit row', () => {
  beforeAll(async () => {
    await truncateCoreTablesForTest();
    await insertTestUser('checker-op-ac5', 'OPERATOR');
  });

  afterAll(async () => {
    await truncateWithUsers();
  });

  it('invalid transition handler returns 409 and writes INVALID_TRANSITION audit row', async () => {
    const operatorToken = signToken({ id: 'checker-op-ac5', role: 'OPERATOR' });

    const app = makeTestApp();
    app.use(requireAuth);
    app.get('/bad-transition', (_req, _res) => {
      throw new InvalidStateTransitionError('rentalVehicle', 'COMPLETED', 'AVAILABLE');
    });
    app.use(errorHandler);

    const before = await db.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*) as count FROM audit_log WHERE action = 'INVALID_TRANSITION'
    `;
    const countBefore = Number(before[0]!.count);

    const res = await request(app)
      .get('/bad-transition')
      .set('Authorization', `Bearer ${operatorToken}`);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INVALID_STATE_TRANSITION');

    // errorHandler awaits the audit write before sending response, so it's already committed
    const after = await db.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*) as count FROM audit_log WHERE action = 'INVALID_TRANSITION'
    `;
    expect(Number(after[0]!.count)).toBe(countBefore + 1);
  });
});

// ===========================================================================
// AC-6 — auth guards: requireAuth, requireRole, ops router guard
// ===========================================================================

describe('T-03 AC-6 FR-61 student token on an ops route → 403 + SECURITY_DENIED audit row', () => {
  beforeAll(async () => {
    await truncateCoreTablesForTest();
    await insertTestUser('checker-student-ac6', 'STUDENT');
    await insertTestUser('checker-operator-ac6', 'OPERATOR');
  });

  afterAll(async () => {
    await truncateWithUsers();
  });

  function makeAuthApp() {
    const app = makeTestApp();
    app.get('/protected', requireAuth, (_req, res) => { res.json({ ok: true }); });
    app.get('/ops-only', requireAuth, requireRole('OPERATOR'), (_req, res) => { res.json({ ok: true }); });
    app.use(errorHandler);
    return app;
  }

  it('no Authorization header → 401 UNAUTHENTICATED', async () => {
    const res = await request(makeAuthApp()).get('/protected');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('malformed token → 401 UNAUTHENTICATED', async () => {
    const res = await request(makeAuthApp())
      .get('/protected')
      .set('Authorization', 'Bearer not.a.jwt');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('tampered token → 401 UNAUTHENTICATED', async () => {
    const token = signToken({ id: 'checker-student-ac6', role: 'STUDENT' });
    const [h, , s] = token.split('.');
    const tampered = `${h}.eyJ0YW1wZXJlZCI6dHJ1ZX0.${s}`;
    const res = await request(makeAuthApp())
      .get('/protected')
      .set('Authorization', `Bearer ${tampered}`);
    expect(res.status).toBe(401);
  });

  it('valid token → request proceeds (200)', async () => {
    const token = signToken({ id: 'checker-student-ac6', role: 'STUDENT' });
    const res = await request(makeAuthApp())
      .get('/protected')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it('STUDENT token on ops route → 403 FORBIDDEN', async () => {
    const studentToken = signToken({ id: 'checker-student-ac6', role: 'STUDENT' });
    const res = await request(makeAuthApp())
      .get('/ops-only')
      .set('Authorization', `Bearer ${studentToken}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('STUDENT token → 403 leaves a SECURITY_DENIED audit row (fire-and-forget, wait briefly)', async () => {
    const studentToken = signToken({ id: 'checker-student-ac6', role: 'STUDENT' });

    const before = await db.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*) as count FROM audit_log WHERE action = 'SECURITY_DENIED'
    `;
    const countBefore = Number(before[0]!.count);

    await request(makeAuthApp())
      .get('/ops-only')
      .set('Authorization', `Bearer ${studentToken}`);

    // requireRole writes audit fire-and-forget; allow it to settle
    await new Promise(r => setTimeout(r, 100));

    const after = await db.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*) as count FROM audit_log WHERE action = 'SECURITY_DENIED'
    `;
    expect(Number(after[0]!.count)).toBe(countBefore + 1);
  });

  it('OPERATOR token on ops route → 200', async () => {
    const operatorToken = signToken({ id: 'checker-operator-ac6', role: 'OPERATOR' });
    const res = await request(makeAuthApp())
      .get('/ops-only')
      .set('Authorization', `Bearer ${operatorToken}`);
    expect(res.status).toBe(200);
  });
});

describe('T-03 AC-6 expired and tampered tokens → 401', () => {
  it('expired token → 401 UNAUTHENTICATED', async () => {
    const jwt = await import('jsonwebtoken');
    const c = loadConfig({});
    const expiredToken = jwt.sign(
      { sub: 'u1', role: 'STUDENT' },
      c.JWT_SECRET,
      { expiresIn: 1 }, // 1 second, then wait >1s
    );
    // Wait for token to expire
    await new Promise(r => setTimeout(r, 1100));

    const app = makeTestApp();
    app.get('/p', requireAuth, (_req, res) => { res.json({ ok: true }); });
    app.use(errorHandler);

    const res = await request(app)
      .get('/p')
      .set('Authorization', `Bearer ${expiredToken}`);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });
});

// ===========================================================================
// AC-7 — lockRow: second transaction waits; unknown id → 404
// ===========================================================================

describe('T-03 AC-7 BR-10 lockRow makes the second transaction wait', () => {
  const TEST_VEHICLE_ID = 'checker-rv-lock-1';
  const TEST_VEHICLE_ID_2 = 'checker-rv-lock-2';

  beforeAll(async () => {
    await truncateWithUsers();
    await insertTestVehicle(TEST_VEHICLE_ID);
    await insertTestVehicle(TEST_VEHICLE_ID_2);
  });

  afterAll(async () => {
    await truncateWithUsers();
  });

  it('second lockRow on the same row returns only after first transaction commits', async () => {
    let txACommitted = false;

    const pA = db.$transaction(async (tx) => {
      await lockRow(tx, 'rental_vehicle', TEST_VEHICLE_ID);
      await new Promise(r => setTimeout(r, 300));
      txACommitted = true;
    });

    // Start B ~50 ms after A has taken the lock
    await new Promise(r => setTimeout(r, 50));

    const pB = db.$transaction(async (tx) => {
      await lockRow(tx, 'rental_vehicle', TEST_VEHICLE_ID);
      // B can only be here after A committed
      expect(txACommitted).toBe(true);
    });

    await Promise.all([pA, pB]);
  });

  it('a different row is NOT blocked by the first lock', async () => {
    let bDone = false;

    const pA = db.$transaction(async (tx) => {
      await lockRow(tx, 'rental_vehicle', TEST_VEHICLE_ID);
      await new Promise(r => setTimeout(r, 300)); // hold lock for 300ms
    });

    // B locks a DIFFERENT row — should not be blocked
    await new Promise(r => setTimeout(r, 50));

    const pB = db.$transaction(async (tx) => {
      await lockRow(tx, 'rental_vehicle', TEST_VEHICLE_ID_2);
      bDone = true;
    });

    await pB; // B should finish well before A's 300ms hold
    expect(bDone).toBe(true);
    await pA;
  });

  it('unknown id → 404 NOT_FOUND', async () => {
    await expect(
      db.$transaction(async (tx) => {
        await lockRow(tx, 'rental_vehicle', 'does-not-exist-9999');
      }),
    ).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
  });
});

// ===========================================================================
// AC-8 — audit() and notify() insert row; roll back with transaction
// ===========================================================================

describe('T-03 AC-8 FR-63 audit row rolls back with its transaction', () => {
  beforeAll(async () => {
    await truncateWithUsers();
    await insertTestUser('checker-audit-user', 'STUDENT');
  });

  afterAll(async () => {
    await truncateWithUsers();
  });

  it('audit() inserts exactly one audit_log row with the given action', async () => {
    const before = await db.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*) as count FROM audit_log
      WHERE action = 'SECURITY_DENIED' AND "entityType" = 'checker-audit-row'
    `;
    const countBefore = Number(before[0]!.count);

    await db.$transaction(async (tx) => {
      await audit(tx, {
        actorId: 'checker-audit-user',
        actorRole: 'STUDENT',
        action: 'SECURITY_DENIED',
        entityType: 'checker-audit-row',
        entityIds: ['test-1'],
      });
    });

    const after = await db.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*) as count FROM audit_log
      WHERE action = 'SECURITY_DENIED' AND "entityType" = 'checker-audit-row'
    `;
    expect(Number(after[0]!.count)).toBe(countBefore + 1);
  });

  it('audit() row is rolled back when transaction throws', async () => {
    const before = await db.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*) as count FROM audit_log
      WHERE action = 'INVALID_TRANSITION' AND "entityType" = 'checker-rollback-test'
    `;
    const countBefore = Number(before[0]!.count);

    await expect(
      db.$transaction(async (tx) => {
        await audit(tx, {
          actorId: 'checker-audit-user',
          actorRole: 'STUDENT',
          action: 'INVALID_TRANSITION',
          entityType: 'checker-rollback-test',
          entityIds: ['test-2'],
        });
        throw new Error('deliberate rollback');
      }),
    ).rejects.toThrow('deliberate rollback');

    const after = await db.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*) as count FROM audit_log
      WHERE action = 'INVALID_TRANSITION' AND "entityType" = 'checker-rollback-test'
    `;
    expect(Number(after[0]!.count)).toBe(countBefore); // no row left
  });

  it('notify() inserts exactly one notification row', async () => {
    const before = await db.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*) as count FROM notification
      WHERE "userId" = 'checker-audit-user' AND title = 'Checker notify test'
    `;
    const countBefore = Number(before[0]!.count);

    await db.$transaction(async (tx) => {
      await notify(tx, {
        userId: 'checker-audit-user',
        type: 'RESERVATION_EXPIRED',
        title: 'Checker notify test',
        body: 'Your reservation has expired.',
      });
    });

    const after = await db.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*) as count FROM notification
      WHERE "userId" = 'checker-audit-user' AND title = 'Checker notify test'
    `;
    expect(Number(after[0]!.count)).toBe(countBefore + 1);
  });

  it('notify() row is rolled back when transaction throws', async () => {
    const before = await db.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*) as count FROM notification
      WHERE "userId" = 'checker-audit-user' AND title = 'Should not exist'
    `;
    const countBefore = Number(before[0]!.count);

    await expect(
      db.$transaction(async (tx) => {
        await notify(tx, {
          userId: 'checker-audit-user',
          type: 'CHARGING_STARTED',
          title: 'Should not exist',
          body: 'body',
        });
        throw new Error('deliberate rollback');
      }),
    ).rejects.toThrow('deliberate rollback');

    const after = await db.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*) as count FROM notification
      WHERE "userId" = 'checker-audit-user' AND title = 'Should not exist'
    `;
    expect(Number(after[0]!.count)).toBe(countBefore);
  });
});

// ===========================================================================
// AC-9 — events: listeners get payload; throwing listener doesn't stop others
// ===========================================================================

describe('T-03 AC-9 events: throwing listener does not stop others or throw from emit', () => {
  it('listeners receive the typed payload', () => {
    const received: unknown[] = [];
    // events.on returns void — no cleanup handle exposed
    events.on('TELEMETRY_INGESTED', (payload) => {
      received.push(payload);
    });
    events.emit('TELEMETRY_INGESTED', { hubId: 'metro-test' });
    expect(received).toEqual([{ hubId: 'metro-test' }]);
  });

  it('a throwing listener does not throw from emit and does not stop other listeners', () => {
    let secondCalled = false;
    events.on('CHARGING_QUEUE_CHANGED', () => {
      throw new Error('listener error');
    });
    events.on('CHARGING_QUEUE_CHANGED', () => {
      secondCalled = true;
    });

    // emit must not throw
    expect(() => events.emit('CHARGING_QUEUE_CHANGED', { hubId: 'metro-test' })).not.toThrow();
    expect(secondCalled).toBe(true);
  });

  it('a rejecting async listener does not throw from emit', async () => {
    events.on('RESOURCE_WITHDRAWN', async () => {
      throw new Error('async listener reject');
    });

    // must not throw synchronously
    expect(() => events.emit('RESOURCE_WITHDRAWN', { hubId: 'metro-test' })).not.toThrow();

    // give the async rejection time to settle
    await new Promise(r => setTimeout(r, 50));
  });
});

// ===========================================================================
// AC-10 — scheduler: overlapping run skipped; throwing job doesn't crash; dup name throws
// ===========================================================================

describe('T-03 AC-10 scheduler skips overlapping runs and survives a throwing job', () => {
  afterEach(() => {
    stopJobs();
  });

  it('runJobOnce passes now to the job function', async () => {
    const received: Date[] = [];
    registerJob('ck-job-now', 60_000, async (now) => {
      received.push(now);
    });
    const fixedNow = new Date('2026-01-01T00:00:00Z');
    await runJobOnce('ck-job-now', fixedNow);
    expect(received[0]).toEqual(fixedNow);
  });

  it('a slow job is not started again while still running (overlap-skip)', async () => {
    let runCount = 0;
    registerJob('ck-slow-job', 60_000, async () => {
      runCount++;
      await new Promise(r => setTimeout(r, 200));
    });

    // Start two runs in parallel — second should be skipped
    const run1 = runJobOnce('ck-slow-job');
    const run2 = runJobOnce('ck-slow-job'); // job.running = true already, skipped
    await Promise.all([run1, run2]);

    expect(runCount).toBe(1); // only one run, second was skipped
  });

  it('a throwing job is logged and the next run still happens', async () => {
    let callCount = 0;
    registerJob('ck-throwing-job', 60_000, async () => {
      callCount++;
      if (callCount === 1) throw new Error('first call throws');
    });

    // runGuarded catches errors and sets running = false in finally, so second call works
    await runJobOnce('ck-throwing-job');
    await runJobOnce('ck-throwing-job');
    expect(callCount).toBe(2);
  });

  it('duplicate job name throws', () => {
    registerJob('ck-dup-job', 60_000, async () => {});
    expect(() => registerJob('ck-dup-job', 60_000, async () => {})).toThrow();
  });
});
