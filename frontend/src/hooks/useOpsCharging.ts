// TanStack Query hooks for Operator Charging Queue, Schedule, Weights, Dispatch & Overrides
// (CONTRACTS §8.2, FR-48–FR-52, D-01 5s polling).
// Uses local literal keys for cross-invalidation to avoid circular imports.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { POLL_INTERVAL_MS } from '@/lib/constants';
import type { VehicleClass } from '@/types/enums';
import type {
  ChargingOverrideRequest,
  ChargingOverrideResult,
  ChargingQueue,
  ChargingSchedule,
  ChargingWeights,
  ChargingWeightsView,
  DispatchResult,
  FleetDispatchRequest,
} from '@/types/charging';

export const OPS_CHARGING_KEY = ['ops', 'charging'] as const;

const OPS_DASHBOARD_KEY = ['ops', 'dashboard'] as const;
const OPS_HUB_DETAIL_KEY = ['ops', 'hub'] as const;
const HUBS_KEY = ['hubs'] as const;

export function useOpsChargingQueue(hubId: string | null, vehicleClass?: VehicleClass) {
  return useQuery<ChargingQueue>({
    queryKey: [
      ...OPS_CHARGING_KEY,
      'queue',
      { hubId, vehicleClass: vehicleClass ?? null },
    ],
    queryFn: () => {
      const params = new URLSearchParams();
      params.set('hubId', hubId!);
      if (vehicleClass) params.set('vehicleClass', vehicleClass);
      return api.get<ChargingQueue>(`/ops/charging/queue?${params.toString()}`);
    },
    enabled: Boolean(hubId),
    refetchInterval: POLL_INTERVAL_MS,
  });
}

export function useOpsChargingSchedule(hubId?: string) {
  return useQuery<ChargingSchedule>({
    queryKey: [...OPS_CHARGING_KEY, 'schedule', { hubId: hubId ?? null }],
    queryFn: () => {
      const qs = hubId ? `?hubId=${encodeURIComponent(hubId)}` : '';
      return api.get<ChargingSchedule>(`/ops/charging/schedule${qs}`);
    },
    refetchInterval: POLL_INTERVAL_MS,
  });
}

export function useChargingWeights() {
  return useQuery<ChargingWeightsView>({
    queryKey: [...OPS_CHARGING_KEY, 'weights'],
    queryFn: () => api.get<ChargingWeightsView>('/ops/charging/weights'),
    refetchInterval: POLL_INTERVAL_MS,
  });
}

export function useUpdateChargingWeights() {
  const queryClient = useQueryClient();
  return useMutation<ChargingWeights, unknown, ChargingWeights>({
    mutationFn: (body) => api.put<ChargingWeights>('/ops/charging/weights', body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: OPS_CHARGING_KEY });
    },
  });
}

export function useResetChargingWeights() {
  const queryClient = useQueryClient();
  return useMutation<ChargingWeightsView, unknown, void>({
    mutationFn: () => api.post<ChargingWeightsView>('/ops/charging/weights/reset'),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: OPS_CHARGING_KEY });
    },
  });
}

export function useDispatchFleetCharging() {
  const queryClient = useQueryClient();
  return useMutation<DispatchResult, unknown, FleetDispatchRequest>({
    mutationFn: (body) => api.post<DispatchResult>('/ops/charging/dispatch', body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: OPS_CHARGING_KEY });
      void queryClient.invalidateQueries({ queryKey: OPS_DASHBOARD_KEY });
      void queryClient.invalidateQueries({ queryKey: OPS_HUB_DETAIL_KEY });
      void queryClient.invalidateQueries({ queryKey: HUBS_KEY });
    },
  });
}

export function useOverrideChargingQueue() {
  const queryClient = useQueryClient();
  return useMutation<ChargingOverrideResult, unknown, ChargingOverrideRequest>({
    mutationFn: (body) => api.post<ChargingOverrideResult>('/ops/charging/override', body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: OPS_CHARGING_KEY });
      void queryClient.invalidateQueries({ queryKey: OPS_DASHBOARD_KEY });
    },
  });
}
