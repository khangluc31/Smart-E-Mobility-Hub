// TanStack Query hooks for Telemetry Demo Controls & Rejected Packets log
// (CONTRACTS §14, ARCHITECTURE §7.4, NFR-25, D-01 5s polling).
// Uses local literal keys for cross-invalidation to avoid circular imports.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { POLL_INTERVAL_MS } from '@/lib/constants';
import type {
  TelemetryDemoBatteryRequest,
  TelemetryDemoFaultRequest,
  TelemetryDemoQueuedResponse,
  TelemetryDemoStallRequest,
  TelemetryDemoStallResponse,
  TelemetryRejectsResponse,
} from '@/types/telemetry';

export const TELEMETRY_REJECTS_KEY = ['ops', 'telemetry', 'rejects'] as const;

const OPS_DASHBOARD_KEY = ['ops', 'dashboard'] as const;
const OPS_HUB_DETAIL_KEY = ['ops', 'hub'] as const;
const OPS_ALERTS_KEY = ['ops', 'alerts'] as const;
const OPS_INCIDENTS_KEY = ['ops', 'incidents'] as const;
const HUBS_KEY = ['hubs'] as const;

export function useTelemetryRejects(limit?: number) {
  return useQuery<TelemetryRejectsResponse>({
    queryKey: [...TELEMETRY_REJECTS_KEY, { limit: limit ?? null }],
    queryFn: () => {
      const qs = limit !== undefined ? `?limit=${encodeURIComponent(String(limit))}` : '';
      return api.get<TelemetryRejectsResponse>(`/ops/telemetry/rejects${qs}`);
    },
    refetchInterval: POLL_INTERVAL_MS,
  });
}

export function useDemoStall() {
  const queryClient = useQueryClient();
  return useMutation<TelemetryDemoStallResponse, unknown, TelemetryDemoStallRequest>({
    mutationFn: (body) =>
      api.post<TelemetryDemoStallResponse>('/ops/telemetry/demo/stall', body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: OPS_DASHBOARD_KEY });
      void queryClient.invalidateQueries({ queryKey: OPS_ALERTS_KEY });
      void queryClient.invalidateQueries({ queryKey: HUBS_KEY });
    },
  });
}

export function useDemoFault() {
  const queryClient = useQueryClient();
  return useMutation<TelemetryDemoQueuedResponse, unknown, TelemetryDemoFaultRequest>({
    mutationFn: (body) =>
      api.post<TelemetryDemoQueuedResponse>('/ops/telemetry/demo/fault', body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: OPS_DASHBOARD_KEY });
      void queryClient.invalidateQueries({ queryKey: OPS_INCIDENTS_KEY });
      void queryClient.invalidateQueries({ queryKey: OPS_ALERTS_KEY });
    },
  });
}

export function useDemoBattery() {
  const queryClient = useQueryClient();
  return useMutation<TelemetryDemoQueuedResponse, unknown, TelemetryDemoBatteryRequest>({
    mutationFn: (body) =>
      api.post<TelemetryDemoQueuedResponse>('/ops/telemetry/demo/battery', body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: OPS_DASHBOARD_KEY });
      void queryClient.invalidateQueries({ queryKey: OPS_HUB_DETAIL_KEY });
      void queryClient.invalidateQueries({ queryKey: OPS_ALERTS_KEY });
    },
  });
}
