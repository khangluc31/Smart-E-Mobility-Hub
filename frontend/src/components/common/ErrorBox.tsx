// Standard error display for API errors (NFR-05, CONTRACTS §0, ARCHITECTURE §4.4).
// Renders message, nextActions list, and alternatives (hub alternatives link to /app/hubs/:hubId).

import { Link } from 'react-router-dom';
import { AlertCircle, ArrowRight } from 'lucide-react';
import { ApiError } from '@/lib/api';
import type { Alternative } from '@/types/common';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';

export interface ErrorBoxProps {
  error: unknown;
  title?: string;
  className?: string;
}

function normaliseError(error: unknown): {
  code?: string;
  message: string;
  nextActions: string[];
  alternatives: Alternative[];
} {
  if (error instanceof ApiError) {
    return {
      code: error.code,
      message: error.message,
      nextActions: error.nextActions,
      alternatives: error.alternatives ?? [],
    };
  }
  if (error instanceof Error && error.message) {
    return {
      message: error.message,
      nextActions: ['Try again or refresh the page.'],
      alternatives: [],
    };
  }
  return {
    message: 'An unexpected error occurred.',
    nextActions: ['Try again or refresh the page.'],
    alternatives: [],
  };
}

export function ErrorBox({ error, title = 'Something went wrong', className }: ErrorBoxProps) {
  if (!error) return null;
  const { code, message, nextActions, alternatives } = normaliseError(error);

  return (
    <Alert variant="destructive" className={className} role="alert">
      <AlertCircle className="h-4 w-4" />
      <AlertTitle className="flex flex-wrap items-center gap-2">
        <span>{title}</span>
        {code && (
          <span className="rounded bg-destructive/15 px-1.5 py-0.5 font-mono text-xs">{code}</span>
        )}
      </AlertTitle>
      <AlertDescription className="mt-2 space-y-2 text-sm">
        <p>{message}</p>

        {nextActions.length > 0 && (
          <div>
            <p className="font-medium text-xs uppercase tracking-wide opacity-80">Next steps</p>
            <ul className="mt-1 list-disc pl-5 space-y-0.5">
              {nextActions.map((action, idx) => (
                <li key={idx}>{action}</li>
              ))}
            </ul>
          </div>
        )}

        {alternatives.length > 0 && (
          <div>
            <p className="font-medium text-xs uppercase tracking-wide opacity-80">Alternatives</p>
            <ul className="mt-1 space-y-1">
              {alternatives.map((alt, idx) => {
                if (alt.type === 'hub' && alt.hubId) {
                  return (
                    <li key={idx}>
                      <Link
                        to={`/app/hubs/${alt.hubId}`}
                        className="inline-flex items-center gap-1 font-medium underline underline-offset-2 hover:opacity-80"
                      >
                        <span>{alt.hubName ?? alt.hubId}</span>
                        <span>— {alt.reason}</span>
                        <ArrowRight className="h-3.5 w-3.5" />
                      </Link>
                    </li>
                  );
                }
                // TODO(M4/M6): make rentalVehicle and time alternatives interactive in reservations/charging pages
                return (
                  <li key={idx} className="text-xs">
                    {alt.reason}
                    {alt.id ? ` (${alt.id})` : ''}
                    {alt.start && alt.end ? ` (${alt.start} – ${alt.end})` : ''}
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </AlertDescription>
    </Alert>
  );
}
