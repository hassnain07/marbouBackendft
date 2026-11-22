import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { db } from '../../shared/db';
import { storage } from '../../shared/storage';
import { E } from '../../shared/errors';
import { settings } from '../../shared/settings';
import { env } from '../../config/env';
import { detectImageMime, detectVideoMime, detectDocMime, processImage } from './imageProcessor';
import { probeVideo } from './ffprobe';
import { classifyImage } from './classifier';

const PUBLIC_API = env.PUBLIC_API_URL;

function absUrl(url: string): string {
  if (url.startsWith('http')) return url;
  return `${PUBLIC_API}${url}`;
}

// ─── Image upload ─────────────────────────────────────────────────────────────

export async function uploadImage(
  ownerId: string,
  buf: Buffer,
  purpose: 'listing' | 'avatar' | 'cover',
  isPrivate = false,
) {
  const maxMB = await settings.get<number>('media.photo.maxMB', 8);
  if (buf.length > maxMB * 1024 * 1024) throw E.rule('FILE_TOO_LARGE', { maxMB });

  const mime = detectImageMime(buf);
  if (!mime) throw E.badRequest('UNSUPPORTED_IMAGE_FORMAT');
  if (mime === 'image/heic') throw E.badRequest('UNSUPPORTED_IMAGE_FORMAT');

  const { allowed } = await classifyImage(buf, purpose);
  if (!allowed) throw E.rule('IMAGE_REJECTED');

  const { main, thumb, width, height, sha256 } = await processImage(buf);

  const id = randomUUID();
  const folder = purpose === 'listing' ? 'listings' : 'avatars';
  const mainKey = `${folder}/${id}.webp`;
  const thumbKey = `${folder}/${id}_m.webp`;

  const mainUrl = await storage.put(mainKey, main, { mime: 'image/webp', isPrivate });
  const thumbUrl = await storage.put(thumbKey, thumb, { mime: 'image/webp', isPrivate });

  const asset = await db.mediaAsset.create({
    data: {
      id,
      ownerId,
      kind: 'IMAGE',
      isPrivate,
      key: mainKey,
      url: absUrl(mainUrl),
      thumbKeys: { m: absUrl(thumbUrl) },
      sizeBytes: main.length,
      mime: 'image/webp',
      width,
      height,
      sha256,
    },
  });

  return {
    id: asset.id,
    url: asset.url,
    thumbs: { m: (asset.thumbKeys as { m: string }).m },
  };
}

// ─── Video upload ─────────────────────────────────────────────────────────────

export async function uploadVideo(
  ownerId: string,
  filePath: string,
  fileSize: number,
  categoryId?: string,
) {
  const videoEnabled = await settings.get<boolean>('flags.video.enabled', true);
  if (!videoEnabled) throw E.rule('VIDEO_DISABLED');

  const maxMB = await settings.get<number>('media.video.maxMB', 15);
  if (fileSize > maxMB * 1024 * 1024) throw E.rule('VIDEO_TOO_LARGE', { maxMB });

  // Category check
  if (categoryId) {
    const disabledCats = await settings.get<string[]>('media.video.disabledCategoryIds', []);
    if (disabledCats.includes(categoryId)) throw E.rule('VIDEO_DISABLED');
    const cat = await db.category.findUnique({ where: { id: categoryId }, select: { isVideoAllowed: true } });
    if (cat && !cat.isVideoAllowed) throw E.rule('VIDEO_DISABLED');
  }

  // Read first bytes for magic check
  const fd = fs.openSync(filePath, 'r');
  const header = Buffer.alloc(16);
  fs.readSync(fd, header, 0, 16, 0);
  fs.closeSync(fd);
  const mime = detectVideoMime(header);
  if (!mime) throw E.badRequest('UNSUPPORTED_VIDEO_FORMAT');

  const maxSec = await settings.get<number>('media.video.maxSeconds', 30);
  let info: Awaited<ReturnType<typeof probeVideo>>;
  try {
    info = await probeVideo(filePath);
  } catch {
    throw E.badRequest('VIDEO_PROBE_FAILED');
  }
  if (info.durationSec > maxSec) throw E.rule('VIDEO_TOO_LONG', { maxSec });

  const id = randomUUID();
  const key = `listings/video_${id}.mp4`;
  const buf = fs.readFileSync(filePath);
  const url = await storage.put(key, buf, { mime, isPrivate: false });

  const asset = await db.mediaAsset.create({
    data: {
      id,
      ownerId,
      kind: 'video',
      isPrivate: false,
      key,
      url: absUrl(url),
      sizeBytes: fileSize,
      mime,
      durationSec: Math.round(info.durationSec),
    },
  });

  return { id: asset.id, url: asset.url };
}

// ─── Document upload ──────────────────────────────────────────────────────────

export async function uploadDocument(ownerId: string, buf: Buffer) {
  const MAX_BYTES = 10 * 1024 * 1024;
  if (buf.length > MAX_BYTES) throw E.rule('FILE_TOO_LARGE', { maxMB: 10 });

  const mime = detectDocMime(buf);
  if (!mime) throw E.badRequest('UNSUPPORTED_DOCUMENT_FORMAT');

  const id = randomUUID();
  const ext = mime === 'application/pdf' ? 'pdf' : 'jpg';
  const key = `docs/${id}.${ext}`;
  await storage.put(key, buf, { mime, isPrivate: true });

  const asset = await db.mediaAsset.create({
    data: { id, ownerId, kind: 'DOC', isPrivate: true, key, sizeBytes: buf.length, mime },
  });

  return { id: asset.id, key: asset.key };
}

// ─── Signed URL ───────────────────────────────────────────────────────────────

export async function getSignedUrl(requesterId: string, mediaId: string) {
  const asset = await db.mediaAsset.findUnique({ where: { id: mediaId } });
  if (!asset) throw E.notFound('MEDIA_NOT_FOUND');
  if (!asset.isPrivate) throw E.badRequest('MEDIA_NOT_PRIVATE');
  if (!canAccessMedia(requesterId, asset)) throw E.forbidden('MEDIA_NOT_OWNED');
  const url = `${PUBLIC_API}${storage.signedUrl(mediaId)}`;
  return { url, expiresIn: 300 };
}

export function canAccessMedia(userId: string, asset: { ownerId: string }): boolean {
  return asset.ownerId === userId;
}

// ─── Delete ───────────────────────────────────────────────────────────────────

export async function deleteMedia(requesterId: string, mediaId: string) {
  const asset = await db.mediaAsset.findUnique({ where: { id: mediaId } });
  if (!asset) throw E.notFound('MEDIA_NOT_FOUND');
  if (asset.ownerId !== requesterId) throw E.forbidden('MEDIA_NOT_OWNED');
  if (asset.attachedAt) throw E.conflict('MEDIA_IN_USE');
  await storage.delete(asset.key, asset.isPrivate);
  await db.mediaAsset.delete({ where: { id: mediaId } });
  return { ok: true };
}

// ─── Attach helper ────────────────────────────────────────────────────────────

export async function attachMedia(
  ids: string[],
  ownerId: string,
  allowedKinds?: string[],
): Promise<void> {
  for (const id of ids) {
    const asset = await db.mediaAsset.findUnique({ where: { id } });
    if (!asset) throw E.notFound('MEDIA_NOT_FOUND');
    if (asset.ownerId !== ownerId) throw E.forbidden('MEDIA_NOT_OWNED');
    if (allowedKinds && !allowedKinds.includes(asset.kind)) throw E.badRequest('MEDIA_WRONG_KIND');
  }
  await db.mediaAsset.updateMany({
    where: { id: { in: ids } },
    data: { attachedAt: new Date() },
  });
}

export async function cleanOrphanMedia(): Promise<number> {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const orphans = await db.mediaAsset.findMany({
    where: { attachedAt: null, createdAt: { lt: cutoff } },
  });
  let count = 0;
  for (const asset of orphans) {
    try {
      await storage.delete(asset.key, asset.isPrivate);
      // Also delete thumb if present
      const thumbKeys = asset.thumbKeys as Record<string, string> | null;
      if (thumbKeys) {
        for (const thumbUrl of Object.values(thumbKeys)) {
          // Derive key from URL
          const key = thumbUrl.replace(`${env.STORAGE_PUBLIC_URL}/`, '');
          await storage.delete(key, false).catch(() => {});
        }
      }
      await db.mediaAsset.delete({ where: { id: asset.id } });
      count++;
    } catch { /* best-effort */ }
  }
  return count;
}

// Export alias expected by tests
export const cleanupOrphanMedia = cleanOrphanMedia;
