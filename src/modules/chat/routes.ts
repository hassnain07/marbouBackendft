import { Router } from 'express';
import { z } from 'zod';
import { defineRoute } from '../../shared/route';
import * as svc from './service';

export const chatRouter = Router();

// ─── Threads ──────────────────────────────────────────────────────────────────

defineRoute({
  router: chatRouter, method: 'post', path: '/threads',
  summary: 'Get or create thread', tag: 'Chat', auth: 'verified',
  body: z.object({
    listingId: z.string().uuid(),
    message: z.string().max(2000).optional(),
  }),
  handler: async ({ body, user, res }) => {
    const { thread, created } = await svc.getOrCreateThread(user!.id, body.listingId, body.message);
    res.status(created ? 201 : 200);
    return { thread };
  },
});

defineRoute({
  router: chatRouter, method: 'get', path: '/threads',
  summary: 'List threads (inbox)', tag: 'Chat', auth: 'user',
  query: z.object({
    role: z.enum(['buyer', 'seller']).optional(),
    cursor: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  }),
  handler: async ({ query, user }) =>
    svc.getThreads(user!.id, query.role, query.cursor, query.limit),
});

defineRoute({
  router: chatRouter, method: 'get', path: '/threads/unread-count',
  summary: 'Unread message count', tag: 'Chat', auth: 'user',
  handler: async ({ user }) => svc.getUnreadCount(user!.id),
});

defineRoute({
  router: chatRouter, method: 'get', path: '/threads/:id',
  summary: 'Get thread', tag: 'Chat', auth: 'user',
  params: z.object({ id: z.string().uuid() }),
  handler: async ({ params, user }) => svc.getThread(params.id, user!.id),
});

defineRoute({
  router: chatRouter, method: 'get', path: '/threads/:id/messages',
  summary: 'Get messages', tag: 'Chat', auth: 'user',
  params: z.object({ id: z.string().uuid() }),
  query: z.object({
    after: z.string().optional(),
    before: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(50).default(30),
  }),
  handler: async ({ params, query, user }) =>
    svc.getMessages(params.id, user!.id, query),
});

defineRoute({
  router: chatRouter, method: 'post', path: '/threads/:id/read',
  summary: 'Mark thread as read', tag: 'Chat', auth: 'user',
  params: z.object({ id: z.string().uuid() }),
  handler: async ({ params, user }) => svc.markRead(params.id, user!.id),
});

defineRoute({
  router: chatRouter, method: 'patch', path: '/threads/:id/mute',
  summary: 'Mute/unmute thread', tag: 'Chat', auth: 'user',
  params: z.object({ id: z.string().uuid() }),
  body: z.object({ muted: z.boolean() }),
  handler: async ({ params, body, user }) => svc.muteThread(params.id, user!.id, body.muted),
});

// ─── Messages ─────────────────────────────────────────────────────────────────

defineRoute({
  router: chatRouter, method: 'post', path: '/threads/:id/messages',
  summary: 'Send message', tag: 'Chat', auth: 'verified',
  params: z.object({ id: z.string().uuid() }),
  body: z.object({
    type: z.enum(['TEXT', 'IMAGE']).default('TEXT'),
    body: z.string().max(2000).optional(),
    attachmentMediaId: z.string().uuid().optional(),
    idempotencyKey: z.string().optional(),
  }),
  handler: async ({ params, body, user, req }) => {
    const idempotencyKey = body.idempotencyKey ?? (req.headers['idempotency-key'] as string | undefined);
    return svc.sendMessage(user!.id, params.id, { ...body, idempotencyKey });
  },
});

// ─── Offers ───────────────────────────────────────────────────────────────────

defineRoute({
  router: chatRouter, method: 'post', path: '/threads/:id/offers',
  summary: 'Make offer', tag: 'Chat', auth: 'verified',
  params: z.object({ id: z.string().uuid() }),
  body: z.object({
    amount: z.number().positive(),
    currency: z.enum(['SDG', 'USD']),
  }),
  handler: async ({ params, body, user }) =>
    svc.makeOffer(user!.id, params.id, body.amount, body.currency),
});

defineRoute({
  router: chatRouter, method: 'post', path: '/offers/:id/accept',
  summary: 'Accept offer', tag: 'Chat', auth: 'verified',
  params: z.object({ id: z.string().uuid() }),
  handler: async ({ params, user }) => svc.respondOffer(user!.id, params.id, 'accept'),
});

defineRoute({
  router: chatRouter, method: 'post', path: '/offers/:id/reject',
  summary: 'Reject offer', tag: 'Chat', auth: 'verified',
  params: z.object({ id: z.string().uuid() }),
  handler: async ({ params, user }) => svc.respondOffer(user!.id, params.id, 'reject'),
});

defineRoute({
  router: chatRouter, method: 'post', path: '/offers/:id/counter',
  summary: 'Counter offer', tag: 'Chat', auth: 'verified',
  params: z.object({ id: z.string().uuid() }),
  body: z.object({ amount: z.number().positive() }),
  handler: async ({ params, body, user }) =>
    svc.respondOffer(user!.id, params.id, 'counter', body.amount),
});

// ─── Quick replies ────────────────────────────────────────────────────────────

defineRoute({
  router: chatRouter, method: 'get', path: '/me/quick-replies',
  summary: 'List quick replies', tag: 'Chat', auth: 'user',
  handler: async ({ user }) => svc.getQuickReplies(user!.id),
});

defineRoute({
  router: chatRouter, method: 'post', path: '/me/quick-replies',
  summary: 'Create quick reply', tag: 'Chat', auth: 'user',
  body: z.object({
    title: z.string().min(1).max(40),
    body: z.string().min(1).max(500),
  }),
  handler: async ({ body, user }) => svc.createQuickReply(user!.id, body.title, body.body),
});

defineRoute({
  router: chatRouter, method: 'patch', path: '/me/quick-replies/:id',
  summary: 'Update quick reply', tag: 'Chat', auth: 'user',
  params: z.object({ id: z.string() }),
  body: z.object({
    title: z.string().min(1).max(40).optional(),
    body: z.string().min(1).max(500).optional(),
  }),
  handler: async ({ params, body, user }) =>
    svc.updateQuickReply(user!.id, params.id, body.title, body.body),
});

defineRoute({
  router: chatRouter, method: 'delete', path: '/me/quick-replies/:id',
  summary: 'Delete quick reply', tag: 'Chat', auth: 'user',
  params: z.object({ id: z.string() }),
  handler: async ({ params, user }) => svc.deleteQuickReply(user!.id, params.id),
});
