// Notification DTOs (CONTRACTS §1 / §9).
// No imports except ./enums so the file can be copied byte-for-byte to the frontend.

import type { NotificationType } from './enums';

export interface Notification {
  id: string;
  type: NotificationType | string;
  title: string;
  body: string;
  data: Record<string, unknown>;
  readAt: string | null;
  createdAt: string;
}

export interface NotificationList {
  items: Notification[];
  unreadCount: number;
  nextCursor: string | null;
}
