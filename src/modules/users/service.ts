import { db } from '../../shared/db';
import { E } from '../../shared/errors';
import { audit } from '../../shared/audit';
import sanitizeHtml from 'sanitize-html';
import type { Capability } from '@prisma/client';

function sanitize(s: string): string {
  return sanitizeHtml(s, { allowedTags: [], allowedAttributes: {} });
}

// ─── Profile ──────────────────────────────────────────────────────────────────

export async function getMe(userId: string) {
  const user = await db.user.findUniqueOrThrow({ where: { id: userId } });
  return serializeMe(user);
}

export async function updateMe(userId: string, input: {
  fullName?: string;
  bio?: string;
  city?: string;
  languages?: string[];
  contactPrefs?: Record<string, unknown>;
  language?: string;
}) {
  const data: Record<string, unknown> = {};
  if (input.fullName !== undefined) data.fullName = sanitize(input.fullName);
  if (input.bio !== undefined) data.bio = sanitize(input.bio);
  if (input.city !== undefined) data.city = sanitize(input.city);
  if (input.languages !== undefined) {
    // B10: validate and size-limit languages array
    if (input.languages.length > 10) throw E.badRequest('TOO_MANY_LANGUAGES');
    data.languages = input.languages.map((l) => sanitize(String(l)).slice(0, 50));
  }
  if (input.contactPrefs !== undefined) {
    // B10: merge with existing contactPrefs instead of replacing
    const existing = await db.user.findUniqueOrThrow({ where: { id: userId }, select: { contactPrefs: true } });
    const current = (existing.contactPrefs as Record<string, unknown>) ?? {};
    data.contactPrefs = { ...current, ...input.contactPrefs };
  }
  if (input.language !== undefined) data.language = input.language.toUpperCase();

  const user = await db.user.update({ where: { id: userId }, data });
  return serializeMe(user);
}

// ─── Capabilities ─────────────────────────────────────────────────────────────

export async function getCapabilities(userId: string) {
  const user = await db.user.findUniqueOrThrow({ where: { id: userId }, select: { capabilities: true } });
  return { capabilities: user.capabilities };
}

export async function grantCapability(userId: string, capability: Capability, setup?: Record<string, unknown>) {
  const user = await db.user.findUniqueOrThrow({ where: { id: userId } });

  if (user.capabilities.includes(capability)) throw E.conflict('CAPABILITY_ALREADY_GRANTED');

  if (capability === 'DEALER') throw E.rule('BUSINESS_SETUP_REQUIRED');

  const updateData: Record<string, unknown> = {
    capabilities: { push: capability },
  };

  if (capability === 'EMPLOYER' && setup) {
    // B10: validate and size-limit employer setup JSON
    const str = JSON.stringify(setup);
    if (str.length > 4096) throw E.badRequest('SETUP_TOO_LARGE');
    updateData.employerProfile = setup as never;
  }
  if (capability === 'SERVICE_PROVIDER' && setup) {
    // B10: validate and size-limit service setup JSON
    const str = JSON.stringify(setup);
    if (str.length > 4096) throw E.badRequest('SETUP_TOO_LARGE');
    updateData.serviceProfile = setup as never;
  }

  await db.user.update({ where: { id: userId }, data: updateData });
  // B05: invalidate session cache so capability is usable immediately
  const { invalidateUserSessions } = await import('../../shared/auth');
  invalidateUserSessions(userId);
  return { capability, granted: true };
}

// ─── Public profile ───────────────────────────────────────────────────────────

export async function getPublicProfile(targetId: string) {
  const user = await db.user.findUnique({
    where: { id: targetId },
    select: {
      id: true, fullName: true, avatarUrl: true, bio: true, city: true,
      ratingAvg: true, ratingCount: true, responseRate: true, avgResponseMin: true,
      badges: true, capabilities: true, createdAt: true,
    },
  });
  if (!user) throw E.notFound('USER_NOT_FOUND');
  return { ...user, activeListingCount: 0 }; // slice 2 will fill this
}

// ─── Blocks ───────────────────────────────────────────────────────────────────

export async function blockUser(blockerId: string, blockedId: string): Promise<void> {
  if (blockerId === blockedId) throw E.badRequest('CANNOT_BLOCK_SELF');
  const target = await db.user.findUnique({ where: { id: blockedId } });
  if (!target) throw E.notFound('USER_NOT_FOUND');
  const existing = await db.blockedUser.findUnique({
    where: { blockerId_blockedId: { blockerId, blockedId } },
  });
  if (existing) throw E.conflict('ALREADY_BLOCKED');
  await db.blockedUser.create({ data: { blockerId, blockedId } });
}

export async function unblockUser(blockerId: string, blockedId: string): Promise<void> {
  const existing = await db.blockedUser.findUnique({
    where: { blockerId_blockedId: { blockerId, blockedId } },
  });
  if (!existing) throw E.notFound('NOT_BLOCKED');
  await db.blockedUser.delete({ where: { blockerId_blockedId: { blockerId, blockedId } } });
}

export async function getBlocks(userId: string) {
  const blocks = await db.blockedUser.findMany({
    where: { blockerId: userId },
    include: { blocked: { select: { id: true, fullName: true, avatarUrl: true } } },
    orderBy: { createdAt: 'desc' },
  });
  return blocks.map((b) => b.blocked);
}

// ─── Notification preferences ─────────────────────────────────────────────────

export async function getNotifPrefs(userId: string) {
  const user = await db.user.findUniqueOrThrow({ where: { id: userId }, select: { notifPrefs: true } });
  return user.notifPrefs;
}

export async function updateNotifPrefs(userId: string, prefs: Record<string, unknown>) {
  const user = await db.user.update({ where: { id: userId }, data: { notifPrefs: prefs as never } });
  return user.notifPrefs;
}

// ─── Device tokens ────────────────────────────────────────────────────────────

export async function addDeviceToken(userId: string, token: string, platform: string): Promise<void> {
  const user = await db.user.findUniqueOrThrow({ where: { id: userId }, select: { deviceTokens: true } });
  const tokens = (user.deviceTokens as { token: string; platform: string }[]) ?? [];
  if (!tokens.find((t) => t.token === token)) {
    tokens.push({ token, platform });
    await db.user.update({ where: { id: userId }, data: { deviceTokens: tokens as never } });
  }
}

export async function removeDeviceToken(userId: string, token: string): Promise<void> {
  const user = await db.user.findUniqueOrThrow({ where: { id: userId }, select: { deviceTokens: true } });
  const tokens = ((user.deviceTokens as { token: string; platform: string }[]) ?? []).filter(
    (t) => t.token !== token,
  );
  await db.user.update({ where: { id: userId }, data: { deviceTokens: tokens as never } });
}

// ─── Verification request ─────────────────────────────────────────────────────

export async function submitVerification(userId: string, kind: string, documentMediaIds: string[]) {
  // Check media ownership
  for (const mediaId of documentMediaIds) {
    const asset = await db.mediaAsset.findUnique({ where: { id: mediaId } });
    if (!asset) throw E.notFound('MEDIA_NOT_FOUND');
    if (asset.ownerId !== userId) throw E.forbidden('MEDIA_NOT_OWNED');
  }

  const existing = await db.verificationRequest.findFirst({
    where: { userId, status: 'PENDING' },
  });
  if (existing) throw E.conflict('VERIFICATION_PENDING');

  return db.verificationRequest.create({
    data: { userId, kind, documentKeys: documentMediaIds, status: 'PENDING' },
  });
}

export async function getVerification(userId: string) {
  return db.verificationRequest.findFirst({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    select: { id: true, kind: true, status: true, reason: true, createdAt: true, decidedAt: true },
  });
}

// ─── Serializers ──────────────────────────────────────────────────────────────

function serializeMe(user: {
  id: string; email: string | null; emailVerifiedAt: Date | null;
  phone: string | null; verifiedPhone: string | null; fullName: string;
  avatarUrl: string | null; coverUrl: string | null; bio: string | null;
  city: string | null; countryCode: string; languages: string[];
  contactPrefs: unknown; language: string; status: string; statusReason: string | null;
  capabilities: string[]; badges: string[]; notifPrefs: unknown;
  ratingAvg: number; ratingCount: number; responseRate: number | null;
  fraudScore: number; createdAt: Date;
}) {
  return {
    id: user.id,
    email: user.email,
    emailVerified: !!user.emailVerifiedAt,
    phone: user.phone,
    verifiedPhone: user.verifiedPhone,
    fullName: user.fullName,
    avatarUrl: user.avatarUrl,
    coverUrl: user.coverUrl,
    bio: user.bio,
    city: user.city,
    countryCode: user.countryCode,
    languages: user.languages,
    contactPrefs: user.contactPrefs,
    language: user.language,
    status: user.status,
    statusReason: user.statusReason,
    capabilities: user.capabilities,
    badges: user.badges,
    notifPrefs: user.notifPrefs,
    ratingAvg: user.ratingAvg,
    ratingCount: user.ratingCount,
    responseRate: user.responseRate,
    createdAt: user.createdAt,
  };
}

export { audit };
