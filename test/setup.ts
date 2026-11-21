import { PrismaClient } from '@prisma/client';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.test' });
// fallback to .env if .env.test missing
dotenv.config();

// Override DB to test DB
if (!process.env.DATABASE_URL?.includes('marbou_test')) {
  process.env.DATABASE_URL = process.env.DATABASE_URL?.replace('/marbou?', '/marbou_test?')
    .replace('/marbou\n', '/marbou_test\n')
    ?? process.env.DATABASE_URL;
  // If still no _test suffix, append it
  if (!process.env.DATABASE_URL?.includes('marbou_test')) {
    process.env.DATABASE_URL = process.env.DATABASE_URL?.replace(
      /\/marbou([^_]|$)/,
      '/marbou_test$1',
    );
  }
}

const db = new PrismaClient();

beforeAll(async () => {
  // Create test DB if needed and apply migrations
  try {
    await db.$queryRawUnsafe('SELECT 1');
  } catch {
    console.error('Test DB not available');
    process.exit(1);
  }
});

afterAll(async () => {
  await db.$disconnect();
});
