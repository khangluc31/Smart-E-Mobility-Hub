// External mock sensor CLI (ARCHITECTURE §7.4, NFR-24, NFR-25, T-06 AC-13).
// Posts telemetry packets in the exact TelemetryPacket format to POST /api/telemetry.
// Usage:
//   npm run mock-sensor -- --hub metro [--url http://localhost:3000] [--vehicle RV-M-001:55] [--stale] [--malformed]

import path from 'node:path';
import dotenv from 'dotenv';
dotenv.config({ path: path.resolve(__dirname, '../.env') });

import { loadConfig } from '../src/core/config';
import type { TelemetryPacket, TelemetryVehicleItem } from '../src/types/telemetry';

const config = loadConfig(process.env);

interface CliOptions {
  hubId: string;
  baseUrl: string;
  stale: boolean;
  malformed: boolean;
  once: boolean;
  count?: number;
  vehicles: TelemetryVehicleItem[];
}

function parseVehicleSpec(spec: string): TelemetryVehicleItem {
  const [id, pctStr] = spec.split(':');
  const batteryPct = Number(pctStr);
  if (!id || !Number.isFinite(batteryPct)) {
    throw new Error(`Invalid --vehicle "${spec}". Expected <id>:<batteryPct> (e.g. RV-M-001:55).`);
  }
  return { id, batteryPct };
}

function parseArgs(argv: string[]): CliOptions {
  let hubId = '';
  let baseUrl = 'http://localhost:3000';
  let stale = false;
  let malformed = false;
  let once = false;
  let count: number | undefined;
  const vehicles: TelemetryVehicleItem[] = [];
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--hub') {
      hubId = argv[++i] ?? '';
    } else if (arg === '--url') {
      baseUrl = (argv[++i] ?? baseUrl).replace(/\/+$/, '');
    } else if (arg === '--stale') {
      stale = true;
    } else if (arg === '--malformed') {
      malformed = true;
    } else if (arg === '--once') {
      once = true;
    } else if (arg === '--count') {
      const n = Number(argv[++i]);
      if (Number.isInteger(n) && n > 0) count = n;
    } else if (arg === '--vehicle') {
      vehicles.push(parseVehicleSpec(argv[++i] ?? ''));
    } else if (arg && !arg.startsWith('-')) {
      positional.push(arg);
    }
  }

  // Fallback for Windows PowerShell where a single `--` is consumed by PowerShell and npm parses flags into npm_config_*.
  const env = process.env;
  if (!stale && env['npm_config_stale'] === 'true') stale = true;
  if (!malformed && env['npm_config_malformed'] === 'true') malformed = true;
  if (!once && env['npm_config_once'] === 'true') once = true;
  if (typeof env['npm_config_url'] === 'string' && env['npm_config_url'] !== 'true') {
    baseUrl = env['npm_config_url'].replace(/\/+$/, '');
  }
  if (!hubId && typeof env['npm_config_hub'] === 'string') {
    if (env['npm_config_hub'] !== 'true') {
      hubId = env['npm_config_hub'];
    } else if (positional.length > 0) {
      hubId = positional.shift()!;
    }
  }
  if (typeof env['npm_config_vehicle'] === 'string' && env['npm_config_vehicle'] !== 'true') {
    vehicles.push(parseVehicleSpec(env['npm_config_vehicle']));
  }
  for (const pos of positional) {
    if (pos.includes(':')) {
      vehicles.push(parseVehicleSpec(pos));
    }
  }

  if (!hubId) {
    throw new Error('Missing required argument: --hub <hubId>');
  }

  return { hubId, baseUrl, stale, malformed, once, count, vehicles };
}

async function sendPacket(baseUrl: string, payload: unknown, label: string): Promise<number> {
  const endpoint = baseUrl.endsWith('/api')
    ? `${baseUrl}/telemetry`
    : `${baseUrl}/api/telemetry`;

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Telemetry-Key': config.TELEMETRY_KEY,
    },
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  console.log(`[mock-sensor] ${label} -> HTTP ${res.status} ${text}`);
  return res.status;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.malformed) {
    await sendPacket(
      opts.baseUrl,
      {
        hubId: opts.hubId,
        timestamp: 'not-an-iso-timestamp',
        source: 'MOCK_SENSOR',
        vehicles: [{ id: '', batteryPct: 150 }],
      },
      `malformed packet (hub=${opts.hubId})`,
    );
  }

  if (opts.stale) {
    // First send a fresh heartbeat so the Hub has a known lastTelemetryAt, then send one 60 s older.
    const freshNow = new Date();
    const freshPacket: TelemetryPacket = {
      hubId: opts.hubId,
      timestamp: freshNow.toISOString(),
      source: 'MOCK_SENSOR',
      vehicles: opts.vehicles,
    };
    await sendPacket(opts.baseUrl, freshPacket, `heartbeat packet (hub=${opts.hubId})`);

    const staleTime = new Date(freshNow.getTime() - 60_000);
    const stalePacket: TelemetryPacket = {
      hubId: opts.hubId,
      timestamp: staleTime.toISOString(),
      source: 'MOCK_SENSOR',
      vehicles: opts.vehicles,
    };
    await sendPacket(opts.baseUrl, stalePacket, `stale packet -60s (hub=${opts.hubId})`);
  }

  let sent = 0;
  const sendHeartbeat = async () => {
    const packet: TelemetryPacket = {
      hubId: opts.hubId,
      timestamp: new Date().toISOString(),
      source: 'MOCK_SENSOR',
      vehicles: opts.vehicles,
    };
    await sendPacket(opts.baseUrl, packet, `tick #${sent + 1} (hub=${opts.hubId})`);
    sent++;
  };

  await sendHeartbeat();

  if (opts.once || (opts.count !== undefined && sent >= opts.count)) {
    return;
  }

  const intervalMs = config.TELEMETRY_INTERVAL_SEC * 1000;
  const timer = setInterval(() => {
    void sendHeartbeat().then(() => {
      if (opts.count !== undefined && sent >= opts.count) {
        clearInterval(timer);
      }
    });
  }, intervalMs);
}

main().catch((err: unknown) => {
  console.error('[mock-sensor] fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
