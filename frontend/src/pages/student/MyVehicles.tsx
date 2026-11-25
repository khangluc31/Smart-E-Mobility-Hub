// Student My Private EVs page (FR-25, FR-26, FR-27, FR-28, BR-14, NFR-05/08/28).

import { useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Car, CheckCircle2, Pencil, PlugZap, Plus, Trash2 } from 'lucide-react';
import { ApiError } from '@/lib/api';
import { PARKING_MAX_WINDOW_H } from '@/lib/constants';
import { useHubs } from '@/hooks/useHubs';
import {
  useBookParkingAndCharging,
  useCreatePrivateEv,
  usePrivateEvs,
  useRemovePrivateEv,
  useUpdatePrivateEv,
} from '@/hooks/usePrivateEvs';
import type { Alternative } from '@/types/common';
import { PRIVATE_EV_TYPES, type PrivateEvType, type VehicleClass } from '@/types/enums';
import type { CombinedBookingResult, PrivateEv } from '@/types/privateEvs';
import { BatteryBar } from '@/components/common/BatteryBar';
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

const EV_TYPE_LABEL: Record<PrivateEvType, string> = {
  E_MOTORCYCLE: 'E-Motorcycle',
  CAR: 'Car',
};

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

function combinedErrorTitle(err: unknown): string {
  if (err instanceof ApiError && err.details && typeof err.details.missing === 'string') {
    const missing = err.details.missing;
    if (missing === 'PARKING') return 'No parking capacity available';
    if (missing === 'CHARGING') return 'No charging capacity available';
  }
  return 'Could not complete combined booking';
}

export function MyVehicles() {
  const { data: evs, isLoading, error } = usePrivateEvs();
  const { data: hubs } = useHubs();

  const createMutation = useCreatePrivateEv();
  const updateMutation = useUpdatePrivateEv();
  const removeMutation = useRemovePrivateEv();
  const combinedMutation = useBookParkingAndCharging();

  const hubNamesById = useMemo(() => {
    const map = new Map<string, string>();
    for (const h of hubs ?? []) map.set(h.id, h.name);
    return map;
  }, [hubs]);

  // Add form state (FR-25)
  const [addType, setAddType] = useState<PrivateEvType>('E_MOTORCYCLE');
  const [addLabel, setAddLabel] = useState<string>('');
  const [addCapacity, setAddCapacity] = useState<string>('');
  const [addBattery, setAddBattery] = useState<string>('80');

  // Edit dialog state (FR-26)
  const [editTarget, setEditTarget] = useState<PrivateEv | null>(null);
  const [editLabel, setEditLabel] = useState<string>('');
  const [editType, setEditType] = useState<PrivateEvType>('E_MOTORCYCLE');
  const [editCapacity, setEditCapacity] = useState<string>('');
  const [editBattery, setEditBattery] = useState<string>('');

  // Remove dialog state (FR-27)
  const [removeTarget, setRemoveTarget] = useState<PrivateEv | null>(null);

  // Combined parking + charging dialog state (FR-28)
  const [combinedTarget, setCombinedTarget] = useState<PrivateEv | null>(null);
  const [combHubId, setCombHubId] = useState<string>('');
  const [combWindowStart, setCombWindowStart] = useState<string>('');
  const [combWindowEnd, setCombWindowEnd] = useState<string>('');
  const [combTargetPct, setCombTargetPct] = useState<string>('80');
  const [combChargeStart, setCombChargeStart] = useState<string>('');
  const [combinedResult, setCombinedResult] = useState<CombinedBookingResult | null>(null);

  const combinedIdemKeyRef = useRef<string>(crypto.randomUUID());
  function resetCombinedIdemKey() {
    combinedIdemKeyRef.current = crypto.randomUUID();
  }

  function openCombinedDialog(ev: PrivateEv) {
    combinedMutation.reset();
    resetCombinedIdemKey();
    setCombinedResult(null);
    setCombinedTarget(ev);
    setCombHubId(hubs?.[0]?.id ?? '');
    const now = Date.now();
    setCombWindowStart(toLocalDateTimeInput(new Date(now + 15 * 60_000)));
    setCombWindowEnd(toLocalDateTimeInput(new Date(now + 135 * 60_000)));
    setCombTargetPct(String(Math.min(100, Math.max(80, ev.batteryPct + 10))));
    setCombChargeStart('');
  }

  function handleCombinedAlternative(alt: Alternative) {
    if (alt.type === 'hub' && alt.hubId) {
      setCombHubId(alt.hubId);
      combinedMutation.reset();
      resetCombinedIdemKey();
      return;
    }

    if (alt.type === 'time' && alt.start) {
      const altStartDate = new Date(alt.start);
      if (Number.isNaN(altStartDate.getTime())) return;
      setCombChargeStart(toLocalDateTimeInput(altStartDate));

      const curStartMs = Date.parse(localInputToIso(combWindowStart) ?? '');
      const curEndMs = Date.parse(localInputToIso(combWindowEnd) ?? '');
      const altStartMs = altStartDate.getTime();
      const altEndDate = alt.end ? new Date(alt.end) : null;
      const altEndMs = altEndDate && !Number.isNaN(altEndDate.getTime()) ? altEndDate.getTime() : NaN;

      let nextStartMs = Number.isFinite(curStartMs) ? curStartMs : altStartMs;
      let nextEndMs = Number.isFinite(curEndMs) ? curEndMs : altStartMs + 120 * 60_000;

      if (altStartMs < nextStartMs) {
        nextStartMs = altStartMs;
      }
      if (Number.isFinite(altEndMs) && altEndMs > nextEndMs) {
        nextEndMs = altEndMs;
        // Keep window within PARKING_MAX_WINDOW_H by shifting windowStart forward to alt.start if needed
        if (nextEndMs - nextStartMs > PARKING_MAX_WINDOW_H * 3_600_000) {
          nextStartMs = altStartMs;
        }
      }

      setCombWindowStart(toLocalDateTimeInput(new Date(nextStartMs)));
      setCombWindowEnd(toLocalDateTimeInput(new Date(nextEndMs)));
      combinedMutation.reset();
      resetCombinedIdemKey();
    }
  }

  async function handleCombinedSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!combinedTarget) return;
    const windowStartIso = localInputToIso(combWindowStart);
    const windowEndIso = localInputToIso(combWindowEnd);
    const chargeStartIso = localInputToIso(combChargeStart);
    if (!windowStartIso || !windowEndIso) return;

    try {
      const result = await combinedMutation.mutateAsync({
        evId: combinedTarget.id,
        hubId: combHubId || hubs?.[0]?.id || '',
        windowStart: windowStartIso,
        windowEnd: windowEndIso,
        targetPct: Number(combTargetPct),
        ...(chargeStartIso ? { chargeStart: chargeStartIso } : {}),
        idempotencyKey: combinedIdemKeyRef.current,
      });
      resetCombinedIdemKey();
      setCombinedResult(result);
    } catch {
      // Displayed via ErrorBox
    }
  }

  async function handleAddSubmit(e: React.FormEvent) {
    e.preventDefault();
    try {
      await createMutation.mutateAsync({
        type: addType,
        label: addLabel.trim(),
        batteryCapacityKwh: Number(addCapacity),
        batteryPct: Number(addBattery),
      });
      setAddLabel('');
      setAddCapacity('');
      setAddBattery('80');
    } catch {
      // Displayed via ErrorBox
    }
  }

  function openEditDialog(ev: PrivateEv) {
    updateMutation.reset();
    setEditTarget(ev);
    setEditLabel(ev.label);
    setEditType(ev.type);
    setEditCapacity(String(ev.batteryCapacityKwh));
    setEditBattery(String(ev.batteryPct));
  }

  async function handleEditSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!editTarget) return;
    try {
      await updateMutation.mutateAsync({
        id: editTarget.id,
        label: editLabel.trim(),
        type: editType,
        batteryCapacityKwh: Number(editCapacity),
        batteryPct: Number(editBattery),
      });
      setEditTarget(null);
    } catch {
      // Displayed via ErrorBox
    }
  }

  async function handleConfirmRemove() {
    if (!removeTarget) return;
    try {
      await removeMutation.mutateAsync(removeTarget.id);
      setRemoveTarget(null);
    } catch {
      // Displayed via ErrorBox
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold tracking-tight">My Private EVs</h1>
        <p className="text-xs text-muted-foreground">
          Register and manage your own electric vehicles for parking and charging bookings.
        </p>
      </div>

      {/* Add Private EV Form (FR-25) */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Plus className="h-4 w-4 shrink-0" />
            <span>Register a Private EV</span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleAddSubmit} className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="add-ev-type">Type</Label>
                <Select value={addType} onValueChange={(v) => setAddType(v as PrivateEvType)}>
                  <SelectTrigger id="add-ev-type" className="w-full min-h-9">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PRIVATE_EV_TYPES.map((t) => (
                      <SelectItem key={t} value={t}>
                        {EV_TYPE_LABEL[t]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="add-ev-label">Label</Label>
                <Input
                  id="add-ev-label"
                  placeholder="e.g. My VinFast Klara"
                  value={addLabel}
                  onChange={(e) => setAddLabel(e.target.value)}
                  className="min-h-9"
                  required
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="add-ev-capacity">Battery capacity (kWh)</Label>
                <Input
                  id="add-ev-capacity"
                  type="number"
                  step="any"
                  min={0.1}
                  placeholder="e.g. 3.5"
                  value={addCapacity}
                  onChange={(e) => setAddCapacity(e.target.value)}
                  className="min-h-9"
                  required
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="add-ev-battery">Current battery (%)</Label>
                <Input
                  id="add-ev-battery"
                  type="number"
                  min={0}
                  max={100}
                  value={addBattery}
                  onChange={(e) => setAddBattery(e.target.value)}
                  className="min-h-9"
                  required
                />
              </div>
            </div>

            {Boolean(createMutation.error) && (
              <ErrorBox error={createMutation.error} title="Could not register EV" />
            )}

            <Button type="submit" className="min-h-9" disabled={createMutation.isPending}>
              {createMutation.isPending ? 'Adding…' : 'Add Private EV'}
            </Button>
          </form>
        </CardContent>
      </Card>

      {/* Registered EVs List */}
      <section className="space-y-3">
        <h2 className="text-base font-semibold flex items-center gap-2">
          <Car className="h-4 w-4" />
          <span>Registered vehicles</span>
        </h2>

        {Boolean(error) && <ErrorBox error={error} title="Could not load your vehicles" />}

        {isLoading && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3" aria-busy="true">
            <Skeleton className="h-36 w-full" />
            <Skeleton className="h-36 w-full" />
          </div>
        )}

        {!isLoading && !error && evs && evs.length === 0 && (
          <Card>
            <CardContent className="py-6 text-center text-sm text-muted-foreground">
              No Private EVs registered yet. Add one above to use it for parking bookings.
            </CardContent>
          </Card>
        )}

        {!isLoading && evs && evs.length > 0 && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {evs.map((ev) => (
              <Card key={ev.id} className="flex flex-col justify-between">
                <CardHeader className="pb-2 space-y-1.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <CardTitle className="text-base">{ev.label}</CardTitle>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge variant="secondary">{CLASS_LABEL[ev.vehicleClass]}</Badge>
                      {ev.hasActiveBooking && (
                        <Badge
                          variant="outline"
                          className="border-amber-300 bg-amber-50 text-amber-800"
                        >
                          Active booking
                        </Badge>
                      )}
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {EV_TYPE_LABEL[ev.type]} · {ev.batteryCapacityKwh} kWh
                  </p>
                </CardHeader>

                <CardContent className="space-y-3">
                  <BatteryBar pct={ev.batteryPct} />

                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="min-h-9 flex-1 sm:flex-none"
                      onClick={() => openEditDialog(ev)}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                      <span>Edit</span>
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="destructive"
                      className="min-h-9 flex-1 sm:flex-none"
                      onClick={() => {
                        removeMutation.reset();
                        setRemoveTarget(ev);
                      }}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      <span>Remove</span>
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      className="min-h-9 w-full sm:w-auto"
                      onClick={() => openCombinedDialog(ev)}
                    >
                      <PlugZap className="h-3.5 w-3.5" />
                      <span>Book parking + charging</span>
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </section>

      {/* Edit EV Dialog (FR-26) */}
      <Dialog open={Boolean(editTarget)} onOpenChange={(open) => !open && setEditTarget(null)}>
        <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Edit Private EV</DialogTitle>
            <DialogDescription>
              Update your vehicle details. Changes apply to future bookings.
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={handleEditSubmit} className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="edit-ev-label">Label</Label>
              <Input
                id="edit-ev-label"
                value={editLabel}
                onChange={(e) => setEditLabel(e.target.value)}
                className="min-h-9"
                required
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="edit-ev-type">Type</Label>
              <Select value={editType} onValueChange={(v) => setEditType(v as PrivateEvType)}>
                <SelectTrigger id="edit-ev-type" className="w-full min-h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PRIVATE_EV_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>
                      {EV_TYPE_LABEL[t]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {editTarget?.hasActiveBooking && (
                <p className="text-xs text-amber-700">
                  Can&apos;t change while a booking is active
                </p>
              )}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="edit-ev-capacity">Capacity (kWh)</Label>
                <Input
                  id="edit-ev-capacity"
                  type="number"
                  step="any"
                  min={0.1}
                  value={editCapacity}
                  onChange={(e) => setEditCapacity(e.target.value)}
                  className="min-h-9"
                  required
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="edit-ev-battery">Battery (%)</Label>
                <Input
                  id="edit-ev-battery"
                  type="number"
                  min={0}
                  max={100}
                  value={editBattery}
                  onChange={(e) => setEditBattery(e.target.value)}
                  className="min-h-9"
                  required
                />
              </div>
            </div>

            {Boolean(updateMutation.error) && (
              <ErrorBox error={updateMutation.error} title="Could not update EV" />
            )}

            <DialogFooter className="gap-2">
              <Button
                type="button"
                variant="outline"
                className="min-h-9"
                onClick={() => setEditTarget(null)}
                disabled={updateMutation.isPending}
              >
                Cancel
              </Button>
              <Button type="submit" className="min-h-9" disabled={updateMutation.isPending}>
                {updateMutation.isPending ? 'Saving…' : 'Save changes'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Remove EV Confirm Dialog (FR-27) */}
      <Dialog open={Boolean(removeTarget)} onOpenChange={(open) => !open && setRemoveTarget(null)}>
        <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Remove Private EV?</DialogTitle>
            <DialogDescription>
              Remove <strong>{removeTarget?.label}</strong> from your registered vehicles? This
              cannot be undone if you have no active booking.
            </DialogDescription>
          </DialogHeader>

          {Boolean(removeMutation.error) && (
            <ErrorBox error={removeMutation.error} title="Could not remove EV" />
          )}

          <DialogFooter className="gap-2">
            <Button
              type="button"
              variant="outline"
              className="min-h-9"
              onClick={() => setRemoveTarget(null)}
              disabled={removeMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              className="min-h-9"
              onClick={handleConfirmRemove}
              disabled={removeMutation.isPending}
            >
              {removeMutation.isPending ? 'Removing…' : 'Yes, remove'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Combined Parking + Charging Dialog (FR-28, BR-14) */}
      <Dialog
        open={Boolean(combinedTarget)}
        onOpenChange={(open) => {
          if (!open) {
            setCombinedTarget(null);
            setCombinedResult(null);
          }
        }}
      >
        <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <PlugZap className="h-4 w-4 shrink-0" />
              <span>Book parking + charging</span>
            </DialogTitle>
            {combinedTarget && (
              <DialogDescription asChild>
                <div className="flex flex-wrap items-center gap-2 pt-1 text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">{combinedTarget.label}</span>
                  <Badge variant="secondary">{CLASS_LABEL[combinedTarget.vehicleClass]}</Badge>
                  <BatteryBar pct={combinedTarget.batteryPct} />
                </div>
              </DialogDescription>
            )}
          </DialogHeader>

          {combinedResult ? (
            <div className="space-y-4">
              <div className="rounded-md border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-950 space-y-2">
                <p className="font-semibold flex items-center gap-1.5">
                  <CheckCircle2 className="h-4 w-4 text-emerald-700 shrink-0" />
                  <span>Parking &amp; charging booked together</span>
                </p>
                <p className="text-xs">
                  <span className="font-medium">Booking group: </span>
                  <span className="font-mono break-all">{combinedResult.bookingGroupId}</span>
                </p>
                <div className="text-xs space-y-1 pt-1 border-t border-emerald-200">
                  <p>
                    <span className="font-medium">Hub: </span>
                    {hubNamesById.get(combinedResult.parkingReservation.hubId) ??
                      combinedResult.parkingReservation.hubId}
                  </p>
                  <p>
                    <span className="font-medium">Parking space: </span>
                    <span className="font-mono">
                      {combinedResult.parkingReservation.parkingSpaceId}
                    </span>{' '}
                    ({formatLocalDateTime(combinedResult.parkingReservation.windowStart)} –{' '}
                    {formatLocalTime(combinedResult.parkingReservation.windowEnd)})
                  </p>
                  <p>
                    <span className="font-medium">Charging point: </span>
                    <span className="font-mono">
                      {combinedResult.chargingRequest.chargingPointId ?? 'Assigned'}
                    </span>
                    {combinedResult.chargingRequest.slotStart &&
                      combinedResult.chargingRequest.slotEnd && (
                        <>
                          {' '}
                          ({formatLocalDateTime(combinedResult.chargingRequest.slotStart)} –{' '}
                          {formatLocalTime(combinedResult.chargingRequest.slotEnd)})
                        </>
                      )}
                  </p>
                </div>
              </div>

              <DialogFooter className="flex-col-reverse sm:flex-row gap-2">
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-9"
                  onClick={() => {
                    setCombinedTarget(null);
                    setCombinedResult(null);
                  }}
                >
                  Close
                </Button>
                <Button asChild variant="outline" className="min-h-9">
                  <Link to="/app/reservations">View reservations</Link>
                </Button>
                <Button asChild className="min-h-9">
                  <Link to="/app/charging">View charging</Link>
                </Button>
              </DialogFooter>
            </div>
          ) : (
            <form onSubmit={handleCombinedSubmit} className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="comb-hub">Hub</Label>
                <Select
                  value={combHubId || hubs?.[0]?.id || ''}
                  onValueChange={(v) => {
                    setCombHubId(v);
                    combinedMutation.reset();
                    resetCombinedIdemKey();
                  }}
                >
                  <SelectTrigger id="comb-hub" className="w-full min-h-9">
                    <SelectValue placeholder="Choose a Hub" />
                  </SelectTrigger>
                  <SelectContent>
                    {(hubs ?? []).map((h) => (
                      <SelectItem key={h.id} value={h.id}>
                        {h.name}
                        {h.degraded ? ' (Degraded)' : ''}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="comb-start">Parking start</Label>
                  <Input
                    id="comb-start"
                    type="datetime-local"
                    value={combWindowStart}
                    onChange={(e) => {
                      setCombWindowStart(e.target.value);
                      combinedMutation.reset();
                      resetCombinedIdemKey();
                    }}
                    className="min-h-9"
                    required
                  />
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="comb-end">Parking end</Label>
                  <Input
                    id="comb-end"
                    type="datetime-local"
                    value={combWindowEnd}
                    onChange={(e) => {
                      setCombWindowEnd(e.target.value);
                      combinedMutation.reset();
                      resetCombinedIdemKey();
                    }}
                    className="min-h-9"
                    required
                  />
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                Parking window max {PARKING_MAX_WINDOW_H} hours. Both parking and charging must
                succeed together (all-or-nothing).
              </p>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="comb-target">Target battery (%)</Label>
                  <Input
                    id="comb-target"
                    type="number"
                    min={1}
                    max={100}
                    value={combTargetPct}
                    onChange={(e) => {
                      setCombTargetPct(e.target.value);
                      combinedMutation.reset();
                      resetCombinedIdemKey();
                    }}
                    className="min-h-9"
                    required
                  />
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="comb-charge-start">Charge start (optional)</Label>
                  <Input
                    id="comb-charge-start"
                    type="datetime-local"
                    value={combChargeStart}
                    onChange={(e) => {
                      setCombChargeStart(e.target.value);
                      combinedMutation.reset();
                      resetCombinedIdemKey();
                    }}
                    className="min-h-9"
                  />
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                Defaults to parking start; must be in the future and inside the parking window.
              </p>

              {Boolean(combinedMutation.error) && (
                <ErrorBox
                  error={combinedMutation.error}
                  title={combinedErrorTitle(combinedMutation.error)}
                  onSelectAlternative={handleCombinedAlternative}
                />
              )}

              <DialogFooter className="flex-col-reverse sm:flex-row gap-2 pt-2">
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-9"
                  onClick={() => setCombinedTarget(null)}
                  disabled={combinedMutation.isPending}
                >
                  Cancel
                </Button>
                <Button type="submit" className="min-h-9" disabled={combinedMutation.isPending}>
                  {combinedMutation.isPending ? 'Booking…' : 'Book parking + charging'}
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
