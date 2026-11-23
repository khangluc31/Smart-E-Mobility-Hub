// TanStack Query hooks for in-app notifications (CONTRACTS §9, FR-62, D-01).

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { POLL_INTERVAL_MS } from '@/lib/constants';
import type { NotificationList } from '@/types/notifications';

export interface UseNotificationsParams {
  unreadOnly?: boolean;
  limit?: number;
  cursor?: string | null;
}

export const NOTIFICATIONS_QUERY_KEY = ['notifications'] as const;

function buildNotificationsPath(params: UseNotificationsParams): string {
  const search = new URLSearchParams();
  if (params.unreadOnly !== undefined) {
    search.set('unreadOnly', String(params.unreadOnly));
  }
  if (params.limit !== undefined) {
    search.set('limit', String(params.limit));
  }
  if (params.cursor) {
    search.set('cursor', params.cursor);
  }
  const qs = search.toString();
  return qs ? `/notifications?${qs}` : '/notifications';
}

export function useNotifications(params: UseNotificationsParams = {}) {
  return useQuery<NotificationList>({
    queryKey: [...NOTIFICATIONS_QUERY_KEY, params],
    queryFn: () => api.get<NotificationList>(buildNotificationsPath(params)),
    refetchInterval: POLL_INTERVAL_MS,
  });
}

export function useMarkRead() {
  const queryClient = useQueryClient();
  return useMutation<void, unknown, string>({
    mutationFn: (id: string) => api.post<void>(`/notifications/${encodeURIComponent(id)}/read`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: NOTIFICATIONS_QUERY_KEY });
    },
  });
}

export function useMarkAllRead() {
  const queryClient = useQueryClient();
  return useMutation<void, unknown, void>({
    mutationFn: () => api.post<void>('/notifications/read-all'),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: NOTIFICATIONS_QUERY_KEY });
    },
  });
}
