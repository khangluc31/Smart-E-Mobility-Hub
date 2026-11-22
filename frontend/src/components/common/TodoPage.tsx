// Placeholder page for routes owned by later tickets (T-05).

import { Construction } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

export interface TodoPageProps {
  title: string;
  area: string;
  owner: string;
  description?: string;
}

export function TodoPage({ title, area, owner, description }: TodoPageProps) {
  return (
    <div className="py-4">
      <Card className="max-w-xl">
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="flex items-center gap-2 text-lg">
              <Construction className="h-5 w-5 text-muted-foreground" />
              {title}
            </CardTitle>
            <Badge variant="secondary">Owner: {owner}</Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p className="font-medium text-foreground">
            Coming in {area} — owner {owner}
          </p>
          {description && <p>{description}</p>}
        </CardContent>
      </Card>
    </div>
  );
}
