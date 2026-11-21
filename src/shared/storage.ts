import fs from 'fs';
import path from 'path';
import { env } from '../config/env';
import { signMediaToken, verifyMediaToken } from './crypto';

const LOCAL_PATH = path.resolve(env.STORAGE_LOCAL_PATH);

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

export const storage = {
  async put(
    key: string,
    buf: Buffer,
    opts: { mime: string; isPrivate: boolean },
  ): Promise<string> {
    const bucket = opts.isPrivate ? 'private' : 'public';
    const dir = path.join(LOCAL_PATH, bucket, path.dirname(key));
    ensureDir(dir);
    fs.writeFileSync(path.join(LOCAL_PATH, bucket, key), buf);
    if (!opts.isPrivate) {
      return `${env.STORAGE_PUBLIC_URL}/${key}`;
    }
    return key; // private: return key only
  },

  publicUrl(key: string): string {
    return `${env.STORAGE_PUBLIC_URL}/${key}`;
  },

  /** Generate a 5-minute HMAC-signed URL for private assets */
  signedUrl(mediaId: string): string {
    const expiresAt = Date.now() + 5 * 60 * 1000;
    const token = signMediaToken(mediaId, expiresAt, env.JWT_USER_SECRET);
    return `/media/private/${token}`;
  },

  verifyToken(token: string): { mediaId: string; expiresAt: number } | null {
    return verifyMediaToken(token, env.JWT_USER_SECRET);
  },

  async delete(key: string, isPrivate: boolean): Promise<void> {
    const bucket = isPrivate ? 'private' : 'public';
    const filePath = path.join(LOCAL_PATH, bucket, key);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  },

  readFile(key: string, isPrivate: boolean): Buffer | null {
    const bucket = isPrivate ? 'private' : 'public';
    const filePath = path.join(LOCAL_PATH, bucket, key);
    if (!fs.existsSync(filePath)) return null;
    return fs.readFileSync(filePath);
  },
};
