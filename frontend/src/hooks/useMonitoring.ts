// TanStack Query hooks for Operator Monitoring & Alerts (CONTRACTS §10, FR-31–FR-35, D-01 5s polling).

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { POLL_INTERVAL_MS } from '@/lib/constants';
import { syncServerClock } from '@/hooks/useServerClock';
import type { AlertStatus, AlertType } from '@/types/enums';
import type { Alert, AlertList, DashboardResponse, OpsHubDetail } from '@/types/monitoring';

export const OPS_DASHBOARD_KEY = ['ops', 'dashboard'] as const;
export const OPS_HUB_DETAIL_KEY = ['ops', 'hub'] as const;
export const OPS_ALERTS_KEY = ['ops', 'alerts'] as const;

export interface OpsAlertsFilters {
  status?: AlertStatus;
  type?: AlertType;
  hubId?: string;
  limit?: number;
}

export interface AlertActionInput {
  id: string;
  note?: string;
}

function buildAlertsPath(filters: OpsAlertsFilters, cursor: string | null): string {
  const params = new URLSearchParams();
  if (filters.status) params.set('status', filters.status);
  if (filters.type) params.set('type', filters.type);
  if (filters.hubId) params.set('hubId', filters.hubId);
  if (filters.limit !== undefined) params.set('limit', String(filters.limit));
  if (cursor) params.set('cursor', cursor);
  const qs = params.toString();
  return qs ? `/ops/alerts?${qs}` : '/ops/alerts';
}

export function useOpsDashboard() {
  return useQuery<DashboardResponse>({
    queryKey: OPS_DASHBOARD_KEY,
    queryFn: async () => {
      const res = await api.get<DashboardResponse>('/ops/dashboard');
      syncServerClock(res.serverNow);
      return res;
    },
    refetchInterval: POLL_INTERVAL_MS,
  });
}

export function useOpsHubDetail(hubId: string | null) {
  return useQuery<OpsHubDetail>({
    queryKey: [...OPS_HUB_DETAIL_KEY, hubId],
    queryFn: () => api.get<OpsHubDetail>(`/ops/hubs/${encodeURIComponent(hubId!)}`),
    enabled: Boolean(hubId),
    refetchInterval: POLL_INTERVAL_MS,
  });
}

export function useOpsAlerts(filters: OpsAlertsFilters = {}) {
  return useInfiniteQuery<AlertList>({
    queryKey: [
      ...OPS_ALERTS_KEY,
      {
        status: filters.status ?? null,
        type: filters.type ?? null,
        hubId: filters.hubId ?? null,
        limit: filters.limit ?? null,
      },
    ],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const cursor = typeof pageParam === 'string' ? pageParam : null;
      return api.get<AlertList>(buildAlertsPath(filters, cursor));
    },
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    refetchInterval: POLL_INTERVAL_MS,
  });
}

export function useAcknowledgeAlert() {
  const queryClient = useQueryClient();
  return useMutation<Alert, unknown, AlertActionInput>({
    mutationFn: ({ id, note }) => {
      const trimmed = note?.trim();
      return api.post<Alert>(
        `/ops/alerts/${encodeURIComponent(id)}/acknowledge`,
        trimmed ? { note: trimmed } : {},
      );
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: OPS_ALERTS_KEY });
      void queryClient.invalidateQueries({ queryKey: OPS_DASHBOARD_KEY });
    },
  });
}

export function useDismissAlert() {
  const queryClient = useQueryClient();
  return useMutation<Alert, unknown, AlertActionInput>({
    mutationFn: ({ id, note }) => {
      const trimmed = note?.trim();
      return api.post<Alert>(
        `/ops/alerts/${encodeURIComponent(id)}/dismiss`,
        trimmed ? { note: trimmed } : {},
      );
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: OPS_ALERTS_KEY });
      void queryClient.invalidateQueries({ queryKey: OPS_DASHBOARD_KEY });
    },
  });
}
