// Auth DTOs (CONTRACTS §1 / §2).
// No imports except ./enums so the file can be copied byte-for-byte to the frontend.

import type { Role } from './enums';

export interface User {
  id: string;
  identifier: string;
  displayName: string;
  role: Role;
  mustChangePassword: boolean;
}

export interface AuthResponse {
  token: string;
  user: User;
}

