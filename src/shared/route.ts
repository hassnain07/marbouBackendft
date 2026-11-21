import { Router, type Request, type Response, type RequestHandler } from 'express';
import { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z, type ZodTypeAny } from 'zod';
import { E } from './errors';
import {
  requireAuth,
  optionalAuth,
  requireVerifiedEmail,
  requireAdmin,
  requirePerm,
  requireCapability,
  type AuthUser,
  type AdminCtx,
} from './auth';
import { settings } from './settings';
import { limiters } from './rateLimit';
import type { Capability } from '@prisma/client';

export const registry = new OpenAPIRegistry();

type AuthLevel = 'public' | 'optional' | 'user' | 'verified' | 'admin';

interface RouteOptions<
  B extends ZodTypeAny,
  Q extends ZodTypeAny,
  P extends ZodTypeAny,
> {
  router: Router;
  method: 'get' | 'post' | 'put' | 'patch' | 'delete';
  path: string;
  summary: string;
  tag: string;
  auth?: AuthLevel;
  cap?: Capability;
  perm?: string;
  flag?: string;
  limit?: keyof typeof limiters;
  body?: B;
  query?: Q;
  params?: P;
  responses?: Record<number, string>;
  handler: (c: {
    body: z.infer<B>;
    query: z.infer<Q>;
    params: z.infer<P>;
    user?: AuthUser;
    admin?: AdminCtx;
    lang: 'ar' | 'en';
    req: Request;
    res: Response;
  }) => Promise<unknown>;
}

export function defineRoute<
  B extends ZodTypeAny = ZodTypeAny,
  Q extends ZodTypeAny = ZodTypeAny,
  P extends ZodTypeAny = ZodTypeAny,
>(o: RouteOptions<B, Q, P>): void {
  const mw: RequestHandler[] = [];

  if (o.limit) mw.push(limiters[o.limit]);

  if (o.flag) {
    mw.push(async (_req, _res, next) => {
      try { await settings.get<boolean>(o.flag!, false) ? next() : next(E.notFound()); }
      catch (e) { next(e); }
    });
  }

  if (o.auth === 'optional') mw.push(optionalAuth);
  if (o.auth === 'user' || o.auth === 'verified') mw.push(requireAuth);
  if (o.auth === 'verified') mw.push(requireVerifiedEmail);
  if (o.auth === 'admin') {
    mw.push(requireAdmin);
    if (o.perm) mw.push(requirePerm(o.perm));
  }
  if (o.cap) mw.push(requireCapability(o.cap));

  o.router[o.method](o.path, ...mw, async (req: Request, res: Response, next) => {
    try {
      const body = o.body ? o.body.parse(req.body) : undefined;
      const query = o.query ? o.query.parse(req.query) : undefined;
      const params = o.params ? o.params.parse(req.params) : undefined;
      const lang = ((req as Request & { lang?: string }).lang ?? 'ar') as 'ar' | 'en';
      const out = await o.handler({
        body: body as z.infer<B>,
        query: query as z.infer<Q>,
        params: params as z.infer<P>,
        user: (req as Request & { user?: AuthUser }).user,
        admin: (req as Request & { admin?: AdminCtx }).admin,
        lang,
        req,
        res,
      });
      if (!res.headersSent) res.json(out ?? { ok: true });
    } catch (e) {
      next(e);
    }
  });

  // Register in OpenAPI
  const security =
    o.auth && o.auth !== 'public' && o.auth !== 'optional'
      ? [{ bearerAuth: [] }]
      : [];

  const openApiPath = '/api/v1' + o.path.replace(/:(\w+)/g, '{$1}');

  try {
    registry.registerPath({
      method: o.method,
      path: openApiPath,
      summary: o.summary,
      tags: [o.tag],
      security,
      request: {
        ...(o.body ? { body: { content: { 'application/json': { schema: o.body } } } } : {}),
        ...(o.query ? { query: o.query as any } : {}),
        ...(o.params ? { params: o.params as any } : {}),
      },
      responses: {
        200: { description: 'Success' },
        ...(o.responses
          ? Object.fromEntries(
              Object.entries(o.responses).map(([k, v]) => [k, { description: v }]),
            )
          : {}),
      },
    });
  } catch {
    // duplicate path registration is fine in tests
  }
}
