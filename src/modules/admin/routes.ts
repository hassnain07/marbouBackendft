import { Router } from 'express';
import { z } from 'zod';
import { defineRoute } from '../../shared/route';
import { audit } from '../../shared/audit';
import * as svc from './service';

export const adminRouter = Router();

// ─── Auth ─────────────────────────────────────────────────────────────────────

defineRoute({
  router: adminRouter, method: 'post', path: '/admin/auth/login',
  summary: 'Admin login step 1', tag: 'Admin Auth', auth: 'public', limit: 'strict',
  body: z.object({ email: z.string().email(), password: z.string().min(1) }),
  handler: async ({ body, req }) => svc.adminLogin({ ...body, ip: req.ip ?? '' }),
});

defineRoute({
  router: adminRouter, method: 'post', path: '/admin/auth/verify-2fa',
  summary: 'Admin 2FA verification', tag: 'Admin Auth', auth: 'public', limit: 'strict',
  body: z.object({ mfaToken: z.string().min(1), code: z.string().min(6).max(6) }),
  handler: async ({ body, req }) => svc.adminVerify2fa({ ...body, ip: req.ip ?? '' }),
});

defineRoute({
  router: adminRouter, method: 'post', path: '/admin/auth/refresh',
  summary: 'Admin refresh token', tag: 'Admin Auth', auth: 'public',
  body: z.object({ refreshToken: z.string().min(1) }),
  handler: async ({ body }) => svc.adminRefresh(body.refreshToken),
});

defineRoute({
  router: adminRouter, method: 'post', path: '/admin/auth/logout',
  summary: 'Admin logout', tag: 'Admin Auth', auth: 'admin',
  handler: async ({ admin }) => { await svc.adminLogout(admin!.id); return { ok: true }; },
});

defineRoute({
  router: adminRouter, method: 'post', path: '/admin/auth/change-password',
  summary: 'Admin change password', tag: 'Admin Auth', auth: 'admin',
  body: z.object({ currentPassword: z.string().min(1), newPassword: z.string().min(1) }),
  handler: async ({ body, admin }) => {
    return svc.adminChangePassword(admin!.id, body.currentPassword, body.newPassword);
  },
});

// ─── Me ───────────────────────────────────────────────────────────────────────

defineRoute({
  router: adminRouter, method: 'get', path: '/admin/me',
  summary: 'Get current admin profile', tag: 'Admin', auth: 'admin',
  handler: async ({ admin }) => svc.getAdminMe(admin!.id),
});

// ─── Admin management (Super Admin only) ─────────────────────────────────────

defineRoute({
  router: adminRouter, method: 'get', path: '/admin/admins',
  summary: 'List all admins', tag: 'Admin', auth: 'admin', perm: '*',
  handler: async () => svc.listAdmins(),
});

defineRoute({
  router: adminRouter, method: 'post', path: '/admin/admins',
  summary: 'Create admin', tag: 'Admin', auth: 'admin', perm: '*',
  body: z.object({
    email: z.string().email(),
    fullName: z.string().min(1),
    role: z.enum(['SUPER_ADMIN', 'CONTENT_MODERATOR', 'SUPPORT_AGENT', 'FINANCIAL_AUDITOR']),
  }),
  handler: async ({ body, admin }) => svc.createAdmin(admin!.id, body),
});

defineRoute({
  router: adminRouter, method: 'patch', path: '/admin/admins/:id',
  summary: 'Update admin', tag: 'Admin', auth: 'admin', perm: '*',
  params: z.object({ id: z.string() }),
  body: z.object({
    role: z.enum(['SUPER_ADMIN', 'CONTENT_MODERATOR', 'SUPPORT_AGENT', 'FINANCIAL_AUDITOR']).optional(),
    isActive: z.boolean().optional(),
  }),
  handler: async ({ params, body, admin }) => svc.updateAdmin(admin!.id, params.id, body),
});

defineRoute({
  router: adminRouter, method: 'post', path: '/admin/admins/:id/reset-2fa',
  summary: 'Reset admin 2FA', tag: 'Admin', auth: 'admin', perm: '*',
  params: z.object({ id: z.string() }),
  handler: async ({ params, admin }) => {
    await svc.resetAdmin2fa(admin!.id, params.id);
    return { ok: true };
  },
});

defineRoute({
  router: adminRouter, method: 'post', path: '/admin/admins/:id/revoke-sessions',
  summary: 'Revoke admin sessions', tag: 'Admin', auth: 'admin', perm: '*',
  params: z.object({ id: z.string() }),
  handler: async ({ params, admin }) => {
    await svc.revokeAdminSessions(admin!.id, params.id);
    return { ok: true };
  },
});

// ─── Settings ─────────────────────────────────────────────────────────────────

defineRoute({
  router: adminRouter, method: 'get', path: '/admin/settings',
  summary: 'Get all settings', tag: 'Admin', auth: 'admin', perm: '*',
  handler: async () => svc.getAllSettings(),
});

defineRoute({
  router: adminRouter, method: 'patch', path: '/admin/settings/:key',
  summary: 'Update a setting', tag: 'Admin', auth: 'admin', perm: '*',
  params: z.object({ key: z.string() }),
  body: z.object({ value: z.unknown() }),
  handler: async ({ params, body, admin }) => svc.updateSetting(admin!.id, params.key, body.value),
});

defineRoute({
  router: adminRouter, method: 'patch', path: '/admin/flags/:key',
  summary: 'Toggle a feature flag', tag: 'Admin', auth: 'admin', perm: '*',
  params: z.object({ key: z.string() }),
  body: z.object({ value: z.boolean() }),
  handler: async ({ params, body, admin }) => svc.updateFlag(admin!.id, params.key, body.value),
});

// ─── Audit logs ───────────────────────────────────────────────────────────────

defineRoute({
  router: adminRouter, method: 'get', path: '/admin/audit-logs',
  summary: 'Get audit logs', tag: 'Admin', auth: 'admin', perm: 'auditlog.read',
  query: z.object({
    actor: z.string().optional(),
    entity: z.string().optional(),
    from: z.string().optional(),
    to: z.string().optional(),
    limit: z.coerce.number().optional(),
    cursor: z.coerce.number().optional(),
  }),
  handler: async ({ query }) => svc.getAuditLogs(query),
});

defineRoute({
  router: adminRouter, method: 'get', path: '/admin/audit-logs/verify',
  summary: 'Verify audit log chain integrity', tag: 'Admin', auth: 'admin', perm: 'auditlog.read',
  handler: async () => audit.verify(),
});
