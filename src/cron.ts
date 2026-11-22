import cron from 'node-cron';
import { db } from './shared/db';
import { runCron } from './config/env';

async function purgeExpiredOtps(): Promise<void> {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const result = await db.otpCode.deleteMany({
    where: {
      OR: [{ usedAt: { not: null } }, { expiresAt: { lt: new Date() } }],
      sentAt: { lt: cutoff },
    },
  });
  if (result.count > 0) console.log(`[cron] Purged ${result.count} expired OTPs`);
}

async function expireListings(): Promise<void> {
  const { expireListings: expire } = await import('./modules/listings/write');
  const count = await expire();
  if (count > 0) console.log(`[cron] Expired ${count} listings`);
}

async function cleanOrphanMedia(): Promise<void> {
  const { cleanOrphanMedia: clean } = await import('./modules/media/service');
  const count = await clean();
  if (count > 0) console.log(`[cron] Cleaned ${count} orphan media assets`);
}

export function startCron(): void {
  if (!runCron) return;

  // Every 15 min: expire listings
  cron.schedule('*/15 * * * *', () => {
    expireListings().catch((e) => console.error('[cron] expire listings error:', e));
  });

  // Daily at 03:00 UTC: purge used/expired OTPs older than 24h
  cron.schedule('0 3 * * *', () => {
    purgeExpiredOtps().catch((e) => console.error('[cron] OTP purge error:', e));
  });

  // Daily at 04:00 UTC: clean orphan media
  cron.schedule('0 4 * * *', () => {
    cleanOrphanMedia().catch((e) => console.error('[cron] orphan media error:', e));
  });

  console.log('[cron] Scheduler started');
}
