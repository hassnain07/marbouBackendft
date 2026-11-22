import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import fs from 'fs';
import { z } from 'zod';
import { defineRoute } from '../../shared/route';
import { requireAuth, optionalAuth } from '../../shared/auth';
import { limiters } from '../../shared/rateLimit';
import { E } from '../../shared/errors';
import * as svc from './service';

export const mediaRouter = Router();

// Multer: disk storage for video (needs temp path for ffprobe), memory for images/docs
const memUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
const diskUpload = multer({ storage: multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, require('os').tmpdir()),
  filename: (_req, _file, cb) => cb(null, `mv_${Date.now()}_${Math.random().toString(36).slice(2)}`),
}), limits: { fileSize: 50 * 1024 * 1024 } });

// ─── POST /media/images ───────────────────────────────────────────────────────

mediaRouter.post(
  '/media/images',
  limiters.strict,
  requireAuth,
  memUpload.single('file'),
  async (req: Request, res: Response, next) => {
    try {
      const user = (req as Request & { user: { id: string } }).user;
      const purpose = (req.query.purpose as string) ?? 'listing';
      if (!['listing', 'avatar', 'cover'].includes(purpose)) {
        throw E.badRequest('INVALID_PURPOSE');
      }
      if (!req.file) throw E.badRequest('NO_FILE');
      const result = await svc.uploadImage(user.id, req.file.buffer, purpose as 'listing' | 'avatar' | 'cover');
      res.json(result);
    } catch (e) { next(e); }
  },
);

// ─── POST /media/video ────────────────────────────────────────────────────────

mediaRouter.post(
  '/media/video',
  limiters.strict,
  requireAuth,
  diskUpload.single('file'),
  async (req: Request, res: Response, next) => {
    const filePath = req.file?.path;
    try {
      const user = (req as Request & { user: { id: string } }).user;
      if (!req.file) throw E.badRequest('NO_FILE');
      const categoryId = req.query.categoryId as string | undefined;
      const result = await svc.uploadVideo(user.id, req.file.path, req.file.size, categoryId);
      res.json(result);
    } catch (e) { next(e); }
    finally {
      if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
  },
);

// ─── POST /media/documents ────────────────────────────────────────────────────

mediaRouter.post(
  '/media/documents',
  limiters.strict,
  requireAuth,
  memUpload.single('file'),
  async (req: Request, res: Response, next) => {
    try {
      const user = (req as Request & { user: { id: string } }).user;
      if (!req.file) throw E.badRequest('NO_FILE');
      const result = await svc.uploadDocument(user.id, req.file.buffer);
      res.json(result);
    } catch (e) { next(e); }
  },
);

// ─── GET /media/signed-url ────────────────────────────────────────────────────

defineRoute({
  router: mediaRouter, method: 'get', path: '/media/signed-url',
  summary: 'Get signed URL for private media', tag: 'Media', auth: 'user',
  query: z.object({ mediaId: z.string().uuid() }),
  handler: async ({ query, user }) => svc.getSignedUrl(user!.id, query.mediaId),
});

// ─── DELETE /media/:id ────────────────────────────────────────────────────────

defineRoute({
  router: mediaRouter, method: 'delete', path: '/media/:id',
  summary: 'Delete a media asset', tag: 'Media', auth: 'user',
  params: z.object({ id: z.string().uuid() }),
  handler: async ({ params, user }) => svc.deleteMedia(user!.id, params.id),
});
