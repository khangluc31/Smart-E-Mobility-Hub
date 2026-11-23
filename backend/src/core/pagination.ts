// Pure cursor-pagination helper for list endpoints (CONTRACTS §0 Lists, SPEC §3, T-10).
// No Prisma or DB imports. Ordering convention: `createdAt DESC, id DESC`.

import { config } from './config';
import { badRequest, optional, requireInt } from './errors';

export interface ListCursor {
  createdAt: Date;
  id: string;
}

export interface ListQuery {
  limit: number;
  cursor: ListCursor | null;
}

const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

function invalidCursorError(): never {
  throw badRequest('Invalid pagination cursor.', 'cursor', [
    'Use the nextCursor returned by the previous page, or omit cursor to start from the first page.',
  ]);
}

/**
 * Encodes the last item of a page (`{ createdAt, id }`) into an opaque base64url cursor.
 */
export function encodeCursor(item: { createdAt: Date | string; id: string }): string {
  const iso =
    typeof item.createdAt === 'string'
      ? new Date(item.createdAt).toISOString()
      : item.createdAt.toISOString();
  const json = JSON.stringify({ createdAt: iso, id: item.id });
  return Buffer.from(json, 'utf8').toString('base64url');
}

/**
 * Decodes and validates an opaque base64url cursor string.
 * Requires `createdAt` to round-trip cleanly via `new Date(s).toISOString() === s`.
 * Throws 400 VALIDATION_ERROR with `details.field = 'cursor'` on any malformed input.
 */
export function decodeCursor(raw: unknown): ListCursor {
  if (typeof raw !== 'string' || raw.length === 0 || !BASE64URL_RE.test(raw)) {
    invalidCursorError();
  }

  let parsed: unknown;
  try {
    const buf = Buffer.from(raw, 'base64url');
    if (buf.toString('base64url') !== raw) {
      invalidCursorError();
    }
    parsed = JSON.parse(buf.toString('utf8'));
  } catch {
    invalidCursorError();
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    invalidCursorError();
  }

  const obj = parsed as Record<string, unknown>;
  const createdAtRaw = obj['createdAt'];
  const idRaw = obj['id'];

  if (typeof createdAtRaw !== 'string' || typeof idRaw !== 'string' || idRaw.length === 0) {
    invalidCursorError();
  }

  const ms = Date.parse(createdAtRaw);
  if (Number.isNaN(ms)) {
    invalidCursorError();
  }

  const createdAt = new Date(ms);
  if (createdAt.toISOString() !== createdAtRaw) {
    invalidCursorError();
  }

  return { createdAt, id: idRaw };
}

/**
 * Parses `limit` (default `config.LIST_LIMIT_DEFAULT`, range `1..config.LIST_LIMIT_MAX`)
 * and optional `cursor` from `req.query`.
 */
export function parseListQuery(query: Record<string, unknown>): ListQuery {
  const limit =
    optional(requireInt)(query, 'limit', {
      min: 1,
      max: config.LIST_LIMIT_MAX,
    }) ?? config.LIST_LIMIT_DEFAULT;

  const rawCursor = query['cursor'];
  const cursor =
    rawCursor === undefined || rawCursor === null ? null : decodeCursor(rawCursor);

  return { limit, cursor };
}
