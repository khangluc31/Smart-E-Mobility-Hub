// TanStack Query hooks for Operator Redistribution & Imbalance Detection
// (CONTRACTS §12, FR-43–FR-47, BR-08, D-19, D-01 5s polling).
// Uses local literal keys for cross-invalidation to avoid circular imports.

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { POLL_INTERVAL_MS } from '@/lib/constants';
import type {
  RedistributionStatus,
  RentalVehicleType,
  VehicleClass,
} from '@/types/enums';
import type {
  Imbalance,
  RedistributionPreview,
  RedistributionTask,
  RedistributionTaskList,
} from '@/types/redistribution';

export const OPS_REDISTRIBUTION_KEY = ['ops', 'redistribution'] as const;

const OPS_DASHBOARD_KEY = ['ops', 'dashboard'] as const;
const OPS_HUB_DETAIL_KEY = ['ops', 'hub'] as const;
const OPS_ALERTS_KEY = ['ops', 'alerts'] as const;
const HUBS_KEY = ['hubs'] as const;

export interface RedistributionPreviewParams {
  sourceHubId: string;
  destHubId: string;
  vehicleClass: VehicleClass;
  vehicleType?: RentalVehicleType;
  count: number;
}

export interface RedistributionTasksFilters {
  status?: RedistributionStatus;
  limit?: number;
}

export interface CreateRedistributionTaskInput {
  sourceHubId: string;
  destHubId: string;
  vehicleClass: VehicleClass;
  vehicleType?: RentalVehicleType;
  count: number;
  override?: boolean;
  reason?: string;
}

export interface RedistributionReasonInput {
  id: string;
  reason: string;
}

function invalidateAfterRedistributionMutation(
  queryClient: ReturnType<typeof useQueryClient>,
): void {
  void queryClient.invalidateQueries({ queryKey: OPS_REDISTRIBUTION_KEY });
  void queryClient.invalidateQueries({ queryKey: OPS_DASHBOARD_KEY });
  void queryClient.invalidateQueries({ queryKey: OPS_HUB_DETAIL_KEY });
  void queryClient.invalidateQueries({ queryKey: OPS_ALERTS_KEY });
  void queryClient.invalidateQueries({ queryKey: HUBS_KEY });
}

function buildTasksPath(filters: RedistributionTasksFilters, cursor: string | null): string {
  const params = new URLSearchParams();
  if (filters.status) params.set('status', filters.status);
  if (filters.limit !== undefined) params.set('limit', String(filters.limit));
  if (cursor) params.set('cursor', cursor);
  const qs = params.toString();
  return qs ? `/ops/redistribution/tasks?${qs}` : '/ops/redistribution/tasks';
}

export function useImbalances() {
  return useQuery<Imbalance[]>({
    queryKey: [...OPS_REDISTRIBUTION_KEY, 'imbalances'],
    queryFn: () => api.get<Imbalance[]>('/ops/redistribution/imbalances'),
    refetchInterval: POLL_INTERVAL_MS,
  });
}

export function useRedistributionPreview(params: RedistributionPreviewParams | null) {
  const enabled = Boolean(
    params &&
      params.sourceHubId &&
      params.destHubId &&
      params.sourceHubId !== params.destHubId &&
      Number.isInteger(params.count) &&
      params.count >= 1,
  );

  return useQuery<RedistributionPreview>({
    queryKey: [...OPS_REDISTRIBUTION_KEY, 'preview', params],
    queryFn: () => {
      const qs = new URLSearchParams({
        sourceHubId: params!.sourceHubId,
        destHubId: params!.destHubId,
        vehicleClass: params!.vehicleClass,
        count: String(params!.count),
      });
      if (params!.vehicleType) {
        qs.set('vehicleType', params!.vehicleType);
      }
      return api.get<RedistributionPreview>(`/ops/redistribution/preview?${qs.toString()}`);
    },
    enabled,
    retry: false,
  });
}

export function useRedistributionTasks(filters: RedistributionTasksFilters = {}) {
  return useInfiniteQuery<RedistributionTaskList>({
    queryKey: [
      ...OPS_REDISTRIBUTION_KEY,
      'tasks',
      { status: filters.status ?? null, limit: filters.limit ?? null },
    ],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const cursor = typeof pageParam === 'string' ? pageParam : null;
      return api.get<RedistributionTaskList>(buildTasksPath(filters, cursor));
    },
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    refetchInterval: POLL_INTERVAL_MS,
  });
}

export function useRedistributionTask(id: string | null) {
  return useQuery<RedistributionTask>({
    queryKey: [...OPS_REDISTRIBUTION_KEY, 'task', id],
    queryFn: () =>
      api.get<RedistributionTask>(`/ops/redistribution/tasks/${encodeURIComponent(id!)}`),
    enabled: Boolean(id),
    refetchInterval: POLL_INTERVAL_MS,
  });
}

export function useCreateRedistributionTask() {
  const queryClient = useQueryClient();
  return useMutation<RedistributionTask, unknown, CreateRedistributionTaskInput>({
    mutationFn: (body) => api.post<RedistributionTask>('/ops/redistribution/tasks', body),
    onSuccess: () => invalidateAfterRedistributionMutation(queryClient),
  });
}

export function useApproveRedistributionTask() {
  const queryClient = useQueryClient();
  return useMutation<RedistributionTask, unknown, string>({
    mutationFn: (id) =>
      api.post<RedistributionTask>(
        `/ops/redistribution/tasks/${encodeURIComponent(id)}/approve`,
      ),
    onSuccess: () => invalidateAfterRedistributionMutation(queryClient),
  });
}

export function useStartRedistributionTask() {
  const queryClient = useQueryClient();
  return useMutation<RedistributionTask, unknown, string>({
    mutationFn: (id) =>
      api.post<RedistributionTask>(
        `/ops/redistribution/tasks/${encodeURIComponent(id)}/start`,
      ),
    onSuccess: () => invalidateAfterRedistributionMutation(queryClient),
  });
}

export function useCompleteRedistributionTask() {
  const queryClient = useQueryClient();
  return useMutation<RedistributionTask, unknown, string>({
    mutationFn: (id) =>
      api.post<RedistributionTask>(
        `/ops/redistribution/tasks/${encodeURIComponent(id)}/complete`,
      ),
    onSuccess: () => invalidateAfterRedistributionMutation(queryClient),
  });
}

export function useFailRedistributionTask() {
  const queryClient = useQueryClient();
  return useMutation<RedistributionTask, unknown, RedistributionReasonInput>({
    mutationFn: ({ id, reason }) =>
      api.post<RedistributionTask>(
        `/ops/redistribution/tasks/${encodeURIComponent(id)}/fail`,
        { reason: reason.trim() },
      ),
    onSuccess: () => invalidateAfterRedistributionMutation(queryClient),
  });
}

export function useCancelRedistributionTask() {
  const queryClient = useQueryClient();
  return useMutation<RedistributionTask, unknown, RedistributionReasonInput>({
    mutationFn: ({ id, reason }) =>
      api.post<RedistributionTask>(
        `/ops/redistribution/tasks/${encodeURIComponent(id)}/cancel`,
        { reason: reason.trim() },
      ),
    onSuccess: () => invalidateAfterRedistributionMutation(queryClient),
  });
}
