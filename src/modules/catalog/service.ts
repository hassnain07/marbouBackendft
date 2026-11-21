import { db } from '../../shared/db';
import { settings } from '../../shared/settings';
import { createHash } from 'crypto';

// ─── Health ───────────────────────────────────────────────────────────────────

export async function getHealth() {
  try {
    await db.$queryRaw`SELECT 1`;
    return { status: 'ok', db: 'ok' };
  } catch {
    return { status: 'degraded', db: 'error' };
  }
}

export async function getHealthReady() {
  await db.$queryRaw`SELECT 1`;
  return { status: 'ready' };
}

// ─── Config ───────────────────────────────────────────────────────────────────

export async function getConfig() {
  const all = await settings.getAll();

  const publicFlags: Record<string, unknown> = {};
  for (const [k, v] of all) {
    if (k.startsWith('flags.')) publicFlags[k] = v;
  }

  const exchangeRates = await db.exchangeRate.findMany({
    orderBy: { effectiveFrom: 'desc' },
    take: 10,
  });

  const latestRates: Record<string, unknown> = {};
  const staleThresholdMs = 72 * 60 * 60 * 1000;
  for (const r of exchangeRates) {
    const key = `${r.base}_${r.quote}`;
    if (!latestRates[key]) {
      const stale = Date.now() - r.effectiveFrom.getTime() > staleThresholdMs;
      latestRates[key] = { base: r.base, quote: r.quote, rate: r.rate, stale, effectiveFrom: r.effectiveFrom };
    }
  }

  const config = {
    flags: publicFlags,
    mediaLimits: {
      maxPhotos: all.get('media.maxPhotos') ?? 10,
      photoMaxMB: all.get('media.photo.maxMB') ?? 8,
      videoMaxMB: all.get('media.video.maxMB') ?? 15,
      videoMaxSeconds: all.get('media.video.maxSeconds') ?? 30,
    },
    otpChannels: {
      email: all.get('flags.otp.email') ?? true,
      sms: all.get('flags.otp.sms') ?? false,
      whatsapp: all.get('flags.otp.whatsapp') ?? false,
    },
    currencies: all.get('currencies.enabled') ?? ['SDG', 'USD'],
    minVersion: all.get('app.minVersion') ?? { ios: '1.0.0', android: '1.0.0' },
    maintenance: all.get('app.maintenance') ?? { enabled: false },
    exchangeRates: Object.values(latestRates),
    contactSupport: all.get('contact.support') ?? {},
    pendingLegal: [],
  };

  const etag = `W/"${createHash('sha1').update(JSON.stringify(config)).digest('hex').slice(0, 16)}"`;
  return { config, etag };
}

// ─── Translations ─────────────────────────────────────────────────────────────

export async function getTranslations(lang: string) {
  const rows = await db.translation.findMany({ where: { lang } });
  const result: Record<string, string> = {};
  for (const r of rows) result[r.key] = r.value;
  const etag = `W/"${createHash('sha1').update(JSON.stringify(result)).digest('hex').slice(0, 16)}"`;
  return { translations: result, etag };
}

// ─── Exchange rate ────────────────────────────────────────────────────────────

export async function getExchangeRate(base: string, quote: string) {
  const rate = await db.exchangeRate.findFirst({
    where: { base: base.toUpperCase(), quote: quote.toUpperCase() },
    orderBy: { effectiveFrom: 'desc' },
  });
  if (!rate) return null;
  const staleHours = await settings.get<number>('fx.staleAlertHours', 72);
  const stale = Date.now() - rate.effectiveFrom.getTime() > staleHours * 3600 * 1000;
  return { base: rate.base, quote: rate.quote, rate: rate.rate, stale, effectiveFrom: rate.effectiveFrom };
}
