import { describe, it, expect, expectTypeOf } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as Prisma from '@prisma/client';
import * as E from '../src/types/enums';

// Each of our mirror arrays paired with the matching @prisma/client enum object.
const pairs: Array<{ name: string; prisma: Record<string, string>; mine: readonly string[] }> = [
  { name: 'Role', prisma: Prisma.Role, mine: E.ROLES },
  { name: 'VehicleClass', prisma: Prisma.VehicleClass, mine: E.VEHICLE_CLASSES },
  { name: 'RentalVehicleType', prisma: Prisma.RentalVehicleType, mine: E.RENTAL_VEHICLE_TYPES },
  { name: 'PrivateEvType', prisma: Prisma.PrivateEvType, mine: E.PRIVATE_EV_TYPES },
  { name: 'RentalVehicleStatus', prisma: Prisma.RentalVehicleStatus, mine: E.RENTAL_VEHICLE_STATUSES },
  { name: 'ReservationStatus', prisma: Prisma.ReservationStatus, mine: E.RESERVATION_STATUSES },
  { name: 'ParkingSpaceStatus', prisma: Prisma.ParkingSpaceStatus, mine: E.PARKING_SPACE_STATUSES },
  { name: 'ParkingPool', prisma: Prisma.ParkingPool, mine: E.PARKING_POOLS },
  { name: 'ChargingPointStatus', prisma: Prisma.ChargingPointStatus, mine: E.CHARGING_POINT_STATUSES },
  { name: 'ChargingRequestStatus', prisma: Prisma.ChargingRequestStatus, mine: E.CHARGING_REQUEST_STATUSES },
  { name: 'ChargingMode', prisma: Prisma.ChargingMode, mine: E.CHARGING_MODES },
  { name: 'ChargingEndReason', prisma: Prisma.ChargingEndReason, mine: E.CHARGING_END_REASONS },
  { name: 'IncidentStatus', prisma: Prisma.IncidentStatus, mine: E.INCIDENT_STATUSES },
  { name: 'IncidentResourceType', prisma: Prisma.IncidentResourceType, mine: E.INCIDENT_RESOURCE_TYPES },
  { name: 'IncidentCategory', prisma: Prisma.IncidentCategory, mine: E.INCIDENT_CATEGORIES },
  { name: 'IncidentSource', prisma: Prisma.IncidentSource, mine: E.INCIDENT_SOURCES },
  { name: 'AlertType', prisma: Prisma.AlertType, mine: E.ALERT_TYPES },
  { name: 'AlertStatus', prisma: Prisma.AlertStatus, mine: E.ALERT_STATUSES },
  { name: 'RedistributionStatus', prisma: Prisma.RedistributionStatus, mine: E.REDISTRIBUTION_STATUSES },
  { name: 'SimRunStatus', prisma: Prisma.SimRunStatus, mine: E.SIM_RUN_STATUSES },
  { name: 'RecommendationType', prisma: Prisma.RecommendationType, mine: E.RECOMMENDATION_TYPES },
  { name: 'RecommendationStatus', prisma: Prisma.RecommendationStatus, mine: E.RECOMMENDATION_STATUSES },
  { name: 'ChargingVehicleKind', prisma: Prisma.ChargingVehicleKind, mine: E.CHARGING_VEHICLE_KINDS },
  {
    name: 'VehicleReservationEndReason',
    prisma: Prisma.VehicleReservationEndReason,
    mine: E.VEHICLE_RESERVATION_END_REASONS,
  },
  { name: 'ImpactBookingType', prisma: Prisma.ImpactBookingType, mine: E.IMPACT_BOOKING_TYPES },
  { name: 'ImpactOutcome', prisma: Prisma.ImpactOutcome, mine: E.IMPACT_OUTCOMES },
  { name: 'RedistributionOrigin', prisma: Prisma.RedistributionOrigin, mine: E.REDISTRIBUTION_ORIGINS },
];

describe('T-03 AC-11 enum mirror matches Prisma', () => {
  it('T-03 AC-11 every exported array has the same members as its @prisma/client enum', () => {
    expect(pairs.length).toBe(27);
    for (const { name, prisma, mine } of pairs) {
      const prismaValues = Object.values(prisma).sort();
      const mineValues = [...mine].sort();
      expect(mineValues, `enum ${name}`).toEqual(prismaValues);
    }
  });

  it('T-03 AC-11 frontend enums.ts is byte-identical to the backend file', () => {
    const backend = readFileSync(join(__dirname, '../src/types/enums.ts'));
    const frontend = readFileSync(join(__dirname, '../../frontend/src/types/enums.ts'));
    expect(frontend.equals(backend)).toBe(true);
  });

  it('T-04/T-05 every backend types file except express.d.ts has a byte-identical frontend twin', () => {
    const files = readdirSync(join(__dirname, '../src/types')).filter(
      (f) => f.endsWith('.ts') && f !== 'express.d.ts',
    );
    expect(files.length).toBeGreaterThanOrEqual(4);
    for (const file of files) {
      const be = readFileSync(join(__dirname, `../src/types/${file}`));
      const fe = readFileSync(join(__dirname, `../../frontend/src/types/${file}`));
      expect(fe.equals(be), `${file} mismatch`).toBe(true);
    }
  });

  it('T-03 AC-11 mirror types equal the Prisma enum unions (type-level)', () => {
    expectTypeOf<E.Role>().toEqualTypeOf<Prisma.Role>();
    expectTypeOf<E.RentalVehicleStatus>().toEqualTypeOf<Prisma.RentalVehicleStatus>();
    expectTypeOf<E.ReservationStatus>().toEqualTypeOf<Prisma.ReservationStatus>();
    expectTypeOf<E.ChargingRequestStatus>().toEqualTypeOf<Prisma.ChargingRequestStatus>();
    expectTypeOf<E.IncidentCategory>().toEqualTypeOf<Prisma.IncidentCategory>();
  });
});
