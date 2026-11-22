import sharp from 'sharp';
import { createHash } from 'crypto';

export function detectImageMime(buf: Buffer): string | null {
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'image/webp';
  if (buf.length >= 12) {
    const ftyp = buf.slice(4, 8).toString('ascii');
    if (ftyp === 'ftyp') {
      const brand = buf.slice(8, 12).toString('ascii');
      if (['heic', 'heix', 'mif1', 'msf1'].includes(brand)) return 'image/heic';
    }
  }
  return null;
}

export function detectVideoMime(buf: Buffer): string | null {
  if (buf.length >= 12) {
    const ftyp = buf.slice(4, 8).toString('ascii');
    if (ftyp === 'ftyp') return 'video/mp4';
  }
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return 'video/webm';
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x41 && buf[9] === 0x56 && buf[10] === 0x49) return 'video/avi';
  return null;
}

export function detectDocMime(buf: Buffer): string | null {
  if (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) return 'application/pdf';
  return detectImageMime(buf);
}

export interface ProcessedImage {
  main: Buffer;
  thumb: Buffer;
  width: number;
  height: number;
  sha256: string;
}

export async function processImage(input: Buffer): Promise<ProcessedImage> {
  const main = await sharp(input)
    .rotate()                                                    // auto-orient from EXIF
    .resize(1920, 1080, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 78 })
    // withMetadata() is intentionally NOT called — strips all EXIF/GPS
    .toBuffer();

  const thumb = await sharp(input)
    .rotate()
    .resize(400, 400, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 72 })
    .toBuffer();

  const meta = await sharp(main).metadata();
  const sha256 = createHash('sha256').update(main).digest('hex');
  return { main, thumb, width: meta.width ?? 0, height: meta.height ?? 0, sha256 };
}
