import { createHash } from 'crypto';
import { db } from '../../shared/db';
import { E } from '../../shared/errors';

const READABLE_RE = /^MARBOU-(\d+)$/;

function readableToSeq(id: string): number | null {
  const m = READABLE_RE.exec(id);
  return m ? parseInt(m[1], 10) : null;
}

export async function getListing(
  idOrReadable: string,
  viewerId?: string,
  viewerIp?: string,
  deviceId?: string,
) {
  const seq = readableToSeq(idOrReadable);
  // Non-UUID, non-readable-ID → 404 immediately
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idOrReadable);
  if (seq === null && !isUuid) throw E.notFound('LISTING_NOT_FOUND');
  const listing = seq !== null
    ? await db.listing.findUnique({ where: { publicSeq: seq }, include: { media: { orderBy: [{ isCover: 'desc' }, { position: 'asc' }] }, category: true, owner: true } })
    : await db.listing.findUnique({ where: { id: idOrReadable }, include: { media: { orderBy: [{ isCover: 'desc' }, { position: 'asc' }] }, category: true, owner: true } });

  if (!listing || listing.deletedAt) throw E.notFound('LISTING_NOT_FOUND');

  const isOwner = viewerId === listing.ownerId;
  const visibleStatuses = ['ACTIVE', 'SOLD', 'EXPIRED'];
  if (!isOwner && !visibleStatuses.includes(listing.status)) throw E.notFound('LISTING_NOT_FOUND');

  // View counting — skip owner, once per viewerKey per day
  // Run synchronously so count is updated before response (within 150ms contract)
  if (!isOwner) {
    const viewerKey = createHash('sha256')
      .update(viewerId ?? deviceId ?? viewerIp ?? 'anon')
      .digest('hex');
    const day = new Date().toISOString().slice(0, 10);
    try {
      const inserted = await db.$executeRaw`
        INSERT INTO "ListingView" (id, "listingId", "viewerKey", day, "createdAt")
        VALUES (gen_random_uuid(), ${listing.id}, ${viewerKey}, ${day}, now())
        ON CONFLICT ("listingId", "viewerKey", day) DO NOTHING
      `;
      if (inserted > 0) {
        await db.listing.update({ where: { id: listing.id }, data: { viewCount: { increment: 1 } } });
        setImmediate(() => {
          db.analyticsEvent.create({
            data: { type: 'listing_view', listingId: listing.id, userId: viewerId ?? null, actorKey: viewerKey, props: {} as never },
          }).catch(() => {});
        });
      }
    } catch { /* ignore on conflict */ }
  }

  const readableId = `MARBOU-${String(listing.publicSeq).padStart(5, '0')}`;
  const shareUrl = `${(await import('../../config/env')).env.PUBLIC_WEB_URL}/listing/${readableId}`;

  const owner = listing.owner;
  const sellerCard = {
    id: owner.id,
    fullName: owner.fullName,
    avatarUrl: owner.avatarUrl,
    badges: owner.badges,
    ratingAvg: owner.ratingAvg,
    ratingCount: owner.ratingCount,
    responseRate: owner.responseRate,
    memberSince: owner.createdAt,
  };

  const contactOptions = listing.contactOptions as { call: boolean; whatsapp: boolean; chat: boolean };

  // Approx listings: expose pubLat/pubLng only, never exact lat/lng
  // For non-approx: pubLat/pubLng are stored as the exact coords
  const pubLat = listing.pubLat ?? listing.lat;
  const pubLng = listing.pubLng ?? listing.lng;

  const base = {
    id: listing.id,
    readableId,
    shareUrl,
    status: listing.status,
    isSold: listing.status === 'SOLD',
    isExpired: listing.status === 'EXPIRED',
    listingType: listing.listingType,
    title: listing.title,
    description: listing.description,
    price: listing.price,
    budgetMin: listing.budgetMin,
    budgetMax: listing.budgetMax,
    currency: listing.currency,
    isNegotiable: listing.isNegotiable,
    condition: listing.condition,
    isCustomOther: listing.isCustomOther,
    customOtherText: listing.customOtherText,
    pubLat,
    pubLng,
    locationName: listing.locationName,
    isApproxLocation: listing.isApproxLocation,
    contactOptions,
    dynamicAttributes: listing.dynamicAttributes,
    qualityScore: listing.qualityScore,
    viewCount: listing.viewCount,
    favoriteCount: listing.favoriteCount,
    leadCount: listing.leadCount,
    videoUrl: listing.videoUrl,
    videoPosterUrl: listing.videoPosterUrl,
    publishedAt: listing.publishedAt,
    expiresAt: listing.expiresAt,
    soldAt: listing.soldAt,
    media: listing.media.map((m) => ({
      id: m.id, url: m.url, thumbUrl: m.thumbUrl, position: m.position, isCover: m.isCover,
    })),
    seller: sellerCard,
    categoryId: listing.categoryId,
    cityId: listing.cityId,
  };

  if (isOwner) {
    return {
      ...base,
      statusReason: listing.statusReason,
      lat: listing.lat,
      lng: listing.lng,
      vehicleVin: listing.vehicleVin,
      scan: listing.scan,
    };
  }

  return base;
}

export async function getMyListings(ownerId: string, status?: string) {
  const where: Record<string, unknown> = { ownerId, deletedAt: null };
  if (status) where.status = status;
  const listings = await db.listing.findMany({
    where: where as never,
    orderBy: { createdAt: 'desc' },
    include: { media: { where: { isCover: true }, take: 1 } },
  });
  return listings.map((l) => ({
    id: l.id,
    readableId: `MARBOU-${String(l.publicSeq).padStart(5, '0')}`,
    title: l.title,
    status: l.status,
    price: l.price,
    currency: l.currency,
    coverUrl: l.media[0]?.url ?? null,
    publishedAt: l.publishedAt,
    expiresAt: l.expiresAt,
    viewCount: l.viewCount,
  }));
}
