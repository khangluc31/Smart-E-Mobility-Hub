-- Constraints Prisma can't express (ARCHITECTURE §5.2, D-03).
-- Column names are the quoted camelCase Prisma field names (fields are never @map'ped).
-- constraints.test.ts asserts each object below exists by name.

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- BR-01: at most one active vehicle Reservation/rental per Student, and per vehicle
CREATE UNIQUE INDEX uq_vres_active_user ON vehicle_reservation ("userId")
  WHERE status IN ('CONFIRMED','ACTIVE');
CREATE UNIQUE INDEX uq_vres_active_vehicle ON vehicle_reservation ("rentalVehicleId")
  WHERE status IN ('CONFIRMED','ACTIVE');

-- BR-01/BR-10/NFR-06: no overlapping parking windows on one space
ALTER TABLE parking_reservation ADD CONSTRAINT ex_parking_overlap
  EXCLUDE USING gist ("parkingSpaceId" WITH =, tstzrange("windowStart","windowEnd") WITH &&)
  WHERE (status IN ('CONFIRMED','ACTIVE'));

-- FR-21/FR-49: no overlapping slots on one charging point
ALTER TABLE charging_request ADD CONSTRAINT ex_charging_overlap
  EXCLUDE USING gist ("chargingPointId" WITH =, tstzrange("slotStart","slotEnd") WITH &&)
  WHERE (status IN ('SCHEDULED','CHARGING') AND "chargingPointId" IS NOT NULL);

-- one live charging request per vehicle
CREATE UNIQUE INDEX uq_charge_active_rental ON charging_request ("rentalVehicleId")
  WHERE status IN ('QUEUED','SCHEDULED','CHARGING') AND "rentalVehicleId" IS NOT NULL;
CREATE UNIQUE INDEX uq_charge_active_pev ON charging_request ("privateEvId")
  WHERE status IN ('QUEUED','SCHEDULED','CHARGING') AND "privateEvId" IS NOT NULL;

-- UC-21 E2: one open incident per resource
CREATE UNIQUE INDEX uq_incident_open ON incident ("resourceType","resourceId")
  WHERE status <> 'RESOLVED';

-- UC-20 E2: one open alert per condition
CREATE UNIQUE INDEX uq_alert_open ON alert ("dedupeKey") WHERE status = 'OPEN';

-- FR-63/FR-34: audit log is append-only, even for the table owner
CREATE FUNCTION forbid_change() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'audit_log is append-only'; END $$ LANGUAGE plpgsql;
CREATE TRIGGER audit_log_no_update BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- sanity
ALTER TABLE rental_vehicle ADD CONSTRAINT ck_rv_battery CHECK ("batteryPct" BETWEEN 0 AND 100);
ALTER TABLE private_ev ADD CONSTRAINT ck_pev_battery CHECK ("batteryPct" BETWEEN 0 AND 100);
ALTER TABLE parking_reservation ADD CONSTRAINT ck_pr_window CHECK ("windowEnd" > "windowStart");
ALTER TABLE charging_request ADD CONSTRAINT ck_cr_target CHECK ("targetPct" > 0 AND "targetPct" <= 100);

-- a booked/running slot must have both ends, else tstzrange(start, NULL) is infinite
-- and ex_charging_overlap would block the point forever
ALTER TABLE charging_request ADD CONSTRAINT ck_cr_slot CHECK (
  status NOT IN ('SCHEDULED','CHARGING') OR "chargingPointId" IS NULL
  OR ("slotStart" IS NOT NULL AND "slotEnd" IS NOT NULL AND "slotEnd" > "slotStart"));
