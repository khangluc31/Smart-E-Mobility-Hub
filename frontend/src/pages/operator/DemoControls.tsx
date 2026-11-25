// Operator Telemetry Demo Controls & Rejected Packets Log
// (ARCHITECTURE §7.4, CONTRACTS §14, FR-03, FR-33, FR-35, FR-36, NFR-25).

import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle,
  BatteryLow,
  Info,
  PauseCircle,
  ShieldAlert,
} from 'lucide-react';
import { useHubs } from '@/hooks/useHubs';
import { useOpsHubDetail } from '@/hooks/useMonitoring';
import {
  useDemoBattery,
  useDemoFault,
  useDemoStall,
  useTelemetryRejects,
} from '@/hooks/useTelemetryDemo';
import { DEMO_STALL_MAX_SEC, DEMO_STALL_MIN_SEC } from '@/lib/constants';
import { ErrorBox } from '@/components/common/ErrorBox';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import {
  INCIDENT_CATEGORIES,
  INCIDENT_RESOURCE_TYPES,
  type IncidentResourceType,
} from '@/types/enums';

const MANUAL_VALUE = '__MANUAL__';

const RESOURCE_TYPE_LABELS: Record<IncidentResourceType, string> = {
  RENTAL_VEHICLE: 'Rental vehicle',
  PARKING_SPACE: 'Parking space',
  CHARGING_POINT: 'Charging point',
};

function formatTime(iso: string | null): string {
  if (!iso) return '—';
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return iso;
  return new Date(parsed).toLocaleString();
}

export function DemoControls() {
  const { data: hubs } = useHubs();
  const firstHubId = hubs?.[0]?.id ?? '';

  // --- Card 1: Stall Hub feed (FR-03 / FR-35) ---
  const [stallHubId, setStallHubId] = useState('');
  const effectiveStallHubId = stallHubId || firstHubId;
  const [stallSeconds, setStallSeconds] = useState('30');
  const stallMutation = useDemoStall();

  async function handleStall(e: React.FormEvent) {
    e.preventDefault();
    if (!effectiveStallHubId) return;
    const seconds = Number(stallSeconds);
    try {
      await stallMutation.mutateAsync({ hubId: effectiveStallHubId, seconds });
    } catch {
      // Displayed in <ErrorBox />
    }
  }

  // --- Card 2: Inject fault (FR-36 / FR-38) ---
  const [faultHubId, setFaultHubId] = useState('');
  const effectiveFaultHubId = faultHubId || firstHubId;
  const [faultResourceType, setFaultResourceType] =
    useState<IncidentResourceType>('RENTAL_VEHICLE');
  const [faultResourceId, setFaultResourceId] = useState('');
  const [faultCode, setFaultCode] = useState('VEHICLE_FAULT');

  const { data: faultHubDetail } = useOpsHubDetail(effectiveFaultHubId || null);
  const faultMutation = useDemoFault();

  const faultResourceOptions = useMemo(() => {
    if (!faultHubDetail) return [];
    if (faultResourceType === 'RENTAL_VEHICLE') {
      return faultHubDetail.vehicles.map((v) => ({
        id: v.id,
        label: `${v.id} · ${v.status} (${v.batteryPct}%)`,
      }));
    }
    if (faultResourceType === 'PARKING_SPACE') {
      return faultHubDetail.parkingSpaces.map((s) => ({
        id: s.id,
        label: `${s.id} · ${s.pool} · ${s.vehicleClass} · ${s.status}`,
      }));
    }
    return faultHubDetail.chargingPoints.map((p) => ({
      id: p.id,
      label: `${p.id} · ${p.vehicleClass} · ${p.status}`,
    }));
  }, [faultHubDetail, faultResourceType]);

  const faultPickerValue = faultResourceOptions.some((o) => o.id === faultResourceId)
    ? faultResourceId
    : MANUAL_VALUE;

  async function handleInjectFault(e: React.FormEvent) {
    e.preventDefault();
    if (!faultResourceId.trim() || !faultCode.trim()) return;
    try {
      await faultMutation.mutateAsync({
        resourceType: faultResourceType,
        resourceId: faultResourceId.trim(),
        faultCode: faultCode.trim(),
      });
    } catch {
      // Displayed in <ErrorBox />
    }
  }

  // --- Card 3: Force vehicle battery (FR-33 / BR-02) ---
  const [batteryHubId, setBatteryHubId] = useState('');
  const effectiveBatteryHubId = batteryHubId || firstHubId;
  const [batteryVehicleId, setBatteryVehicleId] = useState('');
  const [batteryPct, setBatteryPct] = useState('15');

  const { data: batteryHubDetail } = useOpsHubDetail(effectiveBatteryHubId || null);
  const batteryMutation = useDemoBattery();

  const batteryVehicleOptions = useMemo(
    () =>
      (batteryHubDetail?.vehicles ?? []).map((v) => ({
        id: v.id,
        label: `${v.id} · ${v.status} (${v.batteryPct}%)`,
      })),
    [batteryHubDetail],
  );

  const batteryPickerValue = batteryVehicleOptions.some((o) => o.id === batteryVehicleId)
    ? batteryVehicleId
    : MANUAL_VALUE;

  async function handleForceBattery(e: React.FormEvent) {
    e.preventDefault();
    if (!batteryVehicleId.trim()) return;
    const pct = Number(batteryPct);
    try {
      await batteryMutation.mutateAsync({
        vehicleId: batteryVehicleId.trim(),
        batteryPct: pct,
      });
    } catch {
      // Displayed in <ErrorBox />
    }
  }

  // --- Rejected Telemetry Packets log (NFR-25) ---
  const {
    data: rejectsData,
    isLoading: rejectsLoading,
    error: rejectsError,
  } = useTelemetryRejects();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Telemetry Demo Controls</h1>
        <p className="text-sm text-muted-foreground">
          Inject simulated telemetry anomalies and inspect rejected sensor packets.
        </p>
      </div>

      <Alert>
        <Info className="h-4 w-4" />
        <AlertTitle>Simulated telemetry controls (D-17)</AlertTitle>
        <AlertDescription className="text-xs">
          These controls steer the in-process telemetry generator so you can demonstrate stalled
          feeds, automated fault incidents, and low-battery alerts live without external sensors.
        </AlertDescription>
      </Alert>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Card 1: Stall Hub feed */}
        <Card className="flex flex-col">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <PauseCircle className="h-4 w-4" />
              <span>Stall Hub feed</span>
            </CardTitle>
            <CardDescription className="text-xs">
              Pause telemetry packets for a Hub ({DEMO_STALL_MIN_SEC}–{DEMO_STALL_MAX_SEC} s) to
              trigger DEGRADED status and STALLED_FEED alerts (FR-03 / FR-35).
            </CardDescription>
          </CardHeader>
          <CardContent className="flex-1 flex flex-col justify-between space-y-4">
            <form onSubmit={(e) => void handleStall(e)} className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="demo-stall-hub">Hub</Label>
                <Select value={effectiveStallHubId} onValueChange={setStallHubId}>
                  <SelectTrigger id="demo-stall-hub">
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
                <Label htmlFor="demo-stall-seconds">
                  Duration ({DEMO_STALL_MIN_SEC}–{DEMO_STALL_MAX_SEC} seconds)
                </Label>
                <Input
                  id="demo-stall-seconds"
                  type="number"
                  min={DEMO_STALL_MIN_SEC}
                  max={DEMO_STALL_MAX_SEC}
                  value={stallSeconds}
                  onChange={(e) => setStallSeconds(e.target.value)}
                  required
                />
              </div>

              {stallMutation.error ? (
                <ErrorBox error={stallMutation.error} title="Could not stall feed" />
              ) : null}

              {stallMutation.data && (
                <div className="rounded border border-emerald-300 bg-emerald-50 p-2.5 text-xs text-emerald-950 space-y-1">
                  <div>
                    Hub <span className="font-mono">{stallMutation.data.hubId}</span> stalled until{' '}
                    {formatTime(stallMutation.data.stalledUntil)}.
                  </div>
                  <div className="flex gap-3 underline">
                    <Link to="/ops">View Dashboard</Link>
                    <Link to={`/ops/alerts?hubId=${encodeURIComponent(stallMutation.data.hubId)}`}>
                      View Alerts
                    </Link>
                  </div>
                </div>
              )}

              <Button
                type="submit"
                size="sm"
                className="w-full"
                disabled={!effectiveStallHubId || stallMutation.isPending}
              >
                {stallMutation.isPending ? 'Stalling…' : 'Stall Hub feed'}
              </Button>
            </form>
          </CardContent>
        </Card>

        {/* Card 2: Inject fault */}
        <Card className="flex flex-col">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <ShieldAlert className="h-4 w-4" />
              <span>Inject fault</span>
            </CardTitle>
            <CardDescription className="text-xs">
              Queue a fault code on the next telemetry packet (~5 s) to trigger automated incident
              creation &amp; resource withdrawal (FR-36 / FR-38).
            </CardDescription>
          </CardHeader>
          <CardContent className="flex-1 flex flex-col justify-between space-y-4">
            <form onSubmit={(e) => void handleInjectFault(e)} className="space-y-3">
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1.5">
                  <Label htmlFor="demo-fault-hub">Hub</Label>
                  <Select
                    value={effectiveFaultHubId}
                    onValueChange={(v) => {
                      setFaultHubId(v);
                      setFaultResourceId('');
                    }}
                  >
                    <SelectTrigger id="demo-fault-hub">
                      <SelectValue placeholder="Hub" />
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
                  <Label htmlFor="demo-fault-type">Resource type</Label>
                  <Select
                    value={faultResourceType}
                    onValueChange={(v) => {
                      setFaultResourceType(v as IncidentResourceType);
                      setFaultResourceId('');
                    }}
                  >
                    <SelectTrigger id="demo-fault-type">
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
                <Label htmlFor="demo-fault-picker">Pick resource at Hub</Label>
                <Select
                  value={faultPickerValue}
                  onValueChange={(v) => {
                    if (v !== MANUAL_VALUE) setFaultResourceId(v);
                  }}
                  disabled={faultResourceOptions.length === 0}
                >
                  <SelectTrigger id="demo-fault-picker">
                    <SelectValue placeholder="Choose a resource…" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={MANUAL_VALUE}>Manual resource ID</SelectItem>
                    {faultResourceOptions.map((o) => (
                      <SelectItem key={o.id} value={o.id}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="demo-fault-id">Resource ID (manual fallback)</Label>
                <Input
                  id="demo-fault-id"
                  value={faultResourceId}
                  onChange={(e) => setFaultResourceId(e.target.value)}
                  placeholder="e.g. RV-0001"
                  required
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="demo-fault-code">Fault code</Label>
                <Input
                  id="demo-fault-code"
                  value={faultCode}
                  onChange={(e) => setFaultCode(e.target.value)}
                  placeholder="e.g. VEHICLE_FAULT"
                  required
                />
                <div className="flex flex-wrap gap-1 pt-0.5">
                  {INCIDENT_CATEGORIES.slice(0, 5).map((cat) => (
                    <Button
                      key={cat}
                      type="button"
                      variant={faultCode === cat ? 'secondary' : 'outline'}
                      size="sm"
                      className="h-6 px-1.5 text-[10px]"
                      onClick={() => setFaultCode(cat)}
                    >
                      {cat}
                    </Button>
                  ))}
                </div>
              </div>

              {faultMutation.error ? (
                <ErrorBox error={faultMutation.error} title="Could not queue fault" />
              ) : null}

              {faultMutation.data && (
                <div className="rounded border border-emerald-300 bg-emerald-50 p-2.5 text-xs text-emerald-950 space-y-1">
                  <div>Fault queued for next telemetry tick (~5 s).</div>
                  <Link to="/ops/incidents" className="underline">
                    Open Incidents →
                  </Link>
                </div>
              )}

              <Button
                type="submit"
                size="sm"
                className="w-full"
                disabled={!faultResourceId.trim() || !faultCode.trim() || faultMutation.isPending}
              >
                {faultMutation.isPending ? 'Queueing…' : 'Queue fault injection'}
              </Button>
            </form>
          </CardContent>
        </Card>

        {/* Card 3: Force vehicle battery */}
        <Card className="flex flex-col">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <BatteryLow className="h-4 w-4" />
              <span>Force vehicle battery</span>
            </CardTitle>
            <CardDescription className="text-xs">
              Queue a battery reading (0–100%) on the next tick to demonstrate low-battery alerts
              and BR-02 eligibility (FR-33).
            </CardDescription>
          </CardHeader>
          <CardContent className="flex-1 flex flex-col justify-between space-y-4">
            <form onSubmit={(e) => void handleForceBattery(e)} className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="demo-bat-hub">Hub</Label>
                <Select
                  value={effectiveBatteryHubId}
                  onValueChange={(v) => {
                    setBatteryHubId(v);
                    setBatteryVehicleId('');
                  }}
                >
                  <SelectTrigger id="demo-bat-hub">
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
                <Label htmlFor="demo-bat-picker">Pick rental vehicle</Label>
                <Select
                  value={batteryPickerValue}
                  onValueChange={(v) => {
                    if (v !== MANUAL_VALUE) setBatteryVehicleId(v);
                  }}
                  disabled={batteryVehicleOptions.length === 0}
                >
                  <SelectTrigger id="demo-bat-picker">
                    <SelectValue placeholder="Choose a vehicle…" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={MANUAL_VALUE}>Manual vehicle ID</SelectItem>
                    {batteryVehicleOptions.map((o) => (
                      <SelectItem key={o.id} value={o.id}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="demo-bat-id">Vehicle ID (manual fallback)</Label>
                <Input
                  id="demo-bat-id"
                  value={batteryVehicleId}
                  onChange={(e) => setBatteryVehicleId(e.target.value)}
                  placeholder="e.g. RV-0001"
                  required
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="demo-bat-pct">Battery percentage (0–100)</Label>
                <div className="flex items-center gap-2">
                  <Input
                    id="demo-bat-pct"
                    type="number"
                    min={0}
                    max={100}
                    value={batteryPct}
                    onChange={(e) => setBatteryPct(e.target.value)}
                    required
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setBatteryPct('15')}
                  >
                    15%
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setBatteryPct('85')}
                  >
                    85%
                  </Button>
                </div>
              </div>

              {batteryMutation.error ? (
                <ErrorBox error={batteryMutation.error} title="Could not queue battery override" />
              ) : null}

              {batteryMutation.data && (
                <div className="rounded border border-emerald-300 bg-emerald-50 p-2.5 text-xs text-emerald-950 space-y-1">
                  <div>Battery override queued for next telemetry tick (~5 s).</div>
                  <Link to="/ops/alerts" className="underline">
                    View Alerts →
                  </Link>
                </div>
              )}

              <Button
                type="submit"
                size="sm"
                className="w-full"
                disabled={!batteryVehicleId.trim() || batteryMutation.isPending}
              >
                {batteryMutation.isPending ? 'Queueing…' : 'Queue battery override'}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>

      {/* Rejected Telemetry Packets Log (NFR-25) */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <AlertTriangle className="h-4 w-4" />
            <span>Rejected Telemetry Packets</span>
          </CardTitle>
          <CardDescription className="text-xs">
            Malformed, unauthorised, or out-of-order packets rejected by ingestion (auto-refreshing
            every 5 s, NFR-25).
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {rejectsError && <ErrorBox error={rejectsError} title="Failed to load telemetry rejects" />}

          {rejectsLoading && <Skeleton className="h-28 w-full" />}

          {!rejectsLoading && !rejectsError && (rejectsData?.items.length ?? 0) === 0 && (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No rejected telemetry packets recorded.
            </p>
          )}

          {rejectsData && rejectsData.items.length > 0 && (
            <div className="overflow-x-auto rounded border">
              <table className="w-full text-xs">
                <thead className="bg-muted text-muted-foreground border-b">
                  <tr>
                    <th className="text-left p-2 font-medium">Received at</th>
                    <th className="text-left p-2 font-medium">Hub ID</th>
                    <th className="text-left p-2 font-medium">Packet timestamp</th>
                    <th className="text-left p-2 font-medium">Reason</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {rejectsData.items.map((rej, idx) => (
                    <tr key={`${rej.receivedAt}-${idx}`}>
                      <td className="p-2">{formatTime(rej.receivedAt)}</td>
                      <td className="p-2 font-mono">{rej.hubId ?? '—'}</td>
                      <td className="p-2">{formatTime(rej.packetTimestamp)}</td>
                      <td className="p-2">
                        <Badge variant="outline" className="border-red-300 bg-red-50 text-red-800">
                          {rej.reason}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
