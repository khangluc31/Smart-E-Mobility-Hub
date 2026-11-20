import { useQuery } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

// replaced by lib/api.ts in T-05
const API_URL = import.meta.env.VITE_API_URL ?? '/api';

interface HealthResponse {
  status: string;
  db: string;
  jobsEnabled: boolean;
  serverNow: string;
}

function App() {
  const { data, isError } = useQuery<HealthResponse>({
    queryKey: ['health'],
    queryFn: async () => {
      const res = await fetch(`${API_URL}/health`);
      if (!res.ok) throw new Error('Backend unreachable');
      return res.json() as Promise<HealthResponse>;
    },
    refetchInterval: 5000,
  });

  const isOk = data?.status === 'ok';

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Smart E-Mobility Hub</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">Backend:</span>
            <Badge variant={isError ? 'destructive' : isOk ? 'secondary' : 'outline'}>
              {isError ? 'unreachable' : isOk ? 'ok' : 'loading…'}
            </Badge>
          </div>
          {data && (
            <p className="text-xs text-muted-foreground mt-2">Server time: {data.serverNow}</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export default App;
