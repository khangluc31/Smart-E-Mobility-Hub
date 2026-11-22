// Telemetry ingestion service (FR-30, FR-36, NFR-24, NFR-25, D-09, D-17, D-22).
// Validates packet shape, locks the Hub row, rejects unknown/foreign resources or stale
// timestamps with 0 live state changes, logs every reject after rollback, updates physical
// facts in one transaction, and emits TELEMETRY_INGESTED after commit.

import { Prisma } from '@prisma/client';
import { db, lockRow, type DbClient } from '../core/db';
import { AppError, badRequest, conflict } from '../core/errors';
import { events } from '../core/events';
import type { IncidentResourceType } from '../types/enums';
import { parsePacket } from './telemetry.validate';

export interface IngestFault {
  resourceType: IncidentResourceType;
  resourceId: string;
  faultCode: string;
}

export interface IngestResult {
  hubId: string;
  appliedAt: string;
  faults: IngestFault[];
  targetsReached: string[];
}

export interface RejectRecordInput {
  hubId?: string | null;
  packetTimestamp?: Date | null;
  reason: string;
  payload?: unknown;
  receivedAt?: Date;
}

class TelemetryRejectError extends Error {
  readonly appError: AppError;
  readonly reason: string;

  constructor(appError: AppError, reason: string) {
    super(appError.message);
    this.name = 'TelemetryRejectError';
    this.appError = appError;
    this.reason = reason;
  }
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function safeJsonPayload(payload: unknown): Prisma.InputJsonValue {
  if (payload === undefined || payload === null) return {};
  try {
    return JSON.parse(JSON.stringify(payload)) as Prisma.InputJsonValue;
  } catch {
    return {};
  }
}

// Logs a rejected telemetry packet with plain db outside any rolled-back transaction (D-22, NFR-25).
export async function recordReject(
  input: RejectRecordInput,
  client: DbClient = db,
): Promise<void> {
  await client.telemetryReject.create({
    data: {
      hubId: input.hubId ?? null,
      packetTimestamp: input.packetTimestamp ?? null,
      reason: input.reason,
      payload: safeJsonPayload(input.payload),
      receivedAt: input.receivedAt ?? new Date(),
    },
  });
}

// Post-commit side effects (ARCHITECTURE §4.6, §7.3, Rule 4).
export function afterCommit(result: IngestResult): void {
  events.emit('TELEMETRY_INGESTED', { hubId: result.hubId });

  // TODO(M6, incidents ticket): incidents.service.create({ source: 'TELEMETRY', ... }) for each fault (FR-36)
  // TODO(M6, charging ticket): charging.service.endSession(id, 'TARGET_REACHED') for each targetsReached (FR-23)
}

export async function ingest(
  rawPacket: unknown,
  now: Date = new Date(),
  client: typeof db = db,
): Promise<IngestResult> {
  // Rule 2(a): Validate shape first before starting any DB transaction.
  const parsed = parsePacket(rawPacket);
  if (!parsed.ok) {
    const first = parsed.problems[0] ?? {
      field: 'body',
      message: 'Invalid telemetry packet.',
      reason: 'MALFORMED_PACKET',
    };
    await recordReject(
      {
        hubId: parsed.bestEffortHubId,
        packetTimestamp: parsed.bestEffortTimestamp,
        reason: first.reason,
        payload: rawPacket,
        receivedAt: now,
      },
      client,
    );
    throw badRequest(first.message, first.field);
  }

  const { packet, parsedTimestamp } = parsed;

  let result: IngestResult;
  try {
    result = await client.$transaction(async (tx) => {
      // Rule 3: Lock the Hub row first so concurrent packets for the same Hub serialize.
      try {
        await lockRow(tx, 'hub', packet.hubId);
      } catch (err) {
        if (err instanceof AppError && err.status === 404) {
          throw new TelemetryRejectError(
            badRequest(`Unknown hubId "${packet.hubId}".`, 'hubId'),
            'UNKNOWN_HUB',
          );
        }
        throw err;
      }

      const hub = await tx.hub.findUnique({ where: { id: packet.hubId } });
      if (!hub) {
        throw new TelemetryRejectError(
          badRequest(`Unknown hubId "${packet.hubId}".`, 'hubId'),
          'UNKNOWN_HUB',
        );
      }

      // Rule 2(b): Validate all resource IDs exist and belong to this Hub before checking timestamp or mutating.
      const vehicleItems = packet.vehicles ?? [];
      if (vehicleItems.length > 0) {
        const ids = vehicleItems.map((v) => v.id);
        const rows = await tx.rentalVehicle.findMany({
          where: { id: { in: ids } },
          select: { id: true, hubId: true },
        });
        const byId = new Map(rows.map((r) => [r.id, r]));
        for (const item of vehicleItems) {
          const found = byId.get(item.id);
          if (!found || found.hubId !== packet.hubId) {
            throw new TelemetryRejectError(
              badRequest(
                `Rental vehicle "${item.id}" does not exist at Hub "${packet.hubId}".`,
                `vehicles.${item.id}`,
              ),
              !found ? 'UNKNOWN_VEHICLE' : 'FOREIGN_VEHICLE',
            );
          }
        }
      }

      const privateEvItems = packet.privateEvs ?? [];
      if (privateEvItems.length > 0) {
        const ids = privateEvItems.map((p) => p.id);
        const [evRows, activeCharging, activeParking] = await Promise.all([
          tx.privateEv.findMany({
            where: { id: { in: ids }, deletedAt: null },
            select: { id: true },
          }),
          tx.chargingRequest.findMany({
            where: {
              hubId: packet.hubId,
              status: 'CHARGING',
              privateEvId: { in: ids },
            },
            select: { privateEvId: true },
          }),
          tx.parkingReservation.findMany({
            where: {
              hubId: packet.hubId,
              status: 'ACTIVE',
              privateEvId: { in: ids },
            },
            select: { privateEvId: true },
          }),
        ]);
        const existingEvs = new Set(evRows.map((r) => r.id));
        const presentAtHub = new Set<string>();
        for (const r of activeCharging) {
          if (r.privateEvId) presentAtHub.add(r.privateEvId);
        }
        for (const r of activeParking) {
          if (r.privateEvId) presentAtHub.add(r.privateEvId);
        }

        for (const item of privateEvItems) {
          if (!existingEvs.has(item.id) || !presentAtHub.has(item.id)) {
            throw new TelemetryRejectError(
              badRequest(
                `Private EV "${item.id}" does not have an active charging session or active parking reservation at Hub "${packet.hubId}".`,
                `privateEvs.${item.id}`,
              ),
              !existingEvs.has(item.id) ? 'UNKNOWN_PRIVATE_EV' : 'FOREIGN_PRIVATE_EV',
            );
          }
        }
      }

      const spaceItems = packet.parkingSpaces ?? [];
      if (spaceItems.length > 0) {
        const ids = spaceItems.map((s) => s.id);
        const rows = await tx.parkingSpace.findMany({
          where: { id: { in: ids } },
          select: { id: true, hubId: true },
        });
        const byId = new Map(rows.map((r) => [r.id, r]));
        for (const item of spaceItems) {
          const found = byId.get(item.id);
          if (!found || found.hubId !== packet.hubId) {
            throw new TelemetryRejectError(
              badRequest(
                `Parking space "${item.id}" does not exist at Hub "${packet.hubId}".`,
                `parkingSpaces.${item.id}`,
              ),
              !found ? 'UNKNOWN_PARKING_SPACE' : 'FOREIGN_PARKING_SPACE',
            );
          }
        }
      }

      const pointItems = packet.chargingPoints ?? [];
      if (pointItems.length > 0) {
        const ids = pointItems.map((p) => p.id);
        const rows = await tx.chargingPoint.findMany({
          where: { id: { in: ids } },
          select: { id: true, hubId: true },
        });
        const byId = new Map(rows.map((r) => [r.id, r]));
        for (const item of pointItems) {
          const found = byId.get(item.id);
          if (!found || found.hubId !== packet.hubId) {
            throw new TelemetryRejectError(
              badRequest(
                `Charging point "${item.id}" does not exist at Hub "${packet.hubId}".`,
                `chargingPoints.${item.id}`,
              ),
              !found ? 'UNKNOWN_CHARGING_POINT' : 'FOREIGN_CHARGING_POINT',
            );
          }
        }
      }

      // Rule 2(c) & Rule 3: Re-check timestamp freshness inside the Hub row lock (FR-30).
      if (hub.lastTelemetryAt && parsedTimestamp.getTime() <= hub.lastTelemetryAt.getTime()) {
        throw new TelemetryRejectError(
          conflict(
            'STALE_PACKET',
            `Telemetry packet timestamp (${packet.timestamp}) is not newer than Hub lastTelemetryAt (${hub.lastTelemetryAt.toISOString()}).`,
            {
              nextActions: ['Send a telemetry packet with a newer timestamp.'],
              details: {
                hubId: packet.hubId,
                timestamp: packet.timestamp,
                lastTelemetryAt: hub.lastTelemetryAt.toISOString(),
              },
            },
          ),
          'STALE_PACKET',
        );
      }

      // Load active CHARGING requests at this Hub for the referenced vehicles / Private EVs.
      const chargingRequests =
        vehicleItems.length > 0 || privateEvItems.length > 0
          ? await tx.chargingRequest.findMany({
              where: {
                hubId: packet.hubId,
                status: 'CHARGING',
              },
              select: {
                id: true,
                rentalVehicleId: true,
                privateEvId: true,
                targetPct: true,
              },
            })
          : [];

      const chargingByRentalId = new Map<string, { id: string; targetPct: number }>();
      const chargingByPrivateEvId = new Map<string, { id: string; targetPct: number }>();
      for (const cr of chargingRequests) {
        if (cr.rentalVehicleId) {
          chargingByRentalId.set(cr.rentalVehicleId, { id: cr.id, targetPct: cr.targetPct });
        }
        if (cr.privateEvId) {
          chargingByPrivateEvId.set(cr.privateEvId, { id: cr.id, targetPct: cr.targetPct });
        }
      }

      const faults: IngestFault[] = [];
      const targetsReached: string[] = [];

      // Apply rental vehicle battery updates and collect faults (D-17: never change status).
      for (const item of vehicleItems) {
        const batteryPct = round1(item.batteryPct);
        await tx.rentalVehicle.update({
          where: { id: item.id },
          data: { batteryPct },
        });

        const cr = chargingByRentalId.get(item.id);
        if (cr) {
          const currentPct = round1(Math.min(batteryPct, cr.targetPct));
          await tx.chargingRequest.update({
            where: { id: cr.id },
            data: { currentPct },
          });
          if (currentPct >= cr.targetPct) {
            targetsReached.push(cr.id);
          }
        }

        if (item.faultCode) {
          faults.push({
            resourceType: 'RENTAL_VEHICLE',
            resourceId: item.id,
            faultCode: item.faultCode,
          });
        }
      }

      // Apply Private EV battery updates and charging session progress.
      for (const item of privateEvItems) {
        const batteryPct = round1(item.batteryPct);
        await tx.privateEv.update({
          where: { id: item.id },
          data: { batteryPct },
        });

        const cr = chargingByPrivateEvId.get(item.id);
        if (cr) {
          const currentPct = round1(Math.min(batteryPct, cr.targetPct));
          await tx.chargingRequest.update({
            where: { id: cr.id },
            data: { currentPct },
          });
          if (currentPct >= cr.targetPct) {
            targetsReached.push(cr.id);
          }
        }
      }

      // Collect parking space and charging point fault codes (D-17: no status change).
      for (const item of spaceItems) {
        if (item.faultCode) {
          faults.push({
            resourceType: 'PARKING_SPACE',
            resourceId: item.id,
            faultCode: item.faultCode,
          });
        }
      }

      for (const item of pointItems) {
        if (item.faultCode) {
          faults.push({
            resourceType: 'CHARGING_POINT',
            resourceId: item.id,
            faultCode: item.faultCode,
          });
        }
      }

      // Advance hub.lastTelemetryAt to the packet timestamp.
      await tx.hub.update({
        where: { id: packet.hubId },
        data: { lastTelemetryAt: parsedTimestamp },
      });

      return {
        hubId: packet.hubId,
        appliedAt: now.toISOString(),
        faults,
        targetsReached,
      };
    });
  } catch (err) {
    if (err instanceof TelemetryRejectError) {
      // D-22 pattern: transaction has rolled back, write telemetry_reject with plain db.
      await recordReject(
        {
          hubId: packet.hubId,
          packetTimestamp: parsedTimestamp,
          reason: err.reason,
          payload: rawPacket,
          receivedAt: now,
        },
        client,
      );
      throw err.appError;
    }
    throw err;
  }

  afterCommit(result);
  return result;
}
