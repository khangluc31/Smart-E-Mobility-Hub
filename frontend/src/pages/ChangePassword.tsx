// Change password page (CONTRACTS §2 POST /auth/change-password, UC-16 A2, T-09).
// Mounted at /app/change-password inside RequireAuth but outside StudentLayout so both
// students and operators see a clean neutral page with a "Back" link to "/".

import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, KeyRound, LogOut } from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import { useChangePassword } from '@/hooks/useChangePassword';
import { ApiError } from '@/lib/api';
import { ErrorBox } from '@/components/common/ErrorBox';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

const HAS_LETTER = /[A-Za-z]/;
const HAS_DIGIT = /\d/;

export function ChangePassword() {
  const { user, logout, clearMustChangePassword } = useAuth();
  const navigate = useNavigate();
  const mutation = useChangePassword();

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [validationError, setValidationError] = useState<unknown>(null);
  const [succeeded, setSucceeded] = useState(false);

  const error = validationError ?? (mutation.isError ? mutation.error : null);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setValidationError(null);
    setSucceeded(false);

    if (!currentPassword) {
      setValidationError(
        new ApiError({
          status: 400,
          code: 'VALIDATION_ERROR',
          message: 'Current password is required.',
          nextActions: ['Enter your current password and try again.'],
          details: { field: 'currentPassword' },
        }),
      );
      return;
    }

    if (newPassword.length < 8 || !HAS_LETTER.test(newPassword) || !HAS_DIGIT.test(newPassword)) {
      setValidationError(
        new ApiError({
          status: 400,
          code: 'VALIDATION_ERROR',
          message: 'New password must be at least 8 characters and contain both a letter and a digit.',
          nextActions: ['Choose a password with at least 8 characters, including a letter and a number.'],
          details: { field: 'newPassword' },
        }),
      );
      return;
    }

    if (newPassword === currentPassword) {
      setValidationError(
        new ApiError({
          status: 400,
          code: 'VALIDATION_ERROR',
          message: 'New password must be different from the current password.',
          nextActions: ['Choose a new password that you are not currently using.'],
          details: { field: 'newPassword' },
        }),
      );
      return;
    }

    const wasForced = Boolean(user?.mustChangePassword);
    try {
      await mutation.mutateAsync({ currentPassword, newPassword });
      clearMustChangePassword();
      setCurrentPassword('');
      setNewPassword('');
      setSucceeded(true);
      if (wasForced) {
        navigate('/', { replace: true });
      }
    } catch {
      // Error is captured on mutation.error and rendered by ErrorBox.
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-3">
      <Card className="w-full max-w-sm">
        <CardHeader className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            {!user?.mustChangePassword ? (
              <Button asChild variant="ghost" size="sm" className="-ml-2">
                <Link to="/">
                  <ArrowLeft className="h-3.5 w-3.5" />
                  <span>Back</span>
                </Link>
              </Button>
            ) : (
              <Badge variant="destructive">Action required</Badge>
            )}
            <Button type="button" variant="outline" size="sm" onClick={logout}>
              <LogOut className="h-3.5 w-3.5" />
              <span>Logout</span>
            </Button>
          </div>
          <div className="flex items-center gap-2">
            <KeyRound className="h-5 w-5 text-muted-foreground" />
            <CardTitle className="text-xl">Change password</CardTitle>
          </div>
          <p className="text-xs text-muted-foreground">
            {user?.mustChangePassword
              ? 'You must change your password before continuing.'
              : `Signed in as ${user?.displayName ?? user?.identifier ?? ''}`}
          </p>
        </CardHeader>

        <CardContent className="space-y-4">
          {Boolean(error) && <ErrorBox error={error} title="Password change failed" />}

          {succeeded && (
            <div
              role="status"
              className="rounded-md border border-emerald-500/40 bg-emerald-500/10 p-3 text-xs text-emerald-800 dark:text-emerald-200 space-y-2"
            >
              <p className="font-medium">Your password has been updated.</p>
              <Button asChild variant="outline" size="sm" className="w-full">
                <Link to="/">Return to home</Link>
              </Button>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-3" noValidate>
            <div className="space-y-1.5">
              <Label htmlFor="current-password">Current password</Label>
              <Input
                id="current-password"
                name="currentPassword"
                type="password"
                autoComplete="current-password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                required
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="new-password">New password (≥ 8 chars, letter + digit)</Label>
              <Input
                id="new-password"
                name="newPassword"
                type="password"
                autoComplete="new-password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                required
              />
            </div>

            <Button type="submit" className="w-full" disabled={mutation.isPending}>
              {mutation.isPending ? 'Updating password…' : 'Update password'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
