// Telemetry DTOs (CONTRACTS §14, ARCHITECTURE §7).
// No imports except ./enums so the file can be copied byte-for-byte to the frontend.

import type { IncidentResourceType } from './enums';

export const TELEMETRY_SOURCES = ['SIMULATOR', 'MOCK_SENSOR', 'SENSOR'] as const;
export type TelemetrySource = (typeof TELEMETRY_SOURCES)[number];

export interface TelemetryVehicleItem {
  id: string;
  batteryPct: number;
  faultCode?: string | null;
}

export interface TelemetryPrivateEvItem {
  id: string;
  batteryPct: number;
}

export interface TelemetryResourceFaultItem {
  id: string;
  faultCode?: string | null;
}

export interface TelemetryPacket {
  hubId: string;
  timestamp: string;
  source: TelemetrySource;
  vehicles?: TelemetryVehicleItem[];
  privateEvs?: TelemetryPrivateEvItem[];
  parkingSpaces?: TelemetryResourceFaultItem[];
  chargingPoints?: TelemetryResourceFaultItem[];
}

export interface TelemetryIngestResponse {
  accepted: true;
  hubId: string;
  appliedAt: string;
}

export interface TelemetryReject {
  hubId: string | null;
  packetTimestamp: string | null;
  reason: string;
  receivedAt: string;
}

export interface TelemetryRejectsResponse {
  items: TelemetryReject[];
}

export interface TelemetryDemoStallRequest {
  hubId: string;
  seconds: number;
}

export interface TelemetryDemoStallResponse {
  hubId: string;
  stalledUntil: string;
}

export interface TelemetryDemoFaultRequest {
  resourceType: IncidentResourceType;
  resourceId: string;
  faultCode: string;
}

export interface TelemetryDemoBatteryRequest {
  vehicleId: string;
  batteryPct: number;
}

export interface TelemetryDemoQueuedResponse {
  queued: true;
}
