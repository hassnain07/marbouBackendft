import request from 'supertest';
import { createApp } from '../src/app';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

// Point to test DB
process.env.DATABASE_URL = process.env.DATABASE_URL?.replace(/\/marbou(\?|$)/, '/marbou_test$1');

export const app = createApp();
export const db = new PrismaClient();

export async function clearTables() {
  await db.$executeRawUnsafe(`
    TRUNCATE "AnalyticsEvent","AuditLog","BlockedUser","LoginEvent","MediaAsset",
    "OtpCode","Session","SocialIdentity","VerificationRequest","User",
    "AdminUser","ExchangeRate","Translation","Setting"
    RESTART IDENTITY CASCADE
  `);
}

export async function seedSettings() {
  const defaults: Record<string, unknown> = {
    'flags.otp.email': true, 'flags.otp.sms': false, 'flags.otp.whatsapp': false,
    'auth.lockout': { maxFails: 5, delaysMin: [1, 5, 15, 60] },
    'app.maintenance': { enabled: false },
    'app.minVersion': { ios: '1.0.0', android: '1.0.0' },
    'currencies.enabled': ['SDG', 'USD'],
    'fx.staleAlertHours': 72,
  };
  for (const [key, value] of Object.entries(defaults)) {
    await db.setting.upsert({
      where: { key },
      create: { key, value: value as never },
      update: { value: value as never },
    });
  }
}

export async function createTestUser(overrides: Partial<{
  email: string; password: string; fullName: string; verified: boolean;
}> = {}) {
  const email = overrides.email ?? `user_${Date.now()}@test.com`;
  const passwordHash = await bcrypt.hash(overrides.password ?? 'Password1', 12);
  const user = await db.user.create({
    data: {
      email,
      passwordHash,
      fullName: overrides.fullName ?? 'Test User',
      emailVerifiedAt: overrides.verified !== false ? new Date() : null,
    },
  });
  return { user, email, password: overrides.password ?? 'Password1' };
}

export async function loginUser(email: string, password: string) {
  const res = await request(app)
    .post('/api/v1/auth/login')
    .send({ email, password, device: { id: 'test-device', name: 'Test', os: 'test' } });
  return res.body as { accessToken: string; refreshToken: string };
}

export async function createAndLoginUser(overrides?: Parameters<typeof createTestUser>[0]) {
  const { user, email, password } = await createTestUser(overrides);
  const tokens = await loginUser(email, password);
  return { user, email, password, ...tokens };
}

export async function createTestAdmin(role: 'SUPER_ADMIN' | 'CONTENT_MODERATOR' | 'SUPPORT_AGENT' | 'FINANCIAL_AUDITOR' = 'SUPER_ADMIN') {
  const email = `admin_${Date.now()}@test.com`;
  const passwordHash = await bcrypt.hash('Admin#12345', 12);
  return db.adminUser.create({
    data: { email, passwordHash, fullName: 'Test Admin', role },
  });
}

export async function loginAdmin(email: string) {
  // Step 1: login
  const step1 = await request(app)
    .post('/api/v1/admin/auth/login')
    .send({ email, password: 'Admin#12345' });
  const { mfaToken } = step1.body as { mfaToken: string };

  // Step 2: verify 2FA with fixed code
  const step2 = await request(app)
    .post('/api/v1/admin/auth/verify-2fa')
    .send({ mfaToken, code: '000000' });
  return step2.body as { accessToken: string; refreshToken: string };
}
