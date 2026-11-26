import { Prisma } from '@prisma/client';
import { db } from '../../shared/db';
import { settings } from '../../shared/settings';
import { sha256 } from '../../shared/crypto';
import { normalizeArabic } from '../../shared/arabic';
import { env } from '../../config/env';

// ─── Category subtree cache ───────────────────────────────────────────────────
const subtreeCache = new Map<string, { ids: string[]; loadedAt: number }>();
const SUBTREE_TTL = 60_000;

async function getCategorySubtree(categoryId: string): Promise<string[]> {
  const cached = subtreeCache.get(categoryId);
  if (cached && Date.now() - cached.loadedAt < SUBTREE_TTL) return cached.ids;

  const ids: string[] = [];
  const queue = [categoryId];
  while (queue.length) {
    const id = queue.shift()!;
    ids.push(id);
    const children = await db.category.findMany({
      where: { parentId: id, isActive: true, isArchived: false },
      select: { id: true },
    });
    for (const c of children) queue.push(c.id);
  }
  subtreeCache.set(categoryId, { ids, loadedAt: Date.now() });
  return ids;
}

// ─── Haversine distance (km) ──────────────────────────────────────────────────
function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

export interface SearchParams {
  q?: string;
  categoryId?: string;
  type?: string;
  cityId?: string;
  minPrice?: number;
  maxPrice?: number;
  currency?: string;
  lat?: number;
  lng?: number;
  radiusKm?: number;
  filters?: Record<string, unknown>;
  sort?: string;
  cursor?: string;
  limit?: number;
  onlyListingId?: string; // internal: saved-search match check
}

interface SearchCursor { o: number; asOf: string }

function decodeCursor(c: string): SearchCursor {
  try { return JSON.parse(Buffer.from(c, 'base64url').toString()); }
  catch { return { o: 0, asOf: new Date().toISOString() }; }
}
function encodeCursor(c: SearchCursor): string {
  return Buffer.from(JSON.stringify(c)).toString('base64url');
}

export async function searchListings(params: SearchParams, viewerId?: string) {
  const limit = Math.min(params.limit ?? 20, 50);
  const sort = params.sort ?? 'relevance';

  if (sort === 'distance' && (params.lat == null || params.lng == null)) {
    const { E } = await import('../../shared/errors');
    throw E.badRequest('SORT_REQUIRES_LOCATION');
  }

  const { o: offset, asOf } = params.cursor
    ? decodeCursor(params.cursor)
    : { o: 0, asOf: new Date().toISOString() };

  const asOfDate = new Date(asOf);

  // Blocked user ids (viewer blocked by or has blocked)
  let blockedIds: string[] = [];
  if (viewerId) {
    const blocks = await db.blockedUser.findMany({
      where: { OR: [{ blockerId: viewerId }, { blockedId: viewerId }] },
      select: { blockerId: true, blockedId: true },
    });
    const set = new Set<string>();
    for (const b of blocks) {
      if (b.blockerId === viewerId) set.add(b.blockedId);
      else set.add(b.blockerId);
    }
    blockedIds = Array.from(set);
  }

  // Category subtree
  let categoryIds: string[] | undefined;
  if (params.categoryId) {
    categoryIds = await getCategorySubtree(params.categoryId);
  }

  // Exchange rate for cross-currency price filter
  let fxRate: number | null = null;
  if (params.minPrice != null || params.maxPrice != null) {
    const staleDays = await settings.get<number>('fx.staleSuppressDays', 7);
    const rate = await db.exchangeRate.findFirst({
      where: { base: 'USD', quote: 'SDG' },
      orderBy: { effectiveFrom: 'desc' },
    });
    if (rate && Date.now() - rate.effectiveFrom.getTime() < staleDays * 86400000) {
      fxRate = Number(rate.rate);
    }
  }

  // Tokenize query
  const tokens: string[] = [];
  if (params.q) {
    const normalized = normalizeArabic(params.q.trim().toLowerCase());
    tokens.push(...normalized.split(/\s+/).filter(Boolean));
  }

  // Build WHERE conditions as Prisma fragments
  const conditions: Prisma.Sql[] = [
    Prisma.sql`l.status = 'ACTIVE'`,
    Prisma.sql`l."deletedAt" IS NULL`,
    Prisma.sql`l."expiresAt" > now()`,
    Prisma.sql`l."countryCode" = 'SD'`,
    Prisma.sql`l."publishedAt" <= ${asOfDate}`,
  ];

  if (blockedIds.length > 0) {
    conditions.push(Prisma.sql`l."ownerId" NOT IN (${Prisma.join(blockedIds)})`);
  }

  if (categoryIds) {
    conditions.push(Prisma.sql`l."categoryId" IN (${Prisma.join(categoryIds)})`);
  }

  if (params.type) {
    conditions.push(Prisma.sql`l."listingType" = ${params.type}::"ListingType"`);
  }

  if (params.cityId) {
    conditions.push(Prisma.sql`l."cityId" = ${params.cityId}`);
  }

  // Price filter
  if (params.minPrice != null || params.maxPrice != null) {
    const filterCurrency = params.currency ?? 'SDG';
    if (filterCurrency === 'SDG' || !fxRate) {
      if (params.minPrice != null) conditions.push(Prisma.sql`(l.currency = 'SDG' AND l.price >= ${params.minPrice})`);
      if (params.maxPrice != null) conditions.push(Prisma.sql`(l.currency = 'SDG' AND l.price <= ${params.maxPrice})`);
    } else {
      // USD filter: compare USD listings directly, SDG listings converted
      const minSdg = params.minPrice != null ? params.minPrice * fxRate : null;
      const maxSdg = params.maxPrice != null ? params.maxPrice * fxRate : null;
      const parts: Prisma.Sql[] = [];
      if (params.minPrice != null && minSdg != null) {
        parts.push(Prisma.sql`(l.currency = 'USD' AND l.price >= ${params.minPrice}) OR (l.currency = 'SDG' AND l.price >= ${minSdg})`);
      }
      if (params.maxPrice != null && maxSdg != null) {
        parts.push(Prisma.sql`(l.currency = 'USD' AND l.price <= ${params.maxPrice}) OR (l.currency = 'SDG' AND l.price <= ${maxSdg})`);
      }
      if (parts.length) conditions.push(Prisma.sql`(${Prisma.join(parts, ' AND ')})`);
    }
  }

  // Geo bbox pre-filter
  if (params.lat != null && params.lng != null && params.radiusKm != null) {
    const r = params.radiusKm;
    const latDelta = r / 111.32;
    const lngDelta = r / (111.32 * Math.cos((params.lat * Math.PI) / 180));
    conditions.push(Prisma.sql`l."pubLat" BETWEEN ${params.lat - latDelta} AND ${params.lat + latDelta}`);
    conditions.push(Prisma.sql`l."pubLng" BETWEEN ${params.lng - lngDelta} AND ${params.lng + lngDelta}`);
  }

  // Text search
  if (tokens.length > 0) {
    for (const token of tokens) {
      conditions.push(Prisma.sql`l."searchText" ILIKE ${'%' + token + '%'}`);
    }
  }

  // onlyListingId (saved-search match check)
  if (params.onlyListingId) {
    conditions.push(Prisma.sql`l.id = ${params.onlyListingId}`);
  }

  const whereClause = Prisma.sql`${Prisma.join(conditions, ' AND ')}`;

  // Relevance score expression
  const halfLife = await settings.get<number>('search.recencyHalfLifeDays', 14);
  const relevanceExpr = tokens.length > 0
    ? Prisma.sql`(
        0.45 * COALESCE(similarity(l."searchText", ${tokens.join(' ')}), 0)
        + 0.25 * EXP(-EXTRACT(EPOCH FROM (now() - l."publishedAt")) / 86400.0 / ${halfLife})
        + 0.20 * (l."qualityScore"::float / 100.0)
        + 0.10 * (l."viewCount" + 3 * l."favoriteCount" + 5 * l."leadCount")::float / GREATEST(1, (l."viewCount" + 3 * l."favoriteCount" + 5 * l."leadCount")::float + 100)
      )`
    : Prisma.sql`(
        0.25 * EXP(-EXTRACT(EPOCH FROM (now() - l."publishedAt")) / 86400.0 / ${halfLife})
        + 0.20 * (l."qualityScore"::float / 100.0)
        + 0.10 * (l."viewCount" + 3 * l."favoriteCount" + 5 * l."leadCount")::float / GREATEST(1, (l."viewCount" + 3 * l."favoriteCount" + 5 * l."leadCount")::float + 100)
      )`;

  const orderExpr = sort === 'newest'
    ? Prisma.sql`l."publishedAt" DESC`
    : sort === 'price_asc'
    ? Prisma.sql`l.price ASC NULLS LAST`
    : sort === 'price_desc'
    ? Prisma.sql`l.price DESC NULLS LAST`
    : sort === 'distance' && params.lat != null && params.lng != null
    ? Prisma.sql`(l."pubLat" - ${params.lat})^2 + (l."pubLng" - ${params.lng})^2 ASC`
    : Prisma.sql`${relevanceExpr} DESC`;

  type RawRow = {
    id: string; publicSeq: number; title: string; price: string | null;
    currency: string; isNegotiable: boolean; listingType: string;
    qualityScore: number; publishedAt: Date; cityId: string | null;
    locationName: string | null; pubLat: number | null; pubLng: number | null;
    coverUrl: string | null; coverThumb: string | null;
    ownerId: string; ownerName: string; ownerAvatar: string | null;
    ownerBadges: string[]; ownerVerified: boolean;
  };

  const rows = await db.$queryRaw<RawRow[]>`
    SELECT
      l.id, l."publicSeq", l.title, l.price, l.currency, l."isNegotiable",
      l."listingType", l."qualityScore", l."publishedAt",
      l."cityId", l."locationName", l."pubLat", l."pubLng",
      (SELECT lm.url FROM "ListingMedia" lm WHERE lm."listingId" = l.id AND lm."isCover" = true LIMIT 1) AS "coverUrl",
      (SELECT lm."thumbUrl" FROM "ListingMedia" lm WHERE lm."listingId" = l.id AND lm."isCover" = true LIMIT 1) AS "coverThumb",
      u.id AS "ownerId", u."fullName" AS "ownerName", u."avatarUrl" AS "ownerAvatar",
      u.badges AS "ownerBadges",
      (u."emailVerifiedAt" IS NOT NULL) AS "ownerVerified"
    FROM "Listing" l
    JOIN "User" u ON u.id = l."ownerId"
    WHERE ${whereClause}
    ORDER BY ${orderExpr}
    LIMIT ${limit + 1} OFFSET ${offset}
  `;

  // Favorite ids for viewer
  let favoriteSet = new Set<string>();
  if (viewerId && rows.length > 0) {
    const ids = rows.map((r) => r.id);
    const favs = await db.favorite.findMany({
      where: { userId: viewerId, listingId: { in: ids } },
      select: { listingId: true },
    });
    favoriteSet = new Set(favs.map((f) => f.listingId));
  }

  const hasMore = rows.length > limit;
  const slice = hasMore ? rows.slice(0, limit) : rows;

  const items = slice.map((r) => {
    const item: Record<string, unknown> = {
      id: r.id,
      readableId: `MARBOU-${String(r.publicSeq).padStart(5, '0')}`,
      title: r.title,
      price: r.price != null ? Number(r.price) : null,
      currency: r.currency,
      isNegotiable: r.isNegotiable,
      cover: r.coverUrl ? { url: r.coverUrl, thumbUrl: r.coverThumb } : null,
      cityId: r.cityId,
      locationName: r.locationName,
      pubLat: r.pubLat,
      pubLng: r.pubLng,
      listingType: r.listingType,
      qualityScore: r.qualityScore,
      publishedAt: r.publishedAt,
      seller: {
        id: r.ownerId,
        fullName: r.ownerName,
        avatarUrl: r.ownerAvatar,
        badges: r.ownerBadges ?? [],
        verified: r.ownerVerified,
      },
    };
    if (params.lat != null && params.lng != null && r.pubLat != null && r.pubLng != null) {
      item.distanceKm = Math.round(haversineKm(params.lat, params.lng, r.pubLat, r.pubLng) * 10) / 10;
    }
    if (viewerId) item.isFavorite = favoriteSet.has(r.id);
    return item;
  });

  const nextCursor = hasMore
    ? encodeCursor({ o: offset + limit, asOf })
    : null;

  // Async SearchLog insert
  setImmediate(async () => {
    try {
      const deviceHash = sha256((params as Record<string, unknown>)._deviceId as string ?? 'anon' + env.ANALYTICS_SALT);
      await db.searchLog.create({
        data: {
          userId: viewerId ?? null,
          deviceHash,
          q: params.q ?? '',
          filters: (params.filters ?? {}) as never,
          resultCount: items.length,
        },
      });
    } catch { /* best-effort */ }
  });

  return { items, nextCursor, hasMore };
}

// ─── Suggest ──────────────────────────────────────────────────────────────────
const suggestCache = new Map<string, { results: unknown[]; loadedAt: number }>();

export async function suggest(q: string): Promise<unknown[]> {
  const key = normalizeArabic(q.trim().toLowerCase()).slice(0, 40);
  const cached = suggestCache.get(key);
  if (cached && Date.now() - cached.loadedAt < 30_000) return cached.results;

  type SugRow = { title: string; id: string };
  const rows = await db.$queryRaw<SugRow[]>`
    SELECT id, title FROM "Listing"
    WHERE status = 'ACTIVE' AND "deletedAt" IS NULL
      AND similarity("searchText", ${key}) > 0.1
    ORDER BY similarity("searchText", ${key}) DESC
    LIMIT 5
  `;
  const results = rows.map((r) => ({ id: r.id, title: r.title }));
  suggestCache.set(key, { results, loadedAt: Date.now() });
  return results;
}

// ─── Home ─────────────────────────────────────────────────────────────────────
const homeCache = new Map<string, { data: unknown; loadedAt: number }>();

export async function getHome(lang: string, lat?: number, lng?: number) {
  if (lat == null || lng == null) {
    const cacheKey = `home:${lang}`;
    const cached = homeCache.get(cacheKey);
    if (cached && Date.now() - cached.loadedAt < 60_000) return cached.data;
  }

  const { getCategories } = await import('../catalog/categories');
  const { categories } = await getCategories();

  type ListingRow = { id: string; publicSeq: number; title: string; price: string | null; currency: string; coverUrl: string | null };

  const recent = await db.$queryRaw<ListingRow[]>`
    SELECT l.id, l."publicSeq", l.title, l.price, l.currency,
      (SELECT lm.url FROM "ListingMedia" lm WHERE lm."listingId" = l.id AND lm."isCover" = true LIMIT 1) AS "coverUrl"
    FROM "Listing" l
    WHERE l.status = 'ACTIVE' AND l."deletedAt" IS NULL AND l."expiresAt" > now()
    ORDER BY l."publishedAt" DESC LIMIT 12
  `;

  const popular = await db.$queryRaw<ListingRow[]>`
    SELECT l.id, l."publicSeq", l.title, l.price, l.currency,
      (SELECT lm.url FROM "ListingMedia" lm WHERE lm."listingId" = l.id AND lm."isCover" = true LIMIT 1) AS "coverUrl"
    FROM "Listing" l
    WHERE l.status = 'ACTIVE' AND l."deletedAt" IS NULL AND l."expiresAt" > now()
      AND l."publishedAt" > now() - interval '30 days'
    ORDER BY (l."viewCount" + 3 * l."favoriteCount" + 5 * l."leadCount") DESC LIMIT 12
  `;

  const mapRow = (r: ListingRow) => ({
    id: r.id,
    readableId: `MARBOU-${String(r.publicSeq).padStart(5, '0')}`,
    title: r.title,
    price: r.price != null ? Number(r.price) : null,
    currency: r.currency,
    coverUrl: r.coverUrl,
  });

  let nearby: unknown[] = [];
  if (lat != null && lng != null) {
    const latD = 50 / 111.32;
    const lngD = 50 / (111.32 * Math.cos((lat * Math.PI) / 180));
    const nearbyRows = await db.$queryRaw<ListingRow[]>`
      SELECT l.id, l."publicSeq", l.title, l.price, l.currency,
        (SELECT lm.url FROM "ListingMedia" lm WHERE lm."listingId" = l.id AND lm."isCover" = true LIMIT 1) AS "coverUrl"
      FROM "Listing" l
      WHERE l.status = 'ACTIVE' AND l."deletedAt" IS NULL AND l."expiresAt" > now()
        AND l."pubLat" BETWEEN ${lat - latD} AND ${lat + latD}
        AND l."pubLng" BETWEEN ${lng - lngD} AND ${lng + lngD}
      ORDER BY (l."pubLat" - ${lat})^2 + (l."pubLng" - ${lng})^2 ASC LIMIT 12
    `;
    nearby = nearbyRows.map(mapRow);
  }

  const data = {
    banners: [],
    categories,
    recent: recent.map(mapRow),
    popular: popular.map(mapRow),
    ...(nearby.length > 0 ? { nearby } : {}),
  };

  if (lat == null || lng == null) {
    homeCache.set(`home:${lang}`, { data, loadedAt: Date.now() });
  }
  return data;
}

// ─── Nearby ───────────────────────────────────────────────────────────────────
export async function getNearby(lat: number, lng: number, radiusKm = 10, limit = 20) {
  return searchListings({ lat, lng, radiusKm, sort: 'distance', limit });
}

// ─── Recommendations ──────────────────────────────────────────────────────────
export async function getRecommendations(viewerId?: string, limit = 20) {
  if (viewerId) {
    const logs = await db.searchLog.findMany({
      where: { userId: viewerId },
      orderBy: { createdAt: 'desc' },
      take: 5,
    });
    const catIds = new Set<string>();
    for (const log of logs) {
      const f = log.filters as Record<string, unknown>;
      if (f.categoryId) catIds.add(f.categoryId as string);
    }
    const favs = await db.favorite.findMany({
      where: { userId: viewerId },
      include: { listing: { select: { categoryId: true } } },
      take: 10,
    });
    for (const fav of favs) catIds.add(fav.listing.categoryId);

    if (catIds.size > 0) {
      const catId = Array.from(catIds)[0];
      return searchListings({ categoryId: catId, sort: 'relevance', limit }, viewerId);
    }
  }
  return searchListings({ sort: 'relevance', limit }, viewerId);
}

// ─── Compare ──────────────────────────────────────────────────────────────────
export async function compareListings(ids: string[], _viewerId?: string) {
  const { E } = await import('../../shared/errors');
  if (ids.length < 2 || ids.length > 4) throw E.rule('COMPARE_COUNT');

  const listings = await db.listing.findMany({
    where: { id: { in: ids }, status: { in: ['ACTIVE', 'SOLD'] }, deletedAt: null },
    include: { category: true, owner: { select: { id: true, emailVerifiedAt: true } } },
  });
  if (listings.length !== ids.length) throw E.notFound('LISTING_NOT_FOUND');

  // Check same root category
  async function getRootId(catId: string): Promise<string> {
    let cur = await db.category.findUnique({ where: { id: catId }, select: { id: true, parentId: true } });
    while (cur?.parentId) {
      cur = await db.category.findUnique({ where: { id: cur.parentId }, select: { id: true, parentId: true } });
    }
    return cur?.id ?? catId;
  }

  const rootIds = await Promise.all(listings.map((l) => getRootId(l.categoryId)));
  if (new Set(rootIds).size > 1) throw E.rule('COMPARE_MISMATCH');

  const rootCat = await db.category.findUnique({ where: { id: rootIds[0] } });
  if (!rootCat?.supportsCompare) throw E.rule('COMPARE_NOT_SUPPORTED');

  // Get showInCompare attributes
  const attrs = await db.categoryAttribute.findMany({
    where: { categoryId: { in: [listings[0].categoryId, rootIds[0]] }, showInCompare: true, isArchived: false },
    orderBy: { displayOrder: 'asc' } as never,
  });

  const columns = listings.map((l) => ({
    id: l.id,
    title: l.title,
    price: l.price,
    currency: l.currency,
    sellerVerified: !!l.owner.emailVerifiedAt,
  }));

  const rows = attrs.map((a) => ({
    key: a.attributeKey,
    labelAr: a.labelAr,
    labelEn: a.labelEn,
    values: listings.map((l) => {
      const attrs = l.dynamicAttributes as Record<string, unknown>;
      return attrs[a.attributeKey] ?? null;
    }),
  }));

  return { columns, rows };
}

// ─── Similar ──────────────────────────────────────────────────────────────────
export async function getSimilar(listingId: string, viewerId?: string) {
  const listing = await db.listing.findUnique({ where: { id: listingId } });
  if (!listing) return { items: [], nextCursor: null, hasMore: false };

  const price = listing.price ? Number(listing.price) : null;
  const minP = price ? price * 0.7 : undefined;
  const maxP = price ? price * 1.3 : undefined;

  return searchListings({
    categoryId: listing.categoryId,
    cityId: listing.cityId ?? undefined,
    minPrice: minP,
    maxPrice: maxP,
    currency: listing.currency,
    sort: 'relevance',
    limit: 10,
  }, viewerId);
}

// ─── Price insight ────────────────────────────────────────────────────────────
const insightCache = new Map<string, { data: unknown; loadedAt: number }>();

export async function getPriceInsight(listingId: string) {
  const cached = insightCache.get(listingId);
  if (cached && Date.now() - cached.loadedAt < 600_000) return cached.data;

  const listing = await db.listing.findUnique({ where: { id: listingId } });
  if (!listing || !listing.price) return { available: false };

  const minComparables = await settings.get<number>('insight.minComparables', 8);
  const bandPct = await settings.get<number>('insight.bandPct', 15);

  // Get filterable SINGLE_SELECT attributes for matching
  const filterableAttrs = await db.categoryAttribute.findMany({
    where: { categoryId: listing.categoryId, isFilterable: true, dataType: 'SINGLE_SELECT', isArchived: false },
  });

  const storedAttrs = listing.dynamicAttributes as Record<string, unknown>;
  const attrConditions: Prisma.Sql[] = [];
  for (const attr of filterableAttrs) {
    const val = storedAttrs[attr.attributeKey];
    if (val != null) {
      attrConditions.push(Prisma.sql`l."dynamicAttributes" @> ${JSON.stringify({ [attr.attributeKey]: val })}::jsonb`);
    }
  }

  // Year +-2 if present
  const year = storedAttrs.year;
  if (typeof year === 'number') {
    attrConditions.push(Prisma.sql`(l."dynamicAttributes"->>'year')::int BETWEEN ${year - 2} AND ${year + 2}`);
  }

  const attrWhere = attrConditions.length > 0
    ? Prisma.sql`AND ${Prisma.join(attrConditions, ' AND ')}`
    : Prisma.sql``;

  type PriceRow = { price: string };
  const rows = await db.$queryRaw<PriceRow[]>`
    SELECT l.price FROM "Listing" l
    WHERE l."categoryId" = ${listing.categoryId}
      AND l.id != ${listingId}
      AND l.currency = ${listing.currency}
      AND l.price IS NOT NULL
      AND l."deletedAt" IS NULL
      AND (l.status = 'ACTIVE' OR (l.status = 'SOLD' AND l."soldAt" > now() - interval '90 days'))
      ${attrWhere}
  `;

  if (rows.length < minComparables) {
    const result = { available: false };
    insightCache.set(listingId, { data: result, loadedAt: Date.now() });
    return result;
  }

  const prices = rows.map((r) => Number(r.price)).sort((a, b) => a - b);
  const n = prices.length;
  const median = n % 2 === 0 ? (prices[n / 2 - 1] + prices[n / 2]) / 2 : prices[Math.floor(n / 2)];
  const lo = prices[Math.floor(n * 0.25)];
  const hi = prices[Math.floor(n * 0.75)];

  const myPrice = Number(listing.price);
  const band = median * (bandPct / 100);
  const label = myPrice < median - band ? 'BELOW' : myPrice > median + band ? 'ABOVE' : 'FAIR';

  const result = { available: true, n, median, lo, hi, label };
  insightCache.set(listingId, { data: result, loadedAt: Date.now() });
  return result;
}
