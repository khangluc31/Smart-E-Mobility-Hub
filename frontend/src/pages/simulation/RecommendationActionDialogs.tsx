// Shared two-step D-20 Preview -> Confirm & Apply dialog and Dismiss dialog (FR-58, UC-33).

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Clock,
  Loader2,
  RefreshCw,
} from 'lucide-react';
import { ApiError } from '@/lib/api';
import {
  useApplyRecommendation,
  useDismissRecommendation,
  usePreviewRecommendation,
} from '@/hooks/useSimulation';
import { StatusBadge } from '@/components/common/StatusBadge';
import { ErrorBox } from '@/components/common/ErrorBox';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { RecommendationType } from '@/types/enums';
import type { Recommendation, RecommendationApplyResult } from '@/types/simulation';

export function formatRecommendationType(type: RecommendationType): string {
  switch (type) {
    case 'REDISTRIBUTE':
      return 'Redistribute fleet';
    case 'CHARGING_ADJUST':
      return 'Adjust charging weights';
    case 'REDIRECT':
      return 'Hub redirect';
  }
}

export function formatProjectedImpact(impact: Record<string, number>): string[] {
  return Object.entries(impact).map(([key, value]) => {
    const label = key
      .replace(/([A-Z])/g, ' $1')
      .replace(/^./, (c) => c.toUpperCase())
      .trim();
    const formatted = Number.isInteger(value) ? String(value) : value.toFixed(1);
    return `${label}: ${formatted}`;
  });
}

function liveTargetForCreated(created: RecommendationApplyResult['created']): {
  to: string;
  label: string;
  summary: string;
} {
  switch (created.type) {
    case 'redistributionTask':
      return {
        to: '/ops/redistribution',
        label: 'Open Redistribution',
        summary: `Created live Redistribution Task (${created.id})`,
      };
    case 'weights':
      return {
        to: '/ops/charging',
        label: 'Open Charging queue',
        summary: `Updated live Charging Priority Weights (${created.id})`,
      };
    case 'hubRedirect':
      return {
        to: '/ops',
        label: 'Open Operations dashboard',
        summary: `Created live Hub Redirect (${created.id})`,
      };
  }
}

function extractApiErrorProblems(error: unknown): string[] {
  if (!(error instanceof ApiError) || !error.details) return [];
  const problems = error.details['problems'];
  if (!Array.isArray(problems)) return [];
  return problems.filter((p): p is string => typeof p === 'string');
}

export interface RecommendationPreviewApplyDialogProps {
  recommendation: Recommendation | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function RecommendationPreviewApplyDialog({
  recommendation,
  open,
  onOpenChange,
}: RecommendationPreviewApplyDialogProps) {
  const previewMutation = usePreviewRecommendation();
  const applyMutation = useApplyRecommendation();
  const [nowMs, setNowMs] = useState<number>(() => Date.now());

  const recId = recommendation?.id ?? null;

  // D-20: Opening fetches a fresh GET /preview to mint a 5-min confirmToken.
  useEffect(() => {
    if (open && recId) {
      applyMutation.reset();
      previewMutation.reset();
      previewMutation.mutate(recId, {
        onSuccess: () => setNowMs(Date.now()),
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, recId]);

  const preview = previewMutation.data;
  const applyResult = applyMutation.data ?? null;
  const expiresAtMs = preview?.expiresAt ? Date.parse(preview.expiresAt) : null;

  // Track confirmToken expiry while dialog is open.
  useEffect(() => {
    if (!open || !expiresAtMs) return;
    const timer = window.setInterval(() => {
      setNowMs(Date.now());
    }, 1000);
    return () => window.clearInterval(timer);
  }, [open, expiresAtMs]);

  const isExpired = Boolean(expiresAtMs && nowMs >= expiresAtMs);
  const remainingSec =
    expiresAtMs && !isExpired ? Math.max(0, Math.ceil((expiresAtMs - nowMs) / 1000)) : 0;

  const canConfirm = Boolean(
    recommendation &&
      preview &&
      preview.valid &&
      preview.confirmToken &&
      !isExpired &&
      !applyMutation.isPending &&
      !applyResult,
  );

  function handleRefreshPreview() {
    if (!recId) return;
    applyMutation.reset();
    previewMutation.mutate(recId, {
      onSuccess: () => setNowMs(Date.now()),
    });
  }

  function handleConfirmApply() {
    if (!recommendation || !preview?.confirmToken) return;
    applyMutation.mutate({ id: recommendation.id, confirmToken: preview.confirmToken });
  }

  const applyConflictProblems = extractApiErrorProblems(applyMutation.error);
  const liveTarget = applyResult ? liveTargetForCreated(applyResult.created) : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2">
            <span>Preview &amp; Apply Recommendation</span>
            {recommendation && (
              <StatusBadge
                kind="recommendation"
                value={applyResult?.recommendation.status ?? recommendation.status}
              />
            )}
          </DialogTitle>
          <DialogDescription>
            Step 1 previews exact live changes against current network state (D-20). Live data is
            unchanged until you click Confirm &amp; Apply.
          </DialogDescription>
        </DialogHeader>

        {recommendation && (
          <div className="space-y-4 text-sm">
            <div className="rounded-md border bg-muted/40 p-3 space-y-1">
              <div className="font-medium">{formatRecommendationType(recommendation.type)}</div>
              <p className="text-muted-foreground">{recommendation.reason}</p>
            </div>

            {previewMutation.isPending && (
              <div className="flex items-center gap-2 text-muted-foreground py-4">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>Checking live network rules and preparing preview…</span>
              </div>
            )}

            {previewMutation.isError && (
              <ErrorBox
                error={previewMutation.error}
                title="Could not preview recommendation"
              />
            )}

            {preview && !applyResult && (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      Live re-check:
                    </span>
                    {preview.valid ? (
                      <Badge
                        variant="outline"
                        className="border-emerald-300 bg-emerald-50 text-emerald-800"
                      >
                        Valid against live state
                      </Badge>
                    ) : (
                      <Badge
                        variant="outline"
                        className="border-red-300 bg-red-50 text-red-800"
                      >
                        Live conflict detected
                      </Badge>
                    )}
                  </div>

                  {preview.expiresAt && preview.valid && (
                    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                      <Clock className="h-3.5 w-3.5" />
                      {isExpired
                        ? 'Confirm token expired'
                        : `Token expires in ${Math.floor(remainingSec / 60)}m ${remainingSec % 60}s`}
                    </span>
                  )}
                </div>

                <div>
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-1">
                    Exact live changes to apply
                  </p>
                  <ul className="list-disc pl-5 space-y-1">
                    {preview.liveChanges.map((change, idx) => (
                      <li key={idx}>{change}</li>
                    ))}
                  </ul>
                </div>

                {preview.problems.length > 0 && (
                  <Alert variant="destructive">
                    <AlertTriangle className="h-4 w-4" />
                    <AlertTitle>Cannot apply right now</AlertTitle>
                    <AlertDescription>
                      <ul className="mt-1 list-disc pl-5 space-y-0.5">
                        {preview.problems.map((problem, idx) => (
                          <li key={idx}>{problem}</li>
                        ))}
                      </ul>
                    </AlertDescription>
                  </Alert>
                )}

                {isExpired && preview.valid && (
                  <Alert>
                    <Clock className="h-4 w-4" />
                    <AlertTitle>Confirmation token expired</AlertTitle>
                    <AlertDescription className="flex items-center justify-between gap-2">
                      <span>Refresh the preview to re-check live state and mint a new token.</span>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={handleRefreshPreview}
                      >
                        <RefreshCw className="h-3.5 w-3.5" />
                        <span>Refresh preview</span>
                      </Button>
                    </AlertDescription>
                  </Alert>
                )}
              </div>
            )}

            {applyMutation.isError && (
              <div className="space-y-2">
                <ErrorBox
                  error={applyMutation.error}
                  title="Failed to apply recommendation"
                />
                {applyConflictProblems.length > 0 && (
                  <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs">
                    <p className="font-medium text-destructive mb-1">Live state problems:</p>
                    <ul className="list-disc pl-4 space-y-0.5">
                      {applyConflictProblems.map((p, idx) => (
                        <li key={idx}>{p}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}

            {applyResult && liveTarget && (
              <Alert className="border-emerald-300 bg-emerald-50 text-emerald-950">
                <CheckCircle2 className="h-4 w-4 text-emerald-700" />
                <AlertTitle>Applied to live network</AlertTitle>
                <AlertDescription className="mt-1 space-y-2">
                  <p>{liveTarget.summary}</p>
                  <Button asChild size="sm" variant="outline">
                    <Link to={liveTarget.to} onClick={() => onOpenChange(false)}>
                      <span>{liveTarget.label}</span>
                      <ArrowRight className="h-3.5 w-3.5" />
                    </Link>
                  </Button>
                </AlertDescription>
              </Alert>
            )}
          </div>
        )}

        <DialogFooter className="gap-2">
          {!applyResult && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleRefreshPreview}
              disabled={previewMutation.isPending || applyMutation.isPending}
            >
              <RefreshCw className="h-3.5 w-3.5" />
              <span>Refresh preview</span>
            </Button>
          )}
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {applyResult ? 'Close' : 'Cancel'}
          </Button>
          {!applyResult && (
            <Button
              type="button"
              onClick={handleConfirmApply}
              disabled={!canConfirm}
            >
              {applyMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              <span>Confirm &amp; Apply to live network</span>
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export interface RecommendationDismissDialogProps {
  recommendation: Recommendation | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function RecommendationDismissDialog({
  recommendation,
  open,
  onOpenChange,
}: RecommendationDismissDialogProps) {
  const dismissMutation = useDismissRecommendation();

  useEffect(() => {
    if (open) {
      dismissMutation.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, recommendation?.id]);

  function handleDismiss() {
    if (!recommendation) return;
    dismissMutation.mutate(recommendation.id, {
      onSuccess: () => {
        onOpenChange(false);
      },
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Dismiss recommendation?</DialogTitle>
          <DialogDescription>
            Dismissing marks this recommendation as dismissed and makes zero writes to live
            operations (UC-33 A1).
          </DialogDescription>
        </DialogHeader>

        {recommendation && (
          <div className="space-y-3 text-sm">
            <div className="rounded-md border bg-muted/40 p-3 space-y-1">
              <div className="font-medium">{formatRecommendationType(recommendation.type)}</div>
              <p className="text-muted-foreground">{recommendation.reason}</p>
            </div>

            {dismissMutation.isError && (
              <ErrorBox
                error={dismissMutation.error}
                title="Could not dismiss recommendation"
              />
            )}
          </div>
        )}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={dismissMutation.isPending}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={handleDismiss}
            disabled={!recommendation || dismissMutation.isPending}
          >
            {dismissMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            <span>Dismiss (0 live writes)</span>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
