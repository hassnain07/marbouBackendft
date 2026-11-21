import { Router } from 'express';
import { z } from 'zod';
import { defineRoute } from '../../shared/route';
import * as svc from './service';

export const usersRouter = Router();

// GET /me
defineRoute({
  router: usersRouter, method: 'get', path: '/me',
  summary: 'Get current user profile', tag: 'Users', auth: 'user',
  handler: async ({ user }) => svc.getMe(user!.id),
});

// PATCH /me
defineRoute({
  router: usersRouter, method: 'patch', path: '/me',
  summary: 'Update current user profile', tag: 'Users', auth: 'user',
  body: z.object({
    fullName: z.string().min(1).max(100).optional(),
    bio: z.string().max(500).optional(),
    city: z.string().max(100).optional(),
    languages: z.array(z.string()).optional(),
    contactPrefs: z.object({
      call: z.boolean().optional(),
      whatsapp: z.boolean().optional(),
      chatOnly: z.boolean().optional(),
    }).optional(),
    language: z.enum(['ar', 'en']).optional(),
  }),
  handler: async ({ body, user }) => svc.updateMe(user!.id, body),
});

// GET /me/capabilities
defineRoute({
  router: usersRouter, method: 'get', path: '/me/capabilities',
  summary: 'Get user capabilities', tag: 'Users', auth: 'user',
  handler: async ({ user }) => svc.getCapabilities(user!.id),
});

// POST /me/capabilities
defineRoute({
  router: usersRouter, method: 'post', path: '/me/capabilities',
  summary: 'Grant a capability', tag: 'Users', auth: 'user',
  body: z.object({
    capability: z.enum(['SELLER', 'DEALER', 'EMPLOYER', 'SERVICE_PROVIDER', 'CANDIDATE']),
    setup: z.record(z.unknown()).optional(),
  }),
  handler: async ({ body, user }) => svc.grantCapability(user!.id, body.capability, body.setup),
});

// GET /users/:id
defineRoute({
  router: usersRouter, method: 'get', path: '/users/:id',
  summary: 'Get public user profile', tag: 'Users', auth: 'public',
  params: z.object({ id: z.string() }),
  handler: async ({ params }) => svc.getPublicProfile(params.id),
});

// POST /users/:id/block
defineRoute({
  router: usersRouter, method: 'post', path: '/users/:id/block',
  summary: 'Block a user', tag: 'Users', auth: 'user',
  params: z.object({ id: z.string() }),
  handler: async ({ params, user }) => {
    await svc.blockUser(user!.id, params.id);
    return { ok: true };
  },
});

// DELETE /users/:id/block
defineRoute({
  router: usersRouter, method: 'delete', path: '/users/:id/block',
  summary: 'Unblock a user', tag: 'Users', auth: 'user',
  params: z.object({ id: z.string() }),
  handler: async ({ params, user }) => {
    await svc.unblockUser(user!.id, params.id);
    return { ok: true };
  },
});

// GET /me/blocks
defineRoute({
  router: usersRouter, method: 'get', path: '/me/blocks',
  summary: 'Get blocked users', tag: 'Users', auth: 'user',
  handler: async ({ user }) => svc.getBlocks(user!.id),
});

// GET /me/notification-preferences
defineRoute({
  router: usersRouter, method: 'get', path: '/me/notification-preferences',
  summary: 'Get notification preferences', tag: 'Users', auth: 'user',
  handler: async ({ user }) => svc.getNotifPrefs(user!.id),
});

// PATCH /me/notification-preferences
defineRoute({
  router: usersRouter, method: 'patch', path: '/me/notification-preferences',
  summary: 'Update notification preferences', tag: 'Users', auth: 'user',
  body: z.record(z.unknown()),
  handler: async ({ body, user }) => svc.updateNotifPrefs(user!.id, body),
});

// POST /me/device-tokens
defineRoute({
  router: usersRouter, method: 'post', path: '/me/device-tokens',
  summary: 'Register device token', tag: 'Users', auth: 'user',
  body: z.object({ token: z.string().min(1), platform: z.enum(['ios', 'android', 'web']) }),
  handler: async ({ body, user }) => {
    await svc.addDeviceToken(user!.id, body.token, body.platform);
    return { ok: true };
  },
});

// DELETE /me/device-tokens/:token
defineRoute({
  router: usersRouter, method: 'delete', path: '/me/device-tokens/:token',
  summary: 'Remove device token', tag: 'Users', auth: 'user',
  params: z.object({ token: z.string() }),
  handler: async ({ params, user }) => {
    await svc.removeDeviceToken(user!.id, params.token);
    return { ok: true };
  },
});

// POST /me/verification
defineRoute({
  router: usersRouter, method: 'post', path: '/me/verification',
  summary: 'Submit verification request', tag: 'Users', auth: 'verified',
  body: z.object({
    kind: z.enum(['USER', 'DEALER', 'BUSINESS', 'EMPLOYER', 'SERVICE_PROVIDER']),
    documentMediaIds: z.array(z.string()).min(1),
  }),
  handler: async ({ body, user }) => svc.submitVerification(user!.id, body.kind, body.documentMediaIds),
});

// GET /me/verification
defineRoute({
  router: usersRouter, method: 'get', path: '/me/verification',
  summary: 'Get verification request status', tag: 'Users', auth: 'user',
  handler: async ({ user }) => svc.getVerification(user!.id),
});
