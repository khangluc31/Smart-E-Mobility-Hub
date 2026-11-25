// Operator Network Dashboard + Hub Drill-down Dialog (CONTRACTS §10, FR-31, FR-32, BR-09, UC-19).

import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Activity,
  AlertTriangle,
  BatteryCharging,
  BellRing,
  Bike,
  Eye,
  Flag,
  Radio,
} from 'lucide-react';
import { useOpsDashboard, useOpsHubDetail } from '@/hooks/useMonitoring';
import { NEAR_CAPACITY_PCT } from '@/lib/constants';
import { StatusBadge } from '@/components/common/StatusBadge';
import { BatteryBar } from '@/components/common/BatteryBar';
import { ErrorBox } from '@/components/common/ErrorBox';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { DashboardHub, ResourceOccupant } from '@/types/monitoring';
import type { IncidentResourceType, RentalVehicleType, VehicleClass } from '@/types/enums';
import { cn } from '@/lib/utils';

function formatTimestamp(iso: string | null): string {
  if (!iso) return 'Never';
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return iso;
  return new Date(parsed).toLocaleString();
}

function formatVehicleType(type: RentalVehicleType): string {
  return type === 'E_BICYCLE' ? 'E-bicycle' : 'E-motorcycle';
}

function formatOccupiedBy(occ: ResourceOccupant | null): string {
  if (!occ) return '—';
  switch (occ.kind) {
    case 'rentalVehicle':
      return `Vehicle ${occ.id}`;
    case 'parkingReservation':
      return occ.userDisplayName
        ? `Reservation ${occ.id} (${occ.userDisplayName})`
        : `Reservation ${occ.id}`;
    case 'chargingRequest':
      return `Charging #${occ.id} (${occ.userDisplayName ?? 'Fleet'})`;
  }
}

function reportFaultUrl(params: {
  hubId: string;
  resourceType: IncidentResourceType;
  resourceId: string;
  vehicleClass: VehicleClass;
}): string {
  const qs = new URLSearchParams({
    report: '1',
    hubId: params.hubId,
    resourceType: params.resourceType,
    resourceId: params.resourceId,
    vehicleClass: params.vehicleClass,
  });
  return `/ops/incidents?${qs.toString()}`;
}

function UtilPill({ label, pct }: { label: string; pct: number }) {
  // BR-09: highlight near-capacity utilisation at or above NEAR_CAPACITY_PCT (85%).
  const nearCap = pct >= NEAR_CAPACITY_PCT;
  return (
    <div
      className={cn(
        'flex items-center justify-between rounded border px-2 py-1 text-xs',
        nearCap
          ? 'border-amber-400 bg-amber-50 text-amber-900 font-semibold'
          : 'border-border bg-muted/40 text-foreground',
      )}
    >
      <span>{label}</span>
      <span className="tabular-nums flex items-center gap-1">
        {pct}%
        {nearCap && (
          <Badge
            variant="outline"
            className="border-red-300 bg-red-50 text-red-800 px-1 py-0 text-[10px] leading-4"
          >
            Near cap
          </Badge>
        )}
      </span>
    </div>
  );
}

function HubCard({
  hub,
  onInspect,
}: {
  hub: DashboardHub;
  onInspect: (hubId: string) => void;
}) {
  const anyNearCap =
    hub.parkingUtilPct.MOTORCYCLE >= NEAR_CAPACITY_PCT ||
    hub.parkingUtilPct.CAR >= NEAR_CAPACITY_PCT ||
    hub.chargingUtilPct.MOTORCYCLE >= NEAR_CAPACITY_PCT ||
    hub.chargingUtilPct.CAR >= NEAR_CAPACITY_PCT;

  return (
    <Card className={cn(hub.degraded && 'border-red-300')}>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <CardTitle className="text-base flex flex-wrap items-center gap-2">
              <span className="truncate">{hub.name}</span>
              {hub.degraded && (
                <Badge variant="destructive" className="text-[11px]">
                  DEGRADED
                </Badge>
              )}
              {anyNearCap && !hub.degraded && (
                <Badge
                  variant="outline"
                  className="border-amber-400 bg-amber-50 text-amber-900 text-[11px]"
                >
                  ≥ {NEAR_CAPACITY_PCT}% util
                </Badge>
              )}
            </CardTitle>
            <CardDescription className="mt-1 flex items-center gap-1.5 text-xs">
              <Radio className="h-3.5 w-3.5 shrink-0" />
              <span>Last telemetry: {formatTimestamp(hub.lastTelemetryAt)}</span>
            </CardDescription>
          </div>
          <Button
            asChild
            variant={hub.openAlerts > 0 ? 'destructive' : 'outline'}
            size="sm"
            className="shrink-0"
          >
            <Link to={`/ops/alerts?hubId=${encodeURIComponent(hub.hubId)}`}>
              <BellRing className="h-3.5 w-3.5" />
              <span>{hub.openAlerts} open</span>
            </Link>
          </Button>
        </div>
      </CardHeader>

      <CardContent className="space-y-3 text-sm">
        <div className="grid grid-cols-3 gap-2 text-center">
          <div className="rounded border bg-muted/30 p-2">
            <div className="text-[11px] text-muted-foreground">Avail. vehicles</div>
            <div className="text-lg font-semibold tabular-nums">
              {hub.availableRentalVehicles.MOTORCYCLE}
            </div>
          </div>
          <div className="rounded border bg-muted/30 p-2">
            <div className="text-[11px] text-muted-foreground">Active rentals</div>
            <div className="text-lg font-semibold tabular-nums">{hub.activeRentals}</div>
          </div>
          <div className="rounded border bg-muted/30 p-2">
            <div className="text-[11px] text-muted-foreground">Queue (M / C)</div>
            <div className="text-lg font-semibold tabular-nums">
              {hub.queueDepth.MOTORCYCLE} / {hub.queueDepth.CAR}
            </div>
          </div>
        </div>

        <div className="space-y-1.5">
          <div className="text-xs font-medium text-muted-foreground">Parking utilisation</div>
          <div className="grid grid-cols-2 gap-1.5">
            <UtilPill label="Moto" pct={hub.parkingUtilPct.MOTORCYCLE} />
            <UtilPill label="Car" pct={hub.parkingUtilPct.CAR} />
          </div>
        </div>

        <div className="space-y-1.5">
          <div className="text-xs font-medium text-muted-foreground">Charging utilisation</div>
          <div className="grid grid-cols-2 gap-1.5">
            <UtilPill label="Moto" pct={hub.chargingUtilPct.MOTORCYCLE} />
            <UtilPill label="Car" pct={hub.chargingUtilPct.CAR} />
          </div>
        </div>

        <div className="pt-1 flex justify-end">
          <Button type="button" variant="secondary" size="sm" onClick={() => onInspect(hub.hubId)}>
            <Eye className="h-3.5 w-3.5" />
            <span>Inspect Hub</span>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function HubDrillDownDialog({
  hubId,
  onClose,
}: {
  hubId: string | null;
  onClose: () => void;
}) {
  const { data: detail, isLoading, error } = useOpsHubDetail(hubId);

  return (
    <Dialog open={Boolean(hubId)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-5xl max-h-[90vh] flex flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2">
            <span>{detail?.name ?? hubId ?? 'Hub detail'}</span>
            {detail?.degraded && <Badge variant="destructive">DEGRADED</Badge>}
          </DialogTitle>
          <DialogDescription>
            {detail ? (
              <span>
                {detail.location} · Last telemetry: {formatTimestamp(detail.lastTelemetryAt)}
              </span>
            ) : (
              <span>Loading Hub resources…</span>
            )}
          </DialogDescription>
        </DialogHeader>

        {error && <ErrorBox error={error} title="Failed to load Hub detail" />}

        {isLoading && (
          <div className="space-y-2 py-4">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-48 w-full" />
          </div>
        )}

        {detail && (
          <div className="flex-1 min-h-0 flex flex-col space-y-3 overflow-hidden">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
              <div className="rounded border bg-muted/30 p-2">
                <div className="text-muted-foreground">Available rental vehicles</div>
                <div className="text-base font-semibold tabular-nums">
                  {detail.availableRentalVehicles}
                </div>
              </div>
              <div className="rounded border bg-muted/30 p-2">
                <div className="text-muted-foreground">Fleet + Public parking free</div>
                <div className="text-base font-semibold tabular-nums">
                  M: {detail.parking.MOTORCYCLE.free}/{detail.parking.MOTORCYCLE.total} · C:{' '}
                  {detail.parking.CAR.free}/{detail.parking.CAR.total}
                </div>
              </div>
              <div className="rounded border bg-muted/30 p-2">
                <div className="text-muted-foreground">Charging points free</div>
                <div className="text-base font-semibold tabular-nums">
                  M: {detail.charging.MOTORCYCLE.free}/{detail.charging.MOTORCYCLE.total} · C:{' '}
                  {detail.charging.CAR.free}/{detail.charging.CAR.total}
                </div>
              </div>
              <div className="rounded border bg-muted/30 p-2">
                <div className="text-muted-foreground">Near capacity</div>
                <div className="text-base font-semibold">
                  {detail.nearCapacity ? (
                    <span className="text-amber-700">Yes (≥ {NEAR_CAPACITY_PCT}%)</span>
                  ) : (
                    'No'
                  )}
                </div>
              </div>
            </div>

            <Tabs defaultValue="vehicles" className="flex-1 min-h-0 flex flex-col">
              <TabsList className="w-fit">
                <TabsTrigger value="vehicles">Vehicles ({detail.vehicles.length})</TabsTrigger>
                <TabsTrigger value="parking">
                  Parking spaces ({detail.parkingSpaces.length})
                </TabsTrigger>
                <TabsTrigger value="charging">
                  Charging points ({detail.chargingPoints.length})
                </TabsTrigger>
              </TabsList>

              <TabsContent value="vehicles" className="flex-1 min-h-0 overflow-auto border rounded-md mt-2">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-muted text-muted-foreground border-b">
                    <tr>
                      <th className="text-left p-2 font-medium">ID</th>
                      <th className="text-left p-2 font-medium">Type</th>
                      <th className="text-left p-2 font-medium">Status</th>
                      <th className="text-left p-2 font-medium">Battery</th>
                      <th className="text-left p-2 font-medium">Charging</th>
                      <th className="text-left p-2 font-medium">Occupied by</th>
                      <th className="text-right p-2 font-medium">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {detail.vehicles.map((v) => (
                      <tr key={v.id} className="hover:bg-muted/30">
                        <td className="p-2 font-mono">{v.id}</td>
                        <td className="p-2">{formatVehicleType(v.type)}</td>
                        <td className="p-2">
                          <StatusBadge kind="rentalVehicle" value={v.status} />
                        </td>
                        <td className="p-2">
                          <BatteryBar pct={v.batteryPct} />
                        </td>
                        <td className="p-2">
                          {v.charging ? (
                            <Badge variant="outline" className="border-sky-300 bg-sky-50 text-sky-800">
                              Charging
                            </Badge>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                        <td className="p-2">{formatOccupiedBy(v.occupiedBy)}</td>
                        <td className="p-2 text-right">
                          <Button asChild variant="ghost" size="sm" className="h-7 px-2 text-xs">
                            <Link
                              to={reportFaultUrl({
                                hubId: detail.id,
                                resourceType: 'RENTAL_VEHICLE',
                                resourceId: v.id,
                                vehicleClass: v.vehicleClass,
                              })}
                            >
                              <Flag className="h-3 w-3" />
                              <span>Report fault</span>
                            </Link>
                          </Button>
                        </td>
                      </tr>
                    ))}
                    {detail.vehicles.length === 0 && (
                      <tr>
                        <td colSpan={7} className="p-4 text-center text-muted-foreground">
                          No rental vehicles at this Hub.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </TabsContent>

              <TabsContent value="parking" className="flex-1 min-h-0 overflow-auto border rounded-md mt-2">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-muted text-muted-foreground border-b">
                    <tr>
                      <th className="text-left p-2 font-medium">ID</th>
                      <th className="text-left p-2 font-medium">Pool</th>
                      <th className="text-left p-2 font-medium">Class</th>
                      <th className="text-left p-2 font-medium">Status</th>
                      <th className="text-left p-2 font-medium">Occupied by</th>
                      <th className="text-right p-2 font-medium">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {detail.parkingSpaces.map((s) => (
                      <tr key={s.id} className="hover:bg-muted/30">
                        <td className="p-2 font-mono">{s.id}</td>
                        <td className="p-2">
                          <Badge variant="outline">{s.pool}</Badge>
                        </td>
                        <td className="p-2">{s.vehicleClass}</td>
                        <td className="p-2">
                          <StatusBadge kind="parkingSpace" value={s.status} />
                        </td>
                        <td className="p-2">{formatOccupiedBy(s.occupiedBy)}</td>
                        <td className="p-2 text-right">
                          <Button asChild variant="ghost" size="sm" className="h-7 px-2 text-xs">
                            <Link
                              to={reportFaultUrl({
                                hubId: detail.id,
                                resourceType: 'PARKING_SPACE',
                                resourceId: s.id,
                                vehicleClass: s.vehicleClass,
                              })}
                            >
                              <Flag className="h-3 w-3" />
                              <span>Report fault</span>
                            </Link>
                          </Button>
                        </td>
                      </tr>
                    ))}
                    {detail.parkingSpaces.length === 0 && (
                      <tr>
                        <td colSpan={6} className="p-4 text-center text-muted-foreground">
                          No parking spaces at this Hub.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </TabsContent>

              <TabsContent value="charging" className="flex-1 min-h-0 overflow-auto border rounded-md mt-2">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-muted text-muted-foreground border-b">
                    <tr>
                      <th className="text-left p-2 font-medium">ID</th>
                      <th className="text-left p-2 font-medium">Class</th>
                      <th className="text-left p-2 font-medium">Status</th>
                      <th className="text-left p-2 font-medium">Occupied by</th>
                      <th className="text-right p-2 font-medium">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {detail.chargingPoints.map((p) => (
                      <tr key={p.id} className="hover:bg-muted/30">
                        <td className="p-2 font-mono">{p.id}</td>
                        <td className="p-2">{p.vehicleClass}</td>
                        <td className="p-2">
                          <StatusBadge kind="chargingPoint" value={p.status} />
                        </td>
                        <td className="p-2">{formatOccupiedBy(p.occupiedBy)}</td>
                        <td className="p-2 text-right">
                          <Button asChild variant="ghost" size="sm" className="h-7 px-2 text-xs">
                            <Link
                              to={reportFaultUrl({
                                hubId: detail.id,
                                resourceType: 'CHARGING_POINT',
                                resourceId: p.id,
                                vehicleClass: p.vehicleClass,
                              })}
                            >
                              <Flag className="h-3 w-3" />
                              <span>Report fault</span>
                            </Link>
                          </Button>
                        </td>
                      </tr>
                    ))}
                    {detail.chargingPoints.length === 0 && (
                      <tr>
                        <td colSpan={5} className="p-4 text-center text-muted-foreground">
                          No charging points at this Hub.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </TabsContent>
            </Tabs>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function Dashboard() {
  const { data, isLoading, error } = useOpsDashboard();
  const [selectedHubId, setSelectedHubId] = useState<string | null>(null);

  const totalOpenAlerts = data
    ? data.hubs.reduce((sum, h) => sum + h.openAlerts, 0)
    : 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Operator Dashboard</h1>
          <p className="text-sm text-muted-foreground">
            Live network status across all Hubs (auto-refreshing every 5 s).
          </p>
        </div>
        {data?.serverNow && (
          <Badge variant="outline" className="font-mono text-xs">
            Server time: {formatTimestamp(data.serverNow)}
          </Badge>
        )}
      </div>

      {error && <ErrorBox error={error} title="Failed to load dashboard" />}

      {isLoading && (
        <div className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-4">
            <Skeleton className="h-64 w-full" />
            <Skeleton className="h-64 w-full" />
            <Skeleton className="h-64 w-full" />
          </div>
        </div>
      )}

      {data && (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <Card>
              <CardHeader className="pb-2 flex flex-row items-center justify-between space-y-0">
                <CardTitle className="text-xs font-medium text-muted-foreground">
                  Total Rental Vehicles
                </CardTitle>
                <Bike className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold tabular-nums">
                  {data.totals.rentalVehicles}
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2 flex flex-row items-center justify-between space-y-0">
                <CardTitle className="text-xs font-medium text-muted-foreground">
                  Total Charging Points
                </CardTitle>
                <BatteryCharging className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold tabular-nums">
                  {data.totals.chargingPoints}
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2 flex flex-row items-center justify-between space-y-0">
                <CardTitle className="text-xs font-medium text-muted-foreground">
                  Active Rentals
                </CardTitle>
                <Activity className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold tabular-nums">
                  {data.totals.activeRentals}
                </div>
              </CardContent>
            </Card>

            <Card className={cn(totalOpenAlerts > 0 && 'border-red-300')}>
              <CardHeader className="pb-2 flex flex-row items-center justify-between space-y-0">
                <CardTitle className="text-xs font-medium text-muted-foreground">
                  Open Alerts
                </CardTitle>
                <AlertTriangle
                  className={cn(
                    'h-4 w-4',
                    totalOpenAlerts > 0 ? 'text-red-600' : 'text-muted-foreground',
                  )}
                />
              </CardHeader>
              <CardContent className="flex items-end justify-between gap-2">
                <div
                  className={cn(
                    'text-2xl font-bold tabular-nums',
                    totalOpenAlerts > 0 && 'text-red-700',
                  )}
                >
                  {totalOpenAlerts}
                </div>
                <Button asChild variant="link" size="sm" className="h-auto p-0 text-xs">
                  <Link to="/ops/alerts">View inbox →</Link>
                </Button>
              </CardContent>
            </Card>
          </div>

          <Separator />

          <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-4">
            {data.hubs.map((hub) => (
              <HubCard key={hub.hubId} hub={hub} onInspect={setSelectedHubId} />
            ))}
          </div>
        </>
      )}

      <HubDrillDownDialog hubId={selectedHubId} onClose={() => setSelectedHubId(null)} />
    </div>
  );
}
