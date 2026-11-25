// TanStack Query hooks for What-if Simulation (CONTRACTS §13, FR-53–FR-59, BR-11, D-20).
// Uses local literal keys for cross-invalidation on recommendation apply to avoid circular imports.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { POLL_INTERVAL_MS } from '@/lib/constants';
import type {
  Recommendation,
  RecommendationApplyResult,
  RecommendationPreview,
  Scenario,
  ScenarioCondition,
  ScenarioTemplateSpec,
  SimCompareResult,
  SimRun,
  SimRunDetail,
} from '@/types/simulation';

export const SIM_KEY = ['sim'] as const;

const OPS_REDISTRIBUTION_KEY = ['ops', 'redistribution'] as const;
const OPS_CHARGING_KEY = ['ops', 'charging'] as const;
const OPS_DASHBOARD_KEY = ['ops', 'dashboard'] as const;
const HUBS_KEY = ['hubs'] as const;

const RUNNING_POLL_MS = 1000;

export interface CreateSimScenarioInput {
  name: string;
  horizonH: number;
  seed?: number;
  conditions: ScenarioCondition[];
}

export interface SaveSimRunInput {
  id: string;
  name: string;
}

export interface ApplyRecommendationInput {
  id: string;
  confirmToken: string;
}

export function useSimTemplates() {
  return useQuery<ScenarioTemplateSpec[]>({
    queryKey: [...SIM_KEY, 'templates'],
    queryFn: () => api.get<ScenarioTemplateSpec[]>('/ops/simulation/templates'),
    staleTime: Infinity,
  });
}

export function useSimScenarios() {
  return useQuery<Scenario[]>({
    queryKey: [...SIM_KEY, 'scenarios'],
    queryFn: () => api.get<Scenario[]>('/ops/simulation/scenarios'),
  });
}

export function useSimScenario(id: string | null) {
  return useQuery<Scenario>({
    queryKey: [...SIM_KEY, 'scenario', id],
    queryFn: () => api.get<Scenario>(`/ops/simulation/scenarios/${encodeURIComponent(id!)}`),
    enabled: Boolean(id),
  });
}

export function useCreateSimScenario() {
  const queryClient = useQueryClient();
  return useMutation<Scenario, unknown, CreateSimScenarioInput>({
    mutationFn: (body) => api.post<Scenario>('/ops/simulation/scenarios', body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: SIM_KEY });
    },
  });
}

export function useSimRuns(saved?: boolean) {
  return useQuery<SimRun[]>({
    queryKey: [...SIM_KEY, 'runs', { saved: Boolean(saved) }],
    queryFn: () =>
      api.get<SimRun[]>(saved === true ? '/ops/simulation/runs?saved=true' : '/ops/simulation/runs'),
    refetchInterval: (query) =>
      query.state.data?.some((r) => r.status === 'RUNNING') ? RUNNING_POLL_MS : POLL_INTERVAL_MS,
  });
}

export function useSimRunDetail(runId: string | null) {
  return useQuery<SimRunDetail>({
    queryKey: [...SIM_KEY, 'run', runId],
    queryFn: () => api.get<SimRunDetail>(`/ops/simulation/runs/${encodeURIComponent(runId!)}`),
    enabled: Boolean(runId),
    refetchInterval: (query) =>
      query.state.data?.run.status === 'RUNNING' ? RUNNING_POLL_MS : false,
  });
}

export function useStartSimRun() {
  const queryClient = useQueryClient();
  return useMutation<SimRun, unknown, string>({
    mutationFn: (scenarioId) => api.post<SimRun>('/ops/simulation/runs', { scenarioId }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: SIM_KEY });
    },
  });
}

export function useSaveSimRun() {
  const queryClient = useQueryClient();
  return useMutation<SimRun, unknown, SaveSimRunInput>({
    mutationFn: ({ id, name }) =>
      api.post<SimRun>(`/ops/simulation/runs/${encodeURIComponent(id)}/save`, {
        name: name.trim(),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: SIM_KEY });
    },
  });
}

export function useUnsaveSimRun() {
  const queryClient = useQueryClient();
  return useMutation<void, unknown, string>({
    mutationFn: (id) => api.delete<void>(`/ops/simulation/runs/${encodeURIComponent(id)}/save`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: SIM_KEY });
    },
  });
}

export function useSimCompare(runA: string | null, runB: string | null) {
  return useQuery<SimCompareResult>({
    queryKey: [...SIM_KEY, 'compare', { runA, runB }],
    queryFn: () => {
      const qs = new URLSearchParams({ runA: runA!, runB: runB! });
      return api.get<SimCompareResult>(`/ops/simulation/compare?${qs.toString()}`);
    },
    enabled: Boolean(runA && runB && runA !== runB),
    retry: false,
  });
}

// On-demand mutation because GET /preview mints a fresh one-time 5-min confirmToken (D-20).
export function usePreviewRecommendation() {
  return useMutation<RecommendationPreview, unknown, string>({
    mutationFn: (id) =>
      api.get<RecommendationPreview>(
        `/ops/simulation/recommendations/${encodeURIComponent(id)}/preview`,
      ),
  });
}

export function useApplyRecommendation() {
  const queryClient = useQueryClient();
  return useMutation<RecommendationApplyResult, unknown, ApplyRecommendationInput>({
    mutationFn: ({ id, confirmToken }) =>
      api.post<RecommendationApplyResult>(
        `/ops/simulation/recommendations/${encodeURIComponent(id)}/apply`,
        { confirmToken },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: OPS_REDISTRIBUTION_KEY });
      void queryClient.invalidateQueries({ queryKey: OPS_CHARGING_KEY });
      void queryClient.invalidateQueries({ queryKey: OPS_DASHBOARD_KEY });
      void queryClient.invalidateQueries({ queryKey: HUBS_KEY });
    },
    // Always refresh simulation data (even on 409 LIVE_STATE_CONFLICT -> BLOCKED).
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: SIM_KEY });
    },
  });
}

export function useDismissRecommendation() {
  const queryClient = useQueryClient();
  return useMutation<Recommendation, unknown, string>({
    mutationFn: (id) =>
      api.post<Recommendation>(
        `/ops/simulation/recommendations/${encodeURIComponent(id)}/dismiss`,
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: SIM_KEY });
    },
  });
}
