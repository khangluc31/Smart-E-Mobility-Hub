// Server-clock offset and countdown hooks (FR-07, ARCHITECTURE §13).
// syncServerClock(serverNow) is called inside query/mutation functions when responses arrive
// so the offset stays accurate without mutating during render.

import { useEffect, useState } from 'react';

let clockOffsetMs = 0;
const listeners = new Set<() => void>();

export function syncServerClock(serverNow: string | null | undefined): void {
  if (!serverNow) return;
  const parsed = Date.parse(serverNow);
  if (Number.isFinite(parsed)) {
    clockOffsetMs = parsed - Date.now();
    for (const listener of listeners) {
      listener();
    }
  }
}

export function getServerNowMs(): number {
  return Date.now() + clockOffsetMs;
}

export function useServerNowMs(tickMs = 1000): number {
  const [nowMs, setNowMs] = useState<number>(() => getServerNowMs());

  useEffect(() => {
    const update = () => setNowMs(getServerNowMs());
    listeners.add(update);
    const id = window.setInterval(update, tickMs);
    return () => {
      listeners.delete(update);
      window.clearInterval(id);
    };
  }, [tickMs]);

  return nowMs;
}

export function useCountdown(
  expiresAt: string | null | undefined,
  serverNow?: string | null,
): { msLeft: number; expired: boolean } {
  // serverNow is synced in query/mutation functions via syncServerClock; keep parameter for callers.
  void serverNow;
  const nowMs = useServerNowMs(1000);

  if (!expiresAt) {
    return { msLeft: 0, expired: false };
  }

  const target = Date.parse(expiresAt);
  if (!Number.isFinite(target)) {
    return { msLeft: 0, expired: false };
  }

  const msLeft = Math.max(0, target - nowMs);
  return {
    msLeft,
    expired: msLeft <= 0,
  };
}

export function formatCountdown(msLeft: number): string {
  const totalSeconds = Math.ceil(Math.max(0, msLeft) / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}
