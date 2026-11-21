// Append-only audit helper (FR-63). Call with the caller's tx so the row commits
// or rolls back with the change; call with plain db for post-rollback security logs (D-22).
import { Prisma } from '@prisma/client';
import type { DbClient } from './db';
import type { AuditAction, Role } from '../types/enums';

export interface AuditEntry {
  actorId?: string | null;
  actorRole?: Role | string | null;
  action: AuditAction;
  entityType: string;
  entityIds: string[];
  reason?: string;
  details?: Record<string, unknown>;
}

export async function audit(client: DbClient, entry: AuditEntry): Promise<void> {
  await client.auditLog.create({
    data: {
      actorId: entry.actorId ?? null,
      actorRole: entry.actorRole ?? null,
      action: entry.action,
      entityType: entry.entityType,
      entityIds: entry.entityIds,
      reason: entry.reason ?? null,
      details: (entry.details ?? {}) as Prisma.InputJsonValue,
    },
  });
}
