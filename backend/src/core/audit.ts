// Append-only audit helper & read-only query (FR-63, CONTRACTS §15).
// Call audit() with the caller's tx so the row commits or rolls back with the change;
// call with plain db for post-rollback security logs (D-22).
import { Prisma, type AuditLog as PrismaAuditLog } from '@prisma/client';
import { db, type DbClient } from './db';
import { badRequest } from './errors';
import { encodeCursor, type ListCursor } from './pagination';
import type { AuditLogItem, AuditLogList } from '../types/audit';
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

export interface AuditListFilters {
  entityType?: string;
  entityId?: string;
  actorId?: string;
  action?: string;
  from?: Date;
  to?: Date;
}

export interface AuditListPageOptions {
  limit: number;
  cursor: ListCursor | null;
}

const DIGITS_RE = /^\d+$/;

function toAuditLogItem(row: PrismaAuditLog): AuditLogItem {
  const details =
    row.details && typeof row.details === 'object' && !Array.isArray(row.details)
      ? (row.details as Record<string, unknown>)
      : {};

  return {
    id: row.id.toString(),
    at: row.at.toISOString(),
    actorId: row.actorId ?? null,
    actorRole: row.actorRole ?? null,
    action: row.action,
    entityType: row.entityType,
    entityIds: [...row.entityIds],
    reason: row.reason ?? null,
    details,
  };
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

/**
 * FR-63, NFR-14, CONTRACTS §15: Read-only filtered, cursor-paginated audit log query.
 * Ordered newest-first (`at DESC, id DESC`). Validates BigInt cursor ids safely.
 */
export async function listAuditLogs(
  filters: AuditListFilters,
  page: AuditListPageOptions,
): Promise<AuditLogList> {
  if (filters.from && filters.to && filters.from.getTime() > filters.to.getTime()) {
    throw badRequest('to must be greater than or equal to from.', 'to');
  }

  let cursorBigInt: bigint | null = null;
  if (page.cursor) {
    if (!DIGITS_RE.test(page.cursor.id)) {
      throw badRequest('Invalid pagination cursor.', 'cursor', [
        'Use the nextCursor returned by the previous page, or omit cursor to start from the first page.',
      ]);
    }
    cursorBigInt = BigInt(page.cursor.id);
  }

  const atRange: Prisma.DateTimeFilter = {
    ...(filters.from ? { gte: filters.from } : {}),
    ...(filters.to ? { lte: filters.to } : {}),
  };

  const where: Prisma.AuditLogWhereInput = {
    ...(filters.entityType ? { entityType: filters.entityType } : {}),
    ...(filters.entityId ? { entityIds: { has: filters.entityId } } : {}),
    ...(filters.actorId ? { actorId: filters.actorId } : {}),
    ...(filters.action ? { action: filters.action } : {}),
    ...(filters.from || filters.to ? { at: atRange } : {}),
    ...(page.cursor && cursorBigInt !== null
      ? {
          OR: [
            { at: { lt: page.cursor.createdAt } },
            { at: page.cursor.createdAt, id: { lt: cursorBigInt } },
          ],
        }
      : {}),
  };

  const rows = await db.auditLog.findMany({
    where,
    orderBy: [{ at: 'desc' }, { id: 'desc' }],
    take: page.limit + 1,
  });

  const hasMore = rows.length > page.limit;
  const pageRows = hasMore ? rows.slice(0, page.limit) : rows;
  const lastRow = pageRows[pageRows.length - 1];
  const nextCursor =
    hasMore && lastRow
      ? encodeCursor({ createdAt: lastRow.at, id: lastRow.id.toString() })
      : null;

  return {
    items: pageRows.map(toAuditLogItem),
    nextCursor,
  };
}
