import { randomUUID } from 'crypto';
import sanitizeHtml from 'sanitize-html';
import { Decimal } from '@prisma/client/runtime/library';
import { db } from '../../shared/db';
import { E } from '../../shared/errors';
import { settings } from '../../shared/settings';
import { buildValidator } from '../catalog/validator';
import { computeQuality } from './quality';
import type { ListingType, ListingStatus } from '@prisma/client';

// ─── Sudan bbox (soft warning only — listings are still accepted) ─────────────
const SUDAN_LAT = [8.5, 23.5] as const;
const SUDAN_LNG = [21.8, 38.7] as const;

// ─── Shared text cleaner ──────────────────────────────────────────────────────
export function cleanText(s: string): string {
  const stripped = sanitizeHtml(s, { allowedTags: [], allowedAttributes: {} });
  return stripped
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

// ─── Deterministic jitter seeded by listing ID ────────────────────────────────
export function computeJitterFixed(listingId: string, radiusM: number, lat: number, lng: number): { pubLat: number; pubLng: number } {
  let h1 = 0x9e3779b9, h2 = 0x6c62272e;
  for (let i = 0; i < listingId.length; i++) {
    const c = listingId.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x9e3779b9) | 0;
    h2 = Math.imul(h2 ^ c, 0x85ebca6b) | 0;
  }
  const u1 = (h1 >>> 0) / 0x100000000;
  const u2 = (h2 >>> 0) / 0x100000000;
  const angle = u1 * 2 * Math.PI;
  const r = radiusM * Math.sqrt(u2);
  const dLat = r / 111320;
  const cosLat = Math.cos((lat * Math.PI) / 180) || 1e-10;
  const dLng = r / (111320 * cosLat);
  return {
    pubLat: lat + Math.cos(angle) * dLat,
    pubLng: lng + Math.sin(angle) * dLng,
  };
}

// ─── Shared searchText builder ────────────────────────────────────────────────
export function buildSearchText(
  title: string,
  description: string,
  customOtherText: string | undefined | null,
  attrs: Record<string, unknown>,
  attrDefs: Array<{ attributeKey: string; optionsList: unknown }>,
  catNameAr: string,
  catNameEn: string,
): string {
  const attrParts: string[] = [];
  for (const [key, val] of Object.entries(attrs)) {
    const def = attrDefs.find((a) => a.attributeKey === key);
    const opts = (def?.optionsList ?? []) as Array<{ value: string; labelEn: string; labelAr: string }>;
    const values = Array.isArray(val) ? val : [val];
    for (const v of values) {
      const opt = opts.find((o) => o.value === v);
      if (opt) {
        attrParts.push(opt.labelEn, opt.labelAr);
      } else {
        attrParts.push(String(v ?? ''));
      }
    }
  }
  const parts = [title, description, customOtherText ?? '', ...attrParts, catNameAr, catNameEn];
  return parts.filter(Boolean).join(' ').toLowerCase();
}

// ─── assertCanPublish ─────────────────────────────────────────────────────────
type TxClient = Parameters<Parameters<typeof db.$transaction>[0]>[0];

export async function assertCanPublish(
  tx: TxClient,
  user: { id: string; fraudScore: number },
  _categoryId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${user.id}))`;

  const activeCount = await tx.listing.count({
    where: { ownerId: user.id, status: { in: ['ACTIVE', 'PENDING_REVIEW'] }, deletedAt: null },
  });
  const capLimit = await settings.get<number>('limits.activeListingsIndividual', 50);
  if (activeCount >= capLimit) throw E.rule('LISTING_CAP_REACHED');

  const fraudMult = user.fraudScore >= 80 ? 0.5 : 1;
  const hourAgo = new Date(Date.now() - 3600000);
  const dayAgo = new Date(Date.now() - 86400000);
  const perHour = await settings.get<number>('limits.listingsPerHour', 5);
  const perDay = await settings.get<number>('limits.listingsPerDay', 20);

  const hourCount = await tx.listing.count({ where: { ownerId: user.id, publishedAt: { gte: hourAgo } } });
  const dayCount = await tx.listing.count({ where: { ownerId: user.id, publishedAt: { gte: dayAgo } } });

  if (hourCount >= Math.floor(perHour * fraudMult)) throw E.rule('LISTING_RATE_LIMIT');
  if (dayCount >= Math.floor(perDay * fraudMult)) throw E.rule('LISTING_RATE_LIMIT');
}

// ─── Delayed visibility decision ─────────────────────────────────────────────
export async function resolveStatus(
  user: { createdAt: Date },
  categoryId: string,
  baseStatus: ListingStatus,
): Promise<ListingStatus> {
  if (baseStatus !== 'ACTIVE') return baseStatus;
  const delayedRules = await settings.get<{ categoryId?: string; categoryIds?: string[]; maxAccountAgeDays?: number }[]>('moderation.delayedVisibility', []);
  for (const rule of delayedRules) {
    const catIds = rule.categoryIds ?? (rule.categoryId ? [rule.categoryId] : undefined);
    const catMatch = !catIds || catIds.includes(categoryId);
    const ageDays = (Date.now() - user.createdAt.getTime()) / 86400000;
    const ageMatch = !rule.maxAccountAgeDays || ageDays < rule.maxAccountAgeDays;
    if (catMatch && ageMatch) return 'PENDING_REVIEW';
  }
  return 'ACTIVE';
}

export interface CreateListingInput {
  categoryId: string;
  listingType: ListingType;
  title: string;
  description: string;
  price?: number;
  budgetMin?: number;
  budgetMax?: number;
  currency?: string;
  isNegotiable?: boolean;
  condition?: string;
  isCustomOther?: boolean;
  customOtherText?: string;
  lat?: number;
  lng?: number;
  locationName?: string;
  isApproxLocation?: boolean;
  approxRadiusM?: number;
  contactOptions?: { call?: boolean; whatsapp?: boolean; chat?: boolean };
  dynamicAttributes?: Record<string, unknown>;
  mediaIds?: string[];
  coverMediaId?: string;
  videoMediaId?: string;
  cityId?: string;
  neighborhoodId?: string;
  publish?: boolean;
  status?: string;
}

export async function createListing(ownerId: string, input: CreateListingInput) {
  const shouldPublish = input.publish ?? (input.status === 'PUBLISH');

  // 1. User checks
  const user = await db.user.findUniqueOrThrow({ where: { id: ownerId } });
  if (!user.emailVerifiedAt) throw E.forbidden('EMAIL_NOT_VERIFIED');
  if (user.status !== 'ACTIVE') throw E.forbidden('ACCOUNT_SUSPENDED');

  // 2. Category checks
  const cat = await db.category.findUnique({ where: { id: input.categoryId } });
  if (!cat || cat.isArchived || !cat.isActive) throw E.rule('CATEGORY_NOT_FOUND');
  if (cat.postingRestricted) throw E.rule('CATEGORY_POSTING_DISABLED', { message: cat.postingMessage });
  if (input.listingType === 'JOB' && !user.capabilities.includes('EMPLOYER')) {
    throw E.forbidden('CAPABILITY_REQUIRED');
  }

  // 3. isCustomOther
  if (input.isCustomOther && (!input.customOtherText || input.customOtherText.length > 80)) {
    throw E.badRequest('CUSTOM_OTHER_TEXT_REQUIRED');
  }

  // 4. Dynamic attributes validation
  const attrs = input.dynamicAttributes ?? {};
  const validator = await buildValidator(input.categoryId);
  const parsed = validator.safeParse(attrs);
  if (!parsed.success) throw E.badRequest('VALIDATION_ERROR', parsed.error.flatten().fieldErrors);

  // 5. Price rules
  const priceOptionalTypes: ListingType[] = ['WANTED', 'JOB', 'SERVICE'];
  const needsPrice = !priceOptionalTypes.includes(input.listingType);
  if (needsPrice && input.price === undefined && input.budgetMin === undefined) {
    throw E.badRequest('PRICE_REQUIRED');
  }
  if (input.price !== undefined && (input.price <= 0 || input.price >= 1e12)) {
    throw E.badRequest('INVALID_PRICE');
  }
  if (!['SDG', 'USD'].includes(input.currency ?? 'SDG')) throw E.badRequest('INVALID_CURRENCY');

  // 6. Sanitize text
  const title = cleanText(input.title);
  const description = cleanText(input.description);
  const customOtherText = input.customOtherText ? cleanText(input.customOtherText) : undefined;

  // 7. Location — always store exact lat/lng; compute pubLat/pubLng
  const lat = input.lat ?? null;
  const lng = input.lng ?? null;
  let pubLat = lat;
  let pubLng = lng;

  const listingId = randomUUID();

  if (lat !== null && lng !== null && input.isApproxLocation) {
    const defaultRadius = await settings.get<number>('listing.approxRadiusDefault', 500);
    const rawRadius = input.approxRadiusM ?? defaultRadius;
    const radiusM = Math.min(2000, Math.max(100, rawRadius));
    const j = computeJitterFixed(listingId, radiusM, lat, lng);
    pubLat = j.pubLat;
    pubLng = j.pubLng;
  }

  // 7b. Sudan bbox soft warning
  const warnings: string[] = [];
  if (lat !== null && lng !== null) {
    if (lat < SUDAN_LAT[0] || lat > SUDAN_LAT[1] || lng < SUDAN_LNG[0] || lng > SUDAN_LNG[1]) {
      warnings.push('OUT_OF_SUDAN');
    }
  }

  // 8. searchText
  const allAttrs = await db.categoryAttribute.findMany({ where: { categoryId: input.categoryId, isArchived: false } });
  const searchText = buildSearchText(title, description, customOtherText, attrs, allAttrs, cat.nameAr, cat.nameEn);

  // 9. Quality score
  const requiredKeys = allAttrs.filter((a) => a.isRequired).map((a) => a.attributeKey);
  const optionalKeys = allAttrs.filter((a) => !a.isRequired).map((a) => a.attributeKey);
  const weights = await settings.get('quality.weights', { titleDesc: 25, photos: 25, requiredAttrs: 20, optionalAttrs: 10, location: 10, video: 5, price: 5 });
  const qualityScore = computeQuality({
    title, description,
    mediaCount: (input.mediaIds ?? []).length,
    hasVideo: !!input.videoMediaId,
    price: input.price,
    lat: pubLat,
    dynamicAttributes: attrs as Record<string, unknown>,
    requiredKeys,
    optionalKeys,
  }, weights as Parameters<typeof computeQuality>[1]);

  // 10. Status
  const expiryDays = cat.expiryDays ?? await settings.get<number>('listing.expiryDaysDefault', 30);
  const expiresAt = shouldPublish ? new Date(Date.now() + expiryDays * 86400000) : null;

  // 11. Create listing + cap check + media in ONE transaction
  const listing = await db.$transaction(async (tx) => {
    let status: ListingStatus = shouldPublish ? 'ACTIVE' : 'DRAFT';
    if (shouldPublish) {
      await assertCanPublish(tx, user, input.categoryId);
      status = await resolveStatus(user, input.categoryId, 'ACTIVE');
    }

    const l = await tx.listing.create({
      data: {
        id: listingId,
        ownerId,
        categoryId: input.categoryId,
        listingType: input.listingType,
        title,
        description,
        searchText,
        price: input.price !== undefined ? new Decimal(input.price) : null,
        budgetMin: input.budgetMin !== undefined ? new Decimal(input.budgetMin) : null,
        budgetMax: input.budgetMax !== undefined ? new Decimal(input.budgetMax) : null,
        currency: input.currency ?? 'SDG',
        isNegotiable: input.isNegotiable ?? false,
        condition: input.condition,
        status,
        isCustomOther: input.isCustomOther ?? false,
        customOtherText,
        lat,
        lng,
        pubLat,
        pubLng,
        locationName: input.locationName,
        isApproxLocation: input.isApproxLocation ?? false,
        approxRadiusM: input.approxRadiusM,
        contactOptions: (input.contactOptions ?? { call: true, whatsapp: true, chat: true }) as never,
        dynamicAttributes: attrs as never,
        qualityScore,
        cityId: input.cityId,
        neighborhoodId: input.neighborhoodId,
        videoMediaId: input.videoMediaId,
        publishedAt: shouldPublish ? new Date() : null,
        expiresAt,
      },
    });

    // Image media rows
    const mediaIds = input.mediaIds ?? [];
    const coverMediaId = input.coverMediaId;
    const maxPhotos = await settings.get<number>('media.maxPhotos', 10);
    if (mediaIds.length > maxPhotos) throw E.badRequest('TOO_MANY_PHOTOS');
    const seen = new Set<string>();
    for (let i = 0; i < mediaIds.length; i++) {
      const mid = mediaIds[i];
      if (seen.has(mid)) throw E.badRequest('DUPLICATE_MEDIA_ID');
      seen.add(mid);
      const asset = await tx.mediaAsset.findUnique({ where: { id: mid } });
      if (!asset || asset.ownerId !== ownerId) throw E.badRequest('MEDIA_NOT_OWNED');
      if (asset.kind !== 'IMAGE') throw E.badRequest('MEDIA_KIND_INVALID');
      if (asset.isPrivate) throw E.badRequest('MEDIA_KIND_INVALID');
      const isCover = coverMediaId ? mid === coverMediaId : i === 0;
      await tx.listingMedia.create({
        data: {
          listingId: l.id,
          mediaId: mid,
          url: asset.url ?? '',
          thumbUrl: (asset.thumbKeys as Record<string, string> | null)?.m,
          position: i,
          isCover,
          hash: asset.sha256,
        },
      });
      await tx.mediaAsset.update({ where: { id: mid }, data: { attachedAt: new Date() } });
    }

    // videoMediaId: must be caller's own unattached VIDEO asset
    if (input.videoMediaId) {
      const vid = await tx.mediaAsset.findUnique({ where: { id: input.videoMediaId } });
      if (!vid || vid.ownerId !== ownerId) throw E.badRequest('MEDIA_NOT_OWNED');
      if (vid.kind !== 'VIDEO') throw E.badRequest('MEDIA_KIND_INVALID');
      if (vid.attachedAt) throw E.badRequest('MEDIA_ALREADY_ATTACHED');
      await tx.mediaAsset.update({ where: { id: input.videoMediaId }, data: { attachedAt: new Date() } });
      await tx.listing.update({ where: { id: l.id }, data: { videoUrl: vid.url } });
    }

    return l;
  });

  const { env } = await import('../../config/env');
  const webUrl = `${env.PUBLIC_WEB_URL}/listing/MARBOU-${String(listing.publicSeq).padStart(5, '0')}`;

  if (shouldPublish) {
    await db.analyticsEvent.create({ data: { type: 'listing_published', listingId: listing.id, userId: ownerId, props: {} as never } });
    setImmediate(() => { import('./scan').then((m) => m.scanListing(listing.id)).catch(() => {}); });
    setImmediate(() => { import('./hooks').then((m) => m.onListingActivated(listing.id)).catch(() => {}); });
  }

  return {
    id: listing.id,
    readableId: `MARBOU-${String(listing.publicSeq).padStart(5, '0')}`,
    status: listing.status,
    shareUrl: webUrl,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}
