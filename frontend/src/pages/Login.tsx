// Login page (CONTRACTS §2 POST /auth/login, AC-1, AC-8, AC-9).

import { useState, type FormEvent } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';
import { ApiError } from '@/lib/api';
import { ErrorBox } from '@/components/common/ErrorBox';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';

interface LocationState {
  from?: { pathname?: string };
}

export function Login() {
  const { user, login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const state = location.state as LocationState | null;
  const fromPath = state?.from?.pathname;

  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState(false);

  if (user) {
    const dest = fromPath ?? (user.role === 'OPERATOR' ? '/ops' : '/app/hubs');
    return <Navigate to={dest} replace />;
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);

    const trimmedId = identifier.trim();
    if (trimmedId.length < 3 || trimmedId.length > 64) {
      setError(
        new ApiError({
          status: 400,
          code: 'VALIDATION_ERROR',
          message: 'Identifier must be between 3 and 64 characters.',
          nextActions: ['Enter your student ID or email and try again.'],
          details: { field: 'identifier' },
        }),
      );
      return;
    }

    if (!password) {
      setError(
        new ApiError({
          status: 400,
          code: 'VALIDATION_ERROR',
          message: 'Password is required.',
          nextActions: ['Enter your password and try again.'],
          details: { field: 'password' },
        }),
      );
      return;
    }

    setPending(true);
    try {
      const loggedInUser = await login(trimmedId, password);
      const dest = fromPath ?? (loggedInUser.role === 'OPERATOR' ? '/ops' : '/app/hubs');
      navigate(dest, { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-3">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-xl">Sign in</CardTitle>
          <p className="text-xs text-muted-foreground">
            Smart E-Mobility Hub — VNU-HCM Urban Area
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          {Boolean(error) && <ErrorBox error={error} title="Sign-in failed" />}

          <form onSubmit={handleSubmit} className="space-y-3" noValidate>
            <div className="space-y-1.5">
              <Label htmlFor="login-identifier">Identifier</Label>
              <Input
                id="login-identifier"
                name="identifier"
                type="text"
                autoComplete="username"
                placeholder="student1 or email"
                value={identifier}
                onChange={(e) => setIdentifier(e.target.value)}
                required
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="login-password">Password</Label>
              <Input
                id="login-password"
                name="password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>

            <Button type="submit" className="w-full" disabled={pending}>
              {pending ? 'Signing in…' : 'Sign in'}
            </Button>
          </form>

          <p className="text-xs text-center text-muted-foreground">
            Need a student account?{' '}
            <Link to="/register" className="font-medium text-foreground underline">
              Create one
            </Link>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
