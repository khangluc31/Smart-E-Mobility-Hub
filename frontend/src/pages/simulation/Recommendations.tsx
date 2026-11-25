// Simulation Recommendations review & D-20 Preview -> Apply / Dismiss
// (/sim/recommendations, FR-57, FR-58, D-20, UC-33).

import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, Eye } from 'lucide-react';
import { NEAR_CAPACITY_PCT } from '@/lib/constants';
import { useSimRunDetail, useSimRuns, useSimScenarios } from '@/hooks/useSimulation';
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
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { RECOMMENDATION_STATUSES, type RecommendationStatus } from '@/types/enums';
import type { Recommendation, Scenario } from '@/types/simulation';

export function Recommendations() {
  const runsQuery = useSimRuns();
  const scenariosQuery = useSimScenarios();

  const completedRuns = useMemo(
    () => (runsQuery.data ?? []).filter((r) => r.status === 'COMPLETED'),
    [runsQuery.data],
  );

  const scenarioById = useMemo(() => {
    const map = new Map<string, Scenario>();
    for (const sc of scenariosQuery.data ?? []) map.set(sc.id, sc);
    return map;
  }, [scenariosQuery.data]);

  const [selectedRunId, setSelectedRunId] = useState<string>('');
  const [statusFilter, setStatusFilter] = useState<'ALL' | RecommendationStatus>('ALL');
  const [previewTarget, setPreviewTarget] = useState<Recommendation | null>(null);
  const [dismissTarget, setDismissTarget] = useState<Recommendation | null>(null);

  // Default to the latest COMPLETED run once runs load.
  const effectiveRunId = selectedRunId || completedRuns[0]?.id || '';

  const detailQuery = useSimRunDetail(effectiveRunId || null);
  const detail = detailQuery.data;

  const filteredRecommendations = useMemo(() => {
    const list = detail?.recommendations ?? [];
    if (statusFilter === 'ALL') return list;
    return list.filter((rec) => rec.status === statusFilter);
  }, [detail?.recommendations, statusFilter]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Recommendations</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Review simulation proposals and apply approved actions to live operations via two-step
          preview &amp; confirmation (FR-57, FR-58, D-20).
        </p>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Select Run &amp; Filter</CardTitle>
          <CardDescription>
            Defaults to the most recent completed simulation run.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {runsQuery.isLoading ? (
            <Skeleton className="h-10 w-full" />
          ) : completedRuns.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No completed simulation runs yet.{' '}
              <Link to="/sim/scenarios" className="underline underline-offset-2 font-medium">
                Create and run a scenario
              </Link>{' '}
              to generate recommendations.
            </p>
          ) : (
            <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-4">
              <div className="space-y-1.5 flex-1 max-w-lg">
                <Label htmlFor="rec-run-select">Completed run</Label>
                <Select value={effectiveRunId} onValueChange={setSelectedRunId}>
                  <SelectTrigger id="rec-run-select">
                    <SelectValue placeholder="Choose a run…" />
                  </SelectTrigger>
                  <SelectContent>
                    {completedRuns.map((r) => {
                      const sc = scenarioById.get(r.scenarioId);
                      const label = r.savedName ?? sc?.name ?? r.scenarioId;
                      return (
                        <SelectItem key={r.id} value={r.id}>
                          {label} · {new Date(r.startedAt).toLocaleString()}
                        </SelectItem>
                      );
                    })}
                  </SelectContent>
                </Select>
              </div>

              <div className="flex flex-wrap items-center gap-1.5">
                <Button
                  type="button"
                  size="sm"
                  variant={statusFilter === 'ALL' ? 'default' : 'outline'}
                  onClick={() => setStatusFilter('ALL')}
                >
                  All
                </Button>
                {RECOMMENDATION_STATUSES.map((st) => (
                  <Button
                    key={st}
                    type="button"
                    size="sm"
                    variant={statusFilter === st ? 'default' : 'outline'}
                    onClick={() => setStatusFilter(st)}
                  >
                    {st}
                  </Button>
                ))}
                {effectiveRunId && (
                  <Button asChild size="sm" variant="ghost">
                    <Link to={`/sim/runs/${effectiveRunId}`}>
                      <Eye className="h-3.5 w-3.5" />
                      <span>Run detail</span>
                    </Link>
                  </Button>
                )}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {detailQuery.isLoading && (
        <div className="space-y-3">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      )}

      {detailQuery.isError && (
        <ErrorBox error={detailQuery.error} title="Could not load run recommendations" />
      )}

      {detail && (
        <div className="space-y-4">
          {detail.warning === 'NETWORK_SATURATED' && (
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>Network saturated (UC-32 E1)</AlertTitle>
              <AlertDescription>
                All Hubs reached or exceeded {NEAR_CAPACITY_PCT}% utilisation. Partial
                recommendations are shown below.
              </AlertDescription>
            </Alert>
          )}

          {detail.recommendations.length === 0 ? (
            <Alert className="border-emerald-300 bg-emerald-50 text-emerald-950">
              <CheckCircle2 className="h-4 w-4 text-emerald-700" />
              <AlertTitle>Network remains balanced</AlertTitle>
              <AlertDescription>
                This simulation run produced no breaches or unserved requests (UC-32 A1).
              </AlertDescription>
            </Alert>
          ) : filteredRecommendations.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4">
              No recommendations match status <strong>{statusFilter}</strong>.
            </p>
          ) : (
            <div className="space-y-3">
              {filteredRecommendations.map((rec) => (
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
        </div>
      )}

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
