import { db } from './db';
import { getMessage, renderTemplate } from './messages';
import { sendPush } from './push';
import { sendEmail } from './email';

// Notification category → User.notifPrefs key
const TYPE_CATEGORY: Record<string, string> = {
  new_message: 'messages',
  new_offer: 'offers',
  offer_accepted: 'offers',
  offer_rejected: 'offers',
  offer_countered: 'offers',
  listing_published: 'listings',
  listing_expiring: 'listings',
  listing_status: 'listings',
  saved_search_match: 'saved_searches',
  price_drop: 'listings',
  listing_unavailable: 'listings',
  // Slice 4+
  booking_confirmed: 'appointments',
  booking_cancelled: 'appointments',
  job_application: 'jobs',
  rental_request: 'rentals',
  account_verified: 'account',
  account_suspended: 'account',
};

interface NotifyOpts {
  dedupeKey?: string;
  data?: Record<string, unknown>;
  vars?: Record<string, string | number>;
  mutedThreadId?: string; // skip push if recipient is in this thread room
}

export async function notify(
  userId: string,
  type: string,
  vars: Record<string, string | number> = {},
  opts: NotifyOpts = {},
): Promise<void> {
  try {
    const titleKeyAr = `notif.${type}`;
    const bodyKeyAr = `notif.${type}.body`;

    const titleAr = renderTemplate(getMessage(titleKeyAr, 'ar') ?? type, vars);
    const titleEn = renderTemplate(getMessage(titleKeyAr, 'en') ?? type, vars);
    const bodyAr = renderTemplate(getMessage(bodyKeyAr, 'ar') ?? '', vars);
    const bodyEn = renderTemplate(getMessage(bodyKeyAr, 'en') ?? '', vars);

    // Insert notification (in-app); skip silently on dedupe conflict or missing user
    try {
      await db.notification.create({
        data: {
          userId,
          type,
          title: { ar: titleAr, en: titleEn },
          body: { ar: bodyAr, en: bodyEn },
          data: (opts.data ?? {}) as never,
          dedupeKey: opts.dedupeKey ?? null,
        },
      });
    } catch (err: unknown) {
      const code = (err as { code?: string }).code;
      // P2002 = unique constraint (dedupe), P2003 = FK violation (user deleted)
      if (code === 'P2002' || code === 'P2003') return;
      throw err;
    }

    // Fetch user prefs and language
    const user = await db.user.findUnique({
      where: { id: userId },
      select: { language: true, notifPrefs: true, deviceTokens: true },
    });
    if (!user) return;

    const lang = (user.language?.toLowerCase() ?? 'ar') as 'ar' | 'en';
    const title = lang === 'en' ? titleEn : titleAr;
    const body = lang === 'en' ? bodyEn : bodyAr;

    const prefs = (user.notifPrefs ?? {}) as Record<string, { push?: boolean; email?: boolean }>;
    const category = TYPE_CATEGORY[type] ?? 'account';
    const catPrefs = prefs[category] ?? {};

    // Default: push=true, email=false except account email=true
    const pushEnabled = catPrefs.push !== undefined ? catPrefs.push : true;
    const emailEnabled = catPrefs.email !== undefined ? catPrefs.email : (category === 'account');

    if (pushEnabled) {
      sendPush(userId, { title, body, data: opts.data as Record<string, string> | undefined })
        .catch((e) => console.error('[notify] push error:', e));
    }

    if (emailEnabled) {
      const userFull = await db.user.findUnique({ where: { id: userId }, select: { email: true } });
      if (userFull?.email) {
        sendEmail(userFull.email, title, body)
          .catch((e) => console.error('[notify] email error:', e));
      }
    }
  } catch (e) {
    console.error('[notify] error:', e);
  }
}
