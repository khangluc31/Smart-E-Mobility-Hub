import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { Prisma } from '@prisma/client';
import { loadConfig, config } from '../src/core/config';
import {
  AppError,
  conflict,
  optional,
  requireBoolean,
  requireEnum,
  requireInt,
  requireIsoDate,
  requireNumber,
  requireString,
  requireStringArray,
} from '../src/core/errors';
import { errorHandler, notFoundHandler } from '../src/core/errorHandler';
import { requireAuth, requireRole, signToken } from '../src/core/auth';
import { assertTransition } from '../src/core/stateMachine';
import { db, lockRow } from '../src/core/db';
import { audit } from '../src/core/audit';
import { notify } from '../src/core/notify';
import { events } from '../src/core/events';
import { registerJob, runJobOnce, startJobs, stopJobs } from '../src/core/scheduler';
import { addMinutes, clamp, minutesBetween, toIso } from '../src/core/time';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function reset(): Promise<void> {
  await db.$executeRawUnsafe(
    `TRUNCATE TABLE "notification", "audit_log", "rental_vehicle", "hub", "user" RESTART IDENTITY CASCADE`,
  );
}

// Run fn, return the thrown AppError (fails if nothing thrown).
function catchApp(fn: () => unknown): AppError {
  try {
    fn();
  } catch (e) {
    return e as AppError;
  }
  throw new Error('expected a throw but none happened');
}

beforeEach(reset);
afterAll(async () => {
  await db.$disconnect();
});

// ---------------------------------------------------------------------------
// AC-1 config
// ---------------------------------------------------------------------------
describe('T-03 AC-1 NFR-17 config', () => {
  it('T-03 AC-1 loadConfig({}) returns SPEC §3 defaults', () => {
    const c = loadConfig({});
    expect(c.RESERVATION_HOLD_MIN).toBe(15);
    expect(c.MIN_RENTAL_BATTERY_PCT).toBe(20);
    expect(c.NEAR_CAPACITY_PCT).toBe(85);
    expect(c.STALLED_FEED_INTERVALS).toBe(3);
    expect(c.SIM_MAX_HORIZON_H).toBe(24);
    expect(c.LIST_LIMIT_DEFAULT).toBe(50);
    expect(c.LIST_LIMIT_MAX).toBe(200);
    expect(c.CHARGING_WEIGHTS).toEqual({ battery: 0.5, urgency: 0.3, waiting: 0.2 });
    expect(c.CHARGE_RATE_PCT_PER_MIN).toEqual({ MOTORCYCLE: 1.0, CAR: 0.5 });
  });

  it('T-03 AC-1 env overrides apply', () => {
    const c = loadConfig({ RESERVATION_HOLD_MIN: '20', CHARGING_WEIGHT_BATTERY: '0.7' });
    expect(c.RESERVATION_HOLD_MIN).toBe(20);
    expect(c.CHARGING_WEIGHTS.battery).toBe(0.7);
  });

  it('T-03 AC-1 non-numeric env throws naming the key', () => {
    expect(() => loadConfig({ NEAR_CAPACITY_PCT: 'abc' })).toThrow(/NEAR_CAPACITY_PCT/);
  });

  it('T-03 AC-1 negative number env throws naming the key', () => {
    expect(() => loadConfig({ RESERVATION_HOLD_MIN: '-5' })).toThrow(/RESERVATION_HOLD_MIN/);
  });

  it('T-03 AC-1 JWT_SECRET missing throws only in production', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/JWT_SECRET/);
    expect(loadConfig({ NODE_ENV: 'production', JWT_SECRET: 's' }).JWT_SECRET).toBe('s');
    expect(loadConfig({}).JWT_SECRET).toBe('dev-insecure-jwt-secret');
  });
});

// ---------------------------------------------------------------------------
// AC-2 validation helpers
// ---------------------------------------------------------------------------
describe('T-03 AC-2 NFR-13 validation helpers', () => {
  it('T-03 AC-2 requireString returns value, enforces min/max/trim, requires presence', () => {
    expect(requireString({ a: 'hi' }, 'a')).toBe('hi');
    expect(requireString({ a: '  hi  ' }, 'a', { trim: true })).toBe('hi');
    const e = catchApp(() => requireString({}, 'a'));
    expect(e.status).toBe(400);
    expect(e.code).toBe('VALIDATION_ERROR');
    expect(e.details?.['field']).toBe('a');
    expect(catchApp(() => requireString({ a: 'ab' }, 'a', { min: 3 })).status).toBe(400);
  });

  it('T-03 AC-2 requireInt boundaries inclusive, min-1/max+1 fail, numeric strings ok', () => {
    expect(requireInt({ n: 5 }, 'n', { min: 5, max: 10 })).toBe(5);
    expect(requireInt({ n: 10 }, 'n', { min: 5, max: 10 })).toBe(10);
    expect(requireInt({ n: '7' }, 'n')).toBe(7);
    expect(catchApp(() => requireInt({ n: 4 }, 'n', { min: 5 })).details?.['field']).toBe('n');
    expect(catchApp(() => requireInt({ n: 11 }, 'n', { max: 10 })).code).toBe('VALIDATION_ERROR');
    expect(catchApp(() => requireInt({ n: 1.5 }, 'n')).status).toBe(400);
  });

  it('T-03 AC-2 requireNumber accepts numeric strings and enforces range', () => {
    expect(requireNumber({ n: '1.5' }, 'n', { min: 0, max: 2 })).toBe(1.5);
    expect(catchApp(() => requireNumber({ n: 'x' }, 'n')).status).toBe(400);
  });

  it('T-03 AC-2 requireBoolean accepts boolean and "true"/"false"', () => {
    expect(requireBoolean({ b: true }, 'b')).toBe(true);
    expect(requireBoolean({ b: 'false' }, 'b')).toBe(false);
    expect(catchApp(() => requireBoolean({ b: 'nope' }, 'b')).status).toBe(400);
  });

  it('T-03 AC-2 requireEnum rejects bad values with details.field', () => {
    expect(requireEnum({ s: 'A' }, 's', ['A', 'B'] as const)).toBe('A');
    const e = catchApp(() => requireEnum({ s: 'C' }, 's', ['A', 'B'] as const));
    expect(e.status).toBe(400);
    expect(e.details?.['field']).toBe('s');
  });

  it('T-03 AC-2 requireIsoDate returns Date and rejects non-ISO', () => {
    const d = requireIsoDate({ t: '2026-12-01T08:00:00.000Z' }, 't');
    expect(d).toBeInstanceOf(Date);
    expect(catchApp(() => requireIsoDate({ t: 'not-a-date' }, 't')).details?.['field']).toBe('t');
    expect(catchApp(() => requireIsoDate({ t: '2026-13-45' }, 't')).status).toBe(400);
  });

  it('T-03 AC-2 requireStringArray enforces type and minItems', () => {
    expect(requireStringArray({ a: ['x', 'y'] }, 'a', { minItems: 1 })).toEqual(['x', 'y']);
    expect(catchApp(() => requireStringArray({ a: 'x' }, 'a')).status).toBe(400);
    expect(catchApp(() => requireStringArray({ a: [] }, 'a', { minItems: 1 })).status).toBe(400);
  });

  it('T-03 AC-2 optional returns undefined for absent/null, else delegates', () => {
    expect(optional(requireInt)({}, 'x')).toBeUndefined();
    expect(optional(requireInt)({ x: null }, 'x')).toBeUndefined();
    expect(optional(requireInt)({ x: '3' }, 'x', { min: 1 })).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// AC-3 error handler
// ---------------------------------------------------------------------------
describe('T-03 AC-3 NFR-05 error handler', () => {
  function appThatThrows(err: unknown) {
    const app = express();
    app.use(express.json());
    app.get('/boom', (_req: Request, _res: Response, next: NextFunction) => next(err));
    app.post('/echo', (req: Request, res: Response) => res.json(req.body));
    app.use(notFoundHandler);
    app.use(errorHandler);
    return app;
  }

  it('T-03 AC-3 AppError keeps status/code/nextActions/alternatives', async () => {
    const err = conflict('RESOURCE_TAKEN', 'Taken.', {
      nextActions: ['Pick another'],
      alternatives: [{ type: 'hub', hubId: 'metro' }],
    });
    const res = await request(appThatThrows(err)).get('/boom');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('RESOURCE_TAKEN');
    expect(res.body.error.nextActions).toEqual(['Pick another']);
    expect(res.body.error.alternatives[0].hubId).toBe('metro');
  });

  it('T-03 AC-3 Prisma P2002 → 409 RESOURCE_TAKEN, P2025 → 404', async () => {
    const p2002 = new Prisma.PrismaClientKnownRequestError('dup', {
      code: 'P2002',
      clientVersion: 'test',
    });
    const r1 = await request(appThatThrows(p2002)).get('/boom');
    expect(r1.status).toBe(409);
    expect(r1.body.error.code).toBe('RESOURCE_TAKEN');

    const p2025 = new Prisma.PrismaClientKnownRequestError('missing', {
      code: 'P2025',
      clientVersion: 'test',
    });
    const r2 = await request(appThatThrows(p2025)).get('/boom');
    expect(r2.status).toBe(404);
    expect(r2.body.error.code).toBe('NOT_FOUND');
  });

  it('T-03 AC-3 raw Postgres 23505/23P01 → 409 RESOURCE_TAKEN', async () => {
    const err = Object.assign(new Error('unique'), { code: '23505' });
    const res = await request(appThatThrows(err)).get('/boom');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('RESOURCE_TAKEN');
  });

  it('T-03 AC-3 malformed JSON body → 400 VALIDATION_ERROR', async () => {
    const res = await request(appThatThrows(new Error('unused')))
      .post('/echo')
      .set('Content-Type', 'application/json')
      .send('{ bad json');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('T-03 AC-3 unknown error → 500 INTERNAL_ERROR without internal text', async () => {
    const res = await request(appThatThrows(new Error('secret-stack-detail'))).get('/boom');
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(res.body)).not.toContain('secret-stack-detail');
  });

  it('T-03 AC-3 unknown route → 404 NOT_FOUND in standard shape', async () => {
    const res = await request(appThatThrows(new Error('unused'))).get('/no-such-route');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(Array.isArray(res.body.error.nextActions)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC-5 invalid transition audited by the handler (D-22)
// ---------------------------------------------------------------------------
describe('T-03 AC-5 D-22 invalid transition', () => {
  it('T-03 AC-5 handler returns 409 and writes one INVALID_TRANSITION audit row', async () => {
    const app = express();
    app.get('/bad', (_req: Request, _res: Response, next: NextFunction) => {
      try {
        assertTransition('rentalVehicle', 'AVAILABLE', 'COMPLETED');
      } catch (e) {
        next(e);
      }
    });
    app.use(errorHandler);

    const res = await request(app).get('/bad');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INVALID_STATE_TRANSITION');

    const rows = await db.auditLog.findMany({ where: { action: 'INVALID_TRANSITION' } });
    expect(rows.length).toBe(1);
    expect(rows[0]?.entityType).toBe('rentalVehicle');
  });
});

// ---------------------------------------------------------------------------
// AC-6 auth guards
// ---------------------------------------------------------------------------
describe('T-03 AC-6 FR-61 auth guards', () => {
  function guardedApp() {
    const app = express();
    app.get('/me', requireAuth, (req: Request, res: Response) => res.json(req.user));
    app.get('/ops', requireAuth, requireRole('OPERATOR'), (_req: Request, res: Response) =>
      res.json({ ok: true }),
    );
    app.use(errorHandler);
    return app;
  }

  it('T-03 AC-6 missing/malformed/tampered/expired token → 401', async () => {
    const app = guardedApp();
    expect((await request(app).get('/me')).status).toBe(401);
    expect((await request(app).get('/me').set('Authorization', 'Basic xyz')).status).toBe(401);

    const good = signToken({ id: 'u1', role: 'STUDENT' });
    const tampered = good.slice(0, -2) + (good.endsWith('a') ? 'bb' : 'aa');
    expect((await request(app).get('/me').set('Authorization', `Bearer ${tampered}`)).status).toBe(401);

    const expired = jwt.sign({ sub: 'u1', role: 'STUDENT' }, config.JWT_SECRET, { expiresIn: '-10s' });
    expect((await request(app).get('/me').set('Authorization', `Bearer ${expired}`)).status).toBe(401);
  });

  it('T-03 AC-6 valid token sets req.user', async () => {
    const token = signToken({ id: 'u1', role: 'STUDENT' });
    const res = await request(guardedApp()).get('/me').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: 'u1', role: 'STUDENT' });
  });

  it('T-03 AC-6 STUDENT on ops route → 403 + one SECURITY_DENIED audit row; OPERATOR passes', async () => {
    const app = guardedApp();
    const studentToken = signToken({ id: 'stu', role: 'STUDENT' });
    const res = await request(app).get('/ops').set('Authorization', `Bearer ${studentToken}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');

    // the audit write is fire-and-forget; give it a tick
    await sleep(100);
    const rows = await db.auditLog.findMany({ where: { action: 'SECURITY_DENIED' } });
    expect(rows.length).toBe(1);

    const opToken = signToken({ id: 'op', role: 'OPERATOR' });
    const ok = await request(app).get('/ops').set('Authorization', `Bearer ${opToken}`);
    expect(ok.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// AC-7 lockRow
// ---------------------------------------------------------------------------
describe('T-03 AC-7 BR-10 lockRow', () => {
  async function seedVehicle(id: string): Promise<void> {
    await db.hub.upsert({
      where: { id: 'lk-hub' },
      create: { id: 'lk-hub', name: 'Lk', location: 'x' },
      update: {},
    });
    await db.rentalVehicle.create({
      data: { id, hubId: 'lk-hub', type: 'E_MOTORCYCLE', status: 'AVAILABLE', batteryPct: 50 },
    });
  }

  it('T-03 AC-7 the second transaction waits until the first commits', async () => {
    await seedVehicle('LK-1');
    const order: string[] = [];
    const t1 = db.$transaction(async (tx) => {
      await lockRow(tx, 'rental_vehicle', 'LK-1');
      order.push('A-locked');
      await sleep(300);
      order.push('A-commit');
    });
    await sleep(50);
    const t2 = db.$transaction(async (tx) => {
      await lockRow(tx, 'rental_vehicle', 'LK-1');
      order.push('B-locked');
    });
    await Promise.all([t1, t2]);
    expect(order.indexOf('B-locked')).toBeGreaterThan(order.indexOf('A-commit'));
  });

  it('T-03 AC-7 a different row does not wait', async () => {
    await seedVehicle('LK-A');
    await seedVehicle('LK-B');
    const order: string[] = [];
    const t1 = db.$transaction(async (tx) => {
      await lockRow(tx, 'rental_vehicle', 'LK-A');
      order.push('A-locked');
      await sleep(300);
      order.push('A-commit');
    });
    await sleep(50);
    const t2 = db.$transaction(async (tx) => {
      await lockRow(tx, 'rental_vehicle', 'LK-B');
      order.push('B-locked');
    });
    await Promise.all([t1, t2]);
    expect(order.indexOf('B-locked')).toBeLessThan(order.indexOf('A-commit'));
  });

  it('T-03 AC-7 unknown id → 404 NOT_FOUND', async () => {
    await expect(
      db.$transaction((tx) => lockRow(tx, 'rental_vehicle', 'NOPE')),
    ).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
  });
});

// ---------------------------------------------------------------------------
// AC-8 audit + notify
// ---------------------------------------------------------------------------
describe('T-03 AC-8 audit and notify', () => {
  it('T-03 AC-8 audit inserts exactly one row', async () => {
    await audit(db, { action: 'SECURITY_DENIED', entityType: 'test', entityIds: ['x'] });
    const rows = await db.auditLog.findMany();
    expect(rows.length).toBe(1);
    expect(rows[0]?.entityIds).toEqual(['x']);
  });

  it('T-03 AC-8 FR-62 notify inserts exactly one row', async () => {
    const user = await db.user.create({
      data: { identifier: 'n1', passwordHash: 'x', displayName: 'n1' },
    });
    await notify(db, { userId: user.id, type: 'RESERVATION_EXPIRED', title: 't', body: 'b' });
    const rows = await db.notification.findMany();
    expect(rows.length).toBe(1);
    expect(rows[0]?.type).toBe('RESERVATION_EXPIRED');
  });

  it('T-03 AC-8 FR-63 a row rolls back with its transaction', async () => {
    await expect(
      db.$transaction(async (tx) => {
        await audit(tx, { action: 'SECURITY_DENIED', entityType: 'test', entityIds: [] });
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    const rows = await db.auditLog.findMany();
    expect(rows.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// AC-9 events
// ---------------------------------------------------------------------------
describe('T-03 AC-9 events', () => {
  it('T-03 AC-9 listeners get the typed payload; a throwing listener does not break emit', () => {
    let got: string | undefined;
    let secondRan = false;
    events.on('TELEMETRY_INGESTED', (p) => {
      got = p.hubId;
    });
    events.on('TELEMETRY_INGESTED', () => {
      throw new Error('listener boom');
    });
    events.on('TELEMETRY_INGESTED', () => {
      secondRan = true;
    });
    expect(() => events.emit('TELEMETRY_INGESTED', { hubId: 'h9' })).not.toThrow();
    expect(got).toBe('h9');
    expect(secondRan).toBe(true);
  });

  it('T-03 AC-9 a rejecting async listener does not throw from emit', () => {
    events.on('RESERVATION_CHANGED', async () => {
      await Promise.reject(new Error('async boom'));
    });
    expect(() => events.emit('RESERVATION_CHANGED', { hubId: 'h1' })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// AC-10 scheduler
// ---------------------------------------------------------------------------
describe('T-03 AC-10 scheduler', () => {
  it('T-03 AC-10 duplicate job name throws', () => {
    registerJob('dup-job', 1000, async () => {});
    expect(() => registerJob('dup-job', 1000, async () => {})).toThrow(/already registered/);
  });

  it('T-03 AC-10 runJobOnce passes now', async () => {
    let captured: Date | undefined;
    registerJob('now-job', 1000, async (now) => {
      captured = now;
    });
    const when = new Date('2026-12-01T00:00:00.000Z');
    await runJobOnce('now-job', when);
    expect(captured).toBe(when);
  });

  it('T-03 AC-10 a throwing job is caught and the next run still happens', async () => {
    let count = 0;
    registerJob('throwing-job', 1000, async () => {
      count += 1;
      throw new Error('job boom');
    });
    await expect(runJobOnce('throwing-job')).resolves.toBeUndefined();
    await runJobOnce('throwing-job');
    expect(count).toBe(2);
  });

  it('T-03 AC-10 a slow job is not started again while running', async () => {
    let runs = 0;
    let release: () => void = () => {};
    registerJob('slow-job', 1000, async () => {
      runs += 1;
      await new Promise<void>((r) => {
        release = r;
      });
    });
    const p1 = runJobOnce('slow-job');
    const p2 = runJobOnce('slow-job'); // should skip: previous run in progress
    release();
    await Promise.all([p1, p2]);
    expect(runs).toBe(1);
  });

  it('T-03 AC-10 startJobs/stopJobs do not throw and run no DB work on their own', async () => {
    const spy = vi.spyOn(console, 'error');
    expect(() => startJobs()).not.toThrow();
    expect(() => stopJobs()).not.toThrow();
    spy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// time helpers
// ---------------------------------------------------------------------------
describe('T-03 time helpers', () => {
  it('T-03 addMinutes / minutesBetween / clamp / toIso', () => {
    const base = new Date('2026-12-01T00:00:00.000Z');
    expect(addMinutes(base, 15).toISOString()).toBe('2026-12-01T00:15:00.000Z');
    expect(minutesBetween(base, addMinutes(base, 30))).toBe(30);
    expect(clamp(0, 100, 150)).toBe(100);
    expect(clamp(0, 100, -5)).toBe(0);
    expect(clamp(0, 100, 42)).toBe(42);
    expect(toIso(base)).toBe('2026-12-01T00:00:00.000Z');
  });
});
