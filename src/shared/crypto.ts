import { createHash, createHmac, randomBytes } from 'crypto';

export function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export function hmac(key: string, data: string): string {
  return createHmac('sha256', key).update(data).digest('hex');
}

export function randomToken(bytes = 48): string {
  return randomBytes(bytes).toString('hex');
}

export function generateOtp(): string {
  const n = Math.floor(Math.random() * 1_000_000);
  return String(n).padStart(6, '0');
}

export function hashOtp(code: string, pepper: string): string {
  return sha256(code + pepper);
}

/** Base64url encode (no padding) */
export function b64urlEncode(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

/** Base64url decode */
export function b64urlDecode<T>(str: string): T {
  return JSON.parse(Buffer.from(str, 'base64url').toString('utf8')) as T;
}

/** AES-256-GCM encrypt (for TOTP secrets) */
export function aesEncrypt(plaintext: string, key: string): string {
  const { createCipheriv } = require('crypto') as typeof import('crypto');
  const keyBuf = Buffer.from(key.padEnd(32, '0').slice(0, 32));
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyBuf, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

/** AES-256-GCM decrypt */
export function aesDecrypt(ciphertext: string, key: string): string {
  const { createDecipheriv } = require('crypto') as typeof import('crypto');
  const keyBuf = Buffer.from(key.padEnd(32, '0').slice(0, 32));
  const buf = Buffer.from(ciphertext, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', keyBuf, iv);
  decipher.setAuthTag(tag);
  return decipher.update(enc) + decipher.final('utf8');
}

/** HMAC-signed token for private media links */
export function signMediaToken(mediaId: string, expiresAt: number, secret: string): string {
  const payload = `${mediaId}:${expiresAt}`;
  const sig = hmac(secret, payload);
  return b64urlEncode({ mediaId, expiresAt, sig });
}

export function verifyMediaToken(
  token: string,
  secret: string,
): { mediaId: string; expiresAt: number } | null {
  try {
    const { mediaId, expiresAt, sig } = b64urlDecode<{
      mediaId: string;
      expiresAt: number;
      sig: string;
    }>(token);
    const expected = hmac(secret, `${mediaId}:${expiresAt}`);
    if (sig !== expected) return null;
    if (Date.now() > expiresAt) return null;
    return { mediaId, expiresAt };
  } catch {
    return null;
  }
}
