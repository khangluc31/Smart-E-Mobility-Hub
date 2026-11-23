// Authentication state and localStorage persistence (ARCHITECTURE §13 / §16, CONTRACTS §2).
// Token key: 'emh.token'; User key: 'emh.user'. Every localStorage access is wrapped in try/catch.
/* eslint-disable react-refresh/only-export-components */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  api,
  ApiError,
  setUnauthorizedHandler,
  TOKEN_STORAGE_KEY,
  USER_STORAGE_KEY,
} from '@/lib/api';
import type { AuthResponse, User } from '@/types/auth';
import { ROLES } from '@/types/enums';

export interface AuthContextValue {
  user: User | null;
  token: string | null;
  isLoading: boolean;
  login: (identifier: string, password: string) => Promise<User>;
  register: (identifier: string, password: string, displayName: string) => Promise<User>;
  logout: () => void;
  clearMustChangePassword: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function isValidStoredUser(val: unknown): val is User {
  if (!val || typeof val !== 'object') return false;
  const u = val as Record<string, unknown>;
  return (
    typeof u.id === 'string' &&
    typeof u.identifier === 'string' &&
    typeof u.displayName === 'string' &&
    typeof u.role === 'string' &&
    (ROLES as readonly string[]).includes(u.role) &&
    typeof u.mustChangePassword === 'boolean'
  );
}

function readInitialAuth(): { token: string | null; user: User | null; needsMeWait: boolean } {
  try {
    const rawToken = localStorage.getItem(TOKEN_STORAGE_KEY);
    const rawUser = localStorage.getItem(USER_STORAGE_KEY);
    if (!rawToken) {
      return { token: null, user: null, needsMeWait: false };
    }
    if (rawUser) {
      const parsed: unknown = JSON.parse(rawUser);
      if (isValidStoredUser(parsed)) {
        // Stored token + user exist: use immediately, refresh /auth/me in background.
        return { token: rawToken, user: parsed, needsMeWait: false };
      }
    }
    // Token present without a valid stored user: wait for /auth/me before rendering protected routes.
    return { token: rawToken, user: null, needsMeWait: true };
  } catch {
    return { token: null, user: null, needsMeWait: false };
  }
}

function persistAuth(token: string, user: User): void {
  try {
    localStorage.setItem(TOKEN_STORAGE_KEY, token);
    localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(user));
  } catch {
    // ignore storage quota / privacy errors
  }
}

function clearPersistedAuth(): void {
  try {
    localStorage.removeItem(TOKEN_STORAGE_KEY);
    localStorage.removeItem(USER_STORAGE_KEY);
  } catch {
    // ignore storage errors
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const initial = useMemo(() => readInitialAuth(), []);
  const [token, setToken] = useState<string | null>(initial.token);
  const [user, setUser] = useState<User | null>(initial.user);
  const [isLoading, setIsLoading] = useState<boolean>(initial.needsMeWait);

  const logout = useCallback(() => {
    clearPersistedAuth();
    setToken(null);
    setUser(null);
    setIsLoading(false);
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(logout);
    return () => setUnauthorizedHandler(null);
  }, [logout]);

  useEffect(() => {
    if (!initial.token) return;
    let active = true;

    api
      .get<User>('/auth/me')
      .then((freshUser) => {
        if (!active) return;
        setUser(freshUser);
        try {
          localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(freshUser));
        } catch {
          // ignore storage error
        }
      })
      .catch((err: unknown) => {
        if (!active) return;
        // 401 -> logged out (also triggered by api.ts unauthorizedHandler).
        // Transient network / server failures keep the stored user.
        if (err instanceof ApiError && err.status === 401) {
          logout();
        }
      })
      .finally(() => {
        if (active) setIsLoading(false);
      });

    return () => {
      active = false;
    };
  }, [initial.token, logout]);

  const login = useCallback(async (identifier: string, password: string): Promise<User> => {
    const res = await api.post<AuthResponse>(
      '/auth/login',
      { identifier, password },
      { skipAuthRedirect: true },
    );
    persistAuth(res.token, res.user);
    setToken(res.token);
    setUser(res.user);
    return res.user;
  }, []);

  const register = useCallback(
    async (identifier: string, password: string, displayName: string): Promise<User> => {
      const res = await api.post<AuthResponse>(
        '/auth/register',
        { identifier, password, displayName },
        { skipAuthRedirect: true },
      );
      persistAuth(res.token, res.user);
      setToken(res.token);
      setUser(res.user);
      return res.user;
    },
    [],
  );

  const clearMustChangePassword = useCallback(() => {
    setUser((prev) => {
      if (!prev) return null;
      const updated: User = { ...prev, mustChangePassword: false };
      try {
        localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(updated));
      } catch {
        // ignore storage error
      }
      return updated;
    });
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({ user, token, isLoading, login, register, logout, clearMustChangePassword }),
    [user, token, isLoading, login, register, logout, clearMustChangePassword],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used inside an AuthProvider');
  }
  return ctx;
}
