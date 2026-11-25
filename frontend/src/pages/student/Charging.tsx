// Student Charging page: live requests, queue submission (Private EV + D-13 Rental),
// advance slot availability & booking, stop & cancel (FR-20–FR-24, BR-06/10/13, NFR-02/04/05/08/28).

import { useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowRight,
  CalendarClock,
  CheckCircle2,
  Clock,
  PlugZap,
  RefreshCw,
  StopCircle,
  XCircle,
} from 'lucide-react';
import { CHARGE_AFTER_RETURN_MIN } from '@/lib/constants';
import { useHubs } from '@/hooks/useHubs';
import { usePrivateEvs } from '@/hooks/usePrivateEvs';
import { useHistory } from '@/hooks/useReservations';
import {
  useBookAdvanceCharging,
  useCancelChargingRequest,
  useChargingAvailability,
  useMyChargingRequests,
  useStopChargingRequest,
  useSubmitChargingRequest,
  type ChargingAvailabilityParams,
} from '@/hooks/useCharging';
import { useServerNowMs } from '@/hooks/useServerClock';
import type { Alternative } from '@/types/common';
import type { ChargingEndReason, ChargingVehicleKind, VehicleClass } from '@/types/enums';
import type { ChargingRequestView } from '@/types/charging';
import type { VehicleReservation } from '@/types/reservations';
import { StatusBadge } from '@/components/common/StatusBadge';
import { BatteryBar } from '@/components/common/BatteryBar';
import { ErrorBox } from '@/components/common/ErrorBox';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
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

const END_REASON_LABEL: Record<ChargingEndReason, string> = {
  TARGET_REACHED: 'Target reached',
  USER_STOP: 'Stopped by user',
  POINT_FAILURE: 'Charging point fault',
  VEHICLE_FAULT: 'Vehicle fault',
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

function formatRemaining(targetIso: string, serverNowMs: number): string | null {
  const targetMs = Date.parse(targetIso);
  if (!Number.isFinite(targetMs)) return null;
  const diffMin = Math.ceil((targetMs - serverNowMs) / 60_000);
  if (diffMin <= 0) return 'any moment';
  if (diffMin < 60) return `~${diffMin} min`;
  const h = Math.floor(diffMin / 60);
  const m = diffMin % 60;
  return m > 0 ? `~${h}h ${m}m` : `~${h}h`;
}

function defaultTargetPct(currentPct: number): string {
  return String(Math.min(100, Math.max(80, currentPct + 10)));
}

export function Charging() {
  const [activeTab, setActiveTab] = useState<'requests' | 'queue' | 'advance'>('requests');
  const [activeOnly, setActiveOnly] = useState<boolean>(true);
  const [successBanner, setSuccessBanner] = useState<string | null>(null);

  const serverNowMs = useServerNowMs(1000);

  const { data: hubs } = useHubs();
  const { data: privateEvs, isLoading: isLoadingEvs } = usePrivateEvs();
  const {
    data: requests,
    isLoading: isLoadingRequests,
    error: requestsError,
  } = useMyChargingRequests(activeOnly);

  const completedRentalsQuery = useHistory({ type: 'vehicle', status: 'COMPLETED' });

  const submitMutation = useSubmitChargingRequest();
  const advanceMutation = useBookAdvanceCharging();
  const stopMutation = useStopChargingRequest();
  const cancelMutation = useCancelChargingRequest();

  const hubNamesById = useMemo(() => {
    const map = new Map<string, string>();
    for (const h of hubs ?? []) map.set(h.id, h.name);
    return map;
  }, [hubs]);

  const evById = useMemo(() => {
    const map = new Map<string, NonNullable<typeof privateEvs>[number]>();
    for (const ev of privateEvs ?? []) map.set(ev.id, ev);
    return map;
  }, [privateEvs]);

  const completedRentals = useMemo<VehicleReservation[]>(() => {
    const pages = completedRentalsQuery.data?.pages ?? [];
    const list: VehicleReservation[] = [];
    for (const page of pages) {
      for (const entry of page.items) {
        if (entry.kind === 'vehicle') list.push(entry.item);
      }
    }
    return list;
  }, [completedRentalsQuery.data]);

  const recentWindowMs = CHARGE_AFTER_RETURN_MIN * 60_000;

  // ---- Cancel / Stop confirmation dialog state ----
  const [cancelTarget, setCancelTarget] = useState<ChargingRequestView | null>(null);
  const [stopTarget, setStopTarget] = useState<ChargingRequestView | null>(null);

  // ---- Join Queue form state (FR-20, D-13) ----
  const [queueKind, setQueueKind] = useState<ChargingVehicleKind>('PRIVATE');
  const [queueEvId, setQueueEvId] = useState<string>('');
  const [queueRentalId, setQueueRentalId] = useState<string>('');
  const [queueHubId, setQueueHubId] = useState<string>('');
  const [queueTargetPct, setQueueTargetPct] = useState<string>('80');
  const [queueDesiredLocal, setQueueDesiredLocal] = useState<string>('');
  const [queueNeededByLocal, setQueueNeededByLocal] = useState<string>('');

  const resolvedQueueEvId = queueEvId || privateEvs?.[0]?.id || '';
  const resolvedQueueHubId = queueHubId || hubs?.[0]?.id || '';

  // ---- Advance Booking form state (FR-21) ----
  const [advEvId, setAdvEvId] = useState<string>('');
  const [advHubId, setAdvHubId] = useState<string>('');
  const [advSlotStartLocal, setAdvSlotStartLocal] = useState<string>(() =>
    toLocalDateTimeInput(new Date(Date.now() + 30 * 60_000)),
  );
  const [advTargetPct, setAdvTargetPct] = useState<string>('80');

  const resolvedAdvEvId = advEvId || privateEvs?.[0]?.id || '';
  const resolvedAdvHubId = advHubId || hubs?.[0]?.id || '';

  const advIdemKeyRef = useRef<string>(crypto.randomUUID());
  function resetAdvIdemKey() {
    advIdemKeyRef.current = crypto.randomUUID();
  }

  const advAvailabilityParams = useMemo<ChargingAvailabilityParams | null>(() => {
    const slotStartIso = localInputToIso(advSlotStartLocal);
    const pct = Number(advTargetPct);
    if (!resolvedAdvHubId || !resolvedAdvEvId || !slotStartIso || !Number.isFinite(pct)) {
      return null;
    }
    return {
      hubId: resolvedAdvHubId,
      privateEvId: resolvedAdvEvId,
      slotStart: slotStartIso,
      targetPct: pct,
    };
  }, [resolvedAdvHubId, resolvedAdvEvId, advSlotStartLocal, advTargetPct]);

  const availabilityQuery = useChargingAvailability(advAvailabilityParams);

  function handleSelectQueueEv(evId: string) {
    setQueueEvId(evId);
    const ev = evById.get(evId);
    if (ev) setQueueTargetPct(defaultTargetPct(ev.batteryPct));
    submitMutation.reset();
  }

  function handleSelectReturnedRental(res: VehicleReservation) {
    setQueueRentalId(res.vehicle.id);
    setQueueHubId(res.returnHubId ?? res.hubId);
    setQueueTargetPct(defaultTargetPct(res.endBatteryPct ?? res.vehicle.batteryPct));
    submitMutation.reset();
  }

  async function handleQueueSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSuccessBanner(null);
    const targetPct = Number(queueTargetPct);

    try {
      let created: ChargingRequestView;
      if (queueKind === 'PRIVATE') {
        const desiredIso = localInputToIso(queueDesiredLocal);
        const neededIso = localInputToIso(queueNeededByLocal);
        created = await submitMutation.mutateAsync({
          vehicleKind: 'PRIVATE',
          privateEvId: resolvedQueueEvId,
          hubId: resolvedQueueHubId,
          targetPct,
          ...(desiredIso ? { desiredTime: desiredIso } : {}),
          ...(neededIso ? { neededBy: neededIso } : {}),
        });
      } else {
        const neededIso = localInputToIso(queueNeededByLocal);
        created = await submitMutation.mutateAsync({
          vehicleKind: 'RENTAL',
          rentalVehicleId: queueRentalId.trim(),
          hubId: resolvedQueueHubId,
          targetPct,
          ...(neededIso ? { neededBy: neededIso } : {}),
        });
      }

      setQueueDesiredLocal('');
      setQueueNeededByLocal('');
      setActiveOnly(true);
      setActiveTab('requests');
      setSuccessBanner(
        `Charging request submitted at ${hubNamesById.get(created.hubId) ?? created.hubId} (status: ${created.status}).`,
      );
    } catch {
      // Displayed via ErrorBox
    }
  }

  function handleAdvAlternative(alt: Alternative) {
    if (alt.type === 'time' && alt.start) {
      setAdvSlotStartLocal(toLocalDateTimeInput(new Date(alt.start)));
      advanceMutation.reset();
      resetAdvIdemKey();
    } else if (alt.type === 'hub' && alt.hubId) {
      setAdvHubId(alt.hubId);
      advanceMutation.reset();
      resetAdvIdemKey();
    }
  }

  function handleSelectAdvEv(evId: string) {
    setAdvEvId(evId);
    const ev = evById.get(evId);
    if (ev) setAdvTargetPct(defaultTargetPct(ev.batteryPct));
    advanceMutation.reset();
    resetAdvIdemKey();
  }

  async function handleAdvSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSuccessBanner(null);
    const slotStartIso = localInputToIso(advSlotStartLocal);
    if (!slotStartIso) return;

    try {
      const created = await advanceMutation.mutateAsync({
        privateEvId: resolvedAdvEvId,
        hubId: resolvedAdvHubId,
        slotStart: slotStartIso,
        targetPct: Number(advTargetPct),
        idempotencyKey: advIdemKeyRef.current,
      });
      resetAdvIdemKey();
      setActiveOnly(true);
      setActiveTab('requests');
      setSuccessBanner(
        `Advance slot booked at ${hubNamesById.get(created.hubId) ?? created.hubId}${created.chargingPointId ? ` (point ${created.chargingPointId})` : ''}${created.slotStart && created.slotEnd ? `, ${formatLocalDateTime(created.slotStart)} – ${formatLocalTime(created.slotEnd)}` : ''}.`,
      );
    } catch {
      // Displayed via ErrorBox
    }
  }

  async function handleConfirmCancel() {
    if (!cancelTarget) return;
    try {
      await cancelMutation.mutateAsync(cancelTarget.id);
      setCancelTarget(null);
      setSuccessBanner('Charging request cancelled.');
    } catch {
      // Displayed via ErrorBox inside dialog
    }
  }

  async function handleConfirmStop() {
    if (!stopTarget) return;
    try {
      await stopMutation.mutateAsync(stopTarget.id);
      setStopTarget(null);
      setSuccessBanner('Charging session stopped.');
    } catch {
      // Displayed via ErrorBox inside dialog
    }
  }

  return (
    <div className="space-y-5 min-w-0">
      <div>
        <h1 className="text-xl font-bold tracking-tight">Charging</h1>
        <p className="text-xs text-muted-foreground">
          Monitor live charging sessions, join a Hub queue, or book a guaranteed advance slot.
        </p>
      </div>

      {successBanner && (
        <div
          role="status"
          className="flex items-start gap-2 rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2.5 text-sm text-emerald-900"
        >
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-700" />
          <span className="min-w-0 flex-1 break-words">{successBanner}</span>
          <button
            type="button"
            onClick={() => setSuccessBanner(null)}
            className="text-xs font-medium underline underline-offset-2 shrink-0"
          >
            Dismiss
          </button>
        </div>
      )}

      <Tabs
        value={activeTab}
        onValueChange={(v) => setActiveTab(v as 'requests' | 'queue' | 'advance')}
        className="space-y-4"
      >
        <TabsList className="grid w-full grid-cols-3 h-auto">
          <TabsTrigger value="requests" className="min-h-9 text-xs sm:text-sm">
            My Requests
          </TabsTrigger>
          <TabsTrigger value="queue" className="min-h-9 text-xs sm:text-sm">
            Join Queue
          </TabsTrigger>
          <TabsTrigger value="advance" className="min-h-9 text-xs sm:text-sm">
            Advance Slot
          </TabsTrigger>
        </TabsList>

        {/* ================================================================ */}
        {/* TAB 1: My Charging Requests (FR-22, FR-23, FR-24)                */}
        {/* ================================================================ */}
        <TabsContent value="requests" className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="inline-flex rounded-md border p-0.5 bg-muted/40">
              <Button
                type="button"
                size="sm"
                variant={activeOnly ? 'default' : 'ghost'}
                className="min-h-9 px-3 text-xs"
                onClick={() => setActiveOnly(true)}
              >
                Active
              </Button>
              <Button
                type="button"
                size="sm"
                variant={!activeOnly ? 'default' : 'ghost'}
                className="min-h-9 px-3 text-xs"
                onClick={() => setActiveOnly(false)}
              >
                All
              </Button>
            </div>
            <span className="text-xs text-muted-foreground">Auto-refreshes every 5 s</span>
          </div>

          {Boolean(requestsError) && (
            <ErrorBox error={requestsError} title="Could not load charging requests" />
          )}

          {isLoadingRequests && (
            <div className="space-y-3" aria-busy="true">
              <Skeleton className="h-36 w-full" />
              <Skeleton className="h-36 w-full" />
            </div>
          )}

          {!isLoadingRequests && !requestsError && requests && requests.length === 0 && (
            <Card>
              <CardContent className="py-8 text-center space-y-3">
                <p className="text-sm text-muted-foreground">
                  {activeOnly
                    ? 'You have no active charging requests right now.'
                    : 'No charging requests yet.'}
                </p>
                <div className="flex flex-wrap justify-center gap-2">
                  <Button
                    type="button"
                    size="sm"
                    className="min-h-9"
                    onClick={() => setActiveTab('queue')}
                  >
                    <PlugZap className="h-4 w-4" />
                    <span>Join Queue</span>
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="min-h-9"
                    onClick={() => setActiveTab('advance')}
                  >
                    <CalendarClock className="h-4 w-4" />
                    <span>Book Advance Slot</span>
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}

          {!isLoadingRequests && requests && requests.length > 0 && (
            <div className="space-y-3">
              {requests.map((req) => {
                const isFinished = req.status === 'COMPLETED' || req.status === 'CANCELLED';
                const canCancel = req.status === 'QUEUED' || req.status === 'SCHEDULED';
                const canStop = req.status === 'CHARGING';
                const hubName = hubNamesById.get(req.hubId) ?? req.hubId;
                const vehicleLabel =
                  req.vehicleKind === 'PRIVATE'
                    ? (evById.get(req.privateEvId ?? '')?.label ?? req.privateEvId ?? 'Private EV')
                    : `Rental ${req.rentalVehicleId ?? ''}`;
                const displayPct = req.finalPct ?? req.currentPct;

                return (
                  <Card key={req.id} className="min-w-0">
                    <CardHeader className="pb-2 space-y-2">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex flex-wrap items-center gap-1.5 min-w-0">
                          <StatusBadge kind="chargingRequest" value={req.status} />
                          <Badge variant="outline" className="text-xs">
                            {req.mode === 'ADVANCE' ? 'Advance' : 'Queue'}
                          </Badge>
                          <Badge variant="secondary" className="text-xs">
                            {CLASS_LABEL[req.vehicleClass]}
                          </Badge>
                        </div>
                        <span className="text-xs text-muted-foreground font-mono break-all">
                          {req.id.slice(0, 8)}
                        </span>
                      </div>
                      <div className="min-w-0">
                        <CardTitle className="text-base break-words">{vehicleLabel}</CardTitle>
                        <p className="text-xs text-muted-foreground break-words">{hubName}</p>
                      </div>
                    </CardHeader>

                    <CardContent className="space-y-3 text-sm">
                      <div className="space-y-1">
                        <BatteryBar pct={displayPct} />
                        <p className="text-xs text-muted-foreground">
                          {isFinished
                            ? `Start ${req.startPct}% → Final ${req.finalPct ?? req.currentPct}% (Target ${req.targetPct}%)`
                            : `Start ${req.startPct}% → Current ${req.currentPct}% → Target ${req.targetPct}%`}
                        </p>
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 text-xs text-muted-foreground">
                        {req.chargingPointId && (
                          <div>
                            <span className="font-medium text-foreground">Point: </span>
                            <span className="font-mono">{req.chargingPointId}</span>
                          </div>
                        )}

                        {req.status === 'QUEUED' && req.queuePosition !== null && (
                          <div>
                            <span className="font-medium text-foreground">Queue position: </span>#
                            {req.queuePosition}
                          </div>
                        )}

                        {req.status === 'SCHEDULED' && req.slotStart && req.slotEnd && (
                          <div className="sm:col-span-2">
                            <span className="font-medium text-foreground">Slot: </span>
                            {formatLocalDateTime(req.slotStart)} – {formatLocalTime(req.slotEnd)}
                          </div>
                        )}

                        {!isFinished && req.status !== 'SCHEDULED' && req.estimatedStart && (
                          <div>
                            <span className="font-medium text-foreground">Est. start: </span>
                            {formatLocalTime(req.estimatedStart)}
                            {req.status === 'QUEUED' && (
                              <span> ({formatRemaining(req.estimatedStart, serverNowMs)})</span>
                            )}
                          </div>
                        )}

                        {!isFinished && req.status !== 'SCHEDULED' && req.estimatedEnd && (
                          <div>
                            <span className="font-medium text-foreground">Est. finish: </span>
                            {formatLocalTime(req.estimatedEnd)} (
                            {formatRemaining(req.estimatedEnd, serverNowMs)})
                          </div>
                        )}

                        {req.status === 'COMPLETED' && req.endReason && (
                          <div className="sm:col-span-2">
                            <span className="font-medium text-foreground">End reason: </span>
                            <Badge variant="outline" className="text-xs ml-1">
                              {END_REASON_LABEL[req.endReason]}
                            </Badge>
                          </div>
                        )}
                      </div>

                      {(canCancel || canStop) && (
                        <div className="flex flex-wrap gap-2 pt-1">
                          {canCancel && (
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              className="min-h-9 w-full sm:w-auto"
                              onClick={() => {
                                cancelMutation.reset();
                                setCancelTarget(req);
                              }}
                            >
                              <XCircle className="h-4 w-4" />
                              <span>Cancel request</span>
                            </Button>
                          )}
                          {canStop && (
                            <Button
                              type="button"
                              size="sm"
                              variant="destructive"
                              className="min-h-9 w-full sm:w-auto"
                              onClick={() => {
                                stopMutation.reset();
                                setStopTarget(req);
                              }}
                            >
                              <StopCircle className="h-4 w-4" />
                              <span>Stop charging</span>
                            </Button>
                          )}
                        </div>
                      )}
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </TabsContent>

        {/* ================================================================ */}
        {/* TAB 2: Join Charging Queue (FR-20, D-13)                         */}
        {/* ================================================================ */}
        <TabsContent value="queue" className="space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <PlugZap className="h-4 w-4 shrink-0" />
                <span>Join Charging Queue</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant={queueKind === 'PRIVATE' ? 'default' : 'outline'}
                  className="min-h-9 text-xs sm:text-sm"
                  onClick={() => {
                    setQueueKind('PRIVATE');
                    submitMutation.reset();
                  }}
                >
                  My Private EV
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={queueKind === 'RENTAL' ? 'default' : 'outline'}
                  className="min-h-9 text-xs sm:text-sm"
                  onClick={() => {
                    setQueueKind('RENTAL');
                    submitMutation.reset();
                  }}
                >
                  Returned Rental
                </Button>
              </div>

              {queueKind === 'PRIVATE' && !isLoadingEvs && (privateEvs?.length ?? 0) === 0 ? (
                <div className="rounded-md border border-dashed p-4 text-center space-y-2">
                  <p className="text-sm text-muted-foreground">
                    You don&apos;t have any Private EVs registered yet.
                  </p>
                  <Button asChild size="sm" className="min-h-9">
                    <Link to="/app/my-vehicles">Register a Private EV</Link>
                  </Button>
                </div>
              ) : (
                <form onSubmit={handleQueueSubmit} className="space-y-4">
                  {queueKind === 'PRIVATE' ? (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div className="space-y-1.5">
                        <Label htmlFor="q-ev">Private EV</Label>
                        <Select value={resolvedQueueEvId} onValueChange={handleSelectQueueEv}>
                          <SelectTrigger id="q-ev" className="w-full min-h-9">
                            <SelectValue placeholder="Choose a Private EV" />
                          </SelectTrigger>
                          <SelectContent>
                            {(privateEvs ?? []).map((ev) => (
                              <SelectItem key={ev.id} value={ev.id}>
                                {ev.label} ({CLASS_LABEL[ev.vehicleClass]}, {ev.batteryPct}%)
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>

                      <div className="space-y-1.5">
                        <Label htmlFor="q-hub">Hub</Label>
                        <Select
                          value={resolvedQueueHubId}
                          onValueChange={(v) => {
                            setQueueHubId(v);
                            submitMutation.reset();
                          }}
                        >
                          <SelectTrigger id="q-hub" className="w-full min-h-9">
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
                    </div>
                  ) : (
                    <div className="space-y-3">
                      <p className="text-xs text-muted-foreground">
                        You can queue a rental vehicle you returned within the last{' '}
                        {CHARGE_AFTER_RETURN_MIN} minutes (D-13).
                      </p>

                      {completedRentals.length > 0 && (
                        <div className="space-y-1.5">
                          <Label>Recently returned rentals</Label>
                          <div className="space-y-1.5">
                            {completedRentals.slice(0, 5).map((res) => {
                              const returnedMs = res.returnedAt ? Date.parse(res.returnedAt) : NaN;
                              const isRecent =
                                Number.isFinite(returnedMs) &&
                                serverNowMs - returnedMs <= recentWindowMs;
                              const selected = queueRentalId === res.vehicle.id;
                              const returnHubName =
                                hubNamesById.get(res.returnHubId ?? res.hubId) ??
                                res.returnHubId ??
                                res.hubId;

                              return (
                                <button
                                  key={res.id}
                                  type="button"
                                  onClick={() => handleSelectReturnedRental(res)}
                                  className={`w-full min-h-9 rounded-md border px-3 py-2 text-left text-xs transition-colors ${
                                    selected
                                      ? 'border-primary bg-primary/5'
                                      : 'border-border hover:bg-muted/50'
                                  }`}
                                >
                                  <div className="flex flex-wrap items-center justify-between gap-1.5">
                                    <span className="font-medium font-mono">
                                      {res.vehicle.id}
                                    </span>
                                    <div className="flex flex-wrap items-center gap-1">
                                      {isRecent && (
                                        <Badge
                                          variant="outline"
                                          className="border-emerald-300 bg-emerald-50 text-emerald-800 text-[11px]"
                                        >
                                          Within {CHARGE_AFTER_RETURN_MIN} min
                                        </Badge>
                                      )}
                                      <span className="text-muted-foreground">{returnHubName}</span>
                                    </div>
                                  </div>
                                  {res.returnedAt && (
                                    <p className="text-[11px] text-muted-foreground mt-0.5">
                                      Returned {formatLocalDateTime(res.returnedAt)}
                                    </p>
                                  )}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      )}

                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div className="space-y-1.5">
                          <Label htmlFor="q-rental-id">Rental vehicle ID</Label>
                          <Input
                            id="q-rental-id"
                            placeholder="e.g. RV-M-001"
                            value={queueRentalId}
                            onChange={(e) => {
                              setQueueRentalId(e.target.value);
                              submitMutation.reset();
                            }}
                            className="min-h-9 font-mono"
                            required
                          />
                        </div>

                        <div className="space-y-1.5">
                          <Label htmlFor="q-rental-hub">Hub</Label>
                          <Select
                            value={resolvedQueueHubId}
                            onValueChange={(v) => {
                              setQueueHubId(v);
                              submitMutation.reset();
                            }}
                          >
                            <SelectTrigger id="q-rental-hub" className="w-full min-h-9">
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
                      </div>
                    </div>
                  )}

                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <div className="space-y-1.5">
                      <Label htmlFor="q-target">Target battery (%)</Label>
                      <Input
                        id="q-target"
                        type="number"
                        min={1}
                        max={100}
                        value={queueTargetPct}
                        onChange={(e) => setQueueTargetPct(e.target.value)}
                        className="min-h-9"
                        required
                      />
                    </div>

                    {queueKind === 'PRIVATE' && (
                      <div className="space-y-1.5">
                        <Label htmlFor="q-desired">Desired start (optional)</Label>
                        <Input
                          id="q-desired"
                          type="datetime-local"
                          value={queueDesiredLocal}
                          onChange={(e) => setQueueDesiredLocal(e.target.value)}
                          className="min-h-9"
                        />
                      </div>
                    )}

                    <div className="space-y-1.5">
                      <Label htmlFor="q-needed">Needed by (optional)</Label>
                      <Input
                        id="q-needed"
                        type="datetime-local"
                        value={queueNeededByLocal}
                        onChange={(e) => setQueueNeededByLocal(e.target.value)}
                        className="min-h-9"
                      />
                    </div>
                  </div>

                  {Boolean(submitMutation.error) && (
                    <ErrorBox error={submitMutation.error} title="Could not join charging queue" />
                  )}

                  <Button
                    type="submit"
                    className="min-h-9 w-full sm:w-auto"
                    disabled={
                      submitMutation.isPending ||
                      !resolvedQueueHubId ||
                      (queueKind === 'PRIVATE' ? !resolvedQueueEvId : !queueRentalId.trim())
                    }
                  >
                    {submitMutation.isPending ? 'Submitting…' : 'Join Queue'}
                  </Button>
                </form>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ================================================================ */}
        {/* TAB 3: Book Advance Slot (FR-21, Private EV only)                */}
        {/* ================================================================ */}
        <TabsContent value="advance" className="space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <CalendarClock className="h-4 w-4 shrink-0" />
                <span>Book an Advance Charging Slot</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {!isLoadingEvs && (privateEvs?.length ?? 0) === 0 ? (
                <div className="rounded-md border border-dashed p-4 text-center space-y-2">
                  <p className="text-sm text-muted-foreground">
                    Advance charging slots require a registered Private EV.
                  </p>
                  <Button asChild size="sm" className="min-h-9">
                    <Link to="/app/my-vehicles">Register a Private EV</Link>
                  </Button>
                </div>
              ) : (
                <form onSubmit={handleAdvSubmit} className="space-y-4">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <Label htmlFor="adv-ev">Private EV</Label>
                      <Select value={resolvedAdvEvId} onValueChange={handleSelectAdvEv}>
                        <SelectTrigger id="adv-ev" className="w-full min-h-9">
                          <SelectValue placeholder="Choose a Private EV" />
                        </SelectTrigger>
                        <SelectContent>
                          {(privateEvs ?? []).map((ev) => (
                            <SelectItem key={ev.id} value={ev.id}>
                              {ev.label} ({CLASS_LABEL[ev.vehicleClass]}, {ev.batteryPct}%)
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="space-y-1.5">
                      <Label htmlFor="adv-hub">Hub</Label>
                      <Select
                        value={resolvedAdvHubId}
                        onValueChange={(v) => {
                          setAdvHubId(v);
                          advanceMutation.reset();
                          resetAdvIdemKey();
                        }}
                      >
                        <SelectTrigger id="adv-hub" className="w-full min-h-9">
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

                    <div className="space-y-1.5">
                      <Label htmlFor="adv-start">Start time</Label>
                      <Input
                        id="adv-start"
                        type="datetime-local"
                        value={advSlotStartLocal}
                        onChange={(e) => {
                          setAdvSlotStartLocal(e.target.value);
                          advanceMutation.reset();
                          resetAdvIdemKey();
                        }}
                        className="min-h-9"
                        required
                      />
                    </div>

                    <div className="space-y-1.5">
                      <Label htmlFor="adv-target">Target battery (%)</Label>
                      <Input
                        id="adv-target"
                        type="number"
                        min={1}
                        max={100}
                        value={advTargetPct}
                        onChange={(e) => {
                          setAdvTargetPct(e.target.value);
                          advanceMutation.reset();
                          resetAdvIdemKey();
                        }}
                        className="min-h-9"
                        required
                      />
                    </div>
                  </div>

                  {/* Live availability status */}
                  {availabilityQuery.isFetching && (
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Clock className="h-3.5 w-3.5 animate-pulse" />
                      <span>Checking charging point availability…</span>
                    </div>
                  )}

                  {Boolean(availabilityQuery.error) && (
                    <ErrorBox
                      error={availabilityQuery.error}
                      title="Cannot check availability"
                      onSelectAlternative={handleAdvAlternative}
                    />
                  )}

                  {!availabilityQuery.isFetching &&
                    availabilityQuery.data &&
                    availabilityQuery.data.available && (
                      <div className="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2.5 text-xs text-emerald-900 space-y-1">
                        <p className="font-medium flex items-center gap-1.5">
                          <CheckCircle2 className="h-4 w-4 text-emerald-700 shrink-0" />
                          <span>Charging point available for this slot</span>
                        </p>
                        <p>
                          Slot:{' '}
                          <span className="font-medium">
                            {advAvailabilityParams
                              ? formatLocalDateTime(advAvailabilityParams.slotStart)
                              : ''}{' '}
                            – {formatLocalTime(availabilityQuery.data.slotEnd)}
                          </span>
                        </p>
                      </div>
                    )}

                  {!availabilityQuery.isFetching &&
                    availabilityQuery.data &&
                    !availabilityQuery.data.available && (
                      <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2.5 text-xs text-amber-950 space-y-2">
                        <p className="font-medium flex items-center gap-1.5">
                          <AlertTriangle className="h-4 w-4 text-amber-700 shrink-0" />
                          <span>No charging point of your vehicle&apos;s class is free then.</span>
                        </p>
                        {availabilityQuery.data.suggestions.length > 0 && (
                          <div className="space-y-1">
                            <p className="font-medium uppercase tracking-wide text-[11px] opacity-80">
                              Suggested alternatives
                            </p>
                            <ul className="space-y-1">
                              {availabilityQuery.data.suggestions.map((alt, idx) => {
                                const label =
                                  alt.type === 'hub'
                                    ? (alt.hubName ?? alt.hubId ?? 'Hub')
                                    : alt.start && alt.end
                                      ? `${formatLocalTime(alt.start)} – ${formatLocalTime(alt.end)}`
                                      : 'Alternative';
                                return (
                                  <li key={idx}>
                                    <button
                                      type="button"
                                      onClick={() => handleAdvAlternative(alt)}
                                      className="inline-flex min-h-9 flex-wrap items-center gap-1 rounded border border-amber-400 bg-background px-2.5 py-1 text-left text-xs font-medium text-foreground hover:bg-muted"
                                    >
                                      <span>{label}</span>
                                      <span className="font-normal text-muted-foreground">
                                        — {alt.reason}
                                      </span>
                                      <ArrowRight className="h-3.5 w-3.5 shrink-0" />
                                    </button>
                                  </li>
                                );
                              })}
                            </ul>
                          </div>
                        )}
                      </div>
                    )}

                  {Boolean(advanceMutation.error) && (
                    <ErrorBox
                      error={advanceMutation.error}
                      title="Could not book advance slot"
                      onSelectAlternative={handleAdvAlternative}
                    />
                  )}

                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      className="min-h-9 w-full sm:w-auto"
                      disabled={!advAvailabilityParams || availabilityQuery.isFetching}
                      onClick={() => void availabilityQuery.refetch()}
                    >
                      <RefreshCw className="h-4 w-4" />
                      <span>Check availability</span>
                    </Button>
                    <Button
                      type="submit"
                      className="min-h-9 w-full sm:w-auto"
                      disabled={
                        advanceMutation.isPending || !advAvailabilityParams || !resolvedAdvEvId
                      }
                    >
                      {advanceMutation.isPending ? 'Booking…' : 'Book advance slot'}
                    </Button>
                  </div>
                </form>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Cancel confirmation dialog (FR-24) */}
      <Dialog open={Boolean(cancelTarget)} onOpenChange={(open) => !open && setCancelTarget(null)}>
        <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Cancel charging request?</DialogTitle>
            <DialogDescription>
              This will remove your {cancelTarget?.mode === 'ADVANCE' ? 'scheduled slot' : 'queue'}{' '}
              request at{' '}
              {cancelTarget ? (hubNamesById.get(cancelTarget.hubId) ?? cancelTarget.hubId) : ''}.
            </DialogDescription>
          </DialogHeader>
          {Boolean(cancelMutation.error) && (
            <ErrorBox error={cancelMutation.error} title="Could not cancel request" />
          )}
          <DialogFooter className="flex-col-reverse sm:flex-row gap-2">
            <Button
              type="button"
              variant="outline"
              className="min-h-9"
              onClick={() => setCancelTarget(null)}
            >
              Keep request
            </Button>
            <Button
              type="button"
              variant="destructive"
              className="min-h-9"
              disabled={cancelMutation.isPending}
              onClick={handleConfirmCancel}
            >
              {cancelMutation.isPending ? 'Cancelling…' : 'Confirm cancel'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Stop charging confirmation dialog (FR-23) */}
      <Dialog open={Boolean(stopTarget)} onOpenChange={(open) => !open && setStopTarget(null)}>
        <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Stop charging now?</DialogTitle>
            <DialogDescription>
              Your session on{' '}
              <span className="font-mono">{stopTarget?.chargingPointId ?? 'this point'}</span> will
              end immediately at the current battery level ({stopTarget?.currentPct ?? 0}%) and free
              the charger for the next vehicle.
            </DialogDescription>
          </DialogHeader>
          {Boolean(stopMutation.error) && (
            <ErrorBox error={stopMutation.error} title="Could not stop charging" />
          )}
          <DialogFooter className="flex-col-reverse sm:flex-row gap-2">
            <Button
              type="button"
              variant="outline"
              className="min-h-9"
              onClick={() => setStopTarget(null)}
            >
              Continue charging
            </Button>
            <Button
              type="button"
              variant="destructive"
              className="min-h-9"
              disabled={stopMutation.isPending}
              onClick={handleConfirmStop}
            >
              {stopMutation.isPending ? 'Stopping…' : 'Stop charging'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
