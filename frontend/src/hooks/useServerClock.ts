// Server-clock offset and countdown hooks (FR-07, ARCHITECTURE §13).
// syncServerClock(serverNow) is called inside query/mutation functions when responses arrive
// so the offset stays accurate without mutating during render.

import { useEffect, useState } from 'react';

let clockOffsetMs = 0;

export function syncServerClock(serverNow: string | null | undefined): void {
  if (!serverNow) return;
  const parsed = Date.parse(serverNow);
  if (Number.isFinite(parsed)) {
    clockOffsetMs = parsed - Date.now();
  }
}

export function getServerNowMs(): number {
  return Date.now() + clockOffsetMs;
}

export function useServerNowMs(tickMs = 1000): number {
  const [nowMs, setNowMs] = useState<number>(() => getServerNowMs());

  useEffect(() => {
    const id = window.setInterval(() => {
      setNowMs(getServerNowMs());
    }, tickMs);
    return () => window.clearInterval(id);
  }, [tickMs]);

  return nowMs;
}

function computeMsLeft(expiresAt: string | null | undefined): number {
  if (!expiresAt) return 0;
  const target = Date.parse(expiresAt);
  if (!Number.isFinite(target)) return 0;
  return Math.max(0, target - getServerNowMs());
}

export function useCountdown(
  expiresAt: string | null | undefined,
  serverNow?: string | null,
): { msLeft: number; expired: boolean } {
  const [msLeft, setMsLeft] = useState<number>(() => computeMsLeft(expiresAt));

  useEffect(() => {
    setMsLeft(computeMsLeft(expiresAt));
    if (!expiresAt) return;

    const id = window.setInterval(() => {
      setMsLeft(computeMsLeft(expiresAt));
    }, 1000);
    return () => window.clearInterval(id);
  }, [expiresAt, serverNow]);

  return {
    msLeft,
    expired: Boolean(expiresAt) && msLeft <= 0,
  };
}

export function formatCountdown(msLeft: number): string {
  const totalSeconds = Math.ceil(Math.max(0, msLeft) / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}
