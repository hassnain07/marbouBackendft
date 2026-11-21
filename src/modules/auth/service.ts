import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';
import { db } from '../../shared/db';
import { E } from '../../shared/errors';
import { env } from '../../config/env';
import { sha256, randomToken, generateOtp, hashOtp, validatePhone } from '../../shared/crypto';
import { sendOtpEmail } from '../../shared/email';
import { sendSms, sendWhatsAppOtp } from '../../shared/sms';
import { settings } from '../../shared/settings';
import { verifySocialToken } from '../../shared/social';
import { invalidateSessionCache, invalidateUserSessions } from '../../shared/auth';
import type { OtpPurpose, OtpChannel } from '@prisma/client';

const BCRYPT_ROUNDS = 12;
const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_COOLDOWN_MS = 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;

// ─── Password validation ──────────────────────────────────────────────────────

export function validatePassword(pw: string): void {
  if (pw.length < 8 || !/[a-zA-Z]/.test(pw) || !/[0-9]/.test(pw)) {
    throw E.badRequest('WEAK_PASSWORD');
  }
}

// ─── Token issuance ───────────────────────────────────────────────────────────

export async function issueTokens(
  userId: string,
  device: { id?: string; name?: string; os?: string },
  ip?: string,
) {
  const familyId = randomUUID();
  const refreshRaw = randomToken();
  const refreshHash = sha256(refreshRaw);

  const session = await db.session.create({
    data: {
      userId,
      familyId,
      refreshHash,
      deviceId: device.id,
      deviceName: device.name,
      os: device.os,
      ip,
      lastActiveAt: new Date(),
    },
  });

  const accessToken = jwt.sign(
    { sub: userId, sid: session.id, fam: familyId, type: 'access' },
    env.JWT_USER_SECRET,
    { expiresIn: '15m' },
  );

  const user = await db.user.findUniqueOrThrow({ where: { id: userId } });

  return {
    accessToken,
    refreshToken: refreshRaw,
    expiresIn: 900,
    user: serializeUser(user),
  };
}

// ─── Register ─────────────────────────────────────────────────────────────────

export async function register(input: {
  email: string;
  password: string;
  fullName: string;
  phone?: string;
  language?: string;
}) {
  const email = input.email.toLowerCase().trim();
  const existing = await db.user.findUnique({ where: { email } });
  if (existing) throw E.conflict('EMAIL_TAKEN');

  validatePassword(input.password);
  const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);

  const phone = input.phone ? validatePhone(input.phone) : undefined;

  const user = await db.user.create({
    data: {
      email,
      passwordHash,
      fullName: input.fullName,
      phone,
      language: (input.language?.toUpperCase() as 'AR' | 'EN') ?? 'AR',
    },
  });

  const { otpSentTo } = await requestOtp({
    email,
    purpose: 'REGISTER',
    channel: 'EMAIL',
    userId: user.id,
    lang: (input.language?.toLowerCase() as 'ar' | 'en') ?? 'ar',
  });

  return { userId: user.id, otpSentTo, resendAfterSec: 60 };
}

// ─── OTP channels ─────────────────────────────────────────────────────────────

export async function getOtpChannels() {
  const [email, sms, whatsapp] = await Promise.all([
    settings.get<boolean>('flags.otp.email', true),
    settings.get<boolean>('flags.otp.sms', false),
    settings.get<boolean>('flags.otp.whatsapp', false),
  ]);
  return { email, sms, whatsapp };
}

// ─── Request OTP (public) ────────────────────────────────────────────────────
// Public route: REGISTER and RESET only. Returns 200 silently when no eligible user exists.
export async function requestOtpPublic(input: {
  email?: string;
  phone?: string;
  purpose: 'REGISTER' | 'RESET';
  channel?: OtpChannel;
  lang: 'ar' | 'en';
}) {
  const email = input.email;

  if (input.purpose === 'REGISTER') {
    // Only send if an unverified user exists with this email
    if (email) {
      const user = await db.user.findUnique({ where: { email } });
      if (!user || user.emailVerifiedAt) {
        // No eligible user — return same shape without creating OTP row
        return { otpSentTo: email, resendAfterSec: 60 };
      }
      return requestOtp({ ...input, userId: user.id });
    }
    // phone-based REGISTER: just proceed
    return requestOtp(input);
  }

  if (input.purpose === 'RESET') {
    // Only send if any user exists
    if (email) {
      const user = await db.user.findUnique({ where: { email } });
      if (!user) {
        return { otpSentTo: email, resendAfterSec: 60 };
      }
      return requestOtp({ ...input, userId: user.id });
    }
    return requestOtp(input);
  }

  return requestOtp(input);
}

// ─── Request OTP ──────────────────────────────────────────────────────────────

export async function requestOtp(input: {
  email?: string;
  phone?: string;
  purpose: OtpPurpose;
  channel?: OtpChannel;
  userId?: string;
  lang: 'ar' | 'en';
}) {
  const channel: OtpChannel = input.channel ?? 'EMAIL';

  // Check channel enabled
  const flagKey = `flags.otp.${channel.toLowerCase()}`;
  const enabled = await settings.get<boolean>(flagKey, false);
  if (!enabled) throw E.rule('OTP_CHANNEL_DISABLED');

  // Cooldown check
  const whereClause = input.email
    ? { email: input.email, purpose: input.purpose }
    : { phone: input.phone, purpose: input.purpose };

  const recent = await db.otpCode.findFirst({
    where: { ...whereClause, usedAt: null },
    orderBy: { sentAt: 'desc' },
  });

  if (recent && Date.now() - recent.sentAt.getTime() < OTP_COOLDOWN_MS) {
    const retryAfterSec = Math.ceil(
      (OTP_COOLDOWN_MS - (Date.now() - recent.sentAt.getTime())) / 1000,
    );
    throw E.rule('OTP_COOLDOWN', { retryAfterSec });
  }

  // Invalidate old codes
  await db.otpCode.updateMany({
    where: { ...whereClause, usedAt: null },
    data: { usedAt: new Date() },
  });

  const code = generateOtp();
  const codeHash = hashOtp(code, env.OTP_PEPPER);
  const expiresAt = new Date(Date.now() + OTP_TTL_MS);

  await db.otpCode.create({
    data: {
      email: input.email,
      phone: input.phone,
      userId: input.userId,
      purpose: input.purpose,
      channel,
      codeHash,
      expiresAt,
    },
  });

  // Record analytics
  await db.analyticsEvent.create({
    data: { type: 'otp_requested', props: { purpose: input.purpose, channel } },
  }).catch(() => {});

  // Send
  const otpSentTo = input.email ?? input.phone ?? '';
  if (channel === 'EMAIL' && input.email) {
    await sendOtpEmail(input.email, code, input.purpose, input.lang);
  } else if (channel === 'SMS' && input.phone) {
    await sendSms(input.phone, `MARBOU OTP: ${code}`);
  } else if (channel === 'WHATSAPP' && input.phone) {
    await sendWhatsAppOtp(input.phone, code);
  }

  return { otpSentTo, resendAfterSec: 60 };
}

// ─── Verify OTP ───────────────────────────────────────────────────────────────

export async function verifyOtp(input: {
  email?: string;
  phone?: string;
  code: string;
  purpose: OtpPurpose;
  device?: { id?: string; name?: string; os?: string };
  ip?: string;
  lang: 'ar' | 'en';
}) {
  const whereClause = input.email
    ? { email: input.email, purpose: input.purpose }
    : { phone: input.phone, purpose: input.purpose };

  const otp = await db.otpCode.findFirst({
    where: { ...whereClause, usedAt: null },
    orderBy: { sentAt: 'desc' },
  });

  if (!otp) throw E.badRequest('OTP_INVALID');
  if (otp.attempts >= OTP_MAX_ATTEMPTS) throw E.tooMany('OTP_ATTEMPTS_EXCEEDED');
  if (otp.expiresAt < new Date()) throw E.badRequest('OTP_EXPIRED');

  const expected = hashOtp(input.code, env.OTP_PEPPER);
  if (otp.codeHash !== expected) {
    await db.otpCode.update({ where: { id: otp.id }, data: { attempts: { increment: 1 } } });
    const remaining = OTP_MAX_ATTEMPTS - otp.attempts - 1;
    if (remaining <= 0) throw E.tooMany('OTP_ATTEMPTS_EXCEEDED');
    throw E.badRequest('OTP_INVALID');
  }

  await db.otpCode.update({ where: { id: otp.id }, data: { usedAt: new Date() } });

  const verifiedAt = new Date();

  // Record analytics
  const timeToVerifySec = Math.round((verifiedAt.getTime() - otp.sentAt.getTime()) / 1000);
  await db.analyticsEvent.create({
    data: { type: 'otp_verified', props: { purpose: input.purpose, timeToVerifySec } },
  }).catch(() => {});

  if (input.purpose === 'REGISTER') {
    // Find user by email
    const user = await db.user.findUnique({ where: { email: input.email! } });
    if (!user) throw E.notFound('USER_NOT_FOUND');

    await db.user.update({
      where: { id: user.id },
      data: { emailVerifiedAt: verifiedAt },
    });

    return issueTokens(user.id, input.device ?? {}, input.ip);
  }

  return { verified: true };
}

// ─── Login ────────────────────────────────────────────────────────────────────

export async function login(input: {
  email: string;
  password: string;
  device: { id?: string; name?: string; os?: string };
  ip: string;
  lang: 'ar' | 'en';
}) {
  const email = input.email.toLowerCase();

  // Lockout check
  try {
    await checkLockout(email, input.ip);
  } catch (lockErr) {
    // Record LOCKED outcome (not BAD_PASSWORD) so it doesn't escalate fails
    await recordLoginEvent({ email, outcome: 'LOCKED', ip: input.ip, device: input.device });
    throw lockErr;
  }

  const user = await db.user.findUnique({ where: { email } });

  if (!user || !user.passwordHash) {
    await recordLoginEvent({ email, outcome: 'BAD_PASSWORD', ip: input.ip, device: input.device });
    throw E.unauthorized('INVALID_CREDENTIALS');
  }

  const valid = await bcrypt.compare(input.password, user.passwordHash);
  if (!valid) {
    await recordLoginEvent({ userId: user.id, email, outcome: 'BAD_PASSWORD', ip: input.ip, device: input.device });
    throw E.unauthorized('INVALID_CREDENTIALS');
  }

  if (user.status === 'SUSPENDED') {
    await recordLoginEvent({ userId: user.id, email, outcome: 'SUSPENDED', ip: input.ip, device: input.device });
    throw E.forbidden('ACCOUNT_SUSPENDED');
  }

  // Reactivate deactivated accounts
  if (user.status === 'DEACTIVATED') {
    await db.user.update({ where: { id: user.id }, data: { status: 'ACTIVE', deactivatedAt: null } });
  }

  await recordLoginEvent({ userId: user.id, email, outcome: 'SUCCESS', ip: input.ip, device: input.device });

  const tokens = await issueTokens(user.id, input.device, input.ip);

  if (user.status === 'PENDING_DELETION') {
    return { ...tokens, pendingDeletion: true };
  }

  return tokens;
}

// ─── Refresh ──────────────────────────────────────────────────────────────────

export async function refreshTokens(refreshToken: string, ip?: string) {
  const hash = sha256(refreshToken);

  const session = await db.session.findFirst({ where: { refreshHash: hash } });
  if (!session) {
    // Check for reuse
    const reused = await db.session.findFirst({ where: { prevRefreshHash: hash } });
    if (reused) {
      await db.session.updateMany({
        where: { familyId: reused.familyId },
        data: { revokedAt: new Date() },
      });
      invalidateUserSessions(reused.userId);
      throw E.unauthorized('REFRESH_REUSED');
    }
    throw E.unauthorized('INVALID_REFRESH');
  }

  if (session.revokedAt) throw E.unauthorized('SESSION_REVOKED');

  const user = await db.user.findUnique({ where: { id: session.userId } });
  if (!user || user.status === 'SUSPENDED') throw E.forbidden('ACCOUNT_SUSPENDED');

  const nextRaw = randomToken();
  const nextHash = sha256(nextRaw);

  await db.session.update({
    where: { id: session.id },
    data: { prevRefreshHash: hash, refreshHash: nextHash, lastActiveAt: new Date(), ip },
  });

  invalidateSessionCache(session.id);

  const accessToken = jwt.sign(
    { sub: session.userId, sid: session.id, fam: session.familyId },
    env.JWT_USER_SECRET,
    { expiresIn: '15m' },
  );

  return { accessToken, refreshToken: nextRaw, expiresIn: 900 };
}

// ─── Logout ───────────────────────────────────────────────────────────────────

export async function logout(sessionId: string): Promise<void> {
  await db.session.update({ where: { id: sessionId }, data: { revokedAt: new Date() } });
  invalidateSessionCache(sessionId);
}

// ─── Social login ─────────────────────────────────────────────────────────────

export async function socialLogin(input: {
  provider: string;
  token: string;
  device: { id?: string; name?: string; os?: string };
  ip?: string;
  lang: 'ar' | 'en';
}) {
  let profile;
  try {
    profile = await verifySocialToken(input.provider, input.token);
  } catch (err) {
    const msg = err instanceof Error ? err.message : '';
    if (msg === 'INVALID_PROVIDER') throw E.badRequest('INVALID_PROVIDER');
    throw E.badRequest('SOCIAL_TOKEN_INVALID');
  }

  // B06: treat any privaterelay email as unverified regardless of provider
  if (profile.email?.endsWith('@privaterelay.appleid.com')) {
    profile = { ...profile, email: undefined, emailVerified: false };
  }

  // Find by social identity
  const existing = await db.socialIdentity.findUnique({
    where: { provider_providerId: { provider: input.provider, providerId: profile.providerId } },
    include: { user: true },
  });

  if (existing) {
    const user = existing.user;
    if (user.status === 'SUSPENDED') throw E.forbidden('ACCOUNT_SUSPENDED');
    if (user.status === 'DEACTIVATED') {
      await db.user.update({ where: { id: user.id }, data: { status: 'ACTIVE', deactivatedAt: null } });
    }
    return issueTokens(user.id, input.device, input.ip);
  }

  // B06: Link by verified email
  if (profile.email && profile.emailVerified) {
    const byEmail = await db.user.findUnique({ where: { email: profile.email.toLowerCase() } });
    if (byEmail) {
      // B06: reject SUSPENDED on link path
      if (byEmail.status === 'SUSPENDED') throw E.forbidden('ACCOUNT_SUSPENDED');
      // B06: pre-registration takeover protection — if existing account email not verified, verify it now
      const updates: Record<string, unknown> = {};
      if (!byEmail.emailVerifiedAt) {
        updates.emailVerifiedAt = new Date();
        updates.passwordHash = null; // clear unverified password
        // Revoke existing sessions
        await db.session.updateMany({ where: { userId: byEmail.id, revokedAt: null }, data: { revokedAt: new Date() } });
        invalidateUserSessions(byEmail.id);
      }
      await db.socialIdentity.create({
        data: { userId: byEmail.id, provider: input.provider, providerId: profile.providerId, email: profile.email },
      });
      if (Object.keys(updates).length) {
        await db.user.update({ where: { id: byEmail.id }, data: updates });
      }
      return issueTokens(byEmail.id, input.device, input.ip);
    }
  }

  // Create new user
  const needsEmail = !profile.email || !profile.emailVerified;
  const user = await db.user.create({
    data: {
      email: profile.email && profile.emailVerified ? profile.email.toLowerCase() : null,
      emailVerifiedAt: profile.emailVerified ? new Date() : null,
      fullName: profile.name ?? 'User',
    },
  });

  await db.socialIdentity.create({
    data: { userId: user.id, provider: input.provider, providerId: profile.providerId, email: profile.email },
  });

  const tokens = await issueTokens(user.id, input.device, input.ip);
  return { ...tokens, needsEmail };
}

// ─── Password reset ───────────────────────────────────────────────────────────

export async function forgotPassword(email: string, lang: 'ar' | 'en'): Promise<void> {
  const user = await db.user.findUnique({ where: { email: email.toLowerCase() } });
  if (!user) return; // always 200

  await requestOtp({ email: email.toLowerCase(), purpose: 'RESET', channel: 'EMAIL', userId: user.id, lang });
}

export async function resetPassword(input: {
  email: string;
  code: string;
  newPassword: string;
  lang: 'ar' | 'en';
}): Promise<void> {
  validatePassword(input.newPassword);
  await verifyOtp({ email: input.email.toLowerCase(), code: input.code, purpose: 'RESET', lang: input.lang });

  const user = await db.user.findUnique({ where: { email: input.email.toLowerCase() } });
  if (!user) throw E.notFound('USER_NOT_FOUND');

  const passwordHash = await bcrypt.hash(input.newPassword, BCRYPT_ROUNDS);
  await db.user.update({ where: { id: user.id }, data: { passwordHash } });

  // Revoke all sessions
  await db.session.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } });
  invalidateUserSessions(user.id);
}

// ─── Change password ──────────────────────────────────────────────────────────

export async function changePassword(userId: string, currentPw: string, newPw: string, currentSessionId?: string): Promise<void> {
  validatePassword(newPw);
  const user = await db.user.findUniqueOrThrow({ where: { id: userId } });
  if (!user.passwordHash) throw E.badRequest('WRONG_PASSWORD');
  const valid = await bcrypt.compare(currentPw, user.passwordHash);
  if (!valid) throw E.badRequest('WRONG_PASSWORD');
  if (currentPw === newPw) throw E.badRequest('SAME_PASSWORD');
  const passwordHash = await bcrypt.hash(newPw, BCRYPT_ROUNDS);
  await db.user.update({ where: { id: userId }, data: { passwordHash } });
  // Revoke all OTHER sessions (B10)
  const sessions = await db.session.findMany({
    where: { userId, revokedAt: null, ...(currentSessionId ? { id: { not: currentSessionId } } : {}) },
  });
  if (sessions.length > 0) {
    await db.session.updateMany({
      where: { id: { in: sessions.map((s) => s.id) } },
      data: { revokedAt: new Date() },
    });
    for (const s of sessions) invalidateSessionCache(s.id);
  }
}

// ─── Change email ─────────────────────────────────────────────────────────────

export async function requestEmailChange(userId: string, newEmail: string, lang: 'ar' | 'en') {
  const email = newEmail.toLowerCase();
  const user = await db.user.findUniqueOrThrow({ where: { id: userId } });
  if (user.email === email) throw E.badRequest('SAME_EMAIL');
  const taken = await db.user.findUnique({ where: { email } });
  if (taken) throw E.conflict('EMAIL_TAKEN');
  return requestOtp({ email, purpose: 'CHANGE_EMAIL', channel: 'EMAIL', userId, lang });
}

export async function confirmEmailChange(userId: string, newEmail: string, code: string, lang: 'ar' | 'en'): Promise<void> {
  const email = newEmail.toLowerCase().trim();
  await verifyOtp({ email, code, purpose: 'CHANGE_EMAIL', lang });
  await db.user.update({ where: { id: userId }, data: { email, emailVerifiedAt: new Date() } });
  // Invalidate session cache so requireVerifiedEmail sees the new state immediately (B05)
  invalidateUserSessions(userId);
}

// ─── Sessions ─────────────────────────────────────────────────────────────────

export async function listSessions(userId: string, currentSessionId?: string) {
  const sessions = await db.session.findMany({
    where: { userId, revokedAt: null },
    orderBy: { lastActiveAt: 'desc' },
    select: { id: true, deviceId: true, deviceName: true, os: true, ip: true, approxLocation: true, lastActiveAt: true, createdAt: true },
  });
  return sessions.map((s) => ({ ...s, isCurrent: s.id === currentSessionId }));
}

export async function revokeSession(userId: string, sessionId: string): Promise<void> {
  const session = await db.session.findUnique({ where: { id: sessionId } });
  if (!session || session.userId !== userId) throw E.notFound('SESSION_NOT_FOUND');
  await db.session.update({ where: { id: sessionId }, data: { revokedAt: new Date() } });
  invalidateSessionCache(sessionId);
}

export async function revokeOtherSessions(userId: string, currentSessionId: string): Promise<void> {
  const sessions = await db.session.findMany({
    where: { userId, revokedAt: null, id: { not: currentSessionId } },
  });
  await db.session.updateMany({
    where: { userId, revokedAt: null, id: { not: currentSessionId } },
    data: { revokedAt: new Date() },
  });
  for (const s of sessions) invalidateSessionCache(s.id);
}

export async function listLoginEvents(userId: string) {
  return db.loginEvent.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: 20,
    select: { id: true, outcome: true, ip: true, deviceName: true, createdAt: true },
  });
}

// ─── Phone ────────────────────────────────────────────────────────────────────

export async function updatePhone(userId: string, phone: string): Promise<void> {
  const normalised = validatePhone(phone);
  // Never alter verifiedPhone (B09)
  await db.user.update({ where: { id: userId }, data: { phone: normalised } });
}

export async function requestPhoneOtp(userId: string, phone: string, lang: 'ar' | 'en') {
  const normalised = validatePhone(phone);
  const smsEnabled = await settings.get<boolean>('flags.otp.sms', false);
  const waEnabled = await settings.get<boolean>('flags.otp.whatsapp', false);
  if (!smsEnabled && !waEnabled) throw E.notFound();
  const channel: OtpChannel = smsEnabled ? 'SMS' : 'WHATSAPP';
  return requestOtp({ phone: normalised, purpose: 'PHONE', channel, userId, lang });
}

export async function verifyPhone(userId: string, phone: string, code: string, lang: 'ar' | 'en'): Promise<void> {
  const normalised = validatePhone(phone);
  await verifyOtp({ phone: normalised, code, purpose: 'PHONE', lang });
  // Only update verifiedPhone, never phone (B09)
  await db.user.update({ where: { id: userId }, data: { verifiedPhone: normalised } });
  invalidateUserSessions(userId); // B05
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function checkLockout(email: string, ip: string): Promise<void> {
  const lockoutCfg = await settings.get<{ maxFails: number; delaysMin: number[] }>('auth.lockout', {
    maxFails: 5,
    delaysMin: [1, 5, 15, 60],
  });

  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

  // Find last SUCCESS for this email to bound the window
  const lastSuccess = await db.loginEvent.findFirst({
    where: { email, outcome: 'SUCCESS' },
    orderBy: { createdAt: 'desc' },
  });
  const failsSince = lastSuccess ? lastSuccess.createdAt : since24h;

  const emailFails = await db.loginEvent.count({
    where: { email, outcome: 'BAD_PASSWORD', createdAt: { gt: failsSince } },
  });

  if (emailFails >= lockoutCfg.maxFails) {
    const lastFail = await db.loginEvent.findFirst({
      where: { email, outcome: 'BAD_PASSWORD' },
      orderBy: { createdAt: 'desc' },
    });
    if (lastFail) {
      const extra = emailFails - lockoutCfg.maxFails;
      const delayMin = lockoutCfg.delaysMin[Math.min(extra, lockoutCfg.delaysMin.length - 1)];
      const unlockAt = lastFail.createdAt.getTime() + delayMin * 60 * 1000;
      if (Date.now() < unlockAt) {
        const retryAfterSec = Math.ceil((unlockAt - Date.now()) / 1000);
        throw E.tooMany('ACCOUNT_LOCKED', { retryAfterSec });
      }
    }
  }

  // Per-IP: higher threshold (20 fails in 10 min)
  const ipSince = new Date(Date.now() - 10 * 60 * 1000);
  const ipFails = await db.loginEvent.count({
    where: { ip, outcome: 'BAD_PASSWORD', createdAt: { gte: ipSince } },
  });
  if (ipFails >= 20) {
    throw E.tooMany('ACCOUNT_LOCKED', { retryAfterSec: 60 });
  }
}

async function recordLoginEvent(input: {
  userId?: string;
  email: string;
  outcome: string;
  ip: string;
  device: { id?: string; name?: string; os?: string };
}): Promise<void> {
  await db.loginEvent.create({
    data: {
      userId: input.userId,
      email: input.email,
      outcome: input.outcome,
      ip: input.ip,
      deviceId: input.device.id,
      deviceName: input.device.name,
    },
  });
}

export function serializeUser(user: {
  id: string;
  email: string | null;
  emailVerifiedAt: Date | null;
  fullName: string;
  avatarUrl: string | null;
  language: string;
  status: string;
  capabilities: string[];
  badges: string[];
  countryCode: string;
}) {
  return {
    id: user.id,
    email: user.email,
    emailVerified: !!user.emailVerifiedAt,
    fullName: user.fullName,
    avatarUrl: user.avatarUrl,
    language: user.language,
    status: user.status,
    capabilities: user.capabilities,
    badges: user.badges,
    countryCode: user.countryCode,
  };
}
