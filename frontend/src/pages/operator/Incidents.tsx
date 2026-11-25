// Operator Incidents Console (CONTRACTS §11, FR-37–FR-42, UC-21/22/23).

import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  CheckCircle2,
  Eye,
  Plus,
  RotateCcw,
  ShieldAlert,
  Wrench,
} from 'lucide-react';
import { useHubs } from '@/hooks/useHubs';
import { useOpsHubDetail } from '@/hooks/useMonitoring';
import {
  useCreateIncident,
  useOpsIncidentDetail,
  useOpsIncidents,
  useResolveIncident,
  useStartMaintenance,
} from '@/hooks/useIncidents';
import { OPERATOR_NOTES_MAX } from '@/lib/constants';
import { StatusBadge } from '@/components/common/StatusBadge';
import { ErrorBox } from '@/components/common/ErrorBox';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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
  INCIDENT_CATEGORIES,
  INCIDENT_RESOURCE_TYPES,
  INCIDENT_STATUSES,
  VEHICLE_CLASSES,
  type IncidentCategory,
  type IncidentResourceType,
  type IncidentStatus,
  type VehicleClass,
} from '@/types/enums';
import type { ReportIncidentResult } from '@/types/incidents';

const ALL_VALUE = '__ALL__';
const MANUAL_RESOURCE_VALUE = '__MANUAL__';

const RESOURCE_TYPE_LABELS: Record<IncidentResourceType, string> = {
  RENTAL_VEHICLE: 'Rental vehicle',
  PARKING_SPACE: 'Parking space',
  CHARGING_POINT: 'Charging point',
};

function formatTimestamp(iso: string | null): string {
  if (!iso) return '—';
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return iso;
  return new Date(parsed).toLocaleString();
}

function localDateTimeToIso(value: string): string | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return undefined;
  return parsed.toISOString();
}

function isResourceType(val: string | null): val is IncidentResourceType {
  return Boolean(val && (INCIDENT_RESOURCE_TYPES as readonly string[]).includes(val));
}

function isVehicleClass(val: string | null): val is VehicleClass {
  return Boolean(val && (VEHICLE_CLASSES as readonly string[]).includes(val));
}

interface ResourceOption {
  id: string;
  label: string;
  vehicleClass: VehicleClass;
}

function IncidentDetailDialog({
  incidentId,
  hubNameMap,
  onClose,
}: {
  incidentId: string | null;
  hubNameMap: Map<string, string>;
  onClose: () => void;
}) {
  const { data: detail, isLoading, error } = useOpsIncidentDetail(incidentId);
  const startMaintenanceMutation = useStartMaintenance();
  const resolveMutation = useResolveIncident();

  const [maintenanceNotes, setMaintenanceNotes] = useState('');
  const [resolutionNotes, setResolutionNotes] = useState('');

  useEffect(() => {
    setMaintenanceNotes('');
    setResolutionNotes('');
    startMaintenanceMutation.reset();
    resolveMutation.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incidentId]);

  async function handleStartMaintenance(e: React.FormEvent) {
    e.preventDefault();
    if (!incidentId) return;
    try {
      await startMaintenanceMutation.mutateAsync({
        id: incidentId,
        notes: maintenanceNotes.trim() || undefined,
      });
      setMaintenanceNotes('');
    } catch {
      // Displayed in ErrorBox
    }
  }

  async function handleResolve(e: React.FormEvent) {
    e.preventDefault();
    if (!incidentId || !resolutionNotes.trim()) return;
    try {
      await resolveMutation.mutateAsync({
        id: incidentId,
        resolutionNotes: resolutionNotes.trim(),
      });
      setResolutionNotes('');
    } catch {
      // Displayed in ErrorBox
    }
  }

  const incident = detail?.incident;

  return (
    <Dialog open={Boolean(incidentId)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-3xl max-h-[90vh] flex flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2">
            <span>Incident</span>
            {incident && <span className="font-mono text-sm">{incident.id}</span>}
            {incident && <StatusBadge kind="incident" value={incident.status} />}
          </DialogTitle>
          <DialogDescription>
            {incident ? (
              <span>
                {RESOURCE_TYPE_LABELS[incident.resourceType]}{' '}
                <span className="font-mono">{incident.resourceId}</span> ·{' '}
                {hubNameMap.get(incident.hubId) ?? incident.hubId} · {incident.vehicleClass}
              </span>
            ) : (
              <span>Loading incident details…</span>
            )}
          </DialogDescription>
        </DialogHeader>

        {error && <ErrorBox error={error} title="Failed to load incident detail" />}

        {isLoading && (
          <div className="space-y-3 py-4">
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-32 w-full" />
          </div>
        )}

        {detail && incident && (
          <div className="flex-1 min-h-0 overflow-y-auto space-y-5 pr-1 text-sm">
            {/* Metadata */}
            <div className="rounded-md border bg-muted/30 p-3 space-y-2 text-xs">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="secondary">{incident.category}</Badge>
                <Badge variant="outline">Source: {incident.source}</Badge>
                <Badge variant="outline">{incident.vehicleClass}</Badge>
              </div>
              <p className="text-sm text-foreground">{incident.notes}</p>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-muted-foreground pt-1">
                <div>Created: {formatTimestamp(incident.createdAt)}</div>
                <div>In maintenance: {formatTimestamp(incident.inMaintenanceAt)}</div>
                <div>Resolved: {formatTimestamp(incident.resolvedAt)}</div>
              </div>
              {incident.resolutionNotes && (
                <div className="rounded border border-emerald-200 bg-emerald-50 p-2 text-emerald-950">
                  <div className="font-medium text-[11px] uppercase tracking-wide">
                    Resolution notes
                  </div>
                  <p className="mt-0.5 text-xs">{incident.resolutionNotes}</p>
                </div>
              )}
            </div>

            {/* Lifecycle actions (FR-41) */}
            {incident.status === 'REPORTED' && (
              <form
                onSubmit={(e) => void handleStartMaintenance(e)}
                className="rounded-md border p-3 space-y-3"
              >
                <div className="flex items-center justify-between">
                  <h3 className="font-medium flex items-center gap-1.5">
                    <Wrench className="h-4 w-4" />
                    <span>Start maintenance</span>
                  </h3>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {maintenanceNotes.length}/{OPERATOR_NOTES_MAX}
                  </span>
                </div>
                <textarea
                  value={maintenanceNotes}
                  onChange={(e) => setMaintenanceNotes(e.target.value)}
                  maxLength={OPERATOR_NOTES_MAX}
                  rows={2}
                  placeholder="Optional maintenance notes…"
                  className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                />
                {startMaintenanceMutation.error ? (
                  <ErrorBox
                    error={startMaintenanceMutation.error}
                    title="Could not start maintenance"
                  />
                ) : null}
                <div className="flex justify-end">
                  <Button type="submit" size="sm" disabled={startMaintenanceMutation.isPending}>
                    <Wrench className="h-3.5 w-3.5" />
                    <span>
                      {startMaintenanceMutation.isPending ? 'Starting…' : 'Start maintenance'}
                    </span>
                  </Button>
                </div>
              </form>
            )}

            {incident.status === 'IN_MAINTENANCE' && (
              <form
                onSubmit={(e) => void handleResolve(e)}
                className="rounded-md border p-3 space-y-3"
              >
                <div className="flex items-center justify-between">
                  <h3 className="font-medium flex items-center gap-1.5">
                    <CheckCircle2 className="h-4 w-4" />
                    <span>Resolve incident</span>
                  </h3>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {resolutionNotes.length}/{OPERATOR_NOTES_MAX}
                  </span>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="incident-resolution-notes" className="text-xs">
                    Resolution notes (required — returns resource to service)
                  </Label>
                  <textarea
                    id="incident-resolution-notes"
                    value={resolutionNotes}
                    onChange={(e) => setResolutionNotes(e.target.value)}
                    maxLength={OPERATOR_NOTES_MAX}
                    required
                    rows={3}
                    placeholder="Describe the repair or verification completed…"
                    className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  />
                </div>
                {resolveMutation.error ? (
                  <ErrorBox error={resolveMutation.error} title="Could not resolve incident" />
                ) : null}
                <div className="flex justify-end">
                  <Button
                    type="submit"
                    size="sm"
                    disabled={resolveMutation.isPending || !resolutionNotes.trim()}
                  >
                    <CheckCircle2 className="h-3.5 w-3.5" />
                    <span>{resolveMutation.isPending ? 'Resolving…' : 'Resolve incident'}</span>
                  </Button>
                </div>
              </form>
            )}

            <Separator />

            {/* Linked reports (oldest first) */}
            <div className="space-y-2">
              <h3 className="font-medium text-sm">
                Linked reports ({detail.reports.length})
              </h3>
              {detail.reports.length === 0 ? (
                <p className="text-xs text-muted-foreground">No linked reports recorded.</p>
              ) : (
                <div className="space-y-2">
                  {detail.reports.map((rep, idx) => (
                    <div
                      key={`${rep.createdAt}-${idx}`}
                      className="rounded border p-2.5 text-xs space-y-1"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <Badge variant="outline">{rep.source}</Badge>
                          <span className="text-muted-foreground">
                            By:{' '}
                            <span className="font-mono text-foreground">
                              {rep.reportedById ?? 'System'}
                            </span>
                          </span>
                        </div>
                        <span className="text-muted-foreground">
                          {formatTimestamp(rep.createdAt)}
                        </span>
                      </div>
                      <p className="text-foreground">{rep.notes}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <Separator />

            {/* Impacted bookings (FR-39/40) */}
            <div className="space-y-2">
              <h3 className="font-medium text-sm">
                Impacted bookings ({detail.impacts.length})
              </h3>
              {detail.impacts.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No active reservations or charging sessions were impacted.
                </p>
              ) : (
                <div className="overflow-x-auto rounded border">
                  <table className="w-full text-xs">
                    <thead className="bg-muted text-muted-foreground border-b">
                      <tr>
                        <th className="text-left p-2 font-medium">Booking type</th>
                        <th className="text-left p-2 font-medium">Booking ID</th>
                        <th className="text-left p-2 font-medium">User</th>
                        <th className="text-left p-2 font-medium">Outcome</th>
                        <th className="text-left p-2 font-medium">New resource</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {detail.impacts.map((imp, idx) => (
                        <tr key={`${imp.bookingId}-${idx}`}>
                          <td className="p-2">{imp.bookingType}</td>
                          <td className="p-2 font-mono">{imp.bookingId}</td>
                          <td className="p-2 font-mono">{imp.userId ?? 'Fleet'}</td>
                          <td className="p-2">
                            <Badge variant="outline">{imp.outcome}</Badge>
                          </td>
                          <td className="p-2 font-mono">{imp.newResourceId ?? '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function Incidents() {
  const [searchParams, setSearchParams] = useSearchParams();
  const { data: hubs } = useHubs();

  const hubNameMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const h of hubs ?? []) {
      map.set(h.id, h.name);
    }
    return map;
  }, [hubs]);

  // Search & filter state (FR-42)
  const [filterHubId, setFilterHubId] = useState('');
  const [filterResourceId, setFilterResourceId] = useState('');
  const [filterVehicleClass, setFilterVehicleClass] = useState<VehicleClass | ''>('');
  const [filterCategory, setFilterCategory] = useState<IncidentCategory | ''>('');
  const [filterStatus, setFilterStatus] = useState<IncidentStatus | ''>('');
  const [filterFrom, setFilterFrom] = useState('');
  const [filterTo, setFilterTo] = useState('');

  const {
    data,
    isLoading,
    error,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
  } = useOpsIncidents({
    hubId: filterHubId || undefined,
    resourceId: filterResourceId.trim() || undefined,
    vehicleClass: filterVehicleClass || undefined,
    category: filterCategory || undefined,
    status: filterStatus || undefined,
    from: localDateTimeToIso(filterFrom),
    to: localDateTimeToIso(filterTo),
  });

  const incidents = useMemo(() => data?.pages.flatMap((page) => page.items) ?? [], [data]);

  // Incident detail dialog state
  const [selectedIncidentId, setSelectedIncidentId] = useState<string | null>(null);

  // Report Incident dialog state (FR-37/38/39/40)
  const [reportOpen, setReportOpen] = useState(false);
  const [formHubId, setFormHubId] = useState('');
  const [formResourceType, setFormResourceType] = useState<IncidentResourceType>('RENTAL_VEHICLE');
  const [formResourceId, setFormResourceId] = useState('');
  const [formVehicleClass, setFormVehicleClass] = useState<VehicleClass>('MOTORCYCLE');
  const [formCategory, setFormCategory] = useState<IncidentCategory>('VEHICLE_FAULT');
  const [formNotes, setFormNotes] = useState('');
  const [createdResult, setCreatedResult] = useState<ReportIncidentResult | null>(null);

  const createIncidentMutation = useCreateIncident();

  // Consume ?report=1&hubId=...&resourceType=...&resourceId=...&vehicleClass=... once and clear
  // those query params so closing the dialog does not re-open it.
  useEffect(() => {
    if (searchParams.get('report') !== '1') return;

    const paramHubId = searchParams.get('hubId') ?? '';
    const paramResourceType = searchParams.get('resourceType');
    const paramResourceId = searchParams.get('resourceId') ?? '';
    const paramVehicleClass = searchParams.get('vehicleClass');

    const resolvedType: IncidentResourceType = isResourceType(paramResourceType)
      ? paramResourceType
      : 'RENTAL_VEHICLE';

    setFormHubId(paramHubId);
    setFormResourceType(resolvedType);
    setFormResourceId(paramResourceId);
    setFormVehicleClass(
      isVehicleClass(paramVehicleClass)
        ? paramVehicleClass
        : resolvedType === 'RENTAL_VEHICLE'
          ? 'MOTORCYCLE'
          : 'MOTORCYCLE',
    );
    setFormCategory(
      resolvedType === 'CHARGING_POINT'
        ? 'CHARGER_FAULT'
        : resolvedType === 'PARKING_SPACE'
          ? 'OBSTRUCTION'
          : 'VEHICLE_FAULT',
    );
    setFormNotes('');
    setCreatedResult(null);
    createIncidentMutation.reset();
    setReportOpen(true);

    const nextParams = new URLSearchParams(searchParams);
    nextParams.delete('report');
    nextParams.delete('hubId');
    nextParams.delete('resourceType');
    nextParams.delete('resourceId');
    nextParams.delete('vehicleClass');
    setSearchParams(nextParams, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, setSearchParams]);

  // Populate Hub-scoped resource picker from useOpsHubDetail when dialog is open & hub is selected
  const { data: formHubDetail, isLoading: formHubLoading } = useOpsHubDetail(
    reportOpen && formHubId ? formHubId : null,
  );

  const resourceOptions = useMemo<ResourceOption[]>(() => {
    if (!formHubDetail) return [];
    if (formResourceType === 'RENTAL_VEHICLE') {
      return formHubDetail.vehicles.map((v) => ({
        id: v.id,
        label: `${v.id} · ${v.type === 'E_BICYCLE' ? 'E-bike' : 'E-moto'} · ${v.status} (${v.batteryPct}%)`,
        vehicleClass: v.vehicleClass,
      }));
    }
    if (formResourceType === 'PARKING_SPACE') {
      return formHubDetail.parkingSpaces.map((s) => ({
        id: s.id,
        label: `${s.id} · ${s.pool} · ${s.vehicleClass} · ${s.status}`,
        vehicleClass: s.vehicleClass,
      }));
    }
    return formHubDetail.chargingPoints.map((p) => ({
      id: p.id,
      label: `${p.id} · ${p.vehicleClass} · ${p.status}`,
      vehicleClass: p.vehicleClass,
    }));
  }, [formHubDetail, formResourceType]);

  const pickerSelectValue = resourceOptions.some((o) => o.id === formResourceId)
    ? formResourceId
    : MANUAL_RESOURCE_VALUE;

  function openNewReportDialog() {
    setFormHubId(hubs?.[0]?.id ?? '');
    setFormResourceType('RENTAL_VEHICLE');
    setFormResourceId('');
    setFormVehicleClass('MOTORCYCLE');
    setFormCategory('VEHICLE_FAULT');
    setFormNotes('');
    setCreatedResult(null);
    createIncidentMutation.reset();
    setReportOpen(true);
  }

  function handleFormHubChange(nextHubId: string) {
    setFormHubId(nextHubId);
    setFormResourceId('');
  }

  function handleFormResourceTypeChange(nextType: IncidentResourceType) {
    setFormResourceType(nextType);
    setFormResourceId('');
    if (nextType === 'RENTAL_VEHICLE') {
      setFormVehicleClass('MOTORCYCLE');
    }
  }

  function handleResourcePickerChange(value: string) {
    if (value === MANUAL_RESOURCE_VALUE) return;
    setFormResourceId(value);
    const match = resourceOptions.find((o) => o.id === value);
    if (match) {
      setFormVehicleClass(match.vehicleClass);
    }
  }

  async function handleSubmitIncident(e: React.FormEvent) {
    e.preventDefault();
    if (!formHubId || !formResourceId.trim() || !formNotes.trim()) return;
    try {
      const result = await createIncidentMutation.mutateAsync({
        hubId: formHubId,
        resourceType: formResourceType,
        resourceId: formResourceId.trim(),
        vehicleClass: formVehicleClass,
        category: formCategory,
        notes: formNotes.trim(),
      });
      setCreatedResult(result);
    } catch {
      // Rendered in ErrorBox
    }
  }

  function handleResetFilters() {
    setFilterHubId('');
    setFilterResourceId('');
    setFilterVehicleClass('');
    setFilterCategory('');
    setFilterStatus('');
    setFilterFrom('');
    setFilterTo('');
  }

  const hasFilters = Boolean(
    filterHubId ||
      filterResourceId.trim() ||
      filterVehicleClass ||
      filterCategory ||
      filterStatus ||
      filterFrom ||
      filterTo,
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Incidents &amp; Maintenance</h1>
          <p className="text-sm text-muted-foreground">
            Report resource faults, inspect impacted bookings, and track maintenance resolution.
          </p>
        </div>
        <Button type="button" onClick={openNewReportDialog}>
          <Plus className="h-4 w-4" />
          <span>Report Incident</span>
        </Button>
      </div>

      {/* Multi-filter search bar (FR-42) */}
      <Card>
        <CardContent className="pt-4 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="inc-filter-hub">Hub</Label>
              <Select
                value={filterHubId || ALL_VALUE}
                onValueChange={(v) => setFilterHubId(v === ALL_VALUE ? '' : v)}
              >
                <SelectTrigger id="inc-filter-hub">
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
              <Label htmlFor="inc-filter-resource">Resource ID</Label>
              <Input
                id="inc-filter-resource"
                value={filterResourceId}
                onChange={(e) => setFilterResourceId(e.target.value)}
                placeholder="e.g. rv-metro-01"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="inc-filter-class">Vehicle class</Label>
              <Select
                value={filterVehicleClass || ALL_VALUE}
                onValueChange={(v) =>
                  setFilterVehicleClass(v === ALL_VALUE ? '' : (v as VehicleClass))
                }
              >
                <SelectTrigger id="inc-filter-class">
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

            <div className="space-y-1.5">
              <Label htmlFor="inc-filter-category">Category</Label>
              <Select
                value={filterCategory || ALL_VALUE}
                onValueChange={(v) =>
                  setFilterCategory(v === ALL_VALUE ? '' : (v as IncidentCategory))
                }
              >
                <SelectTrigger id="inc-filter-category">
                  <SelectValue placeholder="All categories" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL_VALUE}>All categories</SelectItem>
                  {INCIDENT_CATEGORIES.map((cat) => (
                    <SelectItem key={cat} value={cat}>
                      {cat}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="inc-filter-status">Status</Label>
              <Select
                value={filterStatus || ALL_VALUE}
                onValueChange={(v) =>
                  setFilterStatus(v === ALL_VALUE ? '' : (v as IncidentStatus))
                }
              >
                <SelectTrigger id="inc-filter-status">
                  <SelectValue placeholder="All statuses" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL_VALUE}>All statuses</SelectItem>
                  {INCIDENT_STATUSES.map((st) => (
                    <SelectItem key={st} value={st}>
                      {st}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="inc-filter-from">From</Label>
              <Input
                id="inc-filter-from"
                type="datetime-local"
                value={filterFrom}
                onChange={(e) => setFilterFrom(e.target.value)}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="inc-filter-to">To</Label>
              <Input
                id="inc-filter-to"
                type="datetime-local"
                value={filterTo}
                onChange={(e) => setFilterTo(e.target.value)}
              />
            </div>

            <div className="flex items-end justify-end">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleResetFilters}
                disabled={!hasFilters}
              >
                <RotateCcw className="h-3.5 w-3.5" />
                <span>Reset filters</span>
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {error && <ErrorBox error={error} title="Failed to load incidents" />}

      {isLoading && (
        <div className="space-y-3">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      )}

      {!isLoading && !error && incidents.length === 0 && (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            No incidents match the current filters.
          </CardContent>
        </Card>
      )}

      {incidents.length > 0 && (
        <div className="space-y-3">
          {incidents.map((inc) => (
            <Card key={inc.id}>
              <CardHeader className="pb-2">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusBadge kind="incident" value={inc.status} />
                    <Badge variant="secondary">{inc.category}</Badge>
                    <Badge variant="outline">
                      {RESOURCE_TYPE_LABELS[inc.resourceType]}:{' '}
                      <span className="font-mono ml-1">{inc.resourceId}</span>
                    </Badge>
                    <Badge variant="outline">
                      {hubNameMap.get(inc.hubId) ?? inc.hubId}
                    </Badge>
                    <Badge variant="outline">{inc.vehicleClass}</Badge>
                    <Badge variant="outline">Source: {inc.source}</Badge>
                  </div>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => setSelectedIncidentId(inc.id)}
                  >
                    <Eye className="h-3.5 w-3.5" />
                    <span>Inspect</span>
                  </Button>
                </div>
                <CardTitle className="text-sm font-normal pt-1 line-clamp-2">
                  {inc.notes}
                </CardTitle>
              </CardHeader>
              <CardContent className="text-xs text-muted-foreground flex flex-wrap gap-x-4 gap-y-1">
                <span>
                  ID: <span className="font-mono text-foreground">{inc.id}</span>
                </span>
                <span>Created: {formatTimestamp(inc.createdAt)}</span>
                {inc.inMaintenanceAt && (
                  <span>Maintenance: {formatTimestamp(inc.inMaintenanceAt)}</span>
                )}
                {inc.resolvedAt && <span>Resolved: {formatTimestamp(inc.resolvedAt)}</span>}
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

      {/* Report Incident Dialog (FR-37/38/39/40) */}
      <Dialog open={reportOpen} onOpenChange={setReportOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ShieldAlert className="h-5 w-5" />
              <span>Report Incident</span>
            </DialogTitle>
            <DialogDescription>
              Withdraw a faulty resource immediately and automatically recover impacted bookings.
            </DialogDescription>
          </DialogHeader>

          {createdResult ? (
            <div className="space-y-4">
              <div className="rounded-md border border-emerald-300 bg-emerald-50 p-3 space-y-2 text-sm text-emerald-950">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold">
                    {createdResult.linkedToExisting
                      ? 'Linked to existing open incident'
                      : 'Incident reported'}
                  </span>
                  <Badge variant="outline" className="font-mono">
                    {createdResult.incident.id}
                  </Badge>
                  <StatusBadge kind="incident" value={createdResult.incident.status} />
                </div>
                <p className="text-xs">
                  {RESOURCE_TYPE_LABELS[createdResult.incident.resourceType]}{' '}
                  <span className="font-mono">{createdResult.incident.resourceId}</span> at{' '}
                  {hubNameMap.get(createdResult.incident.hubId) ?? createdResult.incident.hubId}.
                </p>
              </div>

              <div className="space-y-2">
                <h4 className="text-sm font-medium">
                  Impacted bookings ({createdResult.impacts.length})
                </h4>
                {createdResult.impacts.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    No active reservations or charging sessions were affected.
                  </p>
                ) : (
                  <div className="overflow-x-auto rounded border">
                    <table className="w-full text-xs">
                      <thead className="bg-muted text-muted-foreground border-b">
                        <tr>
                          <th className="text-left p-2 font-medium">Booking type</th>
                          <th className="text-left p-2 font-medium">Booking ID</th>
                          <th className="text-left p-2 font-medium">Outcome</th>
                          <th className="text-left p-2 font-medium">New resource</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {createdResult.impacts.map((imp, idx) => (
                          <tr key={`${imp.bookingId}-${idx}`}>
                            <td className="p-2">{imp.bookingType}</td>
                            <td className="p-2 font-mono">{imp.bookingId}</td>
                            <td className="p-2">
                              <Badge variant="outline">{imp.outcome}</Badge>
                            </td>
                            <td className="p-2 font-mono">{imp.newResourceId ?? '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setReportOpen(false)}>
                  Close
                </Button>
                <Button
                  type="button"
                  onClick={() => {
                    const id = createdResult.incident.id;
                    setReportOpen(false);
                    setSelectedIncidentId(id);
                  }}
                >
                  Open incident detail
                </Button>
              </DialogFooter>
            </div>
          ) : (
            <form onSubmit={(e) => void handleSubmitIncident(e)} className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="report-hub">Hub</Label>
                  <Select value={formHubId} onValueChange={handleFormHubChange}>
                    <SelectTrigger id="report-hub">
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
                  <Label htmlFor="report-resource-type">Resource type</Label>
                  <Select
                    value={formResourceType}
                    onValueChange={(v) => handleFormResourceTypeChange(v as IncidentResourceType)}
                  >
                    <SelectTrigger id="report-resource-type">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {INCIDENT_RESOURCE_TYPES.map((rt) => (
                        <SelectItem key={rt} value={rt}>
                          {RESOURCE_TYPE_LABELS[rt]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="report-resource-picker">
                  Select resource at Hub {formHubLoading ? '(loading…)' : ''}
                </Label>
                <Select
                  value={pickerSelectValue}
                  onValueChange={handleResourcePickerChange}
                  disabled={!formHubId || resourceOptions.length === 0}
                >
                  <SelectTrigger id="report-resource-picker">
                    <SelectValue
                      placeholder={
                        !formHubId
                          ? 'Choose a Hub first'
                          : formHubLoading
                            ? 'Loading resources…'
                            : 'Choose from Hub resources…'
                      }
                    />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={MANUAL_RESOURCE_VALUE}>
                      Manual resource ID (enter below)
                    </SelectItem>
                    {resourceOptions.map((opt) => (
                      <SelectItem key={opt.id} value={opt.id}>
                        {opt.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="report-resource-id">Resource ID (manual fallback)</Label>
                  <Input
                    id="report-resource-id"
                    value={formResourceId}
                    onChange={(e) => setFormResourceId(e.target.value)}
                    placeholder="e.g. rv-metro-01"
                    required
                  />
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="report-vehicle-class">Vehicle class</Label>
                  <Select
                    value={formVehicleClass}
                    onValueChange={(v) => setFormVehicleClass(v as VehicleClass)}
                  >
                    <SelectTrigger id="report-vehicle-class">
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
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="report-category">Category</Label>
                <Select
                  value={formCategory}
                  onValueChange={(v) => setFormCategory(v as IncidentCategory)}
                >
                  <SelectTrigger id="report-category">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {INCIDENT_CATEGORIES.map((cat) => (
                      <SelectItem key={cat} value={cat}>
                        {cat}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <Label htmlFor="report-notes">Incident notes (required)</Label>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {formNotes.length}/{OPERATOR_NOTES_MAX}
                  </span>
                </div>
                <textarea
                  id="report-notes"
                  value={formNotes}
                  onChange={(e) => setFormNotes(e.target.value)}
                  maxLength={OPERATOR_NOTES_MAX}
                  required
                  rows={3}
                  placeholder="Describe the observed fault or issue…"
                  className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                />
              </div>

              {createIncidentMutation.error ? (
                <ErrorBox error={createIncidentMutation.error} title="Could not report incident" />
              ) : null}

              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setReportOpen(false)}>
                  Cancel
                </Button>
                <Button
                  type="submit"
                  disabled={
                    createIncidentMutation.isPending ||
                    !formHubId ||
                    !formResourceId.trim() ||
                    !formNotes.trim()
                  }
                >
                  {createIncidentMutation.isPending ? 'Submitting…' : 'Submit incident'}
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>

      {/* Incident Detail Dialog (FR-39/40/41, UC-22/23) */}
      <IncidentDetailDialog
        incidentId={selectedIncidentId}
        hubNameMap={hubNameMap}
        onClose={() => setSelectedIncidentId(null)}
      />
    </div>
  );
}
