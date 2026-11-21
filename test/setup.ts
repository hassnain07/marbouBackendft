import { execSync } from 'child_process';
import dotenv from 'dotenv';
dotenv.config();

// Point to test DB
const base = process.env.DATABASE_URL ?? '';
const testUrl = base.replace(/\/marbou(\?|$)/, '/marbou_test$1');
process.env.DATABASE_URL = testUrl;

export async function setup() {
  if (!testUrl || testUrl === base) {
    throw new Error('Could not derive marbou_test DATABASE_URL from: ' + base);
  }

  // Verify connectivity
  try {
    execSync(`node node_modules/prisma/build/index.js migrate deploy`, {
      stdio: 'pipe',
      env: { ...process.env, DATABASE_URL: testUrl },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Test DB migration failed. Is the DB running? Run: npm run test:setup\n${msg}`);
  }
}

export async function teardown() {
  // nothing
}
