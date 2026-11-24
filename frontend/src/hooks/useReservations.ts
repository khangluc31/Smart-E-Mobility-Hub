// TanStack Query hooks for rental vehicles, vehicle reservations, parking, and history
// (CONTRACTS §4, §5, §6, D-01 5s polling, NFR-08 idempotency).

import { useMemo } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { POLL_INTERVAL_MS } from '@/lib/constants';
import { syncServerClock } from '@/hooks/useServerClock';
import type { RentalVehicleType, ReservationStatus, VehicleClass } from '@/types/enums';
import type { RentalVehicle } from '@/types/hubs';
import type {
  HistoryPage,
  HistoryType,
  ParkingAvailability,
  ParkingReservation,
  VehicleRecommendation,
  VehicleReservation,
  VehicleReturnResult,
} from '@/types/reservations';

export const VEHICLE_SEARCH_KEY = ['vehicles', 'search'] as const;
export const VEHICLE_RECOMMEND_KEY = ['vehicles', 'recommend'] as const;
export const CURRENT_RESERVATION_KEY = ['vehicle-reservations', 'current'] as const;
export const PARKING_AVAILABILITY_KEY = ['parking', 'availability'] as const;
export const HISTORY_KEY = ['me', 'history'] as const;

const HUBS_KEY = ['hubs'] as const;
const PRIVATE_EVS_KEY = ['private-evs'] as const;

export interface VehicleSearchFilters {
  hubId?: string;
  type?: RentalVehicleType;
  minBattery?: number;
  availableOnly?: boolean;
}

export interface VehicleRecommendQuery {
  originHubId: string;
  destinationHubId: string;
  time?: string;
}

export interface ParkingAvailabilityQuery {
  hubId: string;
  vehicleClass: VehicleClass;
  from: string;
  to: string;
}

export interface HistoryFilters {
  type?: HistoryType;
  status?: ReservationStatus;
}

export function useVehicleSearch(filters: VehicleSearchFilters, enabled = true) {
  return useQuery<RentalVehicle[]>({
    queryKey: [...VEHICLE_SEARCH_KEY, filters],
    queryFn: () => {
      const params = new URLSearchParams();
      if (filters.hubId) params.set('hubId', filters.hubId);
      if (filters.type) params.set('type', filters.type);
      if (filters.minBattery !== undefined) params.set('minBattery', String(filters.minBattery));
      if (filters.availableOnly !== undefined) {
        params.set('availableOnly', String(filters.availableOnly));
      }
      const qs = params.toString();
      return api.get<RentalVehicle[]>(qs ? `/vehicles/search?${qs}` : '/vehicles/search');
    },
    enabled,
    refetchInterval: POLL_INTERVAL_MS,
  });
}

export function useRecommend(query: VehicleRecommendQuery | null, enabled = true) {
  return useQuery<VehicleRecommendation>({
    queryKey: [...VEHICLE_RECOMMEND_KEY, query],
    queryFn: () => {
      const params = new URLSearchParams();
      params.set('originHubId', query?.originHubId ?? '');
      params.set('destinationHubId', query?.destinationHubId ?? '');
      if (query?.time) params.set('time', query.time);
      return api.get<VehicleRecommendation>(`/vehicles/recommend?${params.toString()}`);
    },
    enabled: enabled && Boolean(query?.originHubId && query?.destinationHubId),
  });
}

export function useCurrentReservation() {
  return useQuery<VehicleReservation | null>({
    queryKey: CURRENT_RESERVATION_KEY,
    queryFn: async () => {
      const res = await api.get<VehicleReservation | null>('/vehicle-reservations/current');
      if (res?.serverNow) syncServerClock(res.serverNow);
      return res;
    },
    refetchInterval: POLL_INTERVAL_MS,
  });
}

export function useParkingAvailability(query: ParkingAvailabilityQuery | null, enabled = true) {
  return useQuery<ParkingAvailability>({
    queryKey: [...PARKING_AVAILABILITY_KEY, query],
    queryFn: () => {
      const params = new URLSearchParams();
      params.set('hubId', query?.hubId ?? '');
      params.set('vehicleClass', query?.vehicleClass ?? 'MOTORCYCLE');
      params.set('from', query?.from ?? '');
      params.set('to', query?.to ?? '');
      return api.get<ParkingAvailability>(`/parking/availability?${params.toString()}`);
    },
    enabled: enabled && Boolean(query?.hubId && query?.vehicleClass && query?.from && query?.to),
  });
}

function buildHistoryPath(params: {
  type?: HistoryType;
  status?: ReservationStatus;
  cursor?: string | null;
}): string {
  const search = new URLSearchParams();
  if (params.type) search.set('type', params.type);
  if (params.status) search.set('status', params.status);
  if (params.cursor) search.set('cursor', params.cursor);
  const qs = search.toString();
  return qs ? `/me/history?${qs}` : '/me/history';
}

function syncClockFromHistory(page: HistoryPage): void {
  const first = page.items[0];
  if (first?.item.serverNow) {
    syncServerClock(first.item.serverNow);
  }
}

export function useHistory({ type = 'all', status }: HistoryFilters = {}) {
  return useInfiniteQuery<HistoryPage>({
    queryKey: [...HISTORY_KEY, { type, status: status ?? null }],
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }) => {
      const cursor = typeof pageParam === 'string' ? pageParam : null;
      const page = await api.get<HistoryPage>(buildHistoryPath({ type, status, cursor }));
      syncClockFromHistory(page);
      return page;
    },
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });
}

export function useMyParking() {
  const confirmedQuery = useQuery<HistoryPage>({
    queryKey: [...HISTORY_KEY, { type: 'parking', status: 'CONFIRMED' }],
    queryFn: async () => {
      const page = await api.get<HistoryPage>(
        buildHistoryPath({ type: 'parking', status: 'CONFIRMED' }),
      );
      syncClockFromHistory(page);
      return page;
    },
    refetchInterval: POLL_INTERVAL_MS,
  });

  const activeQuery = useQuery<HistoryPage>({
    queryKey: [...HISTORY_KEY, { type: 'parking', status: 'ACTIVE' }],
    queryFn: async () => {
      const page = await api.get<HistoryPage>(
        buildHistoryPath({ type: 'parking', status: 'ACTIVE' }),
      );
      syncClockFromHistory(page);
      return page;
    },
    refetchInterval: POLL_INTERVAL_MS,
  });

  const data = useMemo<ParkingReservation[]>(() => {
    const byId = new Map<string, ParkingReservation>();
    for (const entry of activeQuery.data?.items ?? []) {
      if (entry.kind === 'parking') byId.set(entry.item.id, entry.item);
    }
    for (const entry of confirmedQuery.data?.items ?? []) {
      if (entry.kind === 'parking') byId.set(entry.item.id, entry.item);
    }
    return Array.from(byId.values()).sort((a, b) => {
      if (a.status !== b.status) return a.status === 'ACTIVE' ? -1 : 1;
      return Date.parse(a.windowStart) - Date.parse(b.windowStart);
    });
  }, [activeQuery.data, confirmedQuery.data]);

  return {
    data,
    isLoading: confirmedQuery.isLoading || activeQuery.isLoading,
    error: activeQuery.error ?? confirmedQuery.error,
  };
}

function invalidateVehicleQueries(queryClient: ReturnType<typeof useQueryClient>) {
  void queryClient.invalidateQueries({ queryKey: VEHICLE_SEARCH_KEY });
  void queryClient.invalidateQueries({ queryKey: VEHICLE_RECOMMEND_KEY });
  void queryClient.invalidateQueries({ queryKey: CURRENT_RESERVATION_KEY });
  void queryClient.invalidateQueries({ queryKey: HISTORY_KEY });
  void queryClient.invalidateQueries({ queryKey: HUBS_KEY });
}

function invalidateParkingQueries(queryClient: ReturnType<typeof useQueryClient>) {
  void queryClient.invalidateQueries({ queryKey: PARKING_AVAILABILITY_KEY });
  void queryClient.invalidateQueries({ queryKey: HISTORY_KEY });
  void queryClient.invalidateQueries({ queryKey: HUBS_KEY });
  void queryClient.invalidateQueries({ queryKey: PRIVATE_EVS_KEY });
}

export function useReserveVehicle() {
  const queryClient = useQueryClient();
  return useMutation<VehicleReservation, unknown, { vehicleId: string; idempotencyKey: string }>({
    mutationFn: async ({ vehicleId, idempotencyKey }) => {
      const res = await api.post<VehicleReservation>(
        '/vehicle-reservations',
        { vehicleId },
        { idempotencyKey },
      );
      syncServerClock(res.serverNow);
      return res;
    },
    onSuccess: () => invalidateVehicleQueries(queryClient),
  });
}

export function useCancelVehicleReservation() {
  const queryClient = useQueryClient();
  return useMutation<VehicleReservation, unknown, string>({
    mutationFn: async (id) => {
      const res = await api.post<VehicleReservation>(
        `/vehicle-reservations/${encodeURIComponent(id)}/cancel`,
      );
      syncServerClock(res.serverNow);
      return res;
    },
    onSuccess: () => invalidateVehicleQueries(queryClient),
  });
}

export function useChangeVehicle() {
  const queryClient = useQueryClient();
  return useMutation<VehicleReservation, unknown, { id: string; vehicleId: string }>({
    mutationFn: async ({ id, vehicleId }) => {
      const res = await api.patch<VehicleReservation>(
        `/vehicle-reservations/${encodeURIComponent(id)}`,
        { vehicleId },
      );
      syncServerClock(res.serverNow);
      return res;
    },
    onSuccess: () => invalidateVehicleQueries(queryClient),
  });
}

export function usePickupVehicle() {
  const queryClient = useQueryClient();
  return useMutation<VehicleReservation, unknown, string>({
    mutationFn: async (id) => {
      const res = await api.post<VehicleReservation>(
        `/vehicle-reservations/${encodeURIComponent(id)}/pickup`,
      );
      syncServerClock(res.serverNow);
      return res;
    },
    onSuccess: () => invalidateVehicleQueries(queryClient),
  });
}

export function useReturnVehicle() {
  const queryClient = useQueryClient();
  return useMutation<VehicleReturnResult, unknown, { id: string; hubId: string }>({
    mutationFn: async ({ id, hubId }) => {
      const res = await api.post<VehicleReturnResult>(
        `/vehicle-reservations/${encodeURIComponent(id)}/return`,
        { hubId },
      );
      syncServerClock(res.reservation.serverNow);
      return res;
    },
    onSuccess: () => invalidateVehicleQueries(queryClient),
  });
}

export interface ReserveParkingInput {
  hubId: string;
  vehicleClass: VehicleClass;
  privateEvId?: string;
  windowStart: string;
  windowEnd: string;
  idempotencyKey: string;
}

export function useReserveParking() {
  const queryClient = useQueryClient();
  return useMutation<ParkingReservation, unknown, ReserveParkingInput>({
    mutationFn: async ({ idempotencyKey, ...body }) => {
      const res = await api.post<ParkingReservation>('/parking-reservations', body, {
        idempotencyKey,
      });
      syncServerClock(res.serverNow);
      return res;
    },
    onSuccess: () => invalidateParkingQueries(queryClient),
  });
}

export function useCancelParking() {
  const queryClient = useQueryClient();
  return useMutation<ParkingReservation, unknown, string>({
    mutationFn: async (id) => {
      const res = await api.post<ParkingReservation>(
        `/parking-reservations/${encodeURIComponent(id)}/cancel`,
      );
      syncServerClock(res.serverNow);
      return res;
    },
    onSuccess: () => invalidateParkingQueries(queryClient),
  });
}

export function useChangeParkingWindow() {
  const queryClient = useQueryClient();
  return useMutation<
    ParkingReservation,
    unknown,
    { id: string; windowStart: string; windowEnd: string }
  >({
    mutationFn: async ({ id, windowStart, windowEnd }) => {
      const res = await api.patch<ParkingReservation>(
        `/parking-reservations/${encodeURIComponent(id)}`,
        { windowStart, windowEnd },
      );
      syncServerClock(res.serverNow);
      return res;
    },
    onSuccess: () => invalidateParkingQueries(queryClient),
  });
}

export function useClaimParking() {
  const queryClient = useQueryClient();
  return useMutation<ParkingReservation, unknown, string>({
    mutationFn: async (id) => {
      const res = await api.post<ParkingReservation>(
        `/parking-reservations/${encodeURIComponent(id)}/claim`,
      );
      syncServerClock(res.serverNow);
      return res;
    },
    onSuccess: () => invalidateParkingQueries(queryClient),
  });
}

export function useLeaveParking() {
  const queryClient = useQueryClient();
  return useMutation<ParkingReservation, unknown, string>({
    mutationFn: async (id) => {
      const res = await api.post<ParkingReservation>(
        `/parking-reservations/${encodeURIComponent(id)}/leave`,
      );
      syncServerClock(res.serverNow);
      return res;
    },
    onSuccess: () => invalidateParkingQueries(queryClient),
  });
}
