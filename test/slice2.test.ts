/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * SLICE 2 TESTS — Catalog, Media, Listings  (put this file at: test/slice2.test.ts)
 *
 * Written against the Slice 2 contract (see "CONTRACT" list in the chat message).
 * If a test fails, FIRST decide whether the code or the contract is wrong — do NOT
 * weaken an assertion just to get green. The privacy tests (no phone / no exact
 * coordinates / no EXIF) must never be relaxed.
 *
 * Isolation: the catalog (Category / CategoryAttribute / Place) is created once in
 * beforeAll and left alone; users, listings, media and settings are reset before
 * every test. Tests that MUTATE catalog data create their own categories.
 *
 * Fixtures (images, pdf, mp4 header) are generated in memory — no files needed.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import sharp from 'sharp';
import { randomBytes } from 'crypto';
import {
  app, db, clearTables, seedSettings,
  createTestUser, createAndLoginUser, createTestAdmin, loginAdmin,
} from './helpers';
import { settings } from '../src/shared/settings';
import { invalidateUserSessions } from '../src/shared/auth';

const API = '/api/v1';
const OK = [200, 201];
const PHONE = '+249912345678';
const PHONE_DIGITS = '912345678';

// ─── Lazy contract imports (clear error if a name differs) ───────────────────
async function scanFn(): Promise<(id: string) => Promise<unknown>> {
  const m: any = await import('../src/modules/listings/scan');
  if (typeof m.scanListing !== 'function') throw new Error('CONTRACT: src/modules/listings/scan.ts must export async scanListing(id)');
  return m.scanListing;
}
async function expireFn(): Promise<() => Promise<unknown>> {
  const m: any = await import('../src/modules/listings/service');
  if (typeof m.expireListings !== 'function') throw new Error('CONTRACT: src/modules/listings/service.ts must export async expireListings()');
  return m.expireListings;
}
async function orphanFn(): Promise<() => Promise<unknown>> {
  const m: any = await import('../src/modules/media/service');
  if (typeof m.cleanupOrphanMedia !== 'function') throw new Error('CONTRACT: src/modules/media/service.ts must export async cleanupOrphanMedia()');
  return m.cleanupOrphanMedia;
}

// ─── Small helpers ───────────────────────────────────────────────────────────
const rnd = () => `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));
const listOf = (b: any): any[] =>
  Array.isArray(b) ? b : (b?.data ?? b?.items ?? b?.categories ?? b?.states ?? b?.cities ?? b?.neighborhoods ?? b?.places ?? b?.countries ?? []);
const unwrap = (b: any) => b?.listing ?? b;
const pathOf = (u: string) => { const x = new URL(u, 'http://localhost'); return x.pathname + x.search; };
const attrKey = (a: any) => a.attributeKey ?? a.key;

function walk(nodes: any[], fn: (n: any) => void) {
  for (const n of nodes) { fn(n); if (Array.isArray(n.children)) walk(n.children, fn); }
}
function collectKeys(v: unknown, out: Set<string>) {
  if (Array.isArray(v)) v.forEach((x) => collectKeys(x, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.add(k); collectKeys(x, out); }
}
function haversineM(aLat: number, aLng: number, bLat: number, bLng: number) {
  const R = 6371000, rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(bLat - aLat), dLng = rad(bLng - aLng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function assertNoPhoneOrEmail(payload: unknown, ownerEmail: string) {
  const s = JSON.stringify(payload);
  expect(s, 'phone digits leaked').not.toContain(PHONE_DIGITS);
  expect(s, 'owner email leaked').not.toContain(ownerEmail);
  const keys = new Set<string>(); collectKeys(payload, keys);
  for (const k of ['phone', 'verifiedPhone', 'passwordHash', 'email', 'ownershipDocKey']) {
    expect(keys.has(k), `forbidden key "${k}" present in payload`).toBe(false);
  }
}

async function setS(key: string, value: unknown) {
  await settings.set(key, value, { type: 'SYSTEM', id: 'test' });
}

// ─── Fixtures (generated in memory) ──────────────────────────────────────────
async function jpeg(w = 800, h = 600, seed = 0): Promise<Buffer> {
  return sharp({ create: { width: w, height: h, channels: 3, background: { r: (seed * 37) % 255, g: 100, b: (seed * 91) % 255 } } }).jpeg().toBuffer();
}
async function noiseJpeg(w = 1500, h = 1500): Promise<Buffer> {
  return sharp(randomBytes(w * h * 3), { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
}
/** Inserts an APP1/EXIF segment that carries a GPS latitude after the SOI marker. */
function withGps(jpegBuf: Buffer): Buffer {
  const le16 = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
  const le32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
  const entry = (tag: number, type: number, count: number, value: Buffer) => Buffer.concat([le16(tag), le16(type), le32(count), value]);
  const header = Buffer.concat([Buffer.from([0x49, 0x49]), le16(42), le32(8)]);                 // 8 bytes
  const ifd0 = Buffer.concat([le16(1), entry(0x8825, 4, 1, le32(26)), le32(0)]);                // ends at 26
  const gps = Buffer.concat([
    le16(2),
    entry(1, 2, 2, Buffer.from([0x4e, 0x00, 0x00, 0x00])),                                      // 'N'
    entry(2, 5, 3, le32(56)),                                                                    // lat rationals @56
    le32(0),
  ]);                                                                                            // ends at 56
  const rationals = Buffer.concat([[15, 1], [30, 1], [0, 1]].map(([n, d]) => Buffer.concat([le32(n), le32(d)])));
  const tiff = Buffer.concat([header, ifd0, gps, rationals]);
  const payload = Buffer.concat([Buffer.from([0x45, 0x78, 0x69, 0x66, 0x00, 0x00]), tiff]);
  const len = Buffer.alloc(2); len.writeUInt16BE(payload.length + 2);
  const seg = Buffer.concat([Buffer.from([0xff, 0xe1]), len, payload]);
  return Buffer.concat([jpegBuf.subarray(0, 2), seg, jpegBuf.subarray(2)]);
}
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n');
function fakeMp4(totalBytes: number): Buffer {
  const head = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32, 0x00, 0x00, 0x00, 0x00, 0x6d, 0x70, 0x34, 0x32, 0x69, 0x73, 0x6f, 0x6d]);
  return Buffer.concat([head, Buffer.alloc(Math.max(0, totalBytes - head.length), 1)]);
}
const binary = (res: any, cb: (err: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};
const fetchFile = (url: string) => request(app).get(pathOf(url)).buffer(true).parse(binary as any);

// ─── Requests ────────────────────────────────────────────────────────────────
const upImg = (token: string, buf: Buffer, purpose = 'listing', name = 'a.jpg', mime = 'image/jpeg') =>
  request(app).post(`${API}/media/images`).query({ purpose }).set(auth(token)).attach('file', buf, { filename: name, contentType: mime });
const upDoc = (token: string, buf: Buffer = PDF, name = 'id.pdf', mime = 'application/pdf') =>
  request(app).post(`${API}/media/documents`).set(auth(token)).attach('file', buf, { filename: name, contentType: mime });
const upVideo = (token: string, buf: Buffer, query: Record<string, string> = {}) =>
  request(app).post(`${API}/media/video`).query(query).set(auth(token)).attach('file', buf, { filename: 'v.mp4', contentType: 'video/mp4' });
const createListing = (token: string, body: any, headers: Record<string, string> = {}) =>
  request(app).post(`${API}/listings`).set(auth(token)).set(headers).send(body);
const getListing = (idOrReadable: string, token?: string, headers: Record<string, string> = {}) => {
  const r = request(app).get(`${API}/listings/${idOrReadable}`).set(headers);
  return token ? r.set(auth(token)) : r;
};

// ─── Catalog fixture (created once) ──────────────────────────────────────────
let C: { root: any; cars: any; jobs: any; state: any; city: any; hood: any; archived: any };
const MAKES = [
  { value: 'toyota', labelEn: 'Toyota', labelAr: 'تويوتا' },
  { value: 'hyundai', labelEn: 'Hyundai', labelAr: 'هيونداي' },
];
const MODELS = [
  { value: 'corolla', labelEn: 'Corolla', labelAr: 'كورولا', dependsOn: { attr: 'make', value: 'toyota' } },
  { value: 'elantra', labelEn: 'Elantra', labelAr: 'النترا', dependsOn: { attr: 'make', value: 'hyundai' } },
];

async function mkCategory(data: Record<string, unknown>) {
  return db.category.create({ data: { nameEn: 'Test', nameAr: 'اختبار', displayOrder: 0, isActive: true, ...data } as never });
}
async function mkAttr(categoryId: string, key: string, dataType: string, extra: Record<string, unknown> = {}) {
  return db.categoryAttribute.create({
    data: { categoryId, attributeKey: key, labelEn: key, labelAr: key, dataType, isRequired: false, displayOrder: 0, ...extra } as never,
  });
}
/** A fresh car-like category (make + year) for tests that mutate the schema. */
async function mkCarCategory(extra: Record<string, unknown> = {}) {
  const cat = await mkCategory({ slug: `t-car-${rnd()}`, nameEn: 'Mutable Cars', nameAr: 'سيارات', parentId: C.root.id, ...extra });
  await mkAttr(cat.id, 'make', 'SINGLE_SELECT', { isRequired: true, optionsList: MAKES });
  await mkAttr(cat.id, 'year', 'NUMBER', { isRequired: true, validationRules: { min: 1980, max: 2030 } });
  return cat;
}

beforeAll(async () => {
  await clearTables(); // throws unless the DB name ends with _test
  await db.$executeRawUnsafe(`TRUNCATE "ListingView","ListingMedia","Listing","CategoryAttribute","Category","Place" RESTART IDENTITY CASCADE`);

  C = {} as any;
  C.root = await mkCategory({ slug: 't-vehicles', nameEn: 'Vehicles', nameAr: 'مركبات' });
  C.cars = await mkCategory({ slug: 't-cars', nameEn: 'Cars', nameAr: 'سيارات', parentId: C.root.id });
  C.jobs = await mkCategory({ slug: 't-jobs', nameEn: 'Jobs', nameAr: 'وظائف' });
  C.archived = await mkCategory({ slug: 't-archived', nameEn: 'Old', nameAr: 'قديم', isArchived: true });
  // root attribute inherited by Cars, and overridden by Cars (child wins)
  await mkAttr(C.root.id, 'condition', 'SINGLE_SELECT', { labelEn: 'Condition (root)', optionsList: [{ value: 'new', labelEn: 'New', labelAr: 'جديد' }, { value: 'used', labelEn: 'Used', labelAr: 'مستعمل' }] });
  await mkAttr(C.cars.id, 'condition', 'SINGLE_SELECT', { labelEn: 'Condition (cars)', optionsList: [{ value: 'new', labelEn: 'New', labelAr: 'جديد' }, { value: 'used', labelEn: 'Used', labelAr: 'مستعمل' }] });
  await mkAttr(C.cars.id, 'make', 'SINGLE_SELECT', { isRequired: true, isFilterable: true, isSearchable: true, optionsList: MAKES });
  await mkAttr(C.cars.id, 'model', 'SINGLE_SELECT', { isRequired: true, optionsList: MODELS });
  await mkAttr(C.cars.id, 'year', 'NUMBER', { isRequired: true, isFilterable: true, validationRules: { min: 1980, max: 2030 } });
  await mkAttr(C.cars.id, 'mileage', 'NUMBER', { validationRules: { min: 0 } });
  await mkAttr(C.cars.id, 'dutyPaid', 'BOOLEAN');
  await mkAttr(C.cars.id, 'features', 'MULTI_SELECT', { optionsList: [{ value: 'sunroof', labelEn: 'Sunroof', labelAr: 'فتحة' }, { value: 'leather', labelEn: 'Leather', labelAr: 'جلد' }] });

  C.state = await db.place.create({ data: { level: 'STATE', nameEn: 'Khartoum', nameAr: 'الخرطوم' } as never });
  C.city = await db.place.create({ data: { level: 'CITY', parentId: C.state.id, nameEn: 'Omdurman', nameAr: 'أم درمان' } as never });
  C.hood = await db.place.create({ data: { level: 'NEIGHBORHOOD', parentId: C.city.id, nameEn: 'Al Thawra', nameAr: 'الثورة' } as never });
});

beforeEach(async () => {
  await clearTables();
  await db.$executeRawUnsafe(`TRUNCATE "ListingView","ListingMedia","Listing" RESTART IDENTITY CASCADE`);
  settings.invalidate();
  await seedSettings();
});

// ─── User / listing builders ─────────────────────────────────────────────────
async function seller(opts: { phone?: boolean; caps?: string[]; fraudScore?: number } = {}) {
  const u = await createAndLoginUser({ email: `s_${rnd()}@test.com` });
  const data: any = {};
  if (opts.phone !== false) data.phone = PHONE;
  if (opts.caps) data.capabilities = { set: opts.caps };
  if (opts.fraudScore !== undefined) data.fraudScore = opts.fraudScore;
  if (Object.keys(data).length) {
    await db.user.update({ where: { id: u.user.id }, data });
    invalidateUserSessions(u.user.id);
  }
  return u;
}
const buyer = () => createAndLoginUser({ email: `b_${rnd()}@test.com` });
async function adminToken(role: 'SUPER_ADMIN' | 'CONTENT_MODERATOR' = 'SUPER_ADMIN') {
  const a = await createTestAdmin(role);
  const t = await loginAdmin(a.email);
  return t.accessToken;
}
function listingBody(over: Record<string, unknown> = {}) {
  return {
    categoryId: C.cars.id,
    listingType: 'SALE',
    title: 'Toyota Corolla 2015 clean car',
    description: 'Well maintained Toyota Corolla, single owner, full service history, ready to drive anywhere in Khartoum.',
    price: 5000, currency: 'USD', isNegotiable: true,
    cityId: C.city.id, lat: 15.123457, lng: 32.654321, locationName: 'Omdurman', isApproxLocation: false,
    contactOptions: { call: true, whatsapp: true, chat: true },
    dynamicAttributes: { make: 'toyota', model: 'corolla', year: 2015 },
    isCustomOther: false, mediaIds: [] as string[], status: 'PUBLISH',
    ...over,
  };
}
async function publish(token: string, over: Record<string, unknown> = {}) {
  const r = await createListing(token, listingBody(over));
  expect(OK, `create failed: ${JSON.stringify(r.body)}`).toContain(r.status);
  return unwrap(r.body);
}
const dbListing = (id: string) => db.listing.findUnique({ where: { id } });

// ═════════════════════════════════════════════════════════════════════════════
// CATALOG
// ═════════════════════════════════════════════════════════════════════════════
describe('Catalog: categories tree', () => {
  it('GET /categories returns the tree with an ETag and 304 on revalidation', async () => {
    const r1 = await request(app).get(`${API}/categories`);
    expect(r1.status).toBe(200);
    expect(r1.headers.etag).toBeTruthy();
    const slugs: string[] = [];
    walk(listOf(r1.body), (n) => slugs.push(n.slug));
    expect(slugs).toContain('t-vehicles');
    expect(slugs).toContain('t-cars');
    const r2 = await request(app).get(`${API}/categories`).set('If-None-Match', r1.headers.etag);
    expect(r2.status).toBe(304);
  });

  it('appends the virtual OTHER option to every non-empty children list', async () => {
    const r = await request(app).get(`${API}/categories`);
    let checked = 0;
    walk(listOf(r.body), (n) => {
      const real = (n.children ?? []).filter((c: any) => c.id !== 'OTHER');
      if (real.length > 0) {
        const other = n.children.find((c: any) => c.id === 'OTHER');
        expect(other, `OTHER missing under ${n.slug}`).toBeTruthy();
        expect(other.isOther).toBe(true);
        expect(other.nameAr).toBe('أخرى');
        checked++;
      }
    });
    expect(checked).toBeGreaterThan(0);
  });

  it('hides archived categories', async () => {
    const r = await request(app).get(`${API}/categories`);
    const slugs: string[] = [];
    walk(listOf(r.body), (n) => slugs.push(n.slug));
    expect(slugs).not.toContain('t-archived');
  });

  it('GET /categories/:id returns breadcrumbs root → cars', async () => {
    const r = await request(app).get(`${API}/categories/${C.cars.id}`);
    expect(r.status).toBe(200);
    const crumbs = r.body.breadcrumbs ?? [];
    expect(crumbs.length).toBeGreaterThanOrEqual(2);
    expect(crumbs[crumbs.length - 1].id ?? crumbs[crumbs.length - 1].slug).toBeTruthy();
  });

  it('unknown category → 404', async () => {
    const r = await request(app).get(`${API}/categories/00000000-0000-0000-0000-000000000000`);
    expect(r.status).toBe(404);
  });
});

describe('Catalog: schema endpoint', () => {
  it('returns attributes incl. inherited, child override wins, ETag + 304', async () => {
    const r = await request(app).get(`${API}/categories/${C.cars.id}/schema`);
    expect(r.status).toBe(200);
    expect(r.headers.etag).toBeTruthy();
    expect(typeof r.body.version).toBe('number');
    const attrs: any[] = r.body.attributes;
    const keys = attrs.map(attrKey);
    for (const k of ['make', 'model', 'year', 'mileage', 'dutyPaid', 'features', 'condition']) expect(keys).toContain(k);
    const cond = attrs.filter((a) => attrKey(a) === 'condition');
    expect(cond).toHaveLength(1);
    expect(cond[0].labelEn).toBe('Condition (cars)');
    const r2 = await request(app).get(`${API}/categories/${C.cars.id}/schema`).set('If-None-Match', r.headers.etag);
    expect(r2.status).toBe(304);
  });

  it('schema of unknown category → 404', async () => {
    const r = await request(app).get(`${API}/categories/00000000-0000-0000-0000-000000000000/schema`);
    expect(r.status).toBe(404);
  });
});

describe('Catalog: geo + countries', () => {
  it('lists states → cities → neighborhoods', async () => {
    const s = await request(app).get(`${API}/geo/states`);
    expect(s.status).toBe(200);
    expect(listOf(s.body).map((x) => x.id)).toContain(C.state.id);
    const c = await request(app).get(`${API}/geo/states/${C.state.id}/cities`);
    expect(c.status).toBe(200);
    expect(listOf(c.body).map((x) => x.id)).toContain(C.city.id);
    const n = await request(app).get(`${API}/geo/cities/${C.city.id}/neighborhoods`);
    expect(n.status).toBe(200);
    expect(listOf(n.body).map((x) => x.id)).toContain(C.hood.id);
  });

  it('GET /countries includes Sudan', async () => {
    const r = await request(app).get(`${API}/countries`);
    expect(r.status).toBe(200);
    expect(listOf(r.body).map((x) => x.code)).toContain('SD');
  });
});

describe('Catalog: admin changes bump schema versions', () => {
  it('adding an attribute bumps version/ETag, appears in schema, and bumps descendants', async () => {
    const admin = await adminToken();
    const parent = await mkCategory({ slug: `t-p-${rnd()}` });
    const child = await mkCategory({ slug: `t-c-${rnd()}`, parentId: parent.id });
    const before = await request(app).get(`${API}/categories/${child.id}/schema`);
    expect(before.status).toBe(200);

    const add = await request(app).post(`${API}/admin/categories/${parent.id}/attributes`).set(auth(admin))
      .send({ attributeKey: 'newattr', labelEn: 'New', labelAr: 'جديد', dataType: 'TEXT', isRequired: false });
    expect(OK, JSON.stringify(add.body)).toContain(add.status);

    const after = await request(app).get(`${API}/categories/${child.id}/schema`).set('If-None-Match', before.headers.etag);
    expect(after.status).toBe(200); // old ETag no longer valid
    expect(after.body.version).toBeGreaterThan(before.body.version);
    expect(after.body.attributes.map(attrKey)).toContain('newattr');
  });

  it('archived attribute: hidden in schema, visible with includeArchived, still accepted on existing listing, rejected on new', async () => {
    const admin = await adminToken();
    const cat = await mkCarCategory();
    const extra = await mkAttr(cat.id, 'extra', 'TEXT');
    const u = await seller();
    const body = (over: Record<string, unknown> = {}) => listingBody({ categoryId: cat.id, dynamicAttributes: { make: 'toyota', year: 2015, extra: 'hello' }, ...over });
    const created = unwrap((await createListing(u.accessToken, body())).body);
    expect(created.id).toBeTruthy();

    const arch = await request(app).post(`${API}/admin/categories/${cat.id}/attributes/${extra.id}/archive`).set(auth(admin));
    expect(OK, JSON.stringify(arch.body)).toContain(arch.status);

    const schema = await request(app).get(`${API}/categories/${cat.id}/schema`);
    expect(schema.body.attributes.map(attrKey)).not.toContain('extra');
    const withArchived = await request(app).get(`${API}/categories/${cat.id}/schema`).query({ includeArchived: 'true' });
    expect(withArchived.body.attributes.map(attrKey)).toContain('extra');

    const edit = await request(app).patch(`${API}/listings/${created.id}`).set(auth(u.accessToken)).send({ title: 'Edited title still fine' });
    expect(edit.status, JSON.stringify(edit.body)).toBe(200);
    expect((await dbListing(created.id))!.dynamicAttributes).toMatchObject({ extra: 'hello' });

    const fresh = await createListing(u.accessToken, body({ title: 'Brand new listing with archived key' }));
    expect(fresh.status).toBe(400);
  });

  it('making an attribute required does not break editing an old listing, but new listings need it', async () => {
    const admin = await adminToken();
    const cat = await mkCarCategory();
    const color = await mkAttr(cat.id, 'color', 'TEXT');
    const u = await seller();
    const old = unwrap((await createListing(u.accessToken, listingBody({ categoryId: cat.id, dynamicAttributes: { make: 'toyota', year: 2015 } }))).body);

    const patch = await request(app).patch(`${API}/admin/categories/${cat.id}/attributes/${color.id}`).set(auth(admin)).send({ isRequired: true });
    expect(OK, JSON.stringify(patch.body)).toContain(patch.status);

    const edit = await request(app).patch(`${API}/listings/${old.id}`).set(auth(u.accessToken)).send({ title: 'Old listing edited after change' });
    expect(edit.status, JSON.stringify(edit.body)).toBe(200);

    const fresh = await createListing(u.accessToken, listingBody({ categoryId: cat.id, title: 'New listing without color', dynamicAttributes: { make: 'toyota', year: 2015 } }));
    expect(fresh.status).toBe(400);
  });

  it('admin can restrict posting in a category; create → 422 CATEGORY_POSTING_DISABLED; restore works', async () => {
    const admin = await adminToken();
    const cat = await mkCarCategory();
    const u = await seller();
    const lock = await request(app).patch(`${API}/admin/categories/${cat.id}`).set(auth(admin)).send({ postingRestricted: true, postingMessage: 'Closed for now' });
    expect(OK, JSON.stringify(lock.body)).toContain(lock.status);

    const blocked = await createListing(u.accessToken, listingBody({ categoryId: cat.id, dynamicAttributes: { make: 'toyota', year: 2015 } }));
    expect(blocked.status).toBe(422);
    expect(blocked.body.error.code).toBe('CATEGORY_POSTING_DISABLED');
    const schema = await request(app).get(`${API}/categories/${cat.id}/schema`);
    expect(schema.body.postingRestricted).toBe(true);

    await request(app).patch(`${API}/admin/categories/${cat.id}`).set(auth(admin)).send({ postingRestricted: false });
    const ok = await createListing(u.accessToken, listingBody({ categoryId: cat.id, dynamicAttributes: { make: 'toyota', year: 2015 } }));
    expect(OK).toContain(ok.status);
  });

  it('RBAC: no token 401, customer token 401, moderator 403 on attribute create', async () => {
    const cat = await mkCarCategory();
    const body = { attributeKey: 'zzz', labelEn: 'Z', labelAr: 'ز', dataType: 'TEXT', isRequired: false };
    const url = `${API}/admin/categories/${cat.id}/attributes`;
    expect((await request(app).post(url).send(body)).status).toBe(401);
    const c = await buyer();
    expect((await request(app).post(url).set(auth(c.accessToken)).send(body)).status).toBe(401);
    const mod = await adminToken('CONTENT_MODERATOR');
    expect((await request(app).post(url).set(auth(mod)).send(body)).status).toBe(403);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// MEDIA
// ═════════════════════════════════════════════════════════════════════════════
describe('Media: images', () => {
  it('converts to webp, caps size, creates a 400px thumb, strips EXIF/GPS', async () => {
    const u = await seller();
    const input = withGps(await jpeg(2400, 1600, 1));
    const pre = await sharp(input).metadata();
    expect(pre.exif, 'test fixture EXIF was not readable — fixture bug').toBeTruthy();

    const r = await upImg(u.accessToken, input);
    expect(OK, JSON.stringify(r.body)).toContain(r.status);
    expect(r.body.id).toBeTruthy();
    expect(typeof r.body.url).toBe('string');
    expect(typeof r.body.thumbs?.m).toBe('string');

    const main = await fetchFile(r.body.url);
    expect(main.status).toBe(200);
    const buf = main.body as Buffer;
    const meta = await sharp(buf).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.width!).toBeLessThanOrEqual(1920);
    expect(meta.exif, 'EXIF must be stripped').toBeUndefined();
    expect(buf.includes(Buffer.from('EXIF'))).toBe(false);
    expect(buf.includes(Buffer.from('GPS'))).toBe(false);

    const thumb = await fetchFile(r.body.thumbs.m);
    expect(thumb.status).toBe(200);
    expect((await sharp(thumb.body as Buffer).metadata()).width!).toBeLessThanOrEqual(400);

    const asset = await db.mediaAsset.findUnique({ where: { id: r.body.id } });
    expect(asset!.attachedAt).toBeNull();
    expect(asset!.kind).toBe('IMAGE');
    expect(asset!.isPrivate).toBe(false);
    expect((asset as any).sha256).toBeTruthy();
  });

  it('accepts png and webp inputs', async () => {
    const u = await seller();
    const png = await sharp({ create: { width: 300, height: 300, channels: 3, background: '#336699' } }).png().toBuffer();
    const webp = await sharp({ create: { width: 300, height: 300, channels: 3, background: '#993366' } }).webp().toBuffer();
    expect(OK).toContain((await upImg(u.accessToken, png, 'listing', 'a.png', 'image/png')).status);
    expect(OK).toContain((await upImg(u.accessToken, webp, 'listing', 'a.webp', 'image/webp')).status);
  });

  it('rejects oversize images (media.photo.maxMB) with FILE_TOO_LARGE', async () => {
    await setS('media.photo.maxMB', 1);
    const u = await seller();
    const big = await noiseJpeg();
    expect(big.length).toBeGreaterThan(1024 * 1024);
    const r = await upImg(u.accessToken, big);
    expect([400, 413, 422]).toContain(r.status);
    expect(r.body.error.code).toBe('FILE_TOO_LARGE');
  });

  it('rejects a text file renamed .jpg (magic-byte check), never 500', async () => {
    const u = await seller();
    const r = await upImg(u.accessToken, Buffer.from('this is definitely not an image'), 'listing', 'fake.jpg', 'image/jpeg');
    expect([400, 415, 422]).toContain(r.status);
    expect(r.body.error?.code).toBeTruthy();
  });

  it('requires auth and a file', async () => {
    const u = await seller();
    expect((await request(app).post(`${API}/media/images`).attach('file', await jpeg(), 'a.jpg')).status).toBe(401);
    const none = await request(app).post(`${API}/media/images`).set(auth(u.accessToken));
    expect(none.status).toBe(400);
  });

  it('avatar upload can be attached through PATCH /me avatarMediaId', async () => {
    const u = await seller();
    const up = await upImg(u.accessToken, await jpeg(400, 400, 5), 'avatar');
    expect(OK).toContain(up.status);
    const patch = await request(app).patch(`${API}/me`).set(auth(u.accessToken)).send({ avatarMediaId: up.body.id });
    expect(patch.status, JSON.stringify(patch.body)).toBe(200);
    const row = await db.user.findUnique({ where: { id: u.user.id } });
    expect(row!.avatarUrl).toBe(up.body.url);
    expect((await db.mediaAsset.findUnique({ where: { id: up.body.id } }))!.attachedAt).not.toBeNull();
  });
});

describe('Media: private documents', () => {
  it('stores privately, is unreachable by path, reachable only through an owner signed link', async () => {
    const owner = await seller();
    const other = await buyer();
    const up = await upDoc(owner.accessToken);
    expect(OK, JSON.stringify(up.body)).toContain(up.status);
    expect(up.body.id).toBeTruthy();
    expect(up.body.key).toBeTruthy();
    const asset = await db.mediaAsset.findUnique({ where: { id: up.body.id } });
    expect(asset!.isPrivate).toBe(true);
    expect(asset!.kind).toBe('DOC');

    expect((await request(app).get(`/files/${up.body.key}`)).status).toBe(404);
    expect((await request(app).get(`/files/private/${up.body.key}`)).status).toBe(404);
    expect([400, 403, 404]).toContain((await request(app).get('/media/private/not-a-valid-token')).status);

    const signed = await request(app).get(`${API}/media/signed-url`).query({ mediaId: up.body.id }).set(auth(owner.accessToken));
    expect(signed.status, JSON.stringify(signed.body)).toBe(200);
    const file = await fetchFile(signed.body.url);
    expect(file.status).toBe(200);
    expect((file.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');

    const denied = await request(app).get(`${API}/media/signed-url`).query({ mediaId: up.body.id }).set(auth(other.accessToken));
    expect([403, 404]).toContain(denied.status);
    expect((await request(app).get(`${API}/media/signed-url`).query({ mediaId: up.body.id })).status).toBe(401);
  });

  it('rejects a non-document disguised as pdf', async () => {
    const u = await seller();
    const r = await upDoc(u.accessToken, Buffer.from('MZ not a pdf at all'), 'x.pdf', 'application/pdf');
    expect([400, 415, 422]).toContain(r.status);
  });

  it('verification request works end-to-end with real document media', async () => {
    const u = await seller();
    const doc = await upDoc(u.accessToken);
    const r = await request(app).post(`${API}/me/verification`).set(auth(u.accessToken)).send({ kind: 'USER', documentMediaIds: [doc.body.id] });
    expect(OK, JSON.stringify(r.body)).toContain(r.status);
  });
});

describe('Media: video limits', () => {
  it('flag off → VIDEO_DISABLED', async () => {
    await setS('flags.video.enabled', false);
    const u = await seller();
    const r = await upVideo(u.accessToken, fakeMp4(2000));
    expect(r.body.error?.code).toBe('VIDEO_DISABLED');
  });

  it('category in media.video.disabledCategoryIds → VIDEO_DISABLED', async () => {
    await setS('media.video.disabledCategoryIds', [C.cars.id]);
    const u = await seller();
    const r = await upVideo(u.accessToken, fakeMp4(2000), { categoryId: C.cars.id });
    expect(r.body.error?.code).toBe('VIDEO_DISABLED');
  });

  it('over media.video.maxMB → VIDEO_TOO_LARGE', async () => {
    await setS('media.video.maxMB', 0.001);
    const u = await seller();
    const r = await upVideo(u.accessToken, fakeMp4(20_000));
    expect([400, 413, 422]).toContain(r.status);
    expect(r.body.error?.code).toBe('VIDEO_TOO_LARGE');
  });

  it('garbage bytes that look like mp4 never cause a 500', async () => {
    const u = await seller();
    const r = await upVideo(u.accessToken, fakeMp4(3000));
    expect(r.status).toBeLessThan(500);
  });
});

describe('Media: delete + orphan cleanup', () => {
  it('owner can delete unattached media; others cannot; attached media → 409 MEDIA_IN_USE', async () => {
    const a = await seller(), b = await buyer();
    const m1 = (await upImg(a.accessToken, await jpeg(500, 400, 11))).body;
    expect([403, 404]).toContain((await request(app).delete(`${API}/media/${m1.id}`).set(auth(b.accessToken))).status);
    const del = await request(app).delete(`${API}/media/${m1.id}`).set(auth(a.accessToken));
    expect([200, 204]).toContain(del.status);
    expect(await db.mediaAsset.findUnique({ where: { id: m1.id } })).toBeNull();

    const m2 = (await upImg(a.accessToken, await jpeg(500, 400, 12))).body;
    await publish(a.accessToken, { mediaIds: [m2.id], coverMediaId: m2.id });
    const inUse = await request(app).delete(`${API}/media/${m2.id}`).set(auth(a.accessToken));
    expect(inUse.status).toBe(409);
    expect(inUse.body.error.code).toBe('MEDIA_IN_USE');
  });

  it('cleanup removes unattached assets older than 24h only (and tolerates missing files)', async () => {
    const u = await seller();
    const old = new Date(Date.now() - 25 * 3600 * 1000);
    const mk = (attachedAt: Date | null, createdAt: Date) => db.mediaAsset.create({
      data: { ownerId: u.user.id, kind: 'IMAGE', key: `test/${rnd()}.webp`, sizeBytes: 1, mime: 'image/webp', attachedAt, createdAt } as never,
    });
    const oldOrphan = await mk(null, old);
    const oldAttached = await mk(new Date(), old);
    const freshOrphan = await mk(null, new Date());
    await (await orphanFn())();
    expect(await db.mediaAsset.findUnique({ where: { id: oldOrphan.id } })).toBeNull();
    expect(await db.mediaAsset.findUnique({ where: { id: oldAttached.id } })).not.toBeNull();
    expect(await db.mediaAsset.findUnique({ where: { id: freshOrphan.id } })).not.toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// LISTINGS — create / validate
// ═════════════════════════════════════════════════════════════════════════════
describe('Listings: create + validation', () => {
  it('publishes, returns readableId + shareUrl, sets expiry ≈ 30 days, quality score > 0', async () => {
    const u = await seller();
    const l = await publish(u.accessToken);
    expect(l.readableId).toMatch(/^MARBOU-\d{5,}$/);
    expect(l.shareUrl).toContain(l.readableId);
    const row = (await dbListing(l.id))!;
    expect(row.status).toBe('ACTIVE');
    expect(row.publishedAt).not.toBeNull();
    const days = (row.expiresAt!.getTime() - Date.now()) / 86400000;
    expect(days).toBeGreaterThan(29);
    expect(days).toBeLessThan(31);
    expect(row.qualityScore).toBeGreaterThan(0);
  });

  it('can be fetched by UUID and by readable ID; malformed id → 404 (not 500)', async () => {
    const u = await seller();
    const l = await publish(u.accessToken);
    const byId = await getListing(l.id);
    const byReadable = await getListing(l.readableId);
    expect(byId.status).toBe(200);
    expect(byReadable.status).toBe(200);
    expect(byReadable.body.id).toBe(l.id);
    expect((await getListing('not-an-id')).status).toBe(404);
  });

  it('requires auth (401) and a verified email (403 EMAIL_NOT_VERIFIED)', async () => {
    expect((await request(app).post(`${API}/listings`).send(listingBody())).status).toBe(401);
    const { email, password } = await createTestUser({ email: `u_${rnd()}@test.com`, verified: false });
    const login = await request(app).post(`${API}/auth/login`).send({ email, password, device: { id: 'd', name: 'd', os: 'test' } });
    const r = await createListing(login.body.accessToken, listingBody());
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('EMAIL_NOT_VERIFIED');
  });

  it('validation: missing required attr, wrong type, unknown key, below min, bad dependsOn → 400', async () => {
    const u = await seller();
    const bad = async (dynamicAttributes: Record<string, unknown>, title: string) => {
      const r = await createListing(u.accessToken, listingBody({ dynamicAttributes, title }));
      expect(r.status, `${title}: ${JSON.stringify(r.body)}`).toBe(400);
    };
    await bad({ make: 'toyota', model: 'corolla' }, 'Car missing the required year');
    await bad({ make: 'toyota', model: 'corolla', year: 'abc' }, 'Car with year as text value');
    await bad({ make: 'toyota', model: 'corolla', year: 2015, bogus: 1 }, 'Car with unknown attribute key');
    await bad({ make: 'toyota', model: 'corolla', year: 1900 }, 'Car with year below minimum');
    await bad({ make: 'toyota', model: 'elantra', year: 2015 }, 'Car with model not matching make');
    await bad({ make: 'nope', model: 'corolla', year: 2015 }, 'Car with invalid make option');
  });

  it('price rules: SALE needs price; bad currency / negative price rejected; WANTED uses budget', async () => {
    const u = await seller();
    expect((await createListing(u.accessToken, listingBody({ price: undefined, title: 'Sale without any price' }))).status).toBe(400);
    expect((await createListing(u.accessToken, listingBody({ currency: 'EUR', title: 'Sale in euro currency' }))).status).toBe(400);
    expect((await createListing(u.accessToken, listingBody({ price: -5, title: 'Sale with negative price' }))).status).toBe(400);
    const wanted = await createListing(u.accessToken, listingBody({ listingType: 'WANTED', price: undefined, budgetMin: 3000, budgetMax: 6000, title: 'Looking for a Toyota Corolla' }));
    expect(OK, JSON.stringify(wanted.body)).toContain(wanted.status);
  });

  it('custom "Other": needs text, stores it', async () => {
    const u = await seller();
    const missing = await createListing(u.accessToken, listingBody({ isCustomOther: true, title: 'Custom other without the text' }));
    expect(missing.status).toBe(400);
    const l = await publish(u.accessToken, { isCustomOther: true, customOtherText: 'Hover car', title: 'Custom other with the text' });
    const row = await dbListing(l.id);
    expect(row!.isCustomOther).toBe(true);
    expect(row!.customOtherText).toBe('Hover car');
  });

  it('sanitizes HTML in free text', async () => {
    const u = await seller();
    const l = await publish(u.accessToken, { title: '<b>Hi</b><script>alert(1)</script> Toyota Corolla', description: '<img src=x onerror=alert(1)>Clean description of the car that is long enough to pass.' });
    const row = (await dbListing(l.id))!;
    expect(row.title).not.toContain('<');
    expect(row.description).not.toContain('<');
  });

  it('draft → not visible to others → publish → visible', async () => {
    const u = await seller(), b = await buyer();
    const d = await publish(u.accessToken, { status: 'DRAFT' });
    expect((await dbListing(d.id))!.status).toBe('DRAFT');
    expect((await getListing(d.id, b.accessToken)).status).toBe(404);
    expect((await getListing(d.id)).status).toBe(404);
    expect((await getListing(d.id, u.accessToken)).status).toBe(200);
    const pub = await request(app).post(`${API}/listings/${d.id}/publish`).set(auth(u.accessToken));
    expect(OK, JSON.stringify(pub.body)).toContain(pub.status);
    expect((await dbListing(d.id))!.status).toBe('ACTIVE');
    expect((await getListing(d.id, b.accessToken)).status).toBe(200);
  });

  it('JOB listings need the EMPLOYER capability; price optional for jobs', async () => {
    const jobBody = (title: string) => listingBody({ categoryId: C.jobs.id, listingType: 'JOB', price: undefined, dynamicAttributes: {}, title, description: 'We need an experienced driver for our company in Khartoum, full time position, good salary.' });
    const plain = await seller();
    const denied = await createListing(plain.accessToken, jobBody('Driver wanted urgently now'));
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('CAPABILITY_REQUIRED');
    const employer = await seller({ caps: ['EMPLOYER'] });
    const ok = await createListing(employer.accessToken, jobBody('Driver wanted urgently now'));
    expect(OK, JSON.stringify(ok.body)).toContain(ok.status);
  });

  it('quality-preview scores richer input higher and saves nothing', async () => {
    const u = await seller();
    const poor = await request(app).post(`${API}/listings/quality-preview`).set(auth(u.accessToken))
      .send(listingBody({ title: 'Car', description: 'x', cityId: undefined, lat: undefined, lng: undefined }));
    const rich = await request(app).post(`${API}/listings/quality-preview`).set(auth(u.accessToken)).send(listingBody());
    expect(poor.status).toBe(200);
    expect(rich.status).toBe(200);
    const score = (b: any) => b.qualityScore ?? b.score;
    expect(typeof score(rich.body)).toBe('number');
    expect(score(rich.body)).toBeGreaterThan(score(poor.body));
    expect(await db.listing.count()).toBe(0);
  });
});

describe('Listings: media attachment', () => {
  it('attaches owned media, cover first, marks assets attached', async () => {
    const u = await seller();
    const a = (await upImg(u.accessToken, await jpeg(600, 400, 21))).body;
    const b = (await upImg(u.accessToken, await jpeg(600, 400, 22))).body;
    const l = await publish(u.accessToken, { mediaIds: [a.id, b.id], coverMediaId: b.id });
    const detail = await getListing(l.id);
    expect(detail.body.media).toHaveLength(2);
    expect(detail.body.media[0].url).toBe(b.url);
    expect(await db.listingMedia.count({ where: { listingId: l.id } })).toBe(2);
    expect((await db.mediaAsset.findUnique({ where: { id: a.id } }))!.attachedAt).not.toBeNull();
  });

  it("rejects someone else's media and too many photos", async () => {
    const a = await seller(), b = await seller();
    const foreign = (await upImg(a.accessToken, await jpeg(600, 400, 23))).body;
    const r = await createListing(b.accessToken, listingBody({ mediaIds: [foreign.id], title: 'Listing using foreign media' }));
    expect([400, 403, 404, 422]).toContain(r.status);
    expect(await db.listing.count({ where: { ownerId: b.user.id } })).toBe(0);

    await setS('media.maxPhotos', 2);
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await upImg(a.accessToken, await jpeg(500, 400, 30 + i))).body.id);
    const many = await createListing(a.accessToken, listingBody({ mediaIds: ids, title: 'Listing with too many photos' }));
    expect([400, 422]).toContain(many.status);
  });

  it('duplicate creates a DRAFT copy with its own media rows', async () => {
    const u = await seller();
    const a = (await upImg(u.accessToken, await jpeg(600, 400, 41))).body;
    const b = (await upImg(u.accessToken, await jpeg(600, 400, 42))).body;
    const l = await publish(u.accessToken, { mediaIds: [a.id, b.id], coverMediaId: a.id });
    const dup = await request(app).post(`${API}/listings/${l.id}/duplicate`).set(auth(u.accessToken));
    expect(OK, JSON.stringify(dup.body)).toContain(dup.status);
    const copy = unwrap(dup.body);
    expect(copy.id).not.toBe(l.id);
    expect((await dbListing(copy.id))!.status).toBe('DRAFT');
    expect(await db.listingMedia.count({ where: { listingId: copy.id } })).toBe(2);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// LISTINGS — caps and rate limits (Vitest rule #3)
// ═════════════════════════════════════════════════════════════════════════════
describe('Listings: caps and rate limits', () => {
  it('active-listing cap → 422 LISTING_CAP_REACHED', async () => {
    await setS('limits.activeListingsIndividual', 2);
    const u = await seller();
    await publish(u.accessToken, { title: 'First listing under the cap' });
    await publish(u.accessToken, { title: 'Second listing under the cap' });
    const r = await createListing(u.accessToken, listingBody({ title: 'Third listing over the cap' }));
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('LISTING_CAP_REACHED');
  });

  it('hourly limit is checked at PUBLISH time (drafts do not count) → 422 LISTING_RATE_LIMIT', async () => {
    await setS('limits.activeListingsIndividual', 100);
    await setS('limits.listingsPerHour', 2);
    const u = await seller();
    const drafts: any[] = [];
    for (let i = 0; i < 3; i++) drafts.push(await publish(u.accessToken, { status: 'DRAFT', title: `Draft number ${i} for the rate test` }));
    const pub = (id: string) => request(app).post(`${API}/listings/${id}/publish`).set(auth(u.accessToken));
    expect(OK).toContain((await pub(drafts[0].id)).status);
    expect(OK).toContain((await pub(drafts[1].id)).status);
    const third = await pub(drafts[2].id);
    expect(third.status).toBe(422);
    expect(third.body.error.code).toBe('LISTING_RATE_LIMIT');
  });

  it('daily limit → 422 LISTING_RATE_LIMIT', async () => {
    await setS('limits.activeListingsIndividual', 100);
    await setS('limits.listingsPerHour', 100);
    await setS('limits.listingsPerDay', 2);
    const u = await seller();
    await publish(u.accessToken, { title: 'Daily limit listing one' });
    await publish(u.accessToken, { title: 'Daily limit listing two' });
    const r = await createListing(u.accessToken, listingBody({ title: 'Daily limit listing three' }));
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('LISTING_RATE_LIMIT');
  });

  it('fraudScore >= 80 halves the rate limits', async () => {
    await setS('limits.activeListingsIndividual', 100);
    await setS('limits.listingsPerHour', 4);
    const u = await seller({ fraudScore: 85 });
    await publish(u.accessToken, { title: 'Risky account listing one' });
    await publish(u.accessToken, { title: 'Risky account listing two' });
    const r = await createListing(u.accessToken, listingBody({ title: 'Risky account listing three' }));
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('LISTING_RATE_LIMIT');
  });

  it('parallel publishes at cap-1 → exactly one succeeds (no race)', async () => {
    await setS('limits.activeListingsIndividual', 2);
    await setS('limits.listingsPerHour', 100);
    await setS('limits.listingsPerDay', 100);
    const u = await seller();
    await publish(u.accessToken, { title: 'Seed listing below the cap' });
    const rs = await Promise.all([1, 2, 3].map((i) => createListing(u.accessToken, listingBody({ title: `Racing listing number ${i} here` }))));
    const ok = rs.filter((r) => OK.includes(r.status));
    const rejected = rs.filter((r) => r.status === 422);
    expect(ok).toHaveLength(1);
    expect(rejected).toHaveLength(2);
    rejected.forEach((r) => expect(r.body.error.code).toBe('LISTING_CAP_REACHED'));
    expect(await db.listing.count({ where: { ownerId: u.user.id, status: { in: ['ACTIVE', 'PENDING_REVIEW'] } } })).toBe(2);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// LISTINGS — PRIVACY (never relax these)
// ═════════════════════════════════════════════════════════════════════════════
describe('Listings: privacy', () => {
  it('approx location never leaks exact lat/lng publicly; jitter is deterministic and within radius', async () => {
    const u = await seller(), b = await buyer();
    const l = await publish(u.accessToken, { isApproxLocation: true, approxRadiusM: 500 });
    const guest = await getListing(l.id);
    const buy = await getListing(l.id, b.accessToken);
    const guestAgain = await getListing(l.id);

    for (const res of [guest, buy]) {
      expect(res.status).toBe(200);
      const s = JSON.stringify(res.body);
      expect(s, 'exact latitude leaked').not.toContain('15.123457');
      expect(s, 'exact longitude leaked').not.toContain('32.654321');
      const keys = new Set<string>(); collectKeys(res.body, keys);
      expect(keys.has('lat')).toBe(false);
      expect(keys.has('lng')).toBe(false);
      expect(typeof res.body.pubLat).toBe('number');
      expect(typeof res.body.pubLng).toBe('number');
      expect(haversineM(15.123457, 32.654321, res.body.pubLat, res.body.pubLng)).toBeLessThanOrEqual(520);
    }
    expect(guestAgain.body.pubLat).toBe(guest.body.pubLat);
    expect(guestAgain.body.pubLng).toBe(guest.body.pubLng);

    const row = (await dbListing(l.id))!;
    expect(row.lat).toBeCloseTo(15.123457, 5);
    expect(row.pubLat).not.toBe(row.lat);

    const owner = await getListing(l.id, u.accessToken);
    expect(JSON.stringify(owner.body)).toContain('15.123457'); // the owner may see exact coordinates
  });

  it('non-approx listings publish exact coordinates as pubLat/pubLng', async () => {
    const u = await seller();
    const l = await publish(u.accessToken, { isApproxLocation: false });
    const res = await getListing(l.id);
    expect(res.body.pubLat).toBeCloseTo(15.123457, 5);
    expect(res.body.pubLng).toBeCloseTo(32.654321, 5);
  });

  it('no payload ever contains the owner phone or email', async () => {
    const u = await seller(), b = await buyer();
    const created = await createListing(u.accessToken, listingBody({ isApproxLocation: true, approxRadiusM: 300 }));
    const l = unwrap(created.body);
    const payloads = [
      created.body,
      (await getListing(l.id)).body,
      (await getListing(l.readableId, b.accessToken)).body,
      (await getListing(l.id, u.accessToken)).body,
      (await request(app).get(`${API}/me/listings`).set(auth(u.accessToken))).body,
      (await request(app).get(`${API}/users/${u.user.id}`)).body,
    ];
    payloads.forEach((p) => assertNoPhoneOrEmail(p, u.email));
  });

  it('phone appears ONLY in the contact-reveal response, and never in analytics events', async () => {
    const u = await seller();
    const l = await publish(u.accessToken);
    const reveal = await request(app).post(`${API}/listings/${l.id}/contact-reveal`).set('X-Device-Id', 'priv-1').send({ channel: 'CALL' });
    expect(reveal.status).toBe(200);
    expect(reveal.body.phone).toBe(PHONE);
    await getListing(l.id, undefined, { 'X-Device-Id': 'priv-2' });
    await settle(300);
    const events = JSON.stringify(await db.analyticsEvent.findMany());
    expect(events).not.toContain(PHONE_DIGITS);
    expect(events).not.toContain('15.123457');
    expect(events).not.toContain(u.email);
  });

  it('owner-only fields are never public (ownershipDocKey / vehicleVin)', async () => {
    const u = await seller();
    const l = await publish(u.accessToken);
    await db.listing.update({ where: { id: l.id }, data: { vehicleVin: 'VIN123SECRET', ownershipDocKey: 'docs/secret-key.pdf' } as never });
    const pub = JSON.stringify((await getListing(l.id)).body);
    expect(pub).not.toContain('VIN123SECRET');
    expect(pub).not.toContain('secret-key');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// LISTINGS — visibility, views, lifecycle
// ═════════════════════════════════════════════════════════════════════════════
describe('Listings: visibility and views', () => {
  it('non-owners get 404 for DRAFT/HIDDEN/AUTO_HIDDEN/SUSPENDED/PENDING_REVIEW/ARCHIVED; SOLD/EXPIRED stay visible with flags; owner always sees', async () => {
    const u = await seller(), b = await buyer();
    const l = await publish(u.accessToken);
    for (const status of ['HIDDEN', 'AUTO_HIDDEN', 'SUSPENDED', 'PENDING_REVIEW', 'ARCHIVED', 'DRAFT']) {
      await db.listing.update({ where: { id: l.id }, data: { status } as never });
      expect((await getListing(l.id, b.accessToken)).status, status).toBe(404);
      expect((await getListing(l.id, u.accessToken)).status, `${status} (owner)`).toBe(200);
    }
    await db.listing.update({ where: { id: l.id }, data: { status: 'SOLD', soldAt: new Date() } as never });
    const sold = await getListing(l.id, b.accessToken);
    expect(sold.status).toBe(200);
    expect(JSON.stringify(sold.body)).toContain('"isSold":true');
    await db.listing.update({ where: { id: l.id }, data: { status: 'EXPIRED' } as never });
    const expired = await getListing(l.id, b.accessToken);
    expect(expired.status).toBe(200);
    expect(JSON.stringify(expired.body)).toContain('"isExpired":true');
  });

  it('view counter: once per viewer, excludes the owner', async () => {
    const u = await seller();
    const l = await publish(u.accessToken);
    const views = async () => (await dbListing(l.id))!.viewCount;
    await getListing(l.id, undefined, { 'X-Device-Id': 'view-dev-1' });
    await getListing(l.id, undefined, { 'X-Device-Id': 'view-dev-1' });
    await settle();
    expect(await views()).toBe(1);
    await getListing(l.id, undefined, { 'X-Device-Id': 'view-dev-2' });
    await settle();
    expect(await views()).toBe(2);
    await getListing(l.id, u.accessToken, { 'X-Device-Id': 'owner-dev' });
    await settle();
    expect(await views()).toBe(2);
  });

  it('GET /me/listings and /me/drafts are scoped to the owner', async () => {
    const u = await seller(), other = await seller();
    const active = await publish(u.accessToken, { title: 'My active listing here' });
    const draft = await publish(u.accessToken, { status: 'DRAFT', title: 'My draft listing here' });
    await publish(other.accessToken, { title: 'Someone elses listing' });
    const mine = await request(app).get(`${API}/me/listings`).query({ status: 'ACTIVE' }).set(auth(u.accessToken));
    expect(mine.status).toBe(200);
    const ids = listOf(mine.body).map((x) => x.id);
    expect(ids).toContain(active.id);
    expect(ids).not.toContain(draft.id);
    expect(ids).toHaveLength(1);
    const drafts = await request(app).get(`${API}/me/drafts`).set(auth(u.accessToken));
    expect(listOf(drafts.body).map((x) => x.id)).toEqual([draft.id]);
  });
});

describe('Listings: lifecycle', () => {
  it('edit: owner only, re-validates, records changed field NAMES (not values)', async () => {
    const u = await seller(), b = await buyer();
    const l = await publish(u.accessToken);
    const ok = await request(app).patch(`${API}/listings/${l.id}`).set(auth(u.accessToken)).send({ title: 'Totally Different Secret Title', price: 4500 });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const row = (await dbListing(l.id))!;
    expect(row.title).toBe('Totally Different Secret Title');
    expect(Number(row.price)).toBe(4500);
    const ev = await db.analyticsEvent.findFirst({ where: { type: 'listing_edited', listingId: l.id } });
    expect(ev).toBeTruthy();
    expect(JSON.stringify(ev!.props)).not.toContain('Totally Different Secret Title');

    expect([403, 404]).toContain((await request(app).patch(`${API}/listings/${l.id}`).set(auth(b.accessToken)).send({ title: 'Hijacked title attempt' })).status);
    const badAttr = await request(app).patch(`${API}/listings/${l.id}`).set(auth(u.accessToken)).send({ dynamicAttributes: { make: 'toyota', model: 'corolla', year: 'abc' } });
    expect(badAttr.status).toBe(400);
  });

  it('sold → SOLD + soldAt; editing a SOLD listing is refused', async () => {
    const u = await seller();
    const l = await publish(u.accessToken);
    const r = await request(app).post(`${API}/listings/${l.id}/sold`).set(auth(u.accessToken));
    expect(OK).toContain(r.status);
    const row = (await dbListing(l.id))!;
    expect(row.status).toBe('SOLD');
    expect(row.soldAt).not.toBeNull();
    const edit = await request(app).patch(`${API}/listings/${l.id}`).set(auth(u.accessToken)).send({ title: 'Edit after it was sold' });
    expect(edit.status).toBeGreaterThanOrEqual(400);
    expect(edit.status).toBeLessThan(500);
  });

  it('archive hides from others; delete is soft and returns 404 to everyone', async () => {
    const u = await seller(), b = await buyer();
    const a = await publish(u.accessToken, { title: 'Listing that will be archived' });
    expect(OK).toContain((await request(app).post(`${API}/listings/${a.id}/archive`).set(auth(u.accessToken))).status);
    expect((await dbListing(a.id))!.status).toBe('ARCHIVED');
    expect((await getListing(a.id, b.accessToken)).status).toBe(404);

    const d = await publish(u.accessToken, { title: 'Listing that will be deleted' });
    const del = await request(app).delete(`${API}/listings/${d.id}`).set(auth(u.accessToken));
    expect([200, 204]).toContain(del.status);
    expect((await dbListing(d.id))!.deletedAt).not.toBeNull();
    expect((await getListing(d.id, b.accessToken)).status).toBe(404);
    expect((await getListing(d.id, u.accessToken)).status).toBe(404);
    expect([403, 404]).toContain((await request(app).delete(`${API}/listings/${a.id}`).set(auth(b.accessToken))).status);
  });

  it('renew: EXPIRED within window ok; beyond window or not-expiring refused; ACTIVE expiring ≤7d ok; resets reminders', async () => {
    const u = await seller();
    const renew = (id: string) => request(app).post(`${API}/listings/${id}/renew`).set(auth(u.accessToken));
    const day = 86400000;

    const l = await publish(u.accessToken, { title: 'Listing to renew after expiry' });
    await db.listing.update({ where: { id: l.id }, data: { status: 'EXPIRED', expiresAt: new Date(Date.now() - 2 * day), reminded7: true, reminded1: true } as never });
    expect(OK).toContain((await renew(l.id)).status);
    const row = (await dbListing(l.id))!;
    expect(row.status).toBe('ACTIVE');
    expect(row.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 25 * day);
    expect((row as any).reminded7).toBe(false);
    expect((row as any).reminded1).toBe(false);

    expect((await renew(l.id)).status).toBe(422); // ACTIVE and not expiring soon

    await db.listing.update({ where: { id: l.id }, data: { expiresAt: new Date(Date.now() + 3 * day) } });
    expect(OK).toContain((await renew(l.id)).status); // expiring within 7 days

    await db.listing.update({ where: { id: l.id }, data: { status: 'EXPIRED', expiresAt: new Date(Date.now() - 40 * day) } as never });
    expect((await renew(l.id)).status).toBe(422); // beyond listing.renewWindowDays
  });

  it('expireListings() expires only ACTIVE listings past expiresAt', async () => {
    const u = await seller();
    const a = await publish(u.accessToken, { title: 'Listing that already ran out' });
    const b = await publish(u.accessToken, { title: 'Listing that is still valid' });
    await settle();
    await db.listing.update({ where: { id: a.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await (await expireFn())();
    expect((await dbListing(a.id))!.status).toBe('EXPIRED');
    expect((await dbListing(b.id))!.status).toBe('ACTIVE');
  });

  it('bulk: non-dealer 403; dealer gets per-id results and cannot touch others\' listings', async () => {
    const dealer = await seller({ caps: ['DEALER'] });
    const plain = await seller();
    const stranger = await seller();
    const mine1 = await publish(dealer.accessToken, { title: 'Dealer stock number one' });
    const mine2 = await publish(dealer.accessToken, { title: 'Dealer stock number two' });
    const theirs = await publish(stranger.accessToken, { title: 'Stranger listing not yours' });

    const denied = await request(app).post(`${API}/listings/bulk`).set(auth(plain.accessToken)).send({ action: 'SOLD', ids: [mine1.id] });
    expect(denied.status).toBe(403);

    const r = await request(app).post(`${API}/listings/bulk`).set(auth(dealer.accessToken)).send({ action: 'SOLD', ids: [mine1.id, mine2.id, theirs.id] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const s = JSON.stringify(r.body);
    [mine1.id, mine2.id, theirs.id].forEach((id) => expect(s).toContain(id));
    expect((await dbListing(mine1.id))!.status).toBe('SOLD');
    expect((await dbListing(mine2.id))!.status).toBe('SOLD');
    expect((await dbListing(theirs.id))!.status).toBe('ACTIVE');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// LISTINGS — contact reveal
// ═════════════════════════════════════════════════════════════════════════════
describe('Listings: contact reveal', () => {
  const reveal = (id: string, channel: string, headers: Record<string, string> = {}, token?: string) => {
    const r = request(app).post(`${API}/listings/${id}/contact-reveal`).set(headers).send({ channel });
    return token ? r.set(auth(token)) : r;
  };

  it('guest CALL returns the phone; WHATSAPP returns a wa.me link with the localized template', async () => {
    const u = await seller();
    const l = await publish(u.accessToken);
    const call = await reveal(l.id, 'CALL', { 'X-Device-Id': 'g1' });
    expect(call.status).toBe(200);
    expect(call.body.phone).toBe(PHONE);
    const wa = await reveal(l.id, 'WHATSAPP', { 'X-Device-Id': 'g1', 'Accept-Language': 'en' });
    expect(wa.status).toBe(200);
    expect(wa.body.waUrl.startsWith('https://wa.me/249912345678?text=')).toBe(true);
    const text = decodeURIComponent(wa.body.waUrl.split('?text=')[1]);
    expect(text).toContain(l.readableId);
    expect(text).toContain('Toyota');
    expect((await dbListing(l.id))!.leadCount).toBeGreaterThanOrEqual(1);
  });

  it('channel hidden by the owner → 403 CONTACT_HIDDEN (other channel still works)', async () => {
    const u = await seller();
    const l = await publish(u.accessToken, { contactOptions: { call: false, whatsapp: true, chat: true } });
    const r = await reveal(l.id, 'CALL', { 'X-Device-Id': 'g2' });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('CONTACT_HIDDEN');
    expect((await reveal(l.id, 'WHATSAPP', { 'X-Device-Id': 'g2' })).status).toBe(200);
  });

  it('guest cap → 429 REVEAL_LIMIT after limits.guestRevealsPerDay; other devices and signed-in users unaffected', async () => {
    await setS('limits.guestRevealsPerDay', 3);
    const u = await seller(), b = await buyer();
    const l = await publish(u.accessToken);
    for (let i = 0; i < 3; i++) expect((await reveal(l.id, 'CALL', { 'X-Device-Id': 'cap-dev' })).status).toBe(200);
    const over = await reveal(l.id, 'CALL', { 'X-Device-Id': 'cap-dev' });
    expect(over.status).toBe(429);
    expect(over.body.error.code).toBe('REVEAL_LIMIT');
    expect(JSON.stringify(over.body)).not.toContain(PHONE_DIGITS);
    expect((await reveal(l.id, 'CALL', { 'X-Device-Id': 'other-dev' })).status).toBe(200);
    for (let i = 0; i < 5; i++) expect((await reveal(l.id, 'CALL', { 'X-Device-Id': 'cap-dev' }, b.accessToken)).status).toBe(200);
  });

  it('SIGNED_IN_ONLY policy: guest 401, signed-in 200', async () => {
    await setS('flags.contactReveal.policy', 'SIGNED_IN_ONLY');
    const u = await seller(), b = await buyer();
    const l = await publish(u.accessToken);
    expect((await reveal(l.id, 'CALL', { 'X-Device-Id': 'pol-1' })).status).toBe(401);
    expect((await reveal(l.id, 'CALL', {}, b.accessToken)).status).toBe(200);
  });

  it('owner without a phone → 422 CONTACT_UNAVAILABLE; non-active listing → 404', async () => {
    const noPhone = await seller({ phone: false });
    const l = await publish(noPhone.accessToken);
    const r = await reveal(l.id, 'CALL', { 'X-Device-Id': 'np-1' });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('CONTACT_UNAVAILABLE');

    const u = await seller();
    const d = await publish(u.accessToken, { status: 'DRAFT' });
    expect((await reveal(d.id, 'CALL', { 'X-Device-Id': 'np-2' })).status).toBe(404);
  });

  it('lead endpoint accepts guests', async () => {
    const u = await seller();
    const l = await publish(u.accessToken);
    const r = await request(app).post(`${API}/listings/${l.id}/lead`).set('X-Device-Id', 'lead-1').send({ type: 'CHAT' });
    expect([200, 201, 204]).toContain(r.status);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// SCAN
// ═════════════════════════════════════════════════════════════════════════════
describe('Listings: scan', () => {
  const flagsOf = async (id: string) => JSON.stringify(((await dbListing(id)) as any).scan?.flags ?? []);

  it('delayed-visibility rule → PENDING_REVIEW (hidden), clean scan → ACTIVE', async () => {
    await setS('moderation.delayedVisibility', [{ categoryId: C.cars.id, maxAccountAgeDays: 30 }]);
    const u = await seller(), b = await buyer();
    const l = await publish(u.accessToken);
    await settle(300);
    // creation fires a background scan; force the state we want to assert on
    await db.listing.update({ where: { id: l.id }, data: { status: 'PENDING_REVIEW' } as never });
    expect((await getListing(l.id, b.accessToken)).status).toBe(404);
    await (await scanFn())(l.id);
    expect((await dbListing(l.id))!.status).toBe('ACTIVE');
    expect((await getListing(l.id, b.accessToken)).status).toBe(200);
  });

  it('flags same-owner duplicate text', async () => {
    await setS('limits.activeListingsIndividual', 100);
    const u = await seller();
    const same = { title: 'Exactly the same title for both', description: 'This description is repeated word for word on two separate listings by one owner.' };
    await publish(u.accessToken, same);
    const second = await publish(u.accessToken, same);
    await (await scanFn())(second.id);
    expect(await flagsOf(second.id)).toMatch(/dup/i);
  });

  it('flags the same image reused by another owner', async () => {
    const buf = await jpeg(700, 500, 77);
    const a = await seller(), b = await seller();
    const ma = (await upImg(a.accessToken, buf)).body;
    await publish(a.accessToken, { mediaIds: [ma.id], coverMediaId: ma.id, title: 'First owner uses this photo' });
    const mb = (await upImg(b.accessToken, buf)).body;
    const lb = await publish(b.accessToken, { mediaIds: [mb.id], coverMediaId: mb.id, title: 'Second owner reuses that photo' });
    await (await scanFn())(lb.id);
    expect(await flagsOf(lb.id)).toMatch(/image|dup/i);
  });

  it('flags phone numbers written in the description', async () => {
    const u = await seller();
    const l = await publish(u.accessToken, { description: 'Great car, call me directly on 0912345678 for the best price today please.', title: 'Car with phone in the text' });
    await (await scanFn())(l.id);
    expect(await flagsOf(l.id)).toMatch(/phone/i);
  });

  it('flags banned keywords from settings', async () => {
    await setS('moderation.bannedKeywords', ['forbiddenword']);
    const u = await seller();
    const l = await publish(u.accessToken, { description: 'This description contains the forbiddenword somewhere in the middle of it.', title: 'Car with a banned keyword' });
    await (await scanFn())(l.id);
    expect(await flagsOf(l.id)).toMatch(/keyword|banned/i);
  });

  it('flags job-scam phrases and raises riskScore', async () => {
    const employer = await seller({ caps: ['EMPLOYER'] });
    const l = await publish(employer.accessToken, {
      categoryId: C.jobs.id, listingType: 'JOB', price: undefined, dynamicAttributes: {},
      title: 'Easy remote job guaranteed income',
      description: 'Pay a small registration fee to apply. WhatsApp only. Transfer money first and start tomorrow.',
    });
    await (await scanFn())(l.id);
    const row = (await dbListing(l.id)) as any;
    expect(row.riskScore).toBeGreaterThan(0);
    expect(JSON.stringify(row.scan?.flags ?? [])).toMatch(/scam|fee|job/i);
  });

  it('accepts out-of-Sudan coordinates but flags them', async () => {
    const u = await seller();
    const r = await createListing(u.accessToken, listingBody({ lat: 48.8566, lng: 2.3522, title: 'Car located far outside Sudan' }));
    expect(OK).toContain(r.status);
    const l = unwrap(r.body);
    await (await scanFn())(l.id);
    expect(await flagsOf(l.id)).toMatch(/sudan|out/i);
  });
});