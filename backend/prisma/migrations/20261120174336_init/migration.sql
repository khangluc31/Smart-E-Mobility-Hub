-- CreateEnum
CREATE TYPE "Role" AS ENUM ('STUDENT', 'OPERATOR');

-- CreateEnum
CREATE TYPE "VehicleClass" AS ENUM ('MOTORCYCLE', 'CAR');

-- CreateEnum
CREATE TYPE "RentalVehicleType" AS ENUM ('E_BICYCLE', 'E_MOTORCYCLE');

-- CreateEnum
CREATE TYPE "PrivateEvType" AS ENUM ('E_MOTORCYCLE', 'CAR');

-- CreateEnum
CREATE TYPE "RentalVehicleStatus" AS ENUM ('AVAILABLE', 'RESERVED', 'IN_USE', 'LOW_BATTERY', 'IN_TRANSIT', 'FAULTY');

-- CreateEnum
CREATE TYPE "ReservationStatus" AS ENUM ('CONFIRMED', 'ACTIVE', 'COMPLETED', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "ParkingSpaceStatus" AS ENUM ('FREE', 'RESERVED', 'OCCUPIED', 'UNAVAILABLE');

-- CreateEnum
CREATE TYPE "ParkingPool" AS ENUM ('FLEET', 'PUBLIC');

-- CreateEnum
CREATE TYPE "ChargingPointStatus" AS ENUM ('AVAILABLE', 'CHARGING', 'FAULTY');

-- CreateEnum
CREATE TYPE "ChargingRequestStatus" AS ENUM ('QUEUED', 'SCHEDULED', 'CHARGING', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ChargingMode" AS ENUM ('QUEUE', 'ADVANCE');

-- CreateEnum
CREATE TYPE "ChargingEndReason" AS ENUM ('TARGET_REACHED', 'USER_STOP', 'POINT_FAILURE', 'VEHICLE_FAULT');

-- CreateEnum
CREATE TYPE "IncidentStatus" AS ENUM ('REPORTED', 'IN_MAINTENANCE', 'RESOLVED');

-- CreateEnum
CREATE TYPE "IncidentResourceType" AS ENUM ('RENTAL_VEHICLE', 'PARKING_SPACE', 'CHARGING_POINT');

-- CreateEnum
CREATE TYPE "IncidentCategory" AS ENUM ('VEHICLE_FAULT', 'BATTERY_FAULT', 'CHARGER_FAULT', 'ELECTRICAL', 'EMERGENCY_DISCONNECT', 'DAMAGE', 'OBSTRUCTION', 'OTHER');

-- CreateEnum
CREATE TYPE "IncidentSource" AS ENUM ('OPERATOR', 'STUDENT', 'TELEMETRY');

-- CreateEnum
CREATE TYPE "AlertType" AS ENUM ('NEAR_CAPACITY', 'LOW_BATTERY', 'FAULT', 'STALLED_FEED', 'SHORTAGE', 'SURPLUS');

-- CreateEnum
CREATE TYPE "AlertStatus" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'DISMISSED', 'RESOLVED');

-- CreateEnum
CREATE TYPE "RedistributionStatus" AS ENUM ('PROPOSED', 'APPROVED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'FAILED');

-- CreateEnum
CREATE TYPE "SimRunStatus" AS ENUM ('RUNNING', 'COMPLETED', 'FAILED', 'INCOMPLETE');

-- CreateEnum
CREATE TYPE "RecommendationType" AS ENUM ('REDISTRIBUTE', 'CHARGING_ADJUST', 'REDIRECT');

-- CreateEnum
CREATE TYPE "RecommendationStatus" AS ENUM ('PENDING', 'APPLIED', 'DISMISSED', 'BLOCKED');

-- CreateEnum
CREATE TYPE "ChargingVehicleKind" AS ENUM ('RENTAL', 'PRIVATE');

-- CreateEnum
CREATE TYPE "VehicleReservationEndReason" AS ENUM ('RETURNED', 'CANCELLED', 'EXPIRED', 'INCIDENT');

-- CreateEnum
CREATE TYPE "ImpactBookingType" AS ENUM ('VEHICLE_RESERVATION', 'PARKING_RESERVATION', 'CHARGING_REQUEST');

-- CreateEnum
CREATE TYPE "ImpactOutcome" AS ENUM ('REASSIGNED', 'CANCELLED', 'ENDED');

-- CreateEnum
CREATE TYPE "RedistributionOrigin" AS ENUM ('MANUAL', 'SIMULATION');

-- CreateTable
CREATE TABLE "user" (
    "id" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'STUDENT',
    "mustChangePassword" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hub" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "location" TEXT NOT NULL,
    "lastTelemetryAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hub_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hub_threshold" (
    "id" TEXT NOT NULL,
    "hubId" TEXT NOT NULL,
    "vehicleClass" "VehicleClass" NOT NULL,
    "minAvailable" INTEGER NOT NULL,
    "maxAvailable" INTEGER NOT NULL,

    CONSTRAINT "hub_threshold_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hub_redirect" (
    "id" TEXT NOT NULL,
    "fromHubId" TEXT NOT NULL,
    "toHubId" TEXT NOT NULL,
    "activeUntil" TIMESTAMPTZ(3) NOT NULL,
    "createdById" TEXT NOT NULL,
    "recommendationId" TEXT,

    CONSTRAINT "hub_redirect_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "setting" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "setting_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "rental_vehicle" (
    "id" TEXT NOT NULL,
    "hubId" TEXT NOT NULL,
    "type" "RentalVehicleType" NOT NULL,
    "vehicleClass" "VehicleClass" NOT NULL DEFAULT 'MOTORCYCLE',
    "status" "RentalVehicleStatus" NOT NULL,
    "batteryPct" DOUBLE PRECISION NOT NULL,
    "parkingSpaceId" TEXT,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "rental_vehicle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "private_ev" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "type" "PrivateEvType" NOT NULL,
    "vehicleClass" "VehicleClass" NOT NULL,
    "label" TEXT NOT NULL,
    "batteryCapacityKwh" DOUBLE PRECISION NOT NULL,
    "batteryPct" DOUBLE PRECISION NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "private_ev_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "parking_space" (
    "id" TEXT NOT NULL,
    "hubId" TEXT NOT NULL,
    "vehicleClass" "VehicleClass" NOT NULL,
    "pool" "ParkingPool" NOT NULL,
    "status" "ParkingSpaceStatus" NOT NULL,
    "reservedForTaskId" TEXT,

    CONSTRAINT "parking_space_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "charging_point" (
    "id" TEXT NOT NULL,
    "hubId" TEXT NOT NULL,
    "vehicleClass" "VehicleClass" NOT NULL,
    "status" "ChargingPointStatus" NOT NULL,

    CONSTRAINT "charging_point_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicle_reservation" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "rentalVehicleId" TEXT NOT NULL,
    "hubId" TEXT NOT NULL,
    "status" "ReservationStatus" NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "pickedUpAt" TIMESTAMPTZ(3),
    "returnedAt" TIMESTAMPTZ(3),
    "returnHubId" TEXT,
    "startBatteryPct" DOUBLE PRECISION,
    "endBatteryPct" DOUBLE PRECISION,
    "endReason" "VehicleReservationEndReason",
    "idempotencyKey" TEXT,

    CONSTRAINT "vehicle_reservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "parking_reservation" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "parkingSpaceId" TEXT NOT NULL,
    "hubId" TEXT NOT NULL,
    "vehicleClass" "VehicleClass" NOT NULL,
    "privateEvId" TEXT,
    "windowStart" TIMESTAMPTZ(3) NOT NULL,
    "windowEnd" TIMESTAMPTZ(3) NOT NULL,
    "status" "ReservationStatus" NOT NULL,
    "claimedAt" TIMESTAMPTZ(3),
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "bookingGroupId" TEXT,
    "idempotencyKey" TEXT,

    CONSTRAINT "parking_reservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "charging_request" (
    "id" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "ownerId" TEXT,
    "vehicleKind" "ChargingVehicleKind" NOT NULL,
    "rentalVehicleId" TEXT,
    "privateEvId" TEXT,
    "vehicleClass" "VehicleClass" NOT NULL,
    "hubId" TEXT NOT NULL,
    "mode" "ChargingMode" NOT NULL,
    "status" "ChargingRequestStatus" NOT NULL,
    "targetPct" DOUBLE PRECISION NOT NULL,
    "startPct" DOUBLE PRECISION NOT NULL,
    "currentPct" DOUBLE PRECISION NOT NULL,
    "desiredTime" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "neededBy" TIMESTAMPTZ(3),
    "chargingPointId" TEXT,
    "slotStart" TIMESTAMPTZ(3),
    "slotEnd" TIMESTAMPTZ(3),
    "startedAt" TIMESTAMPTZ(3),
    "endedAt" TIMESTAMPTZ(3),
    "endReason" "ChargingEndReason",
    "finalPct" DOUBLE PRECISION,
    "manualAdjust" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "bookingGroupId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "charging_request_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_key" (
    "key" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "responseStatus" INTEGER NOT NULL,
    "responseBody" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idempotency_key_pkey" PRIMARY KEY ("key","userId")
);

-- CreateTable
CREATE TABLE "incident" (
    "id" TEXT NOT NULL,
    "resourceType" "IncidentResourceType" NOT NULL,
    "resourceId" TEXT NOT NULL,
    "hubId" TEXT NOT NULL,
    "vehicleClass" "VehicleClass" NOT NULL,
    "category" "IncidentCategory" NOT NULL,
    "notes" TEXT NOT NULL,
    "source" "IncidentSource" NOT NULL,
    "reportedById" TEXT,
    "status" "IncidentStatus" NOT NULL,
    "resolutionNotes" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inMaintenanceAt" TIMESTAMPTZ(3),
    "resolvedAt" TIMESTAMPTZ(3),

    CONSTRAINT "incident_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "incident_report" (
    "id" TEXT NOT NULL,
    "incidentId" TEXT NOT NULL,
    "source" "IncidentSource" NOT NULL,
    "reportedById" TEXT,
    "notes" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "incident_report_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "incident_impact" (
    "id" TEXT NOT NULL,
    "incidentId" TEXT NOT NULL,
    "bookingType" "ImpactBookingType" NOT NULL,
    "bookingId" TEXT NOT NULL,
    "userId" TEXT,
    "outcome" "ImpactOutcome" NOT NULL,
    "newResourceId" TEXT,

    CONSTRAINT "incident_impact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alert" (
    "id" TEXT NOT NULL,
    "type" "AlertType" NOT NULL,
    "hubId" TEXT NOT NULL,
    "vehicleClass" "VehicleClass",
    "resourceIds" TEXT[],
    "metric" JSONB NOT NULL DEFAULT '{}',
    "message" TEXT NOT NULL,
    "status" "AlertStatus" NOT NULL DEFAULT 'OPEN',
    "dedupeKey" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMPTZ(3),
    "closedById" TEXT,

    CONSTRAINT "alert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "redistribution_task" (
    "id" TEXT NOT NULL,
    "sourceHubId" TEXT NOT NULL,
    "destHubId" TEXT NOT NULL,
    "vehicleClass" "VehicleClass" NOT NULL,
    "vehicleType" "RentalVehicleType",
    "count" INTEGER NOT NULL,
    "status" "RedistributionStatus" NOT NULL,
    "override" BOOLEAN NOT NULL DEFAULT false,
    "reason" TEXT,
    "origin" "RedistributionOrigin" NOT NULL,
    "recommendationId" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedAt" TIMESTAMPTZ(3),
    "startedAt" TIMESTAMPTZ(3),
    "completedAt" TIMESTAMPTZ(3),
    "failedAt" TIMESTAMPTZ(3),
    "cancelledAt" TIMESTAMPTZ(3),
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "redistribution_task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "redistribution_task_vehicle" (
    "taskId" TEXT NOT NULL,
    "rentalVehicleId" TEXT NOT NULL,

    CONSTRAINT "redistribution_task_vehicle_pkey" PRIMARY KEY ("taskId","rentalVehicleId")
);

-- CreateTable
CREATE TABLE "notification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "data" JSONB NOT NULL DEFAULT '{}',
    "readAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" BIGSERIAL NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actorId" TEXT,
    "actorRole" TEXT,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityIds" TEXT[],
    "reason" TEXT,
    "details" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "telemetry_reject" (
    "id" TEXT NOT NULL,
    "hubId" TEXT,
    "packetTimestamp" TIMESTAMPTZ(3),
    "reason" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "telemetry_reject_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sim_scenario" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "conditions" JSONB NOT NULL,
    "horizonH" INTEGER NOT NULL,
    "seed" INTEGER NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sim_scenario_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sim_run" (
    "id" TEXT NOT NULL,
    "scenarioId" TEXT NOT NULL,
    "status" "SimRunStatus" NOT NULL,
    "snapshot" JSONB NOT NULL DEFAULT '{}',
    "results" JSONB NOT NULL DEFAULT '{}',
    "startedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMPTZ(3),
    "durationMs" INTEGER,
    "savedName" TEXT,

    CONSTRAINT "sim_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sim_recommendation" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "type" "RecommendationType" NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "projectedImpact" JSONB NOT NULL DEFAULT '{}',
    "status" "RecommendationStatus" NOT NULL DEFAULT 'PENDING',
    "confirmToken" TEXT,
    "confirmTokenExpiresAt" TIMESTAMPTZ(3),
    "appliedById" TEXT,
    "appliedAt" TIMESTAMPTZ(3),

    CONSTRAINT "sim_recommendation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_identifier_key" ON "user"("identifier");

-- CreateIndex
CREATE UNIQUE INDEX "hub_threshold_hubId_vehicleClass_key" ON "hub_threshold"("hubId", "vehicleClass");

-- CreateIndex
CREATE UNIQUE INDEX "rental_vehicle_parkingSpaceId_key" ON "rental_vehicle"("parkingSpaceId");

-- CreateIndex
CREATE INDEX "rental_vehicle_hubId_status_idx" ON "rental_vehicle"("hubId", "status");

-- CreateIndex
CREATE INDEX "parking_space_hubId_vehicleClass_pool_status_idx" ON "parking_space"("hubId", "vehicleClass", "pool", "status");

-- CreateIndex
CREATE INDEX "vehicle_reservation_status_expiresAt_idx" ON "vehicle_reservation"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "parking_reservation_status_windowStart_idx" ON "parking_reservation"("status", "windowStart");

-- CreateIndex
CREATE INDEX "parking_reservation_status_expiresAt_idx" ON "parking_reservation"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "charging_request_hubId_status_idx" ON "charging_request"("hubId", "status");

-- CreateIndex
CREATE INDEX "incident_hubId_status_createdAt_idx" ON "incident"("hubId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "alert_status_hubId_idx" ON "alert"("status", "hubId");

-- CreateIndex
CREATE INDEX "notification_userId_readAt_createdAt_idx" ON "notification"("userId", "readAt", "createdAt");

-- CreateIndex
CREATE INDEX "audit_log_entityType_at_idx" ON "audit_log"("entityType", "at");

-- AddForeignKey
ALTER TABLE "hub_threshold" ADD CONSTRAINT "hub_threshold_hubId_fkey" FOREIGN KEY ("hubId") REFERENCES "hub"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hub_redirect" ADD CONSTRAINT "hub_redirect_fromHubId_fkey" FOREIGN KEY ("fromHubId") REFERENCES "hub"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hub_redirect" ADD CONSTRAINT "hub_redirect_toHubId_fkey" FOREIGN KEY ("toHubId") REFERENCES "hub"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hub_redirect" ADD CONSTRAINT "hub_redirect_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hub_redirect" ADD CONSTRAINT "hub_redirect_recommendationId_fkey" FOREIGN KEY ("recommendationId") REFERENCES "sim_recommendation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rental_vehicle" ADD CONSTRAINT "rental_vehicle_hubId_fkey" FOREIGN KEY ("hubId") REFERENCES "hub"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rental_vehicle" ADD CONSTRAINT "rental_vehicle_parkingSpaceId_fkey" FOREIGN KEY ("parkingSpaceId") REFERENCES "parking_space"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "private_ev" ADD CONSTRAINT "private_ev_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "parking_space" ADD CONSTRAINT "parking_space_hubId_fkey" FOREIGN KEY ("hubId") REFERENCES "hub"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "parking_space" ADD CONSTRAINT "parking_space_reservedForTaskId_fkey" FOREIGN KEY ("reservedForTaskId") REFERENCES "redistribution_task"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "charging_point" ADD CONSTRAINT "charging_point_hubId_fkey" FOREIGN KEY ("hubId") REFERENCES "hub"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_reservation" ADD CONSTRAINT "vehicle_reservation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_reservation" ADD CONSTRAINT "vehicle_reservation_rentalVehicleId_fkey" FOREIGN KEY ("rentalVehicleId") REFERENCES "rental_vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_reservation" ADD CONSTRAINT "vehicle_reservation_hubId_fkey" FOREIGN KEY ("hubId") REFERENCES "hub"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_reservation" ADD CONSTRAINT "vehicle_reservation_returnHubId_fkey" FOREIGN KEY ("returnHubId") REFERENCES "hub"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "parking_reservation" ADD CONSTRAINT "parking_reservation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "parking_reservation" ADD CONSTRAINT "parking_reservation_parkingSpaceId_fkey" FOREIGN KEY ("parkingSpaceId") REFERENCES "parking_space"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "parking_reservation" ADD CONSTRAINT "parking_reservation_hubId_fkey" FOREIGN KEY ("hubId") REFERENCES "hub"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "parking_reservation" ADD CONSTRAINT "parking_reservation_privateEvId_fkey" FOREIGN KEY ("privateEvId") REFERENCES "private_ev"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "charging_request" ADD CONSTRAINT "charging_request_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "charging_request" ADD CONSTRAINT "charging_request_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "charging_request" ADD CONSTRAINT "charging_request_rentalVehicleId_fkey" FOREIGN KEY ("rentalVehicleId") REFERENCES "rental_vehicle"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "charging_request" ADD CONSTRAINT "charging_request_privateEvId_fkey" FOREIGN KEY ("privateEvId") REFERENCES "private_ev"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "charging_request" ADD CONSTRAINT "charging_request_chargingPointId_fkey" FOREIGN KEY ("chargingPointId") REFERENCES "charging_point"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "charging_request" ADD CONSTRAINT "charging_request_hubId_fkey" FOREIGN KEY ("hubId") REFERENCES "hub"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "idempotency_key" ADD CONSTRAINT "idempotency_key_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incident" ADD CONSTRAINT "incident_hubId_fkey" FOREIGN KEY ("hubId") REFERENCES "hub"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incident" ADD CONSTRAINT "incident_reportedById_fkey" FOREIGN KEY ("reportedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incident_report" ADD CONSTRAINT "incident_report_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "incident"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incident_report" ADD CONSTRAINT "incident_report_reportedById_fkey" FOREIGN KEY ("reportedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incident_impact" ADD CONSTRAINT "incident_impact_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "incident"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incident_impact" ADD CONSTRAINT "incident_impact_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alert" ADD CONSTRAINT "alert_hubId_fkey" FOREIGN KEY ("hubId") REFERENCES "hub"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alert" ADD CONSTRAINT "alert_closedById_fkey" FOREIGN KEY ("closedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "redistribution_task" ADD CONSTRAINT "redistribution_task_sourceHubId_fkey" FOREIGN KEY ("sourceHubId") REFERENCES "hub"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "redistribution_task" ADD CONSTRAINT "redistribution_task_destHubId_fkey" FOREIGN KEY ("destHubId") REFERENCES "hub"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "redistribution_task" ADD CONSTRAINT "redistribution_task_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "redistribution_task" ADD CONSTRAINT "redistribution_task_recommendationId_fkey" FOREIGN KEY ("recommendationId") REFERENCES "sim_recommendation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "redistribution_task_vehicle" ADD CONSTRAINT "redistribution_task_vehicle_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "redistribution_task"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "redistribution_task_vehicle" ADD CONSTRAINT "redistribution_task_vehicle_rentalVehicleId_fkey" FOREIGN KEY ("rentalVehicleId") REFERENCES "rental_vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification" ADD CONSTRAINT "notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sim_scenario" ADD CONSTRAINT "sim_scenario_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sim_run" ADD CONSTRAINT "sim_run_scenarioId_fkey" FOREIGN KEY ("scenarioId") REFERENCES "sim_scenario"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sim_recommendation" ADD CONSTRAINT "sim_recommendation_runId_fkey" FOREIGN KEY ("runId") REFERENCES "sim_run"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sim_recommendation" ADD CONSTRAINT "sim_recommendation_appliedById_fkey" FOREIGN KEY ("appliedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
