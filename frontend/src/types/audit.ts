// Shared Audit Log DTO types (CONTRACTS §15, FR-63).
// Keep backend/src/types/audit.ts and frontend/src/types/audit.ts byte-identical.

export interface AuditLogItem {
  id: string;
  at: string;
  actorId: string | null;
  actorRole: string | null;
  action: string;
  entityType: string;
  entityIds: string[];
  reason: string | null;
  details: Record<string, unknown>;
}

export interface AuditLogList {
  items: AuditLogItem[];
  nextCursor: string | null;
}
