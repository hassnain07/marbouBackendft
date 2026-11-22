import { db } from '../../shared/db';
import { settings } from '../../shared/settings';

// ─── Phone pattern (Arabic-Indic digits too) ──────────────────────────────────

const PHONE_RE = /(?:\+?[\d٠-٩]{7,}[\s\-]?){1}/u;

// ─── Job scam phrases ─────────────────────────────────────────────────────────

const JOB_SCAM_PHRASES = [
  'pay to apply', 'fee required', 'transfer money', 'send money',
  'whatsapp only', 'واتساب فقط', 'رسوم التقديم', 'تحويل مبلغ',
];

interface ScanSignal { signal: string; weight: number }

export async function scanListing(listingId: string): Promise<void> {
  const listing = await db.listing.findUnique({
    where: { id: listingId },
    include: { media: { select: { hash: true } } },
  });
  if (!listing) return;

  const signals: ScanSignal[] = [];
  const text = `${listing.title} ${listing.description} ${listing.customOtherText ?? ''}`.toLowerCase();

  // Banned keywords
  const bannedKw = await settings.get<string[]>('moderation.bannedKeywords', []);
  const bannedPhrases = await settings.get<string[]>('chat.bannedPhrases', []);
  const allBanned = [...bannedKw, ...bannedPhrases];
  for (const kw of allBanned) {
    if (text.includes(kw.toLowerCase())) {
      signals.push({ signal: 'BANNED_KEYWORD', weight: 30 });
      break;
    }
  }

  // Phone number in text
  if (PHONE_RE.test(text)) {
    signals.push({ signal: 'PHONE_IN_TEXT', weight: 40 });
  }

  // Duplicate text (same owner, same title similarity via pg_trgm)
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
  } catch { /* pg_trgm may not be installed in test */ }

  // Image sha256 duplicate (different owner)
  const hashes = listing.media.map((m) => m.hash).filter(Boolean) as string[];
  if (hashes.length > 0) {
    const imgDup = await db.listingMedia.findFirst({
      where: {
        hash: { in: hashes },
        listing: { ownerId: { not: listing.ownerId }, deletedAt: null },
      },
    });
    if (imgDup) signals.push({ signal: 'IMAGE_DUPLICATE', weight: 20 });
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

  // Out of Sudan bbox (lat 8.5-23.5, lng 21.8-38.7)
  if (listing.lat !== null && listing.lng !== null) {
    const lat = listing.lat as number;
    const lng = listing.lng as number;
    if (lat < 8.5 || lat > 23.5 || lng < 21.8 || lng > 38.7) {
      signals.push({ signal: 'OUT_OF_SUDAN', weight: 10 });
    }
  }

  // Classifier stub — always clean
  // signals.push({ signal: 'CLASSIFIER', weight: 0 });

  const riskScore = Math.min(100, signals.reduce((s, x) => s + x.weight, 0));
  const flags = signals.map((s) => s.signal);
  const scan = { flags, risk: riskScore, scannedAt: new Date().toISOString() };

  const autoHideCfg = await settings.get<{ fraudScore: number }>('moderation.autoHide', { fraudScore: 85 });
  const fraudAlert = await settings.get<number>('fraud.alert', 70);

  let newStatus = listing.status;
  if (riskScore >= autoHideCfg.fraudScore && listing.status === 'ACTIVE') {
    newStatus = 'AUTO_HIDDEN';
  } else if (listing.status === 'PENDING_REVIEW' && riskScore < autoHideCfg.fraudScore) {
    newStatus = 'ACTIVE';
  }

  await db.listing.update({
    where: { id: listingId },
    data: { scan: scan as never, riskScore, status: newStatus },
  });

  if (riskScore >= fraudAlert) {
    await db.analyticsEvent.create({
      data: { type: 'scan_alert', listingId, props: { flags, riskScore } as never },
    });
  }
}
