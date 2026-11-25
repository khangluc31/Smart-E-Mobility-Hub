// Simulation Run Detail: live polling, KPIs, 15-min interval explorer, recommendations
// (/sim/runs/:runId, FR-55, FR-56, FR-57, FR-58, D-20).

import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowLeft,
  Bookmark,
  BookmarkX,
  CheckCircle2,
  GitCompareArrows,
  Loader2,
} from 'lucide-react';
import { NEAR_CAPACITY_PCT, SIM_INTERVAL_MIN } from '@/lib/constants';
import { useHubs } from '@/hooks/useHubs';
import {
  useSaveSimRun,
  useSimRunDetail,
  useSimScenario,
  useUnsaveSimRun,
} from '@/hooks/useSimulation';
import { StatusBadge } from '@/components/common/StatusBadge';
import { ErrorBox } from '@/components/common/ErrorBox';
import {
  formatProjectedImpact,
  formatRecommendationType,
  RecommendationDismissDialog,
  RecommendationPreviewApplyDialog,
} from '@/pages/simulation/RecommendationActionDialogs';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import type { Recommendation } from '@/types/simulation';

function UtilBar({ pct }: { pct: number }) {
  const clamped = Math.max(0, Math.min(100, pct));
  const isNearCap = pct >= NEAR_CAPACITY_PCT;
  return (
    <div className="flex items-center gap-2 min-w-[100px]">
      <div className="h-2 flex-1 rounded-full bg-muted overflow-hidden">
        <div
          className={cn(
            'h-full rounded-full transition-all',
            isNearCap ? 'bg-red-500' : pct >= 70 ? 'bg-amber-500' : 'bg-emerald-500',
          )}
          style={{ width: `${clamped}%` }}
        />
      </div>
      <span
        className={cn(
          'text-xs tabular-nums w-10 text-right',
          isNearCap && 'font-semibold text-red-700',
        )}
      >
        {pct.toFixed(0)}%
      </span>
    </div>
  );
}

export function RunDetail() {
  const { runId } = useParams<{ runId: string }>();
  const detailQuery = useSimRunDetail(runId ?? null);
  const scenarioQuery = useSimScenario(detailQuery.data?.run.scenarioId ?? null);
  const hubsQuery = useHubs();
  const saveRun = useSaveSimRun();
  const unsaveRun = useUnsaveSimRun();

  const [hubFilter, setHubFilter] = useState<string>('ALL');
  const [breachesOnly, setBreachesOnly] = useState(false);
  const [saveDialogOpen, setSaveDialogOpen] = useState(false);
  const [saveName, setSaveName] = useState('');

  const [previewTarget, setPreviewTarget] = useState<Recommendation | null>(null);
  const [dismissTarget, setDismissTarget] = useState<Recommendation | null>(null);

  const hubNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const h of hubsQuery.data ?? []) map.set(h.id, h.name);
    return map;
  }, [hubsQuery.data]);

  const detail = detailQuery.data;

  const filteredIntervals = useMemo(() => {
    if (!detail) return [];
    return detail.intervals.filter((iv) => {
      if (hubFilter !== 'ALL' && iv.hubId !== hubFilter) return false;
      if (breachesOnly && !iv.breach) return false;
      return true;
    });
  }, [detail, hubFilter, breachesOnly]);

  const intervalHubIds = useMemo(() => {
    if (!detail) return [];
    return Array.from(new Set(detail.summary.map((s) => s.hubId)));
  }, [detail]);

  function openSave() {
    if (!detail) return;
    saveRun.reset();
    setSaveName(detail.run.savedName ?? scenarioQuery.data?.name ?? '');
    setSaveDialogOpen(true);
  }

  function handleSaveSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!detail || !saveName.trim()) return;
    saveRun.mutate(
      { id: detail.run.id, name: saveName.trim() },
      {
        onSuccess: () => setSaveDialogOpen(false),
      },
    );
  }

  if (detailQuery.isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (detailQuery.isError || !detail) {
    return (
      <div className="space-y-4">
        <Button asChild variant="outline" size="sm">
          <Link to="/sim/runs">
            <ArrowLeft className="h-4 w-4" />
            <span>Back to runs</span>
          </Link>
        </Button>
        <ErrorBox error={detailQuery.error} title="Could not load simulation run" />
      </div>
    );
  }

  const { run, summary, recommendations, warning } = detail;

  return (
    <div className="space-y-6">
      <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-4">
        <div className="space-y-1.5">
          <div className="flex items-center gap-2">
            <Button asChild variant="ghost" size="sm" className="-ml-2">
              <Link to="/sim/runs">
                <ArrowLeft className="h-4 w-4" />
                <span>Runs</span>
              </Link>
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">
              {scenarioQuery.data?.name ?? `Run ${run.id}`}
            </h1>
            <StatusBadge kind="simRun" value={run.status} />
            {run.savedName && (
              <Badge variant="outline" className="border-amber-300 bg-amber-50 text-amber-900">
                Saved: {run.savedName}
              </Badge>
            )}
          </div>
          <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
            <span>Snapshot: {new Date(run.snapshotTakenAt).toLocaleString()}</span>
            <span>Started: {new Date(run.startedAt).toLocaleString()}</span>
            <span>Duration: {run.durationMs !== null ? `${run.durationMs} ms` : 'Running…'}</span>
            {scenarioQuery.data && (
              <span>
                Horizon: {scenarioQuery.data.horizonH} h · Seed: {scenarioQuery.data.seed}
              </span>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          {run.status === 'COMPLETED' && (
            <>
              <Button asChild variant="outline" size="sm">
                <Link to={`/sim/compare?runA=${encodeURIComponent(run.id)}`}>
                  <GitCompareArrows className="h-4 w-4" />
                  <span>Compare</span>
                </Link>
              </Button>
              {run.savedName ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => unsaveRun.mutate(run.id)}
                  disabled={unsaveRun.isPending}
                >
                  <BookmarkX className="h-4 w-4" />
                  <span>Unsave</span>
                </Button>
              ) : (
                <Button type="button" variant="outline" size="sm" onClick={openSave}>
                  <Bookmark className="h-4 w-4" />
                  <span>Save</span>
                </Button>
              )}
            </>
          )}
        </div>
      </div>

      {unsaveRun.isError && <ErrorBox error={unsaveRun.error} title="Could not unsave run" />}

      {run.status === 'RUNNING' && (
        <Alert className="border-sky-300 bg-sky-50 text-sky-950">
          <Loader2 className="h-4 w-4 animate-spin text-sky-700" />
          <AlertTitle>Simulation running</AlertTitle>
          <AlertDescription>
            Stepping through the read-only snapshot in the sandbox. Polling every 1 s until
            completion…
          </AlertDescription>
        </Alert>
      )}

      {warning === 'NETWORK_SATURATED' && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Network saturated (UC-32 E1)</AlertTitle>
          <AlertDescription>
            Every Hub reached or exceeded {NEAR_CAPACITY_PCT}% utilisation during this scenario.
            Partial recommendations are listed below.
          </AlertDescription>
        </Alert>
      )}

      {/* Per-Hub Summary Cards */}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Per-Hub Summary</h2>
        {summary.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Summary metrics will appear once intervals are generated.
          </p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {summary.map((s) => {
              const parkingHigh = s.peakParkingUtilPct >= NEAR_CAPACITY_PCT;
              const chargingHigh = s.peakChargingUtilPct >= NEAR_CAPACITY_PCT;
              return (
                <Card
                  key={s.hubId}
                  className={cn(
                    (parkingHigh || chargingHigh) && 'border-red-300 bg-red-50/30',
                  )}
                >
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base flex items-center justify-between gap-2">
                      <span>{hubNameById.get(s.hubId) ?? s.hubId}</span>
                      {(parkingHigh || chargingHigh) && (
                        <Badge
                          variant="outline"
                          className="border-red-300 bg-red-50 text-red-800 text-xs"
                        >
                          &ge; {NEAR_CAPACITY_PCT}% peak
                        </Badge>
                      )}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="grid grid-cols-2 gap-3 text-sm">
                    <div>
                      <p className="text-xs text-muted-foreground">Peak parking</p>
                      <p className={cn('font-semibold', parkingHigh && 'text-red-700')}>
                        {s.peakParkingUtilPct.toFixed(1)}%
                      </p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">Peak charging</p>
                      <p className={cn('font-semibold', chargingHigh && 'text-red-700')}>
                        {s.peakChargingUtilPct.toFixed(1)}%
                      </p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">Avg charging wait</p>
                      <p className="font-semibold">{s.avgChargingWaitMin.toFixed(1)} min</p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">Unserved total</p>
                      <p className={cn('font-semibold', s.unservedTotal > 0 && 'text-amber-800')}>
                        {s.unservedTotal}
                      </p>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </section>

      {/* Recommendations Panel */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Recommendations ({recommendations.length})</h2>
          <Button asChild variant="outline" size="sm">
            <Link to="/sim/recommendations">Open Recommendations view</Link>
          </Button>
        </div>

        {run.status === 'COMPLETED' && recommendations.length === 0 ? (
          <Alert className="border-emerald-300 bg-emerald-50 text-emerald-950">
            <CheckCircle2 className="h-4 w-4 text-emerald-700" />
            <AlertTitle>Network remains balanced</AlertTitle>
            <AlertDescription>
              No Hub breached {NEAR_CAPACITY_PCT}% utilisation or had unserved demand in this run
              (UC-32 A1).
            </AlertDescription>
          </Alert>
        ) : (
          <div className="space-y-3">
            {recommendations.map((rec) => (
              <Card key={rec.id}>
                <CardContent className="pt-4 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
                  <div className="space-y-1.5 min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusBadge kind="recommendation" value={rec.status} />
                      <span className="font-medium text-sm">
                        {formatRecommendationType(rec.type)}
                      </span>
                      <Badge variant="outline" className="font-mono text-xs">
                        {rec.type}
                      </Badge>
                    </div>
                    <p className="text-sm text-muted-foreground">{rec.reason}</p>
                    <div className="flex flex-wrap gap-1.5">
                      {formatProjectedImpact(rec.projectedImpact).map((chip, idx) => (
                        <Badge key={idx} variant="secondary" className="text-xs font-normal">
                          {chip}
                        </Badge>
                      ))}
                    </div>
                  </div>

                  {rec.status === 'PENDING' && (
                    <div className="flex items-center gap-2 shrink-0">
                      <Button
                        type="button"
                        size="sm"
                        onClick={() => setPreviewTarget(rec)}
                      >
                        Preview &amp; Apply
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => setDismissTarget(rec)}
                      >
                        Dismiss
                      </Button>
                    </div>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </section>

      {/* 15-min Intervals Explorer */}
      <Card>
        <CardHeader>
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <CardTitle>{SIM_INTERVAL_MIN}-Minute Intervals ({filteredIntervals.length})</CardTitle>
              <CardDescription>
                Rows breaching {NEAR_CAPACITY_PCT}% utilisation or with unserved demand are
                highlighted (FR-56).
              </CardDescription>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Select value={hubFilter} onValueChange={setHubFilter}>
                <SelectTrigger className="w-44">
                  <SelectValue placeholder="Filter Hub" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">All Hubs</SelectItem>
                  {intervalHubIds.map((hid) => (
                    <SelectItem key={hid} value={hid}>
                      {hubNameById.get(hid) ?? hid}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                type="button"
                size="sm"
                variant={breachesOnly ? 'destructive' : 'outline'}
                onClick={() => setBreachesOnly((v) => !v)}
              >
                {breachesOnly ? 'Showing breaches only' : 'Breaches only'}
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {filteredIntervals.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4">
              No intervals match the selected filters.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs border-collapse">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="py-2 pr-3 font-medium">Time</th>
                    <th className="py-2 pr-3 font-medium">Hub</th>
                    <th className="py-2 pr-3 font-medium">Parking %</th>
                    <th className="py-2 pr-3 font-medium">Charging %</th>
                    <th className="py-2 pr-3 font-medium text-right">Avg wait</th>
                    <th className="py-2 pr-3 font-medium text-right">Max queue</th>
                    <th className="py-2 pr-3 font-medium text-right">Unserved (R/P/C)</th>
                    <th className="py-2 pr-3 font-medium text-right">Redirects</th>
                    <th className="py-2 font-medium text-right">Avail. veh</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {filteredIntervals.map((iv, idx) => (
                    <tr
                      key={`${iv.t}-${iv.hubId}-${idx}`}
                      className={cn(iv.breach && 'bg-red-50/70')}
                    >
                      <td className="py-2 pr-3 whitespace-nowrap font-mono">
                        {new Date(iv.t).toLocaleTimeString([], {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                        {iv.breach && (
                          <Badge
                            variant="outline"
                            className="ml-1.5 border-red-300 bg-red-100 text-red-800 text-[10px]"
                          >
                            Breach
                          </Badge>
                        )}
                      </td>
                      <td className="py-2 pr-3 whitespace-nowrap">
                        {hubNameById.get(iv.hubId) ?? iv.hubId}
                      </td>
                      <td className="py-2 pr-3">
                        <UtilBar pct={iv.parkingUtilPct} />
                      </td>
                      <td className="py-2 pr-3">
                        <UtilBar pct={iv.chargingUtilPct} />
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums">
                        {iv.avgChargingWaitMin.toFixed(1)}m
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums">{iv.maxQueueDepth}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">
                        {iv.unservedRental}/{iv.unservedParking}/{iv.unservedCharging}
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums">{iv.redirectedReturns}</td>
                      <td className="py-2 text-right tabular-nums">{iv.availableVehicles}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Save Run Dialog */}
      <Dialog open={saveDialogOpen} onOpenChange={setSaveDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Save Simulation Run</DialogTitle>
            <DialogDescription>
              Name this run so you can find and compare it later (FR-59).
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleSaveSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="detail-save-name">Saved name</Label>
              <Input
                id="detail-save-name"
                value={saveName}
                onChange={(e) => setSaveName(e.target.value)}
                required
              />
            </div>
            {saveRun.isError && <ErrorBox error={saveRun.error} title="Could not save run" />}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setSaveDialogOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={!saveName.trim() || saveRun.isPending}>
                {saveRun.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                <span>Save run</span>
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Shared D-20 Preview -> Confirm & Apply + Dismiss Dialogs */}
      <RecommendationPreviewApplyDialog
        recommendation={previewTarget}
        open={Boolean(previewTarget)}
        onOpenChange={(open) => !open && setPreviewTarget(null)}
      />
      <RecommendationDismissDialog
        recommendation={dismissTarget}
        open={Boolean(dismissTarget)}
        onOpenChange={(open) => !open && setDismissTarget(null)}
      />
    </div>
  );
}
