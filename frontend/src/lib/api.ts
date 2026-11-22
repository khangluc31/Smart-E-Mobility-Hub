// HTTP client for /api (ARCHITECTURE §13, CONTRACTS §0).
// Never import React here. AuthContext registers the 401 logout handler via setUnauthorizedHandler.

import type { Alternative, ApiErrorBody } from '@/types/common';

const BASE_URL = (import.meta.env.VITE_API_URL as string | undefined) ?? '/api';

export const TOKEN_STORAGE_KEY = 'emh.token';
export const USER_STORAGE_KEY = 'emh.user';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly nextActions: string[];
  readonly alternatives?: Alternative[];
  readonly details?: Record<string, unknown>;

  constructor(opts: {
    status: number;
    code: string;
    message: string;
    nextActions: string[];
    alternatives?: Alternative[];
    details?: Record<string, unknown>;
  }) {
    super(opts.message);
    this.name = 'ApiError';
    this.status = opts.status;
    this.code = opts.code;
    this.nextActions = opts.nextActions;
    this.alternatives = opts.alternatives;
    this.details = opts.details;
  }
}

export interface RequestOptions {
  idempotencyKey?: string;
  headers?: Record<string, string>;
  skipAuthRedirect?: boolean;
}

let unauthorizedHandler: (() => void) | null = null;

export function setUnauthorizedHandler(fn: (() => void) | null): void {
  unauthorizedHandler = fn;
}

export function getStoredToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function clearStoredToken(): void {
  try {
    localStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    // ignore storage errors
  }
}

function networkError(): ApiError {
  return new ApiError({
    status: 0,
    code: 'NETWORK_ERROR',
    message: 'Cannot reach the server',
    nextActions: ['Check your connection and try again'],
  });
}

function isApiErrorBody(val: unknown): val is ApiErrorBody {
  if (!val || typeof val !== 'object') return false;
  const err = (val as { error?: unknown }).error;
  if (!err || typeof err !== 'object') return false;
  const e = err as Record<string, unknown>;
  return (
    typeof e.code === 'string' &&
    typeof e.message === 'string' &&
    Array.isArray(e.nextActions)
  );
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  opts?: RequestOptions,
): Promise<T> {
  const url = `${BASE_URL}${path.startsWith('/') ? path : `/${path}`}`;
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...opts?.headers,
  };

  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  const token = getStoredToken();
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  if (opts?.idempotencyKey) {
    headers['Idempotency-Key'] = opts.idempotencyKey;
  }

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw networkError();
  }

  if (res.status === 204) {
    return undefined as T;
  }

  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    if (!res.ok) {
      if (res.status === 401 && !opts?.skipAuthRedirect && path !== '/auth/login') {
        clearStoredToken();
        unauthorizedHandler?.();
      }
      throw networkError();
    }
    return undefined as T;
  }

  if (!res.ok) {
    // 401 on an authenticated call clears the token and notifies AuthContext,
    // except /auth/login (INVALID_CREDENTIALS) which should display in ErrorBox without a redirect loop.
    if (res.status === 401 && !opts?.skipAuthRedirect && path !== '/auth/login') {
      clearStoredToken();
      unauthorizedHandler?.();
    }

    if (isApiErrorBody(parsed)) {
      throw new ApiError({
        status: res.status,
        code: parsed.error.code,
        message: parsed.error.message,
        nextActions: parsed.error.nextActions,
        alternatives: parsed.error.alternatives,
        details: parsed.error.details,
      });
    }

    throw new ApiError({
      status: res.status,
      code: 'HTTP_ERROR',
      message: `Request failed with status ${res.status}.`,
      nextActions: ['Try again in a moment.'],
    });
  }

  return parsed as T;
}

export const api = {
  get<T>(path: string, opts?: RequestOptions): Promise<T> {
    return request<T>('GET', path, undefined, opts);
  },
  post<T>(path: string, body?: unknown, opts?: RequestOptions): Promise<T> {
    return request<T>('POST', path, body, opts);
  },
  patch<T>(path: string, body?: unknown, opts?: RequestOptions): Promise<T> {
    return request<T>('PATCH', path, body, opts);
  },
  put<T>(path: string, body?: unknown, opts?: RequestOptions): Promise<T> {
    return request<T>('PUT', path, body, opts);
  },
  delete<T>(path: string, opts?: RequestOptions): Promise<T> {
    return request<T>('DELETE', path, undefined, opts);
  },
};

