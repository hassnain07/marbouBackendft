import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { authenticator } from 'otplib';
import { db } from '../../shared/db';
import { E } from '../../shared/errors';
import { env, isProd } from '../../config/env';
import { randomToken } from '../../shared/crypto';
import { aesEncrypt, aesDecrypt } from '../../shared/crypto';
import { audit } from '../../shared/audit';
import { settings } from '../../shared/settings';
import type { AdminRole } from '@prisma/client';

const BCRYPT_ROUNDS = 12;
const ACCESS_TTL = '30m';
const REFRESH_TTL_MS = 8 * 60 * 60 * 1000; // 8h sliding

// ─── Token helpers ────────────────────────────────────────────────────────────

function signAdminAccess(admin: { id: string; role: AdminRole; tokenVersion: number }): string {
  return jwt.sign(
    { sub: admin.id, role: admin.role, tv: admin.tokenVersion },
    env.JWT_ADMIN_SECRET,
    { expiresIn: ACCESS_TTL },
  );
}

function signAdminRefresh(admin: { id: string; role: AdminRole; tokenVersion: number }): string {
  return jwt.sign(
    { sub: admin.id, role: admin.role, tv: admin.tokenVersion, type: 'refresh' },
    env.JWT_ADMIN_SECRET,
    { expiresIn: '8h' },
  );
}

function signMfaToken(adminId: string): string {
  return jwt.sign({ sub: adminId, purpose: 'mfa' }, env.JWT_ADMIN_SECRET, { expiresIn: '5m' });
}

function verifyMfaToken(token: string): string {
  try {
    const p = jwt.verify(token, env.JWT_ADMIN_SECRET) as { sub: string; purpose: string };
    if (p.purpose !== 'mfa') throw new Error();
    return p.sub;
  } catch {
    throw E.badRequest('MFA_TOKEN_INVALID');
  }
}

// ─── Login step 1 ─────────────────────────────────────────────────────────────

export async function adminLogin(input: { email: string; password: string; ip: string }) {
  const admin = await db.adminUser.findUnique({ where: { email: input.email.toLowerCase() } });
  if (!admin) throw E.unauthorized('INVALID_CREDENTIALS');
  if (!admin.isActive) throw E.forbidden('ADMIN_INACTIVE');

  // IP allow-list
  if (admin.ipAllowlist.length > 0 && !admin.ipAllowlist.includes(input.ip)) {
    throw E.forbidden('ADMIN_IP_BLOCKED');
  }

  const valid = await bcrypt.compare(input.password, admin.passwordHash);
  if (!valid) throw E.unauthorized('INVALID_CREDENTIALS');

  const mfaToken = signMfaToken(admin.id);

  if (!admin.totpEnrolledAt) {
    // First login: generate TOTP secret
    const secret = authenticator.generateSecret();
    const secretEnc = aesEncrypt(secret, env.ADMIN_TOTP_ENC_KEY);
    await db.adminUser.update({ where: { id: admin.id }, data: { totpSecretEnc: secretEnc } });

    const otpauthUrl = authenticator.keyuri(admin.email, 'MARBOU Admin', secret);
    return { needsEnrollment: true, mfaToken, otpauthUrl, secret };
  }

  return { needsEnrollment: false, mfaToken };
}

// ─── Login step 2 (2FA verify) ────────────────────────────────────────────────

export async function adminVerify2fa(input: { mfaToken: string; code: string; ip: string }) {
  const adminId = verifyMfaToken(input.mfaToken);
  const admin = await db.adminUser.findUnique({ where: { id: adminId } });
  if (!admin || !admin.isActive) throw E.unauthorized('ADMIN_INACTIVE');
  if (!admin.totpSecretEnc) throw E.badRequest('MFA_TOKEN_INVALID');

  const secret = aesDecrypt(admin.totpSecretEnc, env.ADMIN_TOTP_ENC_KEY);

  // Accept fixed code in non-production
  const isFixedCode = !isProd && env.DEV_TOTP_FIXED_CODE && input.code === env.DEV_TOTP_FIXED_CODE;
  if (!isFixedCode && !authenticator.check(input.code, secret)) {
    throw E.badRequest('TOTP_INVALID');
  }

  const updates: Record<string, unknown> = {};
  if (!admin.totpEnrolledAt) updates.totpEnrolledAt = new Date();

  await db.adminUser.update({ where: { id: adminId }, data: updates });

  await audit.log({
    actor: { type: 'ADMIN', id: adminId },
    action: 'ADMIN_LOGIN',
    entity: 'AdminUser',
    entityId: adminId,
    after: { ip: input.ip },
  });

  const accessToken = signAdminAccess(admin);
  const refreshToken = signAdminRefresh(admin);

  return { accessToken, refreshToken, expiresIn: 1800 };
}

// ─── Refresh ──────────────────────────────────────────────────────────────────

export async function adminRefresh(refreshToken: string) {
  let payload: { sub: string; role: AdminRole; tv: number; type: string };
  try {
    payload = jwt.verify(refreshToken, env.JWT_ADMIN_SECRET) as typeof payload;
  } catch {
    throw E.unauthorized('INVALID_REFRESH');
  }
  if (payload.type !== 'refresh') throw E.unauthorized('INVALID_REFRESH');

  const admin = await db.adminUser.findUnique({ where: { id: payload.sub } });
  if (!admin || !admin.isActive) throw E.unauthorized('ADMIN_INACTIVE');
  if (admin.tokenVersion !== payload.tv) throw E.unauthorized('SESSION_REVOKED');

  const accessToken = signAdminAccess(admin);
  const newRefresh = signAdminRefresh(admin);
  return { accessToken, refreshToken: newRefresh, expiresIn: 1800 };
}

// ─── Logout ───────────────────────────────────────────────────────────────────

export async function adminLogout(adminId: string): Promise<void> {
  await db.adminUser.update({ where: { id: adminId }, data: { tokenVersion: { increment: 1 } } });
}

// ─── Change password ──────────────────────────────────────────────────────────

export async function adminChangePassword(adminId: string, currentPw: string, newPw: string): Promise<void> {
  const admin = await db.adminUser.findUniqueOrThrow({ where: { id: adminId } });
  const valid = await bcrypt.compare(currentPw, admin.passwordHash);
  if (!valid) throw E.badRequest('WRONG_PASSWORD');
  const passwordHash = await bcrypt.hash(newPw, BCRYPT_ROUNDS);
  await db.adminUser.update({ where: { id: adminId }, data: { passwordHash, mustChangePassword: false } });
}

// ─── Get me ───────────────────────────────────────────────────────────────────

export async function getAdminMe(adminId: string) {
  const admin = await db.adminUser.findUniqueOrThrow({
    where: { id: adminId },
    select: { id: true, email: true, fullName: true, role: true, totpEnrolledAt: true, isActive: true, createdAt: true },
  });
  return admin;
}

// ─── Admin CRUD (Super Admin only) ───────────────────────────────────────────

export async function listAdmins() {
  return db.adminUser.findMany({
    select: { id: true, email: true, fullName: true, role: true, isActive: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
  });
}

export async function createAdmin(
  actorId: string,
  input: { email: string; fullName: string; role: AdminRole },
) {
  const existing = await db.adminUser.findUnique({ where: { email: input.email.toLowerCase() } });
  if (existing) throw E.conflict('ADMIN_EMAIL_TAKEN');

  const tempPassword = randomToken(12);
  const passwordHash = await bcrypt.hash(tempPassword, BCRYPT_ROUNDS);

  const admin = await db.adminUser.create({
    data: {
      email: input.email.toLowerCase(),
      passwordHash,
      fullName: input.fullName,
      role: input.role,
      mustChangePassword: true,
    },
  });

  await audit.log({
    actor: { type: 'ADMIN', id: actorId },
    action: 'ADMIN_CREATED',
    entity: 'AdminUser',
    entityId: admin.id,
    after: { role: admin.role },
  });

  return { id: admin.id, email: admin.email, tempPassword };
}

export async function updateAdmin(
  actorId: string,
  targetId: string,
  input: { role?: AdminRole; isActive?: boolean },
) {
  if (actorId === targetId) throw E.badRequest('CANNOT_MODIFY_SELF');
  const before = await db.adminUser.findUnique({ where: { id: targetId }, select: { role: true, isActive: true } });
  if (!before) throw E.notFound('ADMIN_NOT_FOUND');

  const admin = await db.adminUser.update({
    where: { id: targetId },
    data: { ...input, ...(input.isActive === false ? { tokenVersion: { increment: 1 } } : {}) },
  });

  await audit.log({
    actor: { type: 'ADMIN', id: actorId },
    action: 'ADMIN_UPDATED',
    entity: 'AdminUser',
    entityId: targetId,
    before: { role: before.role, isActive: before.isActive },
    after: { role: admin.role, isActive: admin.isActive },
  });

  return { id: admin.id, email: admin.email, role: admin.role, isActive: admin.isActive };
}

export async function resetAdmin2fa(actorId: string, targetId: string): Promise<void> {
  if (actorId === targetId) throw E.badRequest('CANNOT_MODIFY_SELF');
  await db.adminUser.update({
    where: { id: targetId },
    data: { totpSecretEnc: null, totpEnrolledAt: null, tokenVersion: { increment: 1 } },
  });
  await audit.log({
    actor: { type: 'ADMIN', id: actorId },
    action: 'ADMIN_2FA_RESET',
    entity: 'AdminUser',
    entityId: targetId,
  });
}

export async function revokeAdminSessions(actorId: string, targetId: string): Promise<void> {
  await db.adminUser.update({ where: { id: targetId }, data: { tokenVersion: { increment: 1 } } });
  await audit.log({
    actor: { type: 'ADMIN', id: actorId },
    action: 'ADMIN_SESSIONS_REVOKED',
    entity: 'AdminUser',
    entityId: targetId,
  });
}

// ─── Settings ─────────────────────────────────────────────────────────────────

export async function getAllSettings() {
  const map = await settings.getAll();
  return Object.fromEntries(map);
}

export async function updateSetting(actorId: string, key: string, value: unknown) {
  const before = await settings.get(key);
  await settings.set(key, value, { type: 'ADMIN', id: actorId });
  await audit.log({
    actor: { type: 'ADMIN', id: actorId },
    action: 'SETTING_CHANGE',
    entity: 'Setting',
    entityId: key,
    before,
    after: value,
  });
  return { key, value };
}

export async function updateFlag(actorId: string, key: string, value: boolean) {
  const flagKey = key.startsWith('flags.') ? key : `flags.${key}`;
  return updateSetting(actorId, flagKey, value);
}

// ─── Audit logs ───────────────────────────────────────────────────────────────

export async function getAuditLogs(query: {
  actor?: string;
  entity?: string;
  from?: string;
  to?: string;
  limit?: number;
  cursor?: number;
}) {
  const where: Record<string, unknown> = {};
  if (query.actor) where.actorId = query.actor;
  if (query.entity) where.entity = query.entity;
  if (query.from || query.to) {
    where.createdAt = {
      ...(query.from ? { gte: new Date(query.from) } : {}),
      ...(query.to ? { lte: new Date(query.to) } : {}),
    };
  }
  if (query.cursor) where.id = { lt: BigInt(query.cursor) };

  const limit = Math.min(query.limit ?? 50, 100);
  const logs = await db.auditLog.findMany({
    where,
    orderBy: { id: 'desc' },
    take: limit + 1,
  });

  const hasMore = logs.length > limit;
  const data = hasMore ? logs.slice(0, limit) : logs;
  return {
    data: data.map((l) => ({ ...l, id: l.id.toString() })),
    nextCursor: hasMore ? data[data.length - 1].id.toString() : null,
  };
}

export { audit };
