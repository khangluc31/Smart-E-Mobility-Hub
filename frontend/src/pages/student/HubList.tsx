// Student Hub list page (FR-01, FR-03, D-01 5s poll, NFR-28 360px).
// Reference example of page -> hook -> api.ts -> typed DTO.

import { Link, useNavigate } from 'react-router-dom';
import { MapPin, Zap } from 'lucide-react';
import { useHubs } from '@/hooks/useHubs';
import { VEHICLE_CLASSES, type VehicleClass } from '@/types/enums';
import type { HubSummary } from '@/types/hubs';
import { CampusMap } from '@/components/common/CampusMap';
import { VehicleIcon } from '@/components/common/VehicleIcon';
import { HubStatusChips } from '@/components/common/HubStatusChips';
import { ErrorBox } from '@/components/common/ErrorBox';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Separator } from '@/components/ui/separator';
import { Button } from '@/components/ui/button';

const CLASS_LABEL: Record<VehicleClass, string> = {
  MOTORCYCLE: 'Motorcycle',
  CAR: 'Car',
};

function HubCard({ hub, hubNamesById }: { hub: HubSummary; hubNamesById: Map<string, string> }) {
  const redirectName = hub.redirectToHubId
    ? (hubNamesById.get(hub.redirectToHubId) ?? hub.redirectToHubId)
    : null;

  return (
    <Card className="flex flex-col justify-between">
      <CardHeader className="space-y-2 pb-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <CardTitle className="text-base">
              <Link
                to={`/app/hubs/${hub.id}`}
                className="hover:underline focus:underline outline-none"
              >
                {hub.name}
              </Link>
            </CardTitle>
            <p className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
              <MapPin className="h-3 w-3 shrink-0" />
              <span className="truncate">{hub.location}</span>
            </p>
          </div>
          <Button asChild variant="outline" size="sm" className="shrink-0">
            <Link to={`/app/hubs/${hub.id}`}>View details</Link>
          </Button>
        </div>

        <HubStatusChips
          degraded={hub.degraded}
          lastTelemetryAt={hub.lastTelemetryAt}
          nearCapacity={hub.nearCapacity}
          redirectToHubId={hub.redirectToHubId}
          redirectToHubName={redirectName}
        />
      </CardHeader>

      <CardContent className="space-y-3 text-xs">
        <div className="flex items-center justify-between rounded-md bg-secondary/60 px-2.5 py-2">
          <span className="font-medium">Available rental vehicles</span>
          <span className="text-sm font-bold tabular-nums">{hub.availableRentalVehicles}</span>
        </div>

        <Separator />

        <div className="space-y-1.5">
          <p className="font-semibold text-muted-foreground uppercase tracking-wider text-[11px]">
            Parking spaces (all pools / public reservable)
          </p>
          {VEHICLE_CLASSES.map((vc) => {
            const allPools = hub.parking[vc];
            const pub = hub.publicParking[vc];
            return (
              <div
                key={`parking-${vc}`}
                className="flex flex-wrap items-center justify-between gap-1 rounded border px-2 py-1.5"
              >
                <div className="flex items-center gap-1.5 font-medium">
                  <VehicleIcon type={vc} size="sm" className="text-muted-foreground" />
                  <span>{CLASS_LABEL[vc]}</span>
                </div>
                <div className="text-right tabular-nums space-x-2">
                  <span>
                    All: <strong>{allPools.free}</strong>/{allPools.total} ({allPools.utilPct}% util)
                  </span>
                  <span className="text-muted-foreground">|</span>
                  <span>
                    Public: <strong>{pub.free}</strong>/{pub.total} ({pub.utilPct}% util)
                  </span>
                </div>
              </div>
            );
          })}
        </div>

        <div className="space-y-1.5">
          <p className="font-semibold text-muted-foreground uppercase tracking-wider text-[11px] flex items-center gap-1">
            <Zap className="h-3 w-3" />
            <span>Charging points</span>
          </p>
          {VEHICLE_CLASSES.map((vc) => {
            const chg = hub.charging[vc];
            return (
              <div
                key={`charging-${vc}`}
                className="flex flex-wrap items-center justify-between gap-1 rounded border px-2 py-1.5"
              >
                <div className="flex items-center gap-1.5 font-medium">
                  <VehicleIcon type={vc} size="sm" className="text-muted-foreground" />
                  <span>{CLASS_LABEL[vc]}</span>
                </div>
                <div className="tabular-nums">
                  <strong>{chg.free}</strong>/{chg.total} free ({chg.utilPct}% util)
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

export function HubList() {
  const navigate = useNavigate();
  const { data: hubs, isLoading, error } = useHubs();

  const hubNamesById = new Map<string, string>();
  if (hubs) {
    for (const h of hubs) {
      hubNamesById.set(h.id, h.name);
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-bold tracking-tight">Mobility Hubs</h1>
        <p className="text-xs text-muted-foreground">
          Live availability across all Hubs
        </p>
      </div>

      {Boolean(error) && <ErrorBox error={error} title="Could not load Hubs" />}

      {isLoading && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4" aria-busy="true">
          {[1, 2, 3, 4, 5].map((n) => (
            <Card key={n}>
              <CardHeader className="space-y-2">
                <Skeleton className="h-5 w-40" />
                <Skeleton className="h-4 w-28" />
              </CardHeader>
              <CardContent className="space-y-2">
                <Skeleton className="h-8 w-full" />
                <Skeleton className="h-16 w-full" />
                <Skeleton className="h-14 w-full" />
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {!isLoading && !error && hubs && hubs.length === 0 && (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            No Hubs yet. Run the database seed to populate the 5 Mobility Hubs.
          </CardContent>
        </Card>
      )}

      {!isLoading && hubs && hubs.length > 0 && (
        <>
          <CampusMap
            hubs={hubs.map((hub) => ({
              id: hub.id,
              name: hub.name,
              degraded: hub.degraded,
              nearCapacity: hub.nearCapacity,
              availableVehicles: hub.availableRentalVehicles,
              redirectToHubId: hub.redirectToHubId,
            }))}
            onSelectHub={(id) => navigate(`/app/hubs/${id}`)}
          />

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {hubs.map((hub) => (
              <HubCard key={hub.id} hub={hub} hubNamesById={hubNamesById} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
