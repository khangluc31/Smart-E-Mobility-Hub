// Authentication service: registration, login, current user, and password change
// (FR-29, FR-60, FR-61, UC-16, ARCHITECTURE §4.4 / §4.5, CONTRACTS §2).

import bcrypt from 'bcryptjs';
import { Prisma, type User as PrismaUser } from '@prisma/client';
import { db } from '../../core/db';
import { audit } from '../../core/audit';
import { signToken } from '../../core/auth';
import {
  AppError,
  badRequest,
  conflict,
  forbidden,
  requireString,
  unauthenticated,
} from '../../core/errors';
import type { AuthResponse, User } from '../../types/auth';

const BCRYPT_COST = 10;
const HAS_LETTER = /[A-Za-z]/;
const HAS_DIGIT = /\d/;

// Precomputed cost-10 dummy hash so login runs a constant-cost bcrypt comparison
// even when the identifier does not exist (CONTRACTS §2 / Rule 2).
const DUMMY_PASSWORD_HASH = bcrypt.hashSync('emh-dummy-timing-guard-password-0', BCRYPT_COST);

export interface RegisterInput {
  identifier: string;
  password: string;
  displayName: string;
  role?: unknown;
}

export interface LoginInput {
  identifier: string;
  password: string;
}

export interface ChangePasswordInput {
  currentPassword: string;
  newPassword: string;
}

function toUserDto(row: PrismaUser): User {
  return {
    id: row.id,
    identifier: row.identifier,
    displayName: row.displayName,
    role: row.role,
    mustChangePassword: row.mustChangePassword,
  };
}

/**
 * Shared password rule helper (CONTRACTS §2, Rule 1 & Rule 4):
 * - Must be a string of at least 8 characters (never trimmed).
 * - Must contain at least one ASCII letter and at least one digit.
 */
export function requireValidPassword(
  source: Record<string, unknown>,
  field: 'password' | 'newPassword',
): string {
  const value = requireString(source, field, { min: 8 });
  if (!HAS_LETTER.test(value) || !HAS_DIGIT.test(value)) {
    throw badRequest(
      `${field} must contain at least one letter and one digit.`,
      field,
      ['Choose a password with at least 8 characters, including a letter and a number.'],
    );
  }
  return value;
}

/**
 * FR-60: Public registration may only create STUDENT accounts.
 * Any non-STUDENT `role` value in the request body is rejected with 403 FORBIDDEN
 * and logged as SECURITY_DENIED with plain `db` (D-22).
 */
export async function assertStudentRole(role: unknown): Promise<void> {
  if (role === undefined || role === null || role === 'STUDENT') {
    return;
  }

  await audit(db, {
    actorId: null,
    actorRole: null,
    action: 'SECURITY_DENIED',
    entityType: 'auth',
    entityIds: [],
    details: {
      path: '/api/auth/register',
      requestedRole: role,
    },
  }).catch((err: unknown) =>
    console.error('[auth] failed to write SECURITY_DENIED audit', err),
  );

  throw forbidden('Public registration is only allowed for STUDENT accounts.');
}

/**
 * FR-29, FR-60: Register a new STUDENT account.
 * Relies on the unique index on `user.identifier` and catches P2002 so concurrent
 * registrations with the same identifier never race or leak a raw Prisma error.
 */
export async function register(
  input: RegisterInput,
  _now: Date = new Date(),
): Promise<AuthResponse> {
  await assertStudentRole(input.role);

  const identifier = input.identifier.trim();
  const displayName = input.displayName.trim();
  const password = requireValidPassword({ password: input.password }, 'password');

  const passwordHash = await bcrypt.hash(password, BCRYPT_COST);

  let created: PrismaUser;
  try {
    created = await db.user.create({
      data: {
        identifier,
        passwordHash,
        displayName,
        role: 'STUDENT',
        mustChangePassword: false,
      },
    });
  } catch (err: unknown) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw conflict(
        'IDENTIFIER_TAKEN',
        'An account with this identifier already exists.',
        {
          nextActions: ['Sign in with your existing account or choose a different identifier.'],
          details: { field: 'identifier' },
        },
      );
    }
    throw err;
  }

  const user = toUserDto(created);
  const token = signToken({ id: user.id, role: user.role });
  return { token, user };
}

/**
 * UC-16, FR-60: Authenticate by identifier + password.
 * Unknown identifier and wrong password both run a cost-10 bcrypt comparison and
 * throw the identical 401 INVALID_CREDENTIALS error.
 */
export async function login(input: LoginInput): Promise<AuthResponse> {
  const identifier = input.identifier.trim();
  const password = input.password;

  const row = await db.user.findUnique({ where: { identifier } });
  const targetHash = row ? row.passwordHash : DUMMY_PASSWORD_HASH;
  const matches = await bcrypt.compare(password, targetHash);

  if (!row || !matches) {
    throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid identifier or password.', {
      nextActions: ['Check your identifier and password and try again.'],
    });
  }

  const user = toUserDto(row);
  const token = signToken({ id: user.id, role: user.role });
  return { token, user };
}

/**
 * UC-16 A1: Return the current authenticated user from the database.
 * If the user row no longer exists, throw 401 UNAUTHENTICATED.
 */
export async function getMe(userId: string): Promise<User> {
  const row = await db.user.findUnique({ where: { id: userId } });
  if (!row) {
    throw unauthenticated();
  }
  return toUserDto(row);
}

/**
 * UC-16 A2: Change the authenticated user's password and clear `mustChangePassword`.
 * Wrong `currentPassword` returns 400 VALIDATION_ERROR with `details.field = 'currentPassword'`
 * (never 401, which would trigger a frontend logout).
 */
export async function changePassword(
  userId: string,
  input: ChangePasswordInput,
): Promise<void> {
  const newPassword = requireValidPassword({ newPassword: input.newPassword }, 'newPassword');
  const currentPassword = input.currentPassword;

  const row = await db.user.findUnique({ where: { id: userId } });
  if (!row) {
    throw unauthenticated();
  }

  const currentMatches = await bcrypt.compare(currentPassword, row.passwordHash);
  if (!currentMatches) {
    throw badRequest(
      'Current password is incorrect.',
      'currentPassword',
      ['Re-enter your current password and try again.'],
    );
  }

  if (newPassword === currentPassword) {
    throw badRequest(
      'New password must be different from the current password.',
      'newPassword',
      ['Choose a new password that you are not currently using.'],
    );
  }

  const newHash = await bcrypt.hash(newPassword, BCRYPT_COST);
  await db.user.update({
    where: { id: userId },
    data: {
      passwordHash: newHash,
      mustChangePassword: false,
    },
  });
}
