// Concurrent read latency + 20-way vehicle reservation race verifier (T-33, NFR-01/07, BR-10).
// Usage: npm run load-test -w backend -- --api http://localhost:3000 [--concurrency 50] [--race 20]

import 'dotenv/config';
import { randomUUID } from 'node:crypto';

interface CliOptions {
  apiUrl: string;
  concurrency: number;
  race: number;
  password: string;
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function parseArgs(argv: string[]): CliOptions {
  let apiUrl: string | undefined;
  let concurrencyRaw: string | undefined;
  let raceRaw: string | undefined;
  let password: string | undefined;
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--api') apiUrl = argv[++i];
    else if (arg?.startsWith('--api=')) apiUrl = arg.slice('--api='.length);
    else if (arg === '--concurrency') concurrencyRaw = argv[++i];
    else if (arg?.startsWith('--concurrency=')) concurrencyRaw = arg.slice('--concurrency='.length);
    else if (arg === '--race') raceRaw = argv[++i];
    else if (arg?.startsWith('--race=')) raceRaw = arg.slice('--race='.length);
    else if (arg === '--password') password = argv[++i];
    else if (arg?.startsWith('--password=')) password = arg.slice('--password='.length);
    else if (arg && !arg.startsWith('-')) positional.push(arg);
  }

  // Fallback for PowerShell npm run where `--` is consumed by PowerShell and npm parses flags into npm_config_*.
  const env = process.env;
  if (!apiUrl && typeof env['npm_config_api'] === 'string') {
    apiUrl = env['npm_config_api'] !== 'true' ? env['npm_config_api'] : positional.shift();
  }
  if (!concurrencyRaw && typeof env['npm_config_concurrency'] === 'string') {
    concurrencyRaw =
      env['npm_config_concurrency'] !== 'true' ? env['npm_config_concurrency'] : positional.shift();
  }
  if (!raceRaw && typeof env['npm_config_race'] === 'string') {
    raceRaw = env['npm_config_race'] !== 'true' ? env['npm_config_race'] : positional.shift();
  }
  if (!password && typeof env['npm_config_password'] === 'string') {
    password =
      env['npm_config_password'] !== 'true' ? env['npm_config_password'] : positional.shift();
  }
  if (!apiUrl && positional.length > 0) apiUrl = positional.shift();

  return {
    apiUrl: stripTrailingSlash((apiUrl && apiUrl.trim() !== '' ? apiUrl : 'http://localhost:3000').trim()),
    concurrency: parsePositiveInt(concurrencyRaw, 50),
    race: Math.min(20, parsePositiveInt(raceRaw, 20)),
    password: password ?? process.env['SEED_PASSWORD'] ?? 'password',
  };
}

interface HttpResult {
  status: number;
  ms: number;
  body: unknown;
}

async function requestJson(
  apiUrl: string,
  method: string,
  path: string,
  opts: { token?: string; body?: unknown; idempotencyKey?: string } = {},
): Promise<HttpResult> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;
  if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;

  const start = performance.now();
  const res = await fetch(`${apiUrl}${path}`, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  const ms = performance.now() - start;
  let body: unknown = null;
  try {
    body = text ? (JSON.parse(text) as unknown) : null;
  } catch {
    body = text;
  }
  return { status: res.status, ms, body };
}

async function login(apiUrl: string, identifier: string, password: string): Promise<string> {
  const res = await requestJson(apiUrl, 'POST', '/api/auth/login', {
    body: { identifier, password },
  });
  const obj = res.body as { token?: string } | null;
  if (res.status !== 200 || !obj?.token) {
    throw new Error(`Login failed for ${identifier} (status=${res.status})`);
  }
  return obj.token;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)] ?? 0;
}

function summariseLatency(name: string, results: HttpResult[]): {
  name: string;
  ok: number;
  total: number;
  p50: number;
  p95: number;
  max: number;
} {
  const times = results.map((r) => r.ms).sort((a, b) => a - b);
  const ok = results.filter((r) => r.status === 200).length;
  return {
    name,
    ok,
    total: results.length,
    p50: Math.round(percentile(times, 50)),
    p95: Math.round(percentile(times, 95)),
    max: Math.round(times[times.length - 1] ?? 0),
  };
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  console.log(`Load test target: ${opts.apiUrl} (concurrency=${opts.concurrency}, race=${opts.race})`);

  // Log in student1..student<race>
  const studentTokens: Array<{ id: string; token: string }> = [];
  for (let i = 1; i <= opts.race; i += 1) {
    const id = `student${i}`;
    const token = await login(opts.apiUrl, id, opts.password);
    studentTokens.push({ id, token });
  }
  const primaryToken = studentTokens[0]?.token;
  if (!primaryToken) throw new Error('No student token available');

  let failed = 0;

  // Test A: Concurrent reads (NFR-01 / NFR-07)
  const [hubResults, searchResults] = await Promise.all([
    Promise.all(
      Array.from({ length: opts.concurrency }, () =>
        requestJson(opts.apiUrl, 'GET', '/api/hubs', { token: primaryToken }),
      ),
    ),
    Promise.all(
      Array.from({ length: opts.concurrency }, () =>
        requestJson(opts.apiUrl, 'GET', '/api/vehicles/search?availableOnly=true', {
          token: primaryToken,
        }),
      ),
    ),
  ]);

  const hubsStats = summariseLatency('GET /api/hubs', hubResults);
  const searchStats = summariseLatency('GET /api/vehicles/search', searchResults);

  for (const s of [hubsStats, searchStats]) {
    const pass = s.ok === s.total;
    if (!pass) failed += 1;
    console.log(
      `${pass ? 'PASS' : 'FAIL'}  Test A ${s.name} — ${s.ok}/${s.total} HTTP 200 | p50=${s.p50}ms p95=${s.p95}ms max=${s.max}ms`,
    );
  }

  // Test B: Concurrent booking race (BR-10) using distinct student1..student<race>
  const vehiclesRes = await requestJson(
    opts.apiUrl,
    'GET',
    '/api/vehicles/search?availableOnly=true',
    { token: primaryToken },
  );
  const vehicles = Array.isArray(vehiclesRes.body)
    ? (vehiclesRes.body as Array<{ id: string }>)
    : [];
  const targetVehicle = vehicles[0];
  if (!targetVehicle) {
    throw new Error('No available rental vehicle found for booking race test');
  }

  let winner: { reservationId: string; token: string; student: string } | null = null;

  try {
    const raceResults = await Promise.all(
      studentTokens.map(async ({ id, token }) => {
        const res = await requestJson(opts.apiUrl, 'POST', '/api/vehicle-reservations', {
          token,
          body: { vehicleId: targetVehicle.id },
          idempotencyKey: randomUUID(),
        });
        return { student: id, token, res };
      }),
    );

    const wins = raceResults.filter((r) => r.res.status === 201);
    const conflicts = raceResults.filter((r) => r.res.status === 409);
    const serverErrors = raceResults.filter((r) => r.res.status >= 500);

    if (wins[0]) {
      const body = wins[0].res.body as { id?: string } | null;
      if (body?.id) {
        winner = { reservationId: body.id, token: wins[0].token, student: wins[0].student };
      }
    }

    const racePassed =
      wins.length === 1 && conflicts.length === opts.race - 1 && serverErrors.length === 0;
    if (!racePassed) failed += 1;

    console.log(
      `${racePassed ? 'PASS' : 'FAIL'}  Test B ${opts.race}-way booking race (${targetVehicle.id}) — 201=${wins.length} 409=${conflicts.length} 5xx=${serverErrors.length}${winner ? ` (winner=${winner.student})` : ''}`,
    );
  } finally {
    if (winner) {
      const cancelRes = await requestJson(
        opts.apiUrl,
        'POST',
        `/api/vehicle-reservations/${encodeURIComponent(winner.reservationId)}/cancel`,
        { token: winner.token },
      );
      if (cancelRes.status !== 200) {
        console.error(
          `WARN  Failed to clean up winning reservation ${winner.reservationId} (status=${cancelRes.status})`,
        );
      } else {
        console.log(`CLEAN Cancelled winning reservation ${winner.reservationId}`);
      }
    }
  }

  if (failed > 0) {
    console.error(`Load test failed: ${failed} check(s) failed.`);
    process.exit(1);
  }
  console.log('Load test passed: all read latency and concurrency race assertions passed.');
}

main().catch((err: unknown) => {
  console.error('FAIL  load-test crashed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
