import cron from 'node-cron';
import { db } from './shared/db';
import { notify } from './shared/notify';
import { runCron } from './config/env';

async function purgeExpiredOtps(): Promise<void> {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const result = await db.otpCode.deleteMany({
    where: { OR: [{ usedAt: { not: null } }, { expiresAt: { lt: new Date() } }], sentAt: { lt: cutoff } },
  });
  if (result.count > 0) console.log(`[cron] Purged ${result.count} expired OTPs`);
}

async function expireListingsJob(): Promise<void> {
  const { expireListings } = await import('./modules/listings/write');
  const count = await expireListings();
  if (count > 0) console.log(`[cron] Expired ${count} listings`);
}

async function cleanOrphanMediaJob(): Promise<void> {
  const { cleanOrphanMedia } = await import('./modules/media/service');
  const count = await cleanOrphanMedia();
  if (count > 0) console.log(`[cron] Cleaned ${count} orphan media assets`);
}

async function sweepPendingReview(): Promise<void> {
  const { scanListing } = await import('./modules/listings/scan');
  const cutoff = new Date(Date.now() - 2 * 60 * 1000);
  const stuck = await db.listing.findMany({
    where: { status: 'PENDING_REVIEW', createdAt: { lt: cutoff } },
    select: { id: true },
    take: 50,
  });
  for (const l of stuck) {
    await scanListing(l.id).catch((e) => console.error('[cron] sweep scan error:', e));
  }
  if (stuck.length > 0) console.log(`[cron] Swept ${stuck.length} PENDING_REVIEW listings`);
}

export async function runExpiryReminders(): Promise<void> {
  const now = new Date();
  const in7d = new Date(now.getTime() + 7 * 86400000);
  const in1d = new Date(now.getTime() + 1 * 86400000);

  // 7-day reminders
  const expiring7 = await db.listing.findMany({
    where: { status: 'ACTIVE', deletedAt: null, reminded7: false, expiresAt: { lte: in7d, gt: in1d } },
    select: { id: true, ownerId: true, title: true, expiresAt: true },
    take: 200,
  });
  for (const l of expiring7) {
    const days = Math.ceil((l.expiresAt!.getTime() - now.getTime()) / 86400000);
    await notify(l.ownerId, 'listing_expiring', { title: l.title, days }, { dedupeKey: `le7:${l.id}`, data: { listingId: l.id } });
    await db.listing.update({ where: { id: l.id }, data: { reminded7: true } });
  }

  // 1-day reminders
  const expiring1 = await db.listing.findMany({
    where: { status: 'ACTIVE', deletedAt: null, reminded1: false, expiresAt: { lte: in1d, gt: now } },
    select: { id: true, ownerId: true, title: true, expiresAt: true },
    take: 200,
  });
  for (const l of expiring1) {
    const days = Math.ceil((l.expiresAt!.getTime() - now.getTime()) / 86400000);
    await notify(l.ownerId, 'listing_expiring', { title: l.title, days }, { dedupeKey: `le1:${l.id}`, data: { listingId: l.id } });
    await db.listing.update({ where: { id: l.id }, data: { reminded1: true } });
  }

  if (expiring7.length + expiring1.length > 0) {
    console.log(`[cron] Sent ${expiring7.length} 7-day and ${expiring1.length} 1-day expiry reminders`);
  }
}

export async function runResponseRateJob(): Promise<void> {
  const since = new Date(Date.now() - 30 * 86400000);
  const sellers = await db.chatThread.groupBy({
    by: ['sellerId'],
    where: { createdAt: { gte: since } },
    _count: { id: true },
  });

  for (const row of sellers) {
    const sellerId = row.sellerId;
    const threads = await db.chatThread.findMany({
      where: { sellerId, createdAt: { gte: since } },
      select: { id: true, createdAt: true },
    });

    let replied = 0;
    let totalDelayMs = 0;
    let repliedCount = 0;

    for (const t of threads) {
      const firstReply = await db.chatMessage.findFirst({
        where: { threadId: t.id, senderId: sellerId },
        orderBy: { sentAt: 'asc' },
      });
      if (firstReply) {
        const delayMs = firstReply.sentAt.getTime() - t.createdAt.getTime();
        if (delayMs <= 86400000) { replied++; totalDelayMs += delayMs; repliedCount++; }
      }
    }

    const responseRate = threads.length > 0 ? replied / threads.length : null;
    const avgResponseMin = repliedCount > 0 ? Math.round(totalDelayMs / repliedCount / 60000) : null;

    await db.user.update({
      where: { id: sellerId },
      data: { responseRate, avgResponseMin } as never,
    });
  }

  if (sellers.length > 0) console.log(`[cron] Updated response rates for ${sellers.length} sellers`);
}

async function runDailyDigest(): Promise<void> {
  // DAILY saved-search digest — minimal: find DAILY searches and notify if there are new matches
  const searches = await db.savedSearch.findMany({
    where: { frequency: 'DAILY' },
  });
  const { searchListings } = await import('./modules/search/service');
  for (const ss of searches) {
    try {
      const result = await searchListings(ss.query as never, ss.userId);
      if (result.items.length > 0) {
        await notify(ss.userId, 'saved_search_match',
          { name: ss.name, title: `${result.items.length} new listing(s)` },
          { dedupeKey: `ssd:${ss.id}:${new Date().toISOString().slice(0, 10)}`, data: { savedSearchId: ss.id } },
        );
        await db.savedSearch.update({ where: { id: ss.id }, data: { lastNotifiedAt: new Date() } });
      }
    } catch { /* ignore per-search errors */ }
  }
}

export function startCron(): void {
  if (!runCron) return;

  cron.schedule('*/15 * * * *', () => {
    expireListingsJob().catch((e) => console.error('[cron] expire listings error:', e));
  });

  cron.schedule('0 * * * *', () => {
    runExpiryReminders().catch((e) => console.error('[cron] expiry reminders error:', e));
  });

  cron.schedule('0 3 * * *', () => {
    purgeExpiredOtps().catch((e) => console.error('[cron] OTP purge error:', e));
  });

  cron.schedule('0 4 * * *', () => {
    cleanOrphanMediaJob().catch((e) => console.error('[cron] orphan media error:', e));
  });

  cron.schedule('*/5 * * * *', () => {
    sweepPendingReview().catch((e) => console.error('[cron] sweep error:', e));
  });

  cron.schedule('0 2 * * *', () => {
    runResponseRateJob().catch((e) => console.error('[cron] response rate error:', e));
  });

  cron.schedule('0 6 * * *', () => {
    runDailyDigest().catch((e) => console.error('[cron] daily digest error:', e));
  });

  console.log('[cron] Scheduler started');
}
