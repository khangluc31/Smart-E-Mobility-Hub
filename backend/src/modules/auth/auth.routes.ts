// Auth routes (CONTRACTS §2). Validates input, calls the service, sends the response.
// No Prisma or audit imports in routes (AGENTS.md §4).

import { Router, type Request, type Response, type NextFunction } from 'express';
import { requireAuth } from '../../core/auth';
import { badRequest, requireString } from '../../core/errors';
import {
  assertStudentRole,
  changePassword,
  getMe,
  login,
  register,
  requireValidPassword,
} from './auth.service';

type AsyncHandler = (req: Request, res: Response, next: NextFunction) => Promise<void>;
function wrap(fn: AsyncHandler) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };
}

function asObject(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw badRequest('Request body must be a JSON object.', 'body', [
      'Send a valid JSON object in the request body.',
    ]);
  }
  return body as Record<string, unknown>;
}

export const authRouter = Router();

// POST /api/auth/register — public (FR-29, FR-60)
authRouter.post(
  '/register',
  wrap(async (req, res) => {
    const body = asObject(req.body);

    // FR-60: check role first before any other field validation.
    await assertStudentRole(body['role']);

    const identifier = requireString(body, 'identifier', { trim: true, min: 3, max: 64 });
    // TODO(M3): confirm displayName limits
    const displayName = requireString(body, 'displayName', { trim: true, min: 1, max: 64 });
    const password = requireValidPassword(body, 'password');

    const result = await register({
      identifier,
      password,
      displayName,
      role: body['role'],
    });
    res.status(201).json(result);
  }),
);

// POST /api/auth/login — public (UC-16, FR-60)
authRouter.post(
  '/login',
  wrap(async (req, res) => {
    const body = asObject(req.body);
    const identifier = requireString(body, 'identifier', { trim: true, min: 1 });
    const password = requireString(body, 'password', { min: 1 });

    const result = await login({ identifier, password });
    res.status(200).json(result);
  }),
);

// GET /api/auth/me — Any authenticated user (UC-16 A1)
authRouter.get(
  '/me',
  requireAuth,
  wrap(async (req, res) => {
    const user = await getMe(req.user!.id);
    res.status(200).json(user);
  }),
);

// POST /api/auth/change-password — Any authenticated user (UC-16 A2)
authRouter.post(
  '/change-password',
  requireAuth,
  wrap(async (req, res) => {
    const body = asObject(req.body);
    const currentPassword = requireString(body, 'currentPassword', { min: 1 });
    const newPassword = requireValidPassword(body, 'newPassword');

    await changePassword(req.user!.id, { currentPassword, newPassword });
    res.status(204).end();
  }),
);
