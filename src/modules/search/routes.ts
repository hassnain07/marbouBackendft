import { Router } from 'express';
import { z } from 'zod';
import { defineRoute } from '../../shared/route';
import * as svc from './service';
import { db } from '../../shared/db';
import { E } from '../../shared/errors';
import { decodeCursor, paginate } from '../../shared/pagination';

export const searchRouter = Router();

const searchQuery = z.object({
  q: z.string().optional(),
  categoryId: z.string().uuid().optional(),
  type: z.enum(['SALE', 'RENT', 'WANTED', 'SERVICE', 'JOB']).optional(),
  cityId: z.string().optional(),
  minPrice: z.coerce.number().optional(),
  maxPrice: z.coerce.number().optional(),
  currency: z.enum(['SDG', 'USD']).optional(),
  lat: z.coerce.number().min(-90).max(90).optional(),
  lng: z.coerce.number().min(-180).max(180).optional(),
  radiusKm: z.coerce.number().positive().optional(),
  sort: z.enum(['relevance', 'newest', 'price_asc', 'price_desc', 'distance']).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  filters: z.string().optional(), // JSON string
});

defineRoute({
  router: searchRouter, method: 'get', path: '/search',
  summary: 'Search listings', tag: 'Search', auth: 'optional',
  query: searchQuery,
  handler: async ({ query, user, req, res }) => {
    let filters: Record<string, unknown> | undefined;
    if (query.filters) {
      try { filters = JSON.parse(query.filters); } catch { /* ignore */ }
    }
    const params = { ...query, filters };
    (params as Record<string, unknown>)._deviceId =
      (req.headers['x-device-id'] as string | undefined) ?? req.ip ?? 'anon';

    const result = await svc.searchListings(params, user?.id);

    if (!user) {
      res.setHeader('Cache-Control', 'public, max-age=15');
    }
    return result;
  },
});

defineRoute({
  router: searchRouter, method: 'get', path: '/search/suggest',
  summary: 'Search suggestions', tag: 'Search', auth: 'public',
  query: z.object({ q: z.string().min(1) }),
  handler: async ({ query }) => svc.suggest(query.q),
});

defineRoute({
  router: searchRouter, method: 'get', path: '/home',
  summary: 'Home feed', tag: 'Search', auth: 'optional',
  query: z.object({
    lat: z.coerce.number().optional(),
    lng: z.coerce.number().optional(),
  }),
  handler: async ({ query, lang }) => svc.getHome(lang, query.lat, query.lng),
});

defineRoute({
  router: searchRouter, method: 'get', path: '/nearby',
  summary: 'Nearby listings', tag: 'Search', auth: 'optional',
  query: z.object({
    lat: z.coerce.number().min(-90).max(90),
    lng: z.coerce.number().min(-180).max(180),
    radiusKm: z.coerce.number().positive().default(10),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  }),
  handler: async ({ query }) =>
    svc.getNearby(query.lat, query.lng, query.radiusKm, query.limit),
});

defineRoute({
  router: searchRouter, method: 'get', path: '/recommendations',
  summary: 'Recommended listings', tag: 'Search', auth: 'optional',
  query: z.object({ limit: z.coerce.number().int().min(1).max(50).default(20) }),
  handler: async ({ query, user }) => svc.getRecommendations(user?.id, query.limit),
});

defineRoute({
  router: searchRouter, method: 'get', path: '/compare',
  summary: 'Compare listings', tag: 'Search', auth: 'optional',
  query: z.object({ ids: z.string() }),
  handler: async ({ query, user }) => {
    const ids = query.ids.split(',').map((s) => s.trim()).filter(Boolean);
    return svc.compareListings(ids, user?.id);
  },
});

defineRoute({
  router: searchRouter, method: 'get', path: '/listings/:id/similar',
  summary: 'Similar listings', tag: 'Search', auth: 'optional',
  params: z.object({ id: z.string().uuid() }),
  handler: async ({ params, user }) => svc.getSimilar(params.id, user?.id),
});

defineRoute({
  router: searchRouter, method: 'get', path: '/listings/:id/price-insight',
  summary: 'Price insight', tag: 'Search', auth: 'optional',
  params: z.object({ id: z.string().uuid() }),
  handler: async ({ params }) => svc.getPriceInsight(params.id),
});

// ─── Saved searches ───────────────────────────────────────────────────────────

defineRoute({
  router: searchRouter, method: 'get', path: '/saved-searches',
  summary: 'List saved searches', tag: 'Search', auth: 'user',
  handler: async ({ user }) => {
    const searches = await db.savedSearch.findMany({
      where: { userId: user!.id },
      orderBy: { createdAt: 'desc' },
    });
    return { data: searches };
  },
});

defineRoute({
  router: searchRouter, method: 'post', path: '/saved-searches',
  summary: 'Create saved search', tag: 'Search', auth: 'verified',
  body: z.object({
    name: z.string().min(1).max(60),
    query: z.record(z.unknown()),
    frequency: z.enum(['INSTANT', 'DAILY']).default('INSTANT'),
  }),
  handler: async ({ body, user }) => {
    const count = await db.savedSearch.count({ where: { userId: user!.id } });
    if (count >= 20) throw E.rule('SAVED_SEARCH_LIMIT');
    const ss = await db.savedSearch.create({
      data: { userId: user!.id, name: body.name, query: body.query as never, frequency: body.frequency },
    });
    return ss;
  },
});

defineRoute({
  router: searchRouter, method: 'patch', path: '/saved-searches/:id',
  summary: 'Update saved search', tag: 'Search', auth: 'user',
  params: z.object({ id: z.string().uuid() }),
  body: z.object({
    name: z.string().min(1).max(60).optional(),
    query: z.record(z.unknown()).optional(),
    frequency: z.enum(['INSTANT', 'DAILY']).optional(),
  }),
  handler: async ({ params, body, user }) => {
    const ss = await db.savedSearch.findUnique({ where: { id: params.id } });
    if (!ss || ss.userId !== user!.id) throw E.notFound('SAVED_SEARCH_NOT_FOUND');
    return db.savedSearch.update({ where: { id: params.id }, data: body as never });
  },
});

defineRoute({
  router: searchRouter, method: 'delete', path: '/saved-searches/:id',
  summary: 'Delete saved search', tag: 'Search', auth: 'user',
  params: z.object({ id: z.string().uuid() }),
  handler: async ({ params, user }) => {
    const ss = await db.savedSearch.findUnique({ where: { id: params.id } });
    if (!ss || ss.userId !== user!.id) throw E.notFound('SAVED_SEARCH_NOT_FOUND');
    await db.savedSearch.delete({ where: { id: params.id } });
    return { ok: true };
  },
});

// ─── Favorites ────────────────────────────────────────────────────────────────

defineRoute({
  router: searchRouter, method: 'post', path: '/listings/:id/favorite',
  summary: 'Add to favorites', tag: 'Search', auth: 'user',
  params: z.object({ id: z.string().uuid() }),
  handler: async ({ params, user }) => {
    const listing = await db.listing.findUnique({ where: { id: params.id } });
    if (!listing || listing.deletedAt || !['ACTIVE', 'SOLD', 'EXPIRED'].includes(listing.status)) {
      throw E.notFound('LISTING_NOT_FOUND');
    }
    await db.$transaction(async (tx) => {
      await tx.favorite.upsert({
        where: { userId_listingId: { userId: user!.id, listingId: params.id } },
        create: { userId: user!.id, listingId: params.id, priceAtSave: listing.price },
        update: {},
      });
      await tx.listing.update({
        where: { id: params.id },
        data: { favoriteCount: { increment: 1 } },
      });
    });
    return { ok: true };
  },
});

defineRoute({
  router: searchRouter, method: 'delete', path: '/listings/:id/favorite',
  summary: 'Remove from favorites', tag: 'Search', auth: 'user',
  params: z.object({ id: z.string().uuid() }),
  handler: async ({ params, user }) => {
    const existing = await db.favorite.findUnique({
      where: { userId_listingId: { userId: user!.id, listingId: params.id } },
    });
    if (!existing) return { ok: true };
    await db.$transaction(async (tx) => {
      await tx.favorite.delete({
        where: { userId_listingId: { userId: user!.id, listingId: params.id } },
      });
      await tx.listing.update({
        where: { id: params.id },
        data: { favoriteCount: { decrement: 1 } },
      });
    });
    return { ok: true };
  },
});

defineRoute({
  router: searchRouter, method: 'get', path: '/me/favorites',
  summary: 'My favorites', tag: 'Search', auth: 'user',
  query: z.object({
    cursor: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  }),
  handler: async ({ query, user }) => {
    const offset = query.cursor ? decodeCursor(query.cursor).o : 0;
    const take = query.limit + 1;

    const favs = await db.favorite.findMany({
      where: { userId: user!.id },
      orderBy: { createdAt: 'desc' },
      include: {
        listing: {
          include: { media: { where: { isCover: true }, take: 1 } },
        },
      },
      skip: offset,
      take,
    });

    const items = favs.slice(0, query.limit).map((f) => {
      const l = f.listing;
      if (l.deletedAt || ['HIDDEN', 'AUTO_HIDDEN', 'SUSPENDED', 'ARCHIVED'].includes(l.status)) {
        return { id: l.id, unavailable: true };
      }
      return {
        id: l.id,
        readableId: `MARBOU-${String(l.publicSeq).padStart(5, '0')}`,
        title: l.title,
        price: l.price,
        currency: l.currency,
        status: l.status,
        coverUrl: l.media[0]?.url ?? null,
        priceAtSave: f.priceAtSave,
        priceDropped: f.priceAtSave != null && l.price != null && Number(l.price) < Number(f.priceAtSave),
        savedAt: f.createdAt,
      };
    });

    return paginate(items, query.limit, offset);
  },
});
