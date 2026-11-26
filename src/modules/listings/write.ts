import { createHash } from 'crypto';
import { Decimal } from '@prisma/client/runtime/library';
import { db } from '../../shared/db';
import { E } from '../../shared/errors';
import { settings } from '../../shared/settings';
import { buildValidator } from '../catalog/validator';
import { computeQuality } from './quality';
import { assertCanPublish, resolveStatus, cleanText, buildSearchText, computeJitterFixed } from './create';
// ─── PATCH listing ────────────────────────────────────────────────────────────

const LOCKED_STATUSES = ['SUSPENDED'] as const;

export async function patchListing(
  requesterId: string,
  listingId: string,
  input: Record<string, unknown>,
) {
  const listing = await db.listing.findUnique({ where: { id: listingId }, include: { category: true } });
  if (!listing || listing.deletedAt) throw E.notFound('LISTING_NOT_FOUND');
  if (listing.ownerId !== requesterId) throw E.forbidden();
  if (['SOLD', 'EXPIRED'].includes(listing.status)) throw E.rule('LISTING_NOT_EDITABLE');
  if (LOCKED_STATUSES.includes(listing.status as never)) throw E.rule('LISTING_LOCKED');

  const changedFields: string[] = [];
  const data: Record<string, unknown> = {};

  if (input.title !== undefined) { data.title = cleanText(input.title as string); changedFields.push('title'); }
  if (input.description !== undefined) { data.description = cleanText(input.description as string); changedFields.push('description'); }
  if (input.price !== undefined) { data.price = new Decimal(input.price as number); changedFields.push('price'); }
  if (input.currency !== undefined) { data.currency = input.currency; changedFields.push('currency'); }
  if (input.isNegotiable !== undefined) { data.isNegotiable = input.isNegotiable; changedFields.push('isNegotiable'); }
  if (input.condition !== undefined) { data.condition = input.condition; changedFields.push('condition'); }
  if (input.locationName !== undefined) { data.locationName = input.locationName; changedFields.push('locationName'); }
  if (input.contactOptions !== undefined) { data.contactOptions = input.contactOptions as never; changedFields.push('contactOptions'); }
  if (input.isCustomOther !== undefined) { data.isCustomOther = input.isCustomOther; changedFields.push('isCustomOther'); }
  if (input.customOtherText !== undefined) { data.customOtherText = cleanText(input.customOtherText as string); changedFields.push('customOtherText'); }

  // Location fields — recompute pubLat/pubLng only when lat, lng, isApproxLocation or approxRadiusM changes
  const locationKeys = ['lat', 'lng', 'isApproxLocation', 'approxRadiusM', 'cityId', 'neighborhoodId'] as const;
  const locationChanged = locationKeys.some((k) => input[k] !== undefined);
  if (locationChanged) {
    const newLat = input.lat !== undefined ? (input.lat as number) : (listing.lat ?? undefined);
    const newLng = input.lng !== undefined ? (input.lng as number) : (listing.lng ?? undefined);
    const newIsApprox = input.isApproxLocation !== undefined ? (input.isApproxLocation as boolean) : listing.isApproxLocation;
    const newRadiusM = input.approxRadiusM !== undefined ? (input.approxRadiusM as number) : (listing.approxRadiusM ?? undefined);

    if (input.lat !== undefined) { data.lat = newLat ?? null; changedFields.push('lat'); }
    if (input.lng !== undefined) { data.lng = newLng ?? null; changedFields.push('lng'); }
    if (input.isApproxLocation !== undefined) { data.isApproxLocation = newIsApprox; changedFields.push('isApproxLocation'); }
    if (input.approxRadiusM !== undefined) { data.approxRadiusM = newRadiusM ?? null; changedFields.push('approxRadiusM'); }

    // Validate cityId/neighborhoodId existence and parentage
    if (input.cityId !== undefined) {
      const city = await db.place.findUnique({ where: { id: input.cityId as string } });
      if (!city) throw E.badRequest('PLACE_NOT_FOUND');
      data.cityId = input.cityId;
      changedFields.push('cityId');
    }
    if (input.neighborhoodId !== undefined) {
      const hood = await db.place.findUnique({ where: { id: input.neighborhoodId as string } });
      if (!hood) throw E.badRequest('PLACE_NOT_FOUND');
      const cityId = (input.cityId as string | undefined) ?? listing.cityId;
      if (hood.parentId !== cityId) throw E.badRequest('NEIGHBORHOOD_CITY_MISMATCH');
      data.neighborhoodId = input.neighborhoodId;
      changedFields.push('neighborhoodId');
    }

    // Recompute pubLat/pubLng
    const coordChanged = input.lat !== undefined || input.lng !== undefined || input.isApproxLocation !== undefined || input.approxRadiusM !== undefined;
    if (coordChanged && newLat !== undefined && newLng !== undefined) {
      if (newIsApprox) {
        const defaultRadius = await settings.get<number>('listing.approxRadiusDefault', 500);
        const rawRadius = newRadiusM ?? defaultRadius;
        const radiusM = Math.min(2000, Math.max(100, rawRadius));
        const j = computeJitterFixed(listingId, radiusM, newLat, newLng);
        data.pubLat = j.pubLat;
        data.pubLng = j.pubLng;
      } else {
        data.pubLat = newLat;
        data.pubLng = newLng;
      }
    }
  }

  if (input.dynamicAttributes !== undefined) {
    // Edit mode: pass existing stored attributes so archived keys are accepted at stored value
    const storedAttrs = listing.dynamicAttributes as Record<string, unknown>;
    const validator = await buildValidator(listing.categoryId, true, storedAttrs);
    const parsed = validator.safeParse(input.dynamicAttributes);
    if (!parsed.success) throw E.badRequest('VALIDATION_ERROR', parsed.error.flatten().fieldErrors);

    // Must not remove a currently required, active attribute
    const activeRequired = await db.categoryAttribute.findMany({
      where: { categoryId: listing.categoryId, isRequired: true, isArchived: false },
    });
    const incoming = input.dynamicAttributes as Record<string, unknown>;
    for (const attr of activeRequired) {
      if (incoming[attr.attributeKey] === undefined && storedAttrs[attr.attributeKey] === undefined) {
        throw E.badRequest('REQUIRED_ATTR_MISSING', { key: attr.attributeKey });
      }
    }

    data.dynamicAttributes = input.dynamicAttributes as never;
    changedFields.push('dynamicAttributes');
  }

  // Rebuild searchText if text fields changed
  if (data.title !== undefined || data.description !== undefined || data.dynamicAttributes !== undefined) {
    const title = (data.title as string | undefined) ?? listing.title;
    const description = (data.description as string | undefined) ?? listing.description;
    const attrs = (data.dynamicAttributes ?? listing.dynamicAttributes) as Record<string, unknown>;
    const attrDefs = await db.categoryAttribute.findMany({ where: { categoryId: listing.categoryId } });
    data.searchText = buildSearchText(title, description, listing.customOtherText, attrs, attrDefs, listing.category.nameAr, listing.category.nameEn);
  }

  const updated = await db.listing.update({ where: { id: listingId }, data: data as never });

  if (changedFields.length > 0) {
    await db.analyticsEvent.create({
      data: { type: 'listing_edited', listingId, userId: requesterId, props: { fields: changedFields } as never },
    });
    setImmediate(() => { import('./scan').then((m) => m.scanListing(listingId)).catch(() => {}); });
    // Price drop hook
    if (data.price !== undefined && listing.price !== null) {
      const oldP = Number(listing.price);
      const newP = Number(data.price);
      if (newP < oldP && listing.currency === (data.currency ?? listing.currency)) {
        setImmediate(() => { import('./hooks').then((m) => m.onListingPriceChanged(listingId, oldP, newP)).catch(() => {}); });
      }
    }
  }

  return { id: updated.id, status: updated.status };
}

// ─── Publish ──────────────────────────────────────────────────────────────────

export async function publishListing(requesterId: string, listingId: string) {
  const listing = await db.listing.findUnique({ where: { id: listingId } });
  if (!listing || listing.deletedAt) throw E.notFound('LISTING_NOT_FOUND');
  if (listing.ownerId !== requesterId) throw E.forbidden();
  if (listing.status !== 'DRAFT') throw E.rule('LISTING_NOT_DRAFT');

  const cat = await db.category.findUnique({ where: { id: listing.categoryId } });
  if (cat?.postingRestricted) throw E.rule('CATEGORY_POSTING_DISABLED', { message: cat.postingMessage });

  const user = await db.user.findUniqueOrThrow({ where: { id: requesterId } });
  const expiryDays = cat?.expiryDays ?? await settings.get<number>('listing.expiryDaysDefault', 30);
  const expiresAt = new Date(Date.now() + expiryDays * 86400000);

  const updated = await db.$transaction(async (tx) => {
    await assertCanPublish(tx, user, listing.categoryId);
    const status = await resolveStatus(user, listing.categoryId, 'ACTIVE');
    return tx.listing.update({
      where: { id: listingId },
      data: { status, publishedAt: new Date(), expiresAt },
    });
  });

  await db.analyticsEvent.create({ data: { type: 'listing_published', listingId, userId: requesterId, props: {} as never } });
  setImmediate(() => { import('./scan').then((m) => m.scanListing(listingId)).catch(() => {}); });
  setImmediate(() => { import('./hooks').then((m) => m.onListingActivated(listingId)).catch(() => {}); });

  return { id: updated.id, status: updated.status, readableId: `MARBOU-${String(updated.publicSeq).padStart(5, '0')}` };
}

// ─── Renew ────────────────────────────────────────────────────────────────────

export async function renewListing(requesterId: string, listingId: string) {
  const listing = await db.listing.findUnique({ where: { id: listingId } });
  if (!listing || listing.deletedAt) throw E.notFound('LISTING_NOT_FOUND');
  if (listing.ownerId !== requesterId) throw E.forbidden();

  const renewWindowDays = await settings.get<number>('listing.renewWindowDays', 30);
  const isExpired = listing.status === 'EXPIRED';
  const isExpiringSoon = listing.status === 'ACTIVE' && listing.expiresAt &&
    listing.expiresAt.getTime() - Date.now() < 7 * 86400000;

  if (!isExpired && !isExpiringSoon) throw E.rule('LISTING_NOT_RENEWABLE');
  if (isExpired && listing.expiresAt) {
    const expiredMs = Date.now() - listing.expiresAt.getTime();
    if (expiredMs > renewWindowDays * 86400000) throw E.rule('RENEW_WINDOW_EXPIRED');
  }

  const cat = await db.category.findUnique({ where: { id: listing.categoryId } });
  const expiryDays = cat?.expiryDays ?? await settings.get<number>('listing.expiryDaysDefault', 30);
  const expiresAt = new Date(Date.now() + expiryDays * 86400000);

  const updated = await db.$transaction(async (tx) => {
    if (isExpired) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${requesterId}))`;
      const activeCount = await tx.listing.count({
        where: { ownerId: requesterId, status: { in: ['ACTIVE', 'PENDING_REVIEW'] }, deletedAt: null },
      });
      const capLimit = await settings.get<number>('limits.activeListingsIndividual', 50);
      if (activeCount >= capLimit) throw E.rule('LISTING_CAP_REACHED');
    }
    return tx.listing.update({
      where: { id: listingId },
      data: { status: 'ACTIVE', expiresAt, reminded7: false, reminded1: false, publishedAt: new Date() },
    });
  });

  setImmediate(() => { import('./hooks').then((m) => m.onListingActivated(listingId)).catch(() => {}); });
  return { id: updated.id, status: updated.status, expiresAt: updated.expiresAt };
}

// ─── Sold ─────────────────────────────────────────────────────────────────────

export async function markSold(requesterId: string, listingId: string) {
  const listing = await db.listing.findUnique({ where: { id: listingId } });
  if (!listing || listing.deletedAt) throw E.notFound('LISTING_NOT_FOUND');
  if (listing.ownerId !== requesterId) throw E.forbidden();
  if (listing.status !== 'ACTIVE') throw E.rule('LISTING_NOT_EDITABLE');
  const updated = await db.listing.update({
    where: { id: listingId },
    data: { status: 'SOLD', soldAt: new Date() },
  });
  setImmediate(() => { import('./hooks').then((m) => m.onListingStatusChanged(listingId, 'ACTIVE', 'SOLD')).catch(() => {}); });
  return { id: updated.id, status: updated.status };
}

// ─── Archive ──────────────────────────────────────────────────────────────────

const ARCHIVABLE = ['ACTIVE', 'EXPIRED', 'SOLD', 'HIDDEN', 'DRAFT'] as const;

export async function archiveListing(requesterId: string, listingId: string) {
  const listing = await db.listing.findUnique({ where: { id: listingId } });
  if (!listing || listing.deletedAt) throw E.notFound('LISTING_NOT_FOUND');
  if (listing.ownerId !== requesterId) throw E.forbidden();
  if (!ARCHIVABLE.includes(listing.status as never)) throw E.rule('LISTING_NOT_EDITABLE');
  const updated = await db.listing.update({ where: { id: listingId }, data: { status: 'ARCHIVED' } });
  setImmediate(() => { import('./hooks').then((m) => m.onListingStatusChanged(listingId, listing.status, 'ARCHIVED')).catch(() => {}); });
  return { id: updated.id, status: updated.status };
}

// ─── Delete (soft) ────────────────────────────────────────────────────────────

export async function deleteListing(requesterId: string, listingId: string) {
  const listing = await db.listing.findUnique({ where: { id: listingId } });
  if (!listing || listing.deletedAt) throw E.notFound('LISTING_NOT_FOUND');
  if (listing.ownerId !== requesterId) throw E.forbidden();
  await db.listing.update({ where: { id: listingId }, data: { deletedAt: new Date(), status: 'ARCHIVED' } });
  return { ok: true };
}

// ─── Duplicate ────────────────────────────────────────────────────────────────

export async function duplicateListing(requesterId: string, listingId: string) {
  const listing = await db.listing.findUnique({ where: { id: listingId }, include: { media: true } });
  if (!listing || listing.deletedAt) throw E.notFound('LISTING_NOT_FOUND');
  if (listing.ownerId !== requesterId) throw E.forbidden();

  const copy = await db.listing.create({
    data: {
      ownerId: listing.ownerId,
      categoryId: listing.categoryId,
      listingType: listing.listingType,
      title: listing.title,
      description: listing.description,
      searchText: listing.searchText,
      price: listing.price,
      budgetMin: listing.budgetMin,
      budgetMax: listing.budgetMax,
      currency: listing.currency,
      isNegotiable: listing.isNegotiable,
      condition: listing.condition,
      status: 'DRAFT',
      isCustomOther: listing.isCustomOther,
      customOtherText: listing.customOtherText,
      locationName: listing.locationName,
      isApproxLocation: listing.isApproxLocation,
      approxRadiusM: listing.approxRadiusM,
      lat: listing.lat,
      lng: listing.lng,
      pubLat: listing.pubLat,
      pubLng: listing.pubLng,
      contactOptions: listing.contactOptions as never,
      dynamicAttributes: listing.dynamicAttributes as never,
      cityId: listing.cityId,
      neighborhoodId: listing.neighborhoodId,
      videoMediaId: listing.videoMediaId,
    },
  });

  for (const m of listing.media) {
    await db.listingMedia.create({
      data: { listingId: copy.id, mediaId: m.mediaId, url: m.url, thumbUrl: m.thumbUrl, position: m.position, isCover: m.isCover, hash: m.hash },
    });
  }

  return { id: copy.id, readableId: `MARBOU-${String(copy.publicSeq).padStart(5, '0')}`, status: copy.status };
}

// ─── Bulk actions ─────────────────────────────────────────────────────────────

export async function bulkAction(
  requesterId: string,
  action: 'RENEW' | 'HIDE' | 'SOLD' | 'DELETE',
  ids: string[],
) {
  const user = await db.user.findUniqueOrThrow({ where: { id: requesterId } });
  if (!user.capabilities.includes('DEALER')) throw E.forbidden('CAPABILITY_REQUIRED');

  const owned = await db.listing.findMany({
    where: { id: { in: ids }, ownerId: requesterId, deletedAt: null },
    select: { id: true },
  });
  const ownedSet = new Set(owned.map((l) => l.id));

  const results: { id: string; ok: boolean; error?: string }[] = [];
  for (const id of ids) {
    if (!ownedSet.has(id)) {
      results.push({ id, ok: false, error: 'NOT_FOUND' });
      continue;
    }
    try {
      if (action === 'RENEW') await renewListing(requesterId, id);
      else if (action === 'HIDE') {
        const l = await db.listing.findUnique({ where: { id } });
        if (!l || l.deletedAt) throw E.notFound('LISTING_NOT_FOUND');
        if (LOCKED_STATUSES.includes(l.status as never)) throw E.rule('LISTING_LOCKED');
        await db.listing.update({ where: { id }, data: { status: 'HIDDEN' } });
      } else if (action === 'SOLD') await markSold(requesterId, id);
      else if (action === 'DELETE') await deleteListing(requesterId, id);
      results.push({ id, ok: true });
    } catch (e: unknown) {
      results.push({ id, ok: false, error: e instanceof Error ? e.message : 'error' });
    }
  }
  return { results };
}

// ─── Quality preview ──────────────────────────────────────────────────────────

export async function qualityPreview(
  _ownerId: string,
  input: { categoryId: string; title: string; description: string; mediaCount: number; hasVideo: boolean; price?: number; lat?: number; dynamicAttributes?: Record<string, unknown> },
) {
  const allAttrs = await db.categoryAttribute.findMany({ where: { categoryId: input.categoryId, isArchived: false } });
  const requiredKeys = allAttrs.filter((a) => a.isRequired).map((a) => a.attributeKey);
  const optionalKeys = allAttrs.filter((a) => !a.isRequired).map((a) => a.attributeKey);
  const weights = await settings.get('quality.weights', { titleDesc: 25, photos: 25, requiredAttrs: 20, optionalAttrs: 10, location: 10, video: 5, price: 5 });
  const score = computeQuality({
    title: input.title,
    description: input.description,
    mediaCount: input.mediaCount,
    hasVideo: input.hasVideo,
    price: input.price,
    lat: input.lat,
    dynamicAttributes: input.dynamicAttributes ?? {},
    requiredKeys,
    optionalKeys,
  }, weights as Parameters<typeof computeQuality>[1]);
  return { qualityScore: score };
}

// ─── Contact reveal ───────────────────────────────────────────────────────────

export async function contactReveal(
  listingId: string,
  channel: 'CALL' | 'WHATSAPP',
  requesterId?: string,
  deviceId?: string,
  ip?: string,
  lang: 'ar' | 'en' = 'ar',
) {
  const listing = await db.listing.findUnique({ where: { id: listingId }, include: { owner: true } });
  if (!listing || listing.deletedAt || listing.status !== 'ACTIVE') throw E.notFound('LISTING_NOT_FOUND');

  const contactOptions = listing.contactOptions as { call: boolean; whatsapp: boolean; chat: boolean };
  if (channel === 'CALL' && !contactOptions.call) throw E.forbidden('CONTACT_HIDDEN');
  if (channel === 'WHATSAPP' && !contactOptions.whatsapp) throw E.forbidden('CONTACT_HIDDEN');

  const policy = await settings.get<string>('flags.contactReveal.policy', 'GUESTS_RATE_LIMITED');
  if (policy === 'SIGNED_IN_ONLY' && !requesterId) throw E.unauthorized();

  const owner = listing.owner;
  const phone = owner.phone ?? owner.verifiedPhone;
  if (!phone) throw E.rule('CONTACT_UNAVAILABLE');

  if (!requesterId) {
    const actorKey = createHash('sha256').update(deviceId ?? ip ?? 'anon').digest('hex');
    const dayAgo = new Date(Date.now() - 86400000);
    const guestLimit = await settings.get<number>('limits.guestRevealsPerDay', 20);

    await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${actorKey}))`;
      const count = await tx.analyticsEvent.count({
        where: { type: 'contact_reveal', actorKey, createdAt: { gte: dayAgo } },
      });
      if (count >= guestLimit) throw E.tooMany('REVEAL_LIMIT');
      await tx.analyticsEvent.create({
        data: { type: 'contact_reveal', listingId, actorKey, props: { channel } as never },
      });
    });
  } else {
    await db.analyticsEvent.create({ data: { type: 'contact_reveal', listingId, userId: requesterId, props: { channel } as never } });
  }

  await db.listing.update({ where: { id: listingId }, data: { leadCount: { increment: 1 } } });

  if (channel === 'CALL') return { phone };

  const templateKey = `whatsapp.template.${lang}`;
  const template = await settings.get<string>(templateKey, 'Hi, interested in {title} ({listingId}) at {price}');
  const readableId = `MARBOU-${String(listing.publicSeq).padStart(5, '0')}`;
  const priceStr = listing.price ? `${listing.price} ${listing.currency}` : '';
  const text = template
    .replace('{title}', listing.title)
    .replace('{listingId}', readableId)
    .replace('{price}', priceStr);
  const digits = phone.replace(/\D/g, '');
  const waUrl = `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
  return { waUrl };
}

// ─── Lead ─────────────────────────────────────────────────────────────────────

export async function recordLead(listingId: string, type: string, actorKey: string, userId?: string) {
  const listing = await db.listing.findUnique({ where: { id: listingId } });
  if (!listing || listing.status !== 'ACTIVE') throw E.notFound('LISTING_NOT_FOUND');

  // At most one lead per (actor, listing, day)
  const today = new Date().toISOString().slice(0, 10);
  const dayStart = new Date(today);
  const existing = await db.analyticsEvent.findFirst({
    where: { type: 'lead', listingId, actorKey, createdAt: { gte: dayStart } },
  });
  if (existing) return { ok: true };

  await db.listing.update({ where: { id: listingId }, data: { leadCount: { increment: 1 } } });
  await db.analyticsEvent.create({ data: { type: 'lead', listingId, userId: userId ?? null, actorKey, props: { leadType: type } as never } });
  return { ok: true };
}

// ─── Expire listings (cron) ───────────────────────────────────────────────────

export async function expireListings(): Promise<number> {
  const result = await db.listing.updateMany({
    where: { status: 'ACTIVE', expiresAt: { lt: new Date() }, deletedAt: null },
    data: { status: 'EXPIRED' },
  });
  return result.count;
}
