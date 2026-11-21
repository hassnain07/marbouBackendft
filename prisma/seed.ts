import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
dotenv.config();

const db = new PrismaClient();

const DEFAULTS: Record<string, unknown> = {
  'flags.otp.email': true,
  'flags.otp.sms': false,
  'flags.otp.whatsapp': false,
  'flags.video.enabled': true,
  'flags.bankak.userFlow': false,
  'flags.monetization': false,
  'flags.engine.subscriptions': false,
  'flags.engine.promotions': false,
  'flags.engine.credits': false,
  'flags.engine.boosts': false,
  'flags.engine.auctions': false,
  'flags.engine.barter': false,
  'flags.engine.assetRental': false,
  'flags.engine.cart': false,
  'flags.engine.delivery': false,
  'flags.engine.admob': false,
  'flags.engine.wholesale': false,
  'flags.engine.hotelReservations': false,
  'flags.contactReveal.policy': 'GUESTS_RATE_LIMITED',
  'limits.guestRevealsPerDay': 20,
  'limits.activeListingsIndividual': 50,
  'limits.activeListingsBusiness': 500,
  'limits.listingsPerHour': 5,
  'limits.listingsPerDay': 20,
  'limits.applicationsPerDay': 20,
  'media.maxPhotos': 10,
  'media.video.maxSeconds': 30,
  'media.video.maxMB': 15,
  'media.photo.maxMB': 8,
  'media.video.disabledCategoryIds': [],
  'listing.expiryDaysDefault': 30,
  'listing.renewWindowDays': 30,
  'quality.weights': { titleDesc: 25, photos: 25, requiredAttrs: 20, optionalAttrs: 10, location: 10, video: 5, price: 5 },
  'dup.textSimilarity': 0.85,
  'moderation.autoHide': { reports: 5, windowHours: 24, fraudScore: 85 },
  'moderation.delayedVisibility': [],
  'fraud.alert': 70,
  'fraud.rateLimit': 80,
  'insight.minComparables': 8,
  'insight.bandPct': 15,
  'fx.staleAlertHours': 72,
  'fx.staleSuppressDays': 7,
  'auth.lockout': { maxFails: 5, delaysMin: [1, 5, 15, 60] },
  'chat.throttle': { perMinute: 20, perRecipientPerMinute: 10, sameTextRecipients: 3, sameTextWindowMin: 10 },
  'chat.reviewMinMessagesEach': 2,
  'chat.bannedPhrases': [],
  'appointment.confirmWindowHours': 72,
  'deletion.graceDays': 30,
  'app.minVersion': { ios: '1.0.0', android: '1.0.0' },
  'app.maintenance': { enabled: false, messageAr: '', messageEn: '', from: null, to: null },
  'maps.googleDailyCap': 1000,
  'maps.perUserPerDay': 50,
  'maps.perIpPerDay': 100,
  'contact.support': { email: 'support@marbou.sd', phone: '', whatsapp: '' },
  'currencies.enabled': ['SDG', 'USD'],
  'whatsapp.template.ar': 'مرحباً، مهتم بـ {title} ({listingId}) بسعر {price}',
  'whatsapp.template.en': 'Hi, interested in {title} ({listingId}) at {price}',
};

const BASE_TRANSLATIONS: Array<{ key: string; ar: string; en: string }> = [
  { key: 'app.name', ar: 'مربو', en: 'MARBOU' },
  { key: 'app.tagline', ar: 'سوق السودان الأول', en: "Sudan's #1 Marketplace" },
  { key: 'auth.register.title', ar: 'إنشاء حساب', en: 'Create Account' },
  { key: 'auth.login.title', ar: 'تسجيل الدخول', en: 'Sign In' },
  { key: 'auth.otp.title', ar: 'التحقق من البريد الإلكتروني', en: 'Email Verification' },
  { key: 'auth.otp.subtitle', ar: 'أدخل الرمز المرسل إلى بريدك', en: 'Enter the code sent to your email' },
  { key: 'auth.forgot.title', ar: 'نسيت كلمة المرور', en: 'Forgot Password' },
  { key: 'auth.reset.title', ar: 'إعادة تعيين كلمة المرور', en: 'Reset Password' },
  { key: 'profile.title', ar: 'الملف الشخصي', en: 'Profile' },
  { key: 'profile.edit', ar: 'تعديل الملف', en: 'Edit Profile' },
  { key: 'profile.verified', ar: 'موثق', en: 'Verified' },
  { key: 'listing.create', ar: 'إضافة إعلان', en: 'Post Ad' },
  { key: 'listing.edit', ar: 'تعديل الإعلان', en: 'Edit Ad' },
  { key: 'listing.sold', ar: 'تم البيع', en: 'Sold' },
  { key: 'listing.expired', ar: 'منتهي الصلاحية', en: 'Expired' },
  { key: 'search.placeholder', ar: 'ابحث عن أي شيء...', en: 'Search for anything...' },
  { key: 'search.noResults', ar: 'لا توجد نتائج', en: 'No results found' },
  { key: 'error.generic', ar: 'حدث خطأ، يرجى المحاولة مرة أخرى', en: 'Something went wrong, please try again' },
  { key: 'error.network', ar: 'خطأ في الاتصال بالإنترنت', en: 'Network error' },
  { key: 'error.unauthorized', ar: 'يرجى تسجيل الدخول أولاً', en: 'Please sign in first' },
  { key: 'error.forbidden', ar: 'ليس لديك صلاحية', en: 'Access denied' },
  { key: 'error.notFound', ar: 'الصفحة غير موجودة', en: 'Page not found' },
  { key: 'button.save', ar: 'حفظ', en: 'Save' },
  { key: 'button.cancel', ar: 'إلغاء', en: 'Cancel' },
  { key: 'button.confirm', ar: 'تأكيد', en: 'Confirm' },
  { key: 'button.delete', ar: 'حذف', en: 'Delete' },
  { key: 'button.back', ar: 'رجوع', en: 'Back' },
  { key: 'button.next', ar: 'التالي', en: 'Next' },
  { key: 'button.submit', ar: 'إرسال', en: 'Submit' },
  { key: 'currency.SDG', ar: 'جنيه سوداني', en: 'Sudanese Pound' },
  { key: 'currency.USD', ar: 'دولار أمريكي', en: 'US Dollar' },
  { key: 'status.active', ar: 'نشط', en: 'Active' },
  { key: 'status.pending', ar: 'قيد المراجعة', en: 'Pending Review' },
  { key: 'status.suspended', ar: 'موقوف', en: 'Suspended' },
  { key: 'notif.otp_requested', ar: 'تم إرسال رمز التحقق', en: 'Verification code sent' },
  { key: 'notif.otp_verified', ar: 'تم التحقق بنجاح', en: 'Verification successful' },
  { key: 'notif.listing_expired', ar: 'انتهت صلاحية إعلانك', en: 'Your listing has expired' },
  { key: 'notif.new_message', ar: 'رسالة جديدة', en: 'New message' },
];

async function seedSettings() {
  console.log('Seeding settings...');
  for (const [key, value] of Object.entries(DEFAULTS)) {
    await db.setting.upsert({
      where: { key },
      create: { key, value: value as never },
      update: {},
    });
  }
  console.log(`  ✓ ${Object.keys(DEFAULTS).length} settings`);
}

async function seedTranslations() {
  console.log('Seeding translations...');
  for (const t of BASE_TRANSLATIONS) {
    await db.translation.upsert({
      where: { key_lang: { key: t.key, lang: 'ar' } },
      create: { key: t.key, lang: 'ar', value: t.ar },
      update: { value: t.ar },
    });
    await db.translation.upsert({
      where: { key_lang: { key: t.key, lang: 'en' } },
      create: { key: t.key, lang: 'en', value: t.en },
      update: { value: t.en },
    });
  }
  console.log(`  ✓ ${BASE_TRANSLATIONS.length * 2} translation entries`);
}

async function seedExchangeRate() {
  console.log('Seeding exchange rates...');
  const existing = await db.exchangeRate.findFirst({ where: { base: 'USD', quote: 'SDG' } });
  if (!existing) {
    await db.exchangeRate.create({ data: { base: 'USD', quote: 'SDG', rate: 600, setBy: 'seed' } });
    await db.exchangeRate.create({ data: { base: 'SDG', quote: 'USD', rate: 0.001667, setBy: 'seed' } });
  }
  console.log('  ✓ USD/SDG exchange rate');
}

async function seedAdmins() {
  console.log('Seeding admin users...');
  const adminEmail = process.env.SEED_ADMIN_EMAIL ?? 'admin@marbou.test';
  const adminPassword = process.env.SEED_ADMIN_PASSWORD ?? 'Admin#12345';
  const passwordHash = await bcrypt.hash(adminPassword, 12);

  await db.adminUser.upsert({
    where: { email: adminEmail },
    create: { email: adminEmail, passwordHash, fullName: 'Super Admin', role: 'SUPER_ADMIN' },
    update: {},
  });
  console.log(`  ✓ Super Admin: ${adminEmail}`);

  if (process.env.SEED_DEMO_ADMINS === 'true') {
    const demoAdmins = [
      { email: 'moderator@marbou.test', fullName: 'Content Moderator', role: 'CONTENT_MODERATOR' as const },
      { email: 'support@marbou.test', fullName: 'Support Agent', role: 'SUPPORT_AGENT' as const },
      { email: 'finance@marbou.test', fullName: 'Financial Auditor', role: 'FINANCIAL_AUDITOR' as const },
    ];
    for (const a of demoAdmins) {
      await db.adminUser.upsert({
        where: { email: a.email },
        create: { email: a.email, passwordHash, fullName: a.fullName, role: a.role },
        update: {},
      });
      console.log(`  ✓ ${a.role}: ${a.email}`);
    }
  }
}

async function main() {
  console.log('🌱 Starting seed...');
  await seedSettings();
  await seedTranslations();
  await seedExchangeRate();
  await seedAdmins();
  console.log('✅ Seed complete');
}

main()
  .catch((e) => { console.error('Seed failed:', e); process.exit(1); })
  .finally(() => db.$disconnect());
