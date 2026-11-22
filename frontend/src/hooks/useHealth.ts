// Health check hook using lib/api.ts (CONTRACTS §2).

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { POLL_INTERVAL_MS } from '@/lib/constants';

export interface HealthStatus {
  status: string;
  db: string;
  jobsEnabled: boolean;
  serverNow: string;
}

export function useHealth() {
  return useQuery<HealthStatus>({
    queryKey: ['health'],
    queryFn: () => api.get<HealthStatus>('/health', { skipAuthRedirect: true }),
    refetchInterval: POLL_INTERVAL_MS,
    retry: false,
  });
}
