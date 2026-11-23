// Checker tests for T-09 (auth module).
// Written BEFORE reading the writer's code, from:
//   SPEC §6 FR-29, FR-60, FR-61  ·  ARCHITECTURE §4.4, §4.5
//   CONTRACTS §0, §1, §2  ·  TASKS.md T-09 AC table
//
// Checker: Sonnet 4.6 Medium

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createTestApp, resetDb, loginAs } from './helpers';
import { db } from '../src/core/db';
import type { Application } from 'express';

let app: Application;

beforeAll(() => {
  app = createTestApp();
});

beforeEach(async () => {
  await resetDb();
});

// ---------------------------------------------------------------------------
// FR-29 AC-1: register creates a STUDENT, bcrypt hash stored, token works
// ---------------------------------------------------------------------------
describe('FR-29 AC-1 register creates a student with a bcrypt hash and a working token', () => {
  it('FR-29 AC-1 register returns 201 with token and User (role STUDENT)', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ identifier: 'newstudent', password: 'Pass1234', displayName: 'New Student' });
    expect(res.status).toBe(201);
    expect(res.body.token).toBeTruthy();
    expect(res.body.user.role).toBe('STUDENT');
    expect(res.body.user.identifier).toBe('newstudent');
    expect(res.body.user.displayName).toBe('New Student');
    expect(res.body.user.mustChangePassword).toBe(false);
    // must never leak the hash
    expect(res.body.user.passwordHash).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain('passwordHash');
  });

  it('FR-29 AC-1 token returned from register works on GET /auth/me', async () => {
    const reg = await request(app)
      .post('/api/auth/register')
      .send({ identifier: 'newstudent2', password: 'Pass1234', displayName: 'NS2' });
    const { token } = reg.body as { token: string };

    const me = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${token}`);
    expect(me.status).toBe(200);
    expect(me.body.identifier).toBe('newstudent2');
  });

  it('FR-29 AC-1 DB stores a bcrypt hash not the plain password', async () => {
    await request(app)
      .post('/api/auth/register')
      .send({ identifier: 'hashcheck', password: 'Pass1234', displayName: 'Hash Check' });

    const row = await db.user.findUnique({ where: { identifier: 'hashcheck' } });
    expect(row).not.toBeNull();
    // bcrypt hashes start with $2b$ or $2a$
    expect(row!.passwordHash).toMatch(/^\$2[ab]\$/);
    expect(row!.passwordHash).not.toBe('Pass1234');
  });
});

// ---------------------------------------------------------------------------
// FR-29 AC-2: duplicate identifier → 409; concurrent → one 201 one 409
// ---------------------------------------------------------------------------
describe('FR-29 AC-2 duplicate identifier → 409 IDENTIFIER_TAKEN', () => {
  it('FR-29 AC-2 second register with same identifier → 409 IDENTIFIER_TAKEN', async () => {
    await request(app)
      .post('/api/auth/register')
      .send({ identifier: 'dupuser', password: 'Pass1234', displayName: 'Dup User' });

    const res = await request(app)
      .post('/api/auth/register')
      .send({ identifier: 'dupuser', password: 'Different1', displayName: 'Other' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('IDENTIFIER_TAKEN');
    expect(res.body.error.nextActions).toBeDefined();
    expect(res.body.error.nextActions.length).toBeGreaterThan(0);
  });

  it('FR-29 AC-2 concurrent duplicate registers → exactly one 201 and one 409', async () => {
    const [a, b] = await Promise.all([
      request(app).post('/api/auth/register').send({ identifier: 'concuser', password: 'Pass1234', displayName: 'A' }),
      request(app).post('/api/auth/register').send({ identifier: 'concuser', password: 'Pass1234', displayName: 'B' }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([201, 409]);
    // exactly one user in the DB
    const count = await db.user.count({ where: { identifier: 'concuser' } });
    expect(count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// FR-60 AC-3: register with role OPERATOR → 403, nothing created, audited
// ---------------------------------------------------------------------------
describe('FR-60 AC-3 register with role OPERATOR → 403 FORBIDDEN', () => {
  it('FR-60 AC-3 body with role: OPERATOR → 403 FORBIDDEN', async () => {
    const before = await db.user.count();
    const res = await request(app)
      .post('/api/auth/register')
      .send({ identifier: 'wannabeop', password: 'Pass1234', displayName: 'Wanna', role: 'OPERATOR' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(res.body.error.nextActions).toBeDefined();
    // no user created
    const after = await db.user.count();
    expect(after).toBe(before);
  });

  it('FR-60 AC-3 SECURITY_DENIED audit row written after role OPERATOR register attempt', async () => {
    await request(app)
      .post('/api/auth/register')
      .send({ identifier: 'audittest', password: 'Pass1234', displayName: 'Audit', role: 'OPERATOR' });

    const audit = await db.auditLog.findFirst({
      where: { action: 'SECURITY_DENIED' },
      orderBy: { id: 'desc' },
    });
    expect(audit).not.toBeNull();
  });

  it('FR-60 AC-3 body with role: STUDENT is accepted → 201', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ identifier: 'studentrole', password: 'Pass1234', displayName: 'SR', role: 'STUDENT' });
    expect(res.status).toBe(201);
    expect(res.body.user.role).toBe('STUDENT');
  });
});

// ---------------------------------------------------------------------------
// FR-29 AC-4: validation boundaries
// ---------------------------------------------------------------------------
describe('FR-29 AC-4 validation boundaries', () => {
  it('FR-29 AC-4 identifier 2 chars → 400 VALIDATION_ERROR', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ identifier: 'ab', password: 'Pass1234', displayName: 'X' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details?.field).toMatch(/identifier/i);
  });

  it('FR-29 AC-4 identifier 3 chars → 201 (boundary accepted)', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ identifier: 'abc', password: 'Pass1234', displayName: 'X' });
    expect(res.status).toBe(201);
  });

  it('FR-29 AC-4 identifier 64 chars → 201 (boundary accepted)', async () => {
    const id64 = 'a'.repeat(64);
    const res = await request(app)
      .post('/api/auth/register')
      .send({ identifier: id64, password: 'Pass1234', displayName: 'X' });
    expect(res.status).toBe(201);
  });

  it('FR-29 AC-4 identifier 65 chars → 400 VALIDATION_ERROR', async () => {
    const id65 = 'a'.repeat(65);
    const res = await request(app)
      .post('/api/auth/register')
      .send({ identifier: id65, password: 'Pass1234', displayName: 'X' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('FR-29 AC-4 password 7 chars → 400 VALIDATION_ERROR', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ identifier: 'pwtest1', password: 'Pass123', displayName: 'X' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('FR-29 AC-4 password without digit → 400 VALIDATION_ERROR', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ identifier: 'pwtest2', password: 'PasswordOnly', displayName: 'X' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('FR-29 AC-4 password without letter → 400 VALIDATION_ERROR', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ identifier: 'pwtest3', password: '12345678', displayName: 'X' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('FR-29 AC-4 missing displayName → 400 VALIDATION_ERROR', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ identifier: 'nodisplay', password: 'Pass1234' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('FR-29 AC-4 no user created on validation failure', async () => {
    const before = await db.user.count();
    await request(app)
      .post('/api/auth/register')
      .send({ identifier: 'ab', password: 'Pass1234', displayName: 'X' });
    const after = await db.user.count();
    expect(after).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// UC-16 AC-5: login success and identical 401 for unknown user / wrong password
// ---------------------------------------------------------------------------
describe('UC-16 AC-5 login success and identical 401 for unknown user / wrong password', () => {
  beforeEach(async () => {
    // create a user we can log in as
    await request(app)
      .post('/api/auth/register')
      .send({ identifier: 'loginuser', password: 'Pass1234', displayName: 'Login User' });
  });

  it('UC-16 AC-5 correct credentials → 200 with token and user', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ identifier: 'loginuser', password: 'Pass1234' });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
    expect(res.body.user.identifier).toBe('loginuser');
    expect(res.body.user.role).toBe('STUDENT');
    expect(JSON.stringify(res.body)).not.toContain('passwordHash');
  });

  it('UC-16 AC-5 seeded operator logs in and gets role OPERATOR', async () => {
    // The fixture creates operator1 with passwordHash '$placeholder$'
    // — we need a real hash. Create a fresh operator via the DB directly.
    const bcryptjs = await import('bcryptjs');
    const hash = await bcryptjs.hash('SecretOp1', 10);
    await db.user.upsert({
      where: { id: 'op-login-test' },
      update: { passwordHash: hash },
      create: { id: 'op-login-test', identifier: 'optest', passwordHash: hash, displayName: 'Op Test', role: 'OPERATOR' },
    });

    const res = await request(app)
      .post('/api/auth/login')
      .send({ identifier: 'optest', password: 'SecretOp1' });
    expect(res.status).toBe(200);
    expect(res.body.user.role).toBe('OPERATOR');
  });

  it('UC-16 AC-5 wrong password → 401 INVALID_CREDENTIALS', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ identifier: 'loginuser', password: 'WrongPass1' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
    expect(res.body.error.nextActions).toBeDefined();
  });

  it('UC-16 AC-5 unknown identifier → same 401 INVALID_CREDENTIALS body', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ identifier: 'nobody_at_all', password: 'Pass1234' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('UC-16 AC-5 wrong password and unknown identifier return identical response body structure', async () => {
    const resWrong = await request(app)
      .post('/api/auth/login')
      .send({ identifier: 'loginuser', password: 'WrongPass1' });
    const resUnknown = await request(app)
      .post('/api/auth/login')
      .send({ identifier: 'nobody_at_all', password: 'Pass1234' });
    // codes must be identical
    expect(resWrong.body.error.code).toBe(resUnknown.body.error.code);
    expect(resWrong.body.error.message).toBe(resUnknown.body.error.message);
  });
});

// ---------------------------------------------------------------------------
// UC-16 AC-6: me requires a valid token and never exposes passwordHash
// ---------------------------------------------------------------------------
describe('UC-16 AC-6 me requires a valid token and never exposes passwordHash', () => {
  it('UC-16 AC-6 no token → 401 UNAUTHENTICATED', async () => {
    const res = await request(app).get('/api/auth/me');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('UC-16 AC-6 malformed token → 401 UNAUTHENTICATED', async () => {
    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', 'Bearer not.a.real.token');
    expect(res.status).toBe(401);
  });

  it('UC-16 AC-6 valid token → 200 User without passwordHash', async () => {
    const reg = await request(app)
      .post('/api/auth/register')
      .send({ identifier: 'meuser', password: 'Pass1234', displayName: 'Me User' });
    const { token } = reg.body as { token: string };

    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.identifier).toBe('meuser');
    expect(res.body.passwordHash).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain('passwordHash');
  });

  it('UC-16 AC-6 response has exactly the CONTRACTS §1 User fields', async () => {
    const reg = await request(app)
      .post('/api/auth/register')
      .send({ identifier: 'meuser2', password: 'Pass1234', displayName: 'Me User 2' });
    const { token } = reg.body as { token: string };

    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${token}`);
    const user = res.body as Record<string, unknown>;
    // required fields
    expect(typeof user.id).toBe('string');
    expect(typeof user.identifier).toBe('string');
    expect(typeof user.displayName).toBe('string');
    expect(user.role === 'STUDENT' || user.role === 'OPERATOR').toBe(true);
    expect(typeof user.mustChangePassword).toBe('boolean');
  });
});

// ---------------------------------------------------------------------------
// UC-16 AC-7: change password rules and effect
// ---------------------------------------------------------------------------
describe('UC-16 AC-7 change password rules and effect', () => {
  let userToken: string;

  beforeEach(async () => {
    const reg = await request(app)
      .post('/api/auth/register')
      .send({ identifier: 'changepwuser', password: 'OldPass1', displayName: 'CP User' });
    userToken = (reg.body as { token: string }).token;
  });

  it('UC-16 AC-7 wrong currentPassword → 400 with details.field: currentPassword', async () => {
    const res = await request(app)
      .post('/api/auth/change-password')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ currentPassword: 'WrongOld1', newPassword: 'NewPass1' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details?.field).toMatch(/currentPassword/i);
  });

  it('UC-16 AC-7 weak newPassword → 400 VALIDATION_ERROR', async () => {
    const res = await request(app)
      .post('/api/auth/change-password')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ currentPassword: 'OldPass1', newPassword: 'weak' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('UC-16 AC-7 newPassword same as current → 400 VALIDATION_ERROR', async () => {
    const res = await request(app)
      .post('/api/auth/change-password')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ currentPassword: 'OldPass1', newPassword: 'OldPass1' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('UC-16 AC-7 successful change → 204, old password no longer works', async () => {
    const changeRes = await request(app)
      .post('/api/auth/change-password')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ currentPassword: 'OldPass1', newPassword: 'NewPass2' });
    expect(changeRes.status).toBe(204);

    // old password no longer works
    const loginOld = await request(app)
      .post('/api/auth/login')
      .send({ identifier: 'changepwuser', password: 'OldPass1' });
    expect(loginOld.status).toBe(401);
  });

  it('UC-16 AC-7 successful change → new password works', async () => {
    await request(app)
      .post('/api/auth/change-password')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ currentPassword: 'OldPass1', newPassword: 'NewPass2' });

    const loginNew = await request(app)
      .post('/api/auth/login')
      .send({ identifier: 'changepwuser', password: 'NewPass2' });
    expect(loginNew.status).toBe(200);
  });

  it('UC-16 AC-7 successful change clears mustChangePassword', async () => {
    // set mustChangePassword = true in the DB
    await db.user.updateMany({
      where: { identifier: 'changepwuser' },
      data: { mustChangePassword: true },
    });

    await request(app)
      .post('/api/auth/change-password')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ currentPassword: 'OldPass1', newPassword: 'NewPass2' });

    const row = await db.user.findFirst({ where: { identifier: 'changepwuser' } });
    expect(row?.mustChangePassword).toBe(false);
  });

  it('UC-16 AC-7 wrong current → 400, not 401 (must not log user out)', async () => {
    const res = await request(app)
      .post('/api/auth/change-password')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ currentPassword: 'WrongOld1', newPassword: 'NewPass2' });
    // must be 400, never 401
    expect(res.status).toBe(400);
    expect(res.status).not.toBe(401);
  });
});

// ---------------------------------------------------------------------------
// FR-61 AC-8: registered student gets 403 on /api/ops/*
// ---------------------------------------------------------------------------
describe('FR-61 AC-8 registered student gets 403 on /api/ops', () => {
  it('FR-61 AC-8 student token on GET /api/ops/telemetry/rejects → 403 FORBIDDEN', async () => {
    const reg = await request(app)
      .post('/api/auth/register')
      .send({ identifier: 'studentops', password: 'Pass1234', displayName: 'Student Ops' });
    const { token } = reg.body as { token: string };

    const res = await request(app)
      .get('/api/ops/telemetry/rejects')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(res.body.error.nextActions).toBeDefined();
  });

  it('FR-61 AC-8 fixture student1 token on /api/ops → 403', async () => {
    const res = await request(app)
      .get('/api/ops/telemetry/rejects')
      .set('Authorization', loginAs('student1'));
    expect(res.status).toBe(403);
  });

  it('FR-61 AC-8 operator1 token on /api/ops/telemetry/rejects → 200 (not blocked)', async () => {
    const res = await request(app)
      .get('/api/ops/telemetry/rejects')
      .set('Authorization', loginAs('operator1'));
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Error shape conformance (CONTRACTS §0, NFR-05)
// ---------------------------------------------------------------------------
describe('T-09 error shape conforms to CONTRACTS §0', () => {
  it('T-09 every 4xx has error.code, error.message and error.nextActions (register 400)', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ identifier: 'ab', password: 'Pass1234', displayName: 'X' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
    expect(typeof res.body.error.code).toBe('string');
    expect(typeof res.body.error.message).toBe('string');
    expect(Array.isArray(res.body.error.nextActions)).toBe(true);
    expect(res.body.error.nextActions.length).toBeGreaterThan(0);
  });

  it('T-09 every 4xx has error.code, error.message and error.nextActions (login 401)', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ identifier: 'nobody', password: 'Pass1234' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBeTruthy();
    expect(res.body.error.message).toBeTruthy();
    expect(Array.isArray(res.body.error.nextActions)).toBe(true);
    expect(res.body.error.nextActions.length).toBeGreaterThan(0);
  });

  it('T-09 every 4xx has error.code, error.message and error.nextActions (register 409)', async () => {
    await request(app)
      .post('/api/auth/register')
      .send({ identifier: 'shapechk', password: 'Pass1234', displayName: 'X' });
    const res = await request(app)
      .post('/api/auth/register')
      .send({ identifier: 'shapechk', password: 'Pass1234', displayName: 'Y' });
    expect(res.status).toBe(409);
    expect(res.body.error.nextActions.length).toBeGreaterThan(0);
  });
});
