# DEPLOY.md — Production Deployment Runbook (Render + Vercel)

> Owner: **M1** (ARCHITECTURE §14, D-02, SPEC §10 Q3).
> Keep placeholders (`<api>`, `<project>`, `<external-db-url>`) in this file — **never commit real credentials or secret URLs**.

---

## 1. Architecture Overview

| Component | Platform | Source | Notes |
|---|---|---|---|
| **Backend API + Jobs** | Render Web Service (`docker`) | `render.yaml` (`./backend/Dockerfile`, context `.`) | **Exactly one instance (D-02)**. Do not scale horizontally. |
| **PostgreSQL** | Render Postgres (`emobility-db`) | `render.yaml` | Requires `btree_gist` extension (applied in migration `20261121034824_constraints`). |
| **Frontend SPA** | Vercel | `frontend/` (`frontend/vercel.json`) | Static Vite build with SPA rewrite `/(.*) -> /index.html`. |

---

## 2. Click-by-Click Initial Deployment (User Steps 1–7)

### Step 1 — Deploy Backend & Database on Render via Blueprint
1. In the Render Dashboard, click **New → Blueprint** and connect this GitHub repository.
2. Render reads `render.yaml` and provisions:
   - PostgreSQL database: `emobility-db` (database name `emobility`, Singapore region, Free plan).
   - Docker web service: `smart-emobility-api` (`dockerContext: .`, `dockerfilePath: ./backend/Dockerfile`).
3. When prompted for `sync: false` environment variables:
   - Set `CORS_ORIGIN` temporarily to `http://localhost:5173`.
   - Set `SEED_PASSWORD` to a strong password for the seeded accounts (`operator1`..`2`, `student1`..`20`).

### Step 2 — Verify Migrations & `btree_gist` in the First Deploy Log
1. Watch the Render deploy logs for `smart-emobility-api`.
2. At container startup, `npx prisma migrate deploy` must apply **both** migrations:
   - `20261121034707_init`
   - `20261121034824_constraints` (runs `CREATE EXTENSION IF NOT EXISTS btree_gist;`)
3. **Important:** If the constraints migration fails on `CREATE EXTENSION btree_gist`, stop immediately and inform the orchestrator (D-03 fallback required).
4. Once started, confirm `https://<api>.onrender.com/api/health` returns `200` with `{"status":"ok","db":"ok","jobsEnabled":true,...}`.

### Step 3 — Seed Production Database Once from Your Local PC (PowerShell)
1. In Render Dashboard → `emobility-db` → **Connect**, copy the **External Database URL**.
2. In a local PowerShell terminal at the repo root, run:
   ```powershell
   $env:DATABASE_URL="<external-db-url>"
   $env:SEED_PASSWORD="<same-seed-password-as-Render>"
   npm run db:seed -w backend
   Remove-Item Env:DATABASE_URL, Env:SEED_PASSWORD
   ```
3. Confirm the output prints the summary lines (`hub: 5`, `hub_threshold: 5`, `setting: 1`, `user: 22`, `private_ev: 5`, `parking_space: 585`, `charging_point: 60`, `rental_vehicle: 300`).
4. Because `seed.ts` is idempotent and preserves live state, re-running it is safe.

### Step 4 — Deploy Frontend on Vercel
1. In the Vercel Dashboard, click **Add New… → Project** and import this repository.
2. Set **Root Directory** to `frontend`.
3. Under **Environment Variables**, add:
   - `VITE_API_URL` = `https://<api>.onrender.com/api`
4. Click **Deploy** and note the assigned production domain `https://<project>.vercel.app`.

### Step 5 — Update `CORS_ORIGIN` on Render
1. Return to Render Dashboard → `smart-emobility-api` → **Environment**.
2. Set `CORS_ORIGIN` to the comma-separated list of allowed origins:
   ```text
   https://<project>.vercel.app,http://localhost:5173
   ```
   (Add any Vercel preview URL if testing a preview deployment.)
3. Save changes and allow Render to redeploy `smart-emobility-api`.

### Step 6 — Run the Smoke Verification Script
From your local terminal at the repo root, run:
```powershell
npm run smoke -- --api https://<api>.onrender.com --web https://<project>.vercel.app
```
All 5 checks must report `PASS`:
- `GET /api/health` (`200`, `db=ok`, `jobsEnabled=true`)
- `GET /api/hubs` without token (`401` in CONTRACTS §0 error shape)
- `OPTIONS /api/hubs` CORS preflight (`Access-Control-Allow-Origin` matches `https://<project>.vercel.app`)
- `GET https://<project>.vercel.app/` (`200` HTML)
- `GET https://<project>.vercel.app/app/hubs` (`200` HTML via SPA rewrite)

### Step 7 — Mobile & Browser Check
Open `https://<project>.vercel.app` on a phone (or 360 px viewport):
- Opening `/app/hubs` logged out redirects to `/login`.
- Once logged in (via the auth module or a seeded token), the 5 Hubs load and poll every 5 s.

---

## 3. Environment Variables Reference

### Backend (`smart-emobility-api` on Render)

| Variable | Production Value / Source | Purpose |
|---|---|---|
| `NODE_ENV` | `production` (`render.yaml`) | Enforces required secrets (`JWT_SECRET`, `SEED_PASSWORD`). |
| `PORT` | `3000` (default / Render injected) | HTTP listening port. |
| `DATABASE_URL` | From `emobility-db` (`render.yaml`) | Internal Postgres connection string. |
| `JWT_SECRET` | Auto-generated (`render.yaml`) | Signing secret for HS256 JWT tokens. |
| `JWT_EXPIRES_IN` | `8h` (default) | JWT lifetime. |
| `TELEMETRY_KEY` | Auto-generated (`render.yaml`) | Shared key for `POST /api/telemetry` (`X-Telemetry-Key`). |
| `CORS_ORIGIN` | `https://<project>.vercel.app,http://localhost:5173` | Comma-separated list of allowed browser origins. |
| `SEED_PASSWORD` | Manual secret (`sync: false`) | Password hashed (bcrypt cost 10) for seeded accounts. |
| `JOBS_ENABLED` | `true` (`render.yaml`) | Starts in-process background jobs (`telemetry.generate`, etc.). |
| `DEMO_TIME_SCALE` | `1` (`render.yaml`) | Speed multiplier for telemetry battery drain/charge rates. |
| `FAULT_PROBABILITY` | `0` (default) | Per-tick random fault probability (keep `0` for deterministic demo). |

### Frontend (Vercel)

| Variable | Production Value | Purpose |
|---|---|---|
| `VITE_API_URL` | `https://<api>.onrender.com/api` | Base API URL used by `frontend/src/lib/api.ts`. |

---

## 4. Redeploying

- **Automatic:** Pushing or merging to `main` triggers an automatic deploy on both Render (`smart-emobility-api`) and Vercel (`frontend`).
- **Database migrations:** On every Render container boot, `CMD` runs `npx prisma migrate deploy && node dist/server.js`, applying any new committed migrations automatically before the server starts.
- **Manual redeploy:** In Render → `smart-emobility-api` → **Manual Deploy → Deploy latest commit**; in Vercel → **Deployments → Redeploy**.

---

## 5. Known Limits & Operational Notes

1. **Single Backend Instance (D-02):**
   - Background jobs (`telemetry.generate`, `reservations.tick`, `charging.schedule`, `monitoring.evaluate`) run in-process via `core/scheduler.ts`.
   - **Never** increase `numInstances` above `1` or enable horizontal autoscaling.
2. **Render Free Web Service Sleep (SPEC §10 Q3):**
   - Render's free web tier spins down after ~15 minutes of no inbound HTTP traffic.
   - While asleep, in-process background jobs pause. When woken up (first request takes ~30–60 s cold start), Hubs will briefly show `DEGRADED` (`lastTelemetryAt` older than 15 s) until the next `telemetry.generate` tick (≤ 5 s) updates `lastTelemetryAt`.
   - **Before the live demo:** Open the site or hit `/api/health` 2–3 minutes ahead of time (or upgrade the web service for demo week).
3. **Render Free PostgreSQL Expiry (30-Day Limit):**
   - Render free PostgreSQL databases expire **30 days** after creation (after expiry, Render gives a 14-day grace period before deletion unless upgraded).
   - **Expiry check:** If created on **2026-11-23**, the database expires on **2026-12-23** — which safely covers the final submission and demo date (**2026-12-09**). Record the actual creation and expiry dates once created:
     - Created: `<YYYY-MM-DD>`
     - Expires (+30 days): `<YYYY-MM-DD>`
