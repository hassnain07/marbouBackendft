import { createHash, createHmac, randomBytes, randomInt } from 'crypto';
import { E } from './errors';

// ─── Phone validation (B09) ─────────────────────────────────────────────────

/**
 * Validates and normalises a phone number.
 * Accepts E.164 (+...) or a 10-digit Sudanese local number starting with 0
 * (converted to +249 + 9 digits). Throws 400 INVALID_PHONE otherwise.
 */
export function validatePhone(raw: string): string {
  const s = raw.trim();
  if (/^\+[1-9]\d{6,14}$/.test(s)) return s;
  if (/^0\d{9}$/.test(s)) return '+249' + s.slice(1);
  throw E.badRequest('INVALID_PHONE');
}

export function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export function hmac(key: string, data: string): string {
  return createHmac('sha256', key).update(data).digest('hex');
}

export function randomToken(bytes = 48): string {
  return randomBytes(bytes).toString('hex');
}

/** B8: use crypto.randomInt for cryptographically secure OTP */
export function generateOtp(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

export function hashOtp(code: string, pepper: string): string {
  return sha256(code + pepper);
}

export function b64urlEncode(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

export function b64urlDecode<T>(str: string): T {
  return JSON.parse(Buffer.from(str, 'base64url').toString('utf8')) as T;
}

/** A7/B8: derive 32-byte key with sha256(key) instead of padEnd */
function deriveKey(key: string): Buffer {
  return Buffer.from(createHash('sha256').update(key).digest());
}

export function aesEncrypt(plaintext: string, key: string): string {
  const { createCipheriv } = require('crypto') as typeof import('crypto');
  const keyBuf = deriveKey(key);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyBuf, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

export function aesDecrypt(ciphertext: string, key: string): string {
  const { createDecipheriv } = require('crypto') as typeof import('crypto');
  const keyBuf = deriveKey(key);
  const buf = Buffer.from(ciphertext, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', keyBuf, iv);
  decipher.setAuthTag(tag);
  return decipher.update(enc) + decipher.final('utf8');
}

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
      mediaId: string; expiresAt: number; sig: string;
    }>(token);
    const expected = hmac(secret, `${mediaId}:${expiresAt}`);
    if (sig !== expected) return null;
    if (Date.now() > expiresAt) return null;
    return { mediaId, expiresAt };
  } catch {
    return null;
  }
}
