// Shared Incident DTO types (CONTRACTS §4, §11).
// Keep backend/src/types/incidents.ts and frontend/src/types/incidents.ts byte-identical.

import type {
  ImpactBookingType,
  ImpactOutcome,
  IncidentCategory,
  IncidentResourceType,
  IncidentSource,
  IncidentStatus,
  VehicleClass,
} from './enums';

export interface Incident {
  id: string;
  status: IncidentStatus;
  resourceType: IncidentResourceType;
  resourceId: string;
  hubId: string;
  vehicleClass: VehicleClass;
  category: IncidentCategory;
  notes: string;
  source: IncidentSource;
  reportedById: string | null;
  resolutionNotes: string | null;
  createdAt: string;
  inMaintenanceAt: string | null;
  resolvedAt: string | null;
}

export interface IncidentImpact {
  bookingType: ImpactBookingType;
  bookingId: string;
  userId: string | null;
  outcome: ImpactOutcome;
  newResourceId: string | null;
}

export interface ReportIncidentResult {
  incident: Incident;
  linkedToExisting: boolean;
  impacts: IncidentImpact[];
}

export interface StudentReportFaultResult {
  incidentId: string;
  linkedToExisting: boolean;
}

export interface IncidentReportView {
  source: IncidentSource;
  reportedById: string | null;
  notes: string;
  createdAt: string;
}

export interface IncidentDetail {
  incident: Incident;
  reports: IncidentReportView[];
  impacts: IncidentImpact[];
}

export interface IncidentList {
  items: Incident[];
  nextCursor: string | null;
}
