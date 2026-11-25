// Side-by-side Simulation Run Comparison (/sim/compare, FR-59, UC-34).

import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { GitCompareArrows, Trophy } from 'lucide-react';
import { useHubs } from '@/hooks/useHubs';
import { useSimCompare, useSimRuns, useSimScenarios } from '@/hooks/useSimulation';
import { StatusBadge } from '@/components/common/StatusBadge';
import { ErrorBox } from '@/components/common/ErrorBox';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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
import type { Scenario, SimCompareMetric, SimRun } from '@/types/simulation';

function formatMetricLabel(metric: SimCompareMetric): string {
  switch (metric) {
    case 'peakParkingUtilPct':
      return 'Peak parking util (%)';
    case 'peakChargingUtilPct':
      return 'Peak charging util (%)';
    case 'avgChargingWaitMin':
      return 'Avg charging wait (min)';
    case 'unservedTotal':
      return 'Unserved requests';
  }
}

function formatMetricValue(metric: SimCompareMetric, value: number): string {
  if (metric === 'unservedTotal') return String(Math.round(value));
  return value.toFixed(1);
}

function formatRunOption(run: SimRun, scenario: Scenario | undefined): string {
  const title = run.savedName ?? scenario?.name ?? run.scenarioId;
  const horizon = scenario ? `${scenario.horizonH}h` : '?h';
  const time = new Date(run.startedAt).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
  return `${title} · ${horizon} · ${time}`;
}

export function Compare() {
  const [searchParams, setSearchParams] = useSearchParams();
  const runA = searchParams.get('runA') ?? '';
  const runB = searchParams.get('runB') ?? '';

  const runsQuery = useSimRuns();
  const scenariosQuery = useSimScenarios();
  const hubsQuery = useHubs();
  const compareQuery = useSimCompare(runA || null, runB || null);

  const completedRuns = useMemo(
    () => (runsQuery.data ?? []).filter((r) => r.status === 'COMPLETED'),
    [runsQuery.data],
  );

  const scenarioById = useMemo(() => {
    const map = new Map<string, Scenario>();
    for (const sc of scenariosQuery.data ?? []) map.set(sc.id, sc);
    return map;
  }, [scenariosQuery.data]);

  const hubNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const h of hubsQuery.data ?? []) map.set(h.id, h.name);
    return map;
  }, [hubsQuery.data]);

  function updateParam(key: 'runA' | 'runB', value: string) {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value);
    else next.delete(key);
    setSearchParams(next, { replace: true });
  }

  const sameRunSelected = Boolean(runA && runB && runA === runB);
  const comparison = compareQuery.data;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Compare Runs</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Compare two completed simulation runs of the same horizon side by side (FR-59, UC-34).
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <GitCompareArrows className="h-4 w-4" />
            <span>Select Two Completed Runs</span>
          </CardTitle>
          <CardDescription>
            Both runs must have the same horizon; mismatched horizons return a 409 error.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {runsQuery.isLoading ? (
            <Skeleton className="h-10 w-full" />
          ) : completedRuns.length < 2 ? (
            <p className="text-sm text-muted-foreground">
              You need at least two completed runs to compare.{' '}
              <Link to="/sim/runs" className="underline underline-offset-2 font-medium">
                Go to Runs
              </Link>
              .
            </p>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label htmlFor="compare-run-a">Run A (baseline)</Label>
                <Select value={runA} onValueChange={(v) => updateParam('runA', v)}>
                  <SelectTrigger id="compare-run-a">
                    <SelectValue placeholder="Choose Run A…" />
                  </SelectTrigger>
                  <SelectContent>
                    {completedRuns.map((r) => (
                      <SelectItem key={r.id} value={r.id}>
                        {formatRunOption(r, scenarioById.get(r.scenarioId))}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="compare-run-b">Run B (candidate)</Label>
                <Select value={runB} onValueChange={(v) => updateParam('runB', v)}>
                  <SelectTrigger id="compare-run-b">
                    <SelectValue placeholder="Choose Run B…" />
                  </SelectTrigger>
                  <SelectContent>
                    {completedRuns.map((r) => (
                      <SelectItem key={r.id} value={r.id}>
                        {formatRunOption(r, scenarioById.get(r.scenarioId))}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}

          {sameRunSelected && (
            <Alert>
              <AlertTitle>Pick two different runs</AlertTitle>
              <AlertDescription>
                Run A and Run B are currently the same run. Choose a different run to compare.
              </AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>

      {compareQuery.isLoading && (
        <div className="space-y-3">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      )}

      {compareQuery.isError && (
        <ErrorBox error={compareQuery.error} title="Cannot compare selected runs" />
      )}

      {comparison && (
        <div className="space-y-6">
          <Alert
            className={cn(
              comparison.better === 'b'
                ? 'border-emerald-300 bg-emerald-50 text-emerald-950'
                : comparison.better === 'a'
                  ? 'border-sky-300 bg-sky-50 text-sky-950'
                  : 'border-neutral-300 bg-neutral-50 text-neutral-900',
            )}
          >
            <Trophy className="h-4 w-4" />
            <AlertTitle>
              {comparison.better === 'a'
                ? 'Run A performs better overall'
                : comparison.better === 'b'
                  ? 'Run B performs better overall'
                  : 'Tie — both runs perform similarly'}
            </AlertTitle>
            <AlertDescription>
              Diff is calculated as <code>Run B − Run A</code>. Negative deltas indicate lower
              utilisation, shorter waits, or fewer unserved requests in Run B.
            </AlertDescription>
          </Alert>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {[
              { label: 'Run A', run: comparison.a },
              { label: 'Run B', run: comparison.b },
            ].map(({ label, run }) => {
              const sc = scenarioById.get(run.scenarioId);
              return (
                <Card key={label}>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base flex items-center justify-between gap-2">
                      <span>
                        {label}: {run.savedName ?? sc?.name ?? run.scenarioId}
                      </span>
                      <StatusBadge kind="simRun" value={run.status} />
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="text-xs text-muted-foreground space-y-1">
                    <div>Started: {new Date(run.startedAt).toLocaleString()}</div>
                    <div>
                      Duration: {run.durationMs !== null ? `${run.durationMs} ms` : '—'}
                      {sc ? ` · Horizon: ${sc.horizonH} h · Seed: ${sc.seed}` : ''}
                    </div>
                    <div>
                      <Link
                        to={`/sim/runs/${run.id}`}
                        className="underline underline-offset-2 text-foreground font-medium"
                      >
                        Inspect full run
                      </Link>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Per-Hub Metric Comparison ({comparison.rows.length} rows)</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <table className="w-full text-sm border-collapse">
                  <thead>
                    <tr className="border-b text-left text-xs text-muted-foreground">
                      <th className="py-2 pr-3 font-medium">Hub</th>
                      <th className="py-2 pr-3 font-medium">Metric</th>
                      <th className="py-2 pr-3 font-medium text-right">Run A</th>
                      <th className="py-2 pr-3 font-medium text-right">Run B</th>
                      <th className="py-2 pr-3 font-medium text-right">Diff (B − A)</th>
                      <th className="py-2 font-medium text-right">Diff %</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {comparison.rows.map((row, idx) => {
                      const improved = row.diff < 0;
                      const worsened = row.diff > 0;
                      const diffClass = improved
                        ? 'text-emerald-700 font-medium'
                        : worsened
                          ? 'text-red-700 font-medium'
                          : 'text-muted-foreground';
                      return (
                        <tr key={`${row.hubId}-${row.metric}-${idx}`}>
                          <td className="py-2 pr-3 whitespace-nowrap">
                            {hubNameById.get(row.hubId) ?? row.hubId}
                          </td>
                          <td className="py-2 pr-3 whitespace-nowrap">
                            {formatMetricLabel(row.metric)}
                          </td>
                          <td className="py-2 pr-3 text-right tabular-nums">
                            {formatMetricValue(row.metric, row.a)}
                          </td>
                          <td className="py-2 pr-3 text-right tabular-nums">
                            {formatMetricValue(row.metric, row.b)}
                          </td>
                          <td className={cn('py-2 pr-3 text-right tabular-nums', diffClass)}>
                            {row.diff > 0 ? '+' : ''}
                            {formatMetricValue(row.metric, row.diff)}
                          </td>
                          <td className={cn('py-2 text-right tabular-nums', diffClass)}>
                            {row.diffPct > 0 ? '+' : ''}
                            {row.diffPct.toFixed(1)}%
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
