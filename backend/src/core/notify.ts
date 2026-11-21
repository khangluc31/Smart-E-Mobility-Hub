// In-app notification helper (FR-62). Insert one notification row, usually inside
// the same transaction as the change that triggered it.
import { Prisma } from '@prisma/client';
import type { DbClient } from './db';
import type { NotificationType } from '../types/enums';

export interface NotifyEntry {
  userId: string;
  type: NotificationType;
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

export async function notify(client: DbClient, entry: NotifyEntry): Promise<void> {
  await client.notification.create({
    data: {
      userId: entry.userId,
      type: entry.type,
      title: entry.title,
      body: entry.body,
      data: (entry.data ?? {}) as Prisma.InputJsonValue,
    },
  });
}
