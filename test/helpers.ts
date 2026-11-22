import request from 'supertest';
import { createApp } from '../src/app';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

// Point to test DB
process.env.DATABASE_URL = process.env.DATABASE_URL?.replace(/\/marbou(\?|$)/, '/marbou_test$1');

export const app = createApp();
export const db = new PrismaClient();

export async function clearTables() {
  // Safety: only allow clearing tables in a test database
  const dbUrl = process.env.DATABASE_URL ?? '';
  const dbName = dbUrl.split('/').pop()?.split('?')[0] ?? '';
  if (!dbName.endsWith('_test')) {
    throw new Error(`clearTables() refused: database "${dbName}" does not end with _test`);
  }
  await db.$executeRawUnsafe(`
    TRUNCATE "ListingView","ListingMedia","Listing",
    "AnalyticsEvent","AuditLog","BlockedUser","LoginEvent","MediaAsset",
    "OtpCode","Session","SocialIdentity","VerificationRequest","User",
    "AdminUser","ExchangeRate","Translation","Setting"
    RESTART IDENTITY CASCADE
  `);}

export async function seedSettings() {
  const defaults: Record<string, unknown> = {
    'flags.otp.email': true, 'flags.otp.sms': false, 'flags.otp.whatsapp': false,
    'auth.lockout': { maxFails: 5, delaysMin: [1, 5, 15, 60] },
    'app.maintenance': { enabled: false },
    'app.minVersion': { ios: '1.0.0', android: '1.0.0' },
    'currencies.enabled': ['SDG', 'USD'],
    'fx.staleAlertHours': 72,
    'flags.video.enabled': true,
    'media.photo.maxMB': 8,
    'media.video.maxMB': 15,
    'media.video.maxSeconds': 30,
    'media.video.disabledCategoryIds': [],
    'media.maxPhotos': 10,
    'limits.activeListingsIndividual': 50,
    'limits.activeListingsBusiness': 500,
    'limits.listingsPerHour': 5,
    'limits.listingsPerDay': 20,
    'listing.expiryDaysDefault': 30,
    'listing.renewWindowDays': 30,
    'quality.weights': { titleDesc: 25, photos: 25, requiredAttrs: 20, optionalAttrs: 10, location: 10, video: 5, price: 5 },
    'dup.textSimilarity': 0.85,
    'moderation.autoHide': { reports: 5, windowHours: 24, fraudScore: 85 },
    'moderation.delayedVisibility': [],
    'moderation.bannedKeywords': [],
    'chat.bannedPhrases': [],
    'fraud.alert': 70,
    'flags.contactReveal.policy': 'GUESTS_RATE_LIMITED',
    'limits.guestRevealsPerDay': 20,
    'whatsapp.template.ar': 'مرحباً، مهتم بـ {title} ({listingId}) بسعر {price}',
    'whatsapp.template.en': 'Hi, interested in {title} ({listingId}) at {price}',
  };
  for (const [key, value] of Object.entries(defaults)) {
    await db.setting.upsert({
      where: { key },
      create: { key, value: value as never },
      update: { value: value as never },
    });
  }
}

export async function createCategory(overrides: Partial<{
  slug: string; nameAr: string; nameEn: string; parentId: string;
  postingRestricted: boolean; postingMessage: string; expiryDays: number;
}> = {}) {
  return db.category.create({
    data: {
      slug: overrides.slug ?? `cat-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      nameAr: overrides.nameAr ?? 'تصنيف اختبار',
      nameEn: overrides.nameEn ?? 'Test Category',
      parentId: overrides.parentId ?? null,
      postingRestricted: overrides.postingRestricted ?? false,
      postingMessage: overrides.postingMessage,
      expiryDays: overrides.expiryDays,
    },
  });
}

export async function createListing(
  ownerId: string,
  categoryId: string,
  overrides: Record<string, unknown> = {},
) {
  const { createListing: svcCreate } = await import('../src/modules/listings/create');
  return svcCreate(ownerId, {
    categoryId,
    listingType: 'SALE',
    title: 'Test Listing Title Here',
    description: 'Test listing description that is long enough to pass validation.',
    price: 1000,
    currency: 'SDG',
    publish: true,
    ...overrides,
  } as Parameters<typeof svcCreate>[1]);
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
