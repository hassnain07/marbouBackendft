import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
import { SUDAN_STATES, CITIES_BY_STATE, NEIGHBORHOODS_BY_CITY, CATEGORY_SPEC } from './seed-data';
dotenv.config();

const BCRYPT_ROUNDS = parseInt(process.env.BCRYPT_ROUNDS ?? '12', 10);

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
  'listing.approxRadiusDefault': 500,
  'quality.weights': { titleDesc: 25, photos: 25, requiredAttrs: 20, optionalAttrs: 10, location: 10, video: 5, price: 5 },
  'dup.textSimilarity': 0.85,
  'moderation.autoHide': { reports: 5, windowHours: 24, fraudScore: 85 },
  'moderation.delayedVisibility': [],
  'moderation.bannedKeywords': [],
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
  'countries': [{ code: 'SD', nameAr: 'السودان', nameEn: 'Sudan' }],
  'whatsapp.template.ar': 'مرحباً، مهتم بـ {title} ({listingId}) بسعر {price}',
  'whatsapp.template.en': 'Hi, interested in {title} ({listingId}) at {price}',
};

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

async function seedExchangeRate() {
  console.log('Seeding exchange rates...');
  const existing = await db.exchangeRate.findFirst({ where: { base: 'USD', quote: 'SDG' } });
  if (!existing) {
    await db.exchangeRate.create({ data: { base: 'USD', quote: 'SDG', rate: 600, setBy: 'seed' } });
    await db.exchangeRate.create({ data: { base: 'SDG', quote: 'USD', rate: 0.001667, setBy: 'seed' } });
    console.log('  ✓ USD/SDG exchange rate');
  } else {
    console.log('  ✓ exchange rate already exists');
  }
}

async function seedAdmins() {
  console.log('Seeding admin users...');
  const adminEmail = process.env.SEED_ADMIN_EMAIL ?? 'admin@marbou.test';
  const adminPassword = process.env.SEED_ADMIN_PASSWORD ?? 'Admin#12345';
  const passwordHash = await bcrypt.hash(adminPassword, BCRYPT_ROUNDS);

  await db.adminUser.upsert({
    where: { email: adminEmail },
    create: { email: adminEmail, passwordHash, fullName: 'Super Admin', role: 'SUPER_ADMIN' },
    update: process.env.NODE_ENV !== 'production'
      ? { passwordHash, isActive: true, mustChangePassword: false }
      : {},
  });
  console.log(`  ✓ Super Admin: ${adminEmail}`);
}

async function seedPlaces() {
  console.log('Seeding Sudan places...');
  let stateCount = 0, cityCount = 0, hoodCount = 0;

  for (const state of SUDAN_STATES) {
    const existing = await db.place.findFirst({ where: { level: 'STATE', nameEn: state.nameEn } });
    const stateRow = existing ?? await db.place.create({
      data: { level: 'STATE', nameAr: state.nameAr, nameEn: state.nameEn, countryCode: 'SD' },
    });
    if (!existing) stateCount++;

    const cities = CITIES_BY_STATE[state.nameEn] ?? [];
    for (const city of cities) {
      const existingCity = await db.place.findFirst({ where: { level: 'CITY', nameEn: city.nameEn, parentId: stateRow.id } });
      const cityRow = existingCity ?? await db.place.create({
        data: { level: 'CITY', nameAr: city.nameAr, nameEn: city.nameEn, parentId: stateRow.id, countryCode: 'SD' },
      });
      if (!existingCity) cityCount++;

      const hoods = NEIGHBORHOODS_BY_CITY[city.nameEn] ?? [];
      for (const hood of hoods) {
        const existingHood = await db.place.findFirst({ where: { level: 'NEIGHBORHOOD', nameEn: hood.nameEn, parentId: cityRow.id } });
        if (!existingHood) {
          await db.place.create({
            data: { level: 'NEIGHBORHOOD', nameAr: hood.nameAr, nameEn: hood.nameEn, parentId: cityRow.id, countryCode: 'SD' },
          });
          hoodCount++;
        }
      }
    }
  }
  console.log(`  ✓ ${stateCount} states, ${cityCount} cities, ${hoodCount} neighborhoods (new)`);
}

async function seedCategories() {
  console.log('Seeding categories...');
  let catCount = 0, attrCount = 0;

  async function upsertCategory(spec: typeof CATEGORY_SPEC[0], parentId?: string): Promise<string> {
    const existing = await db.category.findUnique({ where: { slug: spec.slug } });
    let cat;
    if (existing) {
      cat = existing;
    } else {
      cat = await db.category.create({
        data: {
          slug: spec.slug,
          nameAr: spec.nameAr,
          nameEn: spec.nameEn,
          displayOrder: spec.displayOrder,
          parentId: parentId ?? null,
          isActive: true,
        },
      });
      catCount++;
    }

    // Upsert attributes
    for (const attr of spec.attrs ?? []) {
      const existingAttr = await db.categoryAttribute.findUnique({
        where: { categoryId_attributeKey: { categoryId: cat.id, attributeKey: attr.key } },
      });
      if (!existingAttr) {
        await db.categoryAttribute.create({
          data: {
            categoryId: cat.id,
            attributeKey: attr.key,
            labelAr: attr.labelAr,
            labelEn: attr.labelEn,
            dataType: attr.type as never,
            isRequired: attr.required ?? false,
            isFilterable: attr.filterable ?? false,
            isSearchable: attr.searchable ?? false,
            optionsList: attr.options ? (attr.options as never) : undefined,
            validationRules: attr.rules ? (attr.rules as never) : undefined,
            displayOrder: attr.displayOrder ?? 0,
          },
        });
        attrCount++;
      }
    }

    // Recurse children
    for (const child of spec.children ?? []) {
      await upsertCategory(child, cat.id);
    }

    return cat.id;
  }

  for (const spec of CATEGORY_SPEC) {
    await upsertCategory(spec);
  }
  console.log(`  ✓ ${catCount} categories, ${attrCount} attributes (new)`);
}

async function main() {
  console.log('🌱 Starting seed...');
  await seedSettings();
  await seedExchangeRate();
  await seedAdmins();
  await seedPlaces();
  await seedCategories();
  console.log('✅ Seed complete');
}

main()
  .catch((e) => { console.error('Seed failed:', e); process.exit(1); })
  .finally(() => db.$disconnect());
