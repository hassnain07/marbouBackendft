import { env, authMock } from '../config/env';
import { OAuth2Client } from 'google-auth-library';
import { createRemoteJWKSet, jwtVerify } from 'jose';

export interface SocialProfile {
  providerId: string;
  email?: string;
  emailVerified: boolean;
  name?: string;
}

// ─── Mock verifier ────────────────────────────────────────────────────────────

function parseMockToken(token: string): SocialProfile {
  // format: "mock:<email>:<name>"
  const parts = token.slice(5).split(':');
  const email = parts[0] || undefined;
  const name = parts[1] || undefined;
  const providerId = email
    ? `mock_${email.replace(/[^a-z0-9]/gi, '_')}`
    : `mock_${name?.replace(/[^a-z0-9]/gi, '_') ?? 'anon'}`;
  return {
    providerId,
    email: email || undefined,
    emailVerified: !!email,
    name,
  };
}

// ─── Google ───────────────────────────────────────────────────────────────────

async function verifyGoogle(token: string): Promise<SocialProfile> {
  const clientIds = (env.GOOGLE_CLIENT_IDS ?? '').split(',').filter(Boolean);
  const client = new OAuth2Client();
  const ticket = await client.verifyIdToken({ idToken: token, audience: clientIds.length ? clientIds : undefined });
  const payload = ticket.getPayload();
  if (!payload?.sub) throw new Error('Invalid Google token');
  return {
    providerId: payload.sub,
    email: payload.email,
    emailVerified: payload.email_verified ?? false,
    name: payload.name,
  };
}

// ─── Facebook ─────────────────────────────────────────────────────────────────

async function verifyFacebook(token: string): Promise<SocialProfile> {
  const res = await fetch(
    `https://graph.facebook.com/me?fields=id,email,name&access_token=${token}`,
  );
  if (!res.ok) throw new Error('Invalid Facebook token');
  const data = (await res.json()) as { id: string; email?: string; name?: string };
  return {
    providerId: data.id,
    email: data.email,
    emailVerified: !!data.email,
    name: data.name,
  };
}

// ─── Apple ────────────────────────────────────────────────────────────────────

const APPLE_JWKS = createRemoteJWKSet(new URL('https://appleid.apple.com/auth/keys'));

async function verifyApple(token: string): Promise<SocialProfile> {
  const { payload } = await jwtVerify(token, APPLE_JWKS, {
    issuer: 'https://appleid.apple.com',
    audience: env.APPLE_CLIENT_ID,
  });
  const sub = payload.sub as string;
  const email = payload.email as string | undefined;
  const isPrivateRelay = email?.endsWith('@privaterelay.appleid.com') ?? false;
  return {
    providerId: sub,
    email: isPrivateRelay ? undefined : email,
    emailVerified: !isPrivateRelay && !!email,
    name: undefined,
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function verifySocialToken(
  provider: string,
  token: string,
): Promise<SocialProfile> {
  if (authMock && token.startsWith('mock:')) return parseMockToken(token);

  switch (provider) {
    case 'google': return verifyGoogle(token);
    case 'facebook': return verifyFacebook(token);
    case 'apple': return verifyApple(token);
    default: throw new Error('INVALID_PROVIDER');
  }
}
