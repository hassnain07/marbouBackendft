/**
 * Creates marbou_test DB if missing and runs prisma migrate deploy against it.
 * Run: npm run test:setup
 */
import { execSync } from 'child_process';
import dotenv from 'dotenv';
dotenv.config();

const base = process.env.DATABASE_URL ?? '';
if (!base) { console.error('DATABASE_URL not set'); process.exit(1); }

// Derive test URL
const testUrl = base.replace(/\/marbou(\?|$)/, '/marbou_test$1');

// Create DB via psql inside Docker (idempotent)
try {
  execSync(
    `docker exec marboubackend2-db-1 psql -U marbou -c "SELECT 'CREATE DATABASE marbou_test' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname='marbou_test')\\gexec"`,
    { stdio: 'inherit' },
  );
} catch {
  // If docker not available, try direct psql
  try {
    execSync(`psql "${base}" -c "CREATE DATABASE marbou_test" 2>/dev/null || true`, { stdio: 'inherit' });
  } catch {
    console.warn('Could not create marbou_test via docker or psql — assuming it exists');
  }
}

// Run migrations
console.log('Running prisma migrate deploy against marbou_test...');
execSync(`node node_modules/prisma/build/index.js migrate deploy`, {
  stdio: 'inherit',
  env: { ...process.env, DATABASE_URL: testUrl },
});

console.log('✅ Test DB ready');
