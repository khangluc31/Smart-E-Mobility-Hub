// TanStack Query hooks for Student Charging (CONTRACTS §8.1, FR-20–FR-24, D-01 5s polling, NFR-08).

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { POLL_INTERVAL_MS } from '@/lib/constants';
import { PRIVATE_EVS_QUERY_KEY } from '@/hooks/usePrivateEvs';
import { HISTORY_KEY } from '@/hooks/useReservations';
import { syncServerClock } from '@/hooks/useServerClock';
import type {
  BookAdvanceChargingRequest,
  ChargingAvailability,
  ChargingRequestView,
  SubmitChargingRequest,
} from '@/types/charging';

export const CHARGING_QUERY_KEY = ['charging'] as const;

const HUBS_KEY = ['hubs'] as const;

export interface ChargingAvailabilityParams {
  hubId: string;
  privateEvId: string;
  slotStart: string;
  targetPct: number;
}

export interface BookAdvanceChargingInput extends BookAdvanceChargingRequest {
  idempotencyKey?: string;
}

function invalidateAfterChargingMutation(queryClient: ReturnType<typeof useQueryClient>): void {
  void queryClient.invalidateQueries({ queryKey: CHARGING_QUERY_KEY });
  void queryClient.invalidateQueries({ queryKey: PRIVATE_EVS_QUERY_KEY });
  void queryClient.invalidateQueries({ queryKey: HISTORY_KEY });
  void queryClient.invalidateQueries({ queryKey: HUBS_KEY });
}

export function useMyChargingRequests(active = true) {
  return useQuery<ChargingRequestView[]>({
    queryKey: [...CHARGING_QUERY_KEY, 'mine', { active }],
    queryFn: async () => {
      const items = await api.get<ChargingRequestView[]>(
        `/charging/requests/mine?active=${active ? 'true' : 'false'}`,
      );
      if (items[0]?.serverNow) {
        syncServerClock(items[0].serverNow);
      }
      return items;
    },
    refetchInterval: POLL_INTERVAL_MS,
  });
}

export function useChargingAvailability(params: ChargingAvailabilityParams | null) {
  return useQuery<ChargingAvailability>({
    queryKey: [...CHARGING_QUERY_KEY, 'availability', params],
    queryFn: () => {
      const qs = new URLSearchParams({
        hubId: params!.hubId,
        privateEvId: params!.privateEvId,
        slotStart: params!.slotStart,
        targetPct: String(params!.targetPct),
      });
      return api.get<ChargingAvailability>(`/charging/availability?${qs.toString()}`);
    },
    enabled: Boolean(
      params &&
        params.hubId &&
        params.privateEvId &&
        params.slotStart &&
        Number.isFinite(params.targetPct),
    ),
    retry: false,
  });
}

export function useSubmitChargingRequest() {
  const queryClient = useQueryClient();
  return useMutation<ChargingRequestView, unknown, SubmitChargingRequest>({
    mutationFn: async (body) => {
      const res = await api.post<ChargingRequestView>('/charging/requests', body);
      if (res.serverNow) syncServerClock(res.serverNow);
      return res;
    },
    onSuccess: () => invalidateAfterChargingMutation(queryClient),
  });
}

export function useBookAdvanceCharging() {
  const queryClient = useQueryClient();
  return useMutation<ChargingRequestView, unknown, BookAdvanceChargingInput>({
    mutationFn: async ({ idempotencyKey, ...body }) => {
      const key = idempotencyKey ?? crypto.randomUUID();
      const res = await api.post<ChargingRequestView>('/charging/advance-bookings', body, {
        idempotencyKey: key,
      });
      if (res.serverNow) syncServerClock(res.serverNow);
      return res;
    },
    onSuccess: () => invalidateAfterChargingMutation(queryClient),
  });
}

export function useStopChargingRequest() {
  const queryClient = useQueryClient();
  return useMutation<ChargingRequestView, unknown, string>({
    mutationFn: async (id) => {
      const res = await api.post<ChargingRequestView>(
        `/charging/requests/${encodeURIComponent(id)}/stop`,
      );
      if (res.serverNow) syncServerClock(res.serverNow);
      return res;
    },
    onSuccess: () => invalidateAfterChargingMutation(queryClient),
  });
}

export function useCancelChargingRequest() {
  const queryClient = useQueryClient();
  return useMutation<ChargingRequestView, unknown, string>({
    mutationFn: async (id) => {
      const res = await api.post<ChargingRequestView>(
        `/charging/requests/${encodeURIComponent(id)}/cancel`,
      );
      if (res.serverNow) syncServerClock(res.serverNow);
      return res;
    },
    onSuccess: () => invalidateAfterChargingMutation(queryClient),
  });
}
