// Mutation hook for POST /api/auth/change-password (CONTRACTS §2, UC-16 A2).

import { useMutation } from '@tanstack/react-query';
import { api } from '@/lib/api';

export interface ChangePasswordPayload {
  currentPassword: string;
  newPassword: string;
}

export function useChangePassword() {
  return useMutation<void, unknown, ChangePasswordPayload>({
    mutationFn: (payload) => api.post<void>('/auth/change-password', payload),
  });
}
