import sanitizeHtml from 'sanitize-html';
import { Decimal } from '@prisma/client/runtime/library';
import { db } from '../../shared/db';
import { E } from '../../shared/errors';
import { settings } from '../../shared/settings';
import { toSearchText } from '../../shared/arabic';
import { buildValidator } from '../catalog/validator';
import { computeQuality } from './quality';
import type { ListingStatus } from '@prisma/client';

function clean(s: string): string {
  return sanitizeHtml(s, { allowedTags: [], allowedAttributes: {} }).trim();
}

// ─── PATCH listing ────────────────────────────────────────────────────────────

export async function patchListing(
  requesterId: string,
  listingId: string,
  input: Record<string, unknown>,
) {
  const listing = await db.listing.findUnique({ where: { id: listingId }, include: { category: true } });
  if (!listing || listing.deletedAt) throw E.notFound('LISTING_NOT_FOUND');
  if (listing.ownerId !== requesterId) throw E.forbidden();
  if (['SOLD', 'EXPIRED'].includes(listing.status)) throw E.rule('LISTING_NOT_EDITABLE');

  const changedFields: string[] = [];
  const data: Record<string, unknown> = {};

  if (input.title !== undefined) { data.title = clean(input.title as string); changedFields.push('title'); }
  if (input.description !== undefined) { data.description = clean(input.description as string); changedFields.push('description'); }
  if (input.price !== undefined) { data.price = new Decimal(input.price as number); changedFields.push('price'); }
  if (input.currency !== undefined) { data.currency = input.currency; changedFields.push('currency'); }
  if (input.isNegotiable !== undefined) { data.isNegotiable = input.isNegotiable; changedFields.push('isNegotiable'); }
  if (input.condition !== undefined) { data.condition = input.condition; changedFields.push('condition'); }
  if (input.locationName !== undefined) { data.locationName = input.locationName; changedFields.push('locationName'); }
  if (input.contactOptions !== undefined) { data.contactOptions = input.contactOptions as never; changedFields.push('contactOptions'); }
  if (input.dynamicAttributes !== undefined) {
    const validator = await buildValidator(listing.categoryId, true); // partial=true: skip required checks on edit
    const parsed = validator.safeParse(input.dynamicAttributes);
    if (!parsed.success) throw E.badRequest('VALIDATION_ERROR', parsed.error.flatten().fieldErrors);
    data.dynamicAttributes = input.dynamicAttributes as never;
    changedFields.push('dynamicAttributes');
  }

  // Rebuild searchText if text fields changed
  if (data.title || data.description || data.dynamicAttributes) {
    const title = (data.title as string | undefined) ?? listing.title;
    const description = (data.description as string | undefined) ?? listing.description;
    const attrValues = Object.values((data.dynamicAttributes ?? listing.dynamicAttributes) as Record<string, unknown>).map(String).join(' ');
    data.searchText = toSearchText(title, description, attrValues, listing.category.nameAr, listing.category.nameEn);
  }

  const updated = await db.listing.update({ where: { id: listingId }, data: data as never });

  if (changedFields.length > 0) {
    await db.analyticsEvent.create({
      data: { type: 'listing_edited', listingId, userId: requesterId, props: { fields: changedFields } as never },
    });
    setImmediate(() => { import('./scan').then((m) => m.scanListing(listingId)).catch(() => {}); });
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

  const expiryDays = cat?.expiryDays ?? await settings.get<number>('listing.expiryDaysDefault', 30);
  const expiresAt = new Date(Date.now() + expiryDays * 86400000);

  const updated = await db.listing.update({
    where: { id: listingId },
    data: { status: 'ACTIVE', publishedAt: new Date(), expiresAt },
  });

  await db.analyticsEvent.create({ data: { type: 'listing_published', listingId, userId: requesterId, props: {} as never } });
  setImmediate(() => { import('./scan').then((m) => m.scanListing(listingId)).catch(() => {}); });

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

  const updated = await db.listing.update({
    where: { id: listingId },
    data: { status: 'ACTIVE', expiresAt, reminded7: false, reminded1: false },
  });
  return { id: updated.id, status: updated.status, expiresAt: updated.expiresAt };
}

// ─── Sold ─────────────────────────────────────────────────────────────────────

export async function markSold(requesterId: string, listingId: string) {
  const listing = await db.listing.findUnique({ where: { id: listingId } });
  if (!listing || listing.deletedAt) throw E.notFound('LISTING_NOT_FOUND');
  if (listing.ownerId !== requesterId) throw E.forbidden();
  const updated = await db.listing.update({
    where: { id: listingId },
    data: { status: 'SOLD', soldAt: new Date() },
  });
  return { id: updated.id, status: updated.status };
}

// ─── Archive ──────────────────────────────────────────────────────────────────

export async function archiveListing(requesterId: string, listingId: string) {
  const listing = await db.listing.findUnique({ where: { id: listingId } });
  if (!listing || listing.deletedAt) throw E.notFound('LISTING_NOT_FOUND');
  if (listing.ownerId !== requesterId) throw E.forbidden();
  const updated = await db.listing.update({ where: { id: listingId }, data: { status: 'ARCHIVED' } });
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
      contactOptions: listing.contactOptions as never,
      dynamicAttributes: listing.dynamicAttributes as never,
      cityId: listing.cityId,
      neighborhoodId: listing.neighborhoodId,
    },
  });

  // Copy media rows (new listing, same assets)
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
  const isDealer = user.capabilities.includes('DEALER');
  if (!isDealer) throw E.forbidden('CAPABILITY_REQUIRED');

  const results: { id: string; ok: boolean; error?: string }[] = [];
  for (const id of ids) {
    try {
      if (action === 'RENEW') await renewListing(requesterId, id);
      else if (action === 'HIDE') await db.listing.update({ where: { id }, data: { status: 'HIDDEN' } });
      else if (action === 'SOLD') await markSold(requesterId, id);
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
  ownerId: string,
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

  // Policy check
  const policy = await settings.get<string>('flags.contactReveal.policy', 'GUESTS_RATE_LIMITED');
  if (policy === 'SIGNED_IN_ONLY' && !requesterId) throw E.unauthorized();

  // Guest rate limit
  if (!requesterId) {
    const actorKey = require('crypto').createHash('sha256').update(deviceId ?? ip ?? 'anon').digest('hex');
    const dayAgo = new Date(Date.now() - 86400000);
    const guestLimit = await settings.get<number>('limits.guestRevealsPerDay', 20);
    const count = await db.analyticsEvent.count({
      where: { type: 'contact_reveal', actorKey, createdAt: { gte: dayAgo } },
    });
    if (count >= guestLimit) throw E.tooMany('REVEAL_LIMIT');
    const actorKeyVal = actorKey;
    setImmediate(() => {
      db.analyticsEvent.create({ data: { type: 'contact_reveal', listingId, actorKey: actorKeyVal, props: { channel } as never } }).catch(() => {});
    });
  } else {
    await db.analyticsEvent.create({ data: { type: 'contact_reveal', listingId, userId: requesterId, props: { channel } as never } });
  }

  const owner = listing.owner;
  const phone = owner.phone ?? owner.verifiedPhone;
  if (!phone) throw E.rule('CONTACT_UNAVAILABLE');

  // Increment lead count
  await db.listing.update({ where: { id: listingId }, data: { leadCount: { increment: 1 } } });

  if (channel === 'CALL') {
    return { phone };
  }

  // WHATSAPP
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

export async function recordLead(listingId: string, type: string, userId?: string) {
  const listing = await db.listing.findUnique({ where: { id: listingId } });
  if (!listing || listing.status !== 'ACTIVE') throw E.notFound('LISTING_NOT_FOUND');
  await db.listing.update({ where: { id: listingId }, data: { leadCount: { increment: 1 } } });
  await db.analyticsEvent.create({ data: { type: 'lead', listingId, userId: userId ?? null, props: { leadType: type } as never } });
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
