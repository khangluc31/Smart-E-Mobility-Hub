// Minimal config for the skeleton. Full business config (SPEC §3) arrives in T-03.

export const config = {
  PORT: parseInt(process.env['PORT'] ?? '3000', 10),
  DATABASE_URL: process.env['DATABASE_URL'] ?? '',
  CORS_ORIGIN: process.env['CORS_ORIGIN'] ?? 'http://localhost:5173',
  JOBS_ENABLED: process.env['JOBS_ENABLED'] === 'true',
  NODE_ENV: process.env['NODE_ENV'] ?? 'development',
} as const;
