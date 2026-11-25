// TanStack Query hooks for Operator Incidents (CONTRACTS §11, FR-37–FR-42, D-01 5s polling).
// Uses local literal query keys for cross-invalidation to avoid circular imports with useMonitoring.ts.

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { POLL_INTERVAL_MS } from '@/lib/constants';
import type {
  IncidentCategory,
  IncidentResourceType,
  IncidentStatus,
  VehicleClass,
} from '@/types/enums';
import type {
  Incident,
  IncidentDetail,
  IncidentList,
  ReportIncidentResult,
} from '@/types/incidents';

export const OPS_INCIDENTS_KEY = ['ops', 'incidents'] as const;

const OPS_DASHBOARD_KEY = ['ops', 'dashboard'] as const;
const OPS_HUB_DETAIL_KEY = ['ops', 'hub'] as const;
const OPS_ALERTS_KEY = ['ops', 'alerts'] as const;
const HUBS_KEY = ['hubs'] as const;

export interface OpsIncidentsFilters {
  hubId?: string;
  resourceId?: string;
  vehicleClass?: VehicleClass;
  category?: IncidentCategory;
  status?: IncidentStatus;
  from?: string;
  to?: string;
  limit?: number;
}

export interface CreateIncidentInput {
  resourceType: IncidentResourceType;
  resourceId: string;
  hubId: string;
  vehicleClass: VehicleClass;
  category: IncidentCategory;
  notes: string;
}

export interface StartMaintenanceInput {
  id: string;
  notes?: string;
}

export interface ResolveIncidentInput {
  id: string;
  resolutionNotes: string;
}

function buildIncidentsPath(filters: OpsIncidentsFilters, cursor: string | null): string {
  const params = new URLSearchParams();
  if (filters.hubId) params.set('hubId', filters.hubId);
  if (filters.resourceId) params.set('resourceId', filters.resourceId);
  if (filters.vehicleClass) params.set('vehicleClass', filters.vehicleClass);
  if (filters.category) params.set('category', filters.category);
  if (filters.status) params.set('status', filters.status);
  if (filters.from) params.set('from', filters.from);
  if (filters.to) params.set('to', filters.to);
  if (filters.limit !== undefined) params.set('limit', String(filters.limit));
  if (cursor) params.set('cursor', cursor);
  const qs = params.toString();
  return qs ? `/ops/incidents?${qs}` : '/ops/incidents';
}

export function useOpsIncidents(filters: OpsIncidentsFilters = {}) {
  return useInfiniteQuery<IncidentList>({
    queryKey: [
      ...OPS_INCIDENTS_KEY,
      {
        hubId: filters.hubId ?? null,
        resourceId: filters.resourceId ?? null,
        vehicleClass: filters.vehicleClass ?? null,
        category: filters.category ?? null,
        status: filters.status ?? null,
        from: filters.from ?? null,
        to: filters.to ?? null,
        limit: filters.limit ?? null,
      },
    ],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const cursor = typeof pageParam === 'string' ? pageParam : null;
      return api.get<IncidentList>(buildIncidentsPath(filters, cursor));
    },
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    refetchInterval: POLL_INTERVAL_MS,
  });
}

export function useOpsIncidentDetail(id: string | null) {
  return useQuery<IncidentDetail>({
    queryKey: [...OPS_INCIDENTS_KEY, 'detail', id],
    queryFn: () => api.get<IncidentDetail>(`/ops/incidents/${encodeURIComponent(id!)}`),
    enabled: Boolean(id),
    refetchInterval: POLL_INTERVAL_MS,
  });
}

export function useCreateIncident() {
  const queryClient = useQueryClient();
  return useMutation<ReportIncidentResult, unknown, CreateIncidentInput>({
    mutationFn: (body) => api.post<ReportIncidentResult>('/ops/incidents', body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: OPS_INCIDENTS_KEY });
      void queryClient.invalidateQueries({ queryKey: OPS_DASHBOARD_KEY });
      void queryClient.invalidateQueries({ queryKey: OPS_HUB_DETAIL_KEY });
      void queryClient.invalidateQueries({ queryKey: OPS_ALERTS_KEY });
      void queryClient.invalidateQueries({ queryKey: HUBS_KEY });
    },
  });
}

export function useStartMaintenance() {
  const queryClient = useQueryClient();
  return useMutation<Incident, unknown, StartMaintenanceInput>({
    mutationFn: ({ id, notes }) => {
      const trimmed = notes?.trim();
      return api.post<Incident>(
        `/ops/incidents/${encodeURIComponent(id)}/start-maintenance`,
        trimmed ? { notes: trimmed } : {},
      );
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: OPS_INCIDENTS_KEY });
      void queryClient.invalidateQueries({ queryKey: OPS_DASHBOARD_KEY });
    },
  });
}

export function useResolveIncident() {
  const queryClient = useQueryClient();
  return useMutation<Incident, unknown, ResolveIncidentInput>({
    mutationFn: ({ id, resolutionNotes }) =>
      api.post<Incident>(`/ops/incidents/${encodeURIComponent(id)}/resolve`, {
        resolutionNotes: resolutionNotes.trim(),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: OPS_INCIDENTS_KEY });
      void queryClient.invalidateQueries({ queryKey: OPS_DASHBOARD_KEY });
      void queryClient.invalidateQueries({ queryKey: OPS_HUB_DETAIL_KEY });
      void queryClient.invalidateQueries({ queryKey: OPS_ALERTS_KEY });
      void queryClient.invalidateQueries({ queryKey: HUBS_KEY });
    },
  });
}
