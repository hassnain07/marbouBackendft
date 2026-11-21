import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import request from 'supertest';
import { app, db, clearTables, seedSettings, createTestUser, loginUser, createAndLoginUser, createTestAdmin, loginAdmin } from './helpers';
import { getLastOtp } from '../src/shared/email';
import { normalizeArabic } from '../src/shared/arabic';
import { storage } from '../src/shared/storage';
import { signMediaToken, verifyMediaToken } from '../src/shared/crypto';

const BASE = '/api/v1';

beforeAll(async () => {
  await seedSettings();
});

beforeEach(async () => {
  await clearTables();
  await seedSettings();
});

// ─── normalizeArabic table tests ─────────────────────────────────────────────

describe('normalizeArabic', () => {
  it('normalizes أحمد and احمد to the same string', () => {
    expect(normalizeArabic('أحمد')).toBe(normalizeArabic('احمد'));
  });
  it('normalizes مدرسة and مدرسه to the same string', () => {
    expect(normalizeArabic('مدرسة')).toBe(normalizeArabic('مدرسه'));
  });
  it('normalizes سيارة and سياره to the same string', () => {
    expect(normalizeArabic('سيارة')).toBe(normalizeArabic('سياره'));
  });
  it('strips diacritics', () => {
    expect(normalizeArabic('مَرْحَبًا')).toBe('مرحبا');
  });
  it('lowercases latin', () => {
    expect(normalizeArabic('Toyota')).toBe('toyota');
  });
});

// ─── Storage private link signature + expiry ─────────────────────────────────

describe('storage private link', () => {
  it('generates a valid signed URL and verifies it', () => {
    const secret = 'test-secret-32-chars-long-enough!';
    const mediaId = 'media-123';
    const expiresAt = Date.now() + 5 * 60 * 1000;
    const token = signMediaToken(mediaId, expiresAt, secret);
    const result = verifyMediaToken(token, secret);
    expect(result).not.toBeNull();
    expect(result!.mediaId).toBe(mediaId);
  });

  it('rejects expired token', () => {
    const secret = 'test-secret-32-chars-long-enough!';
    const token = signMediaToken('media-123', Date.now() - 1000, secret);
    expect(verifyMediaToken(token, secret)).toBeNull();
  });

  it('rejects tampered token', () => {
    const secret = 'test-secret-32-chars-long-enough!';
    const token = signMediaToken('media-123', Date.now() + 60000, secret);
    const tampered = token.slice(0, -4) + 'XXXX';
    expect(verifyMediaToken(tampered, secret)).toBeNull();
  });
});

// ─── Auth: register → OTP → login ────────────────────────────────────────────

describe('Auth: register → verify → login', () => {
  it('registers a user, verifies OTP, returns tokens', async () => {
    const email = `reg_${Date.now()}@test.com`;
    const res = await request(app).post(`${BASE}/auth/register`)
      .send({ email, password: 'Password1', fullName: 'Test User' });
    expect(res.status).toBe(200);
    expect(res.body.userId).toBeDefined();

    const code = getLastOtp(email, 'REGISTER');
    expect(code).toBeDefined();

    const verify = await request(app).post(`${BASE}/auth/otp/verify`)
      .send({ email, code, purpose: 'REGISTER' });
    expect(verify.status).toBe(200);
    expect(verify.body.accessToken).toBeDefined();
    expect(verify.body.refreshToken).toBeDefined();
  });

  it('rejects duplicate email with 409 EMAIL_TAKEN', async () => {
    const email = `dup_${Date.now()}@test.com`;
    await request(app).post(`${BASE}/auth/register`).send({ email, password: 'Password1', fullName: 'A' });
    const res = await request(app).post(`${BASE}/auth/register`).send({ email, password: 'Password1', fullName: 'B' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EMAIL_TAKEN');
  });

  it('rejects weak password', async () => {
    const res = await request(app).post(`${BASE}/auth/register`)
      .send({ email: `weak_${Date.now()}@test.com`, password: 'short', fullName: 'A' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('WEAK_PASSWORD');
  });
});

// ─── OTP: cooldown, attempts, expiry ─────────────────────────────────────────

describe('OTP: cooldown / attempts / expiry', () => {
  it('enforces 60s cooldown on resend', async () => {
    const email = `otp_${Date.now()}@test.com`;
    await request(app).post(`${BASE}/auth/register`).send({ email, password: 'Password1', fullName: 'A' });
    // Immediate resend should hit cooldown
    const res = await request(app).post(`${BASE}/auth/otp/request`)
      .send({ email, purpose: 'REGISTER', channel: 'EMAIL' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('OTP_COOLDOWN');
    expect(res.body.error.details.retryAfterSec).toBeGreaterThan(0);
  });

  it('locks after 5 wrong attempts', async () => {
    const email = `attempts_${Date.now()}@test.com`;
    await request(app).post(`${BASE}/auth/register`).send({ email, password: 'Password1', fullName: 'A' });

    for (let i = 0; i < 5; i++) {
      await request(app).post(`${BASE}/auth/otp/verify`)
        .send({ email, code: '000000', purpose: 'REGISTER' });
    }
    const res = await request(app).post(`${BASE}/auth/otp/verify`)
      .send({ email, code: '000000', purpose: 'REGISTER' });
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('OTP_ATTEMPTS_EXCEEDED');
  });

  it('rejects expired OTP', async () => {
    const email = `exp_${Date.now()}@test.com`;
    await request(app).post(`${BASE}/auth/register`).send({ email, password: 'Password1', fullName: 'A' });
    // Manually expire the OTP
    await db.otpCode.updateMany({ where: { email }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const res = await request(app).post(`${BASE}/auth/otp/verify`)
      .send({ email, code: '123456', purpose: 'REGISTER' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('OTP_EXPIRED');
  });
});

// ─── Login lockout delays ─────────────────────────────────────────────────────

describe('Login lockout', () => {
  it('returns 429 ACCOUNT_LOCKED with retryAfterSec after 5 bad passwords', async () => {
    const { email } = await createTestUser({ verified: true });

    for (let i = 0; i < 5; i++) {
      await request(app).post(`${BASE}/auth/login`)
        .send({ email, password: 'WrongPass1', device: {} });
    }
    const res = await request(app).post(`${BASE}/auth/login`)
      .send({ email, password: 'WrongPass1', device: {} });
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('ACCOUNT_LOCKED');
    expect(res.body.error.details.retryAfterSec).toBeGreaterThan(0);
  });
});

// ─── Refresh rotation + reuse revokes family ─────────────────────────────────

describe('Refresh token rotation', () => {
  it('rotates refresh token on each use', async () => {
    const { accessToken, refreshToken } = await createAndLoginUser();
    const res = await request(app).post(`${BASE}/auth/refresh`).send({ refreshToken });
    expect(res.status).toBe(200);
    expect(res.body.refreshToken).not.toBe(refreshToken);
    expect(res.body.accessToken).toBeDefined();
  });

  it('revokes entire family on refresh token reuse', async () => {
    const { refreshToken } = await createAndLoginUser();

    // Use the token once
    const res1 = await request(app).post(`${BASE}/auth/refresh`).send({ refreshToken });
    expect(res1.status).toBe(200);
    const newRefresh = res1.body.refreshToken;

    // Reuse the OLD token — should revoke family
    const res2 = await request(app).post(`${BASE}/auth/refresh`).send({ refreshToken });
    expect(res2.status).toBe(401);
    expect(res2.body.error.code).toBe('REFRESH_REUSED');

    // New token should also be revoked now
    const res3 = await request(app).post(`${BASE}/auth/refresh`).send({ refreshToken: newRefresh });
    expect(res3.status).toBe(401);
  });
});

// ─── Suspended / revoked session rejected immediately ────────────────────────

describe('Session revocation', () => {
  it('rejects requests with a revoked session', async () => {
    const { accessToken, refreshToken } = await createAndLoginUser();

    // Logout (revoke session)
    await request(app).post(`${BASE}/auth/logout`)
      .set('Authorization', `Bearer ${accessToken}`);

    // Access token should now fail
    const res = await request(app).get(`${BASE}/me`)
      .set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(401);
  });

  it('rejects suspended user immediately', async () => {
    const { user, accessToken } = await createAndLoginUser();
    await db.user.update({ where: { id: user.id }, data: { status: 'SUSPENDED' } });

    const res = await request(app).get(`${BASE}/me`)
      .set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ACCOUNT_SUSPENDED');
  });
});

// ─── Social login: no duplicate on re-login ───────────────────────────────────

describe('Social login', () => {
  it('creates user on first social login', async () => {
    const res = await request(app).post(`${BASE}/auth/social/google`)
      .send({ idToken: 'mock:social@test.com:Social User', device: {} });
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeDefined();
  });

  it('does not create duplicate on second social login with same email', async () => {
    const token = 'mock:social2@test.com:Social User';
    await request(app).post(`${BASE}/auth/social/google`).send({ idToken: token, device: {} });
    await request(app).post(`${BASE}/auth/social/google`).send({ idToken: token, device: {} });

    const count = await db.user.count({ where: { email: 'social2@test.com' } });
    expect(count).toBe(1);
  });

  it('returns needsEmail:true for mock token with no email', async () => {
    const res = await request(app).post(`${BASE}/auth/social/google`)
      .send({ idToken: 'mock::NoEmail User', device: {} });
    expect(res.status).toBe(200);
    expect(res.body.needsEmail).toBe(true);
  });

  it('social no-email user gets 403 EMAIL_NOT_VERIFIED on POST /me/verification', async () => {
    const res1 = await request(app).post(`${BASE}/auth/social/google`)
      .send({ idToken: 'mock::Unverified', device: {} });
    const { accessToken } = res1.body as { accessToken: string };

    const res2 = await request(app).post(`${BASE}/me/verification`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ kind: 'USER', documentMediaIds: ['fake-id'] });
    expect(res2.status).toBe(403);
    expect(res2.body.error.code).toBe('EMAIL_NOT_VERIFIED');
  });
});

// ─── Customer token rejected on /admin/* ─────────────────────────────────────

describe('Token isolation', () => {
  it('rejects customer token on /admin/* routes', async () => {
    const { accessToken } = await createAndLoginUser();
    const res = await request(app).get(`${BASE}/admin/me`)
      .set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(401);
  });

  it('rejects admin token on /me route', async () => {
    const admin = await createTestAdmin();
    const { accessToken } = await loginAdmin(admin.email);
    const res = await request(app).get(`${BASE}/me`)
      .set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(401);
  });
});

// ─── Admin: cannot get tokens without 2FA ────────────────────────────────────

describe('Admin 2FA', () => {
  it('step 1 returns mfaToken, not accessToken', async () => {
    const admin = await createTestAdmin();
    const res = await request(app).post(`${BASE}/admin/auth/login`)
      .send({ email: admin.email, password: 'Admin#12345' });
    expect(res.status).toBe(200);
    expect(res.body.mfaToken).toBeDefined();
    expect(res.body.accessToken).toBeUndefined();
  });

  it('step 2 with valid code returns accessToken', async () => {
    const admin = await createTestAdmin();
    const step1 = await request(app).post(`${BASE}/admin/auth/login`)
      .send({ email: admin.email, password: 'Admin#12345' });
    const { mfaToken } = step1.body as { mfaToken: string };

    const step2 = await request(app).post(`${BASE}/admin/auth/verify-2fa`)
      .send({ mfaToken, code: '000000' });
    expect(step2.status).toBe(200);
    expect(step2.body.accessToken).toBeDefined();
  });

  it('step 2 with wrong code returns 400 TOTP_INVALID', async () => {
    const admin = await createTestAdmin();
    const step1 = await request(app).post(`${BASE}/admin/auth/login`)
      .send({ email: admin.email, password: 'Admin#12345' });
    const { mfaToken } = step1.body as { mfaToken: string };

    const step2 = await request(app).post(`${BASE}/admin/auth/verify-2fa`)
      .send({ mfaToken, code: '999999' });
    expect(step2.status).toBe(400);
    expect(step2.body.error.code).toBe('TOTP_INVALID');
  });
});

// ─── Moderator gets 403 on settings ──────────────────────────────────────────

describe('Admin RBAC', () => {
  it('moderator cannot access PATCH /admin/settings/:key', async () => {
    const mod = await createTestAdmin('CONTENT_MODERATOR');
    const { accessToken } = await loginAdmin(mod.email);

    const res = await request(app).patch(`${BASE}/admin/settings/flags.otp.email`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ value: false });
    expect(res.status).toBe(403);
  });

  it('super admin can access settings', async () => {
    const sa = await createTestAdmin('SUPER_ADMIN');
    const { accessToken } = await loginAdmin(sa.email);

    const res = await request(app).get(`${BASE}/admin/settings`)
      .set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(200);
  });
});

// ─── Last OTP channel cannot be disabled ─────────────────────────────────────

describe('Settings: last OTP channel', () => {
  it('refuses to disable the last enabled OTP channel', async () => {
    const sa = await createTestAdmin('SUPER_ADMIN');
    const { accessToken } = await loginAdmin(sa.email);

    // email is the only enabled channel (sms=false, whatsapp=false)
    const res = await request(app).patch(`${BASE}/admin/flags/flags.otp.email`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ value: false });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('LAST_OTP_CHANNEL');
  });
});

// ─── Audit chain verify detects tampering ────────────────────────────────────

describe('Audit log', () => {
  it('verify returns ok on clean chain', async () => {
    const sa = await createTestAdmin('SUPER_ADMIN');
    const { accessToken } = await loginAdmin(sa.email);

    const res = await request(app).get(`${BASE}/admin/audit-logs/verify`)
      .set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('detects tampering in audit chain', async () => {
    const sa = await createTestAdmin('SUPER_ADMIN');
    await loginAdmin(sa.email); // creates an audit entry

    // Tamper: disable trigger, corrupt hash, re-enable
    await db.$executeRawUnsafe(`ALTER TABLE "AuditLog" DISABLE TRIGGER audit_no_update`);
    await db.$executeRawUnsafe(`UPDATE "AuditLog" SET hash = 'tampered' WHERE id = (SELECT MIN(id) FROM "AuditLog")`);
    await db.$executeRawUnsafe(`ALTER TABLE "AuditLog" ENABLE TRIGGER audit_no_update`);

    const { accessToken } = await loginAdmin(sa.email);
    const res = await request(app).get(`${BASE}/admin/audit-logs/verify`)
      .set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.firstMismatch).toBeDefined();
  });
});

// ─── ETag 304 on /config ─────────────────────────────────────────────────────

describe('GET /config ETag', () => {
  it('returns 200 on first request with ETag header', async () => {
    const res = await request(app).get(`${BASE}/config`);
    expect(res.status).toBe(200);
    expect(res.headers.etag).toBeDefined();
  });

  it('returns 304 when ETag matches', async () => {
    const res1 = await request(app).get(`${BASE}/config`);
    const etag = res1.headers.etag as string;

    const res2 = await request(app).get(`${BASE}/config`)
      .set('If-None-Match', etag);
    expect(res2.status).toBe(304);
  });
});

// ─── Health endpoints ─────────────────────────────────────────────────────────

describe('Health', () => {
  it('GET /health returns 200', async () => {
    const res = await request(app).get(`${BASE}/health`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('GET /health/ready returns 200', async () => {
    const res = await request(app).get(`${BASE}/health/ready`);
    expect(res.status).toBe(200);
  });
});
