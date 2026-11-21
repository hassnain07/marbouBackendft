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

export function startCron(): void {
  if (!runCron) return;

  // Daily at 03:00 UTC: purge used/expired OTPs older than 24h
  cron.schedule('0 3 * * *', () => {
    purgeExpiredOtps().catch((e) => console.error('[cron] OTP purge error:', e));
  });

  console.log('[cron] Scheduler started');
}
