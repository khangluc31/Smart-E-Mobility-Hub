import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
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
      // Thresholds come in T-03
    },
  },
});
