// Student Hub detail page (FR-02, FR-03, D-01 5s poll, D-18 charging flag, NFR-28 360px).

import { Link, useParams } from 'react-router-dom';
import { AlertTriangle, ArrowLeft, MapPin, Zap } from 'lucide-react';
import { useHub, useHubs } from '@/hooks/useHubs';
import {
  PARKING_POOLS,
  VEHICLE_CLASSES,
  type ParkingPool,
  type RentalVehicleType,
  type VehicleClass,
} from '@/types/enums';
import { StatusBadge } from '@/components/common/StatusBadge';
import { BatteryBar } from '@/components/common/BatteryBar';
import { ErrorBox } from '@/components/common/ErrorBox';
import { HubStatusChips, formatRelativeTime } from '@/components/common/HubStatusChips';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';

const CLASS_LABEL: Record<VehicleClass, string> = {
  MOTORCYCLE: 'Motorcycle',
  CAR: 'Car',
};

const POOL_LABEL: Record<ParkingPool, string> = {
  FLEET: 'Fleet pool',
  PUBLIC: 'Public pool',
};

const VEHICLE_TYPE_LABEL: Record<RentalVehicleType, string> = {
  E_BICYCLE: 'E-Bicycle',
  E_MOTORCYCLE: 'E-Motorcycle',
};

export function HubDetail() {
  const { hubId } = useParams<{ hubId: string }>();
  const { data: hub, isLoading, error } = useHub(hubId);
  const { data: allHubs } = useHubs();

  const redirectName =
    hub?.redirectToHubId && allHubs
      ? (allHubs.find((h) => h.id === hub.redirectToHubId)?.name ?? hub.redirectToHubId)
      : hub?.redirectToHubId;

  return (
    <div className="space-y-4">
      <div>
        <Button asChild variant="outline" size="sm">
          <Link to="/app/hubs">
            <ArrowLeft className="h-3.5 w-3.5" />
            <span>Back to Hubs</span>
          </Link>
        </Button>
      </div>

      {Boolean(error) && <ErrorBox error={error} title="Could not load Hub" />}

      {isLoading && (
        <div className="space-y-4" aria-busy="true">
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      )}

      {hub && (
        <>
          {hub.degraded && (
            <Alert className="border-amber-400 bg-amber-50 text-amber-900">
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>Telemetry feed delayed</AlertTitle>
              <AlertDescription className="text-xs">
                Last telemetry packet arrived {formatRelativeTime(hub.lastTelemetryAt)}. Resource
                counts and battery numbers below may be out of date (FR-03).
              </AlertDescription>
            </Alert>
          )}

          <Card>
            <CardHeader className="space-y-2 pb-3">
              <div>
                <CardTitle className="text-lg">{hub.name}</CardTitle>
                <p className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
                  <MapPin className="h-3 w-3 shrink-0" />
                  <span>{hub.location}</span>
                </p>
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
              <div className="flex items-center justify-between rounded-md bg-secondary/60 px-3 py-2">
                <span className="font-medium">Available rental vehicles</span>
                <span className="text-base font-bold tabular-nums">
                  {hub.availableRentalVehicles}
                </span>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {VEHICLE_CLASSES.map((vc) => {
                  const allP = hub.parking[vc];
                  const pubP = hub.publicParking[vc];
                  const chg = hub.charging[vc];
                  return (
                    <div key={vc} className="rounded-md border p-2.5 space-y-1">
                      <p className="font-semibold">{CLASS_LABEL[vc]}</p>
                      <p className="tabular-nums">
                        Parking (all): <strong>{allP.free}</strong>/{allP.total} free (
                        {allP.utilPct}% util)
                      </p>
                      <p className="tabular-nums">
                        Public parking: <strong>{pubP.free}</strong>/{pubP.total} free (
                        {pubP.utilPct}% util)
                      </p>
                      <p className="tabular-nums">
                        Charging: <strong>{chg.free}</strong>/{chg.total} free ({chg.utilPct}% util)
                      </p>
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>

          {/* Section 1: Rental vehicles */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">
                Rental vehicles ({hub.vehicles.length})
              </CardTitle>
            </CardHeader>
            <CardContent>
              {hub.vehicles.length === 0 ? (
                <p className="text-xs text-muted-foreground">No rental vehicles at this Hub.</p>
              ) : (
                <ul className="divide-y">
                  {hub.vehicles.map((v) => (
                    <li
                      key={v.id}
                      className="py-2.5 flex flex-wrap items-center justify-between gap-2 text-xs"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="font-mono font-semibold">{v.id}</span>
                        <span className="text-muted-foreground">{VEHICLE_TYPE_LABEL[v.type]}</span>
                      </div>

                      <div className="flex flex-wrap items-center gap-2">
                        <BatteryBar pct={v.batteryPct} />
                        <StatusBadge kind="rentalVehicle" value={v.status} />
                        {v.charging && (
                          <Badge
                            variant="outline"
                            className="border-sky-300 bg-sky-50 text-sky-800 inline-flex items-center gap-1"
                          >
                            <Zap className="h-3 w-3" />
                            <span>Charging</span>
                          </Badge>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          {/* Section 2: Parking spaces grouped by pool -> class */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">
                Parking spaces ({hub.parkingSpaces.length})
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {PARKING_POOLS.map((pool) => (
                <div key={pool} className="space-y-2">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    {POOL_LABEL[pool]}
                  </h3>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {VEHICLE_CLASSES.map((vc) => {
                      const spaces = hub.parkingSpaces.filter(
                        (s) => s.pool === pool && s.vehicleClass === vc,
                      );
                      return (
                        <div key={`${pool}-${vc}`} className="rounded-md border p-2.5 space-y-2">
                          <p className="text-xs font-medium">
                            {CLASS_LABEL[vc]} ({spaces.length})
                          </p>
                          {spaces.length === 0 ? (
                            <p className="text-xs text-muted-foreground">None</p>
                          ) : (
                            <ul className="divide-y text-xs">
                              {spaces.map((s) => (
                                <li
                                  key={s.id}
                                  className="py-1.5 flex items-center justify-between gap-2"
                                >
                                  <span className="font-mono">{s.id}</span>
                                  <StatusBadge kind="parkingSpace" value={s.status} />
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>

          {/* Section 3: Charging points by class */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">
                Charging points ({hub.chargingPoints.length})
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {VEHICLE_CLASSES.map((vc) => {
                  const points = hub.chargingPoints.filter((p) => p.vehicleClass === vc);
                  return (
                    <div key={vc} className="rounded-md border p-2.5 space-y-2">
                      <p className="text-xs font-medium">
                        {CLASS_LABEL[vc]} ({points.length})
                      </p>
                      {points.length === 0 ? (
                        <p className="text-xs text-muted-foreground">None</p>
                      ) : (
                        <ul className="divide-y text-xs">
                          {points.map((pt) => (
                            <li
                              key={pt.id}
                              className="py-1.5 flex items-center justify-between gap-2"
                            >
                              <span className="font-mono">{pt.id}</span>
                              <StatusBadge kind="chargingPoint" value={pt.status} />
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
