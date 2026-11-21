import { Router } from 'express';
import { z } from 'zod';
import { defineRoute } from '../../shared/route';
import * as svc from './service';

export const catalogRouter = Router();

// GET /health
defineRoute({
  router: catalogRouter, method: 'get', path: '/health',
  summary: 'Health check', tag: 'Platform', auth: 'public',
  handler: async () => svc.getHealth(),
});

// GET /health/ready
defineRoute({
  router: catalogRouter, method: 'get', path: '/health/ready',
  summary: 'Readiness check', tag: 'Platform', auth: 'public',
  handler: async () => svc.getHealthReady(),
});

// GET /config
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

// GET /translations
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

// GET /exchange-rate
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
