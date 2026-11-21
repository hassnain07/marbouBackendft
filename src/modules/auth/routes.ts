import { Router } from 'express';
import { z } from 'zod';
import { defineRoute } from '../../shared/route';
import * as svc from './service';

export const authRouter = Router();

const deviceSchema = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  os: z.string().optional(),
});

// POST /auth/register
defineRoute({
  router: authRouter, method: 'post', path: '/auth/register',
  summary: 'Register a new user', tag: 'Auth', auth: 'public', limit: 'strict',
  body: z.object({
    email: z.string().email().transform((v) => v.trim().toLowerCase()),
    password: z.string().min(1),
    fullName: z.string().min(1).max(100),
    phone: z.string().optional(),
    language: z.enum(['ar', 'en']).optional(),
  }),
  handler: async ({ body, lang }) => svc.register({ ...body, language: body.language ?? lang }),
});

// GET /auth/otp/channels
defineRoute({
  router: authRouter, method: 'get', path: '/auth/otp/channels',
  summary: 'Get enabled OTP channels', tag: 'Auth', auth: 'public',
  handler: async () => svc.getOtpChannels(),
});

// POST /auth/otp/request  — public: REGISTER and RESET only
defineRoute({
  router: authRouter, method: 'post', path: '/auth/otp/request',
  summary: 'Request an OTP code', tag: 'Auth', auth: 'public', limit: 'strict',
  body: z.object({
    email: z.string().email().transform((v) => v.trim().toLowerCase()).optional(),
    phone: z.string().optional(),
    // B3: public route only accepts REGISTER and RESET
    purpose: z.enum(['REGISTER', 'RESET']),
    channel: z.enum(['EMAIL', 'SMS', 'WHATSAPP']).optional(),
  })
    .refine((d) => d.email || d.phone, { message: 'email or phone required' })
    .refine((d) => {
      const ch = d.channel ?? 'EMAIL';
      if (ch === 'EMAIL') return !!d.email;
      return !!d.phone;
    }, { message: 'EMAIL channel requires email; SMS/WHATSAPP require phone' }),
  handler: async ({ body, lang }) => svc.requestOtpPublic({ ...body, lang }),
});

// POST /auth/otp/verify  — public: REGISTER and RESET only
defineRoute({
  router: authRouter, method: 'post', path: '/auth/otp/verify',
  summary: 'Verify an OTP code', tag: 'Auth', auth: 'public', limit: 'strict',
  body: z.object({
    email: z.string().email().transform((v) => v.trim().toLowerCase()).optional(),
    phone: z.string().optional(),
    code: z.string().length(6),
    // B3: public route only accepts REGISTER and RESET
    purpose: z.enum(['REGISTER', 'RESET']),
    device: deviceSchema.optional(),
  }).refine((d) => d.email || d.phone, { message: 'email or phone required' }),
  handler: async ({ body, lang, req }) =>
    svc.verifyOtp({ ...body, device: body.device, ip: req.ip ?? '', lang }),
});

// POST /auth/login
defineRoute({
  router: authRouter, method: 'post', path: '/auth/login',
  summary: 'Login with email and password', tag: 'Auth', auth: 'public', limit: 'strict',
  body: z.object({
    email: z.string().email().transform((v) => v.trim().toLowerCase()),
    password: z.string().min(1),
    device: deviceSchema.optional().default({}),
  }),
  handler: async ({ body, lang, req }) =>
    svc.login({ email: body.email, password: body.password, device: body.device, ip: req.ip ?? '', lang }),
});

// POST /auth/social/:provider
defineRoute({
  router: authRouter, method: 'post', path: '/auth/social/:provider',
  summary: 'Social login (Google/Facebook/Apple)', tag: 'Auth', auth: 'public', limit: 'strict',
  params: z.object({ provider: z.enum(['google', 'facebook', 'apple']) }),
  body: z.object({
    idToken: z.string().optional(),
    accessToken: z.string().optional(),
    device: deviceSchema.optional().default({}),
  }),
  handler: async ({ body, params, lang, req }) => {
    const token = body.idToken ?? body.accessToken ?? '';
    return svc.socialLogin({ provider: params.provider, token, device: body.device, ip: req.ip, lang });
  },
});

// POST /auth/refresh
defineRoute({
  router: authRouter, method: 'post', path: '/auth/refresh',
  summary: 'Rotate refresh token', tag: 'Auth', auth: 'public', limit: 'strict',
  body: z.object({ refreshToken: z.string().min(1) }),
  handler: async ({ body, req }) => svc.refreshTokens(body.refreshToken, req.ip),
});

// POST /auth/logout
defineRoute({
  router: authRouter, method: 'post', path: '/auth/logout',
  summary: 'Logout current session', tag: 'Auth', auth: 'user',
  handler: async ({ req }) => {
    const sid = (req as typeof req & { sessionId: string }).sessionId;
    await svc.logout(sid);
    return { ok: true };
  },
});

// POST /auth/password/forgot
defineRoute({
  router: authRouter, method: 'post', path: '/auth/password/forgot',
  summary: 'Request password reset OTP', tag: 'Auth', auth: 'public', limit: 'strict',
  body: z.object({ email: z.string().email().transform((v) => v.trim().toLowerCase()) }),
  handler: async ({ body, lang }) => { await svc.forgotPassword(body.email, lang); return { ok: true }; },
});

// POST /auth/password/reset
defineRoute({
  router: authRouter, method: 'post', path: '/auth/password/reset',
  summary: 'Reset password with OTP', tag: 'Auth', auth: 'public', limit: 'strict',
  body: z.object({
    email: z.string().email().transform((v) => v.trim().toLowerCase()),
    code: z.string().length(6),
    newPassword: z.string().min(1),
  }),
  handler: async ({ body, lang }) => { await svc.resetPassword({ ...body, lang }); return { ok: true }; },
});

// POST /auth/phone/request
defineRoute({
  router: authRouter, method: 'post', path: '/auth/phone/request',
  summary: 'Request phone OTP', tag: 'Auth', auth: 'user', limit: 'strict',
  body: z.object({ phone: z.string().min(1) }),
  handler: async ({ body, user, lang }) => svc.requestPhoneOtp(user!.id, body.phone, lang),
});

// POST /auth/phone/verify
defineRoute({
  router: authRouter, method: 'post', path: '/auth/phone/verify',
  summary: 'Verify phone OTP', tag: 'Auth', auth: 'user', limit: 'strict',
  body: z.object({ phone: z.string().min(1), code: z.string().length(6) }),
  handler: async ({ body, user, lang }) => {
    await svc.verifyPhone(user!.id, body.phone, body.code, lang);
    return { ok: true };
  },
});

// GET /me/sessions
defineRoute({
  router: authRouter, method: 'get', path: '/me/sessions',
  summary: 'List active sessions', tag: 'Auth', auth: 'user',
  handler: async ({ user, req }) => {
    const sid = (req as typeof req & { sessionId?: string }).sessionId;
    return svc.listSessions(user!.id, sid);
  },
});

// DELETE /me/sessions/:id
defineRoute({
  router: authRouter, method: 'delete', path: '/me/sessions/:id',
  summary: 'Revoke a session', tag: 'Auth', auth: 'user',
  params: z.object({ id: z.string() }),
  handler: async ({ params, user }) => { await svc.revokeSession(user!.id, params.id); return { ok: true }; },
});

// DELETE /me/sessions (revoke others)
defineRoute({
  router: authRouter, method: 'delete', path: '/me/sessions',
  summary: 'Revoke all other sessions', tag: 'Auth', auth: 'user',
  handler: async ({ user, req }) => {
    const sid = (req as typeof req & { sessionId: string }).sessionId;
    await svc.revokeOtherSessions(user!.id, sid);
    return { ok: true };
  },
});

// GET /me/login-events
defineRoute({
  router: authRouter, method: 'get', path: '/me/login-events',
  summary: 'Get last 20 login events', tag: 'Auth', auth: 'user',
  handler: async ({ user }) => svc.listLoginEvents(user!.id),
});

// POST /me/password/change
defineRoute({
  router: authRouter, method: 'post', path: '/me/password/change',
  summary: 'Change password', tag: 'Auth', auth: 'user',
  body: z.object({ currentPassword: z.string().min(1), newPassword: z.string().min(1) }),
  handler: async ({ body, user, req }) => {
    const sid = (req as typeof req & { sessionId?: string }).sessionId;
    await svc.changePassword(user!.id, body.currentPassword, body.newPassword, sid);
    return { ok: true };
  },
});

// POST /me/email/change
defineRoute({
  router: authRouter, method: 'post', path: '/me/email/change',
  summary: 'Request email change OTP', tag: 'Auth', auth: 'user', limit: 'strict',
  body: z.object({ newEmail: z.string().email().transform((v) => v.trim().toLowerCase()) }),
  handler: async ({ body, user, lang }) => svc.requestEmailChange(user!.id, body.newEmail, lang),
});

// POST /me/email/confirm
defineRoute({
  router: authRouter, method: 'post', path: '/me/email/confirm',
  summary: 'Confirm email change', tag: 'Auth', auth: 'user', limit: 'strict',
  body: z.object({
    newEmail: z.string().email().transform((v) => v.trim().toLowerCase()),
    code: z.string().length(6),
  }),
  handler: async ({ body, user, lang }) => {
    await svc.confirmEmailChange(user!.id, body.newEmail, body.code, lang);
    return { ok: true };
  },
});

// PATCH /me/phone
defineRoute({
  router: authRouter, method: 'patch', path: '/me/phone',
  summary: 'Update phone number', tag: 'Auth', auth: 'user',
  body: z.object({ phone: z.string().min(1) }),
  handler: async ({ body, user }) => {
    await svc.updatePhone(user!.id, body.phone);
    return { ok: true };
  },
});
