import { db } from '../../shared/db';
import { settings } from '../../shared/settings';

// ─── Normalize Arabic-Indic digits to ASCII ───────────────────────────────────
function normalizeDigits(s: string): string {
  return s.replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x0660));
}

// ─── Phone detection ──────────────────────────────────────────────────────────
// Finds runs of 9-13 digits that look like Sudanese numbers.
// Ignores numbers directly followed by a currency word.
// Ignores numbers that equal the listing's own price.
const CURRENCY_WORDS = /\s*(sdg|usd|جنيه|دولار)/i;

function containsPhone(text: string, price: string | null): boolean {
  const normalized = normalizeDigits(text);
  // Strip separators to find digit runs
  const cleaned = normalized.replace(/[\s.\-()]/g, '');
  // Patterns: 0XXXXXXXXX (10 digits), 249XXXXXXXXX (12), +249XXXXXXXXX (12+), 9XXXXXXXX (9), 1XXXXXXXX (9)
  const phoneRe = /(?:(?:\+?249|0)[\d]{8,10}|[91][\d]{8})/g;
  let m: RegExpExecArray | null;
  while ((m = phoneRe.exec(cleaned)) !== null) {
    const digits = m[0].replace(/\D/g, '');
    // Skip if it matches the listing price
    if (price && digits === price.replace(/\D/g, '')) continue;
    // Check what follows in the original text for currency words
    const afterIdx = text.indexOf(m[0].slice(0, 4));
    const after = afterIdx >= 0 ? text.slice(afterIdx + m[0].length, afterIdx + m[0].length + 20) : '';
    if (CURRENCY_WORDS.test(after)) continue;
    return true;
  }
  return false;
}

// ─── Job scam phrases ─────────────────────────────────────────────────────────
const JOB_SCAM_PHRASES = [
  'pay to apply', 'fee required', 'transfer money', 'send money',
  'registration fee', 'whatsapp only', 'واتساب فقط', 'رسوم التقديم', 'تحويل مبلغ',
];

interface ScanSignal { signal: string; weight: number }

type ListingWithMedia = NonNullable<Awaited<ReturnType<typeof db.listing.findUnique>>> & {
  media: { hash: string | null }[];
};

export async function scanListing(listingId: string): Promise<void> {
  let listing: ListingWithMedia | null = null;
  try {
    listing = await db.listing.findUnique({
      where: { id: listingId },
      include: { media: { select: { hash: true } } },
    }) as ListingWithMedia | null;
  } catch (err) {
    console.error('[scan] fetch error for', listingId, err);
    return;
  }
  if (!listing) return;

  const prevStatus = listing.status;
  const signals: ScanSignal[] = [];
  const text = `${listing.title} ${listing.description} ${listing.customOtherText ?? ''}`.toLowerCase();
  const priceStr = listing.price ? String(listing.price) : null;

  // Banned keywords
  try {
    const bannedKw = await settings.get<string[]>('moderation.bannedKeywords', []);
    const bannedPhrases = await settings.get<string[]>('chat.bannedPhrases', []);
    for (const kw of [...bannedKw, ...bannedPhrases]) {
      if (text.includes(kw.toLowerCase())) {
        signals.push({ signal: 'BANNED_KEYWORD', weight: 30 });
        break;
      }
    }
  } catch (err) { console.error('[scan] bannedKeywords error', err); }

  // Phone number in text
  if (containsPhone(text, priceStr)) {
    signals.push({ signal: 'PHONE_IN_TEXT', weight: 40 });
  }

  // Duplicate text (same owner, pg_trgm)
  try {
    const dupThreshold = await settings.get<number>('dup.textSimilarity', 0.85);
    const dups = await db.$queryRaw<{ id: string }[]>`
      SELECT id FROM "Listing"
      WHERE "ownerId" = ${listing.ownerId}
        AND id != ${listing.id}
        AND "deletedAt" IS NULL
        AND similarity("searchText", ${listing.searchText}) >= ${dupThreshold}
      LIMIT 1
    `;
    if (dups.length > 0) signals.push({ signal: 'DUPLICATE_TEXT', weight: 25 });
  } catch { /* pg_trgm may not be installed */ }

  // Image sha256 duplicate (different owner)
  const mediaList = listing.media ?? [];
  const hashes = mediaList.map((m) => m.hash).filter(Boolean) as string[];
  if (hashes.length > 0) {
    try {
      const imgDup = await db.listingMedia.findFirst({
        where: { hash: { in: hashes }, listing: { ownerId: { not: listing.ownerId }, deletedAt: null } },
      });
      if (imgDup) signals.push({ signal: 'IMAGE_DUPLICATE', weight: 20 });
    } catch (err) { console.error('[scan] imageDup error', err); }
  }

  // Job scam phrases
  if (listing.listingType === 'JOB') {
    for (const phrase of JOB_SCAM_PHRASES) {
      if (text.includes(phrase)) {
        signals.push({ signal: 'JOB_SCAM_PHRASE', weight: 35 });
        break;
      }
    }
  }

  // Out of Sudan bbox — use exact lat/lng (always stored)
  if (listing.lat !== null && listing.lng !== null) {
    const lat = listing.lat as number;
    const lng = listing.lng as number;
    if (lat < 8.5 || lat > 23.5 || lng < 21.8 || lng > 38.7) {
      signals.push({ signal: 'OUT_OF_SUDAN', weight: 10 });
    }
  }

  const riskScore = Math.min(100, signals.reduce((s, x) => s + x.weight, 0));
  const flags = signals.map((s) => s.signal);
  const scan = { flags, risk: riskScore, scannedAt: new Date().toISOString() };

  const autoHideCfg = await settings.get<{ fraudScore: number }>('moderation.autoHide', { fraudScore: 85 });
  const fraudAlert = await settings.get<number>('fraud.alert', 70);

  let newStatus = prevStatus;
  if (riskScore >= autoHideCfg.fraudScore && prevStatus === 'ACTIVE') {
    newStatus = 'AUTO_HIDDEN';
  } else if (prevStatus === 'PENDING_REVIEW' && riskScore < autoHideCfg.fraudScore) {
    newStatus = 'ACTIVE';
  }

  // Conditional update: only change status if it hasn't been changed by something else
  try {
    await db.listing.updateMany({
      where: { id: listingId, status: prevStatus },
      data: { scan: scan as never, riskScore, status: newStatus },
    });
  } catch (err) {
    console.error('[scan] update error for', listingId, err);
    // Retry once
    try {
      await db.listing.updateMany({
        where: { id: listingId, status: prevStatus },
        data: { scan: scan as never, riskScore, status: newStatus },
      });
    } catch (err2) { console.error('[scan] retry failed for', listingId, err2); }
  }

  if (riskScore >= fraudAlert) {
    await db.analyticsEvent.create({
      data: { type: 'scan_alert', listingId, props: { flags, riskScore } as never },
    }).catch((err) => console.error('[scan] analyticsEvent error', err));
  }
}
