// Operator Alerts Inbox (CONTRACTS §10, FR-33, FR-34, FR-35, UC-20).

import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { BellRing, Check, RotateCcw, XCircle } from 'lucide-react';
import { useHubs } from '@/hooks/useHubs';
import { useAcknowledgeAlert, useDismissAlert, useOpsAlerts } from '@/hooks/useMonitoring';
import { OPERATOR_NOTES_MAX } from '@/lib/constants';
import { StatusBadge } from '@/components/common/StatusBadge';
import { ErrorBox } from '@/components/common/ErrorBox';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { ALERT_STATUSES, ALERT_TYPES, type AlertStatus, type AlertType } from '@/types/enums';
import type { Alert } from '@/types/monitoring';

const ALL_VALUE = '__ALL__';

const ALERT_TYPE_LABELS: Record<AlertType, string> = {
  NEAR_CAPACITY: 'Near capacity',
  LOW_BATTERY: 'Low battery',
  FAULT: 'Fault',
  STALLED_FEED: 'Stalled feed',
  SHORTAGE: 'Shortage',
  SURPLUS: 'Surplus',
};

function formatTimestamp(iso: string | null): string {
  if (!iso) return '—';
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return iso;
  return new Date(parsed).toLocaleString();
}

type PendingAction = {
  alert: Alert;
  kind: 'acknowledge' | 'dismiss';
};

export function Alerts() {
  const [searchParams, setSearchParams] = useSearchParams();
  const hubId = searchParams.get('hubId') ?? '';

  const [status, setStatus] = useState<AlertStatus>('OPEN');
  const [type, setType] = useState<AlertType | ''>('');

  const { data: hubs } = useHubs();
  const hubNameMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const h of hubs ?? []) {
      map.set(h.id, h.name);
    }
    return map;
  }, [hubs]);

  const {
    data,
    isLoading,
    error,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
  } = useOpsAlerts({
    status,
    type: type || undefined,
    hubId: hubId || undefined,
  });

  const alerts = useMemo(() => data?.pages.flatMap((page) => page.items) ?? [], [data]);

  const acknowledgeMutation = useAcknowledgeAlert();
  const dismissMutation = useDismissAlert();

  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [note, setNote] = useState('');

  const activeMutation =
    pendingAction?.kind === 'dismiss' ? dismissMutation : acknowledgeMutation;

  function openActionDialog(alert: Alert, kind: 'acknowledge' | 'dismiss') {
    acknowledgeMutation.reset();
    dismissMutation.reset();
    setNote('');
    setPendingAction({ alert, kind });
  }

  function closeActionDialog() {
    setPendingAction(null);
    setNote('');
    acknowledgeMutation.reset();
    dismissMutation.reset();
  }

  function handleHubChange(value: string) {
    const nextHubId = value === ALL_VALUE ? '' : value;
    const nextParams = new URLSearchParams(searchParams);
    if (nextHubId) {
      nextParams.set('hubId', nextHubId);
    } else {
      nextParams.delete('hubId');
    }
    setSearchParams(nextParams, { replace: true });
  }

  function handleResetFilters() {
    setStatus('OPEN');
    setType('');
    if (searchParams.has('hubId')) {
      const nextParams = new URLSearchParams(searchParams);
      nextParams.delete('hubId');
      setSearchParams(nextParams, { replace: true });
    }
  }

  async function handleConfirmAction(e: React.FormEvent) {
    e.preventDefault();
    if (!pendingAction) return;
    try {
      const payload = { id: pendingAction.alert.id, note: note.trim() || undefined };
      if (pendingAction.kind === 'acknowledge') {
        await acknowledgeMutation.mutateAsync(payload);
      } else {
        await dismissMutation.mutateAsync(payload);
      }
      closeActionDialog();
    } catch {
      // Error is displayed in <ErrorBox /> via activeMutation.error.
    }
  }

  const hasCustomFilters = status !== 'OPEN' || Boolean(type) || Boolean(hubId);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Operational Alerts</h1>
          <p className="text-sm text-muted-foreground">
            Live alert inbox across all Hubs (auto-refreshing every 5 s).
          </p>
        </div>
        <Badge variant="outline" className="gap-1.5">
          <BellRing className="h-3.5 w-3.5" />
          <span>
            {alerts.length} {status.toLowerCase()}
          </span>
        </Badge>
      </div>

      {/* Filter bar */}
      <Card>
        <CardContent className="pt-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 items-end">
            <div className="space-y-1.5">
              <Label htmlFor="alerts-filter-status">Status</Label>
              <Select value={status} onValueChange={(v) => setStatus(v as AlertStatus)}>
                <SelectTrigger id="alerts-filter-status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ALERT_STATUSES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {s}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="alerts-filter-type">Alert type</Label>
              <Select
                value={type || ALL_VALUE}
                onValueChange={(v) => setType(v === ALL_VALUE ? '' : (v as AlertType))}
              >
                <SelectTrigger id="alerts-filter-type">
                  <SelectValue placeholder="All types" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL_VALUE}>All types</SelectItem>
                  {ALERT_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>
                      {ALERT_TYPE_LABELS[t]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="alerts-filter-hub">Hub</Label>
              <Select value={hubId || ALL_VALUE} onValueChange={handleHubChange}>
                <SelectTrigger id="alerts-filter-hub">
                  <SelectValue placeholder="All Hubs" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL_VALUE}>All Hubs</SelectItem>
                  {(hubs ?? []).map((h) => (
                    <SelectItem key={h.id} value={h.id}>
                      {h.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex justify-end">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleResetFilters}
                disabled={!hasCustomFilters}
              >
                <RotateCcw className="h-3.5 w-3.5" />
                <span>Reset filters</span>
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {error && <ErrorBox error={error} title="Failed to load alerts" />}

      {isLoading && (
        <div className="space-y-3">
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-28 w-full" />
        </div>
      )}

      {!isLoading && !error && alerts.length === 0 && (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            No {status.toLowerCase()} alerts match the current filters.
          </CardContent>
        </Card>
      )}

      {alerts.length > 0 && (
        <div className="space-y-3">
          {alerts.map((alert) => {
            const metricEntries = Object.entries(alert.metric ?? {});
            const hubLabel = hubNameMap.get(alert.hubId) ?? alert.hubId;
            return (
              <Card key={alert.id}>
                <CardHeader className="pb-2">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusBadge kind="alert" value={alert.status} />
                      <Badge variant="secondary">{ALERT_TYPE_LABELS[alert.type]}</Badge>
                      <Badge variant="outline">{hubLabel}</Badge>
                      {alert.vehicleClass && (
                        <Badge variant="outline">{alert.vehicleClass}</Badge>
                      )}
                    </div>
                    {alert.status === 'OPEN' && (
                      <div className="flex items-center gap-2">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => openActionDialog(alert, 'acknowledge')}
                        >
                          <Check className="h-3.5 w-3.5" />
                          <span>Acknowledge</span>
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => openActionDialog(alert, 'dismiss')}
                        >
                          <XCircle className="h-3.5 w-3.5" />
                          <span>Dismiss</span>
                        </Button>
                      </div>
                    )}
                  </div>
                  <CardTitle className="text-sm font-medium pt-1">{alert.message}</CardTitle>
                </CardHeader>

                <CardContent className="space-y-2 text-xs">
                  {alert.resourceIds.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-muted-foreground font-medium">Resources:</span>
                      {alert.resourceIds.map((rid) => (
                        <span
                          key={rid}
                          className="rounded border bg-muted px-1.5 py-0.5 font-mono text-[11px]"
                        >
                          {rid}
                        </span>
                      ))}
                    </div>
                  )}

                  {metricEntries.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-muted-foreground font-medium">Metrics:</span>
                      {metricEntries.map(([k, v]) => (
                        <Badge key={k} variant="outline" className="font-mono text-[11px]">
                          {k}: {String(v)}
                        </Badge>
                      ))}
                    </div>
                  )}

                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground pt-1">
                    <span>Created: {formatTimestamp(alert.createdAt)}</span>
                    <span>Last seen: {formatTimestamp(alert.lastSeenAt)}</span>
                    {alert.closedAt && <span>Closed: {formatTimestamp(alert.closedAt)}</span>}
                    {alert.closedById && (
                      <span>
                        Closed by: <span className="font-mono">{alert.closedById}</span>
                      </span>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })}

          {hasNextPage && (
            <div className="flex justify-center pt-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => void fetchNextPage()}
                disabled={isFetchingNextPage}
              >
                {isFetchingNextPage ? 'Loading more…' : 'Load more'}
              </Button>
            </div>
          )}
        </div>
      )}

      {/* Acknowledge / Dismiss confirm dialog */}
      <Dialog open={Boolean(pendingAction)} onOpenChange={(open) => !open && closeActionDialog()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {pendingAction?.kind === 'acknowledge' ? 'Acknowledge alert' : 'Dismiss alert'}
            </DialogTitle>
            <DialogDescription>
              {pendingAction && (
                <span>
                  {ALERT_TYPE_LABELS[pendingAction.alert.type]} at{' '}
                  {hubNameMap.get(pendingAction.alert.hubId) ?? pendingAction.alert.hubId}:{' '}
                  {pendingAction.alert.message}
                </span>
              )}
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={(e) => void handleConfirmAction(e)} className="space-y-4">
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label htmlFor="alert-action-note">Operator note (optional)</Label>
                <span className="text-xs text-muted-foreground tabular-nums">
                  {note.length}/{OPERATOR_NOTES_MAX}
                </span>
              </div>
              <textarea
                id="alert-action-note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                maxLength={OPERATOR_NOTES_MAX}
                rows={3}
                placeholder="Add context for the audit log (optional)…"
                className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              />
            </div>

            {activeMutation.error ? (
              <ErrorBox
                error={activeMutation.error}
                title={`Could not ${pendingAction?.kind ?? 'update'} alert`}
              />
            ) : null}

            <DialogFooter>
              <Button type="button" variant="outline" onClick={closeActionDialog}>
                Cancel
              </Button>
              <Button
                type="submit"
                variant={pendingAction?.kind === 'dismiss' ? 'destructive' : 'default'}
                disabled={activeMutation.isPending}
              >
                {activeMutation.isPending
                  ? 'Saving…'
                  : pendingAction?.kind === 'acknowledge'
                    ? 'Confirm acknowledge'
                    : 'Confirm dismiss'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
