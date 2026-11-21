// Small time helpers. Services take `now: Date` so tests control the clock.

export function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000);
}

export function minutesBetween(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / 60_000;
}

// clamp(min, max, value) — argument order matches ARCHITECTURE §9.1 usage.
export function clamp(min: number, max: number, value: number): number {
  return Math.min(max, Math.max(min, value));
}

export function toIso(date: Date): string {
  return date.toISOString();
}
