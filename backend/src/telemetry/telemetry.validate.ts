// Pure telemetry packet validation (FR-30, NFR-24, NFR-25, CONTRACTS §14).
// No Prisma, no Express. Returns a validated TelemetryPacket or a list of validation problems.

import {
  TELEMETRY_SOURCES,
  type TelemetryPacket,
  type TelemetryPrivateEvItem,
  type TelemetryResourceFaultItem,
  type TelemetrySource,
  type TelemetryVehicleItem,
} from '../types/telemetry';

export interface PacketValidationProblem {
  field: string;
  message: string;
  reason: string;
}

export type ParsePacketResult =
  | { ok: true; packet: TelemetryPacket; parsedTimestamp: Date }
  | {
      ok: false;
      problems: PacketValidationProblem[];
      bestEffortHubId: string | null;
      bestEffortTimestamp: Date | null;
    };

const ISO_DATE =
  /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?)?$/;

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim() !== '';
}

function parseIsoTimestamp(v: unknown): Date | null {
  if (typeof v !== 'string' || !ISO_DATE.test(v)) return null;
  const ms = Date.parse(v);
  if (Number.isNaN(ms)) return null;
  // TODO(M1): reject timestamps far in the future?
  return new Date(ms);
}

function validateFaultCode(
  raw: unknown,
  field: string,
  problems: PacketValidationProblem[],
): string | null | undefined {
  if (raw === undefined || raw === null) return raw;
  if (!isNonEmptyString(raw)) {
    problems.push({
      field,
      message: `${field} must be a non-empty string or null.`,
      reason: 'INVALID_FAULT_CODE',
    });
    return undefined;
  }
  return raw.trim();
}

function validateBatteryPct(
  raw: unknown,
  field: string,
  problems: PacketValidationProblem[],
): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    problems.push({
      field,
      message: `${field} must be a number between 0 and 100.`,
      reason: 'INVALID_BATTERY_PCT',
    });
    return null;
  }
  if (raw < 0 || raw > 100) {
    problems.push({
      field,
      message: `${field} must be between 0 and 100.`,
      reason: 'BATTERY_OUT_OF_RANGE',
    });
    return null;
  }
  return raw;
}

export function parsePacket(body: unknown): ParsePacketResult {
  const problems: PacketValidationProblem[] = [];

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return {
      ok: false,
      problems: [
        {
          field: 'body',
          message: 'Telemetry packet must be a JSON object.',
          reason: 'MALFORMED_BODY',
        },
      ],
      bestEffortHubId: null,
      bestEffortTimestamp: null,
    };
  }

  const obj = body as Record<string, unknown>;

  let bestEffortHubId: string | null = null;
  if (isNonEmptyString(obj['hubId'])) {
    bestEffortHubId = obj['hubId'].trim();
  } else {
    problems.push({
      field: 'hubId',
      message: 'hubId is required and must be a non-empty string.',
      reason: 'INVALID_HUB_ID',
    });
  }

  const bestEffortTimestamp = parseIsoTimestamp(obj['timestamp']);
  if (!bestEffortTimestamp) {
    problems.push({
      field: 'timestamp',
      message: 'timestamp is required and must be a valid ISO-8601 date string.',
      reason: 'INVALID_TIMESTAMP',
    });
  }

  const rawSource = obj['source'];
  let source: TelemetrySource | null = null;
  if (
    typeof rawSource === 'string' &&
    (TELEMETRY_SOURCES as readonly string[]).includes(rawSource)
  ) {
    source = rawSource as TelemetrySource;
  } else {
    problems.push({
      field: 'source',
      message: `source must be one of: ${TELEMETRY_SOURCES.join(', ')}.`,
      reason: 'INVALID_SOURCE',
    });
  }

  let vehicles: TelemetryVehicleItem[] | undefined;
  if (obj['vehicles'] !== undefined) {
    if (!Array.isArray(obj['vehicles'])) {
      problems.push({
        field: 'vehicles',
        message: 'vehicles must be an array.',
        reason: 'INVALID_VEHICLES_LIST',
      });
    } else {
      vehicles = [];
      const seen = new Set<string>();
      obj['vehicles'].forEach((item: unknown, idx: number) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
          problems.push({
            field: `vehicles[${idx}]`,
            message: `vehicles[${idx}] must be an object.`,
            reason: 'INVALID_VEHICLE_ITEM',
          });
          return;
        }
        const rec = item as Record<string, unknown>;
        const idField = `vehicles[${idx}].id`;
        if (!isNonEmptyString(rec['id'])) {
          problems.push({
            field: idField,
            message: `${idField} must be a non-empty string.`,
            reason: 'INVALID_VEHICLE_ID',
          });
          return;
        }
        const id = rec['id'].trim();
        if (seen.has(id)) {
          problems.push({
            field: 'vehicles',
            message: `Duplicate vehicle id "${id}" in vehicles list.`,
            reason: 'DUPLICATE_ID',
          });
          return;
        }
        seen.add(id);

        const batteryPct = validateBatteryPct(
          rec['batteryPct'],
          `vehicles[${idx}].batteryPct`,
          problems,
        );
        const faultCode = validateFaultCode(
          rec['faultCode'],
          `vehicles[${idx}].faultCode`,
          problems,
        );
        if (batteryPct !== null) {
          const entry: TelemetryVehicleItem = { id, batteryPct };
          if (faultCode !== undefined) entry.faultCode = faultCode;
          vehicles!.push(entry);
        }
      });
    }
  }

  let privateEvs: TelemetryPrivateEvItem[] | undefined;
  if (obj['privateEvs'] !== undefined) {
    if (!Array.isArray(obj['privateEvs'])) {
      problems.push({
        field: 'privateEvs',
        message: 'privateEvs must be an array.',
        reason: 'INVALID_PRIVATE_EVS_LIST',
      });
    } else {
      privateEvs = [];
      const seen = new Set<string>();
      obj['privateEvs'].forEach((item: unknown, idx: number) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
          problems.push({
            field: `privateEvs[${idx}]`,
            message: `privateEvs[${idx}] must be an object.`,
            reason: 'INVALID_PRIVATE_EV_ITEM',
          });
          return;
        }
        const rec = item as Record<string, unknown>;
        const idField = `privateEvs[${idx}].id`;
        if (!isNonEmptyString(rec['id'])) {
          problems.push({
            field: idField,
            message: `${idField} must be a non-empty string.`,
            reason: 'INVALID_PRIVATE_EV_ID',
          });
          return;
        }
        const id = rec['id'].trim();
        if (seen.has(id)) {
          problems.push({
            field: 'privateEvs',
            message: `Duplicate privateEv id "${id}" in privateEvs list.`,
            reason: 'DUPLICATE_ID',
          });
          return;
        }
        seen.add(id);

        const batteryPct = validateBatteryPct(
          rec['batteryPct'],
          `privateEvs[${idx}].batteryPct`,
          problems,
        );
        if (batteryPct !== null) {
          privateEvs!.push({ id, batteryPct });
        }
      });
    }
  }

  function validateResourceFaultList(
    listName: 'parkingSpaces' | 'chargingPoints',
  ): TelemetryResourceFaultItem[] | undefined {
    const rawList = obj[listName];
    if (rawList === undefined) return undefined;
    if (!Array.isArray(rawList)) {
      problems.push({
        field: listName,
        message: `${listName} must be an array.`,
        reason: 'INVALID_RESOURCE_LIST',
      });
      return undefined;
    }
    const items: TelemetryResourceFaultItem[] = [];
    const seen = new Set<string>();
    rawList.forEach((item: unknown, idx: number) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        problems.push({
          field: `${listName}[${idx}]`,
          message: `${listName}[${idx}] must be an object.`,
          reason: 'INVALID_RESOURCE_ITEM',
        });
        return;
      }
      const rec = item as Record<string, unknown>;
      const idField = `${listName}[${idx}].id`;
      if (!isNonEmptyString(rec['id'])) {
        problems.push({
          field: idField,
          message: `${idField} must be a non-empty string.`,
          reason: 'INVALID_RESOURCE_ID',
        });
        return;
      }
      const id = rec['id'].trim();
      if (seen.has(id)) {
        problems.push({
          field: listName,
          message: `Duplicate id "${id}" in ${listName} list.`,
          reason: 'DUPLICATE_ID',
        });
        return;
      }
      seen.add(id);

      const faultCode = validateFaultCode(
        rec['faultCode'],
        `${listName}[${idx}].faultCode`,
        problems,
      );
      const entry: TelemetryResourceFaultItem = { id };
      if (faultCode !== undefined) entry.faultCode = faultCode;
      items.push(entry);
    });
    return items;
  }

  const parkingSpaces = validateResourceFaultList('parkingSpaces');
  const chargingPoints = validateResourceFaultList('chargingPoints');

  if (problems.length > 0 || !bestEffortHubId || !bestEffortTimestamp || !source) {
    return {
      ok: false,
      problems,
      bestEffortHubId,
      bestEffortTimestamp,
    };
  }

  const packet: TelemetryPacket = {
    hubId: bestEffortHubId,
    timestamp: obj['timestamp'] as string,
    source,
  };
  if (vehicles !== undefined) packet.vehicles = vehicles;
  if (privateEvs !== undefined) packet.privateEvs = privateEvs;
  if (parkingSpaces !== undefined) packet.parkingSpaces = parkingSpaces;
  if (chargingPoints !== undefined) packet.chargingPoints = chargingPoints;

  return {
    ok: true,
    packet,
    parsedTimestamp: bestEffortTimestamp,
  };
}
