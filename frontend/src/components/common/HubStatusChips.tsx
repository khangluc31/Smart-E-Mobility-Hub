// Reusable chips for Hub-level computed flags (FR-03 degraded, BR-09 nearCapacity, D-12 redirectToHubId).
// Never recomputes degraded or nearCapacity — displays the flags returned by the backend.
/* eslint-disable react-refresh/only-export-components */

import { Link } from 'react-router-dom';
import { AlertTriangle, ArrowRight, Clock } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

export function formatRelativeTime(iso: string | null): string {
  if (!iso) return 'never';
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  const diffSec = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  return `${diffHr}h ago`;
}

export interface HubStatusChipsProps {
  degraded: boolean;
  lastTelemetryAt: string | null;
  nearCapacity: boolean;
  redirectToHubId: string | null;
  redirectToHubName?: string | null;
}

export function HubStatusChips({
  degraded,
  lastTelemetryAt,
  nearCapacity,
  redirectToHubId,
  redirectToHubName,
}: HubStatusChipsProps) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {degraded ? (
        <Badge
          variant="outline"
          className="border-amber-400 bg-amber-50 text-amber-900 inline-flex items-center gap-1"
        >
          <AlertTriangle className="h-3 w-3 shrink-0" />
          <span>Data delayed — last update {formatRelativeTime(lastTelemetryAt)}</span>
        </Badge>
      ) : (
        <Badge
          variant="outline"
          className="border-emerald-300 bg-emerald-50 text-emerald-800 inline-flex items-center gap-1"
        >
          <Clock className="h-3 w-3 shrink-0" />
          <span>Live ({formatRelativeTime(lastTelemetryAt)})</span>
        </Badge>
      )}

      {nearCapacity && (
        <Badge variant="outline" className="border-red-300 bg-red-50 text-red-800">
          Near capacity
        </Badge>
      )}

      {redirectToHubId && (
        <Badge
          variant="outline"
          className="border-sky-300 bg-sky-50 text-sky-900 inline-flex items-center gap-1"
        >
          <span>Operators recommend</span>
          <Link
            to={`/app/hubs/${redirectToHubId}`}
            className="font-semibold underline underline-offset-2 inline-flex items-center gap-0.5 hover:opacity-80"
            onClick={(e) => e.stopPropagation()}
          >
            {redirectToHubName ?? redirectToHubId}
            <ArrowRight className="h-3 w-3" />
          </Link>
        </Badge>
      )}
    </div>
  );
}
