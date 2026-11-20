// Runs once before the whole test suite: applies every migration to the test
// database so tests (health, constraints) run against the real schema with no
// manual migrate step. Uses the Prisma CLI already in devDependencies — no new package.
import { execSync } from 'node:child_process';

// The test DB, matching vitest.config.ts and .env.test.example. Hardcoded here
// (not read from DATABASE_URL) so a stray dev DATABASE_URL can never migrate the dev DB.
const TEST_DATABASE_URL = 'postgresql://postgres:postgres@localhost:5432/emobility_test';

export default function setup(): void {
  execSync('npx prisma migrate deploy', {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
  });
}
