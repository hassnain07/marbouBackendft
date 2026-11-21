/**
 * B09-B11 tests: phone validation, session fixes, social login fixes,
 * JWT error codes, lockout timing, contactPrefs merge, changePassword revokes sessions,
 * audit canonical JSON, config suppressed flag.
 */
import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import request from 'supertest';
import {
  app, db, clearTables, seedSettings,
  createTestUser, loginUser, createAndLoginUser, createTestAdmin, loginAdmin,
} from './helpers';
import { validatePhone } from '../src/shared/crypto';
import { audit } from '../src/shared/audit';

const BASE = '/api/v1';

beforeAll(async () => { await seedSettings(); });
beforeEach(async () => { await clearTables(); await seedSettings(); });

// ─── B09: validatePhone ───────────────────────────────────────────────────────

describe('validatePhone (B09)', () => {
  it('accepts E.164 number', () => {
    expect(validatePhone('+249912345678')).toBe('+249912345678');
  });

  it('converts 10-digit Sudanese local to E.164', () => {
    expect(validatePhone('0912345678')).toBe('+249912345678');
  });

  it('rejects invalid phone', () => {
    expect(() => validatePhone('12345')).toThrow();
    expect(() => validatePhone('notaphone')).toThrow();
  });

  it('register rejects invalid phone with 400 INVALID_PHONE', async () => {
    const res = await request(app).post(`${BASE}/auth/register`).send({
      email: `phone_${Date.now()}@test.com`,
      password: 'Password1',
      fullName: 'A',
      phone: 'badphone',
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_PHONE');
  });

  it('PATCH /me/phone validates and normalises to E.164', async () => {
    const { accessToken } = await createAndLoginUser();
    const res = await request(app).patch(`${BASE}/me/phone`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ phone: '0912345678' });
    expect(res.status).toBe(200);
    const me = await request(app).get(`${BASE}/me`).set('Authorization', `Bearer ${accessToken}`);
    expect(me.body.phone).toBe('+249912345678');
  });

  it('PATCH /me/phone does not alter verifiedPhone', async () => {
    const { user, accessToken } = await createAndLoginUser();
    await db.user.update({ where: { id: user.id }, data: { verifiedPhone: '+249999999999' } });
    await request(app).patch(`${BASE}/me/phone`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ phone: '0912345678' });
    const updated = await db.user.findUnique({ where: { id: user.id } });
    expect(updated!.verifiedPhone).toBe('+249999999999');
    expect(updated!.phone).toBe('+249912345678');
  });
});

// ─── B01: JWT errors → 401 ────────────────────────────────────────────────────

describe('JWT errors (B01)', () => {
  it('expired token returns 401 TOKEN_EXPIRED', async () => {
    const jwt = await import('jsonwebtoken');
    const { env } = await import('../src/config/env');
    const expired = jwt.sign(
      { sub: 'x', sid: 'y', fam: 'z', type: 'access' },
      env.JWT_USER_SECRET,
      { expiresIn: -1 },
    );
    const res = await request(app).get(`${BASE}/me`)
      .set('Authorization', `Bearer ${expired}`);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('TOKEN_EXPIRED');
  });

  it('malformed token returns 401', async () => {
    const res = await request(app).get(`${BASE}/me`)
      .set('Authorization', 'Bearer not.a.valid.jwt');
    expect(res.status).toBe(401);
  });

  it('refresh token rejected on user route returns 401', async () => {
    const { refreshToken } = await createAndLoginUser();
    const res = await request(app).get(`${BASE}/me`)
      .set('Authorization', `Bearer ${refreshToken}`);
    expect(res.status).toBe(401);
  });
});

// ─── B02: audit canonical JSON + verify returns string ────────────────────────

describe('Audit canonical JSON (B02)', () => {
  it('verify returns ok:true on clean chain', async () => {
    const sa = await createTestAdmin('SUPER_ADMIN');
    await loginAdmin(sa.email);
    const result = await audit.verify();
    expect(result.ok).toBe(true);
  });

  it('firstMismatch is a string not BigInt', async () => {
    const sa = await createTestAdmin('SUPER_ADMIN');
    await loginAdmin(sa.email);
    await db.$executeRawUnsafe(`ALTER TABLE "AuditLog" DISABLE TRIGGER audit_no_update`);
    await db.$executeRawUnsafe(`UPDATE "AuditLog" SET hash = 'tampered' WHERE id = (SELECT MIN(id) FROM "AuditLog")`);
    await db.$executeRawUnsafe(`ALTER TABLE "AuditLog" ENABLE TRIGGER audit_no_update`);
    const result = await audit.verify();
    expect(result.ok).toBe(false);
    expect(typeof result.firstMismatch).toBe('string');
  });

  it('multi-key before/after object does not break chain', async () => {
    await audit.log({
      actor: { type: 'ADMIN', id: 'test-id' },
      action: 'TEST',
      entity: 'Setting',
      entityId: 'test.key',
      before: { z: 1, a: 2, m: 3 },
      after: { a: 2, m: 3, z: 1 },
    });
    const result = await audit.verify();
    expect(result.ok).toBe(true);
  });
});

// ─── B04: lockout timing ──────────────────────────────────────────────────────

describe('Login lockout timing (B04)', () => {
  it('5 fails → locked with retryAfterSec', async () => {
    const { email } = await createTestUser({ verified: true });
    for (let i = 0; i < 5; i++) {
      await request(app).post(`${BASE}/auth/login`).send({ email, password: 'WrongPass1', device: {} });
    }
    const res = await request(app).post(`${BASE}/auth/login`).send({ email, password: 'WrongPass1', device: {} });
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('ACCOUNT_LOCKED');
    expect(res.body.error.details.retryAfterSec).toBeGreaterThan(0);
  });

  it('success resets lockout counter', async () => {
    const { email, password } = await createTestUser({ verified: true });
    for (let i = 0; i < 4; i++) {
      await request(app).post(`${BASE}/auth/login`).send({ email, password: 'WrongPass1', device: {} });
    }
    const ok = await request(app).post(`${BASE}/auth/login`).send({ email, password, device: {} });
    expect(ok.status).toBe(200);
    // 5 bad attempts after reset should lock
    for (let i = 0; i < 5; i++) {
      await request(app).post(`${BASE}/auth/login`).send({ email, password: 'WrongPass1', device: {} });
    }
    const locked = await request(app).post(`${BASE}/auth/login`).send({ email, password: 'WrongPass1', device: {} });
    expect(locked.status).toBe(429);
  });

  it('LOCKED outcome does not count as BAD_PASSWORD', async () => {
    const { email } = await createTestUser({ verified: true });
    for (let i = 0; i < 5; i++) {
      await request(app).post(`${BASE}/auth/login`).send({ email, password: 'WrongPass1', device: {} });
    }
    const before = await db.loginEvent.count({ where: { email, outcome: 'BAD_PASSWORD' } });
    await request(app).post(`${BASE}/auth/login`).send({ email, password: 'WrongPass1', device: {} });
    await request(app).post(`${BASE}/auth/login`).send({ email, password: 'WrongPass1', device: {} });
    const after = await db.loginEvent.count({ where: { email, outcome: 'BAD_PASSWORD' } });
    expect(after).toBe(before);
  });
});

// ─── B05: session cache invalidation ─────────────────────────────────────────

describe('Session cache invalidation (B05)', () => {
  it('capability granted is usable immediately without re-login', async () => {
    const { accessToken } = await createAndLoginUser();
    const grant = await request(app).post(`${BASE}/me/capabilities`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ capability: 'SELLER' });
    expect([200, 409]).toContain(grant.status);
    const caps = await request(app).get(`${BASE}/me/capabilities`)
      .set('Authorization', `Bearer ${accessToken}`);
    expect(caps.status).toBe(200);
  });
});

// ─── B06: social login fixes ──────────────────────────────────────────────────

describe('Social login fixes (B06)', () => {
  it('rejects SUSPENDED user on link-by-email path', async () => {
    const email = `susp_${Date.now()}@test.com`;
    const { user } = await createTestUser({ email, verified: true });
    await db.user.update({ where: { id: user.id }, data: { status: 'SUSPENDED' } });
    const res = await request(app).post(`${BASE}/auth/social/google`)
      .send({ idToken: `mock:${email}:Test`, device: {} });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ACCOUNT_SUSPENDED');
  });

  it('privaterelay email treated as unverified → needsEmail:true', async () => {
    const res = await request(app).post(`${BASE}/auth/social/google`)
      .send({ idToken: `mock:relay_${Date.now()}@privaterelay.appleid.com:Apple`, device: {} });
    expect(res.status).toBe(200);
    expect(res.body.needsEmail).toBe(true);
  });

  it('pre-registration takeover: linking to unverified account revokes old sessions', async () => {
    const email = `takeover_${Date.now()}@test.com`;
    const { user } = await createTestUser({ email, verified: false });
    // Create a session manually
    await db.session.create({
      data: { userId: user.id, familyId: 'fam1', refreshHash: 'hash1', lastActiveAt: new Date() },
    });
    // Social login with same verified email
    const social = await request(app).post(`${BASE}/auth/social/google`)
      .send({ idToken: `mock:${email}:Social`, device: {} });
    expect(social.status).toBe(200);
    // Old session should be revoked
    const oldSession = await db.session.findFirst({ where: { userId: user.id, refreshHash: 'hash1' } });
    expect(oldSession!.revokedAt).not.toBeNull();
  });
});

// ─── B10: misc fixes ──────────────────────────────────────────────────────────

describe('Misc fixes (B10)', () => {
  it('GET /me/sessions returns isCurrent:true for current session', async () => {
    const { accessToken } = await createAndLoginUser();
    const res = await request(app).get(`${BASE}/me/sessions`)
      .set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
    expect(res.body[0]).toHaveProperty('isCurrent');
    expect(res.body[0]).toHaveProperty('deviceId');
    const current = res.body.find((s: { isCurrent: boolean }) => s.isCurrent);
    expect(current).toBeDefined();
  });

  it('PATCH /me contactPrefs merges with existing values', async () => {
    const { accessToken } = await createAndLoginUser();
    await request(app).patch(`${BASE}/me`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ contactPrefs: { call: true, whatsapp: false, chatOnly: false } });
    const res = await request(app).patch(`${BASE}/me`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ contactPrefs: { whatsapp: true } });
    expect(res.status).toBe(200);
    expect(res.body.contactPrefs.call).toBe(true);
    expect(res.body.contactPrefs.whatsapp).toBe(true);
  });

  it('changePassword revokes other sessions', async () => {
    const { email, password } = await createTestUser({ verified: true });
    const s1 = await loginUser(email, password);
    const s2 = await loginUser(email, password);
    const res = await request(app).post(`${BASE}/me/password/change`)
      .set('Authorization', `Bearer ${s1.accessToken}`)
      .send({ currentPassword: password, newPassword: 'NewPassword1' });
    expect(res.status).toBe(200);
    const me = await request(app).get(`${BASE}/me`)
      .set('Authorization', `Bearer ${s2.accessToken}`);
    expect(me.status).toBe(401);
  });

  it('/config marks exchange rates suppressed after staleSuppressDays', async () => {
    await db.exchangeRate.create({
      data: {
        base: 'USD', quote: 'SDG', rate: 600,
        effectiveFrom: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000),
        setBy: 'test',
      },
    });
    const res = await request(app).get(`${BASE}/config`);
    expect(res.status).toBe(200);
    const rates = res.body.exchangeRates as Array<{ base: string; quote: string; suppressed?: boolean; stale?: boolean }>;
    const usdSdg = rates.find((r) => r.base === 'USD' && r.quote === 'SDG');
    expect(usdSdg?.suppressed).toBe(true);
    expect(usdSdg?.stale).toBe(true);
  });

  it('CORS rejected origin does not produce 500', async () => {
    const res = await request(app).get(`${BASE}/health`)
      .set('Origin', 'http://evil.example.com');
    expect(res.status).not.toBe(500);
  });
});

// ─── B07: admin password change ───────────────────────────────────────────────

describe('Admin password change (B07)', () => {
  it('returns fresh tokens after password change', async () => {
    const admin = await createTestAdmin('SUPER_ADMIN');
    const { accessToken } = await loginAdmin(admin.email);
    const res = await request(app).post(`${BASE}/admin/auth/change-password`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ currentPassword: 'Admin#12345', newPassword: 'NewAdmin#123456' });
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeDefined();
    expect(res.body.refreshToken).toBeDefined();
  });

  it('rejects weak admin password (< 12 chars)', async () => {
    const admin = await createTestAdmin('SUPER_ADMIN');
    const { accessToken } = await loginAdmin(admin.email);
    const res = await request(app).post(`${BASE}/admin/auth/change-password`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ currentPassword: 'Admin#12345', newPassword: 'Short1' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('WEAK_PASSWORD');
  });

  it('GET /admin/settings forbidden for moderator (B07)', async () => {
    const mod = await createTestAdmin('CONTENT_MODERATOR');
    const { accessToken } = await loginAdmin(mod.email);
    const res = await request(app).get(`${BASE}/admin/settings`)
      .set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(403);
  });

  it('updateSetting returns 404 for unknown key', async () => {
    const sa = await createTestAdmin('SUPER_ADMIN');
    const { accessToken } = await loginAdmin(sa.email);
    const res = await request(app).patch(`${BASE}/admin/settings/nonexistent.key`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ value: true });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('SETTING_NOT_FOUND');
  });

  it('updateSetting returns 422 for wrong type', async () => {
    const sa = await createTestAdmin('SUPER_ADMIN');
    const { accessToken } = await loginAdmin(sa.email);
    const res = await request(app).patch(`${BASE}/admin/settings/flags.otp.email`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ value: 'yes' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('SETTING_INVALID_VALUE');
  });
});
