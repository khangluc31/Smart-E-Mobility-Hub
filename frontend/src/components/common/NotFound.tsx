// Unknown route fallback card (T-05).

import { Link } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

export function NotFound() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Page not found</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            The page you requested does not exist. Check the address or return to the home screen.
          </p>
          <Button asChild>
            <Link to="/">Go to home</Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
