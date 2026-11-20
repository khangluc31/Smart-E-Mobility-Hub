import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app';

const app = createApp();

describe('Health endpoint', () => {
  it('T-01 AC-4: health returns ok with db ok, boolean jobsEnabled and ISO serverNow', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.db).toBe('ok');
    expect(typeof res.body.jobsEnabled).toBe('boolean');
    // serverNow is a valid ISO-8601 string
    expect(() => new Date(res.body.serverNow).toISOString()).not.toThrow();
    expect(new Date(res.body.serverNow).toISOString()).toBe(res.body.serverNow);
  });

  it('T-01 AC-5: health returns 503 DB_UNAVAILABLE when the db query throws', async () => {
    // Dynamically import db to mock it
    const dbModule = await import('../src/core/db');
    const spy = vi.spyOn(dbModule.db, '$queryRawUnsafe').mockRejectedValueOnce(new Error('connection refused'));

    const res = await request(app).get('/api/health');
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('DB_UNAVAILABLE');
    expect(res.body.error.message).toBeTruthy();
    expect(Array.isArray(res.body.error.nextActions)).toBe(true);
    expect(res.body.error.nextActions.length).toBeGreaterThan(0);

    spy.mockRestore();
  });
});

describe('404 handler', () => {
  it('T-01 AC-6: unknown route returns 404 NOT_FOUND in the standard error shape', async () => {
    const res = await request(app).get('/api/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(res.body.error.message).toBeTruthy();
    expect(Array.isArray(res.body.error.nextActions)).toBe(true);
    expect(res.body.error.nextActions.length).toBeGreaterThan(0);
  });
});

describe('CORS', () => {
  it('T-01 AC-7: CORS header present for CORS_ORIGIN', async () => {
    const res = await request(app)
      .get('/api/health')
      .set('Origin', 'http://localhost:5173');
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
  });

  it('T-01 AC-7: CORS header absent for another origin', async () => {
    const res = await request(app)
      .get('/api/health')
      .set('Origin', 'http://evil.example.com');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});
