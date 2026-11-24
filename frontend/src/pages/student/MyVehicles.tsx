// Student My Private EVs page (FR-25, FR-26, FR-27, NFR-05/28).

import { useState } from 'react';
import { Car, Pencil, Plus, Trash2 } from 'lucide-react';
import {
  useCreatePrivateEv,
  usePrivateEvs,
  useRemovePrivateEv,
  useUpdatePrivateEv,
} from '@/hooks/usePrivateEvs';
import { PRIVATE_EV_TYPES, type PrivateEvType, type VehicleClass } from '@/types/enums';
import type { PrivateEv } from '@/types/privateEvs';
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

export function MyVehicles() {
  const { data: evs, isLoading, error } = usePrivateEvs();

  const createMutation = useCreatePrivateEv();
  const updateMutation = useUpdatePrivateEv();
  const removeMutation = useRemovePrivateEv();

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
                      disabled
                      title="Combined parking + charging booking is coming soon"
                    >
                      Book parking + charging (coming soon)
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
    </div>
  );
}
