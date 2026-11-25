// Student Vehicle Search & Trip Recommendations page (FR-04, FR-05, FR-06, NFR-03/05/28).

import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, Compass, Search, Zap } from 'lucide-react';
import { ApiError } from '@/lib/api';
import { MIN_RENTAL_BATTERY_PCT } from '@/lib/constants';
import { useHubs } from '@/hooks/useHubs';
import {
  useRecommend,
  useReserveVehicle,
  useVehicleSearch,
  type VehicleRecommendQuery,
} from '@/hooks/useReservations';
import { RENTAL_VEHICLE_TYPES, type RentalVehicleType } from '@/types/enums';
import type { Alternative } from '@/types/common';
import type { RentalVehicle } from '@/types/hubs';
import { StatusBadge } from '@/components/common/StatusBadge';
import { BatteryBar } from '@/components/common/BatteryBar';
import { VehicleIcon } from '@/components/common/VehicleIcon';
import { ErrorBox } from '@/components/common/ErrorBox';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

const VEHICLE_TYPE_LABEL: Record<RentalVehicleType, string> = {
  E_BICYCLE: 'E-Bicycle',
  E_MOTORCYCLE: 'E-Motorcycle',
};

interface PendingReserve {
  vehicleId: string;
  hubId?: string;
  type?: RentalVehicleType;
  batteryPct?: number;
  idempotencyKey: string;
}

function isRentable(v: RentalVehicle): boolean {
  return v.status === 'AVAILABLE' && v.batteryPct >= MIN_RENTAL_BATTERY_PCT && !v.charging;
}

export function VehicleSearch() {
  const navigate = useNavigate();
  const { data: hubs } = useHubs();

  // Search filters
  const [hubFilter, setHubFilter] = useState<string>('ALL');
  const [typeFilter, setTypeFilter] = useState<string>('ALL');
  const [minBatteryInput, setMinBatteryInput] = useState<string>('');
  const [availableOnly, setAvailableOnly] = useState<boolean>(true);

  const parsedMinBattery = useMemo(() => {
    if (minBatteryInput.trim() === '') return undefined;
    const n = Number(minBatteryInput);
    if (!Number.isFinite(n)) return undefined;
    return Math.max(0, Math.min(100, Math.round(n)));
  }, [minBatteryInput]);

  const searchFilters = useMemo(
    () => ({
      hubId: hubFilter !== 'ALL' ? hubFilter : undefined,
      type: typeFilter !== 'ALL' ? (typeFilter as RentalVehicleType) : undefined,
      minBattery: parsedMinBattery,
      availableOnly,
    }),
    [hubFilter, typeFilter, parsedMinBattery, availableOnly],
  );

  const {
    data: vehicles,
    isLoading: isSearching,
    error: searchError,
  } = useVehicleSearch(searchFilters);

  // Plan a trip (FR-05)
  const [originHubId, setOriginHubId] = useState<string>('');
  const [destinationHubId, setDestinationHubId] = useState<string>('');
  const [tripTimeLocal, setTripTimeLocal] = useState<string>('');
  const [activeTripQuery, setActiveTripQuery] = useState<VehicleRecommendQuery | null>(null);

  const {
    data: recommendation,
    isLoading: isRecommending,
    error: recommendError,
  } = useRecommend(activeTripQuery, Boolean(activeTripQuery));

  // Reserve confirm dialog (FR-06, <= 4 steps)
  const [pending, setPending] = useState<PendingReserve | null>(null);
  const reserveMutation = useReserveVehicle();

  const hubNamesById = useMemo(() => {
    const map = new Map<string, string>();
    for (const h of hubs ?? []) map.set(h.id, h.name);
    return map;
  }, [hubs]);

  function openReserveDialog(vehicle: {
    id: string;
    hubId?: string;
    type?: RentalVehicleType;
    batteryPct?: number;
  }) {
    reserveMutation.reset();
    setPending({
      vehicleId: vehicle.id,
      hubId: vehicle.hubId,
      type: vehicle.type,
      batteryPct: vehicle.batteryPct,
      idempotencyKey: crypto.randomUUID(),
    });
  }

  function closeReserveDialog() {
    if (reserveMutation.isPending) return;
    setPending(null);
    reserveMutation.reset();
  }

  async function handleConfirmReserve() {
    if (!pending) return;
    try {
      await reserveMutation.mutateAsync({
        vehicleId: pending.vehicleId,
        idempotencyKey: pending.idempotencyKey,
      });
      setPending(null);
      navigate('/app/reservations');
    } catch {
      // Displayed via ErrorBox
    }
  }

  function handleSelectAlternativeVehicle(alt: Alternative) {
    if (alt.type !== 'rentalVehicle' || !alt.id) return;
    const match =
      vehicles?.find((v) => v.id === alt.id) ??
      recommendation?.vehicles.find((v) => v.id === alt.id);
    openReserveDialog({
      id: alt.id,
      hubId: match?.hubId ?? alt.hubId ?? pending?.hubId,
      type: match?.type,
      batteryPct: match?.batteryPct ?? alt.batteryPct,
    });
  }

  function handlePlanTripSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!originHubId || !destinationHubId) return;
    const isoTime = tripTimeLocal ? new Date(tripTimeLocal).toISOString() : undefined;
    setActiveTripQuery({
      originHubId,
      destinationHubId,
      time: isoTime,
    });
  }

  function handlePickAlternativeDestination(alt: Alternative) {
    if (!alt.hubId || !originHubId) return;
    setDestinationHubId(alt.hubId);
    const isoTime = tripTimeLocal ? new Date(tripTimeLocal).toISOString() : undefined;
    setActiveTripQuery({
      originHubId,
      destinationHubId: alt.hubId,
      time: isoTime,
    });
  }

  const reserveErr = reserveMutation.error;
  const isActiveRentalExists =
    reserveErr instanceof ApiError && reserveErr.code === 'ACTIVE_RENTAL_EXISTS';

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold tracking-tight">Rental Vehicles</h1>
        <p className="text-xs text-muted-foreground">
          Find and reserve an available vehicle, or plan a trip between Hubs.
        </p>
      </div>

      {/* Plan a trip (FR-05) */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Compass className="h-4 w-4 shrink-0" />
            <span>Plan a trip</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <form onSubmit={handlePlanTripSubmit} className="grid grid-cols-1 sm:grid-cols-4 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="trip-origin">Origin Hub</Label>
              <Select value={originHubId} onValueChange={setOriginHubId}>
                <SelectTrigger id="trip-origin" className="w-full min-h-9">
                  <SelectValue placeholder="Choose origin" />
                </SelectTrigger>
                <SelectContent>
                  {(hubs ?? []).map((h) => (
                    <SelectItem key={h.id} value={h.id}>
                      {h.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="trip-destination">Destination Hub</Label>
              <Select value={destinationHubId} onValueChange={setDestinationHubId}>
                <SelectTrigger id="trip-destination" className="w-full min-h-9">
                  <SelectValue placeholder="Choose destination" />
                </SelectTrigger>
                <SelectContent>
                  {(hubs ?? []).map((h) => (
                    <SelectItem key={h.id} value={h.id}>
                      {h.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="trip-time">Departure time (optional)</Label>
              <Input
                id="trip-time"
                type="datetime-local"
                value={tripTimeLocal}
                onChange={(e) => setTripTimeLocal(e.target.value)}
                className="min-h-9"
              />
            </div>

            <div className="flex items-end">
              <Button
                type="submit"
                className="w-full min-h-9"
                disabled={!originHubId || !destinationHubId || isRecommending}
              >
                {isRecommending ? 'Checking…' : 'Recommend'}
              </Button>
            </div>
          </form>

          {Boolean(recommendError) && (
            <ErrorBox error={recommendError} title="Could not load recommendations" />
          )}

          {recommendation && (
            <div className="space-y-3 pt-2 border-t">
              <div
                className={`rounded-md border p-3 text-xs space-y-2 ${
                  recommendation.destination.ok
                    ? 'border-emerald-300 bg-emerald-50 text-emerald-900'
                    : 'border-amber-400 bg-amber-50 text-amber-900'
                }`}
              >
                <div className="flex items-start gap-2">
                  {recommendation.destination.ok ? (
                    <CheckCircle2 className="h-4 w-4 shrink-0 mt-0.5" />
                  ) : (
                    <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                  )}
                  <div className="space-y-1 min-w-0">
                    <p className="font-semibold">
                      Destination:{' '}
                      {hubNamesById.get(recommendation.destination.hubId) ??
                        recommendation.destination.hubId}{' '}
                      ({recommendation.destination.freeFleetSpaces} free fleet spaces)
                    </p>
                    <p>{recommendation.destination.reason}</p>
                  </div>
                </div>

                {!recommendation.destination.ok &&
                  recommendation.alternativeDestinations.length > 0 && (
                    <div className="space-y-1.5 pt-1">
                      <p className="font-medium uppercase tracking-wide text-[11px]">
                        Alternative destinations
                      </p>
                      <div className="flex flex-wrap gap-2">
                        {recommendation.alternativeDestinations.map((alt, idx) => (
                          <Button
                            key={idx}
                            type="button"
                            size="sm"
                            variant="outline"
                            className="min-h-9 bg-background text-foreground"
                            onClick={() => handlePickAlternativeDestination(alt)}
                          >
                            {alt.hubName ?? alt.hubId} — {alt.reason}
                          </Button>
                        ))}
                      </div>
                    </div>
                  )}
              </div>

              {recommendation.vehicles.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No recommended vehicles at the selected origin Hub.
                </p>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {recommendation.vehicles.map((v) => (
                    <div
                      key={v.id}
                      className="rounded-md border p-3 flex flex-col justify-between gap-2 text-xs"
                    >
                      <div className="space-y-1.5">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex items-center gap-2 min-w-0">
                            <VehicleIcon type={v.type} size="md" className="text-muted-foreground" />
                            <span className="font-mono font-semibold text-sm">{v.id}</span>
                          </div>
                          <StatusBadge kind="rentalVehicle" value={v.status} />
                        </div>
                        <p className="text-muted-foreground">
                          {VEHICLE_TYPE_LABEL[v.type]} · {hubNamesById.get(v.hubId) ?? v.hubId}
                        </p>
                        <BatteryBar pct={v.batteryPct} />
                        <p className="text-muted-foreground">{v.reason}</p>
                      </div>
                      <Button
                        type="button"
                        size="sm"
                        className="w-full min-h-9"
                        disabled={!isRentable(v)}
                        onClick={() => openReserveDialog(v)}
                      >
                        Reserve
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Search Filters (FR-04) */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Search className="h-4 w-4 shrink-0" />
            <span>Search fleet</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="filter-hub">Hub</Label>
              <Select value={hubFilter} onValueChange={setHubFilter}>
                <SelectTrigger id="filter-hub" className="w-full min-h-9">
                  <SelectValue placeholder="All Hubs" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">All Hubs</SelectItem>
                  {(hubs ?? []).map((h) => (
                    <SelectItem key={h.id} value={h.id}>
                      {h.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="filter-type">Vehicle type</Label>
              <Select value={typeFilter} onValueChange={setTypeFilter}>
                <SelectTrigger id="filter-type" className="w-full min-h-9">
                  <SelectValue placeholder="All types" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">All types</SelectItem>
                  {RENTAL_VEHICLE_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>
                      {VEHICLE_TYPE_LABEL[t]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="filter-battery">Min battery (%)</Label>
              <Input
                id="filter-battery"
                type="number"
                min={0}
                max={100}
                placeholder="Any"
                value={minBatteryInput}
                onChange={(e) => setMinBatteryInput(e.target.value)}
                className="min-h-9"
              />
            </div>

            <div className="flex items-end">
              <label className="flex min-h-9 w-full items-center gap-2 rounded-md border px-3 text-sm cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={availableOnly}
                  onChange={(e) => setAvailableOnly(e.target.checked)}
                  className="h-4 w-4 accent-primary"
                />
                <span>Available only</span>
              </label>
            </div>
          </div>

          {Boolean(searchError) && <ErrorBox error={searchError} title="Could not load vehicles" />}

          {isSearching && (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3" aria-busy="true">
              {[1, 2, 3, 4, 5, 6].map((n) => (
                <Skeleton key={n} className="h-32 w-full" />
              ))}
            </div>
          )}

          {!isSearching && !searchError && vehicles && vehicles.length === 0 && (
            <div className="rounded-md border py-8 text-center text-sm text-muted-foreground">
              No vehicle found
            </div>
          )}

          {!isSearching && vehicles && vehicles.length > 0 && (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {vehicles.map((v) => {
                const rentable = isRentable(v);
                return (
                  <Card key={v.id} className="flex flex-col justify-between">
                    <CardHeader className="pb-2 space-y-1.5">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                          <VehicleIcon type={v.type} size="md" className="text-muted-foreground" />
                          <CardTitle className="font-mono text-sm">{v.id}</CardTitle>
                        </div>
                        <div className="flex flex-wrap items-center gap-1.5">
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
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {VEHICLE_TYPE_LABEL[v.type]} · {hubNamesById.get(v.hubId) ?? v.hubId}
                      </p>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      <BatteryBar pct={v.batteryPct} />
                      <Button
                        type="button"
                        size="sm"
                        className="w-full min-h-9"
                        disabled={!rentable}
                        onClick={() => openReserveDialog(v)}
                      >
                        {rentable ? 'Reserve' : 'Unavailable'}
                      </Button>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Reserve Confirmation Dialog */}
      <Dialog open={Boolean(pending)} onOpenChange={(open) => !open && closeReserveDialog()}>
        <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Confirm vehicle reservation</DialogTitle>
            <DialogDescription>
              The hold timer starts as soon as you confirm. Your exact expiry countdown will be
              shown on My Reservations.
            </DialogDescription>
          </DialogHeader>

          {pending && (
            <div className="space-y-3 text-sm">
              <div className="rounded-md border p-3 space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-muted-foreground">Vehicle</span>
                  <span className="font-mono font-semibold">{pending.vehicleId}</span>
                </div>
                {pending.type && (
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-muted-foreground">Type</span>
                    <span>{VEHICLE_TYPE_LABEL[pending.type]}</span>
                  </div>
                )}
                {pending.hubId && (
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-muted-foreground">Hub</span>
                    <span>{hubNamesById.get(pending.hubId) ?? pending.hubId}</span>
                  </div>
                )}
                {pending.batteryPct !== undefined && (
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-muted-foreground">Battery</span>
                    <BatteryBar pct={pending.batteryPct} />
                  </div>
                )}
              </div>

              {Boolean(reserveErr) && (
                <div className="space-y-2">
                  <ErrorBox
                    error={reserveErr}
                    title="Could not reserve vehicle"
                    onSelectAlternative={handleSelectAlternativeVehicle}
                  />
                  {isActiveRentalExists && (
                    <Button asChild variant="outline" size="sm" className="w-full min-h-9">
                      <Link to="/app/reservations">Go to My Reservations</Link>
                    </Button>
                  )}
                </div>
              )}
            </div>
          )}

          <DialogFooter className="gap-2">
            <Button
              type="button"
              variant="outline"
              className="min-h-9"
              onClick={closeReserveDialog}
              disabled={reserveMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              type="button"
              className="min-h-9"
              onClick={handleConfirmReserve}
              disabled={reserveMutation.isPending || !pending}
            >
              {reserveMutation.isPending ? 'Reserving…' : 'Confirm reservation'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
