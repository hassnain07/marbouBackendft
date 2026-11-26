import { randomUUID } from 'crypto';
import { db } from '../../shared/db';
import { E } from '../../shared/errors';
import { settings } from '../../shared/settings';
import { notify } from '../../shared/notify';
import { cleanText } from '../listings/create';

// ─── Socket room helper (set by sockets/chat.ts) ──────────────────────────────
let _isUserInRoom: (userId: string, threadId: string) => boolean = () => false;
export function setRoomChecker(fn: (userId: string, threadId: string) => boolean): void {
  _isUserInRoom = fn;
}
export function isUserInThreadRoom(userId: string, threadId: string): boolean {
  return _isUserInRoom(userId, threadId);
}

let _emit: (event: string, room: string, data: unknown) => void = () => {};
export function setEmitter(fn: (event: string, room: string, data: unknown) => void): void {
  _emit = fn;
}

async function assertParticipant(threadId: string, userId: string) {
  const thread = await db.chatThread.findUnique({ where: { id: threadId } });
  if (!thread || (thread.buyerId !== userId && thread.sellerId !== userId)) {
    throw E.notFound('THREAD_NOT_FOUND');
  }
  return thread;
}

function recipientId(thread: { buyerId: string; sellerId: string }, senderId: string): string {
  return thread.buyerId === senderId ? thread.sellerId : thread.buyerId;
}

export async function getOrCreateThread(buyerId: string, listingId: string, firstMessage?: string) {
  const listing = await db.listing.findUnique({
    where: { id: listingId },
    include: { owner: { select: { id: true, status: true } } },
  });
  if (!listing || listing.deletedAt || listing.status !== 'ACTIVE') throw E.rule('LISTING_UNAVAILABLE');
  if (listing.ownerId === buyerId) throw E.rule('CANNOT_MESSAGE_SELF');

  const contactOptions = listing.contactOptions as { call: boolean; whatsapp: boolean; chat: boolean };
  if (!contactOptions.chat) throw E.forbidden('CHAT_DISABLED');
  if (listing.owner.status !== 'ACTIVE') throw E.rule('LISTING_UNAVAILABLE');

  const block = await db.blockedUser.findFirst({
    where: { OR: [{ blockerId: buyerId, blockedId: listing.ownerId }, { blockerId: listing.ownerId, blockedId: buyerId }] },
  });
  if (block) throw E.forbidden('CANNOT_MESSAGE_USER');

  const existing = await db.chatThread.findFirst({
    where: { listingId, buyerId, sellerId: listing.ownerId },
  });

  if (existing) {
    if (firstMessage) await sendMessage(buyerId, existing.id, { type: 'TEXT', body: firstMessage });
    return { thread: existing, created: false };
  }

  const thread = await db.chatThread.create({
    data: { listingId, buyerId, sellerId: listing.ownerId },
  });
  if (firstMessage) await sendMessage(buyerId, thread.id, { type: 'TEXT', body: firstMessage });
  return { thread, created: true };
}

export async function getThreads(userId: string, role?: string, cursor?: string, limit = 20) {
  const offset = cursor ? parseInt(Buffer.from(cursor, 'base64url').toString(), 10) : 0;

  const blocks = await db.blockedUser.findMany({ where: { blockerId: userId }, select: { blockedId: true } });
  const blockedIds = blocks.map((b) => b.blockedId);

  const roleWhere = role === 'buyer' ? { buyerId: userId } : role === 'seller' ? { sellerId: userId } : { OR: [{ buyerId: userId }, { sellerId: userId }] };

  const threads = await db.chatThread.findMany({
    where: {
      ...roleWhere,
      AND: blockedIds.length > 0 ? [{ buyerId: { notIn: blockedIds } }, { sellerId: { notIn: blockedIds } }] : [],
    } as never,
    orderBy: { lastMessageAt: 'desc' },
    skip: offset,
    take: limit + 1,
    include: {
      buyer: { select: { id: true, fullName: true, avatarUrl: true, badges: true } },
      seller: { select: { id: true, fullName: true, avatarUrl: true, badges: true } },
      listing: { include: { media: { where: { isCover: true }, take: 1 } } },
      messages: { orderBy: { sentAt: 'desc' }, take: 1 },
    },
  });

  const hasMore = threads.length > limit;
  const slice = hasMore ? threads.slice(0, limit) : threads;

  const data = await Promise.all(slice.map(async (t) => {
    const counterpart = t.buyerId === userId ? t.seller : t.buyer;
    const isMuted = t.buyerId === userId ? t.isMutedByBuyer : t.isMutedBySeller;
    const unreadCount = await db.chatMessage.count({
      where: { threadId: t.id, senderId: { not: userId }, readAt: null },
    });
    const l = t.listing;
    let listingInfo: unknown = null;
    if (l) {
      const state = l.deletedAt ? 'REMOVED' : l.status === 'SOLD' ? 'SOLD' : l.status === 'EXPIRED' ? 'EXPIRED' : l.status === 'ACTIVE' ? 'ACTIVE' : 'REMOVED';
      listingInfo = { id: l.id, readableId: `MARBOU-${String(l.publicSeq).padStart(5, '0')}`, title: l.title, cover: l.media[0]?.url ?? null, price: l.price, currency: l.currency, state };
    }
    return {
      id: t.id, counterpart, listing: listingInfo,
      lastMessage: t.messages[0] ? { body: t.messages[0].body, type: t.messages[0].type, sentAt: t.messages[0].sentAt, senderId: t.messages[0].senderId } : null,
      unreadCount, isMuted, lastMessageAt: t.lastMessageAt, createdAt: t.createdAt,
    };
  }));

  const nextCursor = hasMore ? Buffer.from(String(offset + limit)).toString('base64url') : null;
  return { data, nextCursor, hasMore };
}

export async function getThread(threadId: string, userId: string) {
  const thread = await db.chatThread.findUnique({
    where: { id: threadId },
    include: {
      buyer: { select: { id: true, fullName: true, avatarUrl: true, badges: true } },
      seller: { select: { id: true, fullName: true, avatarUrl: true, badges: true } },
      listing: { include: { media: { where: { isCover: true }, take: 1 } } },
    },
  });
  if (!thread || (thread.buyerId !== userId && thread.sellerId !== userId)) throw E.notFound('THREAD_NOT_FOUND');
  return thread;
}

export async function getMessages(threadId: string, userId: string, opts: { after?: string; before?: string; limit?: number } = {}) {
  await assertParticipant(threadId, userId);
  const limit = Math.min(opts.limit ?? 30, 50);
  const where: Record<string, unknown> = { threadId };
  if (opts.after) {
    const ref = await db.chatMessage.findUnique({ where: { id: opts.after }, select: { sentAt: true } });
    if (ref) where.sentAt = { gt: ref.sentAt };
  }
  if (opts.before) {
    const ref = await db.chatMessage.findUnique({ where: { id: opts.before }, select: { sentAt: true } });
    if (ref) where.sentAt = { lt: ref.sentAt };
  }
  const messages = await db.chatMessage.findMany({
    where: where as never,
    orderBy: { sentAt: 'asc' },
    take: limit,
    include: { offer: true },
  });
  return { data: messages };
}

export async function getUnreadCount(userId: string) {
  const threads = await db.chatThread.findMany({ where: { OR: [{ buyerId: userId }, { sellerId: userId }] }, select: { id: true } });
  const threadIds = threads.map((t) => t.id);
  if (threadIds.length === 0) return { count: 0, byThread: {} };
  const counts = await db.chatMessage.groupBy({
    by: ['threadId'],
    where: { threadId: { in: threadIds }, senderId: { not: userId }, readAt: null },
    _count: { id: true },
  });
  const byThread: Record<string, number> = {};
  let total = 0;
  for (const c of counts) { byThread[c.threadId] = c._count.id; total += c._count.id; }
  return { count: total, byThread };
}

export async function markRead(threadId: string, userId: string) {
  await assertParticipant(threadId, userId);
  const now = new Date();
  await db.chatMessage.updateMany({ where: { threadId, senderId: { not: userId }, readAt: null }, data: { readAt: now } });
  _emit('message:read', `thread:${threadId}`, { threadId, readBy: userId, readAt: now });
  return { ok: true };
}

export async function muteThread(threadId: string, userId: string, muted: boolean) {
  const thread = await assertParticipant(threadId, userId);
  const data = thread.buyerId === userId ? { isMutedByBuyer: muted } : { isMutedBySeller: muted };
  await db.chatThread.update({ where: { id: threadId }, data });
  return { ok: true };
}

export async function sendMessage(
  senderId: string,
  threadId: string,
  input: { type: 'TEXT' | 'IMAGE'; body?: string; attachmentMediaId?: string; idempotencyKey?: string },
) {
  const thread = await assertParticipant(threadId, senderId);
  if (thread.closedReason) throw E.rule('LISTING_UNAVAILABLE');

  const recip = recipientId(thread, senderId);
  const block = await db.blockedUser.findFirst({
    where: { OR: [{ blockerId: senderId, blockedId: recip }, { blockerId: recip, blockedId: senderId }] },
  });
  if (block) throw E.forbidden('CANNOT_MESSAGE_USER');

  const perMin = await settings.get<number>('limits.messagesPerMinute', 20);
  const perRecipMin = await settings.get<number>('limits.messagesPerMinutePerRecipient', 10);
  const oneMinAgo = new Date(Date.now() - 60_000);

  const totalCount = await db.chatMessage.count({ where: { senderId, sentAt: { gte: oneMinAgo } } });
  if (totalCount >= perMin) throw E.tooMany('MESSAGE_RATE_LIMIT');

  const recipCount = await db.chatMessage.count({ where: { senderId, threadId, sentAt: { gte: oneMinAgo } } });
  if (recipCount >= perRecipMin) throw E.tooMany('MESSAGE_RATE_LIMIT');

  const bannedPhrases = await settings.get<string[]>('chat.bannedPhrases', []);
  const bodyLower = (input.body ?? '').toLowerCase();
  for (const phrase of bannedPhrases) {
    if (phrase && bodyLower.includes(phrase.toLowerCase())) throw E.rule('MESSAGE_BLOCKED');
  }

  if (input.type === 'TEXT') {
    if (!input.body || input.body.trim().length === 0) throw E.badRequest('VALIDATION_ERROR');
    if (input.body.length > 2000) throw E.badRequest('VALIDATION_ERROR');
  }

  let attachmentUrl: string | null = null;
  if (input.type === 'IMAGE') {
    if (!input.attachmentMediaId) throw E.badRequest('VALIDATION_ERROR');
    const asset = await db.mediaAsset.findUnique({ where: { id: input.attachmentMediaId } });
    if (!asset || asset.ownerId !== senderId || asset.kind !== 'IMAGE') throw E.badRequest('MEDIA_NOT_OWNED');
    attachmentUrl = asset.url ?? null;
    await db.mediaAsset.update({ where: { id: input.attachmentMediaId }, data: { attachedAt: new Date() } });
  }

  const idempotencyKey = input.idempotencyKey ?? randomUUID();
  const cleanBody = input.body ? cleanText(input.body) : null;

  // Spam detection
  const urlCount = (cleanBody ?? '').match(/https?:\/\//g)?.length ?? 0;
  let spamFlag = urlCount >= 3;
  if (!spamFlag && cleanBody) {
    const tenMinAgo = new Date(Date.now() - 600_000);
    const sameTextThreads = await db.chatMessage.findMany({
      where: { senderId, body: cleanBody, sentAt: { gte: tenMinAgo } },
      select: { threadId: true },
      distinct: ['threadId'],
    });
    if (sameTextThreads.length >= 3) spamFlag = true;
  }

  let message;
  try {
    message = await db.chatMessage.create({
      data: { threadId, senderId, type: input.type, body: cleanBody, attachmentUrl, idempotencyKey },
    });
  } catch (err: unknown) {
    if ((err as { code?: string }).code === 'P2002') {
      const existing = await db.chatMessage.findFirst({ where: { senderId, idempotencyKey } });
      return existing!;
    }
    throw err;
  }

  await db.chatThread.update({ where: { id: threadId }, data: { lastMessageAt: message.sentAt } });

  if (spamFlag) {
    db.analyticsEvent.create({ data: { type: 'chat_spam_flag', userId: senderId, props: { threadId, messageId: message.id } as never } }).catch(() => {});
  }

  _emit('message:new', `thread:${threadId}`, message);
  _emit('message:new', `user:${recip}`, message);

  if (_isUserInRoom(recip, threadId)) {
    await db.chatMessage.update({ where: { id: message.id }, data: { deliveredAt: new Date() } });
    _emit('message:delivered', `thread:${threadId}`, { messageId: message.id });
  }

  const isMuted = thread.buyerId === recip ? thread.isMutedByBuyer : thread.isMutedBySeller;
  if (!_isUserInRoom(recip, threadId) && !isMuted) {
    const sender = await db.user.findUnique({ where: { id: senderId }, select: { fullName: true } });
    const minuteBucket = Math.floor(Date.now() / 60_000);
    notify(recip, 'new_message',
      { senderName: sender?.fullName ?? '', preview: (cleanBody ?? '').slice(0, 60) },
      { dedupeKey: `msg:${threadId}:${minuteBucket}`, data: { threadId, messageId: message.id } },
    ).catch(() => {});
  }

  return message;
}

export async function makeOffer(senderId: string, threadId: string, amount: number, currency: string) {
  const thread = await assertParticipant(threadId, senderId);

  if (thread.listingId) {
    const listing = await db.listing.findUnique({ where: { id: thread.listingId }, select: { currency: true } });
    if (listing && listing.currency !== currency) throw E.rule('OFFER_CURRENCY_MISMATCH');
  }

  const pending = await db.offer.findFirst({ where: { threadId, status: 'PENDING' } });
  if (pending) throw E.conflict('OFFER_PENDING');

  const message = await db.chatMessage.create({
    data: { threadId, senderId, type: 'OFFER', body: `${amount} ${currency}`, idempotencyKey: randomUUID() },
  });
  const offer = await db.offer.create({
    data: { threadId, messageId: message.id, offeredById: senderId, amount, currency },
  });
  await db.chatThread.update({ where: { id: threadId }, data: { lastMessageAt: message.sentAt } });

  _emit('offer:updated', `thread:${threadId}`, { offer });

  const recip = recipientId(thread, senderId);
  const isMuted = thread.buyerId === recip ? thread.isMutedByBuyer : thread.isMutedBySeller;
  if (!isMuted) {
    notify(recip, 'new_offer', { amount, currency }, { dedupeKey: `offer:${offer.id}`, data: { threadId, offerId: offer.id } }).catch(() => {});
  }

  return { offer };
}

export async function respondOffer(userId: string, offerId: string, action: 'accept' | 'reject' | 'counter', counterAmount?: number) {
  const offer = await db.offer.findUnique({ where: { id: offerId }, include: { thread: true } });
  if (!offer) throw E.notFound('OFFER_NOT_FOUND');

  const thread = offer.thread;
  if (thread.buyerId !== userId && thread.sellerId !== userId) throw E.notFound('OFFER_NOT_FOUND');
  if (offer.offeredById === userId) throw E.notFound('OFFER_NOT_FOUND');
  if (offer.status !== 'PENDING') throw E.conflict('OFFER_NOT_PENDING');

  if (action === 'accept') {
    await db.offer.update({ where: { id: offerId }, data: { status: 'ACCEPTED' } });
    const sysMsg = await db.chatMessage.create({
      data: { threadId: thread.id, senderId: userId, type: 'SYSTEM', body: `Agreed price: ${offer.amount} ${offer.currency}`, idempotencyKey: randomUUID() },
    });
    await db.chatThread.update({ where: { id: thread.id }, data: { lastMessageAt: sysMsg.sentAt } });
    _emit('offer:updated', `thread:${thread.id}`, { offerId, status: 'ACCEPTED' });
    notify(offer.offeredById, 'offer_accepted', { amount: Number(offer.amount), currency: offer.currency }, { dedupeKey: `oa:${offerId}`, data: { threadId: thread.id, offerId } }).catch(() => {});
    return { offer: { id: offerId, status: 'ACCEPTED', amount: offer.amount, currency: offer.currency } };
  }

  if (action === 'reject') {
    await db.offer.update({ where: { id: offerId }, data: { status: 'REJECTED' } });
    _emit('offer:updated', `thread:${thread.id}`, { offerId, status: 'REJECTED' });
    notify(offer.offeredById, 'offer_rejected', { amount: Number(offer.amount), currency: offer.currency }, { dedupeKey: `or:${offerId}`, data: { threadId: thread.id, offerId } }).catch(() => {});
    return { offer: { id: offerId, status: 'REJECTED', amount: offer.amount, currency: offer.currency } };
  }

  if (counterAmount == null || counterAmount <= 0) throw E.badRequest('VALIDATION_ERROR');
  await db.offer.update({ where: { id: offerId }, data: { status: 'COUNTERED' } });
  const counterMsg = await db.chatMessage.create({
    data: { threadId: thread.id, senderId: userId, type: 'OFFER', body: `${counterAmount} ${offer.currency}`, idempotencyKey: randomUUID() },
  });
  const counterOffer = await db.offer.create({
    data: { threadId: thread.id, messageId: counterMsg.id, offeredById: userId, amount: counterAmount, currency: offer.currency, counterOfId: offerId },
  });
  await db.chatThread.update({ where: { id: thread.id }, data: { lastMessageAt: counterMsg.sentAt } });
  _emit('offer:updated', `thread:${thread.id}`, { offerId, status: 'COUNTERED', counterOffer });
  notify(offer.offeredById, 'offer_countered', { amount: counterAmount, currency: offer.currency }, { dedupeKey: `oc:${counterOffer.id}`, data: { threadId: thread.id, offerId: counterOffer.id } }).catch(() => {});
  return { offer: { id: counterOffer.id, status: 'PENDING', amount: counterAmount, currency: offer.currency } };
}

export async function getQuickReplies(userId: string) {
  const user = await db.user.findUnique({ where: { id: userId }, select: { quickReplies: true } });
  return (user?.quickReplies as unknown[]) ?? [];
}

export async function createQuickReply(userId: string, title: string, body: string) {
  const user = await db.user.findUnique({ where: { id: userId }, select: { quickReplies: true } });
  const replies = (user?.quickReplies as Array<{ id: string; title: string; body: string }>) ?? [];
  if (replies.length >= 20) throw E.rule('QUICK_REPLY_LIMIT');
  const newReply = { id: randomUUID(), title: title.slice(0, 40), body: body.slice(0, 500) };
  await db.user.update({ where: { id: userId }, data: { quickReplies: [...replies, newReply] as never } });
  return newReply;
}

export async function updateQuickReply(userId: string, replyId: string, title?: string, body?: string) {
  const user = await db.user.findUnique({ where: { id: userId }, select: { quickReplies: true } });
  const replies = (user?.quickReplies as Array<{ id: string; title: string; body: string }>) ?? [];
  const idx = replies.findIndex((r) => r.id === replyId);
  if (idx === -1) throw E.notFound('QUICK_REPLY_NOT_FOUND');
  if (title != null) replies[idx].title = title.slice(0, 40);
  if (body != null) replies[idx].body = body.slice(0, 500);
  await db.user.update({ where: { id: userId }, data: { quickReplies: replies as never } });
  return replies[idx];
}

export async function deleteQuickReply(userId: string, replyId: string) {
  const user = await db.user.findUnique({ where: { id: userId }, select: { quickReplies: true } });
  const replies = (user?.quickReplies as Array<{ id: string }>) ?? [];
  const filtered = replies.filter((r) => r.id !== replyId);
  if (filtered.length === replies.length) throw E.notFound('QUICK_REPLY_NOT_FOUND');
  await db.user.update({ where: { id: userId }, data: { quickReplies: filtered as never } });
  return { ok: true };
}
