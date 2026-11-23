// Notifications service (FR-62, UC-18 E1, CONTRACTS §0 / §1 / §9).
// Every query filters by `userId` so users never see or mark another user's rows.

import type { Notification as PrismaNotification, Prisma } from '@prisma/client';
import { db } from '../../core/db';
import { notFound } from '../../core/errors';
import { encodeCursor, type ListCursor } from '../../core/pagination';
import type { Notification, NotificationList } from '../../types/notifications';

export interface ListNotificationsOptions {
  unreadOnly?: boolean;
  limit: number;
  cursor: ListCursor | null;
}

function toNotificationDto(row: PrismaNotification): Notification {
  const rawData = row.data;
  const data =
    rawData && typeof rawData === 'object' && !Array.isArray(rawData)
      ? (rawData as Record<string, unknown>)
      : {};

  return {
    id: row.id,
    type: row.type,
    title: row.title,
    body: row.body,
    data,
    readAt: row.readAt ? row.readAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * FR-62: List the caller's notifications ordered by `createdAt DESC, id DESC`.
 * `unreadCount` always counts all of this user's unread notifications, regardless
 * of `unreadOnly`, `limit`, or `cursor`.
 */
export async function listNotifications(
  userId: string,
  opts: ListNotificationsOptions,
): Promise<NotificationList> {
  const where: Prisma.NotificationWhereInput = {
    userId,
    ...(opts.unreadOnly ? { readAt: null } : {}),
    ...(opts.cursor
      ? {
          OR: [
            { createdAt: { lt: opts.cursor.createdAt } },
            { createdAt: opts.cursor.createdAt, id: { lt: opts.cursor.id } },
          ],
        }
      : {}),
  };

  const [rows, unreadCount] = await Promise.all([
    db.notification.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: opts.limit + 1,
    }),
    db.notification.count({
      where: { userId, readAt: null },
    }),
  ]);

  const hasMore = rows.length > opts.limit;
  const pageRows = hasMore ? rows.slice(0, opts.limit) : rows;
  const lastRow = pageRows[pageRows.length - 1];
  const nextCursor = hasMore && lastRow ? encodeCursor(lastRow) : null;

  return {
    items: pageRows.map(toNotificationDto),
    unreadCount,
    nextCursor,
  };
}

/**
 * FR-62: Mark a single notification belonging to `userId` as read.
 * Sets `readAt = now` only if `readAt` is currently null (first read wins, idempotent).
 * Throws 404 NOT_FOUND if the notification does not exist or belongs to another user.
 */
export async function markRead(
  userId: string,
  id: string,
  now: Date = new Date(),
): Promise<void> {
  const updated = await db.notification.updateMany({
    where: { id, userId, readAt: null },
    data: { readAt: now },
  });

  if (updated.count > 0) {
    return;
  }

  const existing = await db.notification.findFirst({
    where: { id, userId },
    select: { id: true },
  });

  if (!existing) {
    throw notFound('Notification');
  }
}

/**
 * FR-62: Mark all unread notifications belonging to `userId` as read.
 * Already-read rows keep their existing `readAt`; other users' rows are untouched.
 */
export async function markAllRead(
  userId: string,
  now: Date = new Date(),
): Promise<void> {
  await db.notification.updateMany({
    where: { userId, readAt: null },
    data: { readAt: now },
  });
}
