# SPEC.md — Smart E-Mobility Hub (Group 10, HK261)

> **Source of truth for code.** Condensed from the Part 2 report (`cnpm_assigment.docx`, Sections 1–2).
> If this file and the report disagree, the report wins for *wording*; this file wins for *implementation* (see §8 Decisions).
> Every ticket, test and PR must cite IDs from here (`FR-xx`, `BR-xx`, `NFR-xx`, `D-xx`).
> Report wording that must change because of §8 is tracked in `docs/PART2_UPDATES.md`.

**Related docs**
- `docs/ARCHITECTURE.md` — how it is built: modules, data model, patterns, trade-offs behind each `D-xx`.
- `docs/CONTRACTS.md` — every endpoint: URL, request, response, owner, FR IDs.
- `AGENTS.md` — rules every AI tool follows in this repo.

**Who reads this**
- **Opus 4.6 (writer):** read §2–§6 before implementing a ticket.
- **Sonnet 4.6 (checker):** write tests from §4–§6 acceptance criteria, *before* reading the code.
- **Gemini (auditor):** check the repo against §6 and the traceability table in §9.

---

## 1. System in one paragraph

Five Mobility Hubs (Metro Station, Dormitory, Campus A, Campus B, Service Area) hold **Rental vehicles**, **Parking spaces** and **Charging points**. Students reserve/ride/return Rental vehicles, reserve Parking spaces, and request charging. Private EV owners (a role of Student) register their own EVs, reserve parking and schedule charging. Operators monitor the network, handle Incidents, redistribute vehicles, steer the charging queue, and run What-if Simulations on a Snapshot. All state is **simulated** by a generator inside the system that sends telemetry every ~5 s through the same interface a real sensor would use.

**Out of scope:** hardware, maps/3D, payment, Metro integration, campus SSO.

**Stack (fixed):** Node.js + Express + TypeScript · PostgreSQL + Prisma · React + TypeScript + Vite + TanStack Query + shadcn/ui · backend + Postgres on Render, frontend on Vercel. Plain mainstream libraries; no Fastify, no Zod (validate by hand with helpers in `core/errors.ts`).

**Module owners** (from the repo template; `[Mx]` = team member)

| Area | Code | Owner | FRs |
|---|---|---|---|
| Core, telemetry, Hub views, Snapshot | `core/`, `telemetry/`, `modules/hubs`, `simulation/snapshot.ts` | M1 | FR-01–03, FR-30, FR-53 |
| Simulation engine, redistribution | `modules/simulation`, `modules/redistribution` | M2 | FR-43–47, FR-54–59 |
| Auth, notifications, seed data, report updates | `modules/auth`, `modules/notifications`, `prisma/seed.ts` | M3 | FR-29, FR-60–62 |
| Reservations, Private EVs | `modules/reservations`, `modules/private-evs` | M4 | FR-04–19, FR-25–28 |
| Student screens | `frontend/src/pages/student` | M5 | UI for FR-01–28 |
| Charging, incidents, monitoring, operator screens | `modules/charging`, `modules/incidents`, `modules/monitoring`, `frontend/src/pages/operator` | M6 | FR-20–24, FR-31–42, FR-48–52 |

FR-63 (audit) is shared: every module calls `audit()` from `core/audit.ts`.

---

## 2. Glossary (use these words exactly in code, UI and docs)

| Term | Code name | Meaning |
|---|---|---|
| Hub | `hub` | One of the 5 locations |
| Rental vehicle | `rental_vehicle` | Shared e-bicycle or e-motorcycle; always class `MOTORCYCLE` |
| Private EV | `private_ev` | Student-owned e-motorcycle or car; never rented or redistributed |
| Vehicle class | `vehicle_class` | `MOTORCYCLE` (incl. e-bicycles) or `CAR` |
| Parking space | `parking_space` | Holds one vehicle of its class |
| Charging point | `charging_point` | Charges one vehicle of its class at a time |
| Reservation | `reservation` | Held claim on a Rental vehicle or Parking space (kind = `VEHICLE` / `PARKING`) |
| Charging request | `charging_request` | Request to charge a vehicle to a target %, queued or scheduled |
| Charging session | (state `CHARGING` of a charging_request) | Period of actual charging |
| Incident | `incident` | Failure making a resource unavailable |
| Redistribution task | `redistribution_task` | Moving Rental vehicles between Hubs |
| Alert | `alert` | Operator warning: near-capacity, low battery, fault, stalled feed, imbalance |
| Scenario / Snapshot | `scenario` / `snapshot` | What-if input / frozen copy of live state |
| Telemetry | `telemetry_packet` | State update from the (simulated) sensor feed |

---

## 3. Configuration constants (NFR-17: change by config, 0 code changes)

All values live in `backend/src/core/config.ts`, loaded from env with these defaults (charging weights can also be changed at runtime by the Operator, stored in the `setting` table). `(P)` = marked "proposed" in the report; may change.

| Key | Default | Source |
|---|---|---|
| `HUB_COUNT` | 5 | 1.4.2 |
| `RENTAL_VEHICLE_COUNT` | ~300 (seed) | 1.4.2 |
| `CHARGING_POINT_COUNT` | ~60 (seed) | 1.4.2 |
| `RESERVATION_HOLD_MIN` | 15 | BR-03 |
| `MIN_RENTAL_BATTERY_PCT` | 20 | BR-02 |
| `NEAR_CAPACITY_PCT` | 85 | BR-09 |
| `TELEMETRY_INTERVAL_SEC` | 5 | 1.4.1 |
| `STALLED_FEED_INTERVALS` | 3 (→ 15 s) | FR-03, FR-35 |
| `MAX_ACTIVE_RENTALS_PER_STUDENT` | 1 | BR-01 |
| `CHARGING_WEIGHTS` | battery 0.5, urgency 0.3, waiting 0.2 (P) | FR-48 |
| `IMBALANCE_MIN_DEFAULT` / `_MAX_DEFAULT` | 15 / 80 per Hub per class (P) | FR-43, BR-15 |
| `REDISTRIBUTION_DEST_LIMIT_PCT` | 85 (override to 100) | BR-08, Conflict 2 |
| `OVERRIDE_REASON_MIN_CHARS` | 10 (P) | FR-52 |
| `SIM_MAX_HORIZON_H` | 24 (P) | FR-55 |
| `SIM_MAX_RUNTIME_SEC` | 60 (P) | FR-55, NFR-26 |
| `SIM_INTERVAL_MIN` | 15 (P) | FR-56 |
| `CHARGE_RATE_PCT_PER_MIN` | MOTORCYCLE 1.0, CAR 0.5 (D-09) | design |
| `DEMO_TIME_SCALE` | 1 (D-10) | design |

---

## 4. State machines (Table 2.6 — authoritative, used by every module)

Implement each as an explicit transition table in `backend/src/core/stateMachine.ts`; state names live in `backend/src/types/enums.ts` (copied to `frontend/src/types/enums.ts`). Any transition not listed → throw `InvalidStateTransitionError` (HTTP 409) and write a security-audit log row (BR-05).

| Entity | States | Allowed transitions |
|---|---|---|
| Rental vehicle | `AVAILABLE`, `RESERVED`, `IN_USE`, `LOW_BATTERY`, `IN_TRANSIT`, `FAULTY` | AVAILABLE→RESERVED (reserve) · RESERVED→AVAILABLE (cancel, expiry) · RESERVED→IN_USE (pick-up) · IN_USE→AVAILABLE (return, battery ≥ 20) · IN_USE→LOW_BATTERY (return, battery < 20) · AVAILABLE→IN_TRANSIT→AVAILABLE (redistribution) · LOW_BATTERY→AVAILABLE (charged ≥ 20) · any→FAULTY (incident) · FAULTY→AVAILABLE (incident resolved, battery ≥ 20) · FAULTY→LOW_BATTERY (incident resolved, battery < 20) |
| Reservation (vehicle or parking) | `CONFIRMED`, `ACTIVE`, `COMPLETED`, `CANCELLED`, `EXPIRED` | CONFIRMED→ACTIVE (pick-up / claim) · CONFIRMED→CANCELLED (user or incident) · CONFIRMED→EXPIRED (hold elapsed) · ACTIVE→COMPLETED |
| Parking space | `FREE`, `RESERVED`, `OCCUPIED`, `UNAVAILABLE` | FREE↔RESERVED · RESERVED→OCCUPIED · FREE→OCCUPIED (vehicle return / arrival) · OCCUPIED→FREE · any→UNAVAILABLE (incident) · UNAVAILABLE→FREE (resolved) — `status` is the state **now**; future windows are checked against reservations (D-16) |
| Charging request | `QUEUED`, `SCHEDULED`, `CHARGING`, `COMPLETED`, `CANCELLED` | QUEUED/SCHEDULED→CHARGING · CHARGING→COMPLETED (target reached, user stop, point failure) · QUEUED/SCHEDULED→CANCELLED |
| Charging point | `AVAILABLE`, `CHARGING`, `FAULTY` | AVAILABLE→CHARGING→AVAILABLE · any→FAULTY · FAULTY→AVAILABLE |
| Incident | `REPORTED`, `IN_MAINTENANCE`, `RESOLVED` | REPORTED→IN_MAINTENANCE→RESOLVED (resolution notes required) |
| Redistribution task | `PROPOSED`, `APPROVED`, `IN_PROGRESS`, `COMPLETED`, `CANCELLED`, `FAILED` | PROPOSED→APPROVED→IN_PROGRESS→COMPLETED · PROPOSED/APPROVED→CANCELLED · IN_PROGRESS→FAILED |

Notes
- `FREE→OCCUPIED` and `UNAVAILABLE→FREE` for Parking space, and `LOW_BATTERY→AVAILABLE` / `FAULTY→LOW_BATTERY` for Rental vehicle, are implied by UC-06, UC-22 and BR-02 but missing from Table 2.6 — added here (D-11).
- A Rental vehicle that is `FAULTY` during a rental: the rental Reservation is completed/closed by the incident flow (UC-22).

---

## 5. Business rules (condensed, with how we implement them in Node)

| ID | Rule | Implementation (our stack) |
|---|---|---|
| BR-01 | A Student has ≤ 1 active **Rental vehicle** Reservation or rental. A resource has ≤ 1 active Reservation/session at a time. Per-Student limit does **not** apply to Parking or Private EV charging (Conflicts 1 & 5). | Partial unique indexes in Postgres (raw-SQL migration, D-03): one active vehicle reservation per user; one active reservation per vehicle; overlap exclusion for time-window resources. Reject: `409 ACTIVE_RENTAL_EXISTS` / `409 RESOURCE_TAKEN`. |
| BR-02 | Rentable only if `AVAILABLE` **and** battery ≥ 20%. < 20% → `LOW_BATTERY`, hidden from search. | Guard in `vehicles` service; search filter at SQL level. |
| BR-03 | Vehicle hold = 15 min from creation. Parking hold = 15 min from **window start** (FR-18). Expired → status `EXPIRED`, resource released, user notified. | Expiry job in `core/scheduler.ts` every 5 s, `SELECT … FOR UPDATE SKIP LOCKED` on due rows (D-02). Replaces Redis/RabbitMQ in the report. |
| BR-04 | Return only to a Hub with ≥ 1 free MOTORCYCLE Parking space; occupancy never > 100%. Full → redirect (FR-19). | Return transaction locks one free FLEET space (`FOR UPDATE SKIP LOCKED`, D-16); none → `409 HUB_FULL` + alternatives. Counts are derived from rows, not a separate counter (D-04). |
| BR-05 | All state changes follow §4 tables. | `assertTransition(entity, from, to)` in `core/stateMachine.ts`; invalid → `InvalidStateTransitionError` + audit row (D-05, replaces Spring StateMachine). |
| BR-06 | One shared charging queue for Rental vehicles and Private EVs. Score = w1·(100 − battery) + w2·urgency + w3·waiting. Ties: lower battery, then earlier upcoming usage, then earlier request. Never interrupt a running session; booked slots keep their time. No bonus by vehicle type (Conflict 4). | Pure function `rankQueue(requests, weights, now)` in `modules/charging/priority.ts` (D-08); the simulation engine imports the same function. |
| BR-07 | Incident → resource `FAULTY` immediately; affected Reservations/sessions reassigned at same Hub (same class, battery ≥ 20 for vehicles) or cancelled; users notified. | `incidents.service` runs withdraw → find impacted → reassign/cancel → notification rows in **one DB transaction** (D-06). `core/events.ts` is used only *after* commit, for side effects (re-run charging scheduler, alerts). Replaces pub-sub/sagas. |
| BR-08 | Redistribution moves only Rental vehicles. Destination predicted occupancy must stay ≤ 85%; Operator may override up to 100% (Conflict 2). Private EVs never rented/redistributed. | Checks in `redistribution` service; `override` flag requires reason. |
| BR-09 | Near-capacity alert when parking or charging utilisation per class ≥ 85%. | Evaluated after each telemetry batch; de-duplicated (one open alert per hub+class+type). |
| BR-10 | First committed request wins. Losers get a clear rejection + alternatives. | `lockRow()` (`SELECT … FOR UPDATE` via `$queryRaw`) inside `prisma.$transaction` + DB constraints as the final guard (D-03, replaces `@Version`). |
| BR-11 | Simulation runs on a Snapshot, never writes/locks live tables; recommendations applied only after Operator confirms. | `simulation/snapshot.ts` = one `REPEATABLE READ`, `READ ONLY` transaction → JSON; `simulation/engine.ts` is pure TS with no DB import; results stored only in simulation tables (D-07). |
| BR-12 | Operator-only: monitoring overrides, incidents (triage), redistribution, charging overrides/weights, simulation. | `requireRole('OPERATOR')` middleware in `core/auth.ts` → 403 + audit row (replaces `@PreAuthorize`). |
| BR-13 | Vehicle uses only Parking spaces / Charging points of its class. | Class check in every allocation query. |
| BR-14 | Parking + charging combined booking is all-or-nothing, one transaction. | Single transaction; any failure → rollback, response names the missing resource. |
| BR-15 | Shortage if available Rental vehicles of a class < Hub min; surplus if > Hub max. Alert within 5 s. | Evaluated after each telemetry batch; per-hub thresholds in `hub_threshold` table. |

---

## 6. Functional requirements

Priority: **M** = Must, **S** = Should, **C** = Could. Acceptance = what a test must prove (condensed from "How it is verified"). Times like "≤ 5 s" are checked in integration tests with the real generator, not in unit tests.

### 6.1 User side

| ID | Name | P | Acceptance (test must prove) | UC |
|---|---|---|---|---|
| FR-01 | View all Hubs | M | List shows all 5 Hubs with location, free Parking spaces per class, free Charging points per class, available Rental vehicles; counts equal DB state. | UC-01 |
| FR-02 | View Hub detail | M | Shows every Rental vehicle (battery, status) and every Parking space / Charging point (class, state); totals equal FR-01 counts. | UC-01 |
| FR-03 | Data freshness | S | Each Hub shows last-update time; marked `DEGRADED` after 3 missed intervals (15 s); mark clears within one interval after updates resume. | UC-01 |
| FR-04 | Search Rental vehicles | M | Filters Hub, type (e-bike / e-motorcycle), min battery, available-only; returns exactly the matching set; RESERVED/IN_USE/FAULTY/LOW_BATTERY/IN_TRANSIT and vehicles currently charging (D-18) excluded when available-only; empty → "No vehicle found". | UC-02 |
| FR-05 | Recommend vehicles and Hubs | S | Given origin Hub, destination Hub, time: only AVAILABLE vehicles ≥ 20% at origin; destination with no free MOTORCYCLE space is excluded or flagged; each item has a reason string. | UC-02 |
| FR-06 | Reserve Rental vehicle | M | Creates CONFIRMED Reservation, vehicle → RESERVED, returns `expiresAt` (+15 min); ≤ 4 UI steps; Student with active rental/reservation → 409; loser of a race → 409 + alternatives; **50 concurrent requests → exactly 1 success**. | UC-03 |
| FR-07 | Remaining hold time | S | Countdown from server `expiresAt`, within 5 s of server time; at 0 shows EXPIRED. | UC-03 |
| FR-08 | Cancel vehicle Reservation | M | CONFIRMED → CANCELLED, vehicle → AVAILABLE; cancelling ACTIVE/COMPLETED/CANCELLED/EXPIRED → 409. | UC-04 |
| FR-09 | Modify vehicle Reservation | S | Change vehicle (or pick-up time) re-checked atomically; if new choice unavailable, original unchanged; finished reservations can't be modified. | UC-04 |
| FR-10 | Own Reservations & history | S | Returns only the caller's vehicle/parking reservations, rentals and charging requests with status, Hub, times; requesting another user's records is impossible (no user id param; 404/403). | UC-07 |
| FR-11 | Pick up | M | Within hold: Reservation → ACTIVE, vehicle → IN_USE, rental start recorded. Faulty / unreserved / other user's vehicle → rejected with reason; after expiry → rejected. | UC-05 |
| FR-12 | Return | M | At Hub with free MOTORCYCLE space: rental ends, battery recorded, Reservation → COMPLETED, vehicle → AVAILABLE (or LOW_BATTERY if < 20), a FLEET Parking space → OCCUPIED (D-16). No free FLEET space → 409 + alternative Hubs (FR-19). Optional "request charging" on return creates an FR-20 request (D-13). | UC-06 |
| FR-13 | Report faulty vehicle | S | Before or during rental; creates Incident (vehicle, Hub, time, reporter) visible to Operator ≤ 5 s; triggers FR-38. | UC-05, UC-21 |
| FR-14 | Free spaces for a window | S | For Hub + class + window, returns count free for the whole window; 0 → submit disabled + alternatives. | UC-08 |
| FR-15 | Reserve Parking space | M | Uses PUBLIC spaces (D-16). Succeeds only if a space of the class is free for the whole window; 2 concurrent requests for the last space → exactly 1 success, other gets alternatives. | UC-08, UC-15 |
| FR-16 | Cancel Parking Reservation | M | Releases space immediately; CANCELLED/EXPIRED/COMPLETED can't be cancelled again. | UC-09 |
| FR-17 | Modify Parking window | S | New window re-checked; unavailable → original unchanged. | UC-09 |
| FR-18 | Expire unclaimed parking | M | Not claimed within 15 min of window start → EXPIRED, space released, no user action; EXPIRED can't be reactivated. | UC-08 |
| FR-19 | Redirect to alternative Hub | M | When chosen Hub has no free space/point of the class or is DEGRADED: returns ≥ 1 alternative Hub with capacity (sorted by free capacity, D-12), or an explicit "none available". | UC-06 |
| FR-20 | Submit Charging request | M | Vehicle (own Private EV, or Rental vehicle from own active/just-completed rental — D-13), Hub, target %, desired time; joins the single queue ranked per BR-06; other's vehicle / missing field / target ≤ current battery → 400/403. | UC-11 |
| FR-21 | Schedule charging in advance | M | Private EV only. Confirmed only if a Charging point of the class is free for the whole slot; never two overlapping sessions on one point; slot keeps its time when others join; none free → alternatives (time or Hub). | UC-12 |
| FR-22 | View charging status | S | Status + estimated completion (or queue position + estimated start); updates within 5 s; estimate recalculated/removed when session stops. | UC-13 |
| FR-23 | End Charging session | M | User stop, target reached, or point failure → COMPLETED, final battery recorded, point → AVAILABLE, next in queue allocated; a session is never interrupted by a queue join. | UC-14 |
| FR-24 | Cancel Charging request | S | Owner only; QUEUED/SCHEDULED → CANCELLED, slot freed; CHARGING must use FR-23. | UC-11 |
| FR-25 | Register Private EV | M | Type (e-motorcycle / car) + battery info (capacity kWh, current %); class derived; missing field → 400; never appears in rental search or redistribution. | UC-10 |
| FR-26 | Edit Private EV | C | Edits used by later requests; type change refused while EV has active Reservation/session. | UC-10 |
| FR-27 | Remove Private EV | C | Refused with active Reservation/session; otherwise removed from list (soft delete). | UC-10 |
| FR-28 | Book parking + charging | M | One transaction: both a Parking space and a Charging point of the class for overlapping times, or neither; response names the missing resource; success shows in user's list. | UC-15 |
| FR-29 | Register account | M | Unique identifier + valid password → can log in; password stored as bcrypt hash; duplicate identifier → 409; payload asking for role OPERATOR → 403 (FR-60). | UC-16 |

### 6.2 Operator side

| ID | Name | P | Acceptance (test must prove) | UC |
|---|---|---|---|---|
| FR-30 | Telemetry ingestion | M | Packet with timestamp > last for that Hub is applied ≤ 5 s; packet with timestamp ≤ last is rejected and logged, state unchanged. | UC-17 |
| FR-31 | Network dashboard | M | All 5 Hubs: available counts per class, parking % and charging % per class, active rentals, queue depth; matches DB; refresh ≤ 5 s. | UC-19 |
| FR-32 | Hub drill-down | M | Every Rental vehicle, Parking space, Charging point of the Hub with state, class, battery, occupancy; no resources from other Hubs. | UC-19 |
| FR-33 | Capacity & fault alerts | M | Alert ≤ 5 s when utilisation ≥ 85% for a class (85/100 → alert; 84/100 → none), Rental battery < 20%, or fault code. Duplicates update the open alert. | UC-17, UC-20 |
| FR-34 | Alert acknowledgement | S | Acknowledge/dismiss removes from open list; immutable history row (operator, time, action). | UC-20 |
| FR-35 | Stalled feed detection | M | No valid packet for a Hub for ≥ 15 s → STALLED_FEED alert + Hub DEGRADED; not before 15 s. | UC-17, UC-19 |
| FR-36 | Automated incident | M | Packet with fault flag for a resource → Incident (REPORTED) ≤ 5 s, then FR-38. | UC-17, UC-21 |
| FR-37 | Manual incident | M | Requires resource id, Hub, class, category, notes; non-existent resource or missing field → 400; valid → created. If resource already has an open Incident → linked, not duplicated. | UC-21 |
| FR-38 | Resource withdrawal | M | Incident → resource FAULTY/UNAVAILABLE, excluded from search/allocation ≤ 5 s. | UC-21, UC-22 |
| FR-39 | Impacted bookings | M | Lists every active Reservation, ongoing rental, queued/scheduled/charging request on the resource; none omitted. | UC-22 |
| FR-40 | Reassign or cancel | M | Each impacted booking → equivalent resource at same Hub (same class; ≥ 20% for vehicles) or cancelled; user notified either way. | UC-18, UC-22 |
| FR-41 | Incident lifecycle | M | REPORTED→IN_MAINTENANCE→RESOLVED; RESOLVED without notes → 400; on RESOLVED the resource returns to AVAILABLE/FREE. | UC-22 |
| FR-42 | Incident log search | S | Filter by Hub, resource id, class, category, status, time range; correct set; ≤ 2 s. | UC-23 |
| FR-43 | Imbalance detection | M | Per Hub per class: available < min → SHORTAGE alert, > max → SURPLUS alert, ≤ 5 s. Suspended for DEGRADED Hubs. | UC-24 |
| FR-44 | Create redistribution task | M | Source, destination, class, count → PROPOSED; missing field or source = destination → 400. | UC-25, UC-33 |
| FR-45 | Vehicle eligibility | M | Only AVAILABLE Rental vehicles, battery ≥ 20%, no active Reservation; Private EVs, IN_USE, RESERVED, LOW_BATTERY, FAULTY never attached. | UC-25 |
| FR-46 | Destination capacity | M | Count > free MOTORCYCLE spaces at destination → rejected; predicted occupancy > 85% → rejected unless override (BR-08). | UC-25 |
| FR-47 | Redistribution lifecycle | M | IN_PROGRESS → vehicles IN_TRANSIT, gone from source counts; COMPLETED → vehicles AVAILABLE at destination; never counted at both Hubs. | UC-25 |
| FR-48 | Priority weights | S | Operator sets numeric non-negative weights (not all zero); queue re-ranked ≤ 5 s; invalid → 400; audit row. | UC-26 |
| FR-49 | Schedule generation | M | After any queue change, schedule across all points regenerated ≤ 5 s; never two overlapping sessions on one point. | UC-27 |
| FR-50 | Class match | M | CAR requests only to CAR points; MOTORCYCLE only to MOTORCYCLE points. | UC-27 |
| FR-51 | Fleet charging dispatch | M | Operator queues an unreserved Rental vehicle with battery < 20% at its current Hub; reserved vehicle or wrong Hub → 400. | UC-27 |
| FR-52 | Manual override | M | Promote / defer / swap / cancel **waiting** entries only, reason ≥ 10 chars; running session or advance-booked slot → 409; audit row; affected user notified. | UC-28 |
| FR-53 | Snapshot | M | Copy of all Hubs/resources/reservations/queue ≤ 5 s without blocking live writes. | UC-30 |
| FR-54 | Scenario config | M | Templates (a) Metro surge, (b) Hub parking full, (c) charging demand spike, (d) partial point outage, (e) vehicle concentration/shortage; numeric params validated (no negatives, horizon ≤ 24 h, required fields). | UC-29 |
| FR-55 | Isolated run | M | Up to 24 simulated hours, ≤ 60 s real time; **0 writes to live tables** (live checksum identical before/after — NFR-23). | UC-30 |
| FR-56 | Results display | S | Per Hub per 15-min interval: parking %, charging %, avg charging wait, max queue depth, unserved requests; ≥ 85% intervals highlighted. | UC-31 |
| FR-57 | Recommendations | S | For each breach (≥ 85% or unserved > 0): redistribution (count, source→dest), charging adjustments, redirect proposals; none → "Network remains balanced". | UC-32 |
| FR-58 | Confirm recommendation | M | Applying needs explicit confirm; re-validates live rules (BR-08) before creating the live task; dismiss → 0 live writes; audit row. | UC-33 |
| FR-59 | Compare Scenarios | C | Two saved runs side by side with differences (wait, utilisation, unserved). | UC-34 |
| FR-60 | Operator authentication | M | Operators only from seed data; public register with role OPERATOR → 403; bcrypt hashes. | UC-16 |
| FR-61 | Role enforcement | M | Every operator-only endpoint returns 403 for STUDENT tokens. | UC-16, UC-19 |
| FR-62 | Notifications | M | Reassignment, cancellation, expiry, premature session end, redirection, override → in-app notification row ≤ 5 s; shown on next poll. | UC-18 |
| FR-63 | Audit log | M | Every state-changing Operator action → append-only row (operator id, action, entity ids, ISO-8601 time, reason). No UPDATE/DELETE on the table. | many |

---

## 7. Non-functional requirements that code and tests must cover

| ID | What we must show in the demo / tests |
|---|---|
| NFR-01 | p95 ≤ 2 s for Hub list, search, availability (simple load test script, 200 virtual users). |
| NFR-02 | Telemetry change visible in UI ≤ 5 s (polling every 5 s, D-01). |
| NFR-03 | Reserve a vehicle in ≤ 4 clicks. |
| NFR-05 | Every failed operation shows a reason **and** a next action (error format in ARCHITECTURE.md §4.4 and CONTRACTS.md). |
| NFR-06 / NFR-20 | After the test suite, a consistency SQL query finds 0 overlapping reservations and 0 resources in incompatible states. |
| NFR-08 | A failed operation leaves 0 partial rows; retry creates no duplicate (idempotency key on reserve/book endpoints). |
| NFR-11 / NFR-12 | Role test per operator endpoint; user never reads another user's records; passwords hashed. |
| NFR-13 | Boundary tests on every input (battery 19/20, utilisation 84/85, reason 9/10 chars, etc.). |
| NFR-14 / FR-63 | Every Operator action appears in the audit log. |
| NFR-15 / NFR-16 | One module per responsibility (see ARCHITECTURE.md); each unit-tested, ≥ 70% line coverage. |
| NFR-17 | Weights, thresholds, hold time come from config only. |
| NFR-18 | Adding a 6th Hub = seed/config change only. |
| NFR-21 | Concurrency test: 50 parallel reserve requests → exactly 1 success. |
| NFR-23 | Live-state checksum before and after a simulation run is identical. |
| NFR-24 / NFR-25 | Generator and a mock sensor post the same packet format; malformed/out-of-order packets rejected and logged. |
| NFR-27 | Restart the server; all Reservations and Charging requests are still there (state lives in Postgres; jobs resume). |
| NFR-28 | User app usable at 360 px width. |

Report-only (not demonstrated in code): NFR-09 (99% availability), NFR-19 (2× load), NFR-26 beyond FR-55.

---

## 8. Decisions that fill gaps or replace report wording

This is the canonical list. `ARCHITECTURE.md` §16 gives the trade-offs behind each one; `PART2_UPDATES.md` lists the report sentences they change.

| ID | Decision | Why |
|---|---|---|
| D-01 | Near-real-time = **polling** via TanStack Query `refetchInterval: 5000`; no WebSockets. | Meets the 5 s targets; simplest on Vercel + Render. |
| D-02 | Expiry, telemetry generation, stalled-feed check, alert evaluation and the charging scheduler run as **in-process interval jobs** (`core/scheduler.ts`). All state lives in Postgres, so jobs resume after a restart (NFR-27). Exactly **one** backend instance runs. | No Redis/RabbitMQ needed; report BR-03 wording changes. |
| D-03 | Concurrency = `prisma.$transaction` + `lockRow()` (`SELECT … FOR UPDATE` via `$queryRaw`), backed by DB constraints written in a raw-SQL migration: partial unique indexes and `EXCLUDE USING gist` on `(resource_id, tstzrange(start, end))`. | First-committed-wins (BR-10) holds even if app code has a bug. Prisma cannot express these constraints itself. |
| D-04 | Free/occupied counts are **derived by query** from resource rows, not stored counters. | One source of truth; report BR-04 wording changes. |
| D-05 | State machines = TS transition tables + `assertTransition()` in `core/stateMachine.ts`. | Replaces Spring StateMachine. |
| D-06 | Incident handling is one synchronous DB transaction (withdraw → impacted → reassign/cancel → notification rows). `core/events.ts` fires only after commit, for side effects. | No half-finished recovery after a crash (NFR-08); replaces pub-sub/sagas. |
| D-07 | Simulation engine = pure TypeScript over a JSON Snapshot, 1-minute ticks, seeded RNG (deterministic). | Isolation (BR-11) by construction; unit-testable. |
| D-08 | Priority score scales: `battery = 100 − level`; `urgency = clamp(0..100, 100 × (1 − minutesUntilNeeded / 240))`, 0 if no upcoming usage; `waiting = clamp(0..100, waitingMinutes / 120 × 100)`. Operator overrides add `manualAdjust`. Ties: lower battery, earlier upcoming usage, earlier request. | Report gives the formula but no scales. |
| D-09 | Simulated charge rate: MOTORCYCLE 1 %/min, CAR 0.5 %/min (config). Estimated duration = (target − current) / rate. | Needed for FR-22 estimates, scheduling and simulation. |
| D-10 | `DEMO_TIME_SCALE` makes the generator, battery drain and charging run faster than real time for the live demo (default 1). Hold time is a separate config value. | 15-min holds and real charging are too slow to demo. |
| D-11 | Extra transitions in §4 (Parking FREE→OCCUPIED, UNAVAILABLE→FREE; Rental vehicle LOW_BATTERY→AVAILABLE, FAULTY→LOW_BATTERY). | Implied by UC-06, UC-22, BR-02. |
| D-12 | Alternative Hubs ranked by most free capacity of the needed class, excluding DEGRADED Hubs; an active Hub redirect (from an applied simulation recommendation) is listed first. | No distances in scope (no maps). |
| D-13 | A Student can request charging for (a) their own Private EV, or (b) a Rental vehicle **at return time** ("return and request charging"), or within 30 min after returning it if it is still at that Hub and unreserved. | Report says "active or just-completed rental" without defining it; charging during a ride isn't physically possible. |
| D-14 | Rental vehicles parked at a Hub **occupy** MOTORCYCLE Parking spaces (UC-06 step 6). | Needed for BR-04 and FR-46 to mean anything. |
| D-15 | Auth = JWT in the `Authorization` header, bcrypt hashes, roles `STUDENT` / `OPERATOR`. Private EV owner is a Student with a registered Private EV, not a separate role. | Simple; matches 2.1.1. |
| D-16 | Each Parking space has a **pool**: `FLEET` (where Rental vehicles are parked, used by return and redistribution) or `PUBLIC` (reservable by users for time windows, FR-14–18). Utilisation for alerts (BR-09) counts both pools per class. | A space can't be both "parked indefinitely by a fleet vehicle" and "reserved 14:00–16:00 by a user". Splitting keeps both rules simple and correct. |
| D-17 | Telemetry carries **physical** facts only: battery levels, charging progress, fault codes. Business states (Reserved, In use, Confirmed …) change only through user/operator actions. | Prevents the generator overwriting reservations; same split a real IoT feed would have. |
| D-18 | A Rental vehicle that is **charging** is not rentable (hidden from search). Reserving a vehicle that is only **queued** for charging cancels its queued request. | Table 2.6 has no "charging" vehicle state; this avoids renting a vehicle off the charger. |
| D-19 | Redistribution picks and locks the actual vehicles when the task moves to **In progress**, and reserves the destination FLEET spaces at the same moment. At creation/approval only the counts are checked. | Avoids holding vehicles away from students while a task waits for approval. |
| D-20 | Applying a simulation recommendation is two calls: `preview` (shows the exact live changes, returns a one-time confirm token) then `apply` with that token (FR-58, UC-33 E2). | Enforces the "secondary confirmation" in the API, not just in the UI. |

## 9. Traceability

Use the report's Table 2.7 / 2.8 (Section 2.6). Each ticket in `TASKS.md` lists the FR/BR IDs it covers; test names include the FR ID (e.g. `FR-06 rejects a second active reservation`). Gemini checks every **M** requirement maps to at least one merged ticket and one test.

## 10. Open questions for the team (answer before the related ticket starts)

1. Are the `(P)` values in §3 accepted as defaults?
2. M3: reword the report's BR-03/04/05/07/10/11/12 "Design Verification" lines to the Node equivalents in §5 (track in `PART2_UPDATES.md`).
3. Render free tier sleeps when idle and stops background jobs — wake the backend a few minutes before the demo, or use a paid instance for demo week.
4. FR-09 "modify pick-up time": the hold starts at reservation time, so we implement **change vehicle**; changing the pick-up time = cancel + re-reserve. OK?
5. D-16 pool sizes per Hub (seed): proposal in ARCHITECTURE.md §5.3 — confirm.