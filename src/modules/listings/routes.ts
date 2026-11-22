import { Router } from 'express';
import { z } from 'zod';
import { defineRoute } from '../../shared/route';
import * as create from './create';
import * as read from './read';
import * as write from './write';

export const listingsRouter = Router();

const listingTypeEnum = z.enum(['SALE', 'RENT', 'WANTED', 'SERVICE', 'JOB']);

const createBody = z.object({
  categoryId: z.string().uuid(),
  listingType: listingTypeEnum,
  title: z.string().min(3).max(200),
  description: z.string().min(10).max(5000),
  price: z.number().positive().max(1e12).optional(),
  budgetMin: z.number().positive().optional(),
  budgetMax: z.number().positive().optional(),
  currency: z.enum(['SDG', 'USD']).default('SDG'),
  isNegotiable: z.boolean().optional(),
  condition: z.string().optional(),
  isCustomOther: z.boolean().optional(),
  customOtherText: z.string().max(80).optional(),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
  locationName: z.string().max(200).optional(),
  isApproxLocation: z.boolean().optional(),
  approxRadiusM: z.number().int().min(100).max(2000).optional(),
  contactOptions: z.object({ call: z.boolean(), whatsapp: z.boolean(), chat: z.boolean() }).optional(),
  dynamicAttributes: z.record(z.unknown()).optional(),
  mediaIds: z.array(z.string().uuid()).max(20).optional(),
  coverMediaId: z.string().uuid().optional(),
  videoMediaId: z.string().uuid().optional(),
  cityId: z.string().optional(),
  neighborhoodId: z.string().optional(),
  publish: z.boolean().optional(),
  status: z.string().optional(), // 'PUBLISH' | 'DRAFT' convenience alias
});

const patchBody = z.object({
  title: z.string().min(3).max(200).optional(),
  description: z.string().min(10).max(5000).optional(),
  price: z.number().positive().max(1e12).optional(),
  currency: z.enum(['SDG', 'USD']).optional(),
  isNegotiable: z.boolean().optional(),
  condition: z.string().optional(),
  isCustomOther: z.boolean().optional(),
  customOtherText: z.string().max(80).optional(),
  locationName: z.string().max(200).optional(),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
  isApproxLocation: z.boolean().optional(),
  approxRadiusM: z.number().int().min(100).max(2000).optional(),
  cityId: z.string().uuid().optional(),
  neighborhoodId: z.string().uuid().optional(),
  contactOptions: z.object({ call: z.boolean(), whatsapp: z.boolean(), chat: z.boolean() }).optional(),
  dynamicAttributes: z.record(z.unknown()).optional(),
}).strict();

// POST /listings
defineRoute({
  router: listingsRouter, method: 'post', path: '/listings',
  summary: 'Create a listing', tag: 'Listings', auth: 'verified',
  body: createBody,
  handler: async ({ body, user }) => create.createListing(user!.id, body),
});

// GET /listings/:id
defineRoute({
  router: listingsRouter, method: 'get', path: '/listings/:id',
  summary: 'Get listing by id or readableId', tag: 'Listings', auth: 'optional',
  params: z.object({ id: z.string() }),
  handler: async ({ params, user, req }) => {
    const ip = req.ip ?? '';
    const deviceId = req.headers['x-device-id'] as string | undefined;
    return read.getListing(params.id, user?.id, ip, deviceId);
  },
});

// PATCH /listings/:id
defineRoute({
  router: listingsRouter, method: 'patch', path: '/listings/:id',
  summary: 'Update a listing', tag: 'Listings', auth: 'verified',
  params: z.object({ id: z.string().uuid() }),
  body: patchBody,
  handler: async ({ params, body, user }) => write.patchListing(user!.id, params.id, body),
});

// POST /listings/:id/publish
defineRoute({
  router: listingsRouter, method: 'post', path: '/listings/:id/publish',
  summary: 'Publish a draft listing', tag: 'Listings', auth: 'verified',
  params: z.object({ id: z.string().uuid() }),
  handler: async ({ params, user }) => write.publishListing(user!.id, params.id),
});

// POST /listings/:id/renew
defineRoute({
  router: listingsRouter, method: 'post', path: '/listings/:id/renew',
  summary: 'Renew a listing', tag: 'Listings', auth: 'verified',
  params: z.object({ id: z.string().uuid() }),
  handler: async ({ params, user }) => write.renewListing(user!.id, params.id),
});

// POST /listings/:id/sold
defineRoute({
  router: listingsRouter, method: 'post', path: '/listings/:id/sold',
  summary: 'Mark listing as sold', tag: 'Listings', auth: 'verified',
  params: z.object({ id: z.string().uuid() }),
  handler: async ({ params, user }) => write.markSold(user!.id, params.id),
});

// POST /listings/:id/duplicate
defineRoute({
  router: listingsRouter, method: 'post', path: '/listings/:id/duplicate',
  summary: 'Duplicate a listing as draft', tag: 'Listings', auth: 'verified',
  params: z.object({ id: z.string().uuid() }),
  handler: async ({ params, user }) => write.duplicateListing(user!.id, params.id),
});

// POST /listings/:id/archive
defineRoute({
  router: listingsRouter, method: 'post', path: '/listings/:id/archive',
  summary: 'Archive a listing', tag: 'Listings', auth: 'verified',
  params: z.object({ id: z.string().uuid() }),
  handler: async ({ params, user }) => write.archiveListing(user!.id, params.id),
});

// DELETE /listings/:id
defineRoute({
  router: listingsRouter, method: 'delete', path: '/listings/:id',
  summary: 'Soft-delete a listing', tag: 'Listings', auth: 'verified',
  params: z.object({ id: z.string().uuid() }),
  handler: async ({ params, user }) => write.deleteListing(user!.id, params.id),
});

// POST /listings/bulk
defineRoute({
  router: listingsRouter, method: 'post', path: '/listings/bulk',
  summary: 'Bulk action on listings', tag: 'Listings', auth: 'verified',
  body: z.object({
    action: z.enum(['RENEW', 'HIDE', 'SOLD', 'DELETE']),
    ids: z.array(z.string().uuid()).min(1).max(50),
  }),
  handler: async ({ body, user }) => write.bulkAction(user!.id, body.action, body.ids),
});

const listingStatusEnum = z.enum(['DRAFT', 'PENDING_REVIEW', 'ACTIVE', 'HIDDEN', 'AUTO_HIDDEN', 'SUSPENDED', 'SOLD', 'EXPIRED', 'ARCHIVED']);

// GET /me/listings
defineRoute({
  router: listingsRouter, method: 'get', path: '/me/listings',
  summary: 'Get my listings', tag: 'Listings', auth: 'user',
  query: z.object({ status: listingStatusEnum.optional(), cursor: z.string().optional(), limit: z.coerce.number().int().min(1).max(50).default(20) }),
  handler: async ({ query, user }) => read.getMyListings(user!.id, query.status, query.cursor, query.limit),
});

// GET /me/drafts
defineRoute({
  router: listingsRouter, method: 'get', path: '/me/drafts',
  summary: 'Get my draft listings', tag: 'Listings', auth: 'user',
  query: z.object({ cursor: z.string().optional(), limit: z.coerce.number().int().min(1).max(50).default(20) }),
  handler: async ({ query, user }) => read.getMyListings(user!.id, 'DRAFT', query.cursor, query.limit),
});

// POST /listings/quality-preview
defineRoute({
  router: listingsRouter, method: 'post', path: '/listings/quality-preview',
  summary: 'Preview quality score without saving', tag: 'Listings', auth: 'user',
  body: z.object({
    categoryId: z.string().uuid(),
    title: z.string(),
    description: z.string(),
    mediaCount: z.number().int().min(0).default(0),
    hasVideo: z.boolean().default(false),
    price: z.number().optional(),
    lat: z.number().optional(),
    dynamicAttributes: z.record(z.unknown()).optional(),
  }),
  handler: async ({ body, user }) => write.qualityPreview(user!.id, body),
});

// POST /listings/:id/contact-reveal
defineRoute({
  router: listingsRouter, method: 'post', path: '/listings/:id/contact-reveal',
  summary: 'Reveal contact info', tag: 'Listings', auth: 'optional',
  limit: 'strict',
  params: z.object({ id: z.string().uuid() }),
  body: z.object({ channel: z.enum(['CALL', 'WHATSAPP']) }),
  handler: async ({ params, body, user, lang, req }) => {
    const ip = req.ip ?? '';
    const deviceId = req.headers['x-device-id'] as string | undefined;
    return write.contactReveal(params.id, body.channel, user?.id, deviceId, ip, lang);
  },
});

// POST /listings/:id/lead
defineRoute({
  router: listingsRouter, method: 'post', path: '/listings/:id/lead',
  summary: 'Record a lead event', tag: 'Listings', auth: 'optional',
  params: z.object({ id: z.string().uuid() }),
  body: z.object({ type: z.enum(['CHAT', 'WHATSAPP', 'CALL']) }),
  handler: async ({ params, body, user }) => write.recordLead(params.id, body.type, user?.id),
});
