import { Router } from 'express';
import { z } from 'zod';
import { defineRoute } from '../../shared/route';
import * as svc from './service';
import * as cats from './categories';
import * as geo from './geo';

export const catalogRouter = Router();

// ─── Platform ─────────────────────────────────────────────────────────────────

defineRoute({
  router: catalogRouter, method: 'get', path: '/health',
  summary: 'Health check', tag: 'Platform', auth: 'public',
  handler: async () => svc.getHealth(),
});

defineRoute({
  router: catalogRouter, method: 'get', path: '/health/ready',
  summary: 'Readiness check', tag: 'Platform', auth: 'public',
  handler: async () => svc.getHealthReady(),
});

defineRoute({
  router: catalogRouter, method: 'get', path: '/config',
  summary: 'Get public configuration', tag: 'Platform', auth: 'public',
  handler: async ({ req, res }) => {
    const { config, etag } = await svc.getConfig();
    const ifNoneMatch = req.headers['if-none-match'];
    if (ifNoneMatch === etag) { res.status(304).end(); return; }
    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', 'public, max-age=30');
    return config;
  },
});

defineRoute({
  router: catalogRouter, method: 'get', path: '/translations',
  summary: 'Get translations', tag: 'Platform', auth: 'public',
  query: z.object({ lang: z.enum(['ar', 'en']).default('ar') }),
  handler: async ({ query, req, res }) => {
    const { translations, etag } = await svc.getTranslations(query.lang);
    const ifNoneMatch = req.headers['if-none-match'];
    if (ifNoneMatch === etag) { res.status(304).end(); return; }
    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', 'public, max-age=60');
    return translations;
  },
});

defineRoute({
  router: catalogRouter, method: 'get', path: '/exchange-rate',
  summary: 'Get exchange rate', tag: 'Platform', auth: 'public',
  query: z.object({ base: z.string().default('USD'), quote: z.string().default('SDG') }),
  handler: async ({ query }) => {
    const rate = await svc.getExchangeRate(query.base, query.quote);
    if (!rate) return { available: false };
    return rate;
  },
});

// ─── Geo ──────────────────────────────────────────────────────────────────────

defineRoute({
  router: catalogRouter, method: 'get', path: '/countries',
  summary: 'List countries', tag: 'Geo', auth: 'public',
  handler: async () => geo.getCountries(),
});

defineRoute({
  router: catalogRouter, method: 'get', path: '/geo/states',
  summary: 'List states', tag: 'Geo', auth: 'public',
  query: z.object({ country: z.string().optional() }),
  handler: async () => geo.getStates(),
});

defineRoute({
  router: catalogRouter, method: 'get', path: '/geo/states/:id/cities',
  summary: 'List cities in a state', tag: 'Geo', auth: 'public',
  params: z.object({ id: z.string() }),
  handler: async ({ params }) => geo.getCities(params.id),
});

defineRoute({
  router: catalogRouter, method: 'get', path: '/geo/cities/:id/neighborhoods',
  summary: 'List neighborhoods in a city', tag: 'Geo', auth: 'public',
  params: z.object({ id: z.string() }),
  handler: async ({ params }) => geo.getNeighborhoods(params.id),
});

defineRoute({
  router: catalogRouter, method: 'get', path: '/geo/places',
  summary: 'Generic place tree', tag: 'Geo', auth: 'public',
  query: z.object({ parentId: z.string().optional(), level: z.string().optional() }),
  handler: async ({ query }) => geo.getPlaces(query),
});

// ─── Categories (public) ──────────────────────────────────────────────────────

defineRoute({
  router: catalogRouter, method: 'get', path: '/categories',
  summary: 'List category tree', tag: 'Categories', auth: 'public',
  query: z.object({ parentId: z.string().optional() }),
  handler: async ({ query, req, res }) => {
    const { categories, etag } = await cats.getCategories(query.parentId);
    const ifNoneMatch = req.headers['if-none-match'];
    if (ifNoneMatch === etag) { res.status(304).end(); return; }
    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', 'public, max-age=60');
    return { categories };
  },
});

defineRoute({
  router: catalogRouter, method: 'get', path: '/categories/:id',
  summary: 'Get category by id', tag: 'Categories', auth: 'public',
  params: z.object({ id: z.string() }),
  handler: async ({ params }) => cats.getCategoryById(params.id),
});

defineRoute({
  router: catalogRouter, method: 'get', path: '/categories/:id/schema',
  summary: 'Get category attribute schema', tag: 'Categories', auth: 'public',
  params: z.object({ id: z.string() }),
  query: z.object({ includeArchived: z.string().optional() }),
  handler: async ({ params, query, req, res }) => {
    const includeArchived = query.includeArchived === 'true';
    const schema = await cats.getCategorySchema(params.id, includeArchived);
    const ifNoneMatch = req.headers['if-none-match'];
    if (ifNoneMatch === schema.etag) { res.status(304).end(); return; }
    res.setHeader('ETag', schema.etag);
    res.setHeader('Cache-Control', 'public, max-age=60');
    return schema;
  },
});

// ─── Admin categories ─────────────────────────────────────────────────────────

defineRoute({
  router: catalogRouter, method: 'post', path: '/admin/categories',
  summary: 'Create category', tag: 'Admin', auth: 'admin', perm: '*',
  body: z.object({
    slug: z.string().min(1).max(80),
    parentId: z.string().optional(),
    nameAr: z.string().min(1).max(100),
    nameEn: z.string().min(1).max(100),
    descriptionAr: z.string().optional(),
    descriptionEn: z.string().optional(),
    postingRestricted: z.boolean().optional(),
    postingMessage: z.string().optional(),
    expiryDays: z.number().int().positive().optional(),
    supportsCompare: z.boolean().optional(),
    isVideoAllowed: z.boolean().optional(),
    sort: z.number().int().optional(),
  }),
  handler: async ({ body, admin }) => cats.adminCreateCategory(admin!.id, body),
});

defineRoute({
  router: catalogRouter, method: 'patch', path: '/admin/categories/:id',
  summary: 'Update category', tag: 'Admin', auth: 'admin', perm: '*',
  params: z.object({ id: z.string() }),
  body: z.object({
    nameAr: z.string().min(1).max(100).optional(),
    nameEn: z.string().min(1).max(100).optional(),
    descriptionAr: z.string().optional(),
    descriptionEn: z.string().optional(),
    postingRestricted: z.boolean().optional(),
    postingMessage: z.string().optional(),
    expiryDays: z.number().int().positive().optional(),
    supportsCompare: z.boolean().optional(),
    isVideoAllowed: z.boolean().optional(),
    sort: z.number().int().optional(),
  }),
  handler: async ({ params, body, admin }) => cats.adminUpdateCategory(admin!.id, params.id, body),
});

defineRoute({
  router: catalogRouter, method: 'post', path: '/admin/categories/:id/archive',
  summary: 'Archive category', tag: 'Admin', auth: 'admin', perm: '*',
  params: z.object({ id: z.string() }),
  handler: async ({ params, admin }) => { await cats.adminArchiveCategory(admin!.id, params.id); return { ok: true }; },
});

defineRoute({
  router: catalogRouter, method: 'post', path: '/admin/categories/:id/restore',
  summary: 'Restore category', tag: 'Admin', auth: 'admin', perm: '*',
  params: z.object({ id: z.string() }),
  handler: async ({ params, admin }) => { await cats.adminRestoreCategory(admin!.id, params.id); return { ok: true }; },
});

defineRoute({
  router: catalogRouter, method: 'post', path: '/admin/categories/reorder',
  summary: 'Reorder categories', tag: 'Admin', auth: 'admin', perm: '*',
  body: z.object({ orders: z.array(z.object({ id: z.string(), displayOrder: z.number().int() })) }),
  handler: async ({ body, admin }) => { await cats.adminReorderCategories(admin!.id, body.orders); return { ok: true }; },
});

// ─── Admin attributes ─────────────────────────────────────────────────────────

defineRoute({
  router: catalogRouter, method: 'post', path: '/admin/categories/:id/attributes',
  summary: 'Create attribute', tag: 'Admin', auth: 'admin', perm: '*',
  params: z.object({ id: z.string() }),
  body: z.object({
    attributeKey: z.string().min(1).max(80).regex(/^[a-z][a-zA-Z0-9_]*$/),
    labelAr: z.string().min(1).max(100),
    labelEn: z.string().min(1).max(100),
    dataType: z.enum(['TEXT', 'NUMBER', 'BOOLEAN', 'SINGLE_SELECT', 'MULTI_SELECT', 'DATE', 'RANGE', 'FILE_URL']),
    isRequired: z.boolean().optional(),
    isPrivate: z.boolean().optional(),
    isFilterable: z.boolean().optional(),
    promoteToIndex: z.boolean().optional(),
    showInCompare: z.boolean().optional(),
    optionsList: z.array(z.object({ value: z.string(), labelEn: z.string(), labelAr: z.string(), dependsOn: z.record(z.string()).optional() })).optional(),
    validationRules: z.record(z.unknown()).optional(),
    dependsOn: z.string().optional(),
    displayOrder: z.number().int().optional(),
  }),
  handler: async ({ params, body, admin }) => cats.adminCreateAttribute(admin!.id, params.id, body),
});

defineRoute({
  router: catalogRouter, method: 'patch', path: '/admin/categories/:id/attributes/:attrId',
  summary: 'Update attribute', tag: 'Admin', auth: 'admin', perm: '*',
  params: z.object({ id: z.string(), attrId: z.string() }),
  body: z.object({
    labelAr: z.string().min(1).max(100).optional(),
    labelEn: z.string().min(1).max(100).optional(),
    isRequired: z.boolean().optional(),
    isPrivate: z.boolean().optional(),
    isFilterable: z.boolean().optional(),
    promoteToIndex: z.boolean().optional(),
    showInCompare: z.boolean().optional(),
    optionsList: z.array(z.object({ value: z.string(), labelEn: z.string(), labelAr: z.string() })).optional(),
    validationRules: z.record(z.unknown()).optional(),
    dependsOn: z.string().optional(),
    displayOrder: z.number().int().optional(),
  }),
  handler: async ({ params, body, admin }) => cats.adminUpdateAttribute(admin!.id, params.attrId, body),
});

defineRoute({
  router: catalogRouter, method: 'post', path: '/admin/categories/:id/attributes/:attrId/archive',
  summary: 'Archive attribute', tag: 'Admin', auth: 'admin', perm: '*',
  params: z.object({ id: z.string(), attrId: z.string() }),
  handler: async ({ params, admin }) => { await cats.adminArchiveAttribute(admin!.id, params.attrId); return { ok: true }; },
});

// Legacy flat attribute routes (kept for backward compat)
defineRoute({
  router: catalogRouter, method: 'patch', path: '/admin/attributes/:id',
  summary: 'Update attribute (legacy)', tag: 'Admin', auth: 'admin', perm: '*',
  params: z.object({ id: z.string() }),
  body: z.object({
    labelAr: z.string().min(1).max(100).optional(),
    labelEn: z.string().min(1).max(100).optional(),
    isRequired: z.boolean().optional(),
    isPrivate: z.boolean().optional(),
    isFilterable: z.boolean().optional(),
    promoteToIndex: z.boolean().optional(),
    showInCompare: z.boolean().optional(),
    optionsList: z.array(z.object({ value: z.string(), labelEn: z.string(), labelAr: z.string() })).optional(),
    validationRules: z.record(z.unknown()).optional(),
    dependsOn: z.string().optional(),
    displayOrder: z.number().int().optional(),
  }),
  handler: async ({ params, body, admin }) => cats.adminUpdateAttribute(admin!.id, params.id, body),
});

defineRoute({
  router: catalogRouter, method: 'post', path: '/admin/attributes/:id/archive',
  summary: 'Archive attribute (legacy)', tag: 'Admin', auth: 'admin', perm: '*',
  params: z.object({ id: z.string() }),
  handler: async ({ params, admin }) => { await cats.adminArchiveAttribute(admin!.id, params.id); return { ok: true }; },
});

defineRoute({
  router: catalogRouter, method: 'delete', path: '/admin/attributes/:id',
  summary: 'Delete attribute (only if unused)', tag: 'Admin', auth: 'admin', perm: '*',
  params: z.object({ id: z.string() }),
  handler: async ({ params, admin }) => { await cats.adminDeleteAttribute(admin!.id, params.id); return { ok: true }; },
});
