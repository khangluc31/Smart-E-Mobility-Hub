import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    globalSetup: ['tests/globalSetup.ts'],
    fileParallelism: false,
    env: {
      DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/emobility_test',
      PORT: '3001',
      CORS_ORIGIN: 'http://localhost:5173',
      JOBS_ENABLED: 'false',
      JWT_SECRET: 'test-secret',
      TELEMETRY_KEY: 'test-telemetry-key',
      NODE_ENV: 'test',
    },
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      thresholds: {
        'src/core/**': { lines: 70 },
        'src/modules/auth/**': { lines: 70 },
        'src/modules/charging/**': { lines: 70 },
        'src/modules/hubs/**': { lines: 70 },
        'src/modules/incidents/**': { lines: 70 },
        'src/modules/notifications/**': { lines: 70 },
        'src/modules/private-evs/**': { lines: 70 },
        'src/modules/reservations/**': { lines: 70 },
        'src/telemetry/**': { lines: 70 },
      },
    },
  },
});
