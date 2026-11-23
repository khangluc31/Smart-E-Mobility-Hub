// Transaction-scoped idempotency helper (NFR-08, CONTRACTS §0, T-11 Rule 6).
// Serialises concurrent requests sharing (userId, key) via `pg_advisory_xact_lock`
// and replays stored successful responses from `idempotency_key`.

import type { Prisma } from '@prisma/client';
import type { Tx } from './db';
import { badRequest } from './errors';

export const IDEMPOTENCY_KEY_MAX_LEN = 128;

export interface IdempotencyContext {
  userId: string;
  key?: string;
  endpoint: string;
  now?: Date;
}

export interface IdempotencyResult<T> {
  status: number;
  body: T;
  replayed: boolean;
}

/**
 * Validates the optional `Idempotency-Key` header.
 * Returns `undefined` when the header is omitted; throws 400 VALIDATION_ERROR
 * with `details.field = 'Idempotency-Key'` if empty or longer than 128 characters.
 */
export function parseIdempotencyKey(rawHeader: unknown): string | undefined {
  if (rawHeader === undefined || rawHeader === null) {
    return undefined;
  }
  if (typeof rawHeader !== 'string') {
    throw badRequest(
      'Idempotency-Key must be a string between 1 and 128 characters.',
      'Idempotency-Key',
      ['Provide a valid Idempotency-Key header (1–128 characters) or omit it.'],
    );
  }
  const trimmed = rawHeader.trim();
  if (trimmed.length < 1 || trimmed.length > IDEMPOTENCY_KEY_MAX_LEN) {
    throw badRequest(
      `Idempotency-Key must be between 1 and ${IDEMPOTENCY_KEY_MAX_LEN} characters.`,
      'Idempotency-Key',
      ['Provide a valid Idempotency-Key header (1–128 characters) or omit it.'],
    );
  }
  return trimmed;
}

/**
 * Runs `run()` inside an active Prisma transaction `tx` with idempotency protection.
 * - Acquires `pg_advisory_xact_lock(hashtext((userId || ':' || key)::text))` so two
 *   concurrent requests with the same key execute sequentially.
 * - If a stored row exists for `(key, userId)`:
 *   - same `endpoint`: returns the stored status + body (with `serverNow` refreshed to `now`).
 *   - different `endpoint`: throws 400 VALIDATION_ERROR (`details.field: 'Idempotency-Key'`).
 * - Otherwise executes `run()` and stores `{ key, userId, endpoint, responseStatus, responseBody }`
 *   in the same transaction. Failed requests throw and roll back without storing a row.
 */
export async function withIdempotency<T>(
  tx: Tx,
  ctx: IdempotencyContext,
  run: () => Promise<{ status: number; body: T }>,
): Promise<IdempotencyResult<T>> {
  const { userId, key, endpoint, now = new Date() } = ctx;

  if (!key) {
    const res = await run();
    return { status: res.status, body: res.body, replayed: false };
  }

  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${userId + ':' + key}::text))`;

  const existing = await tx.idempotencyKey.findUnique({
    where: {
      key_userId: {
        key,
        userId,
      },
    },
  });

  if (existing) {
    if (existing.endpoint !== endpoint) {
      throw badRequest(
        'Idempotency-Key has already been used for another endpoint.',
        'Idempotency-Key',
        ['Use a fresh Idempotency-Key for each distinct request.'],
      );
    }

    const storedBody = existing.responseBody;
    if (storedBody && typeof storedBody === 'object' && !Array.isArray(storedBody)) {
      const copy = { ...(storedBody as Record<string, unknown>) };
      if ('serverNow' in copy) {
        copy['serverNow'] = now.toISOString();
      }
      return {
        status: existing.responseStatus,
        body: copy as unknown as T,
        replayed: true,
      };
    }

    return {
      status: existing.responseStatus,
      body: storedBody as unknown as T,
      replayed: true,
    };
  }

  const result = await run();

  await tx.idempotencyKey.create({
    data: {
      key,
      userId,
      endpoint,
      responseStatus: result.status,
      responseBody: result.body as unknown as Prisma.InputJsonValue,
    },
  });

  return {
    status: result.status,
    body: result.body,
    replayed: false,
  };
}
