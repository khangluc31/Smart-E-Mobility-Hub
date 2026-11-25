// Operator Redistribution & Imbalance Detection Console
// (CONTRACTS §12, FR-43–FR-47, BR-08, BR-15, D-19, UC-24, UC-25).

import { useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  Check,
  CheckCircle2,
  Eye,
  Info,
  Play,
  Plus,
  RotateCcw,
  Truck,
  XCircle,
} from 'lucide-react';
import { useHubs } from '@/hooks/useHubs';
import {
  useApproveRedistributionTask,
  useCancelRedistributionTask,
  useCompleteRedistributionTask,
  useCreateRedistributionTask,
  useFailRedistributionTask,
  useImbalances,
  useRedistributionPreview,
  useRedistributionTask,
  useRedistributionTasks,
  useStartRedistributionTask,
} from '@/hooks/useRedistribution';
import { OPERATOR_NOTES_MAX, REDISTRIBUTION_DEST_LIMIT_PCT } from '@/lib/constants';
import { StatusBadge } from '@/components/common/StatusBadge';
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
import {
  REDISTRIBUTION_STATUSES,
  RENTAL_VEHICLE_TYPES,
  VEHICLE_CLASSES,
  type RedistributionStatus,
  type RentalVehicleType,
  type VehicleClass,
} from '@/types/enums';
import type { HubSummary } from '@/types/hubs';
import type { Imbalance, ImbalanceState, RedistributionTask } from '@/types/redistribution';
import { cn } from '@/lib/utils';

const ALL_VALUE = '__ALL__';
const ANY_TYPE_VALUE = '__ANY__';

const IMBALANCE_BADGE_CLASSES: Record<ImbalanceState, string> = {
  SHORTAGE: 'border-red-300 bg-red-50 text-red-800',
  SURPLUS: 'border-amber-300 bg-amber-50 text-amber-800',
  OK: 'border-emerald-300 bg-emerald-50 text-emerald-800',
};

function formatTime(iso: string | null): string {
  if (!iso) return '—';
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return iso;
  return new Date(parsed).toLocaleString();
}

interface CreatePrefill {
  sourceHubId: string;
  destHubId: string;
  vehicleClass: VehicleClass;
  count: number;
}

function CreateTaskDialog({
  open,
  prefill,
  hubs,
  onClose,
}: {
  open: boolean;
  prefill: CreatePrefill;
  hubs: HubSummary[];
  onClose: () => void;
}) {
  const [sourceHubId, setSourceHubId] = useState(prefill.sourceHubId);
  const [destHubId, setDestHubId] = useState(prefill.destHubId);
  const [vehicleClass, setVehicleClass] = useState<VehicleClass>(prefill.vehicleClass);
  const [vehicleType, setVehicleType] = useState<RentalVehicleType | ''>('');
  const [countRaw, setCountRaw] = useState(String(prefill.count));
  const [override, setOverride] = useState(false);
  const [reason, setReason] = useState('');

  const parsedCount = Number(countRaw);
  const validCount = Number.isInteger(parsedCount) && parsedCount >= 1;
  const sameHub = Boolean(sourceHubId && destHubId && sourceHubId === destHubId);

  const previewParams =
    open && sourceHubId && destHubId && !sameHub && validCount
      ? {
          sourceHubId,
          destHubId,
          vehicleClass,
          vehicleType: vehicleType || undefined,
          count: parsedCount,
        }
      : null;

  const {
    data: preview,
    isLoading: previewLoading,
    error: previewError,
  } = useRedistributionPreview(previewParams);

  const createMutation = useCreateRedistributionTask();

  const exceedsPhysicalCap = Boolean(preview && parsedCount > preview.destFreeFleetSpaces);
  const insufficientVehicles = Boolean(preview && parsedCount > preview.eligibleAtSource);
  const needsOverride = Boolean(preview?.needsOverride);
  const effectiveOverride = needsOverride && override;
  const trimmedReason = reason.trim();

  const canSubmit =
    Boolean(sourceHubId) &&
    Boolean(destHubId) &&
    !sameHub &&
    validCount &&
    !exceedsPhysicalCap &&
    !insufficientVehicles &&
    (!needsOverride || (effectiveOverride && trimmedReason.length >= 1)) &&
    !createMutation.isPending;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    try {
      await createMutation.mutateAsync({
        sourceHubId,
        destHubId,
        vehicleClass,
        vehicleType: vehicleType || undefined,
        count: parsedCount,
        override: effectiveOverride ? true : undefined,
        reason: trimmedReason || undefined,
      });
      onClose();
    } catch {
      // Displayed in <ErrorBox />
    }
  }

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent className="max-w-xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Truck className="h-5 w-5" />
            <span>New redistribution task</span>
          </DialogTitle>
          <DialogDescription>
            Preview source eligibility and destination FLEET occupancy before proposing a transfer
            (D-19: vehicles and spaces are locked when the task starts).
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="redist-source-hub">Source Hub</Label>
              <Select value={sourceHubId} onValueChange={setSourceHubId}>
                <SelectTrigger id="redist-source-hub">
                  <SelectValue placeholder="Select source Hub" />
                </SelectTrigger>
                <SelectContent>
                  {hubs.map((h) => (
                    <SelectItem key={h.id} value={h.id}>
                      {h.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="redist-dest-hub">Destination Hub</Label>
              <Select value={destHubId} onValueChange={setDestHubId}>
                <SelectTrigger id="redist-dest-hub">
                  <SelectValue placeholder="Select destination Hub" />
                </SelectTrigger>
                <SelectContent>
                  {hubs.map((h) => (
                    <SelectItem key={h.id} value={h.id}>
                      {h.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {sameHub && (
            <p className="text-xs text-red-700 font-medium">
              Source Hub and Destination Hub must be different.
            </p>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="redist-class">Vehicle class</Label>
              <Select
                value={vehicleClass}
                onValueChange={(v) => setVehicleClass(v as VehicleClass)}
              >
                <SelectTrigger id="redist-class">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {VEHICLE_CLASSES.map((vc) => (
                    <SelectItem key={vc} value={vc}>
                      {vc}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="redist-type">Vehicle type (optional)</Label>
              <Select
                value={vehicleType || ANY_TYPE_VALUE}
                onValueChange={(v) =>
                  setVehicleType(v === ANY_TYPE_VALUE ? '' : (v as RentalVehicleType))
                }
              >
                <SelectTrigger id="redist-type">
                  <SelectValue placeholder="Any" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ANY_TYPE_VALUE}>Any rental type</SelectItem>
                  {RENTAL_VEHICLE_TYPES.map((rt) => (
                    <SelectItem key={rt} value={rt}>
                      {rt === 'E_BICYCLE' ? 'E-bicycle' : 'E-motorcycle'}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="redist-count">Count</Label>
              <Input
                id="redist-count"
                type="number"
                min={1}
                step={1}
                value={countRaw}
                onChange={(e) => setCountRaw(e.target.value)}
                required
              />
            </div>
          </div>

          {/* Live Preview box (FR-45, FR-46, BR-08) */}
          <div className="rounded-md border bg-muted/30 p-3 space-y-2 text-xs">
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium text-foreground">Live transfer preview</span>
              {preview && (
                <Badge
                  variant="outline"
                  className={cn(
                    preview.ok
                      ? 'border-emerald-300 bg-emerald-50 text-emerald-800'
                      : preview.needsOverride
                        ? 'border-amber-300 bg-amber-50 text-amber-900'
                        : 'border-red-300 bg-red-50 text-red-800',
                  )}
                >
                  {preview.ok
                    ? 'Ready'
                    : preview.needsOverride
                      ? `Override required (> ${REDISTRIBUTION_DEST_LIMIT_PCT}%)`
                      : 'Blocked'}
                </Badge>
              )}
            </div>

            {!previewParams && (
              <p className="text-muted-foreground">
                Select two distinct Hubs and a valid count (≥ 1) to preview capacity.
              </p>
            )}

            {previewLoading && <Skeleton className="h-12 w-full" />}

            {previewError && <ErrorBox error={previewError} title="Preview failed" />}

            {preview && (
              <>
                <div className="grid grid-cols-3 gap-2 text-center">
                  <div className="rounded border bg-background p-2">
                    <div className="text-[11px] text-muted-foreground">Eligible at source</div>
                    <div className="text-base font-semibold tabular-nums">
                      {preview.eligibleAtSource}
                    </div>
                  </div>
                  <div className="rounded border bg-background p-2">
                    <div className="text-[11px] text-muted-foreground">Dest free FLEET</div>
                    <div className="text-base font-semibold tabular-nums">
                      {preview.destFreeFleetSpaces}
                    </div>
                  </div>
                  <div
                    className={cn(
                      'rounded border p-2',
                      preview.predictedDestOccupancyPct > REDISTRIBUTION_DEST_LIMIT_PCT
                        ? 'border-amber-400 bg-amber-50 text-amber-900'
                        : 'bg-background',
                    )}
                  >
                    <div className="text-[11px] opacity-80">Predicted dest %</div>
                    <div className="text-base font-semibold tabular-nums">
                      {preview.predictedDestOccupancyPct}%
                    </div>
                  </div>
                </div>

                {preview.problems.length > 0 && (
                  <ul className="list-disc pl-5 space-y-0.5 text-red-800">
                    {preview.problems.map((prob, idx) => (
                      <li key={idx}>{prob}</li>
                    ))}
                  </ul>
                )}

                {exceedsPhysicalCap && (
                  <div className="rounded border border-red-300 bg-red-50 p-2 text-red-900 font-medium">
                    Exceeds 100% physical FLEET capacity at destination — cannot be overridden
                    (BR-08). Reduce count or choose another destination Hub.
                  </div>
                )}
              </>
            )}
          </div>

          {/* BR-08 Override checkbox + required reason when predicted occupancy is 85.1%–100% */}
          {needsOverride && !exceedsPhysicalCap && (
            <div className="rounded-md border border-amber-300 bg-amber-50/70 p-3 space-y-3">
              <label className="flex items-start gap-2 text-xs font-medium text-amber-950 cursor-pointer">
                <input
                  type="checkbox"
                  checked={override}
                  onChange={(e) => setOverride(e.target.checked)}
                  className="mt-0.5 h-4 w-4 rounded border-amber-500"
                />
                <span>
                  Override {REDISTRIBUTION_DEST_LIMIT_PCT}% destination occupancy limit (BR-08, up
                  to 100% physical FLEET capacity — reason required)
                </span>
              </label>

              {override && (
                <div className="space-y-1">
                  <div className="flex items-center justify-between">
                    <Label htmlFor="redist-override-reason" className="text-xs">
                      Override reason (required)
                    </Label>
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {reason.length}/{OPERATOR_NOTES_MAX}
                    </span>
                  </div>
                  <textarea
                    id="redist-override-reason"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    maxLength={OPERATOR_NOTES_MAX}
                    required
                    rows={2}
                    placeholder="Explain why exceeding the 85% destination limit is necessary…"
                    className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  />
                </div>
              )}
            </div>
          )}

          {createMutation.error ? (
            <ErrorBox error={createMutation.error} title="Could not create redistribution task" />
          ) : null}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {createMutation.isPending ? 'Creating…' : 'Create task'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

type LifecycleActionKind = 'approve' | 'start' | 'complete' | 'fail' | 'cancel';

interface PendingLifecycleAction {
  task: RedistributionTask;
  kind: LifecycleActionKind;
}

function LifecycleActionDialog({
  pending,
  hubNameMap,
  onClose,
}: {
  pending: PendingLifecycleAction | null;
  hubNameMap: Map<string, string>;
  onClose: () => void;
}) {
  const approveMutation = useApproveRedistributionTask();
  const startMutation = useStartRedistributionTask();
  const completeMutation = useCompleteRedistributionTask();
  const failMutation = useFailRedistributionTask();
  const cancelMutation = useCancelRedistributionTask();

  const [reason, setReason] = useState('');

  const needsReason = pending?.kind === 'fail' || pending?.kind === 'cancel';
  const trimmedReason = reason.trim();

  const activeMutation =
    pending?.kind === 'approve'
      ? approveMutation
      : pending?.kind === 'start'
        ? startMutation
        : pending?.kind === 'complete'
          ? completeMutation
          : pending?.kind === 'fail'
            ? failMutation
            : cancelMutation;

  const titles: Record<LifecycleActionKind, string> = {
    approve: 'Approve redistribution task',
    start: 'Start redistribution task',
    complete: 'Complete redistribution task',
    fail: 'Mark task as failed',
    cancel: 'Cancel redistribution task',
  };

  async function handleConfirm(e: React.FormEvent) {
    e.preventDefault();
    if (!pending) return;
    if (needsReason && trimmedReason.length === 0) return;

    try {
      switch (pending.kind) {
        case 'approve':
          await approveMutation.mutateAsync(pending.task.id);
          break;
        case 'start':
          await startMutation.mutateAsync(pending.task.id);
          break;
        case 'complete':
          await completeMutation.mutateAsync(pending.task.id);
          break;
        case 'fail':
          await failMutation.mutateAsync({ id: pending.task.id, reason: trimmedReason });
          break;
        case 'cancel':
          await cancelMutation.mutateAsync({ id: pending.task.id, reason: trimmedReason });
          break;
      }
      onClose();
    } catch {
      // Rendered in <ErrorBox />
    }
  }

  return (
    <Dialog open={Boolean(pending)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{pending ? titles[pending.kind] : 'Confirm action'}</DialogTitle>
          <DialogDescription>
            {pending && (
              <span>
                Task <span className="font-mono">{pending.task.id}</span> ·{' '}
                {hubNameMap.get(pending.task.sourceHubId) ?? pending.task.sourceHubId} →{' '}
                {hubNameMap.get(pending.task.destHubId) ?? pending.task.destHubId} (
                {pending.task.count} × {pending.task.vehicleClass})
              </span>
            )}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={(e) => void handleConfirm(e)} className="space-y-4">
          {pending?.kind === 'start' && (
            <Alert>
              <Info className="h-4 w-4" />
              <AlertDescription className="text-xs">
                Starting this task will atomically pick and lock {pending.task.count} eligible
                source vehicle(s) as <span className="font-semibold">IN_TRANSIT</span>, free their
                source FLEET spaces, and reserve {pending.task.count} destination FLEET space(s)
                (D-19).
              </AlertDescription>
            </Alert>
          )}

          {pending?.kind === 'complete' && (
            <Alert>
              <Info className="h-4 w-4" />
              <AlertDescription className="text-xs">
                Completing this task parks all IN_TRANSIT vehicles as AVAILABLE at the destination
                Hub in their reserved FLEET spaces.
              </AlertDescription>
            </Alert>
          )}

          {needsReason && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label htmlFor="lifecycle-reason">Reason (required)</Label>
                <span className="text-xs text-muted-foreground tabular-nums">
                  {reason.length}/{OPERATOR_NOTES_MAX}
                </span>
              </div>
              <textarea
                id="lifecycle-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                maxLength={OPERATOR_NOTES_MAX}
                required
                rows={3}
                placeholder={
                  pending?.kind === 'fail'
                    ? 'Explain why the transfer failed (vehicles will return to source Hub)…'
                    : 'Explain why this task is being cancelled…'
                }
                className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              />
            </div>
          )}

          {activeMutation.error ? (
            <ErrorBox error={activeMutation.error} title="Action failed" />
          ) : null}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Back
            </Button>
            <Button
              type="submit"
              variant={pending?.kind === 'fail' || pending?.kind === 'cancel' ? 'destructive' : 'default'}
              disabled={activeMutation.isPending || (needsReason && trimmedReason.length === 0)}
            >
              {activeMutation.isPending ? 'Saving…' : 'Confirm'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function TaskDetailDialog({
  taskId,
  hubNameMap,
  onClose,
}: {
  taskId: string | null;
  hubNameMap: Map<string, string>;
  onClose: () => void;
}) {
  const { data: task, isLoading, error } = useRedistributionTask(taskId);

  return (
    <Dialog open={Boolean(taskId)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2">
            <span>Redistribution Task</span>
            {task && <StatusBadge kind="redistribution" value={task.status} />}
          </DialogTitle>
          <DialogDescription>
            {task ? <span className="font-mono text-xs">{task.id}</span> : 'Loading task…'}
          </DialogDescription>
        </DialogHeader>

        {error && <ErrorBox error={error} title="Failed to load task detail" />}

        {isLoading && <Skeleton className="h-32 w-full" />}

        {task && (
          <div className="space-y-4 text-xs">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline">Origin: {task.origin}</Badge>
              {task.recommendationId && (
                <Badge variant="secondary" className="font-mono">
                  Rec: {task.recommendationId}
                </Badge>
              )}
              {task.override && (
                <Badge variant="outline" className="border-amber-400 bg-amber-50 text-amber-900">
                  BR-08 Override
                </Badge>
              )}
            </div>

            <div className="rounded border bg-muted/30 p-3 space-y-1.5">
              <div className="flex items-center gap-2 text-sm font-medium">
                <span>{hubNameMap.get(task.sourceHubId) ?? task.sourceHubId}</span>
                <ArrowRight className="h-4 w-4 text-muted-foreground" />
                <span>{hubNameMap.get(task.destHubId) ?? task.destHubId}</span>
              </div>
              <div className="text-muted-foreground">
                Count: <span className="text-foreground font-medium">{task.count}</span> ×{' '}
                {task.vehicleClass}
                {task.vehicleType ? ` (${task.vehicleType})` : ''}
              </div>
              {task.reason && (
                <div className="pt-1">
                  <span className="text-muted-foreground">Reason: </span>
                  <span className="text-foreground">{task.reason}</span>
                </div>
              )}
            </div>

            <div className="space-y-1.5">
              <div className="font-medium text-foreground">
                Attached vehicles ({task.vehicleIds.length})
              </div>
              {task.vehicleIds.length === 0 ? (
                <p className="text-muted-foreground">
                  {task.status === 'PROPOSED' || task.status === 'APPROVED'
                    ? 'Vehicles and destination FLEET spaces are locked when the task starts (D-19).'
                    : 'No vehicles attached.'}
                </p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {task.vehicleIds.map((vid) => (
                    <span
                      key={vid}
                      className="rounded border bg-muted px-2 py-0.5 font-mono text-[11px]"
                    >
                      {vid}
                    </span>
                  ))}
                </div>
              )}
            </div>

            <div className="flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground pt-1">
              <span>
                Created by: <span className="font-mono text-foreground">{task.createdById}</span>
              </span>
              <span>Created: {formatTime(task.createdAt)}</span>
              <span>Updated: {formatTime(task.updatedAt)}</span>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function Redistribution() {
  const { data: hubs } = useHubs();
  const hubNameMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const h of hubs ?? []) {
      map.set(h.id, h.name);
    }
    return map;
  }, [hubs]);

  // Imbalances (FR-43)
  const {
    data: imbalances,
    isLoading: imbalancesLoading,
    error: imbalancesError,
  } = useImbalances();

  // Tasks list (FR-47)
  const [statusFilter, setStatusFilter] = useState<RedistributionStatus | ''>('');
  const {
    data: tasksData,
    isLoading: tasksLoading,
    error: tasksError,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
  } = useRedistributionTasks({ status: statusFilter || undefined });

  const tasks = useMemo(
    () => tasksData?.pages.flatMap((page) => page.items) ?? [],
    [tasksData],
  );

  // Dialog states
  const [createSession, setCreateSession] = useState<{
    key: number;
    prefill: CreatePrefill;
  } | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<PendingLifecycleAction | null>(null);

  function openNewTaskDialog(prefill?: Partial<CreatePrefill>) {
    const defaultSource = prefill?.sourceHubId ?? hubs?.[0]?.id ?? '';
    const defaultDest =
      prefill?.destHubId ?? hubs?.find((h) => h.id !== defaultSource)?.id ?? '';
    setCreateSession((prev) => ({
      key: (prev?.key ?? 0) + 1,
      prefill: {
        sourceHubId: defaultSource,
        destHubId: defaultDest,
        vehicleClass: prefill?.vehicleClass ?? 'MOTORCYCLE',
        count: prefill?.count ?? 1,
      },
    }));
  }

  function handlePlanTransfer(imb: Imbalance) {
    const count = Math.max(1, imb.amount);
    if (imb.state === 'SHORTAGE') {
      const altSource = hubs?.find((h) => h.id !== imb.hubId)?.id ?? '';
      openNewTaskDialog({
        sourceHubId: altSource,
        destHubId: imb.hubId,
        vehicleClass: imb.vehicleClass,
        count,
      });
    } else {
      const altDest = hubs?.find((h) => h.id !== imb.hubId)?.id ?? '';
      openNewTaskDialog({
        sourceHubId: imb.hubId,
        destHubId: altDest,
        vehicleClass: imb.vehicleClass,
        count,
      });
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Vehicle Redistribution</h1>
          <p className="text-sm text-muted-foreground">
            Monitor Hub fleet imbalances and manage inter-Hub vehicle transfers (auto-refreshing
            every 5 s).
          </p>
        </div>
        <Button type="button" onClick={() => openNewTaskDialog()}>
          <Plus className="h-4 w-4" />
          <span>New redistribution task</span>
        </Button>
      </div>

      {/* Imbalances Panel (FR-43, BR-15, UC-24) */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <AlertTriangle className="h-4 w-4" />
            <span>Live Hub Imbalances</span>
          </CardTitle>
          <CardDescription className="text-xs">
            Available rental vehicles per Hub against min/max thresholds. DEGRADED Hubs are omitted
            while their telemetry feed is stalled (UC-24 E1).
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {imbalancesError && (
            <ErrorBox error={imbalancesError} title="Failed to load Hub imbalances" />
          )}

          {imbalancesLoading && (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-24 w-full" />
            </div>
          )}

          {!imbalancesLoading && !imbalancesError && (imbalances?.length ?? 0) === 0 && (
            <p className="text-sm text-muted-foreground py-4 text-center">
              No non-degraded Hubs currently reporting imbalance data.
            </p>
          )}

          {imbalances && imbalances.length > 0 && (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              {imbalances.map((imb) => (
                <div
                  key={`${imb.hubId}-${imb.vehicleClass}`}
                  className="rounded-md border p-3 flex flex-col justify-between gap-2 text-xs"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="font-semibold text-sm">
                        {hubNameMap.get(imb.hubId) ?? imb.hubId}
                      </div>
                      <div className="text-muted-foreground">{imb.vehicleClass}</div>
                    </div>
                    <Badge variant="outline" className={IMBALANCE_BADGE_CLASSES[imb.state]}>
                      {imb.state}
                    </Badge>
                  </div>

                  <div className="flex items-center justify-between text-muted-foreground">
                    <span>
                      Available:{' '}
                      <span className="font-semibold text-foreground tabular-nums">
                        {imb.available}
                      </span>{' '}
                      (band {imb.min}–{imb.max})
                    </span>
                    {imb.amount > 0 && (
                      <span className="font-medium text-foreground tabular-nums">
                        {imb.state === 'SHORTAGE' ? `-${imb.amount}` : `+${imb.amount}`}
                      </span>
                    )}
                  </div>

                  {imb.state !== 'OK' && (
                    <div className="pt-1 flex justify-end">
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        className="h-7 text-xs"
                        onClick={() => handlePlanTransfer(imb)}
                      >
                        <Truck className="h-3.5 w-3.5" />
                        <span>Plan transfer</span>
                      </Button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Separator />

      {/* Tasks Filter + List (FR-47, D-19, UC-25) */}
      <div className="space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="space-y-1.5 w-56">
            <Label htmlFor="redist-status-filter">Filter by status</Label>
            <Select
              value={statusFilter || ALL_VALUE}
              onValueChange={(v) =>
                setStatusFilter(v === ALL_VALUE ? '' : (v as RedistributionStatus))
              }
            >
              <SelectTrigger id="redist-status-filter">
                <SelectValue placeholder="All statuses" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_VALUE}>All statuses</SelectItem>
                {REDISTRIBUTION_STATUSES.map((st) => (
                  <SelectItem key={st} value={st}>
                    {st}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {statusFilter && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setStatusFilter('')}
            >
              <RotateCcw className="h-3.5 w-3.5" />
              <span>Reset filter</span>
            </Button>
          )}
        </div>

        {tasksError && <ErrorBox error={tasksError} title="Failed to load redistribution tasks" />}

        {tasksLoading && (
          <div className="space-y-3">
            <Skeleton className="h-28 w-full" />
            <Skeleton className="h-28 w-full" />
          </div>
        )}

        {!tasksLoading && !tasksError && tasks.length === 0 && (
          <Card>
            <CardContent className="py-10 text-center text-sm text-muted-foreground">
              No redistribution tasks match the selected filter.
            </CardContent>
          </Card>
        )}

        {tasks.length > 0 && (
          <div className="space-y-3">
            {tasks.map((task) => (
              <Card key={task.id}>
                <CardHeader className="pb-2">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusBadge kind="redistribution" value={task.status} />
                      <Badge variant="outline">{task.origin}</Badge>
                      {task.override && (
                        <Badge
                          variant="outline"
                          className="border-amber-400 bg-amber-50 text-amber-900"
                        >
                          Override &gt; {REDISTRIBUTION_DEST_LIMIT_PCT}%
                        </Badge>
                      )}
                      <span className="text-sm font-medium inline-flex items-center gap-1.5">
                        <span>{hubNameMap.get(task.sourceHubId) ?? task.sourceHubId}</span>
                        <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
                        <span>{hubNameMap.get(task.destHubId) ?? task.destHubId}</span>
                      </span>
                      <Badge variant="secondary">
                        {task.count} × {task.vehicleClass}
                        {task.vehicleType ? ` · ${task.vehicleType}` : ''}
                      </Badge>
                    </div>

                    <div className="flex flex-wrap items-center gap-1.5">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => setSelectedTaskId(task.id)}
                      >
                        <Eye className="h-3.5 w-3.5" />
                        <span>Inspect</span>
                      </Button>

                      {task.status === 'PROPOSED' && (
                        <>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => setPendingAction({ task, kind: 'approve' })}
                          >
                            <Check className="h-3.5 w-3.5" />
                            <span>Approve</span>
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => setPendingAction({ task, kind: 'cancel' })}
                          >
                            <XCircle className="h-3.5 w-3.5" />
                            <span>Cancel</span>
                          </Button>
                        </>
                      )}

                      {task.status === 'APPROVED' && (
                        <>
                          <Button
                            type="button"
                            size="sm"
                            onClick={() => setPendingAction({ task, kind: 'start' })}
                          >
                            <Play className="h-3.5 w-3.5" />
                            <span>Start</span>
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => setPendingAction({ task, kind: 'cancel' })}
                          >
                            <XCircle className="h-3.5 w-3.5" />
                            <span>Cancel</span>
                          </Button>
                        </>
                      )}

                      {task.status === 'IN_PROGRESS' && (
                        <>
                          <Button
                            type="button"
                            size="sm"
                            onClick={() => setPendingAction({ task, kind: 'complete' })}
                          >
                            <CheckCircle2 className="h-3.5 w-3.5" />
                            <span>Complete</span>
                          </Button>
                          <Button
                            type="button"
                            variant="destructive"
                            size="sm"
                            onClick={() => setPendingAction({ task, kind: 'fail' })}
                          >
                            <XCircle className="h-3.5 w-3.5" />
                            <span>Fail</span>
                          </Button>
                        </>
                      )}
                    </div>
                  </div>
                </CardHeader>

                <CardContent className="space-y-2 text-xs">
                  {task.reason && (
                    <div>
                      <span className="text-muted-foreground">Reason: </span>
                      <span>{task.reason}</span>
                    </div>
                  )}

                  {task.vehicleIds.length > 0 ? (
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-muted-foreground font-medium">
                        Vehicles ({task.vehicleIds.length}):
                      </span>
                      {task.vehicleIds.map((vid) => (
                        <span
                          key={vid}
                          className="rounded border bg-muted px-1.5 py-0.5 font-mono text-[11px]"
                        >
                          {vid}
                        </span>
                      ))}
                    </div>
                  ) : (
                    (task.status === 'PROPOSED' || task.status === 'APPROVED') && (
                      <p className="text-muted-foreground">
                        Vehicles &amp; destination spaces locked at Start (D-19).
                      </p>
                    )
                  )}

                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground">
                    <span>
                      ID: <span className="font-mono text-foreground">{task.id}</span>
                    </span>
                    <span>Created: {formatTime(task.createdAt)}</span>
                    <span>Updated: {formatTime(task.updatedAt)}</span>
                  </div>
                </CardContent>
              </Card>
            ))}

            {hasNextPage && (
              <div className="flex justify-center pt-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void fetchNextPage()}
                  disabled={isFetchingNextPage}
                >
                  {isFetchingNextPage ? 'Loading more…' : 'Load more'}
                </Button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Create Dialog */}
      {createSession && (
        <CreateTaskDialog
          key={createSession.key}
          open={Boolean(createSession)}
          prefill={createSession.prefill}
          hubs={hubs ?? []}
          onClose={() => setCreateSession(null)}
        />
      )}

      {/* Lifecycle Action Dialog */}
      <LifecycleActionDialog
        key={pendingAction ? `${pendingAction.task.id}-${pendingAction.kind}` : 'closed'}
        pending={pendingAction}
        hubNameMap={hubNameMap}
        onClose={() => setPendingAction(null)}
      />

      {/* Detail Dialog */}
      <TaskDetailDialog
        taskId={selectedTaskId}
        hubNameMap={hubNameMap}
        onClose={() => setSelectedTaskId(null)}
      />
    </div>
  );
}
