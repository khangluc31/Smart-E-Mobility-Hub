// Telemetry demo controls and reject listing service (CONTRACTS §14, FR-03, FR-33, FR-35, FR-36, NFR-25).
// Validates Hub/resource existence, queues demo directives in memory, and writes Operator audit rows.

import { audit } from '../core/audit';
import { config } from '../core/config';
import { db, type DbClient } from '../core/db';
import { notFound } from '../core/errors';
import type { IncidentResourceType, Role } from '../types/enums';
import type {
  TelemetryDemoQueuedResponse,
  TelemetryDemoStallResponse,
  TelemetryRejectsResponse,
} from '../types/telemetry';
import { enqueueBatteryOverride, enqueueFault, setHubStall } from './demoState';

export interface OperatorActor {
  id: string;
  role: Role;
}

export async function stallHub(
  input: { hubId: string; seconds: number },
  actor: OperatorActor,
  now: Date = new Date(),
  client: DbClient = db,
): Promise<TelemetryDemoStallResponse> {
  const hub = await client.hub.findUnique({ where: { id: input.hubId } });
  if (!hub) throw notFound('Hub');

  const stalledUntil = new Date(now.getTime() + input.seconds * 1000);
  setHubStall(hub.id, stalledUntil);

  await audit(client, {
    actorId: actor.id,
    actorRole: actor.role,
    action: 'TELEMETRY_DEMO_STALL',
    entityType: 'hub',
    entityIds: [hub.id],
    details: { seconds: input.seconds, stalledUntil: stalledUntil.toISOString() },
  });

  return {
    hubId: hub.id,
    stalledUntil: stalledUntil.toISOString(),
  };
}

export async function queueFault(
  input: { resourceType: IncidentResourceType; resourceId: string; faultCode: string },
  actor: OperatorActor,
  client: DbClient = db,
): Promise<TelemetryDemoQueuedResponse> {
  let hubId: string | null = null;

  if (input.resourceType === 'RENTAL_VEHICLE') {
    const rv = await client.rentalVehicle.findUnique({
      where: { id: input.resourceId },
      select: { hubId: true },
    });
    if (!rv) throw notFound('Rental vehicle');
    hubId = rv.hubId;
  } else if (input.resourceType === 'PARKING_SPACE') {
    const ps = await client.parkingSpace.findUnique({
      where: { id: input.resourceId },
      select: { hubId: true },
    });
    if (!ps) throw notFound('Parking space');
    hubId = ps.hubId;
  } else {
    const cp = await client.chargingPoint.findUnique({
      where: { id: input.resourceId },
      select: { hubId: true },
    });
    if (!cp) throw notFound('Charging point');
    hubId = cp.hubId;
  }

  enqueueFault({
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    hubId,
    faultCode: input.faultCode,
  });

  await audit(client, {
    actorId: actor.id,
    actorRole: actor.role,
    action: 'TELEMETRY_DEMO_FAULT',
    entityType: input.resourceType.toLowerCase(),
    entityIds: [input.resourceId],
    details: { hubId, resourceType: input.resourceType, faultCode: input.faultCode },
  });

  return { queued: true };
}

export async function queueBattery(
  input: { vehicleId: string; batteryPct: number },
  actor: OperatorActor,
  client: DbClient = db,
): Promise<TelemetryDemoQueuedResponse> {
  const rv = await client.rentalVehicle.findUnique({
    where: { id: input.vehicleId },
    select: { id: true, hubId: true },
  });
  if (!rv) throw notFound('Rental vehicle');

  const rounded = Math.round(input.batteryPct * 10) / 10;
  enqueueBatteryOverride({
    vehicleId: rv.id,
    hubId: rv.hubId,
    batteryPct: rounded,
  });

  await audit(client, {
    actorId: actor.id,
    actorRole: actor.role,
    action: 'TELEMETRY_DEMO_BATTERY',
    entityType: 'rental_vehicle',
    entityIds: [rv.id],
    details: { hubId: rv.hubId, batteryPct: rounded },
  });

  return { queued: true };
}

export async function listRejects(
  limit: number = config.LIST_LIMIT_DEFAULT,
  client: DbClient = db,
): Promise<TelemetryRejectsResponse> {
  const rows = await client.telemetryReject.findMany({
    orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
    take: limit,
  });

  return {
    items: rows.map((r) => ({
      hubId: r.hubId,
      packetTimestamp: r.packetTimestamp?.toISOString() ?? null,
      reason: r.reason,
      receivedAt: r.receivedAt.toISOString(),
    })),
  };
}
