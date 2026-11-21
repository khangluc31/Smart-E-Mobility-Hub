// Typed errors, factory helpers and hand-written validation (no Zod, NFR-13).
// DB-free on purpose: the error handler that writes the D-22 audit row lives in
// errorHandler.ts so this file never imports core/db (keeps core cycle-free).

export interface Alternative {
  type: string;
  hubId?: string;
  hubName?: string;
  id?: string;
  batteryPct?: number;
  free?: number;
  start?: string;
  end?: string;
  reason?: string;
}

export interface ErrorBody {
  code: string;
  message: string;
  nextActions: string[];
  alternatives?: Alternative[];
  details?: Record<string, unknown>;
}

export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly nextActions: string[];
  readonly alternatives?: Alternative[];
  readonly details?: Record<string, unknown>;

  constructor(
    status: number,
    code: string,
    message: string,
    opts: { nextActions: string[]; alternatives?: Alternative[]; details?: Record<string, unknown> },
  ) {
    super(message);
    this.name = 'AppError';
    if (!opts.nextActions || opts.nextActions.length === 0) {
      // Programming error: every user-facing error must offer a next action (NFR-05).
      throw new Error(`AppError ${code} created without a nextActions entry`);
    }
    this.status = status;
    this.code = code;
    this.nextActions = opts.nextActions;
    this.alternatives = opts.alternatives;
    this.details = opts.details;
  }

  toBody(): ErrorBody {
    const body: ErrorBody = {
      code: this.code,
      message: this.message,
      nextActions: this.nextActions,
    };
    if (this.alternatives) body.alternatives = this.alternatives;
    if (this.details) body.details = this.details;
    return body;
  }
}

export class InvalidStateTransitionError extends AppError {
  constructor(entity: string, from: string, to: string) {
    super(409, 'INVALID_STATE_TRANSITION', `Cannot change ${entity} from ${from} to ${to}.`, {
      nextActions: ['Refresh and try again with the current state.'],
      details: { entity, from, to },
    });
    this.name = 'InvalidStateTransitionError';
  }
}

// --- factories ---

export function badRequest(message: string, field: string, nextActions?: string[]): AppError {
  return new AppError(400, 'VALIDATION_ERROR', message, {
    nextActions: nextActions ?? ['Check the input and try again.'],
    details: { field },
  });
}

export function notFound(what = 'Resource'): AppError {
  return new AppError(404, 'NOT_FOUND', `${what} not found.`, {
    nextActions: ['Check the id and try again.'],
  });
}

export function forbidden(message = 'You do not have access to this action.'): AppError {
  return new AppError(403, 'FORBIDDEN', message, {
    nextActions: ['Sign in with an account that has the required role.'],
  });
}

export function unauthenticated(): AppError {
  return new AppError(401, 'UNAUTHENTICATED', 'Authentication is required.', {
    nextActions: ['Sign in and try again.'],
  });
}

export function conflict(
  code: string,
  message: string,
  opts: { nextActions: string[]; alternatives?: Alternative[]; details?: Record<string, unknown> },
): AppError {
  return new AppError(409, code, message, opts);
}

// --- validation helpers ---
// Each reads source[field], returns the typed value, or throws badRequest with details.field.

type Source = Record<string, unknown>;

function present(source: Source, field: string): unknown {
  const v = source[field];
  if (v === undefined || v === null) throw badRequest(`${field} is required.`, field);
  return v;
}

export function requireString(
  source: Source,
  field: string,
  opts: { min?: number; max?: number; trim?: boolean } = {},
): string {
  let v = present(source, field);
  if (typeof v !== 'string') throw badRequest(`${field} must be a string.`, field);
  if (opts.trim) v = v.trim();
  const s = v as string;
  if (opts.min !== undefined && s.length < opts.min)
    throw badRequest(`${field} must be at least ${opts.min} characters.`, field);
  if (opts.max !== undefined && s.length > opts.max)
    throw badRequest(`${field} must be at most ${opts.max} characters.`, field);
  return s;
}

export function requireNumber(
  source: Source,
  field: string,
  opts: { min?: number; max?: number } = {},
): number {
  const v = present(source, field);
  let n: number;
  if (typeof v === 'number') n = v;
  else if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) n = Number(v);
  else throw badRequest(`${field} must be a number.`, field);
  if (!Number.isFinite(n)) throw badRequest(`${field} must be a number.`, field);
  if (opts.min !== undefined && n < opts.min)
    throw badRequest(`${field} must be at least ${opts.min}.`, field);
  if (opts.max !== undefined && n > opts.max)
    throw badRequest(`${field} must be at most ${opts.max}.`, field);
  return n;
}

export function requireInt(
  source: Source,
  field: string,
  opts: { min?: number; max?: number } = {},
): number {
  const n = requireNumber(source, field, {});
  if (!Number.isInteger(n)) throw badRequest(`${field} must be an integer.`, field);
  if (opts.min !== undefined && n < opts.min)
    throw badRequest(`${field} must be at least ${opts.min}.`, field);
  if (opts.max !== undefined && n > opts.max)
    throw badRequest(`${field} must be at most ${opts.max}.`, field);
  return n;
}

export function requireBoolean(source: Source, field: string): boolean {
  const v = present(source, field);
  if (typeof v === 'boolean') return v;
  if (v === 'true') return true;
  if (v === 'false') return false;
  throw badRequest(`${field} must be a boolean.`, field);
}

export function requireEnum<T extends string>(
  source: Source,
  field: string,
  values: readonly T[],
): T {
  const v = present(source, field);
  if (typeof v !== 'string' || !values.includes(v as T))
    throw badRequest(`${field} must be one of: ${values.join(', ')}.`, field);
  return v as T;
}

const ISO_DATE =
  /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?)?$/;

export function requireIsoDate(source: Source, field: string): Date {
  const v = present(source, field);
  if (typeof v !== 'string' || !ISO_DATE.test(v))
    throw badRequest(`${field} must be an ISO-8601 date.`, field);
  const ms = Date.parse(v);
  if (Number.isNaN(ms)) throw badRequest(`${field} must be a valid date.`, field);
  return new Date(ms);
}

export function requireStringArray(
  source: Source,
  field: string,
  opts: { minItems?: number } = {},
): string[] {
  const v = present(source, field);
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string'))
    throw badRequest(`${field} must be an array of strings.`, field);
  const arr = v as string[];
  if (opts.minItems !== undefined && arr.length < opts.minItems)
    throw badRequest(`${field} must have at least ${opts.minItems} item(s).`, field);
  return arr;
}

// optional(requireInt)(source, field, opts) → undefined when the field is absent/null.
export function optional<A extends unknown[], T>(
  helper: (source: Source, field: string, ...args: A) => T,
): (source: Source, field: string, ...args: A) => T | undefined {
  return (source, field, ...args) => {
    const v = source[field];
    if (v === undefined || v === null) return undefined;
    return helper(source, field, ...args);
  };
}
