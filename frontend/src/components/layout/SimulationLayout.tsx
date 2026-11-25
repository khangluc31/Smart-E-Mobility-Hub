// Operator Sandbox Workspace layout for What-if Simulation (/sim/*, D-24, BR-11, FR-61).

import { Link, NavLink, Outlet } from 'react-router-dom';
import { Activity, FlaskConical, KeyRound, LogOut, ShieldAlert } from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import { useHealth } from '@/hooks/useHealth';
import { NotificationBell } from '@/components/common/NotificationBell';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

const SIM_NAV_ITEMS = [
  { to: '/sim/scenarios', label: 'Scenarios', end: false },
  { to: '/sim/runs', label: 'Runs', end: false },
  { to: '/sim/compare', label: 'Compare', end: false },
  { to: '/sim/recommendations', label: 'Recommendations', end: false },
] as const;

export function SimulationLayout() {
  const { user, logout } = useAuth();
  const { data: health, isError: healthError } = useHealth();
  const backendOk = !healthError && health?.status === 'ok';

  return (
    <div className="min-h-screen flex flex-col md:flex-row bg-background text-foreground">
      <aside className="w-full md:w-60 shrink-0 border-b md:border-b-0 md:border-r bg-amber-50/40 dark:bg-amber-950/10 flex flex-col justify-between">
        <div className="p-4 space-y-4">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <Link to="/sim/scenarios" className="font-semibold text-base tracking-tight block">
                What-if Simulation
              </Link>
              {user && (
                <p className="text-xs text-muted-foreground mt-0.5 truncate">
                  Operator: {user.displayName}
                </p>
              )}
            </div>
            <Badge
              variant="outline"
              className="border-amber-400 bg-amber-100 text-amber-900 text-[10px] uppercase tracking-wider shrink-0"
            >
              Sandbox
            </Badge>
          </div>

          <div
            role="navigation"
            aria-label="Workspace switch"
            className="grid grid-cols-2 gap-1 rounded-md border bg-muted/50 p-1"
          >
            <Link
              to="/ops"
              className="inline-flex items-center justify-center gap-1.5 rounded px-2 py-1.5 text-xs font-medium text-muted-foreground hover:bg-background hover:text-foreground transition-colors"
            >
              <Activity className="h-3.5 w-3.5 shrink-0" />
              <span>Operations</span>
            </Link>
            <Link
              to="/sim"
              aria-current="page"
              className="inline-flex items-center justify-center gap-1.5 rounded px-2 py-1.5 text-xs font-medium bg-amber-600 text-white shadow-xs"
            >
              <FlaskConical className="h-3.5 w-3.5 shrink-0" />
              <span>Simulation</span>
            </Link>
          </div>

          <nav aria-label="Simulation navigation" className="flex flex-wrap md:flex-col gap-1">
            {SIM_NAV_ITEMS.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  cn(
                    'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                    isActive
                      ? 'bg-amber-600 text-white'
                      : 'text-foreground hover:bg-amber-100/70 dark:hover:bg-amber-900/30',
                  )
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>
        </div>

        <div className="p-4 border-t space-y-2">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span>Backend:</span>
              <Badge variant={healthError ? 'destructive' : backendOk ? 'secondary' : 'outline'}>
                {healthError ? 'unreachable' : backendOk ? 'ok' : 'checking…'}
              </Badge>
            </div>
            <NotificationBell />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="outline" size="sm" className="flex-1">
              <Link to="/ops">
                <Activity className="h-3.5 w-3.5" />
                <span>Operations</span>
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

      <div className="flex-1 flex flex-col min-w-0">
        {/* BR-11 / D-24: Persistent sandbox isolation banner across every /sim/* screen */}
        <div
          role="status"
          className="border-b border-amber-300 bg-amber-50 px-4 py-2.5 text-xs md:text-sm text-amber-950 flex items-center gap-2"
        >
          <ShieldAlert className="h-4 w-4 shrink-0 text-amber-700" />
          <p className="font-medium">
            Sandbox — simulations run on a read-only snapshot; live data is not changed until you
            explicitly confirm and apply a recommendation.
          </p>
        </div>

        <main className="flex-1 p-4 md:p-6 overflow-x-hidden">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
