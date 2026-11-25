// Desktop-first sidebar layout for Operator screens (ARCHITECTURE §13, FR-61, D-24).

import { Link, NavLink, Outlet } from 'react-router-dom';
import { Activity, FlaskConical, KeyRound, LogOut, MapPin } from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import { useHealth } from '@/hooks/useHealth';
import { NotificationBell } from '@/components/common/NotificationBell';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

const OPS_NAV_ITEMS = [
  { to: '/ops', label: 'Dashboard', end: true },
  { to: '/ops/alerts', label: 'Alerts', end: false },
  { to: '/ops/incidents', label: 'Incidents', end: false },
  { to: '/ops/charging', label: 'Charging queue', end: false },
  { to: '/ops/redistribution', label: 'Redistribution', end: false },
  { to: '/ops/demo', label: 'Demo controls', end: false },
] as const;

export function OperatorLayout() {
  const { user, logout } = useAuth();
  const { data: health, isError: healthError } = useHealth();
  const backendOk = !healthError && health?.status === 'ok';

  return (
    <div className="min-h-screen flex flex-col md:flex-row bg-background text-foreground">
      <aside className="w-full md:w-60 shrink-0 border-b md:border-b-0 md:border-r bg-card flex flex-col justify-between">
        <div className="p-4 space-y-4">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <Link to="/ops" className="font-semibold text-base tracking-tight block">
                E-Mobility Operations
              </Link>
              {user && (
                <p className="text-xs text-muted-foreground mt-0.5 truncate">
                  Operator: {user.displayName}
                </p>
              )}
            </div>
            <NotificationBell />
          </div>

          <div
            role="navigation"
            aria-label="Workspace switch"
            className="grid grid-cols-2 gap-1 rounded-md border bg-muted/50 p-1"
          >
            <Link
              to="/ops"
              aria-current="page"
              className="inline-flex items-center justify-center gap-1.5 rounded px-2 py-1.5 text-xs font-medium bg-primary text-primary-foreground shadow-xs"
            >
              <Activity className="h-3.5 w-3.5 shrink-0" />
              <span>Operations</span>
            </Link>
            <Link
              to="/sim"
              className="inline-flex items-center justify-center gap-1.5 rounded px-2 py-1.5 text-xs font-medium text-muted-foreground hover:bg-background hover:text-foreground transition-colors"
            >
              <FlaskConical className="h-3.5 w-3.5 shrink-0" />
              <span>Simulation</span>
            </Link>
          </div>

          <nav aria-label="Operator navigation" className="flex flex-wrap md:flex-col gap-1">
            {OPS_NAV_ITEMS.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  cn(
                    'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                    isActive
                      ? 'bg-primary text-primary-foreground'
                      : 'text-foreground hover:bg-secondary',
                  )
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>
        </div>

        <div className="p-4 border-t space-y-2">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>Backend:</span>
            <Badge variant={healthError ? 'destructive' : backendOk ? 'secondary' : 'outline'}>
              {healthError ? 'unreachable' : backendOk ? 'ok' : 'checking…'}
            </Badge>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="outline" size="sm" className="flex-1">
              <Link to="/app/hubs">
                <MapPin className="h-3.5 w-3.5" />
                <span>Hubs view</span>
              </Link>
            </Button>
            <Button asChild variant="outline" size="sm" className="flex-1">
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
      </aside>

      <main className="flex-1 p-4 md:p-6 overflow-x-hidden">
        <Outlet />
      </main>
    </div>
  );
}
