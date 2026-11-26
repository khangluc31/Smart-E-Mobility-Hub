// Guided end-to-end showcase script (T-33).
// Usage: npm run demo -w backend -- --api http://localhost:3000 [--password <seed-password>]
// Exercises Student, Operator, and What-if Simulation flows, cleans up student bookings,
// prints PASS/FAIL per step, and exits 1 on any failure.

import 'dotenv/config';
import { randomUUID } from 'node:crypto';

interface CliOptions {
  apiUrl: string;
  password: string;
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

function parseArgs(argv: string[]): CliOptions {
  let apiUrl: string | undefined;
  let password: string | undefined;
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--api') apiUrl = argv[++i];
    else if (arg?.startsWith('--api=')) apiUrl = arg.slice('--api='.length);
    else if (arg === '--password') password = argv[++i];
    else if (arg?.startsWith('--password=')) password = arg.slice('--password='.length);
    else if (arg && !arg.startsWith('-')) positional.push(arg);
  }

  // Fallback for PowerShell npm run where `--` is consumed by PowerShell and npm parses flags into npm_config_*.
  const env = process.env;
  if (!apiUrl && typeof env['npm_config_api'] === 'string') {
    apiUrl = env['npm_config_api'] !== 'true' ? env['npm_config_api'] : positional.shift();
  }
  if (!password && typeof env['npm_config_password'] === 'string') {
    password =
      env['npm_config_password'] !== 'true' ? env['npm_config_password'] : positional.shift();
  }
  if (!apiUrl && positional.length > 0) apiUrl = positional.shift();

  return {
    apiUrl: stripTrailingSlash((apiUrl && apiUrl.trim() !== '' ? apiUrl : 'http://localhost:3000').trim()),
    password: password ?? process.env['SEED_PASSWORD'] ?? 'password',
  };
}

interface HttpResult {
  status: number;
  body: unknown;
}

async function req(
  apiUrl: string,
  method: string,
  path: string,
  opts: { token?: string; body?: unknown; idempotencyKey?: string } = {},
): Promise<HttpResult> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;
  if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;

  const res = await fetch(`${apiUrl}${path}`, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? (JSON.parse(text) as unknown) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface StepResult {
  name: string;
  passed: boolean;
  detail: string;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const results: StepResult[] = [];

  let studentToken = '';
  let operatorToken = '';

  // Cleanup trackers so live seeded state stays clean even if a step fails
  let openVehicleResId: string | null = null;
  let openVehicleResState: 'CONFIRMED' | 'ACTIVE' | null = null;
  let openVehicleReturnHubId: string | null = null;
  let openParkingResId: string | null = null;
  let openChargingReqId: string | null = null;

  async function runStep(name: string, fn: () => Promise<string>): Promise<void> {
    try {
      const detail = await fn();
      results.push({ name, passed: true, detail });
      console.log(`PASS  ${name} — ${detail}`);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      results.push({ name, passed: false, detail });
      console.log(`FAIL  ${name} — ${detail}`);
    }
  }

  try {
    // Step 1: Health check
    await runStep('1. GET /api/health', async () => {
      const r = await req(opts.apiUrl, 'GET', '/api/health');
      const b = r.body as Record<string, unknown> | null;
      if (r.status !== 200 || b?.['status'] !== 'ok' || b?.['db'] !== 'ok') {
        throw new Error(`Unexpected health response: status=${r.status} body=${JSON.stringify(b)}`);
      }
      return `status=ok db=ok jobsEnabled=${String(b['jobsEnabled'])}`;
    });

    // Step 2: Login student1 & operator1
    await runStep('2. Login student1 & operator1', async () => {
      const st = await req(opts.apiUrl, 'POST', '/api/auth/login', {
        body: { identifier: 'student1', password: opts.password },
      });
      const op = await req(opts.apiUrl, 'POST', '/api/auth/login', {
        body: { identifier: 'operator1', password: opts.password },
      });
      const stBody = st.body as { token?: string } | null;
      const opBody = op.body as { token?: string } | null;
      if (st.status !== 200 || !stBody?.token) {
        throw new Error(`student1 login failed: status=${st.status}`);
      }
      if (op.status !== 200 || !opBody?.token) {
        throw new Error(`operator1 login failed: status=${op.status}`);
      }
      studentToken = stBody.token;
      operatorToken = opBody.token;
      return 'both JWT tokens issued';
    });

    // Step 3: Student Hubs + Search + Reserve -> Pick up -> Return
    await runStep('3. Student rental lifecycle (hubs -> search -> reserve -> pickup -> return)', async () => {
      const hubsRes = await req(opts.apiUrl, 'GET', '/api/hubs', { token: studentToken });
      const hubs = Array.isArray(hubsRes.body) ? (hubsRes.body as Array<{ id: string }>) : [];
      if (hubsRes.status !== 200 || hubs.length !== 5) {
        throw new Error(`Expected 5 hubs, got status=${hubsRes.status} count=${hubs.length}`);
      }

      const searchRes = await req(
        opts.apiUrl,
        'GET',
        '/api/vehicles/search?availableOnly=true',
        { token: studentToken },
      );
      const vehicles = Array.isArray(searchRes.body)
        ? (searchRes.body as Array<{ id: string; hubId: string }>)
        : [];
      const chosen = vehicles[0];
      if (searchRes.status !== 200 || !chosen) {
        throw new Error(`No available vehicle found (status=${searchRes.status})`);
      }

      const resv = await req(opts.apiUrl, 'POST', '/api/vehicle-reservations', {
        token: studentToken,
        body: { vehicleId: chosen.id },
        idempotencyKey: randomUUID(),
      });
      const resvBody = resv.body as { id?: string } | null;
      if (resv.status !== 201 || !resvBody?.id) {
        throw new Error(`Reserve failed: status=${resv.status} ${JSON.stringify(resv.body)}`);
      }
      openVehicleResId = resvBody.id;
      openVehicleResState = 'CONFIRMED';
      openVehicleReturnHubId = chosen.hubId;

      const pickup = await req(
        opts.apiUrl,
        'POST',
        `/api/vehicle-reservations/${encodeURIComponent(openVehicleResId)}/pickup`,
        { token: studentToken },
      );
      if (pickup.status !== 200) {
        throw new Error(`Pickup failed: status=${pickup.status} ${JSON.stringify(pickup.body)}`);
      }
      openVehicleResState = 'ACTIVE';

      const ret = await req(
        opts.apiUrl,
        'POST',
        `/api/vehicle-reservations/${encodeURIComponent(openVehicleResId)}/return`,
        { token: studentToken, body: { hubId: chosen.hubId } },
      );
      if (ret.status !== 200) {
        throw new Error(`Return failed: status=${ret.status} ${JSON.stringify(ret.body)}`);
      }
      openVehicleResId = null;
      openVehicleResState = null;
      return `hubs=5 vehicle=${chosen.id} hub=${chosen.hubId} completed cleanly`;
    });

    // Step 4: Student Private EV combined parking + charging booking, then cancel both
    await runStep('4. Student Private EV combined parking + charging booking & cleanup', async () => {
      const evsRes = await req(opts.apiUrl, 'GET', '/api/private-evs', { token: studentToken });
      const evs = Array.isArray(evsRes.body)
        ? (evsRes.body as Array<{ id: string; batteryPct: number }>)
        : [];
      const ev = evs.find((e) => e.batteryPct < 95) ?? evs[0];
      if (evsRes.status !== 200 || !ev) {
        throw new Error(`No Private EV found for student1 (status=${evsRes.status})`);
      }

      const now = Date.now();
      const windowStart = new Date(now + 30 * 60_000).toISOString();
      const windowEnd = new Date(now + 150 * 60_000).toISOString();
      const targetPct = Math.min(100, Math.max(ev.batteryPct + 10, 80));

      const comb = await req(
        opts.apiUrl,
        'POST',
        `/api/private-evs/${encodeURIComponent(ev.id)}/book-parking-charging`,
        {
          token: studentToken,
          body: { hubId: 'campus-a', windowStart, windowEnd, targetPct },
          idempotencyKey: randomUUID(),
        },
      );
      const combBody = comb.body as {
        bookingGroupId?: string;
        parkingReservation?: { id?: string };
        chargingRequest?: { id?: string };
      } | null;
      if (
        comb.status !== 201 ||
        !combBody?.parkingReservation?.id ||
        !combBody?.chargingRequest?.id
      ) {
        throw new Error(`Combined booking failed: status=${comb.status} ${JSON.stringify(comb.body)}`);
      }
      openParkingResId = combBody.parkingReservation.id;
      openChargingReqId = combBody.chargingRequest.id;

      const cPark = await req(
        opts.apiUrl,
        'POST',
        `/api/parking-reservations/${encodeURIComponent(openParkingResId)}/cancel`,
        { token: studentToken },
      );
      if (cPark.status !== 200) {
        throw new Error(`Cancel parking failed: status=${cPark.status}`);
      }
      openParkingResId = null;

      const cChg = await req(
        opts.apiUrl,
        'POST',
        `/api/charging/requests/${encodeURIComponent(openChargingReqId)}/cancel`,
        { token: studentToken },
      );
      if (cChg.status !== 200) {
        throw new Error(`Cancel charging failed: status=${cChg.status}`);
      }
      openChargingReqId = null;

      return `ev=${ev.id} group=${combBody.bookingGroupId ?? 'ok'} booked & cancelled`;
    });

    // Step 5: Operator dashboard, alerts, redistribution imbalances
    await runStep('5. Operator dashboard, alerts & redistribution imbalances', async () => {
      const [dash, alerts, imb] = await Promise.all([
        req(opts.apiUrl, 'GET', '/api/ops/dashboard', { token: operatorToken }),
        req(opts.apiUrl, 'GET', '/api/ops/alerts', { token: operatorToken }),
        req(opts.apiUrl, 'GET', '/api/ops/redistribution/imbalances', { token: operatorToken }),
      ]);
      if (dash.status !== 200 || alerts.status !== 200 || imb.status !== 200) {
        throw new Error(
          `Operator reads failed: dashboard=${dash.status} alerts=${alerts.status} imbalances=${imb.status}`,
        );
      }
      const dashBody = dash.body as { hubs?: unknown[] } | null;
      const alertsBody = alerts.body as { items?: unknown[] } | null;
      const imbBody = Array.isArray(imb.body) ? imb.body : [];
      return `hubs=${dashBody?.hubs?.length ?? 0} alerts=${alertsBody?.items?.length ?? 0} imbalances=${imbBody.length}`;
    });

    // Step 6: Operator What-if Simulation (BR-11, 0 live writes)
    await runStep('6. Operator What-if Simulation (templates -> scenario -> run -> preview -> dismiss)', async () => {
      const tplRes = await req(opts.apiUrl, 'GET', '/api/ops/simulation/templates', {
        token: operatorToken,
      });
      const templates = Array.isArray(tplRes.body) ? tplRes.body : [];
      if (tplRes.status !== 200 || templates.length !== 5) {
        throw new Error(`Expected 5 templates, got status=${tplRes.status} count=${templates.length}`);
      }

      const scRes = await req(opts.apiUrl, 'POST', '/api/ops/simulation/scenarios', {
        token: operatorToken,
        body: {
          name: `Demo Showcase ${new Date().toISOString().slice(11, 19)}`,
          horizonH: 4,
          seed: 2026,
          conditions: [
            { template: 'METRO_SURGE', params: { multiplierPct: 200, startHour: 0, durationH: 4 } },
            { template: 'HUB_PARKING_FULL', params: { hubId: 'campus-a' } },
          ],
        },
      });
      const scBody = scRes.body as { id?: string } | null;
      if (scRes.status !== 201 || !scBody?.id) {
        throw new Error(`Create scenario failed: status=${scRes.status} ${JSON.stringify(scRes.body)}`);
      }

      const runRes = await req(opts.apiUrl, 'POST', '/api/ops/simulation/runs', {
        token: operatorToken,
        body: { scenarioId: scBody.id },
      });
      const runBody = runRes.body as { id?: string } | null;
      if (runRes.status !== 202 || !runBody?.id) {
        throw new Error(`Start run failed: status=${runRes.status} ${JSON.stringify(runRes.body)}`);
      }

      interface SimRunPollDetail {
        run?: { status?: string; durationMs?: number | null };
        recommendations?: Array<{ id: string }>;
      }
      let detail: SimRunPollDetail | null = null;
      for (let i = 0; i < 60; i += 1) {
        const poll = await req(
          opts.apiUrl,
          'GET',
          `/api/ops/simulation/runs/${encodeURIComponent(runBody.id)}`,
          { token: operatorToken },
        );
        const body = poll.body as SimRunPollDetail | null;
        if (poll.status === 200 && body?.run?.status && body.run.status !== 'RUNNING') {
          detail = body;
          break;
        }
        await sleep(250);
      }
      if (!detail || detail.run?.status !== 'COMPLETED') {
        throw new Error(`Simulation run did not complete: status=${detail?.run?.status ?? 'timeout'}`);
      }

      const firstRec = detail.recommendations?.[0];
      if (!firstRec) {
        return `templates=5 run=COMPLETED (${detail.run.durationMs ?? 0}ms) recs=0 (balanced)`;
      }

      const prev = await req(
        opts.apiUrl,
        'GET',
        `/api/ops/simulation/recommendations/${encodeURIComponent(firstRec.id)}/preview`,
        { token: operatorToken },
      );
      if (prev.status !== 200) {
        throw new Error(`Preview failed: status=${prev.status}`);
      }

      const dism = await req(
        opts.apiUrl,
        'POST',
        `/api/ops/simulation/recommendations/${encodeURIComponent(firstRec.id)}/dismiss`,
        { token: operatorToken },
      );
      const dismBody = dism.body as { status?: string } | null;
      if (dism.status !== 200 || dismBody?.status !== 'DISMISSED') {
        throw new Error(`Dismiss failed: status=${dism.status}`);
      }
      return `templates=5 run=COMPLETED (${detail.run.durationMs ?? 0}ms) recs=${detail.recommendations?.length ?? 0} preview+dismiss=OK (0 live writes)`;
    });
  } finally {
    // Best-effort cleanup of any student booking left open by an early failure
    if (studentToken && openVehicleResId) {
      if (openVehicleResState === 'CONFIRMED') {
        await req(
          opts.apiUrl,
          'POST',
          `/api/vehicle-reservations/${encodeURIComponent(openVehicleResId)}/cancel`,
          { token: studentToken },
        );
      } else if (openVehicleResState === 'ACTIVE' && openVehicleReturnHubId) {
        await req(
          opts.apiUrl,
          'POST',
          `/api/vehicle-reservations/${encodeURIComponent(openVehicleResId)}/return`,
          { token: studentToken, body: { hubId: openVehicleReturnHubId } },
        );
      }
    }
    if (studentToken && openParkingResId) {
      await req(
        opts.apiUrl,
        'POST',
        `/api/parking-reservations/${encodeURIComponent(openParkingResId)}/cancel`,
        { token: studentToken },
      );
    }
    if (studentToken && openChargingReqId) {
      await req(
        opts.apiUrl,
        'POST',
        `/api/charging/requests/${encodeURIComponent(openChargingReqId)}/cancel`,
        { token: studentToken },
      );
    }
  }

  const failed = results.filter((r) => !r.passed).length;
  if (failed > 0) {
    console.error(`Demo showcase failed: ${failed}/${results.length} steps failed.`);
    process.exit(1);
  }
  console.log(`Demo showcase passed: ${results.length}/${results.length} steps passed.`);
}

main().catch((err: unknown) => {
  console.error('FAIL  demo script crashed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
