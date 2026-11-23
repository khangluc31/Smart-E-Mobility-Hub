// Deployment smoke test (T-08, ARCHITECTURE §14).
// Usage: npm run smoke -- --api <backend url> [--web <vercel url>]
// Prints PASS/FAIL per check and exits 1 if any check fails. No secrets required.

interface CliOptions {
  apiUrl: string;
  webUrl: string | null;
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

function parseArgs(argv: string[]): CliOptions {
  let apiUrl: string | undefined;
  let webUrl: string | undefined;
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--api') {
      apiUrl = argv[++i];
    } else if (arg?.startsWith('--api=')) {
      apiUrl = arg.slice('--api='.length);
    } else if (arg === '--web') {
      webUrl = argv[++i];
    } else if (arg?.startsWith('--web=')) {
      webUrl = arg.slice('--web='.length);
    } else if (arg && !arg.startsWith('-')) {
      positional.push(arg);
    }
  }

  // Fallback for PowerShell npm run where `--` is consumed by PowerShell and npm parses flags into npm_config_*.
  const env = process.env;
  if (!apiUrl && typeof env['npm_config_api'] === 'string') {
    if (env['npm_config_api'] !== 'true') {
      apiUrl = env['npm_config_api'];
    } else if (positional.length > 0) {
      apiUrl = positional.shift();
    }
  }
  if (!webUrl && typeof env['npm_config_web'] === 'string') {
    if (env['npm_config_web'] !== 'true') {
      webUrl = env['npm_config_web'];
    } else if (positional.length > 0) {
      webUrl = positional.shift();
    }
  }
  if (!apiUrl && positional.length > 0) {
    apiUrl = positional.shift();
  }
  if (!webUrl && positional.length > 0) {
    webUrl = positional.shift();
  }

  if (!apiUrl || apiUrl.trim() === '') {
    console.error('Usage: npm run smoke -- --api <backend url> [--web <vercel url>]');
    process.exit(1);
  }

  return {
    apiUrl: stripTrailingSlash(apiUrl.trim()),
    webUrl: webUrl && webUrl.trim() !== '' ? stripTrailingSlash(webUrl.trim()) : null,
  };
}

interface CheckResult {
  name: string;
  passed: boolean;
  detail: string;
}

async function checkHealth(apiUrl: string): Promise<CheckResult> {
  const url = `${apiUrl}/api/health`;
  try {
    const res = await fetch(url);
    const body = (await res.json()) as Record<string, unknown>;
    const ok =
      res.status === 200 &&
      body['status'] === 'ok' &&
      body['db'] === 'ok' &&
      body['jobsEnabled'] === true;
    return {
      name: `GET /api/health`,
      passed: ok,
      detail: `status=${res.status} db=${String(body['db'])} jobsEnabled=${String(body['jobsEnabled'])}`,
    };
  } catch (err) {
    return {
      name: `GET /api/health`,
      passed: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

async function checkUnauthorizedHubs(apiUrl: string): Promise<CheckResult> {
  const url = `${apiUrl}/api/hubs`;
  try {
    const res = await fetch(url);
    const body = (await res.json()) as { error?: Record<string, unknown> };
    const errObj = body?.error;
    const hasShape =
      res.status === 401 &&
      typeof errObj === 'object' &&
      errObj !== null &&
      typeof errObj['code'] === 'string' &&
      typeof errObj['message'] === 'string' &&
      Array.isArray(errObj['nextActions']) &&
      errObj['nextActions'].length >= 1;
    return {
      name: `GET /api/hubs (no token -> 401 CONTRACTS §0 shape)`,
      passed: hasShape,
      detail: `status=${res.status} code=${String(errObj?.['code'])} nextActions=${Array.isArray(errObj?.['nextActions']) ? errObj['nextActions'].length : 0}`,
    };
  } catch (err) {
    return {
      name: `GET /api/hubs (no token -> 401 CONTRACTS §0 shape)`,
      passed: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

async function checkCorsPreflight(apiUrl: string, origin: string): Promise<CheckResult> {
  const url = `${apiUrl}/api/hubs`;
  try {
    const res = await fetch(url, {
      method: 'OPTIONS',
      headers: {
        Origin: origin,
        'Access-Control-Request-Method': 'GET',
      },
    });
    const allowOrigin = res.headers.get('access-control-allow-origin');
    const ok = allowOrigin === origin;
    return {
      name: `OPTIONS /api/hubs (Origin: ${origin})`,
      passed: ok,
      detail: `Access-Control-Allow-Origin=${String(allowOrigin)}`,
    };
  } catch (err) {
    return {
      name: `OPTIONS /api/hubs (Origin: ${origin})`,
      passed: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

async function checkWebHtml(webUrl: string, path: string): Promise<CheckResult> {
  const url = `${webUrl}${path}`;
  try {
    const res = await fetch(url);
    const contentType = res.headers.get('content-type') ?? '';
    const text = await res.text();
    const isHtml =
      contentType.toLowerCase().includes('text/html') ||
      text.toLowerCase().includes('<!doctype html') ||
      text.toLowerCase().includes('<html');
    const ok = res.status === 200 && isHtml;
    return {
      name: `GET ${url}`,
      passed: ok,
      detail: `status=${res.status} content-type=${contentType}`,
    };
  } catch (err) {
    return {
      name: `GET ${url}`,
      passed: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const corsOrigin = opts.webUrl ?? 'http://localhost:5173';

  const results: CheckResult[] = [];
  results.push(await checkHealth(opts.apiUrl));
  results.push(await checkUnauthorizedHubs(opts.apiUrl));
  results.push(await checkCorsPreflight(opts.apiUrl, corsOrigin));

  if (opts.webUrl) {
    results.push(await checkWebHtml(opts.webUrl, '/'));
    results.push(await checkWebHtml(opts.webUrl, '/app/hubs'));
  }

  let failed = 0;
  for (const r of results) {
    const tag = r.passed ? 'PASS' : 'FAIL';
    console.log(`${tag}  ${r.name} — ${r.detail}`);
    if (!r.passed) failed += 1;
  }

  if (failed > 0) {
    console.error(`Smoke check failed: ${failed}/${results.length} checks failed.`);
    process.exit(1);
  }

  console.log(`Smoke check passed: ${results.length}/${results.length} checks passed.`);
}

main().catch((err: unknown) => {
  console.error('FAIL  smoke script crashed:', err);
  process.exit(1);
});
