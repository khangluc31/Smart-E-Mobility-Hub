// Adds the authenticated user to Express's Request (set by requireAuth).
import type { Role } from './enums';

declare global {
  namespace Express {
    interface Request {
      user?: { id: string; role: Role };
    }
  }
}

export {};
