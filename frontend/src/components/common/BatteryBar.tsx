// Visual battery level indicator (AGENTS §5, BR-02).
// Shows battery percentage 0–100 and colours the bar red when below MIN_RENTAL_BATTERY_PCT.

import { MIN_RENTAL_BATTERY_PCT } from '@/lib/constants';
import { cn } from '@/lib/utils';

export interface BatteryBarProps {
  pct: number;
  className?: string;
}

export function BatteryBar({ pct, className }: BatteryBarProps) {
  const clamped = Math.max(0, Math.min(100, pct));
  const isLow = clamped < MIN_RENTAL_BATTERY_PCT;

  return (
    <div
      className={cn('inline-flex items-center gap-2', className)}
      aria-label={`Battery ${clamped}%`}
    >
      <div className="h-2.5 w-16 overflow-hidden rounded-full bg-neutral-200">
        <div
          className={cn('h-full transition-all', isLow ? 'bg-red-600' : 'bg-emerald-600')}
          style={{ width: `${clamped}%` }}
        />
      </div>
      <span
        className={cn(
          'text-xs font-medium tabular-nums',
          isLow ? 'text-red-700 font-semibold' : 'text-foreground',
        )}
      >
        {clamped}%
      </span>
    </div>
  );
}
