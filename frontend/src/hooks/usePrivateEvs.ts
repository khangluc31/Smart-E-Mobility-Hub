// TanStack Query hooks for Private EVs (CONTRACTS §7, FR-25–FR-27, D-01 5s polling).

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { POLL_INTERVAL_MS } from '@/lib/constants';
import { HISTORY_KEY } from '@/hooks/useReservations';
import type { PrivateEvType } from '@/types/enums';
import type { PrivateEv } from '@/types/privateEvs';

export const PRIVATE_EVS_QUERY_KEY = ['private-evs'] as const;

export interface CreatePrivateEvInput {
  type: PrivateEvType;
  label: string;
  batteryCapacityKwh: number;
  batteryPct: number;
}

export interface UpdatePrivateEvInput {
  id: string;
  label?: string;
  type?: PrivateEvType;
  batteryCapacityKwh?: number;
  batteryPct?: number;
}

export function usePrivateEvs() {
  return useQuery<PrivateEv[]>({
    queryKey: PRIVATE_EVS_QUERY_KEY,
    queryFn: () => api.get<PrivateEv[]>('/private-evs'),
    refetchInterval: POLL_INTERVAL_MS,
  });
}

export function useCreatePrivateEv() {
  const queryClient = useQueryClient();
  return useMutation<PrivateEv, unknown, CreatePrivateEvInput>({
    mutationFn: (body) => api.post<PrivateEv>('/private-evs', body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: PRIVATE_EVS_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: HISTORY_KEY });
    },
  });
}

export function useUpdatePrivateEv() {
  const queryClient = useQueryClient();
  return useMutation<PrivateEv, unknown, UpdatePrivateEvInput>({
    mutationFn: ({ id, ...body }) =>
      api.patch<PrivateEv>(`/private-evs/${encodeURIComponent(id)}`, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: PRIVATE_EVS_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: HISTORY_KEY });
    },
  });
}

export function useRemovePrivateEv() {
  const queryClient = useQueryClient();
  return useMutation<void, unknown, string>({
    mutationFn: (id) => api.delete<void>(`/private-evs/${encodeURIComponent(id)}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: PRIVATE_EVS_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: HISTORY_KEY });
    },
  });
}
