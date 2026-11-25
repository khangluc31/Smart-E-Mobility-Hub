// What-if Simulation Scenarios builder & list (/sim/scenarios, FR-54, UC-29).

import { useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Copy, Loader2, Play, Plus, Trash2 } from 'lucide-react';
import { SIM_MAX_HORIZON_H } from '@/lib/constants';
import { useHubs } from '@/hooks/useHubs';
import {
  useCreateSimScenario,
  useSimScenarios,
  useSimTemplates,
  useStartSimRun,
} from '@/hooks/useSimulation';
import { ErrorBox } from '@/components/common/ErrorBox';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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
import type { ScenarioTemplate } from '@/types/enums';
import type { Scenario, ScenarioCondition, ScenarioTemplateSpec } from '@/types/simulation';

interface DraftCondition {
  key: string;
  template: ScenarioTemplate;
  params: Record<string, string | string[]>;
}

function makeKey(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function buildDefaultParams(spec: ScenarioTemplateSpec, defaultHubId: string): Record<string, string | string[]> {
  const params: Record<string, string | string[]> = {};
  for (const p of spec.params) {
    if (p.type === 'hubId') {
      params[p.name] = defaultHubId;
    } else if (p.type === 'hubIds') {
      params[p.name] = defaultHubId ? [defaultHubId] : [];
    } else {
      const fallback = p.min !== undefined ? Math.max(p.min, p.name === 'multiplierPct' ? 50 : p.min) : 1;
      params[p.name] = String(fallback);
    }
  }
  return params;
}

function formatParamLabel(name: string): string {
  return name
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (c) => c.toUpperCase())
    .trim();
}

function formatConditionChip(condition: ScenarioCondition, hubNameById: Map<string, string>): string {
  const parts = Object.entries(condition.params).map(([k, v]) => {
    if (Array.isArray(v)) {
      return `${k}: ${v.map((id) => hubNameById.get(id) ?? id).join(', ')}`;
    }
    if (typeof v === 'string' && hubNameById.has(v)) {
      return `${k}: ${hubNameById.get(v)}`;
    }
    return `${k}: ${String(v)}`;
  });
  return `${condition.template} (${parts.join(' · ')})`;
}

export function Scenarios() {
  const navigate = useNavigate();
  const builderRef = useRef<HTMLDivElement | null>(null);

  const templatesQuery = useSimTemplates();
  const scenariosQuery = useSimScenarios();
  const hubsQuery = useHubs();
  const createScenario = useCreateSimScenario();
  const startRun = useStartSimRun();

  const templates = useMemo(() => templatesQuery.data ?? [], [templatesQuery.data]);
  const scenarios = useMemo(() => scenariosQuery.data ?? [], [scenariosQuery.data]);
  const hubs = useMemo(() => hubsQuery.data ?? [], [hubsQuery.data]);

  const templateMap = useMemo(() => {
    const map = new Map<ScenarioTemplate, ScenarioTemplateSpec>();
    for (const t of templates) map.set(t.template, t);
    return map;
  }, [templates]);

  const hubNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const h of hubs) map.set(h.id, h.name);
    return map;
  }, [hubs]);

  const [name, setName] = useState('');
  const [horizonH, setHorizonH] = useState('4');
  const [seed, setSeed] = useState('');
  const [draftConditions, setDraftConditions] = useState<DraftCondition[] | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [createdBanner, setCreatedBanner] = useState<string | null>(null);

  const defaultHubId = hubs[0]?.id ?? '';

  // Derive the active conditions list without setState in useEffect.
  const conditions = useMemo<DraftCondition[]>(() => {
    if (draftConditions !== null) return draftConditions;
    const first = templates[0];
    if (!first) return [];
    return [
      {
        key: 'default-0',
        template: first.template,
        params: buildDefaultParams(first, defaultHubId),
      },
    ];
  }, [draftConditions, templates, defaultHubId]);

  function handleAddCondition() {
    const spec = templates[0];
    if (!spec) return;
    setDraftConditions((prev) => [
      ...(prev ?? conditions),
      {
        key: makeKey(),
        template: spec.template,
        params: buildDefaultParams(spec, defaultHubId),
      },
    ]);
  }

  function handleRemoveCondition(key: string) {
    setDraftConditions((prev) => {
      const list = prev ?? conditions;
      return list.length > 1 ? list.filter((c) => c.key !== key) : list;
    });
  }

  function handleTemplateChange(key: string, nextTemplate: ScenarioTemplate) {
    const spec = templateMap.get(nextTemplate);
    if (!spec) return;
    setDraftConditions((prev) =>
      (prev ?? conditions).map((c) =>
        c.key === key
          ? {
              ...c,
              template: nextTemplate,
              params: buildDefaultParams(spec, defaultHubId),
            }
          : c,
      ),
    );
  }

  function handleParamChange(key: string, paramName: string, value: string | string[]) {
    setDraftConditions((prev) =>
      (prev ?? conditions).map((c) =>
        c.key === key
          ? {
              ...c,
              params: {
                ...c.params,
                [paramName]: value,
              },
            }
          : c,
      ),
    );
  }

  function toggleHubIdInArray(key: string, paramName: string, hubId: string) {
    setDraftConditions((prev) =>
      (prev ?? conditions).map((c) => {
        if (c.key !== key) return c;
        const current = Array.isArray(c.params[paramName]) ? (c.params[paramName] as string[]) : [];
        const next = current.includes(hubId)
          ? current.filter((id) => id !== hubId)
          : [...current, hubId];
        return {
          ...c,
          params: {
            ...c.params,
            [paramName]: next,
          },
        };
      }),
    );
  }

  // UC-29 A1: Clone an existing scenario into the builder for modification.
  function handleClone(scenario: Scenario) {
    setLocalError(null);
    setCreatedBanner(null);
    createScenario.reset();
    setName(`${scenario.name} (copy)`);
    setHorizonH(String(scenario.horizonH));
    setSeed(String(scenario.seed));
    setDraftConditions(
      scenario.conditions.map((cond) => {
        const draftParams: Record<string, string | string[]> = {};
        for (const [k, v] of Object.entries(cond.params)) {
          draftParams[k] = Array.isArray(v) ? [...v] : String(v);
        }
        return {
          key: makeKey(),
          template: cond.template,
          params: draftParams,
        };
      }),
    );
    builderRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function handleRunNow(scenarioId: string) {
    startRun.mutate(scenarioId, {
      onSuccess: (created) => {
        navigate(`/sim/runs/${created.id}`);
      },
    });
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLocalError(null);
    setCreatedBanner(null);

    const trimmedName = name.trim();
    if (!trimmedName) {
      setLocalError('Scenario name is required.');
      return;
    }

    const parsedHorizon = Number(horizonH);
    if (!Number.isInteger(parsedHorizon) || parsedHorizon < 1 || parsedHorizon > SIM_MAX_HORIZON_H) {
      setLocalError(`Horizon must be a whole number between 1 and ${SIM_MAX_HORIZON_H} hours.`);
      return;
    }

    let parsedSeed: number | undefined;
    if (seed.trim() !== '') {
      const n = Number(seed.trim());
      if (!Number.isInteger(n)) {
        setLocalError('Seed must be an integer.');
        return;
      }
      parsedSeed = n;
    }

    if (conditions.length === 0) {
      setLocalError('Add at least one scenario condition.');
      return;
    }

    const payloadConditions: ScenarioCondition[] = [];
    for (let i = 0; i < conditions.length; i += 1) {
      const cond = conditions[i];
      if (!cond) continue;
      const spec = templateMap.get(cond.template);
      if (!spec) {
        setLocalError(`Unknown template at condition #${i + 1}.`);
        return;
      }

      const typedParams: Record<string, number | string | string[]> = {};
      for (const p of spec.params) {
        const raw = cond.params[p.name];
        if (p.type === 'hubIds') {
          const arr = Array.isArray(raw) ? raw : [];
          if (p.required && arr.length === 0) {
            setLocalError(`Condition #${i + 1}: select at least one Hub for ${p.name}.`);
            return;
          }
          typedParams[p.name] = arr;
        } else if (p.type === 'hubId') {
          const val = typeof raw === 'string' ? raw.trim() : '';
          if (p.required && !val) {
            setLocalError(`Condition #${i + 1}: select a Hub for ${p.name}.`);
            return;
          }
          typedParams[p.name] = val;
        } else {
          const str = typeof raw === 'string' ? raw.trim() : '';
          if (str === '') {
            if (p.required) {
              setLocalError(`Condition #${i + 1}: ${p.name} is required.`);
              return;
            }
            continue;
          }
          const num = Number(str);
          if (!Number.isFinite(num) || (p.type === 'integer' && !Number.isInteger(num))) {
            setLocalError(
              `Condition #${i + 1}: ${p.name} must be a valid ${p.type === 'integer' ? 'integer' : 'number'}.`,
            );
            return;
          }
          typedParams[p.name] = num;
        }
      }

      payloadConditions.push({
        template: cond.template,
        params: typedParams,
      });
    }

    createScenario.mutate(
      {
        name: trimmedName,
        horizonH: parsedHorizon,
        ...(parsedSeed !== undefined ? { seed: parsedSeed } : {}),
        conditions: payloadConditions,
      },
      {
        onSuccess: (created) => {
          setCreatedBanner(`Scenario "${created.name}" created (seed ${created.seed}).`);
          setName('');
        },
      },
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Scenarios</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Configure what-if demand, outage, or imbalance scenarios (FR-54), clone existing setups
          (UC-29), and launch isolated snapshot runs.
        </p>
      </div>

      {templatesQuery.isError && (
        <ErrorBox error={templatesQuery.error} title="Could not load scenario templates" />
      )}
      {startRun.isError && <ErrorBox error={startRun.error} title="Could not start simulation run" />}

      <div ref={builderRef}>
        <Card>
          <CardHeader>
            <CardTitle>Create Scenario</CardTitle>
            <CardDescription>
              Combine one or more template conditions over a 1–{SIM_MAX_HORIZON_H} hour horizon.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {templatesQuery.isLoading ? (
              <div className="space-y-3">
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-24 w-full" />
              </div>
            ) : (
              <form onSubmit={handleSubmit} className="space-y-5">
                <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                  <div className="md:col-span-2 space-y-1.5">
                    <Label htmlFor="sim-scenario-name">Scenario name</Label>
                    <Input
                      id="sim-scenario-name"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="e.g. Morning Metro Surge + Charger Outage"
                      required
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="sim-scenario-horizon">Horizon (1–{SIM_MAX_HORIZON_H} h)</Label>
                    <Input
                      id="sim-scenario-horizon"
                      type="number"
                      min={1}
                      max={SIM_MAX_HORIZON_H}
                      step={1}
                      value={horizonH}
                      onChange={(e) => setHorizonH(e.target.value)}
                      required
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="sim-scenario-seed">RNG Seed (optional)</Label>
                    <Input
                      id="sim-scenario-seed"
                      type="number"
                      step={1}
                      value={seed}
                      onChange={(e) => setSeed(e.target.value)}
                      placeholder="Auto"
                    />
                  </div>
                </div>

                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <Label>Conditions ({conditions.length})</Label>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={handleAddCondition}
                      disabled={templates.length === 0}
                    >
                      <Plus className="h-3.5 w-3.5" />
                      <span>Add condition</span>
                    </Button>
                  </div>

                  {conditions.map((cond, idx) => {
                    const spec = templateMap.get(cond.template);
                    return (
                      <div
                        key={cond.key}
                        className="rounded-md border bg-muted/20 p-4 space-y-3"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex items-center gap-2 flex-1 min-w-[220px]">
                            <Badge variant="outline">#{idx + 1}</Badge>
                            <Select
                              value={cond.template}
                              onValueChange={(val) =>
                                handleTemplateChange(cond.key, val as ScenarioTemplate)
                              }
                            >
                              <SelectTrigger className="max-w-sm">
                                <SelectValue placeholder="Choose template" />
                              </SelectTrigger>
                              <SelectContent>
                                {templates.map((t) => (
                                  <SelectItem key={t.template} value={t.template}>
                                    {t.label} ({t.template})
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>

                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => handleRemoveCondition(cond.key)}
                            disabled={conditions.length <= 1}
                            aria-label={`Remove condition ${idx + 1}`}
                          >
                            <Trash2 className="h-4 w-4 text-muted-foreground" />
                          </Button>
                        </div>

                        {spec && (
                          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                            {spec.params.map((param) => {
                              const inputId = `cond-${cond.key}-${param.name}`;
                              const rawVal = cond.params[param.name];

                              if (param.type === 'hubId') {
                                const selected = typeof rawVal === 'string' ? rawVal : '';
                                return (
                                  <div key={param.name} className="space-y-1">
                                    <Label htmlFor={inputId} className="text-xs">
                                      {formatParamLabel(param.name)}
                                    </Label>
                                    <Select
                                      value={selected}
                                      onValueChange={(val) =>
                                        handleParamChange(cond.key, param.name, val)
                                      }
                                    >
                                      <SelectTrigger id={inputId}>
                                        <SelectValue placeholder="Select Hub" />
                                      </SelectTrigger>
                                      <SelectContent>
                                        {hubs.map((h) => (
                                          <SelectItem key={h.id} value={h.id}>
                                            {h.name} ({h.id})
                                          </SelectItem>
                                        ))}
                                      </SelectContent>
                                    </Select>
                                  </div>
                                );
                              }

                              if (param.type === 'hubIds') {
                                const selectedList = Array.isArray(rawVal) ? rawVal : [];
                                return (
                                  <div key={param.name} className="md:col-span-3 space-y-1.5">
                                    <Label className="text-xs">
                                      {formatParamLabel(param.name)} ({selectedList.length} selected)
                                    </Label>
                                    <div className="flex flex-wrap gap-2">
                                      {hubs.map((h) => {
                                        const active = selectedList.includes(h.id);
                                        return (
                                          <Button
                                            key={h.id}
                                            type="button"
                                            size="sm"
                                            variant={active ? 'default' : 'outline'}
                                            onClick={() =>
                                              toggleHubIdInArray(cond.key, param.name, h.id)
                                            }
                                          >
                                            {h.name}
                                          </Button>
                                        );
                                      })}
                                    </div>
                                  </div>
                                );
                              }

                              return (
                                <div key={param.name} className="space-y-1">
                                  <Label htmlFor={inputId} className="text-xs">
                                    {formatParamLabel(param.name)}
                                    {param.min !== undefined || param.max !== undefined
                                      ? ` (${param.min ?? '…'}..${param.max ?? '…'})`
                                      : ''}
                                  </Label>
                                  <Input
                                    id={inputId}
                                    type="number"
                                    step={param.type === 'integer' ? 1 : 'any'}
                                    min={param.min}
                                    max={param.max}
                                    required={param.required}
                                    value={typeof rawVal === 'string' ? rawVal : ''}
                                    onChange={(e) =>
                                      handleParamChange(cond.key, param.name, e.target.value)
                                    }
                                  />
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>

                {localError && (
                  <Alert variant="destructive">
                    <AlertTitle>Invalid scenario configuration</AlertTitle>
                    <AlertDescription>{localError}</AlertDescription>
                  </Alert>
                )}

                {createScenario.isError && (
                  <ErrorBox
                    error={createScenario.error}
                    title="Could not create scenario"
                  />
                )}

                {createdBanner && (
                  <Alert className="border-emerald-300 bg-emerald-50 text-emerald-950">
                    <AlertTitle>Scenario saved</AlertTitle>
                    <AlertDescription>{createdBanner}</AlertDescription>
                  </Alert>
                )}

                <div className="flex items-center justify-end">
                  <Button type="submit" disabled={createScenario.isPending}>
                    {createScenario.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                    <span>Save Scenario</span>
                  </Button>
                </div>
              </form>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Defined Scenarios ({scenarios.length})</CardTitle>
          <CardDescription>
            Clone a scenario to tweak parameters (UC-29 A1), or launch an isolated snapshot run
            immediately.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {scenariosQuery.isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
            </div>
          ) : scenariosQuery.isError ? (
            <ErrorBox error={scenariosQuery.error} title="Could not load scenarios" />
          ) : scenarios.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4">
              No scenarios defined yet. Use the builder above to create your first scenario.
            </p>
          ) : (
            <div className="divide-y">
              {scenarios.map((sc) => (
                <div
                  key={sc.id}
                  className="py-3 first:pt-0 last:pb-0 flex flex-col lg:flex-row lg:items-center justify-between gap-3"
                >
                  <div className="space-y-1.5 min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-sm">{sc.name}</span>
                      <Badge variant="secondary">{sc.horizonH} h horizon</Badge>
                      <Badge variant="outline" className="font-mono text-xs">
                        seed {sc.seed}
                      </Badge>
                      <span className="text-xs text-muted-foreground">
                        {new Date(sc.createdAt).toLocaleString()}
                      </span>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {sc.conditions.map((cond, idx) => (
                        <Badge key={idx} variant="outline" className="text-xs font-normal">
                          {formatConditionChip(cond, hubNameById)}
                        </Badge>
                      ))}
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => handleClone(sc)}
                    >
                      <Copy className="h-3.5 w-3.5" />
                      <span>Clone</span>
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      onClick={() => handleRunNow(sc.id)}
                      disabled={startRun.isPending}
                    >
                      {startRun.isPending ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Play className="h-3.5 w-3.5" />
                      )}
                      <span>Run now</span>
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
