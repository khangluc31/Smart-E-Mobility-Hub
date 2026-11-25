// Operator Charging Queue, Schedule, Priority Weights, Fleet Dispatch & Manual Overrides
// (CONTRACTS §8.2, FR-48–FR-52, BR-06, BR-13).

import { useMemo, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  BatteryCharging,
  CalendarClock,
  Lock,
  RotateCcw,
  Save,
  Send,
  Sliders,
  XCircle,
} from 'lucide-react';
import { useHubs } from '@/hooks/useHubs';
import { useOpsHubDetail } from '@/hooks/useMonitoring';
import {
  useChargingWeights,
  useDispatchFleetCharging,
  useOpsChargingQueue,
  useOpsChargingSchedule,
  useOverrideChargingQueue,
  useResetChargingWeights,
  useUpdateChargingWeights,
} from '@/hooks/useOpsCharging';
import {
  FULL_CHARGE_PCT,
  MIN_RENTAL_BATTERY_PCT,
  OVERRIDE_REASON_MIN_CHARS,
} from '@/lib/constants';
import { StatusBadge } from '@/components/common/StatusBadge';
import { BatteryBar } from '@/components/common/BatteryBar';
import { ErrorBox } from '@/components/common/ErrorBox';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { VEHICLE_CLASSES, type VehicleClass } from '@/types/enums';
import type {
  ChargingOverrideAction,
  ChargingQueueEntry,
  DispatchResult,
} from '@/types/charging';
import { cn } from '@/lib/utils';

const ALL_VALUE = '__ALL__';
const MANUAL_VEHICLE_VALUE = '__MANUAL__';

const OVERRIDE_LABELS: Record<ChargingOverrideAction, string> = {
  PROMOTE: 'Promote',
  DEFER: 'Defer',
  SWAP: 'Swap',
  CANCEL: 'Cancel',
};

function formatTime(iso: string | null): string {
  if (!iso) return '—';
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return iso;
  return new Date(parsed).toLocaleString();
}

function vehicleLabel(req: { rentalVehicleId: string | null; privateEvId: string | null }): string {
  return req.rentalVehicleId ?? req.privateEvId ?? '—';
}

interface PendingOverride {
  entry: ChargingQueueEntry;
  action: ChargingOverrideAction;
}

function OverrideDialog({
  pending,
  allEntries,
  onClose,
}: {
  pending: PendingOverride | null;
  allEntries: ChargingQueueEntry[];
  onClose: () => void;
}) {
  const overrideMutation = useOverrideChargingQueue();
  const [reason, setReason] = useState('');
  const [otherRequestId, setOtherRequestId] = useState('');

  // FR-52: SWAP target must be another QUEUED entry at the same Hub and same vehicleClass.
  const swapCandidates = useMemo(() => {
    if (!pending || pending.action !== 'SWAP') return [];
    const { request } = pending.entry;
    return allEntries.filter(
      (e) =>
        e.request.status === 'QUEUED' &&
        e.request.hubId === request.hubId &&
        e.request.vehicleClass === request.vehicleClass &&
        e.request.id !== request.id,
    );
  }, [pending, allEntries]);

  const trimmedReason = reason.trim();
  const reasonValid = trimmedReason.length >= OVERRIDE_REASON_MIN_CHARS;
  const swapNeedsTarget = pending?.action === 'SWAP';
  const canSubmit =
    Boolean(pending) &&
    reasonValid &&
    (!swapNeedsTarget || Boolean(otherRequestId)) &&
    !overrideMutation.isPending;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!pending || !canSubmit) return;
    try {
      await overrideMutation.mutateAsync({
        action: pending.action,
        requestId: pending.entry.request.id,
        otherRequestId: pending.action === 'SWAP' ? otherRequestId : undefined,
        reason: trimmedReason,
      });
      onClose();
    } catch {
      // Displayed in <ErrorBox />
    }
  }

  return (
    <Dialog open={Boolean(pending)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {pending ? `${OVERRIDE_LABELS[pending.action]} queue entry` : 'Override queue entry'}
          </DialogTitle>
          <DialogDescription>
            {pending && (
              <span>
                Rank #{pending.entry.rank} · {vehicleLabel(pending.entry.request)} (
                {pending.entry.request.vehicleKind} · {pending.entry.request.vehicleClass}) ·{' '}
                {pending.entry.request.currentPct}% → {pending.entry.request.targetPct}%
              </span>
            )}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
          <div className="rounded border bg-muted/40 p-2.5 text-xs text-muted-foreground flex items-start gap-2">
            <Lock className="h-3.5 w-3.5 shrink-0 mt-0.5" />
            <span>
              Running sessions (CHARGING) and advance-booked slots (SCHEDULED) are protected and
              cannot be overridden (BR-06).
            </span>
          </div>

          {swapNeedsTarget && (
            <div className="space-y-1.5">
              <Label htmlFor="override-swap-target">Swap with (same Hub &amp; vehicle class)</Label>
              {swapCandidates.length === 0 ? (
                <p className="rounded border border-amber-300 bg-amber-50 p-2.5 text-xs text-amber-900">
                  Fewer than 2 QUEUED entries of class {pending?.entry.request.vehicleClass} exist
                  at this Hub — swap is not available.
                </p>
              ) : (
                <Select value={otherRequestId} onValueChange={setOtherRequestId}>
                  <SelectTrigger id="override-swap-target">
                    <SelectValue placeholder="Choose another QUEUED request…" />
                  </SelectTrigger>
                  <SelectContent>
                    {swapCandidates.map((c) => (
                      <SelectItem key={c.request.id} value={c.request.id}>
                        #{c.rank} · {vehicleLabel(c.request)} ({c.request.currentPct}% →{' '}
                        {c.request.targetPct}%) · score {c.score.toFixed(2)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
          )}

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="override-reason">Override reason (required)</Label>
              <span
                className={cn(
                  'text-xs tabular-nums',
                  reasonValid ? 'text-emerald-700 font-medium' : 'text-amber-700',
                )}
              >
                {trimmedReason.length} / {OVERRIDE_REASON_MIN_CHARS} min chars
              </span>
            </div>
            <textarea
              id="override-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              required
              placeholder={`Enter at least ${OVERRIDE_REASON_MIN_CHARS} characters explaining this override…`}
              className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            />
          </div>

          {overrideMutation.error ? (
            <ErrorBox error={overrideMutation.error} title="Override rejected" />
          ) : null}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant={pending?.action === 'CANCEL' ? 'destructive' : 'default'}
              disabled={!canSubmit}
            >
              {overrideMutation.isPending
                ? 'Applying…'
                : `Confirm ${pending ? OVERRIDE_LABELS[pending.action].toLowerCase() : 'override'}`}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function ChargingQueue() {
  const { data: hubs } = useHubs();
  const hubNameMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const h of hubs ?? []) {
      map.set(h.id, h.name);
    }
    return map;
  }, [hubs]);

  // --- Tab 1: Queue & Overrides ---
  const [selectedQueueHubId, setSelectedQueueHubId] = useState('');
  const [queueClassFilter, setQueueClassFilter] = useState<VehicleClass | ''>('');
  const effectiveQueueHubId = selectedQueueHubId || hubs?.[0]?.id || '';

  const {
    data: queueData,
    isLoading: queueLoading,
    error: queueError,
  } = useOpsChargingQueue(effectiveQueueHubId || null, queueClassFilter || undefined);

  const [pendingOverride, setPendingOverride] = useState<PendingOverride | null>(null);

  // --- Tab 2: Schedule ---
  const [scheduleHubId, setScheduleHubId] = useState('');
  const [scheduleClassFilter, setScheduleClassFilter] = useState<VehicleClass | ''>('');
  const {
    data: scheduleData,
    isLoading: scheduleLoading,
    error: scheduleError,
  } = useOpsChargingSchedule(scheduleHubId || undefined);

  const filteredSchedulePoints = useMemo(() => {
    const points = scheduleData?.points ?? [];
    if (!scheduleClassFilter) return points;
    return points.filter((p) => p.point.vehicleClass === scheduleClassFilter);
  }, [scheduleData, scheduleClassFilter]);

  // --- Tab 3: Priority Weights ---
  const {
    data: weightsData,
    isLoading: weightsLoading,
    error: weightsError,
  } = useChargingWeights();
  const updateWeightsMutation = useUpdateChargingWeights();
  const resetWeightsMutation = useResetChargingWeights();

  // Nullable draft so 5 s background polls never clobber user edits while typing.
  const [weightsDraft, setWeightsDraft] = useState<{
    battery: string;
    urgency: string;
    waiting: string;
  } | null>(null);
  const [weightsNotice, setWeightsNotice] = useState<string | null>(null);

  const displayedWeights = weightsDraft ?? {
    battery: weightsData ? String(weightsData.battery) : '',
    urgency: weightsData ? String(weightsData.urgency) : '',
    waiting: weightsData ? String(weightsData.waiting) : '',
  };

  function handleWeightFieldChange(field: 'battery' | 'urgency' | 'waiting', value: string) {
    setWeightsNotice(null);
    setWeightsDraft((prev) => ({
      battery: prev?.battery ?? (weightsData ? String(weightsData.battery) : '0'),
      urgency: prev?.urgency ?? (weightsData ? String(weightsData.urgency) : '0'),
      waiting: prev?.waiting ?? (weightsData ? String(weightsData.waiting) : '0'),
      [field]: value,
    }));
  }

  async function handleSaveWeights(e: React.FormEvent) {
    e.preventDefault();
    setWeightsNotice(null);
    const battery = Number(displayedWeights.battery);
    const urgency = Number(displayedWeights.urgency);
    const waiting = Number(displayedWeights.waiting);
    try {
      await updateWeightsMutation.mutateAsync({ battery, urgency, waiting });
      setWeightsDraft(null);
      setWeightsNotice('Priority weights saved and queue re-ranked.');
    } catch {
      // Rendered in <ErrorBox />
    }
  }

  async function handleResetWeights() {
    setWeightsNotice(null);
    try {
      await resetWeightsMutation.mutateAsync();
      setWeightsDraft(null);
      setWeightsNotice('Priority weights reset to system defaults.');
    } catch {
      // Rendered in <ErrorBox />
    }
  }

  // --- Tab 4: Fleet Dispatch ---
  const [selectedDispatchHubId, setSelectedDispatchHubId] = useState('');
  const effectiveDispatchHubId = selectedDispatchHubId || hubs?.[0]?.id || '';
  const [dispatchTargetPct, setDispatchTargetPct] = useState(String(FULL_CHARGE_PCT));
  const [dispatchVehicleId, setDispatchVehicleId] = useState('');
  const [dispatchResult, setDispatchResult] = useState<DispatchResult | null>(null);

  const { data: dispatchHubDetail, isLoading: dispatchHubLoading } = useOpsHubDetail(
    effectiveDispatchHubId || null,
  );
  const dispatchMutation = useDispatchFleetCharging();

  const lowBatteryVehicles = useMemo(
    () =>
      (dispatchHubDetail?.vehicles ?? []).filter(
        (v) => v.batteryPct < MIN_RENTAL_BATTERY_PCT,
      ),
    [dispatchHubDetail],
  );

  const dispatchPickerValue = lowBatteryVehicles.some((v) => v.id === dispatchVehicleId)
    ? dispatchVehicleId
    : MANUAL_VEHICLE_VALUE;

  async function handleBulkDispatch() {
    if (!effectiveDispatchHubId) return;
    setDispatchResult(null);
    const targetPct = Number(dispatchTargetPct);
    try {
      const res = await dispatchMutation.mutateAsync({
        hubId: effectiveDispatchHubId,
        allLowBattery: true,
        targetPct: Number.isFinite(targetPct) ? targetPct : FULL_CHARGE_PCT,
      });
      setDispatchResult(res);
    } catch {
      // Displayed in <ErrorBox />
    }
  }

  async function handleSingleDispatch(e: React.FormEvent) {
    e.preventDefault();
    if (!effectiveDispatchHubId || !dispatchVehicleId.trim()) return;
    setDispatchResult(null);
    const targetPct = Number(dispatchTargetPct);
    try {
      const res = await dispatchMutation.mutateAsync({
        hubId: effectiveDispatchHubId,
        rentalVehicleId: dispatchVehicleId.trim(),
        targetPct: Number.isFinite(targetPct) ? targetPct : FULL_CHARGE_PCT,
      });
      setDispatchResult(res);
    } catch {
      // Displayed in <ErrorBox />
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Charging Queue &amp; Schedule</h1>
        <p className="text-sm text-muted-foreground">
          Monitor priority queues, inspect per-point schedules, tune weights, dispatch low-battery
          fleet vehicles, and apply manual queue overrides.
        </p>
      </div>

      <Tabs defaultValue="queue" className="space-y-4">
        <TabsList className="flex flex-wrap h-auto">
          <TabsTrigger value="queue" className="gap-1.5">
            <BatteryCharging className="h-3.5 w-3.5" />
            <span>Queue &amp; Overrides</span>
          </TabsTrigger>
          <TabsTrigger value="schedule" className="gap-1.5">
            <CalendarClock className="h-3.5 w-3.5" />
            <span>Schedule</span>
          </TabsTrigger>
          <TabsTrigger value="weights" className="gap-1.5">
            <Sliders className="h-3.5 w-3.5" />
            <span>Priority Weights</span>
          </TabsTrigger>
          <TabsTrigger value="dispatch" className="gap-1.5">
            <Send className="h-3.5 w-3.5" />
            <span>Fleet Dispatch</span>
          </TabsTrigger>
        </TabsList>

        {/* TAB 1: QUEUE & OVERRIDES (FR-48, FR-52, BR-06) */}
        <TabsContent value="queue" className="space-y-4">
          <Card>
            <CardContent className="pt-4 space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-end">
                <div className="space-y-1.5">
                  <Label htmlFor="queue-hub">Hub</Label>
                  <Select
                    value={effectiveQueueHubId}
                    onValueChange={(v) => setSelectedQueueHubId(v)}
                  >
                    <SelectTrigger id="queue-hub">
                      <SelectValue placeholder="Select a Hub" />
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
                  <Label htmlFor="queue-class">Vehicle class</Label>
                  <Select
                    value={queueClassFilter || ALL_VALUE}
                    onValueChange={(v) =>
                      setQueueClassFilter(v === ALL_VALUE ? '' : (v as VehicleClass))
                    }
                  >
                    <SelectTrigger id="queue-class">
                      <SelectValue placeholder="All classes" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={ALL_VALUE}>All classes</SelectItem>
                      {VEHICLE_CLASSES.map((vc) => (
                        <SelectItem key={vc} value={vc}>
                          {vc}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {queueData && (
                  <div className="flex flex-wrap items-center gap-1.5 text-xs justify-start sm:justify-end">
                    <span className="text-muted-foreground font-medium">Weights:</span>
                    <Badge variant="outline">Bat {queueData.weights.battery}</Badge>
                    <Badge variant="outline">Urg {queueData.weights.urgency}</Badge>
                    <Badge variant="outline">Wait {queueData.weights.waiting}</Badge>
                  </div>
                )}
              </div>

              <div className="text-xs text-muted-foreground flex items-center gap-1.5">
                <Lock className="h-3.5 w-3.5 shrink-0" />
                <span>
                  Running sessions (CHARGING) and advance bookings (SCHEDULED) are protected and
                  cannot be interrupted or overridden (BR-06).
                </span>
              </div>
            </CardContent>
          </Card>

          {queueError && <ErrorBox error={queueError} title="Failed to load charging queue" />}

          {queueLoading && (
            <div className="space-y-3">
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-24 w-full" />
            </div>
          )}

          {!queueLoading && !queueError && queueData && queueData.entries.length === 0 && (
            <Card>
              <CardContent className="py-10 text-center text-sm text-muted-foreground">
                No queued charging requests at{' '}
                {hubNameMap.get(effectiveQueueHubId) ?? effectiveQueueHubId}
                {queueClassFilter ? ` for class ${queueClassFilter}` : ''}.
              </CardContent>
            </Card>
          )}

          {queueData && queueData.entries.length > 0 && (
            <div className="space-y-3">
              {queueData.entries.map((entry) => {
                const req = entry.request;
                return (
                  <Card key={req.id}>
                    <CardHeader className="pb-2">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge className="font-mono">#{entry.rank}</Badge>
                          <Badge variant="secondary" className="font-mono">
                            Score {entry.score.toFixed(2)}
                          </Badge>
                          <StatusBadge kind="chargingRequest" value={req.status} />
                          <Badge variant="outline">{req.vehicleKind}</Badge>
                          <Badge variant="outline">{req.vehicleClass}</Badge>
                          <span className="font-mono text-sm font-medium">
                            {vehicleLabel(req)}
                          </span>
                        </div>

                        {req.status === 'QUEUED' && (
                          <div className="flex flex-wrap items-center gap-1.5">
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={() => setPendingOverride({ entry, action: 'PROMOTE' })}
                            >
                              <ArrowUp className="h-3.5 w-3.5" />
                              <span>Promote</span>
                            </Button>
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={() => setPendingOverride({ entry, action: 'DEFER' })}
                            >
                              <ArrowDown className="h-3.5 w-3.5" />
                              <span>Defer</span>
                            </Button>
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={() => setPendingOverride({ entry, action: 'SWAP' })}
                            >
                              <ArrowUpDown className="h-3.5 w-3.5" />
                              <span>Swap</span>
                            </Button>
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={() => setPendingOverride({ entry, action: 'CANCEL' })}
                            >
                              <XCircle className="h-3.5 w-3.5" />
                              <span>Cancel</span>
                            </Button>
                          </div>
                        )}
                      </div>
                    </CardHeader>

                    <CardContent className="space-y-2 text-xs">
                      <div className="flex flex-wrap items-center gap-3">
                        <div className="flex items-center gap-2">
                          <BatteryBar pct={req.currentPct} />
                          <span className="text-muted-foreground">→ {req.targetPct}%</span>
                        </div>
                        <div className="flex flex-wrap items-center gap-1.5 text-muted-foreground">
                          <span>Breakdown:</span>
                          <Badge variant="outline" className="font-mono text-[11px]">
                            bat {entry.breakdown.battery.toFixed(1)}
                          </Badge>
                          <Badge variant="outline" className="font-mono text-[11px]">
                            urg {entry.breakdown.urgency.toFixed(1)}
                          </Badge>
                          <Badge variant="outline" className="font-mono text-[11px]">
                            wait {entry.breakdown.waiting.toFixed(1)}
                          </Badge>
                          {entry.breakdown.manualAdjust !== 0 && (
                            <Badge variant="secondary" className="font-mono text-[11px]">
                              adj {entry.breakdown.manualAdjust > 0 ? '+' : ''}
                              {entry.breakdown.manualAdjust}
                            </Badge>
                          )}
                        </div>
                      </div>

                      <div className="flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground">
                        <span>
                          Request ID: <span className="font-mono text-foreground">{req.id}</span>
                        </span>
                        <span>Needed by: {formatTime(req.neededBy)}</span>
                        <span>Created: {formatTime(req.createdAt)}</span>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </TabsContent>

        {/* TAB 2: SCHEDULE (FR-49, FR-50) */}
        <TabsContent value="schedule" className="space-y-4">
          <Card>
            <CardContent className="pt-4">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-end">
                <div className="space-y-1.5">
                  <Label htmlFor="schedule-hub">Hub</Label>
                  <Select
                    value={scheduleHubId || ALL_VALUE}
                    onValueChange={(v) => setScheduleHubId(v === ALL_VALUE ? '' : v)}
                  >
                    <SelectTrigger id="schedule-hub">
                      <SelectValue placeholder="All Hubs" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={ALL_VALUE}>All Hubs</SelectItem>
                      {(hubs ?? []).map((h) => (
                        <SelectItem key={h.id} value={h.id}>
                          {h.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="schedule-class">Vehicle class</Label>
                  <Select
                    value={scheduleClassFilter || ALL_VALUE}
                    onValueChange={(v) =>
                      setScheduleClassFilter(v === ALL_VALUE ? '' : (v as VehicleClass))
                    }
                  >
                    <SelectTrigger id="schedule-class">
                      <SelectValue placeholder="All classes" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={ALL_VALUE}>All classes</SelectItem>
                      {VEHICLE_CLASSES.map((vc) => (
                        <SelectItem key={vc} value={vc}>
                          {vc}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {scheduleData && (
                  <div className="flex sm:justify-end">
                    <Badge variant="outline" className="font-mono text-xs">
                      Generated: {formatTime(scheduleData.generatedAt)}
                    </Badge>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          {scheduleError && <ErrorBox error={scheduleError} title="Failed to load schedule" />}

          {scheduleLoading && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <Skeleton className="h-44 w-full" />
              <Skeleton className="h-44 w-full" />
            </div>
          )}

          {!scheduleLoading && !scheduleError && filteredSchedulePoints.length === 0 && (
            <Card>
              <CardContent className="py-10 text-center text-sm text-muted-foreground">
                No charging points match the selected filters.
              </CardContent>
            </Card>
          )}

          {filteredSchedulePoints.length > 0 && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {filteredSchedulePoints.map((sp) => (
                <Card key={sp.point.id}>
                  <CardHeader className="pb-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <CardTitle className="text-sm font-mono flex items-center gap-2">
                        <span>{sp.point.id}</span>
                        <Badge variant="outline" className="font-sans">
                          {hubNameMap.get(sp.point.hubId) ?? sp.point.hubId}
                        </Badge>
                        <Badge variant="secondary" className="font-sans">
                          {sp.point.vehicleClass}
                        </Badge>
                      </CardTitle>
                      <StatusBadge kind="chargingPoint" value={sp.point.status} />
                    </div>
                  </CardHeader>

                  <CardContent className="space-y-3 text-xs">
                    {/* Running session */}
                    <div className="rounded border bg-muted/30 p-2.5 space-y-1">
                      <div className="font-medium text-muted-foreground">Running session</div>
                      {sp.current ? (
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex items-center gap-2">
                            <span className="font-mono font-medium">
                              {vehicleLabel(sp.current)}
                            </span>
                            <BatteryBar pct={sp.current.currentPct} />
                            <span>→ {sp.current.targetPct}%</span>
                          </div>
                          <span className="text-muted-foreground">
                            Est. end: {formatTime(sp.current.estimatedEnd)}
                          </span>
                        </div>
                      ) : (
                        <div className="text-muted-foreground">Idle</div>
                      )}
                    </div>

                    {/* Booked advance slots */}
                    <div className="space-y-1">
                      <div className="font-medium text-muted-foreground">
                        Booked advance slots ({sp.booked.length})
                      </div>
                      {sp.booked.length === 0 ? (
                        <p className="text-muted-foreground">None</p>
                      ) : (
                        <ul className="space-y-1">
                          {sp.booked.map((b) => (
                            <li
                              key={b.id}
                              className="flex flex-wrap items-center justify-between gap-2 rounded border px-2 py-1"
                            >
                              <span className="font-mono">{vehicleLabel(b)}</span>
                              <span>
                                {formatTime(b.slotStart)} – {formatTime(b.slotEnd)}
                              </span>
                              <Badge variant="outline" className="text-[10px]">
                                Protected
                              </Badge>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>

                    {/* Projected queue */}
                    <div className="space-y-1">
                      <div className="font-medium text-muted-foreground">
                        Projected queue ({sp.projected.length})
                      </div>
                      {sp.projected.length === 0 ? (
                        <p className="text-muted-foreground">None</p>
                      ) : (
                        <ul className="space-y-1">
                          {sp.projected.map((pr) => (
                            <li
                              key={pr.requestId}
                              className="flex flex-wrap items-center justify-between gap-2 rounded border border-dashed px-2 py-1"
                            >
                              <span className="font-mono">{pr.requestId}</span>
                              <span className="text-muted-foreground">
                                {formatTime(pr.estimatedStart)} – {formatTime(pr.estimatedEnd)}
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>

        {/* TAB 3: PRIORITY WEIGHTS (FR-48, UC-26) */}
        <TabsContent value="weights" className="space-y-4">
          <Card className="max-w-xl">
            <CardHeader>
              <div className="flex items-center justify-between gap-2">
                <div>
                  <CardTitle className="text-base">Charging Priority Weights</CardTitle>
                  <CardDescription>
                    Non-negative weights (not all zero) used by the BR-06 queue ranking formula.
                  </CardDescription>
                </div>
                {weightsData && (
                  <Badge variant={weightsData.isDefault ? 'secondary' : 'outline'}>
                    {weightsData.isDefault ? 'Default' : 'Custom'}
                  </Badge>
                )}
              </div>
            </CardHeader>

            <CardContent className="space-y-4">
              {weightsError && <ErrorBox error={weightsError} title="Failed to load weights" />}

              {weightsLoading && <Skeleton className="h-32 w-full" />}

              {weightsData && (
                <form onSubmit={(e) => void handleSaveWeights(e)} className="space-y-4">
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <div className="space-y-1.5">
                      <Label htmlFor="weight-battery">Battery weight</Label>
                      <Input
                        id="weight-battery"
                        type="number"
                        min={0}
                        step="0.1"
                        value={displayedWeights.battery}
                        onChange={(e) => handleWeightFieldChange('battery', e.target.value)}
                        required
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="weight-urgency">Urgency weight</Label>
                      <Input
                        id="weight-urgency"
                        type="number"
                        min={0}
                        step="0.1"
                        value={displayedWeights.urgency}
                        onChange={(e) => handleWeightFieldChange('urgency', e.target.value)}
                        required
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="weight-waiting">Waiting weight</Label>
                      <Input
                        id="weight-waiting"
                        type="number"
                        min={0}
                        step="0.1"
                        value={displayedWeights.waiting}
                        onChange={(e) => handleWeightFieldChange('waiting', e.target.value)}
                        required
                      />
                    </div>
                  </div>

                  {weightsNotice && (
                    <Alert className="border-emerald-300 bg-emerald-50 text-emerald-950">
                      <AlertDescription className="text-xs">{weightsNotice}</AlertDescription>
                    </Alert>
                  )}

                  {updateWeightsMutation.error ? (
                    <ErrorBox error={updateWeightsMutation.error} title="Could not save weights" />
                  ) : null}

                  {resetWeightsMutation.error ? (
                    <ErrorBox error={resetWeightsMutation.error} title="Could not reset weights" />
                  ) : null}

                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => void handleResetWeights()}
                      disabled={resetWeightsMutation.isPending}
                    >
                      <RotateCcw className="h-3.5 w-3.5" />
                      <span>
                        {resetWeightsMutation.isPending ? 'Resetting…' : 'Reset to defaults'}
                      </span>
                    </Button>

                    <div className="flex items-center gap-2">
                      {weightsDraft !== null && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => setWeightsDraft(null)}
                        >
                          Discard
                        </Button>
                      )}
                      <Button
                        type="submit"
                        size="sm"
                        disabled={updateWeightsMutation.isPending}
                      >
                        <Save className="h-3.5 w-3.5" />
                        <span>
                          {updateWeightsMutation.isPending ? 'Saving…' : 'Save weights'}
                        </span>
                      </Button>
                    </div>
                  </div>
                </form>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* TAB 4: FLEET DISPATCH (FR-51) */}
        <TabsContent value="dispatch" className="space-y-4">
          <Card className="max-w-2xl">
            <CardHeader>
              <CardTitle className="text-base">Fleet Charging Dispatch</CardTitle>
              <CardDescription>
                Queue unreserved low-battery rental vehicles (&lt; {MIN_RENTAL_BATTERY_PCT}%) at
                their current Hub for charging.
              </CardDescription>
            </CardHeader>

            <CardContent className="space-y-5">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="dispatch-hub">Hub</Label>
                  <Select
                    value={effectiveDispatchHubId}
                    onValueChange={(v) => {
                      setSelectedDispatchHubId(v);
                      setDispatchVehicleId('');
                      setDispatchResult(null);
                    }}
                  >
                    <SelectTrigger id="dispatch-hub">
                      <SelectValue placeholder="Select a Hub" />
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
                  <Label htmlFor="dispatch-target">Target battery (%)</Label>
                  <Input
                    id="dispatch-target"
                    type="number"
                    min={1}
                    max={FULL_CHARGE_PCT}
                    value={dispatchTargetPct}
                    onChange={(e) => setDispatchTargetPct(e.target.value)}
                  />
                </div>
              </div>

              {/* Bulk dispatch */}
              <div className="rounded-md border bg-muted/30 p-3 flex flex-wrap items-center justify-between gap-3">
                <div className="text-xs">
                  <div className="font-medium text-foreground">Bulk dispatch at Hub</div>
                  <div className="text-muted-foreground">
                    {dispatchHubLoading
                      ? 'Checking low-battery vehicles…'
                      : `${lowBatteryVehicles.length} vehicle(s) currently below ${MIN_RENTAL_BATTERY_PCT}% at ${hubNameMap.get(effectiveDispatchHubId) ?? effectiveDispatchHubId}.`}
                  </div>
                </div>
                <Button
                  type="button"
                  size="sm"
                  onClick={() => void handleBulkDispatch()}
                  disabled={!effectiveDispatchHubId || dispatchMutation.isPending}
                >
                  <Send className="h-3.5 w-3.5" />
                  <span>Dispatch all low-battery vehicles at Hub</span>
                </Button>
              </div>

              <Separator />

              {/* Single vehicle dispatch */}
              <form onSubmit={(e) => void handleSingleDispatch(e)} className="space-y-3">
                <div className="text-sm font-medium">Single vehicle dispatch</div>

                <div className="space-y-1.5">
                  <Label htmlFor="dispatch-vehicle-picker">
                    Low-battery vehicles at Hub (&lt; {MIN_RENTAL_BATTERY_PCT}%)
                  </Label>
                  <Select
                    value={dispatchPickerValue}
                    onValueChange={(v) => {
                      if (v !== MANUAL_VEHICLE_VALUE) setDispatchVehicleId(v);
                    }}
                    disabled={lowBatteryVehicles.length === 0}
                  >
                    <SelectTrigger id="dispatch-vehicle-picker">
                      <SelectValue
                        placeholder={
                          lowBatteryVehicles.length === 0
                            ? 'No low-battery vehicles at this Hub'
                            : 'Choose a low-battery vehicle…'
                        }
                      />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={MANUAL_VEHICLE_VALUE}>
                        Manual vehicle ID (enter below)
                      </SelectItem>
                      {lowBatteryVehicles.map((v) => (
                        <SelectItem key={v.id} value={v.id}>
                          {v.id} · {v.status} · {v.batteryPct}%
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {lowBatteryVehicles.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {lowBatteryVehicles.slice(0, 6).map((v) => (
                      <button
                        key={v.id}
                        type="button"
                        onClick={() => setDispatchVehicleId(v.id)}
                        className={cn(
                          'inline-flex items-center gap-2 rounded border px-2 py-1 text-xs hover:bg-muted',
                          dispatchVehicleId === v.id && 'border-primary bg-primary/5',
                        )}
                      >
                        <span className="font-mono">{v.id}</span>
                        <StatusBadge kind="rentalVehicle" value={v.status} />
                        <BatteryBar pct={v.batteryPct} />
                      </button>
                    ))}
                  </div>
                )}

                <div className="space-y-1.5">
                  <Label htmlFor="dispatch-vehicle-manual">
                    Rental vehicle ID (manual fallback)
                  </Label>
                  <Input
                    id="dispatch-vehicle-manual"
                    value={dispatchVehicleId}
                    onChange={(e) => setDispatchVehicleId(e.target.value)}
                    placeholder="e.g. RV-0001"
                    required
                  />
                </div>

                <div className="flex justify-end">
                  <Button
                    type="submit"
                    size="sm"
                    disabled={
                      !effectiveDispatchHubId ||
                      !dispatchVehicleId.trim() ||
                      dispatchMutation.isPending
                    }
                  >
                    <Send className="h-3.5 w-3.5" />
                    <span>
                      {dispatchMutation.isPending ? 'Dispatching…' : 'Dispatch vehicle'}
                    </span>
                  </Button>
                </div>
              </form>

              {dispatchMutation.error ? (
                <ErrorBox error={dispatchMutation.error} title="Dispatch failed" />
              ) : null}

              {dispatchResult && (
                <div className="rounded-md border border-emerald-300 bg-emerald-50 p-3 text-xs text-emerald-950 space-y-1.5">
                  {dispatchResult.created.length === 0 ? (
                    <p>No eligible low-battery vehicles to dispatch at this Hub.</p>
                  ) : (
                    <>
                      <p className="font-semibold">
                        Dispatched {dispatchResult.created.length} vehicle(s) to the charging
                        queue:
                      </p>
                      <ul className="list-disc pl-5 space-y-0.5">
                        {dispatchResult.created.map((r) => (
                          <li key={r.id}>
                            <span className="font-mono">{r.rentalVehicleId}</span> → target{' '}
                            {r.targetPct}% (request <span className="font-mono">{r.id}</span>)
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <OverrideDialog
        key={pendingOverride ? `${pendingOverride.entry.request.id}-${pendingOverride.action}` : 'closed'}
        pending={pendingOverride}
        allEntries={queueData?.entries ?? []}
        onClose={() => setPendingOverride(null)}
      />
    </div>
  );
}
