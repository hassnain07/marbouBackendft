/**
 * Creates marbou_test DB if missing and runs prisma migrate deploy against it.
 * Run: npm run test:setup
 *
 * Strategy (in order):
 *  1. docker compose exec -T db psql -U marbou ...
 *  2. psql with DATABASE_URL directly
 *  3. Print manual instruction and exit 1
 */
import { execSync } from 'child_process';
import dotenv from 'dotenv';
dotenv.config();

const base = process.env.DATABASE_URL ?? '';
if (!base) { console.error('DATABASE_URL not set'); process.exit(1); }

const testUrl = base.replace(/\/marbou(\?|$)/, '/marbou_test$1');
if (testUrl === base) {
  console.error('Could not derive marbou_test URL from DATABASE_URL:', base);
  process.exit(1);
}

const createSql = `SELECT 'CREATE DATABASE marbou_test' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname='marbou_test')\\gexec`;

let dbCreated = false;

// Strategy 1: docker compose exec -T (no hardcoded container name)
try {
  execSync(`docker compose exec -T db psql -U marbou -c "${createSql}"`, { stdio: 'inherit' });
  dbCreated = true;
  console.log('✅ DB created/verified via docker compose');
} catch {
  console.warn('docker compose exec failed, trying direct psql...');
}

// Strategy 2: direct psql with DATABASE_URL
if (!dbCreated) {
  try {
    execSync(`psql "${base}" -c "SELECT 'CREATE DATABASE marbou_test' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname='marbou_test')\\gexec"`, {
      stdio: 'inherit',
    });
    dbCreated = true;
    console.log('✅ DB created/verified via direct psql');
  } catch {
    console.warn('Direct psql also failed.');
  }
}

// Strategy 3: manual instruction
if (!dbCreated) {
  console.error(`
❌ Could not create marbou_test automatically.

Please run manually:
  docker compose exec db psql -U marbou -c "CREATE DATABASE marbou_test;"
  # or if using a local PostgreSQL:
  psql "${base}" -c "CREATE DATABASE marbou_test;"

Then re-run: npm run test:setup
`);
  process.exit(1);
}

// Run migrations against test DB
console.log('Running prisma migrate deploy against marbou_test...');
execSync(`node node_modules/prisma/build/index.js migrate deploy`, {
  stdio: 'inherit',
  env: { ...process.env, DATABASE_URL: testUrl },
});

console.log('✅ Test DB ready');
