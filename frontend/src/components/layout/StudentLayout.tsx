// Mobile-first layout for student / private EV owner screens (ARCHITECTURE §13, NFR-28 360px).

import { Link, NavLink, Outlet } from 'react-router-dom';
import { KeyRound, LogOut, Shield } from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import { useHealth } from '@/hooks/useHealth';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

const NAV_ITEMS = [
  { to: '/app/hubs', label: 'Hubs' },
  { to: '/app/vehicles', label: 'Vehicles' },
  { to: '/app/reservations', label: 'Reservations' },
  { to: '/app/parking', label: 'Parking' },
  { to: '/app/charging', label: 'Charging' },
  { to: '/app/my-vehicles', label: 'My vehicles' },
] as const;

export function StudentLayout() {
  const { user, logout } = useAuth();
  const { data: health, isError: healthError } = useHealth();
  const backendOk = !healthError && health?.status === 'ok';

  return (
    <div className="min-h-screen flex flex-col bg-background text-foreground overflow-x-hidden">
      <header className="border-b bg-card">
        <div className="mx-auto max-w-5xl px-3 py-2.5 flex flex-wrap items-center justify-between gap-2">
          <Link to="/app/hubs" className="font-semibold text-base tracking-tight">
            Smart E-Mobility Hub
          </Link>

          <div className="flex flex-wrap items-center gap-2">
            {user?.role === 'OPERATOR' && (
              <Button asChild variant="outline" size="sm">
                <Link to="/ops">
                  <Shield className="h-3.5 w-3.5" />
                  <span>Ops</span>
                </Link>
              </Button>
            )}
            {user && (
              <span className="text-xs text-muted-foreground truncate max-w-[140px]">
                {user.displayName}
              </span>
            )}
            <Button asChild variant="outline" size="sm">
              <Link to="/app/change-password">
                <KeyRound className="h-3.5 w-3.5" />
                <span>Change password</span>
              </Link>
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={logout}>
              <LogOut className="h-3.5 w-3.5" />
              <span>Logout</span>
            </Button>
          </div>
        </div>

        <nav
          aria-label="Student navigation"
          className="mx-auto max-w-5xl px-3 pb-2 flex flex-wrap gap-1.5"
        >
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                cn(
                  'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
                  isActive
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-secondary text-secondary-foreground hover:bg-secondary/80',
                )
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
      </header>

      <main className="mx-auto w-full max-w-5xl flex-1 px-3 py-4">
        <Outlet />
      </main>

      <footer className="border-t bg-card">
        <div className="mx-auto max-w-5xl px-3 py-2 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>VNU-HCM Smart E-Mobility Hub</span>
          <div className="flex items-center gap-1.5">
            <span>Backend:</span>
            <Badge variant={healthError ? 'destructive' : backendOk ? 'secondary' : 'outline'}>
              {healthError ? 'unreachable' : backendOk ? 'ok' : 'checking…'}
            </Badge>
          </div>
        </div>
      </footer>
    </div>
  );
}
