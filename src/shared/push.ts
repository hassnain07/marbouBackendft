import { env } from '../config/env';
import { db } from './db';

export interface PushPayload {
  title: string;
  body: string;
  data?: Record<string, string>;
}

export async function sendPush(userId: string, payload: PushPayload): Promise<void> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { deviceTokens: true } });
  if (!user) return;

  const tokens = (user.deviceTokens as string[]) ?? [];
  if (tokens.length === 0) return;

  if (env.PUSH_DRIVER === 'console') {
    console.log(`[PUSH] userId=${userId} title="${payload.title}" body="${payload.body}"`);
    return;
  }

  if (env.PUSH_DRIVER === 'fcm') {
    if (!env.FCM_SERVICE_ACCOUNT) {
      console.warn('[PUSH] FCM_SERVICE_ACCOUNT not set, skipping push');
      return;
    }
     
    let admin: any;
    try {
      // Dynamic require avoids compile-time resolution of optional firebase-admin
       
      admin = require('firebase-admin');
    } catch {
      console.warn('[PUSH] firebase-admin not installed');
      return;
    }

    if (!admin.apps.length) {
      const sa = JSON.parse(env.FCM_SERVICE_ACCOUNT);
      admin.initializeApp({ credential: admin.credential.cert(sa) });
    }

    const invalidTokens: string[] = [];
    for (const token of tokens) {
      try {
        await admin.messaging().send({
          token,
          notification: { title: payload.title, body: payload.body },
          data: payload.data,
        });
      } catch (err: unknown) {
        const code = (err as { code?: string }).code ?? '';
        if (
          code === 'messaging/invalid-registration-token' ||
          code === 'messaging/registration-token-not-registered'
        ) {
          invalidTokens.push(token);
        } else {
          console.error('[PUSH] FCM error:', err);
        }
      }
    }

    if (invalidTokens.length > 0) {
      const remaining = tokens.filter((t) => !invalidTokens.includes(t));
      await db.user.update({ where: { id: userId }, data: { deviceTokens: remaining as never } });
    }
  }
}
