// Simulation Runs list, quick Start Run, and Save/Unsave (/sim/runs, FR-53, FR-55, FR-59).

import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Bookmark, BookmarkX, Eye, GitCompareArrows, Loader2, Play } from 'lucide-react';
import {
  useSaveSimRun,
  useSimRuns,
  useSimScenarios,
  useStartSimRun,
  useUnsaveSimRun,
} from '@/hooks/useSimulation';
import { StatusBadge } from '@/components/common/StatusBadge';
import { ErrorBox } from '@/components/common/ErrorBox';
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
import type { SimRun } from '@/types/simulation';

export function Runs() {
  const navigate = useNavigate();
  const [savedOnly, setSavedOnly] = useState(false);
  const [selectedScenarioId, setSelectedScenarioId] = useState('');
  const [saveTarget, setSaveTarget] = useState<SimRun | null>(null);
  const [saveName, setSaveName] = useState('');

  const runsQuery = useSimRuns(savedOnly);
  const scenariosQuery = useSimScenarios();
  const startRun = useStartSimRun();
  const saveRun = useSaveSimRun();
  const unsaveRun = useUnsaveSimRun();

  const runs = useMemo(() => runsQuery.data ?? [], [runsQuery.data]);
  const scenarios = useMemo(() => scenariosQuery.data ?? [], [scenariosQuery.data]);

  const scenarioNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const sc of scenarios) map.set(sc.id, sc.name);
    return map;
  }, [scenarios]);

  function handleQuickStart() {
    if (!selectedScenarioId) return;
    startRun.mutate(selectedScenarioId, {
      onSuccess: (created) => {
        navigate(`/sim/runs/${created.id}`);
      },
    });
  }

  function openSaveDialog(run: SimRun) {
    saveRun.reset();
    setSaveTarget(run);
    setSaveName(run.savedName ?? scenarioNameById.get(run.scenarioId) ?? '');
  }

  function handleSaveSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!saveTarget || !saveName.trim()) return;
    saveRun.mutate(
      { id: saveTarget.id, name: saveName.trim() },
      {
        onSuccess: () => {
          setSaveTarget(null);
          setSaveName('');
        },
      },
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Simulation Runs</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Monitor isolated snapshot runs, bookmark completed runs for side-by-side comparison, and
            inspect interval metrics &amp; recommendations.
          </p>
        </div>

        <div className="inline-flex rounded-md border bg-muted/40 p-1 self-start">
          <Button
            type="button"
            size="sm"
            variant={!savedOnly ? 'default' : 'ghost'}
            onClick={() => setSavedOnly(false)}
          >
            All runs
          </Button>
          <Button
            type="button"
            size="sm"
            variant={savedOnly ? 'default' : 'ghost'}
            onClick={() => setSavedOnly(true)}
          >
            Saved only
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Quick Start Run</CardTitle>
          <CardDescription>
            Takes a read-only live snapshot (FR-53) and executes the deterministic engine in the
            sandbox (FR-55).
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-col sm:flex-row gap-3">
            <Select value={selectedScenarioId} onValueChange={setSelectedScenarioId}>
              <SelectTrigger className="sm:max-w-md">
                <SelectValue placeholder="Choose a scenario to run…" />
              </SelectTrigger>
              <SelectContent>
                {scenarios.map((sc) => (
                  <SelectItem key={sc.id} value={sc.id}>
                    {sc.name} ({sc.horizonH} h, seed {sc.seed})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              type="button"
              onClick={handleQuickStart}
              disabled={!selectedScenarioId || startRun.isPending}
            >
              {startRun.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Play className="h-4 w-4" />
              )}
              <span>Start run</span>
            </Button>
            {scenarios.length === 0 && !scenariosQuery.isLoading && (
              <Button asChild variant="outline">
                <Link to="/sim/scenarios">Create a scenario first</Link>
              </Button>
            )}
          </div>
          {startRun.isError && <ErrorBox error={startRun.error} title="Could not start run" />}
        </CardContent>
      </Card>

      {unsaveRun.isError && <ErrorBox error={unsaveRun.error} title="Could not unsave run" />}

      <Card>
        <CardHeader>
          <CardTitle>{savedOnly ? 'Saved Runs' : 'All Runs'} ({runs.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {runsQuery.isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-14 w-full" />
              <Skeleton className="h-14 w-full" />
            </div>
          ) : runsQuery.isError ? (
            <ErrorBox error={runsQuery.error} title="Could not load simulation runs" />
          ) : runs.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4">
              {savedOnly
                ? 'No saved runs yet. Complete a run and click Save to keep it for comparison.'
                : 'No simulation runs yet. Pick a scenario above to start one.'}
            </p>
          ) : (
            <div className="divide-y">
              {runs.map((run) => {
                const scenarioName = scenarioNameById.get(run.scenarioId) ?? run.scenarioId;
                return (
                  <div
                    key={run.id}
                    className="py-3 first:pt-0 last:pb-0 flex flex-col lg:flex-row lg:items-center justify-between gap-3"
                  >
                    <div className="space-y-1 min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <StatusBadge kind="simRun" value={run.status} />
                        <span className="font-medium text-sm">{scenarioName}</span>
                        {run.savedName && (
                          <Badge
                            variant="outline"
                            className="border-amber-300 bg-amber-50 text-amber-900"
                          >
                            Saved: {run.savedName}
                          </Badge>
                        )}
                      </div>
                      <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                        <span>Started: {new Date(run.startedAt).toLocaleString()}</span>
                        <span>
                          Duration:{' '}
                          {run.durationMs !== null
                            ? `${run.durationMs} ms`
                            : run.status === 'RUNNING'
                              ? 'Running…'
                              : '—'}
                        </span>
                        <span className="font-mono">{run.id}</span>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2 shrink-0">
                      <Button asChild size="sm" variant="default">
                        <Link to={`/sim/runs/${run.id}`}>
                          <Eye className="h-3.5 w-3.5" />
                          <span>Inspect</span>
                        </Link>
                      </Button>

                      {run.status === 'COMPLETED' && (
                        <>
                          <Button asChild size="sm" variant="outline">
                            <Link to={`/sim/compare?runA=${encodeURIComponent(run.id)}`}>
                              <GitCompareArrows className="h-3.5 w-3.5" />
                              <span>Compare</span>
                            </Link>
                          </Button>

                          {run.savedName ? (
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              onClick={() => unsaveRun.mutate(run.id)}
                              disabled={unsaveRun.isPending}
                            >
                              <BookmarkX className="h-3.5 w-3.5" />
                              <span>Unsave</span>
                            </Button>
                          ) : (
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              onClick={() => openSaveDialog(run)}
                            >
                              <Bookmark className="h-3.5 w-3.5" />
                              <span>Save</span>
                            </Button>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={Boolean(saveTarget)} onOpenChange={(open) => !open && setSaveTarget(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Save Simulation Run</DialogTitle>
            <DialogDescription>
              Give this completed run a memorable name so it is easy to compare later (FR-59).
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleSaveSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="save-run-name">Saved name</Label>
              <Input
                id="save-run-name"
                value={saveName}
                onChange={(e) => setSaveName(e.target.value)}
                placeholder="e.g. Baseline 4h Morning"
                required
              />
            </div>
            {saveRun.isError && <ErrorBox error={saveRun.error} title="Could not save run" />}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setSaveTarget(null)}>
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
    </div>
  );
}
