import { Router } from 'express';
import { z } from 'zod';
import { defineRoute } from '../../shared/route';
import { db } from '../../shared/db';
import { E } from '../../shared/errors';
import { decodeCursor, paginate } from '../../shared/pagination';

export const notificationsRouter = Router();

defineRoute({
  router: notificationsRouter, method: 'get', path: '/notifications',
  summary: 'List notifications', tag: 'Notifications', auth: 'user',
  query: z.object({
    cursor: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
    unread: z.string().optional(),
  }),
  handler: async ({ query, user, lang }) => {
    const offset = query.cursor ? decodeCursor(query.cursor).o : 0;
    const onlyUnread = query.unread === 'true';

    const notifications = await db.notification.findMany({
      where: { userId: user!.id, ...(onlyUnread ? { readAt: null } : {}) },
      orderBy: { createdAt: 'desc' },
      skip: offset,
      take: query.limit + 1,
    });

    const items = notifications.slice(0, query.limit).map((n) => {
      const title = (n.title as Record<string, string>)[lang] ?? (n.title as Record<string, string>).ar ?? '';
      const body = (n.body as Record<string, string>)[lang] ?? (n.body as Record<string, string>).ar ?? '';
      return { id: n.id, type: n.type, title, body, data: n.data, readAt: n.readAt, createdAt: n.createdAt };
    });

    return paginate(items, query.limit, offset);
  },
});

defineRoute({
  router: notificationsRouter, method: 'get', path: '/notifications/unread-count',
  summary: 'Unread notification count', tag: 'Notifications', auth: 'user',
  handler: async ({ user }) => {
    const count = await db.notification.count({ where: { userId: user!.id, readAt: null } });
    return { count };
  },
});

defineRoute({
  router: notificationsRouter, method: 'post', path: '/notifications/:id/read',
  summary: 'Mark notification as read', tag: 'Notifications', auth: 'user',
  params: z.object({ id: z.string().uuid() }),
  handler: async ({ params, user }) => {
    const notif = await db.notification.findUnique({ where: { id: params.id } });
    if (!notif || notif.userId !== user!.id) throw E.notFound('NOTIFICATION_NOT_FOUND');
    if (notif.readAt) return { ok: true };
    await db.notification.update({ where: { id: params.id }, data: { readAt: new Date() } });
    return { ok: true };
  },
});

defineRoute({
  router: notificationsRouter, method: 'post', path: '/notifications/read-all',
  summary: 'Mark all notifications as read', tag: 'Notifications', auth: 'user',
  handler: async ({ user }) => {
    await db.notification.updateMany({ where: { userId: user!.id, readAt: null }, data: { readAt: new Date() } });
    return { ok: true };
  },
});
