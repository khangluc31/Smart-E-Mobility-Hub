# Smart E-Mobility Hub

Electric mobility coordination system for the **VNU-HCM Urban Area**.
Software Engineering assignment (HK261), **Group 10**.

Students arrive by Metro Line 1 and continue with shared electric bicycles and motorcycles, or with their own electric vehicles. The system coordinates three shared resources (**Rental vehicles, Parking spaces and Charging points**) across five Hubs, using simulated near-real-time state data. Operators monitor the network, handle Incidents, redistribute vehicles, schedule charging, and test decisions safely with **What-if Simulation**.

> Requirements: Part 2 of the report (FR-01 – FR-63, NFR-01 – NFR-28, BR-01 – BR-15, UC-01 – UC-34).
> Architecture decisions: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) · API contracts: [`docs/CONTRACTS.md`](docs/CONTRACTS.md) · Report addendum: [`docs/PART2_UPDATES.md`](docs/PART2_UPDATES.md) · Deployment runbook: [`docs/DEPLOY.md`](docs/DEPLOY.md) · Rules for AI coding tools: [`AGENTS.md`](AGENTS.md)

---

## Contents

1. [Features](#features)
2. [Tech stack](#tech-stack)
3. [Architecture at a glance](#architecture-at-a-glance)
4. [Folder structure](#folder-structure)
5. [Getting started (local)](#getting-started-local)
6. [Demo accounts and demo tools](#demo-accounts-and-demo-tools)
7. [Configuration](#configuration)
8. [Testing](#testing)
9. [Deployment](#deployment)
10. [Team and module ownership](#team-and-module-ownership)
11. [Git workflow](#git-workflow)
12. [Troubleshooting](#troubleshooting)

---

## Features

**Student / Private EV owner**
- View all Hubs and their live status: free Parking spaces and Charging points per vehicle class, available Rental vehicles, data freshness
- Search Rental vehicles by Hub, type and battery level; get Hub recommendations for a journey
- Reserve a Rental vehicle (15-minute hold), pick it up and return it, with redirection to another Hub when one is full
- Reserve Parking spaces for a time window
- Submit Charging requests, schedule charging in advance, view charging status, end a session
- Register Private EVs and book parking and charging together
- In-app notifications when an Operator action or an Incident changes a booking

**Operator**
- Network dashboard and Hub drill-down, refreshed every ~5 s
- Automatic alerts: near capacity (85 %), low battery (< 20 %), faults, stalled data feed
- Incident handling: automatic or manual creation, resource withdrawal, automatic reassignment or cancellation of affected bookings, lifecycle tracking
- Rental vehicle Redistribution between Hubs, with eligibility and capacity checks
- Smart charging: one shared priority queue, configurable weights, fleet charging dispatch, manual override with an audit reason
- What-if Simulation on an isolated Snapshot: 5 Scenario types, results per 15-minute interval, recommendations applied only after Operator confirmation

---

## Tech stack

TypeScript on both sides, with mainstream libraries only.

| Layer | Technology |
|---|---|
| Backend | **Node.js 22 + Express + TypeScript** |
| Database | **PostgreSQL 16** |
| ORM + migrations | **Prisma** |
| Auth | **jsonwebtoken** (JWT) + **bcryptjs** (password hashing) |
| Frontend | **React + TypeScript + Vite** |
| UI | **Tailwind CSS + shadcn/ui** |
| Data fetching | **TanStack Query** (auto-refresh every 5 s) |
| Tests | **Vitest + Supertest** |
| Lint / format | **ESLint + Prettier** |
| Hosting | **Vercel** (frontend), **Render** (backend), **Render Postgres or Neon** (database) |
| CI | **GitHub Actions** |

Why a few of these:
- **Postgres + Prisma:** real row locking, so two students can never book the same vehicle (BR-10). Prisma gives typed queries, migrations, and Prisma Studio to look at the data.
- **TanStack Query:** screens refetch every 5 s, which meets the "changes visible within 5 s" requirement (NFR-02) without WebSockets.
- **Render for the backend:** the backend runs background jobs (simulated sensor data every 5 s, the 15-minute reservation expiry). That needs a server that keeps running, which Vercel doesn't provide.

---

## Architecture at a glance

```
 Browser (React app on Vercel)
   │  REST/JSON over HTTPS, refetch every 5 s
   ▼
 Express backend (Render, 1 instance) ────────────────────────────────────────┐
   │  routes → services (business rules) → Prisma                              │
   │                                                                          │
   │  core: auth · state machine · errors · events · scheduler · audit         │
   │                                                                          │
   │  modules: hubs · auth · reservations · private-evs · charging ·           │
   │           incidents · monitoring · redistribution · simulation ·          │
   │           notifications                                                  │
   │                                                                          │
   │  telemetry: generator (simulated sensors, every 5 s) → ingestion ─────────┘
   ▼
 PostgreSQL (all live state, accounts, audit log, simulation results)
```

- **One backend split into modules** (NFR-15). Each module has its own folder and talks to the others through services and events.
- **Business rules live only in backend services.** The frontend displays and submits.
- **Every status change goes through `core/stateMachine.ts`** (Table 2.6, BR-05).
- **Modules react to each other through events.** Example: `incident.created` → reservations and charging reassign or cancel affected bookings → users get notified (BR-07).
- **Simulation is isolated.** It copies live state into a Snapshot, runs in plain TypeScript with no database access, and changes live data only after the Operator confirms (BR-11).

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for every decision and its trade-offs.

---

## Folder structure

`[Mx]` = owner (see [Team and module ownership](#team-and-module-ownership)).

```
smart-emobility-hub/
|- package.json                   [M1] root scripts only: `npm run dev` starts backend + frontend
|- AGENTS.md                      [M1] rules every teammate's AI must follow
|- CLAUDE.md                      [M1] one line: "read AGENTS.md"
|- README.md                      [M1] this file
|- docker-compose.yml             [M1] local Postgres
|- render.yaml                    [M1] Render backend + Postgres blueprint
|- .gitignore
|- .github/
|  |- workflows/
|  |  |- ci.yml                   [M1] lint + typecheck + test + build on every PR
|  |- pull_request_template.md    [M1] owner, FR IDs, tests, AI Log ticked
|
|- docs/
|  |- SPEC.md                     [M1] requirements, state machines, business rules, decisions D-01–D-24
|  |- ARCHITECTURE.md             [M1] decisions + trade-offs + component diagram (report 3.1)
|  |- CONTRACTS.md                [M1] every endpoint: URL, request, response, owner, FR IDs
|  |- DEPLOY.md                   [M1] production Render + Vercel deployment runbook
|  |- PART2_UPDATES.md            [M1→M3] implementation addendum to the Part 2 report
|  |- AI_USAGE_LOG.md             [all] declared AI-assisted changes per ticket
|
|- backend/
|  |- package.json
|  |- tsconfig.json
|  |- .env.example
|  |- Dockerfile                  [M1]
|  |- prisma/
|  |  |- schema.prisma            [M1] all tables (others request changes via PR)
|  |  |- migrations/              generated by `npm run db:migrate`
|  |  |- seed.ts                  [M3] 5 Hubs, 300 vehicles, 60 Charging points, accounts
|  |- src/
|  |  |- server.ts                [M1] starts Express + background jobs
|  |  |- app.ts                   [M1] middleware, routes, error handler
|  |  |- core/                    [M1] shared code - others use it, don't edit it
|  |  |  |- config.ts             env vars and all business numbers (15 min, 20 %, 85 %, 5 s ...)
|  |  |  |- db.ts                 Prisma client
|  |  |  |- auth.ts               JWT, bcrypt, requireAuth / requireRole middleware
|  |  |  |- errors.ts             AppError + one JSON error format
|  |  |  |- stateMachine.ts       allowed state transitions (Table 2.6)
|  |  |  |- events.ts             event emitter + list of events
|  |  |  |- scheduler.ts          periodic background jobs
|  |  |  |- audit.ts              audit() helper (FR-63)
|  |  |  |- notify.ts             notify() helper (FR-62)
|  |  |- types/
|  |  |  |- enums.ts              [M1] all states and vocabulary
|  |  |- telemetry/               [M1] simulated sensor feed
|  |  |  |- generator.ts          fake sensor data every 5 s
|  |  |  |- ingestion.ts          check timestamps, update state, emit events
|  |  |  |- telemetry.routes.ts   external ingest endpoint + demo endpoints
|  |  |- modules/                 each module: *.routes.ts + *.service.ts
|  |     |- hubs/                 [M1] FR-01-03  - FULL EXAMPLE to copy
|  |     |  |- hubs.routes.ts
|  |     |  |- hubs.service.ts
|  |     |- auth/                 [M3] FR-29, 60, 61
|  |     |- notifications/        [M3] FR-62
|  |     |- reservations/         [M4] FR-04-19  vehicles, parking, pick-up/return, redirect
|  |     |- private-evs/          [M4] FR-25-28  incl. combined booking
|  |     |- charging/             [M6] FR-20-24, 48-52
|  |     |- incidents/            [M6] FR-13, 36-42
|  |     |- monitoring/           [M6] FR-31-35  dashboard, alerts
|  |     |- redistribution/       [M2] FR-43-47
|  |     |- simulation/           [M2] FR-53-59
|  |        |- simulation.routes.ts
|  |        |- simulation.service.ts
|  |        |- snapshot.ts        [M1] read-only copy of live state
|  |        |- engine.ts          [M2] plain TypeScript, no database access
|  |- scripts/
|  |  |- demo.ts                  [M1] end-to-end Student + Operator + Simulation showcase
|  |  |- load-test.ts             [M1] 50-concurrent read latency + 20-way BR-10 booking race
|  |  |- check-consistency.ts     [M1] 5 PostgreSQL integrity invariant checks
|  |  |- smoke.ts                 [M1] deployment smoke check (health, 401 shape, CORS, SPA)
|  |  |- mock-sensor.ts           [M1] external telemetry sensor CLI
|  |- tests/
|     |- helpers.ts               [M1] test app + loginAs('student1')
|     |- stateMachine.test.ts     [M1]
|     |- hubs.test.ts             [M1] example tests
|     |- <module>.test.ts         [owner] 29 test files, 773 passing tests
|
|- frontend/
   |- package.json
   |- vite.config.ts              forwards /api to the backend in dev
   |- tsconfig.json
   |- components.json             shadcn config
   |- vercel.json                 SPA rewrites
   |- index.html
   |- .env.example                VITE_API_URL
   |- src/
      |- main.tsx                 [M1] providers (TanStack Query, router, auth)
      |- App.tsx                  [M1] all routes
      |- index.css                [M1] Tailwind + shadcn theme
      |- lib/
      |  |- utils.ts              cn() helper (shadcn)
      |  |- api.ts                [M1] fetch wrapper: base URL, token, error handling
      |- types/                   API response types, mirrored from the backend
      |  |- enums.ts              [M1] copy of backend enums
      |  |- hubs.ts               [M1] example
      |  |- <module>.ts           [owner of the screens]
      |- hooks/                   TanStack Query hooks, one file per module
      |  |- useHubs.ts            [M1] example
      |  |- useAuth.ts            [M3]
      |  |- useReservations.ts    [M5]
      |  |- useCharging.ts        [M5 student / M6 operator]
      |  |- useOperator.ts        [M6]
      |  |- useSimulation.ts      [M6]
      |- context/
      |  |- AuthContext.tsx       [M1] logged-in user, login / logout
      |- components/
      |  |- ui/                   shadcn components (generated by the shadcn CLI)
      |  |- layout/               [M1] StudentLayout, OperatorLayout, SimulationLayout, RequireRole
      |  |- common/               [M1/M5] StatusBadge, BatteryBar, ErrorBox, CampusMap, VehicleIcon, NotificationBell
      |- pages/
         |- Login.tsx             [M1]
         |- Register.tsx          [M1]
         |- ChangePassword.tsx    [M3]
         |- student/              [M5]
         |  |- HubList.tsx        [M1] + inline SVG CampusMap
         |  |- HubDetail.tsx      [M1]
         |  |- VehicleSearch.tsx
         |  |- MyReservations.tsx
         |  |- ParkingBooking.tsx
         |  |- Charging.tsx
         |  |- MyVehicles.tsx     Private EVs + combined booking
         |- operator/             [M6]
         |  |- Dashboard.tsx      + inline SVG CampusMap & Hub drill-down
         |  |- Alerts.tsx
         |  |- Incidents.tsx
         |  |- ChargingQueue.tsx
         |  |- Redistribution.tsx
         |  |- DemoControls.tsx
         |- simulation/           [M6/M2] separate /sim/* sandbox workspace (D-24)
            |- Scenarios.tsx
            |- Runs.tsx
            |- RunDetail.tsx
            |- Compare.tsx
            |- Recommendations.tsx
```

**Backend module convention.** Every module folder has two files:

| File | Contains | Must not contain |
|---|---|---|
| `<module>.routes.ts` | Express `Router`: URLs, `requireAuth` / `requireRole`, input checks, calls the service, sends the JSON | Business rules, Prisma queries |
| `<module>.service.ts` | Business rules, Prisma queries and transactions, state transitions, event listeners | `req`, `res`, status codes |

Copy the `hubs` module when you start a new one. Response shapes are listed in `docs/CONTRACTS.md`; the frontend copies them into `frontend/src/types/`.

---

## Getting started (local)

### Prerequisites

- **Node.js 22 LTS** (comes with npm). Check with `node -v`.
- **Docker Desktop**, for the local Postgres. No Docker? Create a free Neon database and put its URL in `backend/.env`.
- Git

### 1. Clone and install

```bash
git clone https://github.com/<org>/smart-emobility-hub.git
cd smart-emobility-hub
npm install                       # installs root + backend + frontend (npm workspaces)
```

### 2. Start Postgres

```bash
docker compose up -d
```

This starts Postgres 16 on `localhost:5432` with two databases: `emobility` (development) and `emobility_test` (tests). User and password are both `postgres`.

### 3. Set up the database

```bash
cp backend/.env.example backend/.env    # Windows PowerShell: Copy-Item backend/.env.example backend/.env
npm run db:migrate -w backend           # create tables + constraints
npm run db:seed -w backend              # 5 Hubs, 300 Rental vehicles, 60 Charging points, 22 accounts
```

### 4. Run

```bash
npm run dev                             # starts backend (:3000) and frontend (:5173) together
```

| | URL |
|---|---|
| Frontend | http://localhost:5173 |
| Operator Operations | http://localhost:5173/ops |
| Operator Simulation Sandbox (D-24) | http://localhost:5173/sim |
| Backend API | http://localhost:3000/api |
| Health check | http://localhost:3000/api/health |

In development, Vite forwards `/api/*` to the backend, so there's no CORS setup.

### Useful commands

Run from the repo root:

| Command | What it does |
|---|---|
| `npm run dev` | Start backend + frontend together |
| `npm test -w backend` | Run all 773 backend tests (Postgres must be running) |
| `npm run lint` | ESLint across backend + frontend |
| `npm run typecheck` | TypeScript strict check across backend + frontend |
| `npm run build` | Production build for backend + frontend |
| `npm run check:cycles` | Madge circular-dependency check on `backend/src` |
| `npm run db:migrate -w backend` | Apply Prisma migrations (dev) |
| `npm run db:seed -w backend` | Idempotent seed (preserves live state on re-run) |
| `npm run db:reset -w backend` | Wipe, re-migrate, and re-seed dev database |
| `npm run db:studio -w backend` | Browse and edit data in Prisma Studio |

---

## Demo accounts and demo tools

All seeded accounts use the `SEED_PASSWORD` value configured in `backend/.env`:

| Role | Identifier | Notes |
|---|---|---|
| Operator | `operator1`, `operator2` | Seeded only; public registration rejects `OPERATOR` (FR-60) |
| Student | `student1` … `student20` | `student1`–`student5` have seeded Private EVs |

**Operator Demo Controls UI (`/ops/demo`) & endpoints** (Operator only):

| Endpoint | Use it to show |
|---|---|
| `POST /api/ops/telemetry/demo/stall` | Stall a Hub feed → Hub marked `DEGRADED` + `STALLED_FEED` alert after 15 s (FR-03, FR-35) |
| `POST /api/ops/telemetry/demo/fault` | Inject a resource fault → automatic Incident, withdrawal, reassignment, notification (FR-36–40) |
| `POST /api/ops/telemetry/demo/battery` | Set a vehicle battery % → `LOW_BATTERY` alert & fleet dispatch (FR-33, FR-51) |
| `GET /api/ops/telemetry/rejects` | Inspect rejected malformed/stale telemetry packets (NFR-25) |

**Verification & demo CLI scripts** (run from repo root):

```bash
# 1. Verify all 5 PostgreSQL integrity invariants
npm run check-consistency -w backend

# 2. Run the 6-step end-to-end showcase (Student, Operator, Simulation — self-cleaning)
npm run demo -w backend -- --api http://localhost:3000

# 3. Run 50-concurrent read latency + 20-way BR-10 booking race (self-cleaning)
npm run load-test -w backend -- --api http://localhost:3000

# 4. Run deployment smoke check (local or Render + Vercel)
npm run smoke -w backend -- --api https://<api>.onrender.com --web https://<project>.vercel.app

# 5. Send a live mock sensor packet (NFR-24)
npm run mock-sensor -w backend
```

---

## Configuration

All business numbers are settings, not hard-coded values (NFR-17). Set them in `backend/.env` locally, or as environment variables on Render (see [`docs/DEPLOY.md`](docs/DEPLOY.md) for the full production variable reference).

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | `postgresql://postgres:postgres@localhost:5432/emobility` | Development database connection |
| `DATABASE_URL_TEST` | `postgresql://postgres:postgres@localhost:5432/emobility_test` | Test database used by `npm test -w backend` |
| `PORT` | `3000` | HTTP port (Render sets this automatically) |
| `JWT_SECRET` | `change-me` | Token signing key (**change in production**) |
| `JWT_EXPIRES_IN` | `8h` | Login session length |
| `CORS_ORIGIN` | `http://localhost:5173` | Comma-separated frontend URLs allowed to call the API |
| `TELEMETRY_KEY` | `change-me` | Header `X-Telemetry-Key` for external sensors posting telemetry |
| `SEED_PASSWORD` | `change-me` | Password hashed (bcrypt) for seeded `operator1..2` and `student1..20` |
| `JOBS_ENABLED` | `false` (dev) / `true` (prod) | Runs in-process telemetry, expiry, charging scheduler, and alert jobs |
| `DEMO_TIME_SCALE` | `1` | Speed multiplier for simulated battery drain & charging (D-10) |
| `FAULT_PROBABILITY` | `0` | Per-tick random fault probability (`0` = demo-injected faults only) |

Frontend (`frontend/.env.example`, or Vercel environment variables):

| Variable | Example | Meaning |
|---|---|---|
| `VITE_API_URL` | `https://smart-emobility-api.onrender.com/api` | Backend API URL (leave unset locally to use Vite's `/api` proxy) |

---

## Testing

```bash
docker compose up -d              # tests need Postgres
cd backend
npm test
```

- Tests call the Express app directly with Supertest, so no server needs to be running. `loginAs('student1')` in `tests/helpers.ts` gives you an auth header.
- Tests run against the separate `emobility_test` database, which is wiped before each run.
- Put your module's tests in `backend/tests/<module>.test.ts` and start each test name with the requirement ID, e.g. `it('FR-06: rejects a second active reservation', ...)`. These names map tests to requirements in report Section 5.
- CI runs lint, tests and both builds on every pull request. A red build is not merged.

---

## Deployment

See the full step-by-step Render + Vercel runbook in [`docs/DEPLOY.md`](docs/DEPLOY.md).

```
Vercel (frontend)  ──HTTPS──▶  Render web service (Express, 1 instance)  ──▶  Render Postgres / Neon
```

### Database
- **Render Postgres (free):** New → Postgres. Copy the **Internal Database URL**.
- **or Neon (free):** create a project and copy the connection string.
- Free databases have size and time limits. Check your provider's dashboard. Switching only changes `DATABASE_URL`.

### Backend on Render
Use the `render.yaml` blueprint (New → Blueprint), or set it up by hand:

| Setting | Value |
|---|---|
| Root directory | `backend` |
| Runtime | Node |
| Build command | `npm ci && npm run build` |
| Start command | `npm start` (applies migrations, then starts the server) |
| Environment | `DATABASE_URL`, `JWT_SECRET` (random string), `CORS_ORIGINS=https://<your-app>.vercel.app`, `TELEMETRY_KEY`, `NODE_VERSION=22` |

After the first deploy, seed once from the Render shell: `npm run db:seed`.

> **Always 1 instance.** The background jobs run inside the backend process. Several instances would run each job several times.
>
> **Free Render services sleep after ~15 minutes with no traffic** and take up to a minute to wake up. The frontend refetches every 5 s, so the backend stays awake while someone has the site open. Open the site a minute before recording or presenting.

### Frontend on Vercel

| Setting | Value |
|---|---|
| Root directory | `frontend` |
| Framework preset | Vite |
| Build command | `npm run build` |
| Output directory | `dist` |
| Environment | `VITE_API_URL=https://<your-backend>.onrender.com` |

`vercel.json` sends every route to `index.html` so page refreshes work. After the first Vercel deploy, add its URL to the backend's `CORS_ORIGINS`.

---

## Team and module ownership

| Member | Backend | Frontend | Requirements |
|---|---|---|---|
| **Member 1** | `core/`, `telemetry/`, `modules/hubs/`, `simulation/snapshot.ts`, `schema.prisma`, integration | App shell, auth, layouts, Hub pages | FR-01–03, FR-30, NFR-15/17/24 |
| **Member 2** | `modules/simulation/`, `modules/redistribution/` | – (screens built by M6) | FR-43–47, FR-53–59 |
| **Member 3** | `modules/auth/`, `modules/notifications/`, `prisma/seed.ts` | `NotificationBell`, `useAuth` | FR-29, FR-60–62 |
| **Member 4** | `modules/reservations/`, `modules/private-evs/` | – (screens built by M5) | FR-04–19, FR-25–28 |
| **Member 5** | – | All Student pages | Student-side UI for FR-04–28 |
| **Member 6** | `modules/charging/`, `modules/incidents/`, `modules/monitoring/` | All Operator pages | FR-13, FR-20–24, FR-31–42, FR-48–52 |

Report sections, test runs and deadlines are tracked in `SE_Group10_Progress_Tracker.xlsx`.

---

## Git workflow

- `main` is always deployable. Never push directly to `main`.
- Branch per task: `feat/m4-reserve-vehicle`, `fix/m6-alert-dedup`.
- Pull request title: `[M4] FR-06 Reserve a Rental vehicle`. Fill in the PR template.
- Merge when **CI is green and Member 1 has had a quick look**.
- Changes to `core/`, `telemetry/`, `schema.prisma` or `types/enums.ts` need Member 1's approval. Explain why in the PR.
- **One migration per PR**, created with `npm run db:migrate -- --name <short-name>`. If another PR with a migration was merged first, rebase and regenerate yours.
- **Using AI? Add a row to the AI Log sheet** in the tracker (required for report Section 6.1).
- Before asking your AI to code, point it at [`AGENTS.md`](AGENTS.md) and [`docs/CONTRACTS.md`](docs/CONTRACTS.md).

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `Can't reach database server at localhost:5432` | Postgres isn't running: `docker compose up -d` |
| Frontend shows "Failed to fetch" | Backend not running on port 3000, or `VITE_API_URL` is wrong |
| CORS error in production | Add the exact Vercel URL (no trailing slash) to `CORS_ORIGINS` on Render |
| `501 NOT_IMPLEMENTED (owner: Member X)` | Expected: that endpoint is still a stub owned by Member X |
| `409 CONCURRENT_UPDATE` | Expected under concurrency: another request took the resource first (BR-10) |
| Type errors after pulling | Run `npm install` in `backend/` and `frontend/`, then `npx prisma generate` in `backend/` |
| `The table ... does not exist` | Someone added a migration: run `npm run db:migrate` in `backend/` |
| Build fails: `Cannot find module '@/components/ui/button'` | Run the `npx shadcn@latest add ...` command from step 4 |
| First request on Render takes ~1 minute | The free service was asleep. Wait, then refresh |
