import type { Server as HttpServer } from 'http';
import { Server as SocketServer } from 'socket.io';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { db } from '../shared/db';
import { setRoomChecker, setEmitter } from '../modules/chat/service';

// Track which users are in which thread rooms: userId -> Set<threadId>
const userRooms = new Map<string, Set<string>>();

export function isUserInThreadRoom(userId: string, threadId: string): boolean {
  return userRooms.get(userId)?.has(threadId) ?? false;
}

export function initSockets(httpServer: HttpServer): SocketServer {
  const allowedOrigins = env.CORS_ORIGINS.split(',').map((o) => o.trim());

  const io = new SocketServer(httpServer, {
    cors: { origin: allowedOrigins, credentials: true },
    path: '/socket.io',
  });

  const chat = io.of('/chat');

  // Wire service helpers
  setRoomChecker(isUserInThreadRoom);
  setEmitter((event, room, data) => {
    chat.to(room).emit(event, data);
  });

  chat.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token as string | undefined;
      if (!token) return next(new Error('UNAUTHORIZED'));

      interface AccessPayload { sub: string; sid: string; type?: string }
      const payload = jwt.verify(token, env.JWT_USER_SECRET) as AccessPayload;
      if (payload.type !== 'access') return next(new Error('UNAUTHORIZED'));

      const session = await db.session.findUnique({ where: { id: payload.sid }, include: { user: true } });
      if (!session || session.revokedAt) return next(new Error('SESSION_REVOKED'));
      if (session.user.status === 'SUSPENDED') return next(new Error('ACCOUNT_SUSPENDED'));

      (socket as typeof socket & { userId: string }).userId = session.user.id;
      next();
    } catch {
      next(new Error('UNAUTHORIZED'));
    }
  });

  chat.on('connection', (socket) => {
    const userId = (socket as typeof socket & { userId: string }).userId;

    // Join personal room
    socket.join(`user:${userId}`);

    // Track typing throttle
    const typingThrottle = new Map<string, number>();

    socket.on('thread:join', async (threadId: string, ack?: (r: unknown) => void) => {
      try {
        const thread = await db.chatThread.findUnique({ where: { id: threadId } });
        if (!thread || (thread.buyerId !== userId && thread.sellerId !== userId)) {
          ack?.({ error: 'THREAD_NOT_FOUND' });
          return;
        }
        socket.join(`thread:${threadId}`);
        if (!userRooms.has(userId)) userRooms.set(userId, new Set());
        userRooms.get(userId)!.add(threadId);
        ack?.({ ok: true });
      } catch {
        ack?.({ error: 'INTERNAL_ERROR' });
      }
    });

    socket.on('message:send', async (data: { threadId: string; type: 'TEXT' | 'IMAGE'; body?: string; attachmentMediaId?: string; idempotencyKey?: string }, ack?: (r: unknown) => void) => {
      try {
        const { sendMessage } = await import('../modules/chat/service');
        const msg = await sendMessage(userId, data.threadId, data);
        ack?.({ ok: true, message: msg });
      } catch (err: unknown) {
        ack?.({ error: (err as { code?: string; message?: string }).code ?? 'ERROR' });
      }
    });

    socket.on('typing', (data: { threadId: string; isTyping: boolean }) => {
      const now = Date.now();
      const last = typingThrottle.get(data.threadId) ?? 0;
      if (now - last < 1000) return;
      typingThrottle.set(data.threadId, now);
      socket.to(`thread:${data.threadId}`).emit('typing', { userId, threadId: data.threadId, isTyping: data.isTyping });
    });

    socket.on('message:read', async (data: { threadId: string }) => {
      try {
        const { markRead } = await import('../modules/chat/service');
        await markRead(data.threadId, userId);
      } catch { /* ignore */ }
    });

    socket.on('disconnect', () => {
      const rooms = userRooms.get(userId);
      if (rooms) {
        for (const threadId of rooms) {
          socket.leave(`thread:${threadId}`);
        }
        userRooms.delete(userId);
      }
    });
  });

  return io;
}
