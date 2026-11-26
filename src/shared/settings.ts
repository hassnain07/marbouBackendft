import { db } from './db';
import { E } from './errors';

// ─── Setting defaults registry ────────────────────────────────────────────────

export const DEFAULTS: Record<string, unknown> = {
  'flags.otp.email': true,
  'flags.otp.sms': false,
  'flags.otp.whatsapp': false,
  'flags.video.enabled': true,
  'flags.bankak.userFlow': false,
  'flags.monetization': false,
  'flags.engine.subscriptions': false,
  'flags.engine.promotions': false,
  'flags.engine.credits': false,
  'flags.engine.boosts': false,
  'flags.engine.auctions': false,
  'flags.engine.barter': false,
  'flags.engine.assetRental': false,
  'flags.engine.cart': false,
  'flags.engine.delivery': false,
  'flags.engine.admob': false,
  'flags.engine.wholesale': false,
  'flags.engine.hotelReservations': false,
  'flags.contactReveal.policy': 'GUESTS_RATE_LIMITED',
  'limits.guestRevealsPerDay': 20,
  'limits.activeListingsIndividual': 50,
  'limits.activeListingsBusiness': 500,
  'limits.listingsPerHour': 5,
  'limits.listingsPerDay': 20,
  'limits.applicationsPerDay': 20,
  'media.maxPhotos': 10,
  'media.video.maxSeconds': 30,
  'media.video.maxMB': 15,
  'media.photo.maxMB': 8,
  'media.video.disabledCategoryIds': [],
  'listing.expiryDaysDefault': 30,
  'listing.renewWindowDays': 30,
  'quality.weights': {
    titleDesc: 25,
    photos: 25,
    requiredAttrs: 20,
    optionalAttrs: 10,
    location: 10,
    video: 5,
    price: 5,
  },
  'dup.textSimilarity': 0.85,
  'moderation.autoHide': { reports: 5, windowHours: 24, fraudScore: 85 },
  'moderation.delayedVisibility': [],
  'fraud.alert': 70,
  'fraud.rateLimit': 80,
  'insight.minComparables': 8,
  'insight.bandPct': 15,
  'search.recencyHalfLifeDays': 14,
  'limits.messagesPerMinute': 20,
  'limits.messagesPerMinutePerRecipient': 10,
  'fx.staleAlertHours': 72,
  'fx.staleSuppressDays': 7,
  'auth.lockout': { maxFails: 5, delaysMin: [1, 5, 15, 60] },
  'chat.throttle': {
    perMinute: 20,
    perRecipientPerMinute: 10,
    sameTextRecipients: 3,
    sameTextWindowMin: 10,
  },
  'chat.reviewMinMessagesEach': 2,
  'chat.bannedPhrases': [],
  'appointment.confirmWindowHours': 72,
  'deletion.graceDays': 30,
  'app.minVersion': { ios: '1.0.0', android: '1.0.0' },
  'app.maintenance': { enabled: false, messageAr: '', messageEn: '', from: null, to: null },
  'maps.googleDailyCap': 1000,
  'maps.perUserPerDay': 50,
  'maps.perIpPerDay': 100,
  'contact.support': { email: '', phone: '', whatsapp: '' },
  'currencies.enabled': ['SDG', 'USD'],
  'whatsapp.template.ar': 'مرحباً، مهتم بـ {title} ({listingId}) بسعر {price}',
  'whatsapp.template.en': 'Hi, interested in {title} ({listingId}) at {price}',
};

// ─── Cache ────────────────────────────────────────────────────────────────────

let cache = new Map<string, unknown>();
let loadedAt = 0;

async function load(force = false): Promise<void> {
  if (!force && Date.now() - loadedAt < 60_000) return;
  const rows = await db.setting.findMany();
  cache = new Map(rows.map((r) => [r.key, r.value]));
  loadedAt = Date.now();
}

// ─── Validation ───────────────────────────────────────────────────────────────

function validateSetting(key: string, value: unknown): void {
  // AUTH-15: refuse disabling the last OTP channel
  // Treat anything other than exactly `true` as disabled
  if (key.startsWith('flags.otp.') && value !== true) {
    const channels = ['flags.otp.email', 'flags.otp.sms', 'flags.otp.whatsapp'];
    const others = channels.filter((k) => k !== key);
    const anyEnabled = others.some((k) => {
      const v = cache.get(k);
      const effective = v !== undefined ? v : DEFAULTS[k];
      return effective === true;
    });
    if (!anyEnabled) throw E.rule('LAST_OTP_CHANNEL');
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

export const settings = {
  async get<T>(key: string, fallback?: T): Promise<T> {
    await load();
    if (cache.has(key)) return cache.get(key) as T;
    if (key in DEFAULTS) return DEFAULTS[key] as T;
    return fallback as T;
  },

  async getAll(): Promise<Map<string, unknown>> {
    await load();
    const merged = new Map<string, unknown>(Object.entries(DEFAULTS));
    for (const [k, v] of cache) merged.set(k, v);
    return merged;
  },

  async set(
    key: string,
    value: unknown,
    actor: { type: 'ADMIN' | 'SYSTEM'; id: string },
  ): Promise<void> {
    await load();
    validateSetting(key, value);
    await db.setting.upsert({
      where: { key },
      create: { key, value: value as never, updatedBy: actor.id },
      update: { value: value as never, updatedBy: actor.id },
    });
    await load(true);
  },

  invalidate(): void {
    loadedAt = 0;
  },
};

export async function requireFlag(key: string): Promise<void> {
  const val = await settings.get<boolean>(key, false);
  if (!val) throw E.notFound();
}
