# PART2_UPDATES.md — Implementation Addendum to the Part 2 Report

> Owner: **M1 → M3** (tracked per `SPEC.md` §8 & §10 Q2).
> Summarises the concrete design decisions (`D-01`–`D-24`), stack alignments, and contract/UX refinements made while building and testing the Smart E-Mobility Hub system.

---

## 1. Stack & Business-Rule Design Verification Alignments

The Part 2 report's "Design Verification" column referenced Spring/Redis/RabbitMQ idioms. In the implemented **Node.js 22 + Express + TypeScript + Prisma + PostgreSQL 16 + React/Vite** stack, each business rule is enforced with stronger database-backed guarantees:

| Rule | Part 2 wording | Implemented verification in Node + PostgreSQL |
|---|---|---|
| **BR-03** | Redis/RabbitMQ TTL expiry jobs | In-process interval job (`reservations.tick` via `core/scheduler.ts`, 5 s interval) using `SELECT … FOR UPDATE SKIP LOCKED`; state persists in Postgres across restarts (NFR-27, D-02). |
| **BR-04** | Stored occupancy counters | Free/occupied counts are derived directly from resource rows (`parking_space`, `charging_point`, `rental_vehicle`), eliminating counter drift (D-04). |
| **BR-05** | Spring StateMachine | Explicit TypeScript transition tables + pure `assertTransition()` in `core/stateMachine.ts`, backed by Postgres enum types (D-05, D-21). Invalid transitions roll back and are audited post-rollback by `errorHandler` (`INVALID_TRANSITION`, D-22). |
| **BR-07** | Async pub-sub / sagas | Single synchronous PostgreSQL transaction in `incidents.service.ts` (withdraw → find impacted → reassign/cancel → write notifications); `core/events.ts` fires only after commit for non-critical side effects (D-06). |
| **BR-10** | JPA `@Version` optimistic locking | `prisma.$transaction` + `lockRow()` (`SELECT … FOR UPDATE` in canonical lock order) + Postgres partial unique indexes and `EXCLUDE USING gist` overlap constraints (D-03). |
| **BR-11** | Isolated simulation service | `simulation/snapshot.ts` reads live state in a single `REPEATABLE READ, READ ONLY` transaction → plain JSON; `simulation/engine.ts` and `recommend.ts` are pure TypeScript with ESLint-enforced zero DB imports; results live strictly in `sim_*` tables (D-07). |
| **BR-12** | `@PreAuthorize` | Express `requireAuth` + `requireRole('OPERATOR')` middleware in `core/auth.ts`; denials return `403 FORBIDDEN` and write a `SECURITY_DENIED` audit row (D-15, D-22). |

---

## 2. Summary of Design Decisions (`D-01`–`D-24`)

| ID | Decision |
|---|---|
| **D-01** | Near-real-time UI updates use TanStack Query polling (`refetchInterval: 5000`); no WebSockets. |
| **D-02** | Background jobs (telemetry, reservation expiry, charging scheduler, monitoring/alerts) run in-process on a single backend instance; all state lives in PostgreSQL. |
| **D-03** | Concurrency combines row locking (`lockRow` / `FOR UPDATE SKIP LOCKED`) with raw-SQL partial unique indexes and `btree_gist` exclusion constraints. |
| **D-04** | Hub availability and utilisation metrics are derived by query from resource rows rather than stored counters. |
| **D-05** | All entity and system-table state transitions are validated by `core/stateMachine.ts`. |
| **D-06** | Incident withdrawal and booking recovery execute atomically in one DB transaction. |
| **D-07** | What-if Simulation runs a deterministic 1-minute tick engine with seeded PRNG (`mulberry32`) over a read-only JSON snapshot. |
| **D-08** | Explicit 0–100 scales for charging priority score (`battery`, `urgency` over 240 min, `waiting` over 120 min) plus `manualAdjust` for operator overrides. |
| **D-09** | Simulated charge rates (`MOTORCYCLE` 1.0 %/min, `CAR` 0.5 %/min) drive estimates, scheduling, and simulation. |
| **D-10** | `DEMO_TIME_SCALE` accelerates telemetry battery drain/charging during live demos without altering hold durations. |
| **D-11** | Added implied state transitions (`FREE→OCCUPIED`, `UNAVAILABLE→FREE`, `LOW_BATTERY→AVAILABLE`, `FAULTY→LOW_BATTERY`) to Table 2.6. |
| **D-12** | Alternative Hubs are ranked by free capacity (excluding degraded Hubs, prioritising active redirects); UI uses a zero-dependency inline SVG campus map instead of external map libraries. |
| **D-13** | Students may request charging for their Private EV, or for a Rental vehicle at return time or within 30 minutes after return while still at that Hub and unreserved. |
| **D-14** | Parked Rental vehicles occupy `MOTORCYCLE` `FLEET` parking spaces. |
| **D-15** | JWT bearer auth + bcryptjs password hashes; Private EV owner is a `STUDENT` with registered EVs rather than a separate role. |
| **D-16** | Parking spaces are split into `FLEET` (rental returns/redistribution) and `PUBLIC` (time-window reservations); utilisation alerts count both pools. |
| **D-17** | Telemetry updates physical facts only (battery, charging progress, faults); business states change only via user/operator actions. |
| **D-18** | A Rental vehicle currently charging is hidden from rental search; reserving a vehicle that is only queued cancels its queued charging request. |
| **D-19** | Redistribution locks specific vehicles and destination `FLEET` spaces when moving to `IN_PROGRESS` (counts only at creation/approval). |
| **D-20** | Applying a simulation recommendation is a two-step API contract: `GET /preview` (re-checks live state, mints 5-minute one-time `confirmToken`) followed by `POST /apply { confirmToken }`. |
| **D-21** | Every state and vocabulary column uses a PostgreSQL enum mirrored byte-for-byte in `types/enums.ts` (verified by `enums.test.ts`). |
| **D-22** | `INVALID_TRANSITION` and `SECURITY_DENIED` audit rows are written post-rollback so failed transactions never drop security audit entries. |
| **D-23** | Acyclic cross-module direction: `reservations → charging` for atomic return-with-charging and queue cancellation; `charging` reads `vehicle_reservation` read-only for the D-13 window. |
| **D-24** | What-if Simulation lives in a separate Operator Sandbox Workspace at `/sim/*` (`SimulationLayout`, persistent BR-11 sandbox banner, Operations ↔ Simulation switch) while backend API routes remain `/api/ops/simulation/*`. |

---

## 3. Notable Contract & UX Refinements

- **Separate Simulation Sandbox Workspace (`/sim/*`, D-24):** Isolates simulation scenarios, runs, comparisons, and recommendations visually from live `/ops/*` operations; `/ops/simulation` redirects to `/sim`.
- **Two-Step Recommendation Confirmation (`D-20`):** Opening Preview calls `GET /preview` on demand; live state drift between preview and apply transitions the recommendation to `BLOCKED` (`409 LIVE_STATE_CONFLICT`) with specific problem details.
- **Widened Alert Deduplication & Dismiss Suppression (T-24):** Unique open-alert dedupe covers both `OPEN` and `ACKNOWLEDGED` statuses; dismissing an alert suppresses re-creation until the underlying condition clears.
- **Atomic Combined Parking + Charging (`bookingGroupId`, FR-28):** `POST /api/private-evs/:id/book-parking-charging` books both resources in one transaction with idempotency and explicit `details.missing` (`PARKING` | `CHARGING`) on rollback.
- **Parking Hold Expiry & `409 NOT_ELIGIBLE` (FR-18, FR-51):** Parking reservation hold expiry is clamped to `min(windowStart + hold, windowEnd)`. Early parking claims (`details.opensAt`) and ineligible fleet charging dispatches (reserved vehicle or battery ≥ 20 %) return `409 NOT_ELIGIBLE`.
- **Inline SVG Campus Map & Vehicle Illustrations (D-12, NFR-28):** Pure inline SVG 5-Hub schematic (`CampusMap`) and vehicle silhouettes (`VehicleIcon`) avoid external map libraries and scale cleanly down to `360 px` mobile viewports.

---

## 4. Verification & Quality Summary

- **Automated Backend Suite:** **773** passing Vitest + Supertest tests across **29** test files covering all Must/Should FRs, boundary values (NFR-13), 50-way concurrency races (NFR-21), 15-table simulation isolation checksums (NFR-23), and module coverage ≥ 70 % (NFR-16).
- **Static & Architecture Checks:** Root `npm run lint` (ESLint), `npm run typecheck` (strict TypeScript), `npm run build` (backend + frontend Vite bundle), and `npm run check:cycles` (Madge, 0 circular dependencies) enforced on every PR via GitHub Actions CI.
- **Operational Verification Scripts (`backend/scripts/`):**
  - `npm run check-consistency -w backend` — verifies 5 PostgreSQL integrity invariants (parked fleet spaces, reservation/vehicle parity, charging 1:1 parity, alert/incident deduplication, append-only audit trigger).
  - `npm run demo -w backend -- --api <url>` — self-cleaning 6-step end-to-end showcase (Student, Operator, Simulation).
  - `npm run load-test -w backend -- --api <url>` — 50-concurrent read latency (`p50`/`p95`/`max`) + 20-way concurrent booking race (`1×201`, `19×409`, `0×500`).
  - `npm run smoke -w backend -- --api <url> [--web <url>]` — post-deploy health, auth error shape, CORS preflight, and SPA route verification.
