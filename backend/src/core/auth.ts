// JWT auth + role guards (D-15, BR-12, FR-61). Password hashing lives in the auth module.
import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from './config';
import { unauthenticated, forbidden } from './errors';
import { audit } from './audit';
import { db } from './db';
import type { Role } from '../types/enums';

export function signToken(user: { id: string; role: Role }): string {
  const options: jwt.SignOptions = {
    expiresIn: config.JWT_EXPIRES_IN as jwt.SignOptions['expiresIn'],
  };
  return jwt.sign({ sub: user.id, role: user.role }, config.JWT_SECRET, options);
}

export function verifyToken(token: string): { id: string; role: Role } {
  const decoded = jwt.verify(token, config.JWT_SECRET) as jwt.JwtPayload;
  const sub = decoded.sub;
  const role = decoded['role'] as unknown;
  if (typeof sub !== 'string' || (role !== 'STUDENT' && role !== 'OPERATOR')) {
    throw new Error('Malformed token payload');
  }
  return { id: sub, role };
}

export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    next(unauthenticated());
    return;
  }
  const token = header.slice('Bearer '.length).trim();
  try {
    req.user = verifyToken(token);
    next();
  } catch {
    next(unauthenticated());
  }
}

export function requireRole(role: Role) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const user = req.user;
    if (!user) {
      next(unauthenticated());
      return;
    }
    if (user.role !== role) {
      // D-22: audit the denial with plain db before sending 403; failure is logged, still 403.
      void audit(db, {
        actorId: user.id,
        actorRole: user.role,
        action: 'SECURITY_DENIED',
        entityType: 'auth',
        entityIds: [],
        details: { method: req.method, path: req.originalUrl || req.path, requiredRole: role },
      })
        .catch((err) => console.error('[auth] failed to write SECURITY_DENIED audit', err))
        .finally(() => {
          next(forbidden());
        });
      return;
    }
    next();
  };
}
