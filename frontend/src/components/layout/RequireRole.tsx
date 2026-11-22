// Role guard for operator-only routes (FR-61, BR-12, AC-2).
// Never renders a blank page: wrong role sees a "Not allowed" card with a link home.

import { Link, Outlet } from 'react-router-dom';
import { ShieldAlert } from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import type { Role } from '@/types/enums';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';

export function RequireRole({ role }: { role: Role }) {
  const { user, isLoading } = useAuth();

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4" aria-busy="true">
        <Skeleton className="h-32 w-full max-w-md" />
      </div>
    );
  }

  if (!user || user.role !== role) {
    const homePath = user?.role === 'OPERATOR' ? '/ops' : '/app/hubs';
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-4">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-destructive">
              <ShieldAlert className="h-5 w-5 shrink-0" />
              Not allowed
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              This section requires the <strong>{role}</strong> role. Your account does not have
              permission to view it.
            </p>
            <Button asChild variant="default">
              <Link to={homePath}>Back to home</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return <Outlet />;
}
