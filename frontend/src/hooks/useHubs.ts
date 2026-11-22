// TanStack Query hooks for Hubs endpoints (CONTRACTS §3, D-01 5s polling).

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { POLL_INTERVAL_MS } from '@/lib/constants';
import type { Alternative } from '@/types/common';
import type { VehicleClass } from '@/types/enums';
import type { AlternativeNeed, HubDetail, HubSummary } from '@/types/hubs';

export interface HubAlternativesQuery {
  need: AlternativeNeed;
  vehicleClass: VehicleClass;
  excludeHubId?: string;
  from?: string;
  to?: string;
}

export function useHubs() {
  return useQuery<HubSummary[]>({
    queryKey: ['hubs'],
    queryFn: () => api.get<HubSummary[]>('/hubs'),
    refetchInterval: POLL_INTERVAL_MS,
  });
}

export function useHub(hubId: string | undefined) {
  return useQuery<HubDetail>({
    queryKey: ['hubs', hubId],
    queryFn: () => api.get<HubDetail>(`/hubs/${encodeURIComponent(hubId ?? '')}`),
    enabled: Boolean(hubId),
    refetchInterval: POLL_INTERVAL_MS,
  });
}

export function useHubAlternatives(query: HubAlternativesQuery, enabled = true) {
  return useQuery<Alternative[]>({
    queryKey: ['hubs', 'alternatives', query],
    queryFn: () => {
      const params = new URLSearchParams();
      params.set('need', query.need);
      params.set('vehicleClass', query.vehicleClass);
      if (query.excludeHubId) params.set('excludeHubId', query.excludeHubId);
      if (query.from) params.set('from', query.from);
      if (query.to) params.set('to', query.to);
      return api.get<Alternative[]>(`/hubs/alternatives?${params.toString()}`);
    },
    enabled,
  });
}
