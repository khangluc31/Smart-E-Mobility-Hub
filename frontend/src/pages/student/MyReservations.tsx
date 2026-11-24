// Student My Reservations & History page (FR-07, FR-08, FR-09, FR-10, FR-11, FR-12, FR-19).

import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Clock, History, RefreshCw } from 'lucide-react';
import { useHubs } from '@/hooks/useHubs';
import {
  useCancelVehicleReservation,
  useChangeVehicle,
  useCurrentReservation,
  useHistory,
  usePickupVehicle,
  useReturnVehicle,
  useVehicleSearch,
} from '@/hooks/useReservations';
import { formatCountdown, useCountdown } from '@/hooks/useServerClock';
import type { Alternative } from '@/types/common';
import type { RentalVehicleType, VehicleClass } from '@/types/enums';
import type { HistoryType } from '@/types/reservations';
import { StatusBadge } from '@/components/common/StatusBadge';
import { BatteryBar } from '@/components/common/BatteryBar';
import { ErrorBox } from '@/components/common/ErrorBox';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
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

const CLASS_LABEL: Record<VehicleClass, string> = {
  MOTORCYCLE: 'Motorcycle',
  CAR: 'Car',
};

function formatLocalDateTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function MyReservations() {
  const { data: hubs } = useHubs();
  const {
    data: current,
    isLoading: isLoadingCurrent,
    error: currentError,
  } = useCurrentReservation();

  const hubNamesById = useMemo(() => {
    const map = new Map<string, string>();
    for (const h of hubs ?? []) map.set(h.id, h.name);
    return map;
  }, [hubs]);

  // Live countdown for CONFIRMED reservation (FR-07)
  const isConfirmed = current?.status === 'CONFIRMED';
  const { msLeft, expired } = useCountdown(
    isConfirmed ? current.expiresAt : null,
    isConfirmed ? current.serverNow : null,
  );

  // Action mutations
  const pickupMutation = usePickupVehicle();
  const cancelMutation = useCancelVehicleReservation();
  const changeMutation = useChangeVehicle();
  const returnMutation = useReturnVehicle();

  // Dialog states
  const [cancelOpen, setCancelOpen] = useState(false);
  const [changeOpen, setChangeOpen] = useState(false);
  const [returnOpen, setReturnOpen] = useState(false);
  const [returnHubId, setReturnHubId] = useState<string>('');

  // Rentable vehicles at same Hub for Change vehicle dialog (FR-09)
  const {
    data: swapCandidates,
    isLoading: isLoadingCandidates,
    error: candidatesError,
  } = useVehicleSearch(
    { hubId: current?.hubId, availableOnly: true },
    changeOpen && Boolean(current?.hubId),
  );

  const currentVehicleId = current?.vehicle.id;
  const otherVehicles = useMemo(
    () => (swapCandidates ?? []).filter((v) => v.id !== currentVehicleId),
    [swapCandidates, currentVehicleId],
  );

  // History tabs & infinite query (FR-10)
  const [historyTab, setHistoryTab] = useState<'all' | 'vehicle' | 'parking'>('all');
  const {
    data: historyPages,
    isLoading: isLoadingHistory,
    error: historyError,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
  } = useHistory({ type: historyTab as HistoryType });

  const historyItems = useMemo(
    () => historyPages?.pages.flatMap((p) => p.items) ?? [],
    [historyPages],
  );

  async function handlePickup() {
    if (!current) return;
    pickupMutation.reset();
    try {
      await pickupMutation.mutateAsync(current.id);
    } catch {
      // Displayed via ErrorBox
    }
  }

  async function handleConfirmCancel() {
    if (!current) return;
    try {
      await cancelMutation.mutateAsync(current.id);
      setCancelOpen(false);
    } catch {
      // Displayed via ErrorBox
    }
  }

  async function handleSelectSwapVehicle(vehicleId: string) {
    if (!current) return;
    try {
      await changeMutation.mutateAsync({ id: current.id, vehicleId });
      setChangeOpen(false);
    } catch {
      // Displayed via ErrorBox
    }
  }

  function openReturnDialog() {
    if (!current) return;
    returnMutation.reset();
    setReturnHubId(current.hubId);
    setReturnOpen(true);
  }

  async function handleConfirmReturn() {
    if (!current || !returnHubId) return;
    try {
      await returnMutation.mutateAsync({ id: current.id, hubId: returnHubId });
      setReturnOpen(false);
    } catch {
      // Displayed via ErrorBox
    }
  }

  function handleSelectReturnAlternative(alt: Alternative) {
    if (alt.type === 'hub' && alt.hubId) {
      setReturnHubId(alt.hubId);
      returnMutation.reset();
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold tracking-tight">My Reservations</h1>
        <p className="text-xs text-muted-foreground">
          Manage your active rental hold or trip, and review your booking history.
        </p>
      </div>

      {/* Current Vehicle Reservation */}
      <section className="space-y-3">
        <h2 className="text-base font-semibold">Current vehicle reservation</h2>

        {Boolean(currentError) && (
          <ErrorBox error={currentError} title="Could not load current reservation" />
        )}

        {isLoadingCurrent && <Skeleton className="h-44 w-full" />}

        {!isLoadingCurrent && !currentError && !current && (
          <Card>
            <CardContent className="py-8 text-center space-y-3">
              <p className="text-sm text-muted-foreground">
                You have no active vehicle reservation or rental right now.
              </p>
              <Button asChild size="sm" className="min-h-9">
                <Link to="/app/vehicles">Browse rental vehicles</Link>
              </Button>
            </CardContent>
          </Card>
        )}

        {!isLoadingCurrent && current && (
          <Card>
            <CardHeader className="pb-3 space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <CardTitle className="font-mono text-base">{current.vehicle.id}</CardTitle>
                  <span className="text-xs text-muted-foreground">
                    {VEHICLE_TYPE_LABEL[current.vehicle.type]}
                  </span>
                </div>
                <StatusBadge kind="reservation" value={current.status} />
              </div>
              <p className="text-xs text-muted-foreground">
                Hub: <strong>{hubNamesById.get(current.hubId) ?? current.hubId}</strong>
              </p>
            </CardHeader>

            <CardContent className="space-y-4 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-md bg-secondary/50 p-3">
                <div className="space-y-1">
                  <p className="text-xs text-muted-foreground">Vehicle battery</p>
                  <BatteryBar pct={current.vehicle.batteryPct} />
                </div>

                {current.status === 'CONFIRMED' && (
                  <div className="text-right space-y-0.5">
                    <p className="text-xs text-muted-foreground flex items-center justify-end gap-1">
                      <Clock className="h-3.5 w-3.5" />
                      <span>Hold remaining</span>
                    </p>
                    <p
                      className={`text-lg font-bold tabular-nums ${
                        expired ? 'text-destructive' : 'text-foreground'
                      }`}
                    >
                      {expired ? 'Expired' : formatCountdown(msLeft)}
                    </p>
                    <p className="text-[11px] text-muted-foreground">
                      Expires {formatLocalDateTime(current.expiresAt)}
                    </p>
                  </div>
                )}

                {current.status === 'ACTIVE' && (
                  <div className="text-right space-y-0.5 text-xs">
                    <p className="text-muted-foreground">Picked up</p>
                    <p className="font-medium">{formatLocalDateTime(current.pickedUpAt)}</p>
                    {current.startBatteryPct !== null && (
                      <p className="text-muted-foreground">
                        Start battery: {current.startBatteryPct}%
                      </p>
                    )}
                  </div>
                )}
              </div>

              {Boolean(pickupMutation.error) && (
                <ErrorBox error={pickupMutation.error} title="Could not pick up vehicle" />
              )}

              {current.status === 'CONFIRMED' && (
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    className="min-h-9 flex-1 sm:flex-none"
                    disabled={expired || pickupMutation.isPending}
                    onClick={handlePickup}
                  >
                    {pickupMutation.isPending ? 'Picking up…' : 'Pick up'}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-9 flex-1 sm:flex-none"
                    disabled={expired}
                    onClick={() => {
                      changeMutation.reset();
                      setChangeOpen(true);
                    }}
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                    <span>Change vehicle</span>
                  </Button>
                  <Button
                    type="button"
                    variant="destructive"
                    className="min-h-9 flex-1 sm:flex-none"
                    onClick={() => {
                      cancelMutation.reset();
                      setCancelOpen(true);
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              )}

              {current.status === 'ACTIVE' && (
                <div className="flex flex-wrap gap-2">
                  <Button type="button" className="min-h-9" onClick={openReturnDialog}>
                    Return vehicle
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        )}
      </section>

      {/* History (FR-10) */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-semibold flex items-center gap-2">
            <History className="h-4 w-4" />
            <span>History</span>
          </h2>

          <Tabs
            value={historyTab}
            onValueChange={(val) => setHistoryTab(val as 'all' | 'vehicle' | 'parking')}
          >
            <TabsList>
              <TabsTrigger value="all" className="min-h-8">
                All
              </TabsTrigger>
              <TabsTrigger value="vehicle" className="min-h-8">
                Vehicle
              </TabsTrigger>
              <TabsTrigger value="parking" className="min-h-8">
                Parking
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </div>

        {Boolean(historyError) && <ErrorBox error={historyError} title="Could not load history" />}

        {isLoadingHistory && (
          <div className="space-y-2" aria-busy="true">
            {[1, 2, 3].map((n) => (
              <Skeleton key={n} className="h-20 w-full" />
            ))}
          </div>
        )}

        {!isLoadingHistory && !historyError && historyItems.length === 0 && (
          <Card>
            <CardContent className="py-6 text-center text-sm text-muted-foreground">
              No past reservations yet.
            </CardContent>
          </Card>
        )}

        {!isLoadingHistory && historyItems.length > 0 && (
          <div className="space-y-2.5">
            {historyItems.map((entry) => {
              if (entry.kind === 'vehicle') {
                const r = entry.item;
                return (
                  <Card key={`v-${r.id}`}>
                    <CardContent className="py-3 px-4 space-y-1.5 text-xs">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge variant="secondary">Vehicle</Badge>
                          <span className="font-mono font-semibold">{r.vehicle.id}</span>
                          <span className="text-muted-foreground">
                            {VEHICLE_TYPE_LABEL[r.vehicle.type]}
                          </span>
                        </div>
                        <StatusBadge kind="reservation" value={r.status} />
                      </div>
                      <div className="flex flex-wrap items-center justify-between gap-2 text-muted-foreground">
                        <span>
                          Hub: {hubNamesById.get(r.hubId) ?? r.hubId}
                          {r.returnHubId && r.returnHubId !== r.hubId
                            ? ` → ${hubNamesById.get(r.returnHubId) ?? r.returnHubId}`
                            : ''}
                        </span>
                        <span>Created {formatLocalDateTime(entry.at)}</span>
                      </div>
                      {(r.pickedUpAt || r.returnedAt) && (
                        <div className="flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground">
                          {r.pickedUpAt && <span>Picked up: {formatLocalDateTime(r.pickedUpAt)}</span>}
                          {r.returnedAt && <span>Returned: {formatLocalDateTime(r.returnedAt)}</span>}
                        </div>
                      )}
                    </CardContent>
                  </Card>
                );
              }

              const p = entry.item;
              return (
                <Card key={`p-${p.id}`}>
                  <CardContent className="py-3 px-4 space-y-1.5 text-xs">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="secondary">Parking</Badge>
                        <span className="font-mono font-semibold">{p.parkingSpaceId}</span>
                        <span className="text-muted-foreground">{CLASS_LABEL[p.vehicleClass]}</span>
                      </div>
                      <StatusBadge kind="reservation" value={p.status} />
                    </div>
                    <div className="flex flex-wrap items-center justify-between gap-2 text-muted-foreground">
                      <span>Hub: {hubNamesById.get(p.hubId) ?? p.hubId}</span>
                      <span>Created {formatLocalDateTime(entry.at)}</span>
                    </div>
                    <div className="text-muted-foreground">
                      Window: {formatLocalDateTime(p.windowStart)} –{' '}
                      {formatLocalDateTime(p.windowEnd)}
                    </div>
                  </CardContent>
                </Card>
              );
            })}

            {hasNextPage && (
              <div className="pt-2 flex justify-center">
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-9"
                  disabled={isFetchingNextPage}
                  onClick={() => void fetchNextPage()}
                >
                  {isFetchingNextPage ? 'Loading…' : 'Load more'}
                </Button>
              </div>
            )}
          </div>
        )}
      </section>

      {/* Cancel Confirm Dialog (FR-08) */}
      <Dialog open={cancelOpen} onOpenChange={setCancelOpen}>
        <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Cancel reservation?</DialogTitle>
            <DialogDescription>
              This releases vehicle <span className="font-mono">{current?.vehicle.id}</span> back to
              the Hub immediately.
            </DialogDescription>
          </DialogHeader>

          {Boolean(cancelMutation.error) && (
            <ErrorBox error={cancelMutation.error} title="Could not cancel reservation" />
          )}

          <DialogFooter className="gap-2">
            <Button
              type="button"
              variant="outline"
              className="min-h-9"
              onClick={() => setCancelOpen(false)}
              disabled={cancelMutation.isPending}
            >
              Keep hold
            </Button>
            <Button
              type="button"
              variant="destructive"
              className="min-h-9"
              onClick={handleConfirmCancel}
              disabled={cancelMutation.isPending}
            >
              {cancelMutation.isPending ? 'Cancelling…' : 'Yes, cancel'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Change Vehicle Dialog (FR-09) */}
      <Dialog open={changeOpen} onOpenChange={setChangeOpen}>
        <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Change vehicle</DialogTitle>
            <DialogDescription>
              Choose another available vehicle at{' '}
              {current ? (hubNamesById.get(current.hubId) ?? current.hubId) : 'this Hub'}. Your
              original hold expiry time stays the same.
            </DialogDescription>
          </DialogHeader>

          {Boolean(changeMutation.error) && (
            <ErrorBox error={changeMutation.error} title="Could not change vehicle" />
          )}
          {Boolean(candidatesError) && (
            <ErrorBox error={candidatesError} title="Could not load available vehicles" />
          )}

          {isLoadingCandidates && <Skeleton className="h-24 w-full" />}

          {!isLoadingCandidates && otherVehicles.length === 0 && (
            <p className="text-sm text-muted-foreground py-4 text-center">
              No other available vehicles at this Hub right now.
            </p>
          )}

          {!isLoadingCandidates && otherVehicles.length > 0 && (
            <ul className="divide-y">
              {otherVehicles.map((v) => (
                <li key={v.id} className="py-2.5 flex flex-wrap items-center justify-between gap-2">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2 text-sm">
                      <span className="font-mono font-semibold">{v.id}</span>
                      <span className="text-xs text-muted-foreground">
                        {VEHICLE_TYPE_LABEL[v.type]}
                      </span>
                    </div>
                    <BatteryBar pct={v.batteryPct} />
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    className="min-h-9"
                    disabled={changeMutation.isPending}
                    onClick={() => void handleSelectSwapVehicle(v.id)}
                  >
                    Select
                  </Button>
                </li>
              ))}
            </ul>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              className="min-h-9"
              onClick={() => setChangeOpen(false)}
              disabled={changeMutation.isPending}
            >
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Return Vehicle Dialog (FR-12, FR-19) */}
      <Dialog open={returnOpen} onOpenChange={setReturnOpen}>
        <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Return vehicle</DialogTitle>
            <DialogDescription>
              Choose the Hub where you are returning{' '}
              <span className="font-mono">{current?.vehicle.id}</span>.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="return-hub">Return Hub</Label>
              <Select value={returnHubId} onValueChange={setReturnHubId}>
                <SelectTrigger id="return-hub" className="w-full min-h-9">
                  <SelectValue placeholder="Choose return Hub" />
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

            {Boolean(returnMutation.error) && (
              <ErrorBox
                error={returnMutation.error}
                title="Could not return vehicle"
                onSelectAlternative={handleSelectReturnAlternative}
              />
            )}
          </div>

          <DialogFooter className="gap-2">
            <Button
              type="button"
              variant="outline"
              className="min-h-9"
              onClick={() => setReturnOpen(false)}
              disabled={returnMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              type="button"
              className="min-h-9"
              onClick={handleConfirmReturn}
              disabled={!returnHubId || returnMutation.isPending}
            >
              {returnMutation.isPending ? 'Returning…' : 'Confirm return'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
