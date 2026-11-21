// Express 404 + error handlers (NFR-05, ARCHITECTURE §4.4). Kept separate from
// errors.ts so it can import db/audit without creating a core import cycle.
import type { Request, Response, NextFunction } from 'express';
import { Prisma } from '@prisma/client';
import { AppError, InvalidStateTransitionError, type ErrorBody } from './errors';
import { audit } from './audit';
import { db } from './db';

function send(res: Response, status: number, body: ErrorBody): void {
  res.status(status).json({ error: body });
}

export function notFoundHandler(_req: Request, res: Response): void {
  send(res, 404, {
    code: 'NOT_FOUND',
    message: 'Route not found.',
    nextActions: ['Check the URL and HTTP method.', 'See docs/CONTRACTS.md for valid endpoints.'],
  });
}

// Async so the D-22 audit is written before the 409 response is sent.
export async function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): Promise<void> {
  if (err instanceof InvalidStateTransitionError) {
    // D-22: the failed transaction has rolled back, so write the audit with plain db.
    try {
      await audit(db, {
        actorId: req.user?.id ?? null,
        actorRole: req.user?.role ?? null,
        action: 'INVALID_TRANSITION',
        entityType: String(err.details?.['entity'] ?? 'unknown'),
        entityIds: [],
        details: { ...err.details, path: req.originalUrl || req.path },
      });
    } catch (auditErr) {
      console.error('[errorHandler] failed to write INVALID_TRANSITION audit', auditErr);
    }
    send(res, err.status, err.toBody());
    return;
  }

  if (err instanceof AppError) {
    send(res, err.status, err.toBody());
    return;
  }

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') {
      send(res, 409, {
        code: 'RESOURCE_TAKEN',
        message: 'This resource was just taken by someone else.',
        nextActions: ['Refresh and try another option.'],
      });
      return;
    }
    if (err.code === 'P2025') {
      send(res, 404, {
        code: 'NOT_FOUND',
        message: 'Resource not found.',
        nextActions: ['Check the id and try again.'],
      });
      return;
    }
  }

  // Raw Postgres unique / exclusion violations surfaced from $queryRaw.
  const pgCode = (err as { code?: unknown }).code;
  if (pgCode === '23505' || pgCode === '23P01') {
    send(res, 409, {
      code: 'RESOURCE_TAKEN',
      message: 'This resource was just taken by someone else.',
      nextActions: ['Refresh and try another option.'],
    });
    return;
  }

  // Malformed JSON body from express.json().
  const parseType = (err as { type?: string }).type;
  if (err instanceof SyntaxError && (parseType === 'entity.parse.failed' || 'body' in err)) {
    send(res, 400, {
      code: 'VALIDATION_ERROR',
      message: 'Request body is not valid JSON.',
      nextActions: ['Send a well-formed JSON body.'],
    });
    return;
  }

  // Unknown: log the real error, never leak it to the client.
  console.error('[errorHandler]', err);
  send(res, 500, {
    code: 'INTERNAL_ERROR',
    message: 'An unexpected error occurred.',
    nextActions: ['Retry the request.', 'If the problem persists, contact the team.'],
  });
}
