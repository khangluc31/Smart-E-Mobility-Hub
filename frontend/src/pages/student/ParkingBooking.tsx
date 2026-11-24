// Student Parking Booking & My Parking Reservations page (FR-14–FR-18, FR-19, NFR-05/28).

import { useMemo, useRef, useState } from 'react';
import { CalendarClock, CheckCircle2, ParkingSquare } from 'lucide-react';
import { PARKING_MAX_WINDOW_H } from '@/lib/constants';
import { useHubs } from '@/hooks/useHubs';
import { usePrivateEvs } from '@/hooks/usePrivateEvs';
import {
  useCancelParking,
  useChangeParkingWindow,
  useClaimParking,
  useLeaveParking,
  useMyParking,
  useParkingAvailability,
  useReserveParking,
  type ParkingAvailabilityQuery,
} from '@/hooks/useReservations';
import { useServerNowMs } from '@/hooks/useServerClock';
import { VEHICLE_CLASSES, type VehicleClass } from '@/types/enums';
import type { Alternative } from '@/types/common';
import type { ParkingReservation } from '@/types/reservations';
import { StatusBadge } from '@/components/common/StatusBadge';
import { ErrorBox } from '@/components/common/ErrorBox';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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

const CLASS_LABEL: Record<VehicleClass, string> = {
  MOTORCYCLE: 'Motorcycle',
  CAR: 'Car',
};

function toLocalDateTimeInput(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function localInputToIso(localVal: string): string | null {
  if (!localVal) return null;
  const d = new Date(localVal);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function formatLocalDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatLocalTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function ParkingBooking() {
  const { data: hubs } = useHubs();
  const { data: privateEvs } = usePrivateEvs();
  const {
    data: myParking,
    isLoading: isLoadingMyParking,
    error: myParkingError,
  } = useMyParking();

  const serverNowMs = useServerNowMs(1000);

  const hubNamesById = useMemo(() => {
    const map = new Map<string, string>();
    for (const h of hubs ?? []) map.set(h.id, h.name);
    return map;
  }, [hubs]);

  const evLabelsById = useMemo(() => {
    const map = new Map<string, string>();
    for (const ev of privateEvs ?? []) map.set(ev.id, ev.label);
    return map;
  }, [privateEvs]);

  // Booking form state
  const [hubId, setHubId] = useState<string>('');
  const [vehicleClass, setVehicleClass] = useState<VehicleClass>('MOTORCYCLE');
  const [privateEvId, setPrivateEvId] = useState<string>('NONE');
  const [windowStartLocal, setWindowStartLocal] = useState<string>(() =>
    toLocalDateTimeInput(new Date(Date.now() + 5 * 60 * 1000)),
  );
  const [windowEndLocal, setWindowEndLocal] = useState<string>(() =>
    toLocalDateTimeInput(new Date(Date.now() + 65 * 60 * 1000)),
  );

  // Idempotency key per distinct form attempt (reused on retry, regenerated on form edit or success)
  const idemKeyRef = useRef<string>(crypto.randomUUID());
  function resetIdemKey() {
    idemKeyRef.current = crypto.randomUUID();
  }

  // Availability check state (FR-14)
  const [availQuery, setAvailQuery] = useState<ParkingAvailabilityQuery | null>(null);
  const {
    data: availability,
    isLoading: isCheckingAvail,
    error: availError,
  } = useParkingAvailability(availQuery, Boolean(availQuery));

  // Mutations
  const reserveMutation = useReserveParking();
  const claimMutation = useClaimParking();
  const leaveMutation = useLeaveParking();
  const cancelMutation = useCancelParking();
  const changeWindowMutation = useChangeParkingWindow();

  // Per-item action error tracking for Claim / Leave
  const [rowActionError, setRowActionError] = useState<{ id: string; error: unknown } | null>(null);

  // Dialog states for Cancel and Change window
  const [cancelTarget, setCancelTarget] = useState<ParkingReservation | null>(null);
  const [editTarget, setEditTarget] = useState<ParkingReservation | null>(null);
  const [editStartLocal, setEditStartLocal] = useState<string>('');
  const [editEndLocal, setEditEndLocal] = useState<string>('');

  const matchingEvs = useMemo(
    () => (privateEvs ?? []).filter((ev) => ev.vehicleClass === vehicleClass),
    [privateEvs, vehicleClass],
  );

  const startIso = localInputToIso(windowStartLocal);
  const endIso = localInputToIso(windowEndLocal);

  // Client-side hints (advisory only — server still validates)
  const windowHint = useMemo(() => {
    if (!startIso || !endIso) return null;
    const diffMs = Date.parse(endIso) - Date.parse(startIso);
    if (diffMs <= 0) return 'End time must be after start time.';
    if (diffMs > PARKING_MAX_WINDOW_H * 60 * 60 * 1000) {
      return `Maximum parking window is ${PARKING_MAX_WINDOW_H} hours.`;
    }
    return null;
  }, [startIso, endIso]);

  const availMatchesForm =
    Boolean(availability) &&
    availQuery?.hubId === hubId &&
    availQuery?.vehicleClass === vehicleClass &&
    availQuery?.from === startIso &&
    availQuery?.to === endIso;

  const isZeroFreeForCurrentForm = availMatchesForm && availability?.free === 0;

  function handleClassChange(nextClass: VehicleClass) {
    setVehicleClass(nextClass);
    setPrivateEvId('NONE');
    resetIdemKey();
  }

  function handleCheckAvailability() {
    if (!hubId || !startIso || !endIso) return;
    reserveMutation.reset();
    setAvailQuery({
      hubId,
      vehicleClass,
      from: startIso,
      to: endIso,
    });
  }

  function handleSelectHubAlternative(alt: Alternative) {
    if (alt.type !== 'hub' || !alt.hubId) return;
    setHubId(alt.hubId);
    resetIdemKey();
    reserveMutation.reset();
    if (startIso && endIso) {
      setAvailQuery({
        hubId: alt.hubId,
        vehicleClass,
        from: startIso,
        to: endIso,
      });
    }
  }

  async function handleReserve(e: React.FormEvent) {
    e.preventDefault();
    if (!hubId || !startIso || !endIso) return;
    try {
      await reserveMutation.mutateAsync({
        hubId,
        vehicleClass,
        privateEvId: privateEvId !== 'NONE' ? privateEvId : undefined,
        windowStart: startIso,
        windowEnd: endIso,
        idempotencyKey: idemKeyRef.current,
      });
      resetIdemKey();
    } catch {
      // Displayed via ErrorBox
    }
  }

  async function handleClaim(id: string) {
    setRowActionError(null);
    try {
      await claimMutation.mutateAsync(id);
    } catch (err) {
      setRowActionError({ id, error: err });
    }
  }

  async function handleLeave(id: string) {
    setRowActionError(null);
    try {
      await leaveMutation.mutateAsync(id);
    } catch (err) {
      setRowActionError({ id, error: err });
    }
  }

  async function handleConfirmCancel() {
    if (!cancelTarget) return;
    try {
      await cancelMutation.mutateAsync(cancelTarget.id);
      setCancelTarget(null);
    } catch {
      // Displayed via ErrorBox
    }
  }

  function openEditDialog(res: ParkingReservation) {
    changeWindowMutation.reset();
    setEditTarget(res);
    setEditStartLocal(toLocalDateTimeInput(new Date(res.windowStart)));
    setEditEndLocal(toLocalDateTimeInput(new Date(res.windowEnd)));
  }

  async function handleConfirmChangeWindow(e: React.FormEvent) {
    e.preventDefault();
    if (!editTarget) return;
    const nextStart = localInputToIso(editStartLocal);
    const nextEnd = localInputToIso(editEndLocal);
    if (!nextStart || !nextEnd) return;
    try {
      await changeWindowMutation.mutateAsync({
        id: editTarget.id,
        windowStart: nextStart,
        windowEnd: nextEnd,
      });
      setEditTarget(null);
    } catch {
      // Displayed via ErrorBox
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold tracking-tight">Parking Booking</h1>
        <p className="text-xs text-muted-foreground">
          Check public parking availability and reserve a space for your time window.
        </p>
      </div>

      {/* Book Parking Form (FR-14, FR-15) */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <ParkingSquare className="h-4 w-4 shrink-0" />
            <span>Reserve a public space</span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleReserve} className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="parking-hub">Hub</Label>
                <Select
                  value={hubId}
                  onValueChange={(v) => {
                    setHubId(v);
                    resetIdemKey();
                  }}
                >
                  <SelectTrigger id="parking-hub" className="w-full min-h-9">
                    <SelectValue placeholder="Choose Hub" />
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
                <Label htmlFor="parking-class">Vehicle class</Label>
                <Select
                  value={vehicleClass}
                  onValueChange={(v) => handleClassChange(v as VehicleClass)}
                >
                  <SelectTrigger id="parking-class" className="w-full min-h-9">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {VEHICLE_CLASSES.map((vc) => (
                      <SelectItem key={vc} value={vc}>
                        {CLASS_LABEL[vc]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="parking-ev">Private EV (optional)</Label>
                <Select
                  value={privateEvId}
                  onValueChange={(v) => {
                    setPrivateEvId(v);
                    resetIdemKey();
                  }}
                >
                  <SelectTrigger id="parking-ev" className="w-full min-h-9">
                    <SelectValue placeholder="None" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="NONE">None</SelectItem>
                    {matchingEvs.map((ev) => (
                      <SelectItem key={ev.id} value={ev.id}>
                        {ev.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="parking-start">Window start (local time)</Label>
                <Input
                  id="parking-start"
                  type="datetime-local"
                  value={windowStartLocal}
                  onChange={(e) => {
                    setWindowStartLocal(e.target.value);
                    resetIdemKey();
                  }}
                  className="min-h-9"
                  required
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="parking-end">Window end (local time)</Label>
                <Input
                  id="parking-end"
                  type="datetime-local"
                  value={windowEndLocal}
                  onChange={(e) => {
                    setWindowEndLocal(e.target.value);
                    resetIdemKey();
                  }}
                  className="min-h-9"
                  required
                />
              </div>
            </div>

            {windowHint && <p className="text-xs text-amber-700 font-medium">{windowHint}</p>}

            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                className="min-h-9 flex-1 sm:flex-none"
                disabled={!hubId || !startIso || !endIso || isCheckingAvail}
                onClick={handleCheckAvailability}
              >
                {isCheckingAvail ? 'Checking…' : 'Check availability'}
              </Button>

              <Button
                type="submit"
                className="min-h-9 flex-1 sm:flex-none"
                disabled={
                  !hubId ||
                  !startIso ||
                  !endIso ||
                  isZeroFreeForCurrentForm ||
                  reserveMutation.isPending
                }
              >
                {reserveMutation.isPending ? 'Reserving…' : 'Reserve space'}
              </Button>
            </div>

            {Boolean(availError) && (
              <ErrorBox error={availError} title="Could not check availability" />
            )}

            {availability && availMatchesForm && (
              <div
                className={`rounded-md border p-3 text-xs space-y-2 ${
                  availability.free > 0
                    ? 'border-emerald-300 bg-emerald-50 text-emerald-900'
                    : 'border-amber-400 bg-amber-50 text-amber-900'
                }`}
              >
                <p className="font-semibold flex items-center gap-1.5">
                  {availability.free > 0 && <CheckCircle2 className="h-4 w-4 shrink-0" />}
                  <span>
                    {availability.free} / {availability.total} public{' '}
                    {CLASS_LABEL[availability.vehicleClass].toLowerCase()} spaces free at{' '}
                    {hubNamesById.get(availability.hubId) ?? availability.hubId}
                  </span>
                </p>

                {availability.free === 0 && (
                  <div className="space-y-1.5">
                    <p>No spaces free for this window. Reserve is disabled.</p>
                    {availability.alternatives.length > 0 ? (
                      <div className="flex flex-wrap gap-2 pt-1">
                        {availability.alternatives.map((alt, idx) => (
                          <Button
                            key={idx}
                            type="button"
                            size="sm"
                            variant="outline"
                            className="min-h-9 bg-background text-foreground"
                            onClick={() => handleSelectHubAlternative(alt)}
                          >
                            {alt.hubName ?? alt.hubId} — {alt.reason}
                          </Button>
                        ))}
                      </div>
                    ) : (
                      <p className="text-muted-foreground">No alternative Hubs available.</p>
                    )}
                  </div>
                )}
              </div>
            )}

            {Boolean(reserveMutation.error) && (
              <ErrorBox
                error={reserveMutation.error}
                title="Could not reserve parking"
                onSelectAlternative={handleSelectHubAlternative}
              />
            )}
          </form>
        </CardContent>
      </Card>

      {/* My Parking Reservations (FR-16, FR-17, FR-18) */}
      <section className="space-y-3">
        <h2 className="text-base font-semibold flex items-center gap-2">
          <CalendarClock className="h-4 w-4" />
          <span>My parking reservations</span>
        </h2>

        {Boolean(myParkingError) && (
          <ErrorBox error={myParkingError} title="Could not load your parking reservations" />
        )}

        {isLoadingMyParking && (
          <div className="space-y-2" aria-busy="true">
            <Skeleton className="h-28 w-full" />
            <Skeleton className="h-28 w-full" />
          </div>
        )}

        {!isLoadingMyParking && !myParkingError && myParking.length === 0 && (
          <Card>
            <CardContent className="py-6 text-center text-sm text-muted-foreground">
              No active or upcoming parking reservations.
            </CardContent>
          </Card>
        )}

        {!isLoadingMyParking && myParking.length > 0 && (
          <div className="space-y-3">
            {myParking.map((p) => {
              const startMs = Date.parse(p.windowStart);
              const beforeStart = Number.isFinite(startMs) && serverNowMs < startMs;
              const rowErr = rowActionError?.id === p.id ? rowActionError.error : null;

              return (
                <Card key={p.id}>
                  <CardContent className="py-4 px-4 space-y-3 text-xs">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono font-semibold text-sm">{p.parkingSpaceId}</span>
                        <span className="text-muted-foreground">{CLASS_LABEL[p.vehicleClass]}</span>
                      </div>
                      <StatusBadge kind="reservation" value={p.status} />
                    </div>

                    <div className="space-y-1 text-muted-foreground">
                      <p>
                        Hub: <strong className="text-foreground">{hubNamesById.get(p.hubId) ?? p.hubId}</strong>
                      </p>
                      <p>
                        Window:{' '}
                        <span className="text-foreground font-medium">
                          {formatLocalDateTime(p.windowStart)} – {formatLocalDateTime(p.windowEnd)}
                        </span>
                      </p>
                      {p.privateEvId && (
                        <p>
                          Private EV:{' '}
                          <span className="text-foreground">
                            {evLabelsById.get(p.privateEvId) ?? p.privateEvId}
                          </span>
                        </p>
                      )}
                      {p.status === 'CONFIRMED' && (
                        <p>Hold expires: {formatLocalDateTime(p.expiresAt)}</p>
                      )}
                    </div>

                    {Boolean(rowErr) && <ErrorBox error={rowErr} title="Action failed" />}

                    {p.status === 'CONFIRMED' && (
                      <div className="flex flex-wrap gap-2 pt-1">
                        <Button
                          type="button"
                          size="sm"
                          className="min-h-9 flex-1 sm:flex-none"
                          disabled={beforeStart || claimMutation.isPending}
                          onClick={() => void handleClaim(p.id)}
                        >
                          {beforeStart
                            ? `Opens at ${formatLocalTime(p.windowStart)}`
                            : claimMutation.isPending
                              ? 'Claiming…'
                              : 'Claim'}
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="min-h-9 flex-1 sm:flex-none"
                          onClick={() => openEditDialog(p)}
                        >
                          Change window
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="destructive"
                          className="min-h-9 flex-1 sm:flex-none"
                          onClick={() => {
                            cancelMutation.reset();
                            setCancelTarget(p);
                          }}
                        >
                          Cancel
                        </Button>
                      </div>
                    )}

                    {p.status === 'ACTIVE' && (
                      <div className="flex flex-wrap gap-2 pt-1">
                        <Button
                          type="button"
                          size="sm"
                          className="min-h-9"
                          disabled={leaveMutation.isPending}
                          onClick={() => void handleLeave(p.id)}
                        >
                          {leaveMutation.isPending ? 'Leaving…' : 'Leave space'}
                        </Button>
                      </div>
                    )}
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </section>

      {/* Cancel Parking Dialog (FR-16) */}
      <Dialog open={Boolean(cancelTarget)} onOpenChange={(open) => !open && setCancelTarget(null)}>
        <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Cancel parking reservation?</DialogTitle>
            <DialogDescription>
              Space <span className="font-mono">{cancelTarget?.parkingSpaceId}</span> will be
              released immediately.
            </DialogDescription>
          </DialogHeader>

          {Boolean(cancelMutation.error) && (
            <ErrorBox error={cancelMutation.error} title="Could not cancel parking" />
          )}

          <DialogFooter className="gap-2">
            <Button
              type="button"
              variant="outline"
              className="min-h-9"
              onClick={() => setCancelTarget(null)}
              disabled={cancelMutation.isPending}
            >
              Keep
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

      {/* Change Window Dialog (FR-17) */}
      <Dialog open={Boolean(editTarget)} onOpenChange={(open) => !open && setEditTarget(null)}>
        <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Change parking window</DialogTitle>
            <DialogDescription>
              Update the time window for{' '}
              {editTarget ? (hubNamesById.get(editTarget.hubId) ?? editTarget.hubId) : 'your Hub'}.
              If the new window is full, your original reservation stays unchanged.
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={handleConfirmChangeWindow} className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="edit-parking-start">New start (local time)</Label>
              <Input
                id="edit-parking-start"
                type="datetime-local"
                value={editStartLocal}
                onChange={(e) => setEditStartLocal(e.target.value)}
                className="min-h-9"
                required
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="edit-parking-end">New end (local time)</Label>
              <Input
                id="edit-parking-end"
                type="datetime-local"
                value={editEndLocal}
                onChange={(e) => setEditEndLocal(e.target.value)}
                className="min-h-9"
                required
              />
            </div>

            {Boolean(changeWindowMutation.error) && (
              <ErrorBox error={changeWindowMutation.error} title="Could not change window" />
            )}

            <DialogFooter className="gap-2">
              <Button
                type="button"
                variant="outline"
                className="min-h-9"
                onClick={() => setEditTarget(null)}
                disabled={changeWindowMutation.isPending}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                className="min-h-9"
                disabled={changeWindowMutation.isPending}
              >
                {changeWindowMutation.isPending ? 'Saving…' : 'Save window'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
