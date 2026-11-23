// Checker tests for T-10 (notifications module).
// Written BEFORE reading the writer's code, from:
//   SPEC §3 (LIST_LIMIT_DEFAULT / LIST_LIMIT_MAX), §6 FR-62
//   ARCHITECTURE §4.6, §5.1 (notification row)
//   CONTRACTS §0 (Ownership, Lists, Validation), §1 (Notification), §9
//   backend/src/core/notify.ts, backend/src/core/errors.ts
//   the T-10 section of .orchestration/TASKS.md
//
// Checker: Gemini (acting as Sonnet 4.6 Medium)

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import type { Application } from 'express';
import { createTestApp, resetDb, loginAs } from './helpers';
import { db } from '../src/core/db';
import { notify } from '../src/core/notify';
import { config } from '../src/core/config';
import type { Notification, NotificationList } from '../src/types/notifications';

let app: Application;
let student1Token: string;
let student2Token: string;
let operatorToken: string;

beforeAll(() => {
  app = createTestApp();
  student1Token = loginAs('student1');
  student2Token = loginAs('student2');
  operatorToken = loginAs('operator1');
});

beforeEach(async () => {
  await resetDb();
});

// ---------------------------------------------------------------------------
// FR-62 AC-1: notify() rows appear newest first with the Notification shape
// ---------------------------------------------------------------------------
describe('FR-62 AC-1 notify() rows appear newest first with the Notification shape', () => {
  it('FR-62 AC-1 notify() rows appear newest first with the Notification shape', async () => {
    const t1 = new Date('2026-05-01T10:00:00.000Z');
    const t2 = new Date('2026-05-01T10:05:00.000Z');

    await db.notification.create({
      data: {
        userId: 'student1',
        type: 'RESERVATION_CANCELLED',
        title: 'Oldest notif',
        body: 'Your reservation was cancelled',
        data: { reservationId: 'RES-01' },
        createdAt: t1,
      },
    });

    await db.notification.create({
      data: {
        userId: 'student1',
        type: 'CHARGING_STARTED',
        title: 'Middle notif',
        body: 'Charging has started',
        data: { requestId: 'CR-01' },
        createdAt: t2,
      },
    });

    // Also verify notify() from core/notify creates a row that appears
    await notify(db, {
      userId: 'student1',
      type: 'HUB_REDIRECT',
      title: 'Newest notif',
      body: 'Redirected to another hub',
      data: { hubId: 'dorm' },
    });

    const res = await request(app)
      .get('/api/notifications')
      .set('Authorization', student1Token);

    expect(res.status).toBe(200);
    const body: NotificationList = res.body;

    expect(body.items).toHaveLength(3);
    expect(body.unreadCount).toBe(3);
    expect(body.nextCursor).toBeNull();

    // Newest first
    expect(body.items[0]!.title).toBe('Newest notif');
    expect(body.items[1]!.title).toBe('Middle notif');
    expect(body.items[2]!.title).toBe('Oldest notif');

    // Matches CONTRACTS §1 Notification shape exactly (no userId)
    const item0 = body.items[0]!;
    expect(item0).toHaveProperty('id');
    expect(item0).toHaveProperty('type', 'HUB_REDIRECT');
    expect(item0).toHaveProperty('title', 'Newest notif');
    expect(item0).toHaveProperty('body', 'Redirected to another hub');
    expect(item0.data).toEqual({ hubId: 'dorm' });
    expect(item0.readAt).toBeNull();
    expect(typeof item0.createdAt).toBe('string');
    expect(new Date(item0.createdAt).toISOString()).toBe(item0.createdAt);
    expect(item0).not.toHaveProperty('userId');
  });
});

// ---------------------------------------------------------------------------
// FR-62 AC-2: another user's notification → 404 and stays unread
// ---------------------------------------------------------------------------
describe("FR-62 AC-2 another user's notification → 404 and stays unread", () => {
  it("FR-62 AC-2 another user's notification → 404 and stays unread", async () => {
    // Create notification for student2
    await notify(db, {
      userId: 'student2',
      type: 'RESERVATION_EXPIRED',
      title: 'Student 2 alert',
      body: 'Your hold has expired',
    });

    const bRows = await db.notification.findMany({ where: { userId: 'student2' } });
    expect(bRows).toHaveLength(1);
    const bNotifId = bRows[0]!.id;

    // Student 2 can see their own notification
    const bListRes = await request(app)
      .get('/api/notifications')
      .set('Authorization', student2Token);
    expect(bListRes.status).toBe(200);
    expect(bListRes.body.items).toHaveLength(1);
    expect(bListRes.body.unreadCount).toBe(1);

    // Student 1 lists notifications - must not see Student 2's notification
    const listRes = await request(app)
      .get('/api/notifications')
      .set('Authorization', student1Token);
    expect(listRes.status).toBe(200);
    expect(listRes.body.items).toHaveLength(0);
    expect(listRes.body.unreadCount).toBe(0);

    // Student 1 tries to mark Student 2's notification as read -> 404 NOT_FOUND
    const readRes = await request(app)
      .post(`/api/notifications/${bNotifId}/read`)
      .set('Authorization', student1Token);

    expect(readRes.status).toBe(404);
    expect(readRes.body.error).toBeDefined();
    expect(readRes.body.error.code).toBe('NOT_FOUND');
    expect(readRes.body.error.nextActions).toBeInstanceOf(Array);
    expect(readRes.body.error.nextActions.length).toBeGreaterThan(0);

    // Verify Student 2's notification row in DB is still unread
    const bRowAfter = await db.notification.findUnique({ where: { id: bNotifId } });
    expect(bRowAfter?.readAt).toBeNull();

    // Unknown notification id gives the same 404 error shape
    const unknownRes = await request(app)
      .post('/api/notifications/non-existent-id-9999/read')
      .set('Authorization', student1Token);

    expect(unknownRes.status).toBe(404);
    expect(unknownRes.body.error.code).toBe('NOT_FOUND');
  });
});

// ---------------------------------------------------------------------------
// FR-62 AC-3: unreadCount ignores unreadOnly, limit and cursor
// ---------------------------------------------------------------------------
describe('FR-62 AC-3 unreadCount ignores unreadOnly, limit and cursor', () => {
  it('FR-62 AC-3 unreadCount ignores unreadOnly, limit and cursor', async () => {
    const baseTime = new Date('2026-05-01T12:00:00.000Z');

    // Create 5 unread notifications
    for (let i = 1; i <= 5; i++) {
      await db.notification.create({
        data: {
          userId: 'student1',
          type: 'HUB_REDIRECT',
          title: `Unread ${i}`,
          body: `Body ${i}`,
          readAt: null,
          createdAt: new Date(baseTime.getTime() + i * 1000),
        },
      });
    }

    // Create 2 already-read notifications
    for (let i = 6; i <= 7; i++) {
      await db.notification.create({
        data: {
          userId: 'student1',
          type: 'HUB_REDIRECT',
          title: `Read ${i}`,
          body: `Body ${i}`,
          readAt: new Date(baseTime.getTime() + i * 1000),
          createdAt: new Date(baseTime.getTime() + i * 1000),
        },
      });
    }

    // 1. Default query (returns all 7, unreadCount = 5)
    const resDefault = await request(app)
      .get('/api/notifications')
      .set('Authorization', student1Token);
    expect(resDefault.status).toBe(200);
    expect(resDefault.body.items).toHaveLength(7);
    expect(resDefault.body.unreadCount).toBe(5);

    // 2. unreadOnly=true (returns 5 items, unreadCount = 5)
    const resUnreadOnly = await request(app)
      .get('/api/notifications?unreadOnly=true')
      .set('Authorization', student1Token);
    expect(resUnreadOnly.status).toBe(200);
    expect(resUnreadOnly.body.items).toHaveLength(5);
    expect(resUnreadOnly.body.unreadCount).toBe(5);
    resUnreadOnly.body.items.forEach((item: Notification) => {
      expect(item.readAt).toBeNull();
    });

    // 3. limit=2 (returns 2 items, unreadCount = 5, has nextCursor)
    const resLimit = await request(app)
      .get('/api/notifications?limit=2')
      .set('Authorization', student1Token);
    expect(resLimit.status).toBe(200);
    expect(resLimit.body.items).toHaveLength(2);
    expect(resLimit.body.unreadCount).toBe(5);
    expect(resLimit.body.nextCursor).toBeTruthy();

    // 4. limit=2 with cursor (returns next page, unreadCount still = 5)
    const resCursor = await request(app)
      .get(`/api/notifications?limit=2&cursor=${resLimit.body.nextCursor}`)
      .set('Authorization', student1Token);
    expect(resCursor.status).toBe(200);
    expect(resCursor.body.items).toHaveLength(2);
    expect(resCursor.body.unreadCount).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// FR-62 AC-4: cursor pagination 2/2/1 with no gaps, tie on createdAt
// ---------------------------------------------------------------------------
describe('FR-62 AC-4 cursor pagination 2/2/1 with no gaps, tie on createdAt', () => {
  it('FR-62 AC-4 cursor pagination 2/2/1 with no gaps, tie on createdAt', async () => {
    const baseTime = new Date('2026-05-01T15:00:00.000Z');

    // Insert 5 notifications with sequential timestamps
    for (let i = 1; i <= 5; i++) {
      await db.notification.create({
        data: {
          id: `seq-notif-${i}`,
          userId: 'student1',
          type: 'HUB_REDIRECT',
          title: `Seq Notif ${i}`,
          body: `Content ${i}`,
          createdAt: new Date(baseTime.getTime() + i * 10000),
        },
      });
    }

    // Page 1: limit=2 -> expect seq-notif-5, seq-notif-4
    const page1 = await request(app)
      .get('/api/notifications?limit=2')
      .set('Authorization', student1Token);
    expect(page1.status).toBe(200);
    expect(page1.body.items).toHaveLength(2);
    expect(page1.body.nextCursor).toBeTruthy();
    expect(page1.body.items[0].id).toBe('seq-notif-5');
    expect(page1.body.items[1].id).toBe('seq-notif-4');

    // Page 2: limit=2 -> expect seq-notif-3, seq-notif-2
    const page2 = await request(app)
      .get(`/api/notifications?limit=2&cursor=${page1.body.nextCursor}`)
      .set('Authorization', student1Token);
    expect(page2.status).toBe(200);
    expect(page2.body.items).toHaveLength(2);
    expect(page2.body.nextCursor).toBeTruthy();
    expect(page2.body.items[0].id).toBe('seq-notif-3');
    expect(page2.body.items[1].id).toBe('seq-notif-2');

    // Page 3: limit=2 -> expect seq-notif-1, nextCursor null
    const page3 = await request(app)
      .get(`/api/notifications?limit=2&cursor=${page2.body.nextCursor}`)
      .set('Authorization', student1Token);
    expect(page3.status).toBe(200);
    expect(page3.body.items).toHaveLength(1);
    expect(page3.body.nextCursor).toBeNull();
    expect(page3.body.items[0].id).toBe('seq-notif-1');

    // Verify all 5 unique items received with 0 gaps or duplicates
    const allIds = [
      ...page1.body.items.map((i: Notification) => i.id),
      ...page2.body.items.map((i: Notification) => i.id),
      ...page3.body.items.map((i: Notification) => i.id),
    ];
    expect(new Set(allIds).size).toBe(5);

    // --- Tie-break on createdAt test ---
    await db.notification.deleteMany({ where: { userId: 'student1' } });

    const tieTimestamp = new Date('2026-06-01T12:00:00.000Z');
    await db.notification.createMany({
      data: [
        { id: 'notif-tie-1', userId: 'student1', type: 'HUB_REDIRECT', title: 'Tie 1', body: 'B1', createdAt: tieTimestamp },
        { id: 'notif-tie-2', userId: 'student1', type: 'HUB_REDIRECT', title: 'Tie 2', body: 'B2', createdAt: tieTimestamp },
        { id: 'notif-tie-3', userId: 'student1', type: 'HUB_REDIRECT', title: 'Tie 3', body: 'B3', createdAt: tieTimestamp },
        { id: 'notif-tie-4', userId: 'student1', type: 'HUB_REDIRECT', title: 'Tie 4', body: 'B4', createdAt: tieTimestamp },
      ],
    });

    // Page 1 with limit=2 (order should be id DESC: tie-4, tie-3)
    const tiePage1 = await request(app)
      .get('/api/notifications?limit=2')
      .set('Authorization', student1Token);
    expect(tiePage1.status).toBe(200);
    expect(tiePage1.body.items).toHaveLength(2);
    expect(tiePage1.body.items[0].id).toBe('notif-tie-4');
    expect(tiePage1.body.items[1].id).toBe('notif-tie-3');
    expect(tiePage1.body.nextCursor).toBeTruthy();

    // Page 2 with limit=2 (tie-2, tie-1)
    const tiePage2 = await request(app)
      .get(`/api/notifications?limit=2&cursor=${tiePage1.body.nextCursor}`)
      .set('Authorization', student1Token);
    expect(tiePage2.status).toBe(200);
    expect(tiePage2.body.items).toHaveLength(2);
    expect(tiePage2.body.items[0].id).toBe('notif-tie-2');
    expect(tiePage2.body.items[1].id).toBe('notif-tie-1');
    expect(tiePage2.body.nextCursor).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// FR-62 AC-5: limit and cursor validation boundaries
// ---------------------------------------------------------------------------
describe('FR-62 AC-5 limit and cursor validation boundaries', () => {
  it('FR-62 AC-5 limit and cursor validation boundaries', async () => {
    // 1. limit = 0 -> 400 details.field: 'limit'
    const res0 = await request(app)
      .get('/api/notifications?limit=0')
      .set('Authorization', student1Token);
    expect(res0.status).toBe(400);
    expect(res0.body.error.code).toBe('VALIDATION_ERROR');
    expect(res0.body.error.details?.field).toBe('limit');

    // 2. limit = LIST_LIMIT_MAX + 1 -> 400 details.field: 'limit'
    const resOverMax = await request(app)
      .get(`/api/notifications?limit=${config.LIST_LIMIT_MAX + 1}`)
      .set('Authorization', student1Token);
    expect(resOverMax.status).toBe(400);
    expect(resOverMax.body.error.code).toBe('VALIDATION_ERROR');
    expect(resOverMax.body.error.details?.field).toBe('limit');

    // 3. limit = 'abc' -> 400 details.field: 'limit'
    const resAbc = await request(app)
      .get('/api/notifications?limit=abc')
      .set('Authorization', student1Token);
    expect(resAbc.status).toBe(400);
    expect(resAbc.body.error.code).toBe('VALIDATION_ERROR');
    expect(resAbc.body.error.details?.field).toBe('limit');

    // 4. limit = '1.5' -> 400 details.field: 'limit'
    const resFloat = await request(app)
      .get('/api/notifications?limit=1.5')
      .set('Authorization', student1Token);
    expect(resFloat.status).toBe(400);
    expect(resFloat.body.error.code).toBe('VALIDATION_ERROR');
    expect(resFloat.body.error.details?.field).toBe('limit');

    // 5. cursor = garbage -> 400 details.field: 'cursor'
    const resGarbageCursor = await request(app)
      .get('/api/notifications?cursor=not-a-base64-json')
      .set('Authorization', student1Token);
    expect(resGarbageCursor.status).toBe(400);
    expect(resGarbageCursor.body.error.code).toBe('VALIDATION_ERROR');
    expect(resGarbageCursor.body.error.details?.field).toBe('cursor');

    // Invalid base64url JSON (e.g. valid base64 but missing fields or invalid date)
    const badJsonCursor = Buffer.from(JSON.stringify({ onlyId: 'foo' })).toString('base64url');
    const resBadJsonCursor = await request(app)
      .get(`/api/notifications?cursor=${badJsonCursor}`)
      .set('Authorization', student1Token);
    expect(resBadJsonCursor.status).toBe(400);
    expect(resBadJsonCursor.body.error.code).toBe('VALIDATION_ERROR');
    expect(resBadJsonCursor.body.error.details?.field).toBe('cursor');

    // 6. unreadOnly = 'yes' -> 400 details.field: 'unreadOnly'
    const resBadBool = await request(app)
      .get('/api/notifications?unreadOnly=yes')
      .set('Authorization', student1Token);
    expect(resBadBool.status).toBe(400);
    expect(resBadBool.body.error.code).toBe('VALIDATION_ERROR');
    expect(resBadBool.body.error.details?.field).toBe('unreadOnly');

    // 7. Acceptable boundaries: limit = 1 and limit = LIST_LIMIT_MAX
    const resMinLimit = await request(app)
      .get('/api/notifications?limit=1')
      .set('Authorization', student1Token);
    expect(resMinLimit.status).toBe(200);

    const resMaxLimit = await request(app)
      .get(`/api/notifications?limit=${config.LIST_LIMIT_MAX}`)
      .set('Authorization', student1Token);
    expect(resMaxLimit.status).toBe(200);

    // 8. Without limit query param, capped at LIST_LIMIT_DEFAULT
    // Insert LIST_LIMIT_DEFAULT + 10 rows
    const countToInsert = config.LIST_LIMIT_DEFAULT + 10;
    const baseDate = new Date('2026-05-01T10:00:00.000Z');
    const bulkData = Array.from({ length: countToInsert }, (_, idx) => ({
      userId: 'student1',
      type: 'HUB_REDIRECT',
      title: `Bulk ${idx}`,
      body: `Body ${idx}`,
      createdAt: new Date(baseDate.getTime() + idx * 1000),
    }));
    await db.notification.createMany({ data: bulkData });

    const resDefaultLimit = await request(app)
      .get('/api/notifications')
      .set('Authorization', student1Token);
    expect(resDefaultLimit.status).toBe(200);
    expect(resDefaultLimit.body.items).toHaveLength(config.LIST_LIMIT_DEFAULT);
    expect(resDefaultLimit.body.nextCursor).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// FR-62 AC-6: mark read is idempotent and keeps the first readAt
// ---------------------------------------------------------------------------
describe('FR-62 AC-6 mark read is idempotent and keeps the first readAt', () => {
  it('FR-62 AC-6 mark read is idempotent and keeps the first readAt', async () => {
    await notify(db, {
      userId: 'student1',
      type: 'RESERVATION_CANCELLED',
      title: 'Cancellation',
      body: 'Your reservation was cancelled',
    });

    const notifs = await db.notification.findMany({ where: { userId: 'student1' } });
    expect(notifs).toHaveLength(1);
    const notifId = notifs[0]!.id;
    expect(notifs[0]!.readAt).toBeNull();

    // Mark as read -> 204
    const res1 = await request(app)
      .post(`/api/notifications/${notifId}/read`)
      .set('Authorization', student1Token);
    expect(res1.status).toBe(204);
    expect(res1.body).toEqual({});

    // Verify readAt is now set in DB and unreadCount drops to 0
    const rowAfterFirst = await db.notification.findUnique({ where: { id: notifId } });
    expect(rowAfterFirst?.readAt).not.toBeNull();
    const firstReadAt = rowAfterFirst!.readAt!;

    const listRes = await request(app)
      .get('/api/notifications')
      .set('Authorization', student1Token);
    expect(listRes.body.unreadCount).toBe(0);
    expect(listRes.body.items[0]!.readAt).toBe(firstReadAt.toISOString());

    // Mark as read again -> 204, readAt must remain unchanged
    const res2 = await request(app)
      .post(`/api/notifications/${notifId}/read`)
      .set('Authorization', student1Token);
    expect(res2.status).toBe(204);

    const rowAfterSecond = await db.notification.findUnique({ where: { id: notifId } });
    expect(rowAfterSecond?.readAt).toEqual(firstReadAt);
  });
});

// ---------------------------------------------------------------------------
// FR-62 AC-7: read-all only touches this user's unread rows
// ---------------------------------------------------------------------------
describe("FR-62 AC-7 read-all only touches this user's unread rows", () => {
  it("FR-62 AC-7 read-all only touches this user's unread rows", async () => {
    const historicalReadAt = new Date('2026-01-01T08:00:00.000Z');

    // Student 1: 2 unread, 1 already read
    await db.notification.createMany({
      data: [
        { id: 's1-u1', userId: 'student1', type: 'HUB_REDIRECT', title: 'S1 U1', body: 'B', readAt: null },
        { id: 's1-u2', userId: 'student1', type: 'HUB_REDIRECT', title: 'S1 U2', body: 'B', readAt: null },
        { id: 's1-r1', userId: 'student1', type: 'HUB_REDIRECT', title: 'S1 R1', body: 'B', readAt: historicalReadAt },
      ],
    });

    // Student 2: 1 unread
    await db.notification.create({
      data: { id: 's2-u1', userId: 'student2', type: 'HUB_REDIRECT', title: 'S2 U1', body: 'B', readAt: null },
    });

    // Student 1 calls read-all -> 204
    const res = await request(app)
      .post('/api/notifications/read-all')
      .set('Authorization', student1Token);
    expect(res.status).toBe(204);

    // Verify Student 1's previously unread notifications are now read
    const s1u1 = await db.notification.findUnique({ where: { id: 's1-u1' } });
    const s1u2 = await db.notification.findUnique({ where: { id: 's1-u2' } });
    expect(s1u1?.readAt).not.toBeNull();
    expect(s1u2?.readAt).not.toBeNull();

    // Verify Student 1's already-read notification keeps original readAt
    const s1r1 = await db.notification.findUnique({ where: { id: 's1-r1' } });
    expect(s1r1?.readAt?.toISOString()).toBe(historicalReadAt.toISOString());

    // Verify Student 2's unread notification remains untouched (readAt null)
    const s2u1 = await db.notification.findUnique({ where: { id: 's2-u1' } });
    expect(s2u1?.readAt).toBeNull();

    // Calling read-all when nothing is unread returns 204
    const resAgain = await request(app)
      .post('/api/notifications/read-all')
      .set('Authorization', student1Token);
    expect(resAgain.status).toBe(204);
  });
});

// ---------------------------------------------------------------------------
// FR-62 AC-8: 401 without token, operator reads own notifications
// ---------------------------------------------------------------------------
describe('FR-62 AC-8 401 without token, operator reads own notifications', () => {
  it('FR-62 AC-8 401 without token, operator reads own notifications', async () => {
    // 1. Without token -> 401 UNAUTHENTICATED
    const getRes = await request(app).get('/api/notifications');
    expect(getRes.status).toBe(401);
    expect(getRes.body.error.code).toBe('UNAUTHENTICATED');

    const readRes = await request(app).post('/api/notifications/any-id/read');
    expect(readRes.status).toBe(401);
    expect(readRes.body.error.code).toBe('UNAUTHENTICATED');

    const readAllRes = await request(app).post('/api/notifications/read-all');
    expect(readAllRes.status).toBe(401);
    expect(readAllRes.body.error.code).toBe('UNAUTHENTICATED');

    // 2. Operator token reads and marks own notifications
    await notify(db, {
      userId: 'operator1',
      type: 'CHARGING_ENDED_FAULT',
      title: 'Charger fault alert',
      body: 'Charger at Metro Station is faulty',
      data: { hubId: 'metro' },
    });

    const opList = await request(app)
      .get('/api/notifications')
      .set('Authorization', operatorToken);
    expect(opList.status).toBe(200);
    expect(opList.body.items).toHaveLength(1);
    expect(opList.body.unreadCount).toBe(1);
    expect(opList.body.items[0].title).toBe('Charger fault alert');

    const opNotifId = opList.body.items[0].id;

    // Mark single notification as read as operator
    const opReadRes = await request(app)
      .post(`/api/notifications/${opNotifId}/read`)
      .set('Authorization', operatorToken);
    expect(opReadRes.status).toBe(204);

    // Read-all as operator
    const opReadAllRes = await request(app)
      .post('/api/notifications/read-all')
      .set('Authorization', operatorToken);
    expect(opReadAllRes.status).toBe(204);
  });
});
