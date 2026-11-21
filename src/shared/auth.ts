import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { db } from './db';
import { AppError, E } from './errors';
import { hasPerm } from './permissions';
import type { Capability, AdminRole } from '@prisma/client';

export interface AuthUser {
  id: string;
  email: string | null;
  emailVerifiedAt: Date | null;
  status: string;
  capabilities: Capability[];
  language: string;
}

export interface AdminCtx {
  id: string;
  email: string;
  role: AdminRole;
  tokenVersion: number;
}

interface AccessPayload {
  sub: string;
  sid: string;
  fam: string;
  iat: number;
  exp: number;
}

interface AdminPayload {
  sub: string;
  role: AdminRole;
  tv: number;
  iat: number;
  exp: number;
}

// 30-second session cache keyed by sid
const sessionCache = new Map<string, { user: AuthUser; expiresAt: number }>();

function cacheSession(sid: string, user: AuthUser): void {
  sessionCache.set(sid, { user, expiresAt: Date.now() + 30_000 });
}

export function invalidateSessionCache(sid: string): void {
  sessionCache.delete(sid);
}

export function invalidateUserSessions(userId: string): void {
  for (const [sid, entry] of sessionCache) {
    if (entry.user.id === userId) sessionCache.delete(sid);
  }
}

async function resolveSession(sid: string): Promise<AuthUser> {
  const cached = sessionCache.get(sid);
  if (cached && cached.expiresAt > Date.now()) return cached.user;

  const session = await db.session.findUnique({
    where: { id: sid },
    include: { user: true },
  });
  if (!session || session.revokedAt) throw E.unauthorized('SESSION_REVOKED');

  const u = session.user;
  if (u.status === 'SUSPENDED') throw E.forbidden('ACCOUNT_SUSPENDED');

  const user: AuthUser = {
    id: u.id,
    email: u.email,
    emailVerifiedAt: u.emailVerifiedAt,
    status: u.status,
    capabilities: u.capabilities,
    language: u.language,
  };

  cacheSession(sid, user);
  return user;
}

function jwtError(e: unknown): AppError {
  if (e instanceof Error) {
    if (e.name === 'TokenExpiredError') return E.unauthorized('TOKEN_EXPIRED');
    if (
      e.name === 'JsonWebTokenError' ||
      e.name === 'NotBeforeError' ||
      e.name === 'SyntaxError'
    ) return E.unauthorized();
  }
  return E.unauthorized();
}

export async function requireAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const token = extractBearer(req);
    if (!token) throw E.unauthorized();
    const payload = jwt.verify(token, env.JWT_USER_SECRET) as AccessPayload;
    // Reject non-access tokens (refresh tokens, mfa tokens)
    if ((payload as unknown as { type?: string }).type !== 'access') throw E.unauthorized();
    const user = await resolveSession(payload.sid);
    (req as Request & { user: AuthUser; sessionId: string }).user = user;
    (req as Request & { sessionId: string }).sessionId = payload.sid;
    next();
  } catch (e) {
    next(e instanceof AppError ? e : jwtError(e));
  }
}

export async function optionalAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const token = extractBearer(req);
    if (token) {
      const payload = jwt.verify(token, env.JWT_USER_SECRET) as AccessPayload;
      if ((payload as unknown as { type?: string }).type === 'access') {
        const user = await resolveSession(payload.sid);
        (req as Request & { user: AuthUser; sessionId: string }).user = user;
        (req as Request & { sessionId: string }).sessionId = payload.sid;
      }
    }
  } catch {
    // ignore – optional
  }
  next();
}

export function requireVerifiedEmail(req: Request, _res: Response, next: NextFunction): void {
  const user = (req as Request & { user?: AuthUser }).user;
  if (!user?.emailVerifiedAt) {
    next(E.forbidden('EMAIL_NOT_VERIFIED'));
    return;
  }
  next();
}

export async function requireAdmin(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const token = extractBearer(req);
    if (!token) throw E.unauthorized();
    const payload = jwt.verify(token, env.JWT_ADMIN_SECRET) as AdminPayload;
    // Reject refresh and mfa tokens (B07)
    if ((payload as unknown as { type?: string; purpose?: string }).type === 'refresh') throw E.unauthorized();
    if ((payload as unknown as { purpose?: string }).purpose === 'mfa') throw E.unauthorized();
    if (!payload.role) throw E.unauthorized();

    const admin = await db.adminUser.findUnique({ where: { id: payload.sub } });
    if (!admin || !admin.isActive) throw E.unauthorized('ADMIN_INACTIVE');
    if (admin.tokenVersion !== payload.tv) throw E.unauthorized('SESSION_REVOKED');

    (req as Request & { admin: AdminCtx }).admin = {
      id: admin.id,
      email: admin.email,
      role: admin.role,
      tokenVersion: admin.tokenVersion,
    };

    // B07: enforce mustChangePassword — block everything except allowed endpoints
    if (admin.mustChangePassword) {
      const path = req.path;
      const allowed = [
        '/admin/me',
        '/admin/auth/change-password',
        '/admin/auth/logout',
      ];
      if (!allowed.some((p) => path === p || path.startsWith(p))) {
        next(E.forbidden('PASSWORD_CHANGE_REQUIRED'));
        return;
      }
    }

    next();
  } catch (e) {
    next(e instanceof AppError ? e : jwtError(e));
  }
}

export function requirePerm(perm: string) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const admin = (req as Request & { admin?: AdminCtx }).admin;
    if (!admin) { next(E.unauthorized()); return; }
    if (!hasPerm(admin.role, perm)) { next(E.forbidden()); return; }
    next();
  };
}

export function requireCapability(cap: Capability) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const user = (req as Request & { user?: AuthUser }).user;
    if (!user) { next(E.unauthorized()); return; }
    if (!user.capabilities.includes(cap)) { next(E.forbidden()); return; }
    next();
  };
}

function extractBearer(req: Request): string | null {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return null;
  return auth.slice(7);
}
