// Registration page (CONTRACTS §2 POST /auth/register, FR-29, FR-60, AC-8).

import { useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';
import { ApiError } from '@/lib/api';
import { ErrorBox } from '@/components/common/ErrorBox';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';

const HAS_LETTER = /[A-Za-z]/;
const HAS_DIGIT = /\d/;

export function Register() {
  const { user, register } = useAuth();
  const navigate = useNavigate();

  const [identifier, setIdentifier] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState(false);

  if (user) {
    return <Navigate to={user.role === 'OPERATOR' ? '/ops' : '/app/hubs'} replace />;
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);

    const trimmedId = identifier.trim();
    const trimmedName = displayName.trim();

    if (trimmedId.length < 3 || trimmedId.length > 64) {
      setError(
        new ApiError({
          status: 400,
          code: 'VALIDATION_ERROR',
          message: 'Identifier must be between 3 and 64 characters.',
          nextActions: ['Choose an identifier with 3–64 characters.'],
          details: { field: 'identifier' },
        }),
      );
      return;
    }

    if (!trimmedName) {
      setError(
        new ApiError({
          status: 400,
          code: 'VALIDATION_ERROR',
          message: 'Display name is required.',
          nextActions: ['Enter your full name or display name.'],
          details: { field: 'displayName' },
        }),
      );
      return;
    }

    if (password.length < 8 || !HAS_LETTER.test(password) || !HAS_DIGIT.test(password)) {
      setError(
        new ApiError({
          status: 400,
          code: 'VALIDATION_ERROR',
          message: 'Password must be at least 8 characters and contain both a letter and a digit.',
          nextActions: ['Update your password to meet the requirements.'],
          details: { field: 'password' },
        }),
      );
      return;
    }

    setPending(true);
    try {
      const created = await register(trimmedId, password, trimmedName);
      navigate(created.role === 'OPERATOR' ? '/ops' : '/app/hubs', { replace: true });
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
          <CardTitle className="text-xl">Create student account</CardTitle>
          <p className="text-xs text-muted-foreground">
            Register to reserve vehicles, parking and charging
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          {Boolean(error) && <ErrorBox error={error} title="Registration failed" />}

          <form onSubmit={handleSubmit} className="space-y-3" noValidate>
            <div className="space-y-1.5">
              <Label htmlFor="register-identifier">Identifier (3–64 chars)</Label>
              <Input
                id="register-identifier"
                name="identifier"
                type="text"
                autoComplete="username"
                placeholder="student-id or email"
                value={identifier}
                onChange={(e) => setIdentifier(e.target.value)}
                required
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="register-display-name">Display name</Label>
              <Input
                id="register-display-name"
                name="displayName"
                type="text"
                autoComplete="name"
                placeholder="Nguyen Van A"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                required
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="register-password">Password (≥ 8 chars, letter + digit)</Label>
              <Input
                id="register-password"
                name="password"
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>

            <Button type="submit" className="w-full" disabled={pending}>
              {pending ? 'Creating account…' : 'Create account'}
            </Button>
          </form>

          <p className="text-xs text-center text-muted-foreground">
            Already have an account?{' '}
            <Link to="/login" className="font-medium text-foreground underline">
              Sign in
            </Link>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
