import { randomUUID } from 'crypto';
import sanitizeHtml from 'sanitize-html';
import { Decimal } from '@prisma/client/runtime/library';
import { db } from '../../shared/db';
import { E } from '../../shared/errors';
import { settings } from '../../shared/settings';
import { toSearchText } from '../../shared/arabic';
import { attachMedia } from '../media/service';
import { buildValidator } from '../catalog/validator';
import { computeQuality } from './quality';
import type { ListingType, ListingStatus } from '@prisma/client';

// ─── Sudan bbox (soft) ────────────────────────────────────────────────────────
const SUDAN_LAT = [8.5, 23.5] as const;
const SUDAN_LNG = [21.8, 38.7] as const;

function clean(s: string): string {
  return sanitizeHtml(s, { allowedTags: [], allowedAttributes: {} }).trim();
}

function jitter(seed: string, radiusM: number): { lat: number; lng: number } {
  // Deterministic jitter from listing UUID seed
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (Math.imul(31, h) + seed.charCodeAt(i)) | 0;
  const angle = ((h >>> 0) / 0xffffffff) * 2 * Math.PI;
  const r = radiusM / 111320;
  return { lat: Math.cos(angle) * r, lng: Math.sin(angle) * r };
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
  status?: string; // 'PUBLISH' | 'DRAFT' — convenience alias
}

export async function createListing(ownerId: string, input: CreateListingInput) {
  // Normalise status alias: status:'PUBLISH' → publish:true
  const shouldPublish = input.publish ?? (input.status === 'PUBLISH');
  const normalised = { ...input, publish: shouldPublish };
  // 1. Verified email + active account
  const user = await db.user.findUniqueOrThrow({ where: { id: ownerId } });
  if (!user.emailVerifiedAt) throw E.forbidden('EMAIL_NOT_VERIFIED');
  if (user.status !== 'ACTIVE') throw E.forbidden('ACCOUNT_SUSPENDED');

  // 2. Category checks
  const cat = await db.category.findUnique({ where: { id: normalised.categoryId } });
  if (!cat || cat.isArchived || !cat.isActive) throw E.rule('CATEGORY_NOT_FOUND');
  if (cat.postingRestricted) throw E.rule('CATEGORY_POSTING_DISABLED', { message: cat.postingMessage });
  if (normalised.listingType === 'JOB' && !user.capabilities.includes('EMPLOYER')) {
    throw E.forbidden('CAPABILITY_REQUIRED');
  }

  // 3. isCustomOther
  if (normalised.isCustomOther && (!normalised.customOtherText || normalised.customOtherText.length > 80)) {
    throw E.badRequest('CUSTOM_OTHER_TEXT_REQUIRED');
  }

  // 4. Dynamic attributes validation
  const attrs = normalised.dynamicAttributes ?? {};
  const validator = await buildValidator(normalised.categoryId);
  const parsed = validator.safeParse(attrs);
  if (!parsed.success) throw E.badRequest('VALIDATION_ERROR', parsed.error.flatten().fieldErrors);

  // 5. Price rules
  const priceOptionalTypes: ListingType[] = ['WANTED', 'JOB', 'SERVICE'];
  const needsPrice = !priceOptionalTypes.includes(normalised.listingType);
  if (needsPrice && normalised.price === undefined && normalised.budgetMin === undefined) {
    throw E.badRequest('PRICE_REQUIRED');
  }
  if (normalised.price !== undefined && (normalised.price <= 0 || normalised.price >= 1e12)) {
    throw E.badRequest('INVALID_PRICE');
  }
  if (!['SDG', 'USD'].includes(normalised.currency ?? 'SDG')) throw E.badRequest('INVALID_CURRENCY');

  // 6. Sanitize text
  const title = clean(normalised.title);
  const description = clean(normalised.description);
  const customOtherText = normalised.customOtherText ? clean(normalised.customOtherText) : undefined;

  // 7. Location
  const warnings: string[] = [];
  let lat = normalised.lat ?? null;
  let lng = normalised.lng ?? null;
  let pubLat = lat;
  let pubLng = lng;

  if (lat !== null && lng !== null) {
    if (lat < SUDAN_LAT[0] || lat > SUDAN_LAT[1] || lng < SUDAN_LNG[0] || lng > SUDAN_LNG[1]) {
      warnings.push('OUT_OF_SUDAN');
    }
    if (normalised.isApproxLocation && normalised.approxRadiusM) {
      const id = randomUUID();
      const j = jitter(id, normalised.approxRadiusM);
      pubLat = lat + j.lat;
      pubLng = lng + j.lng;
      lat = null; lng = null; // exact coords not stored when approx
    }
  }

  // 8. searchText
  const attrValues = Object.values(attrs).map((v) => String(v ?? '')).join(' ');
  const searchText = toSearchText(title, description, customOtherText, attrValues, cat.nameAr, cat.nameEn);

  // 9. Quality score
  const allAttrs = await db.categoryAttribute.findMany({ where: { categoryId: normalised.categoryId, isArchived: false } });
  const requiredKeys = allAttrs.filter((a) => a.isRequired).map((a) => a.attributeKey);
  const optionalKeys = allAttrs.filter((a) => !a.isRequired).map((a) => a.attributeKey);
  const weights = await settings.get('quality.weights', { titleDesc: 25, photos: 25, requiredAttrs: 20, optionalAttrs: 10, location: 10, video: 5, price: 5 });
  const qualityScore = computeQuality({
    title, description,
    mediaCount: (normalised.mediaIds ?? []).length,
    hasVideo: !!normalised.videoMediaId,
    price: normalised.price,
    lat: pubLat,
    dynamicAttributes: attrs as Record<string, unknown>,
    requiredKeys,
    optionalKeys,
  }, weights as Parameters<typeof computeQuality>[1]);

  // 10. Status
  const delayedRules = await settings.get<{ categoryId?: string; categoryIds?: string[]; maxAccountAgeDays?: number }[]>('moderation.delayedVisibility', []);
  let status: ListingStatus = shouldPublish ? 'ACTIVE' : 'DRAFT';
  if (shouldPublish) {
    for (const rule of delayedRules) {
      const catIds = rule.categoryIds ?? (rule.categoryId ? [rule.categoryId] : undefined);
      const catMatch = !catIds || catIds.includes(normalised.categoryId);
      const ageMs = Date.now() - user.createdAt.getTime();
      const ageDays = ageMs / 86400000;
      const ageMatch = !rule.maxAccountAgeDays || ageDays < rule.maxAccountAgeDays;
      if (catMatch && ageMatch) { status = 'PENDING_REVIEW'; break; }
    }
  }

  // 11. expiresAt
  const expiryDays = cat.expiryDays ?? await settings.get<number>('listing.expiryDaysDefault', 30);
  const expiresAt = shouldPublish ? new Date(Date.now() + expiryDays * 86400000) : null;

  const listingId = randomUUID();

  // Cap + rate checks (only at publish time)
  if (shouldPublish) {
    await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${ownerId}))`;
      const activeCount = await tx.listing.count({
        where: { ownerId, status: { in: ['ACTIVE', 'PENDING_REVIEW'] }, deletedAt: null },
      });
      const capLimit = await settings.get<number>('limits.activeListingsIndividual', 50);
      if (activeCount >= capLimit) throw E.rule('LISTING_CAP_REACHED');

      const hourAgo = new Date(Date.now() - 3600000);
      const dayAgo = new Date(Date.now() - 86400000);
      const perHour = await settings.get<number>('limits.listingsPerHour', 5);
      const perDay = await settings.get<number>('limits.listingsPerDay', 20);
      const fraudMult = user.fraudScore >= 80 ? 0.5 : 1;
      const hourCount = await tx.listing.count({ where: { ownerId, publishedAt: { gte: hourAgo } } });
      const dayCount = await tx.listing.count({ where: { ownerId, publishedAt: { gte: dayAgo } } });
      if (hourCount >= Math.floor(perHour * fraudMult)) throw E.rule('LISTING_RATE_LIMIT');
      if (dayCount >= Math.floor(perDay * fraudMult)) throw E.rule('LISTING_RATE_LIMIT');
    });
  }

  // Create listing + media in one transaction
  const listing = await db.$transaction(async (tx) => {
    const l = await tx.listing.create({
      data: {
        id: listingId,
        ownerId,
        categoryId: normalised.categoryId,
        listingType: normalised.listingType,
        title,
        description,
        searchText,
        price: normalised.price !== undefined ? new Decimal(normalised.price) : null,
        budgetMin: normalised.budgetMin !== undefined ? new Decimal(normalised.budgetMin) : null,
        budgetMax: normalised.budgetMax !== undefined ? new Decimal(normalised.budgetMax) : null,
        currency: normalised.currency ?? 'SDG',
        isNegotiable: normalised.isNegotiable ?? false,
        condition: normalised.condition,
        status,
        isCustomOther: normalised.isCustomOther ?? false,
        customOtherText,
        lat,
        lng,
        pubLat,
        pubLng,
        locationName: normalised.locationName,
        isApproxLocation: normalised.isApproxLocation ?? false,
        approxRadiusM: normalised.approxRadiusM,
        contactOptions: (normalised.contactOptions ?? { call: true, whatsapp: true, chat: true }) as never,
        dynamicAttributes: attrs as never,
        qualityScore,
        cityId: normalised.cityId,
        neighborhoodId: normalised.neighborhoodId,
        videoMediaId: normalised.videoMediaId,
        publishedAt: shouldPublish ? new Date() : null,
        expiresAt,
      },
    });

    // Media rows — coverMediaId sets isCover; otherwise first item is cover
    const mediaIds = normalised.mediaIds ?? [];
    const coverMediaId = normalised.coverMediaId;
    const maxPhotos = await settings.get<number>('media.maxPhotos', 10);
    if (mediaIds.length > maxPhotos) throw E.badRequest('TOO_MANY_PHOTOS');
    for (let i = 0; i < mediaIds.length; i++) {
      const asset = await tx.mediaAsset.findUnique({ where: { id: mediaIds[i] } });
      if (!asset || asset.ownerId !== ownerId) throw E.badRequest('MEDIA_NOT_OWNED');
      const isCover = coverMediaId ? mediaIds[i] === coverMediaId : i === 0;
      await tx.listingMedia.create({
        data: {
          listingId: l.id,
          mediaId: mediaIds[i],
          url: asset.url ?? '',
          thumbUrl: (asset.thumbKeys as Record<string, string> | null)?.m,
          position: coverMediaId && mediaIds[i] === coverMediaId ? -1 : i,
          isCover,
          hash: asset.sha256,
        },
      });
      await tx.mediaAsset.update({ where: { id: mediaIds[i] }, data: { attachedAt: new Date() } });
    }

    return l;
  });

  const webUrl = `${process.env.PUBLIC_WEB_URL ?? 'http://localhost:3000'}/listing/MARBOU-${String(listing.publicSeq).padStart(5, '0')}`;

  if (shouldPublish) {
    await db.analyticsEvent.create({ data: { type: 'listing_published', listingId: listing.id, userId: ownerId, props: {} as never } });
    setImmediate(() => { import('./scan').then((m) => m.scanListing(listing.id)).catch(() => {}); });
  }

  return {
    id: listing.id,
    readableId: `MARBOU-${String(listing.publicSeq).padStart(5, '0')}`,
    status: listing.status,
    shareUrl: webUrl,
    warnings,
  };
}
