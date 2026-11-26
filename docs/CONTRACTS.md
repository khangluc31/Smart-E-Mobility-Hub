# CONTRACTS.md — API contract (Smart E-Mobility Hub, Group 10)

> Every endpoint: URL, who may call it, request, response, main errors, FR IDs, owner.
> Rules are in `docs/SPEC.md`; design is in `docs/ARCHITECTURE.md`. Owner of this file: **M1**.
> **Change process:** an endpoint's owner may add optional fields freely. Renaming/removing a field or changing a status code needs a PR that edits this file first, reviewed by M1 and whoever owns the screen that uses it.

---

## 0. Conventions

| Topic | Rule |
|---|---|
| Base URL | `/api` (dev: Vite proxies `/api` → `http://localhost:3000`; prod: `VITE_API_URL`) |
| Format | JSON in and out. Field names camelCase. Ids are strings. Times are ISO-8601 UTC strings (`2026-12-01T08:00:00.000Z`). Battery and utilisation are numbers 0–100 |
| Auth | `Authorization: Bearer <jwt>` on every endpoint except `/health`, `/auth/register`, `/auth/login`, `POST /telemetry` |
| Roles | **S** = STUDENT, **O** = OPERATOR, **Any** = any logged-in user. Everything under `/api/ops/*` is **O** only — the router applies `requireRole('OPERATOR')` once (FR-61, BR-12) |
| Ownership | A Student only sees/changes their own records. Someone else's id → `404 NOT_FOUND` |
| Idempotency | `POST` endpoints marked **(idem)** accept header `Idempotency-Key: <uuid>`. Same key + same user → the stored first response is returned, nothing is created twice (NFR-08). The frontend sends a new uuid per user action |
| Server time | Responses with a countdown or estimate include `serverNow` (FR-07) |
| Lists | Long lists take `?limit=` (default 50, max 200) and `?cursor=`; response `{ items, nextCursor }`. Short fixed lists (5 Hubs) return a plain array |
| Errors | Always `{ "error": { code, message, nextActions[], alternatives?[], details? } }` — see ARCHITECTURE §4.4. Every 4xx has a human `message` and at least one `nextActions` entry (NFR-05) |
| Validation | Bad/missing field → `400 VALIDATION_ERROR` with `details.field`; no state change (NFR-13) |
| Status codes | `200` read/update, `201` created, `202` accepted (async), `204` no body, `400` bad input, `401` no/bad token, `403` wrong role, `404` not found / not yours, `409` business rule, state or race conflict, `500` unexpected server error (generic message, no internals), `503` database unreachable (`/health` only) |

**Common error codes:** `VALIDATION_ERROR`, `UNAUTHENTICATED`, `INVALID_CREDENTIALS`, `FORBIDDEN`, `NOT_FOUND`, `IDENTIFIER_TAKEN`, `RESOURCE_TAKEN`, `ACTIVE_RENTAL_EXISTS`, `LOW_BATTERY`, `HOLD_EXPIRED`, `HUB_FULL`, `NO_CAPACITY`, `CLASS_MISMATCH`, `INVALID_STATE_TRANSITION`, `SESSION_PROTECTED`, `CAPACITY_EXCEEDED`, `NOT_ELIGIBLE`, `HAS_ACTIVE_BOOKING`, `STALE_PACKET`, `LIVE_STATE_CONFLICT`, `CONFIRM_TOKEN_INVALID`, `INTERNAL_ERROR` (500), `DB_UNAVAILABLE` (503).

---

## 1. Shared types

Backend: `backend/src/types/` · Frontend mirror: `frontend/src/types/` (keep identical; the module owner updates both in the same PR).

```ts
// ---- enums.ts (values exactly as SPEC §4) ----
type Role = 'STUDENT' | 'OPERATOR';
type VehicleClass = 'MOTORCYCLE' | 'CAR';
type RentalVehicleType = 'E_BICYCLE' | 'E_MOTORCYCLE';
type PrivateEvType = 'E_MOTORCYCLE' | 'CAR';
type RentalVehicleStatus = 'AVAILABLE' | 'RESERVED' | 'IN_USE' | 'LOW_BATTERY' | 'IN_TRANSIT' | 'FAULTY';
type ReservationStatus = 'CONFIRMED' | 'ACTIVE' | 'COMPLETED' | 'CANCELLED' | 'EXPIRED';
type ParkingSpaceStatus = 'FREE' | 'RESERVED' | 'OCCUPIED' | 'UNAVAILABLE';
type ParkingPool = 'FLEET' | 'PUBLIC';
type ChargingPointStatus = 'AVAILABLE' | 'CHARGING' | 'FAULTY';
type ChargingRequestStatus = 'QUEUED' | 'SCHEDULED' | 'CHARGING' | 'COMPLETED' | 'CANCELLED';
type ChargingMode = 'QUEUE' | 'ADVANCE';
type ChargingEndReason = 'TARGET_REACHED' | 'USER_STOP' | 'POINT_FAILURE' | 'VEHICLE_FAULT';
type IncidentStatus = 'REPORTED' | 'IN_MAINTENANCE' | 'RESOLVED';
type IncidentResourceType = 'RENTAL_VEHICLE' | 'PARKING_SPACE' | 'CHARGING_POINT';
type IncidentCategory = 'VEHICLE_FAULT' | 'BATTERY_FAULT' | 'CHARGER_FAULT' | 'ELECTRICAL'
  | 'EMERGENCY_DISCONNECT' | 'DAMAGE' | 'OBSTRUCTION' | 'OTHER';
type IncidentSource = 'OPERATOR' | 'STUDENT' | 'TELEMETRY';
type AlertType = 'NEAR_CAPACITY' | 'LOW_BATTERY' | 'FAULT' | 'STALLED_FEED' | 'SHORTAGE' | 'SURPLUS';
type AlertStatus = 'OPEN' | 'ACKNOWLEDGED' | 'DISMISSED' | 'RESOLVED';
type RedistributionStatus = 'PROPOSED' | 'APPROVED' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED' | 'FAILED';
type ScenarioTemplate = 'METRO_SURGE' | 'HUB_PARKING_FULL' | 'CHARGING_SPIKE' | 'POINT_OUTAGE' | 'VEHICLE_IMBALANCE';
type SimRunStatus = 'RUNNING' | 'COMPLETED' | 'FAILED' | 'INCOMPLETE';
type RecommendationType = 'REDISTRIBUTE' | 'CHARGING_ADJUST' | 'REDIRECT';
type RecommendationStatus = 'PENDING' | 'APPLIED' | 'DISMISSED' | 'BLOCKED';

// ---- core DTOs ----
interface User { id: string; identifier: string; displayName: string; role: Role; mustChangePassword: boolean }

interface ClassCount { free: number; total: number; utilPct: number }          // utilPct per ARCHITECTURE §8

interface HubSummary {
  id: string; name: string; location: string;
  lastTelemetryAt: string | null; degraded: boolean;                            // FR-03
  availableRentalVehicles: number;                                              // AVAILABLE, ≥20%, not charging
  parking: Record<VehicleClass, ClassCount>;                                    // both pools
  publicParking: Record<VehicleClass, ClassCount>;                              // what users can reserve now
  charging: Record<VehicleClass, ClassCount>;
  nearCapacity: boolean;                                                        // any util ≥ 85% (BR-09)
  redirectToHubId: string | null;                                               // active hub_redirect (D-12)
}

interface RentalVehicle {
  id: string; hubId: string; type: RentalVehicleType; vehicleClass: 'MOTORCYCLE';
  status: RentalVehicleStatus; batteryPct: number; charging: boolean;           // charging = D-18
}

interface ParkingSpace { id: string; hubId: string; vehicleClass: VehicleClass; pool: ParkingPool; status: ParkingSpaceStatus }
interface ChargingPoint { id: string; hubId: string; vehicleClass: VehicleClass; status: ChargingPointStatus }

interface HubDetail extends HubSummary {
  vehicles: RentalVehicle[]; parkingSpaces: ParkingSpace[]; chargingPoints: ChargingPoint[];
}

interface Alternative { type: 'hub' | 'rentalVehicle' | 'time'; hubId?: string; hubName?: string;
  id?: string; batteryPct?: number; free?: number; start?: string; end?: string; reason: string }

interface VehicleReservation {
  id: string; status: ReservationStatus; hubId: string; vehicle: RentalVehicle;
  createdAt: string; expiresAt: string; pickedUpAt: string | null; returnedAt: string | null;
  returnHubId: string | null; startBatteryPct: number | null; endBatteryPct: number | null;
  endReason: 'RETURNED' | 'CANCELLED' | 'EXPIRED' | 'INCIDENT' | null;
  serverNow: string;
}

interface ParkingReservation {
  id: string; status: ReservationStatus; hubId: string; parkingSpaceId: string; vehicleClass: VehicleClass;
  privateEvId: string | null; windowStart: string; windowEnd: string; expiresAt: string;
  claimedAt: string | null; bookingGroupId: string | null; serverNow: string;
}

interface PrivateEv {
  id: string; type: PrivateEvType; vehicleClass: VehicleClass; label: string;
  batteryCapacityKwh: number; batteryPct: number; hasActiveBooking: boolean;
}

interface ChargingRequestView {
  id: string; status: ChargingRequestStatus; mode: ChargingMode; hubId: string; vehicleClass: VehicleClass;
  vehicleKind: 'RENTAL' | 'PRIVATE'; rentalVehicleId: string | null; privateEvId: string | null;
  startPct: number; currentPct: number; targetPct: number;
  desiredTime: string; neededBy: string | null;
  chargingPointId: string | null; slotStart: string | null; slotEnd: string | null;
  queuePosition: number | null;            // QUEUED only (FR-22 / UC-13 A1)
  estimatedStart: string | null;           // QUEUED / SCHEDULED
  estimatedEnd: string | null;             // removed (null) once the session ends
  endReason: ChargingEndReason | null; finalPct: number | null;
  createdAt: string; serverNow: string;
}

interface Notification { id: string; type: string; title: string; body: string; data: Record<string, unknown>;
  readAt: string | null; createdAt: string }
```

Operator-side types (`Alert`, `Incident`, `RedistributionTask`, `SimRun`…) are defined next to their endpoints below.

---

## 2. Health & auth

### Health — owner M1
| Method & path | Role | Request | 2xx response | Errors | FR |
|---|---|---|---|---|---|
| `GET /health` | public | – | `200 { status: 'ok', db: 'ok', jobsEnabled: boolean, serverNow }` | 503 if DB down | ops |

### Auth — owner M3
| Method & path | Role | Request | 2xx response | Errors | FR |
|---|---|---|---|---|---|
| `POST /auth/register` | public | `{ identifier, password, displayName }` — identifier 3–64 chars; password ≥ 8 chars with a letter and a digit | `201 { token, user }` | 400; 409 `IDENTIFIER_TAKEN`; **403 `FORBIDDEN` if body has `role` other than STUDENT** | FR-29, FR-60 |
| `POST /auth/login` | public | `{ identifier, password }` | `200 { token, user }` | 401 `INVALID_CREDENTIALS` (same message for unknown user and wrong password) | UC-16, FR-60 |
| `GET /auth/me` | Any | – | `200 User` | 401 | UC-16 A1 |
| `POST /auth/change-password` | Any | `{ currentPassword, newPassword }` | `204`; clears `mustChangePassword` | 400; 401 | UC-16 A2 (C) |

---

## 3. Hubs — owner M1

| Method & path | Role | Request | 2xx response | Errors | FR |
|---|---|---|---|---|---|
| `GET /hubs` | Any | – | `200 HubSummary[]` (all Hubs, poll 5 s) | 401 | FR-01, FR-03 |
| `GET /hubs/:hubId` | Any | – | `200 HubDetail` | 404 | FR-02 |
| `GET /hubs/alternatives` | Any | query `need=FLEET_PARKING\|PUBLIC_PARKING\|CHARGING`, `vehicleClass`, `excludeHubId?`, `from?`, `to?` | `200 Alternative[]` sorted per D-12 (active redirect first, then most free; DEGRADED excluded). Empty array = none available | 400 | FR-19 |

The same `alternativeHubs()` service function fills `error.alternatives` for `HUB_FULL` / `NO_CAPACITY` errors in other modules.

---

## 4. Rental vehicles & vehicle reservations — owner M4

| Method & path | Role | Request | 2xx response | Errors | FR |
|---|---|---|---|---|---|
| `GET /vehicles/search` | S | query `hubId?`, `type?`, `minBattery?` (0–100), `availableOnly?` (default `true`) | `200 RentalVehicle[]`. With `availableOnly`: only AVAILABLE, ≥ 20%, not charging. Empty → `[]` (UI shows "No vehicle found") | 400 | FR-04, BR-02 |
| `GET /vehicles/recommend` | S | query `originHubId`, `destinationHubId`, `time?` (default now) | `200 { vehicles: (RentalVehicle & { reason })[], destination: { hubId, freeFleetSpaces, ok, reason }, alternativeDestinations: Alternative[] }` | 400 | FR-05 |
| `POST /vehicle-reservations` **(idem)** | S | `{ vehicleId }` | `201 VehicleReservation` (CONFIRMED, `expiresAt` = +15 min) | 404; 409 `RESOURCE_TAKEN` (+ `alternatives` at same Hub), `ACTIVE_RENTAL_EXISTS`, `LOW_BATTERY` | FR-06, BR-01/02/10 |
| `GET /vehicle-reservations/current` | S | – | `200 VehicleReservation \| null` (CONFIRMED or ACTIVE) | – | FR-07 |
| `POST /vehicle-reservations/:id/cancel` | S | – | `200 VehicleReservation` (CANCELLED) | 404; 409 `INVALID_STATE_TRANSITION` | FR-08 |
| `PATCH /vehicle-reservations/:id` | S | `{ vehicleId }` (change vehicle, SPEC §10 Q4) | `200 VehicleReservation` (same `expiresAt`) | 404; 409 `RESOURCE_TAKEN` / `LOW_BATTERY` / `INVALID_STATE_TRANSITION` — original unchanged | FR-09 |
| `POST /vehicle-reservations/:id/pickup` | S | – | `200 VehicleReservation` (ACTIVE, vehicle IN_USE) | 404; 409 `HOLD_EXPIRED`, `INVALID_STATE_TRANSITION`, `NOT_ELIGIBLE` (vehicle FAULTY) | FR-11 |
| `POST /vehicle-reservations/:id/return` | S | `{ hubId, requestCharging?: { targetPct, neededBy? } }` — battery comes from the vehicle's latest telemetry, not the user | `200 { reservation: VehicleReservation, chargingRequest: ChargingRequestView \| null }` | 404; 409 `HUB_FULL` (+ `alternatives`, FR-19), `INVALID_STATE_TRANSITION`; 400 Hub DEGRADED/unknown | FR-12, FR-19, D-13 |
| `POST /vehicles/:vehicleId/report-fault` | S | `{ category, notes }` (notes ≤ 500) | `201 { incidentId, linkedToExisting: boolean }` | 404; 400 | FR-13 |

---

## 5. Parking reservations — owner M4

| Method & path | Role | Request | 2xx response | Errors | FR |
|---|---|---|---|---|---|
| `GET /parking/availability` | S | query `hubId`, `vehicleClass`, `from`, `to` | `200 { hubId, vehicleClass, free, total, alternatives: Alternative[] }` (alternatives filled when `free = 0`) | 400 | FR-14 |
| `POST /parking-reservations` **(idem)** | S | `{ hubId, vehicleClass, privateEvId?, windowStart, windowEnd }` — start ≥ now − 1 min, end > start, length ≤ 12 h; if `privateEvId` given, its class must equal `vehicleClass` | `201 ParkingReservation` (CONFIRMED) | 400; 409 `NO_CAPACITY` (+ `alternatives`), `CLASS_MISMATCH` | FR-15, BR-10, BR-13 |
| `POST /parking-reservations/:id/cancel` | S | – | `200 ParkingReservation` (CANCELLED) | 404; 409 `INVALID_STATE_TRANSITION` | FR-16 |
| `PATCH /parking-reservations/:id` | S | `{ windowStart, windowEnd }` | `200 ParkingReservation` (may move to another free space of the same class/Hub) | 404; 409 `NO_CAPACITY` — original unchanged | FR-17 |
| `POST /parking-reservations/:id/claim` | S | – | `200 ParkingReservation` (ACTIVE, space OCCUPIED) | 404; 409 `HOLD_EXPIRED`, 409 `NOT_ELIGIBLE` too early (`details.opensAt`) | FR-18 |
| `POST /parking-reservations/:id/leave` | S | – | `200 ParkingReservation` (COMPLETED, space FREE) | 404; 409 | FR-18 (end of window early) |

Expiry and window end are handled by the `reservations.tick` job (no endpoint).

---

## 6. History — owner M4 (charging items come from M6's service)

| Method & path | Role | Request | 2xx response | Errors | FR |
|---|---|---|---|---|---|
| `GET /me/history` | S | query `type=all\|vehicle\|parking\|charging` (default all), `status?` (a `ReservationStatus` or `ChargingRequestStatus`; applied only to the kinds that have it), `limit`, `cursor` | `200 { items: HistoryItem[], nextCursor }` newest first | 400 | FR-10 |

```ts
type HistoryItem =
  | { kind: 'vehicle'; at: string; item: VehicleReservation }
  | { kind: 'parking'; at: string; item: ParkingReservation }
  | { kind: 'charging'; at: string; item: ChargingRequestView };
```
There is **no** `userId` parameter — the user always comes from the token (UC-07 E1).

---

## 7. Private EVs — owner M4

| Method & path | Role | Request | 2xx response | Errors | FR |
|---|---|---|---|---|---|
| `GET /private-evs` | S | – | `200 PrivateEv[]` (not deleted) | – | FR-25 |
| `POST /private-evs` | S | `{ type, label, batteryCapacityKwh (>0), batteryPct (0–100) }` | `201 PrivateEv` (class derived from type) | 400 | FR-25 |
| `PATCH /private-evs/:id` | S | any of `{ label, type, batteryCapacityKwh, batteryPct }` | `200 PrivateEv` | 404; 400; 409 `HAS_ACTIVE_BOOKING` when changing `type` | FR-26 (C) |
| `DELETE /private-evs/:id` | S | – | `204` (soft delete) | 404; 409 `HAS_ACTIVE_BOOKING` | FR-27 (C) |
| `POST /private-evs/:id/book-parking-charging` **(idem)** | S | `{ hubId, windowStart, windowEnd, targetPct, chargeStart? }` — `chargeStart` defaults to `windowStart`, must be inside the window | `201 { bookingGroupId, parkingReservation: ParkingReservation, chargingRequest: ChargingRequestView }` | 400; 409 `NO_CAPACITY` with `details.missing: 'PARKING' \| 'CHARGING'` + `alternatives` (other time or Hub) — **nothing booked** | FR-28, BR-14 |

---

## 8. Charging — owner M6

### 8.1 User side
| Method & path | Role | Request | 2xx response | Errors | FR |
|---|---|---|---|---|---|
| `POST /charging/requests` | S | `{ vehicleKind: 'PRIVATE', privateEvId, hubId, targetPct, desiredTime?, neededBy? }` or `{ vehicleKind: 'RENTAL', rentalVehicleId, hubId, targetPct, neededBy? }` (Rental only per D-13) | `201 ChargingRequestView` (QUEUED, with `queuePosition`, `estimatedStart`, `estimatedEnd`) | 400 missing field / `targetPct <= currentPct`; 403 not your vehicle; 409 `HAS_ACTIVE_BOOKING` (vehicle already has a live request) | FR-20, BR-06 |
| `GET /charging/availability` | S | query `hubId`, `privateEvId`, `slotStart`, `targetPct` | `200 { available, slotEnd, suggestions: Alternative[] }` (next 3 free start times here + other Hubs) | 400 | FR-21 |
| `POST /charging/advance-bookings` **(idem)** | S | `{ privateEvId, hubId, slotStart, targetPct }` — `slotStart` in the future | `201 ChargingRequestView` (SCHEDULED, `chargingPointId`, `slotStart`, `slotEnd`) | 400; 403; 409 `NO_CAPACITY` (+ `alternatives`) | FR-21, BR-10 |
| `GET /charging/requests/mine` | S | query `active?` (default true) | `200 ChargingRequestView[]` (poll 5 s) | – | FR-22 |
| `GET /charging/requests/:id` | S | – | `200 ChargingRequestView` | 404 | FR-22 |
| `POST /charging/requests/:id/stop` | S | – | `200 ChargingRequestView` (COMPLETED, `USER_STOP`, `finalPct`) | 404; 409 not CHARGING | FR-23 |
| `POST /charging/requests/:id/cancel` | S | – | `200 ChargingRequestView` (CANCELLED) | 404; 409 if CHARGING (use `/stop`) | FR-24 |

### 8.2 Operator side
| Method & path | Role | Request | 2xx response | Errors | FR |
|---|---|---|---|---|---|
| `GET /ops/charging/queue` | O | query `hubId`, `vehicleClass?` | `200 { weights, entries: { rank, score, breakdown: { battery, urgency, waiting, manualAdjust }, request: ChargingRequestView }[] }` | 400 | FR-48, FR-52 |
| `GET /ops/charging/schedule` | O | query `hubId?` (all if omitted) | `200 { generatedAt, points: { point: ChargingPoint, current: ChargingRequestView \| null, booked: ChargingRequestView[], projected: { requestId, estimatedStart, estimatedEnd }[] }[] }` | – | FR-49 |
| `GET /ops/charging/weights` | O | – | `200 { battery, urgency, waiting, isDefault }` | – | FR-48 |
| `PUT /ops/charging/weights` | O | `{ battery, urgency, waiting }` — numbers ≥ 0, not all 0 | `200 { battery, urgency, waiting }` (audited) | 400 | FR-48, UC-26 |
| `POST /ops/charging/weights/reset` | O | – | `200` defaults (audited) | – | UC-26 A1 |
| `POST /ops/charging/dispatch` | O | `{ rentalVehicleId, hubId, targetPct? (default 100) }` **or** `{ hubId, allLowBattery: true }` | `201 { created: ChargingRequestView[] }` | 400 wrong Hub; 409 `NOT_ELIGIBLE` (reserved / battery ≥ 20%) | FR-51 |
| `POST /ops/charging/override` | O | `{ action: 'PROMOTE'\|'DEFER'\|'SWAP'\|'CANCEL', requestId, otherRequestId? (SWAP), reason (≥ 10 chars) }` | `200 { entries }` (updated queue; audited; owner notified on DEFER/CANCEL) | 400 short reason; 409 `SESSION_PROTECTED` (CHARGING or SCHEDULED target) | FR-52 |

---

## 9. Notifications — owner M3

| Method & path | Role | Request | 2xx response | Errors | FR |
|---|---|---|---|---|---|
| `GET /notifications` | Any | query `unreadOnly?`, `limit`, `cursor` | `200 { items: Notification[], unreadCount, nextCursor }` (bell polls 5 s) | – | FR-62 |
| `POST /notifications/:id/read` | Any | – | `204` | 404 | FR-62 |
| `POST /notifications/read-all` | Any | – | `204` | – | FR-62 |

Notification `type` values: `RESERVATION_EXPIRED`, `RESERVATION_REASSIGNED`, `RESERVATION_CANCELLED`, `RENTAL_ENDED_INCIDENT`, `CHARGING_STARTED`, `CHARGING_COMPLETED`, `CHARGING_ENDED_FAULT`, `CHARGING_REQUEUED`, `CHARGING_DEFERRED`, `CHARGING_CANCELLED`, `HUB_REDIRECT`. `data` carries the ids needed to link to the record.

---

## 10. Monitoring & alerts — owner M6

```ts
interface DashboardHub {
  hubId: string; name: string; degraded: boolean; lastTelemetryAt: string | null;
  availableRentalVehicles: Record<VehicleClass, number>;
  parkingUtilPct: Record<VehicleClass, number>; chargingUtilPct: Record<VehicleClass, number>;
  activeRentals: number; queueDepth: Record<VehicleClass, number>; openAlerts: number;
}
interface Alert {
  id: string; type: AlertType; status: AlertStatus; hubId: string; vehicleClass: VehicleClass | null;
  resourceIds: string[]; metric: Record<string, number | string>; message: string;
  createdAt: string; lastSeenAt: string; closedAt: string | null; closedById: string | null;
}
```

| Method & path | Role | Request | 2xx response | Errors | FR |
|---|---|---|---|---|---|
| `GET /ops/dashboard` | O | – | `200 { hubs: DashboardHub[], totals: { rentalVehicles, chargingPoints, activeRentals }, serverNow }` (poll 5 s) | – | FR-31 |
| `GET /ops/hubs/:hubId` | O | – | `200 HubDetail` plus per resource `occupiedBy` (`{ kind: 'rentalVehicle'\|'parkingReservation'\|'chargingRequest', id, userDisplayName? }`) and `lastTelemetryAt` | 404 | FR-32 |
| `GET /ops/alerts` | O | query `status?` (default OPEN), `type?`, `hubId?`, `limit`, `cursor` | `200 { items: Alert[], nextCursor }` | – | FR-33, FR-35, FR-43 |
| `POST /ops/alerts/:id/acknowledge` | O | `{ note? }` | `200 Alert` (ACKNOWLEDGED; audited) | 404; 409 not OPEN | FR-34 |
| `POST /ops/alerts/:id/dismiss` | O | `{ note? }` | `200 Alert` (DISMISSED; audited) | 404; 409 not OPEN | FR-34 |

---

## 11. Incidents — owner M6

```ts
interface Incident {
  id: string; status: IncidentStatus; resourceType: IncidentResourceType; resourceId: string;
  hubId: string; vehicleClass: VehicleClass; category: IncidentCategory; notes: string;
  source: IncidentSource; reportedById: string | null; resolutionNotes: string | null;
  createdAt: string; inMaintenanceAt: string | null; resolvedAt: string | null;
}
interface IncidentImpact { bookingType: 'VEHICLE_RESERVATION' | 'PARKING_RESERVATION' | 'CHARGING_REQUEST';
  bookingId: string; userId: string | null; outcome: 'REASSIGNED' | 'CANCELLED' | 'ENDED'; newResourceId: string | null }
```

| Method & path | Role | Request | 2xx response | Errors | FR |
|---|---|---|---|---|---|
| `POST /ops/incidents` | O | `{ resourceType, resourceId, hubId, vehicleClass, category, notes }` — all required | `201 { incident: Incident, linkedToExisting: boolean, impacts: IncidentImpact[] }` | 400 missing field / unknown resource / resource not at that Hub / class mismatch | FR-37, FR-38, FR-39, FR-40 |
| `GET /ops/incidents` | O | query `hubId?`, `resourceId?`, `vehicleClass?`, `category?`, `status?`, `from?`, `to?`, `limit`, `cursor` | `200 { items: Incident[], nextCursor }` | 400 | FR-42 |
| `GET /ops/incidents/:id` | O | – | `200 { incident, reports: { source, reportedById, notes, createdAt }[], impacts: IncidentImpact[] }` | 404 | FR-39, UC-23 |
| `POST /ops/incidents/:id/start-maintenance` | O | `{ notes? }` | `200 Incident` (IN_MAINTENANCE; audited) | 404; 409 `INVALID_STATE_TRANSITION` | FR-41 |
| `POST /ops/incidents/:id/resolve` | O | `{ resolutionNotes }` (non-empty, ≤ 1000) | `200 Incident` (RESOLVED; resource back in service; audited) | 400 empty notes; 409 `INVALID_STATE_TRANSITION` | FR-41 |

Telemetry faults (FR-36) and student reports (FR-13) call the same service; no extra endpoint.

---

## 12. Redistribution — owner M2

```ts
interface Imbalance { hubId: string; vehicleClass: VehicleClass; available: number; min: number; max: number;
  state: 'SHORTAGE' | 'SURPLUS' | 'OK'; amount: number }   // amount = how far outside the band
interface RedistributionTask {
  id: string; status: RedistributionStatus; sourceHubId: string; destHubId: string;
  vehicleClass: VehicleClass; vehicleType: RentalVehicleType | null; count: number;
  override: boolean; reason: string | null; origin: 'MANUAL' | 'SIMULATION'; recommendationId: string | null;
  vehicleIds: string[];                     // filled from IN_PROGRESS (D-19)
  createdById: string; createdAt: string; updatedAt: string;
}
```

| Method & path | Role | Request | 2xx response | Errors | FR |
|---|---|---|---|---|---|
| `GET /ops/redistribution/imbalances` | O | – | `200 Imbalance[]` (DEGRADED Hubs omitted) | – | FR-43 |
| `GET /ops/redistribution/preview` | O | query `sourceHubId`, `destHubId`, `vehicleClass`, `vehicleType?`, `count` | `200 { eligibleAtSource, destFreeFleetSpaces, predictedDestOccupancyPct, ok, needsOverride, problems: string[] }` | 400 | FR-45, FR-46 |
| `POST /ops/redistribution/tasks` | O | `{ sourceHubId, destHubId, vehicleClass, vehicleType?, count, override?, reason? }` — `reason` required if `override` | `201 RedistributionTask` (PROPOSED; audited) | 400 same Hub / missing field; 409 `CAPACITY_EXCEEDED`, `NOT_ELIGIBLE` (not enough eligible vehicles) | FR-44, FR-45, FR-46 |
| `GET /ops/redistribution/tasks` | O | query `status?`, `limit`, `cursor` | `200 { items: RedistributionTask[], nextCursor }` | – | FR-47 |
| `GET /ops/redistribution/tasks/:id` | O | – | `200 RedistributionTask` | 404 | FR-47 |
| `POST /ops/redistribution/tasks/:id/approve` | O | – | `200` (APPROVED) | 409 | FR-47 |
| `POST /ops/redistribution/tasks/:id/start` | O | – | `200` (IN_PROGRESS; vehicles IN_TRANSIT) | 409 `CAPACITY_EXCEEDED` / `NOT_ELIGIBLE` (re-check failed), `INVALID_STATE_TRANSITION` | FR-47 |
| `POST /ops/redistribution/tasks/:id/complete` | O | – | `200` (COMPLETED; vehicles AVAILABLE at destination) | 409 | FR-47 |
| `POST /ops/redistribution/tasks/:id/fail` | O | `{ reason }` | `200` (FAILED; vehicles back at source) | 400; 409 | FR-47 |
| `POST /ops/redistribution/tasks/:id/cancel` | O | `{ reason }` | `200` (CANCELLED) | 400; 409 | UC-25 A1 |

Every state change is audited (FR-63).

---

## 13. What-if Simulation — owner M2 (snapshot: M1)

```ts
interface ScenarioCondition { template: ScenarioTemplate; params: Record<string, number | string | string[]> }
interface Scenario { id: string; name: string; horizonH: number; seed: number; conditions: ScenarioCondition[];
  createdById: string; createdAt: string }
interface SimInterval { t: string; hubId: string; parkingUtilPct: number; chargingUtilPct: number;
  avgChargingWaitMin: number; maxQueueDepth: number; unservedRental: number; unservedParking: number;
  unservedCharging: number; redirectedReturns: number; availableVehicles: number; breach: boolean }
interface SimRun { id: string; scenarioId: string; status: SimRunStatus; startedAt: string; finishedAt: string | null;
  durationMs: number | null; savedName: string | null; snapshotTakenAt: string }
interface Recommendation { id: string; runId: string; type: RecommendationType; status: RecommendationStatus;
  payload: Record<string, unknown>; projectedImpact: Record<string, number>; reason: string }
```

| Method & path | Role | Request | 2xx response | Errors | FR |
|---|---|---|---|---|---|
| `GET /ops/simulation/templates` | O | – | `200 { template, label, params: { name, type, min?, max?, required }[] }[]` (drives the form) | – | FR-54 |
| `POST /ops/simulation/scenarios` | O | `{ name, horizonH (1–24), seed?, conditions: ScenarioCondition[] (≥ 1) }` | `201 Scenario` | 400 out-of-bounds / negative / missing params (`details.field` like `conditions[0].params.multiplierPct`) | FR-54, UC-29 |
| `GET /ops/simulation/scenarios` | O | – | `200 Scenario[]` | – | UC-29 A1 (load to clone) |
| `GET /ops/simulation/scenarios/:id` | O | – | `200 Scenario` | 404 | UC-29 |
| `POST /ops/simulation/runs` | O | `{ scenarioId }` | `202 SimRun` (RUNNING) — snapshot taken now; poll the run | 404; 409 another run already RUNNING | FR-53, FR-55 |
| `GET /ops/simulation/runs` | O | query `saved?` | `200 SimRun[]` | – | FR-59 |
| `GET /ops/simulation/runs/:id` | O | – | `200 { run: SimRun, intervals: SimInterval[], summary: { hubId, peakParkingUtilPct, peakChargingUtilPct, avgChargingWaitMin, unservedTotal }[], recommendations: Recommendation[], warning: 'NETWORK_SATURATED' \| null }` | 404 | FR-55, FR-56, FR-57 |
| `POST /ops/simulation/runs/:id/save` | O | `{ name }` | `200 SimRun` | 404; 409 run not COMPLETED | FR-59 |
| `DELETE /ops/simulation/runs/:id/save` | O | – | `204` (unsaves) | 404 | UC-34 A1 |
| `GET /ops/simulation/recommendations/:id/preview` | O | – | `200 { recommendation, liveChanges: string[], valid: boolean, problems: string[], confirmToken: string \| null, expiresAt }` — token only if `valid` (5 min) | 404; 409 not PENDING | FR-58, D-20 |
| `POST /ops/simulation/recommendations/:id/apply` | O | `{ confirmToken }` | `200 { recommendation (APPLIED), created: { type: 'redistributionTask' \| 'weights' \| 'hubRedirect', id } }` (audited) | 400/409 `CONFIRM_TOKEN_INVALID`; 409 `LIVE_STATE_CONFLICT` (status → BLOCKED, `problems` in details) | FR-58, UC-33 |
| `POST /ops/simulation/recommendations/:id/dismiss` | O | – | `200 Recommendation` (DISMISSED; 0 live writes) | 404; 409 | UC-33 A1 |
| `GET /ops/simulation/compare` | O | query `runA`, `runB` | `200 { a: SimRun, b: SimRun, rows: { hubId, metric, a, b, diff, diffPct }[], better: 'a' \| 'b' \| 'tie' }` | 400 missing run; 409 different horizons | FR-59 |

---

## 14. Telemetry — owner M1

```ts
interface TelemetryPacket {           // ARCHITECTURE §7.1
  hubId: string; timestamp: string; source: 'SIMULATOR' | 'MOCK_SENSOR' | 'SENSOR';
  vehicles?: { id: string; batteryPct: number; faultCode?: string | null }[];
  privateEvs?: { id: string; batteryPct: number }[];
  parkingSpaces?: { id: string; faultCode?: string | null }[];
  chargingPoints?: { id: string; faultCode?: string | null }[];
}
```

| Method & path | Role | Request | 2xx response | Errors | FR |
|---|---|---|---|---|---|
| `POST /telemetry` | header `X-Telemetry-Key` | `TelemetryPacket` | `202 { accepted: true, hubId, appliedAt }` | 401 bad key; 400 malformed / unknown ids; 409 `STALE_PACKET` (timestamp ≤ last) — all logged to `telemetry_reject`, no state change | FR-30, NFR-24, NFR-25 |
| `GET /ops/telemetry/rejects` | O | query `limit` | `200 { items: { hubId, packetTimestamp, reason, receivedAt }[] }` | – | NFR-25 (demo) |
| `POST /ops/telemetry/demo/stall` | O | `{ hubId, seconds (1–600) }` | `200 { hubId, stalledUntil }` | 400 | FR-03, FR-35 (demo) |
| `POST /ops/telemetry/demo/fault` | O | `{ resourceType, resourceId, faultCode }` | `200 { queued: true }` — next packet carries the fault | 400; 404 | FR-36 (demo) |
| `POST /ops/telemetry/demo/battery` | O | `{ vehicleId, batteryPct }` | `200 { queued: true }` | 400; 404 | FR-33 (demo) |

---

## 15. Audit log — owner M1

| Method & path | Role | Request | 2xx response | Errors | FR |
|---|---|---|---|---|---|
| `GET /ops/audit` | O | query `entityType?`, `entityId?`, `actorId?`, `action?`, `from?`, `to?`, `limit`, `cursor` | `200 { items: { id, at, actorId, actorRole, action, entityType, entityIds, reason, details }[], nextCursor }` | 400 | FR-63, NFR-14 |

There is no endpoint that edits or deletes audit rows, and the DB trigger refuses it (ARCHITECTURE §5.2).

---

## 16. Screen → endpoint map (for M5 / M6)

| Screen | Endpoints |
|---|---|
| `Login`, `Register` | `/auth/login`, `/auth/register` |
| `student/HubList` | `GET /hubs` (5 s) |
| `student/HubDetail` | `GET /hubs/:id` (5 s) |
| `student/VehicleSearch` | `GET /vehicles/search`, `GET /vehicles/recommend`, `POST /vehicle-reservations` |
| `student/MyReservations` | `GET /vehicle-reservations/current`, cancel / PATCH / pickup / return, `POST /vehicles/:id/report-fault`, `GET /me/history` |
| `student/ParkingBooking` | `GET /parking/availability`, `POST /parking-reservations`, cancel / PATCH / claim / leave, `GET /hubs/alternatives` |
| `student/Charging` | `POST /charging/requests`, `GET /charging/availability`, `POST /charging/advance-bookings`, `GET /charging/requests/mine` (5 s), stop / cancel |
| `student/MyVehicles` | `/private-evs` CRUD, `POST /private-evs/:id/book-parking-charging` |
| `NotificationBell` | `GET /notifications` (5 s), read / read-all |
| `operator/Dashboard` | `GET /ops/dashboard` (5 s), `GET /ops/hubs/:id` (drawer) |
| `operator/Alerts` | `GET /ops/alerts` (5 s), acknowledge / dismiss |
| `operator/Incidents` | `/ops/incidents` (create, list, detail, start-maintenance, resolve) |
| `operator/ChargingQueue` | `GET /ops/charging/queue`, `GET /ops/charging/schedule`, weights GET/PUT/reset, dispatch, override |
| `operator/Redistribution` | `/ops/redistribution/*` |
| `simulation/*` (`/sim/*`, D-24) | `/ops/simulation/*` |
| Demo controls (operator) | `/ops/telemetry/demo/*`, `GET /ops/telemetry/rejects` |