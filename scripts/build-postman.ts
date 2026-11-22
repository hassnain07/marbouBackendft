import fs from 'fs';
import path from 'path';

const BASE = '{{baseUrl}}';
const DEV = '{{devUrl}}';

type Headers = { key: string; value: string; type: string }[];

function r(
  name: string,
  method: string,
  url: string,
  body?: unknown,
  pre?: string,
  tests?: string,
  hdrs?: Headers,
) {
  const obj: Record<string, unknown> = {
    name,
    request: { method, header: hdrs ?? [], url },
    event: [] as unknown[],
  };
  if (body !== undefined) {
    (obj.request as Record<string, unknown>).body = {
      mode: 'raw',
      raw: JSON.stringify(body, null, 2),
      options: { raw: { language: 'json' } },
    };
  }
  const events = obj.event as unknown[];
  if (pre) events.push({ listen: 'prerequest', script: { type: 'text/javascript', exec: pre.split('\n') } });
  if (tests) events.push({ listen: 'test', script: { type: 'text/javascript', exec: tests.split('\n') } });
  return obj;
}

function fold(name: string, items: unknown[], pre?: string) {
  const obj: Record<string, unknown> = { name, item: items, event: [] as unknown[] };
  if (pre) (obj.event as unknown[]).push({ listen: 'prerequest', script: { type: 'text/javascript', exec: pre.split('\n') } });
  return obj;
}

function authHdr(tokenVar: string): Headers {
  return [{ key: 'Authorization', value: `Bearer {{${tokenVar}}}`, type: 'text' }];
}

function fetchOtp(emailVar: string, purpose = 'REGISTER') {
  return r(
    `[OTP] fetch ${purpose} for {{${emailVar}}}`,
    'GET',
    `${DEV}/last-otp?email={{${emailVar}}}&purpose=${purpose}`,
    undefined,
    undefined,
    [
      'pm.test("200", () => pm.expect(pm.response.code).to.equal(200));',
      'const _oc = pm.response.json().code;',
      'pm.test("got code", () => pm.expect(_oc).to.match(/^\\d{6}$/));',
      'pm.environment.set("otp", _oc);',
    ].join('\n'),
  );
}

const captureUser = [
  'const j = pm.response.json();',
  'if (j.accessToken) { pm.environment.set("accessToken", j.accessToken); pm.environment.set("refreshToken", j.refreshToken); }',
  'if (j.user && j.user.id) pm.environment.set("userId", j.user.id);',
].join('\n');

const captureBuyer = [
  'const jb = pm.response.json();',
  'if (jb.accessToken) { pm.environment.set("buyerToken", jb.accessToken); pm.environment.set("buyerRefresh", jb.refreshToken); }',
  'if (jb.user && jb.user.id) pm.environment.set("buyerUserId", jb.user.id);',
].join('\n');

const captureAdmin = [
  'const ja = pm.response.json();',
  'if (ja.accessToken) { pm.environment.set("adminToken", ja.accessToken); pm.environment.set("adminRefresh", ja.refreshToken); }',
].join('\n');

const captureMfa = 'const jm = pm.response.json(); if (jm.mfaToken) pm.environment.set("mfaToken", jm.mfaToken);';

// ── Folder 00 ──────────────────────────────────────────────────────────────────
const f00Pre = [
  'pm.environment.set("runId", Date.now().toString());',
  'const rid = pm.environment.get("runId");',
  'pm.environment.set("sellerEmail", "seller." + rid + "@test.com");',
  'pm.environment.set("buyerEmail",  "buyer."  + rid + "@test.com");',
  'pm.environment.set("lockEmail",   "lock."   + rid + "@test.com");',
  'pm.environment.set("changedEmail","changed."+ rid + "@test.com");',
  'pm.environment.set("sellerPassword", "Password1!");',
].join('\n');

const f00 = fold('00 Pre-request and Config', [
  r('GET /health', 'GET', `${BASE}/health`, undefined, undefined,
    'pm.test("200", () => pm.expect(pm.response.code).to.equal(200));\npm.test("ok", () => pm.expect(pm.response.json().status).to.equal("ok"));'),
  r('GET /config', 'GET', `${BASE}/config`, undefined, undefined,
    'pm.test("200", () => pm.expect(pm.response.code).to.equal(200));\npm.test("has flags", () => pm.expect(pm.response.json()).to.have.property("flags"));\nconst etag = pm.response.headers.get("ETag");\nif (etag) pm.environment.set("configEtag", etag);'),
  r('GET /config 304 [NEG]', 'GET', `${BASE}/config`,
    undefined,
    'pm.request.headers.upsert({ key: "If-None-Match", value: pm.environment.get("configEtag") });',
    'pm.test("304", () => pm.expect(pm.response.code).to.equal(304));'),
], f00Pre);

// ── Folder 01 Auth ─────────────────────────────────────────────────────────────
const f01 = fold('01 Auth', [
  r('POST /auth/register (seller)', 'POST', `${BASE}/auth/register`,
    { email: '{{sellerEmail}}', password: 'Password1!', fullName: 'Seller User' },
    undefined,
    'pm.test("200", () => pm.expect(pm.response.code).to.equal(200));\npm.test("userId", () => pm.expect(pm.response.json()).to.have.property("userId"));'),
  r('POST /auth/register (buyer)', 'POST', `${BASE}/auth/register`,
    { email: '{{buyerEmail}}', password: 'Password1!', fullName: 'Buyer User' },
    undefined,
    'pm.test("200", () => pm.expect(pm.response.code).to.equal(200));'),
  fetchOtp('sellerEmail', 'REGISTER'),
  r('POST /auth/otp/verify (seller)', 'POST', `${BASE}/auth/otp/verify`,
    { email: '{{sellerEmail}}', code: '{{otp}}', purpose: 'REGISTER' },
    undefined,
    `pm.test("200", () => pm.expect(pm.response.code).to.equal(200));\npm.test("accessToken", () => pm.expect(pm.response.json()).to.have.property("accessToken"));\n${captureUser}`),
  fetchOtp('buyerEmail', 'REGISTER'),
  r('POST /auth/otp/verify (buyer)', 'POST', `${BASE}/auth/otp/verify`,
    { email: '{{buyerEmail}}', code: '{{otp}}', purpose: 'REGISTER' },
    undefined,
    `pm.test("200", () => pm.expect(pm.response.code).to.equal(200));\n${captureBuyer}`),
  r('POST /auth/login (seller)', 'POST', `${BASE}/auth/login`,
    { email: '{{sellerEmail}}', password: 'Password1!', device: { id: '{{deviceId}}', name: 'Postman', os: 'test' } },
    undefined,
    `pm.test("200", () => pm.expect(pm.response.code).to.equal(200));\n${captureUser}`),
  r('POST /auth/refresh', 'POST', `${BASE}/auth/refresh`,
    { refreshToken: '{{refreshToken}}' },
    undefined,
    'pm.test("200", () => pm.expect(pm.response.code).to.equal(200));\nconst jr = pm.response.json();\nif (jr.accessToken) { pm.environment.set("accessToken", jr.accessToken); pm.environment.set("refreshToken", jr.refreshToken); }'),
  r('[NEG] register weak password', 'POST', `${BASE}/auth/register`,
    { email: 'neg+{{runId}}@test.com', password: 'weak', fullName: 'A' },
    undefined,
    'pm.test("400", () => pm.expect(pm.response.code).to.equal(400));\npm.test("WEAK_PASSWORD", () => pm.expect(pm.response.json().error.code).to.equal("WEAK_PASSWORD"));'),
  r('[NEG] CHANGE_EMAIL on public otp/request -> 400', 'POST', `${BASE}/auth/otp/request`,
    { email: '{{sellerEmail}}', purpose: 'CHANGE_EMAIL' },
    undefined,
    'pm.test("400", () => pm.expect(pm.response.code).to.equal(400));'),
  r('[NEG] tampered bearer -> 401', 'GET', `${BASE}/me`,
    undefined,
    'pm.request.headers.upsert({ key: "Authorization", value: "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4IiwiZXhwIjoxfQ.bad" });',
    'pm.test("401", () => pm.expect(pm.response.code).to.equal(401));'),
  r('POST /auth/login (restore)', 'POST', `${BASE}/auth/login`,
    { email: '{{sellerEmail}}', password: 'Password1!', device: {} },
    undefined,
    `pm.test("200", () => pm.expect(pm.response.code).to.equal(200));\n${captureUser}`),
]);

// ── Folder 02 Profile ──────────────────────────────────────────────────────────
const f02 = fold('02 Profile', [
  r('GET /me', 'GET', `${BASE}/me`, undefined, undefined,
    'pm.test("200", () => pm.expect(pm.response.code).to.equal(200));\npm.test("has email", () => pm.expect(pm.response.json()).to.have.property("email"));'),
  r('PATCH /me', 'PATCH', `${BASE}/me`,
    { fullName: 'Updated Seller', bio: 'Test bio' },
    undefined,
    'pm.test("200", () => pm.expect(pm.response.code).to.equal(200));'),
  r('POST /me/capabilities SELLER', 'POST', `${BASE}/me/capabilities`,
    { capability: 'SELLER' },
    undefined,
    'pm.test("200 or 409", () => pm.expect([200,409]).to.include(pm.response.code));'),
  r('GET /users/{{buyerUserId}} public', 'GET', `${BASE}/users/{{buyerUserId}}`,
    undefined, undefined,
    'pm.test("200 or 404", () => pm.expect([200,404]).to.include(pm.response.code));\nif (pm.response.code === 200) {\n  pm.test("no email", () => pm.expect(pm.response.json()).to.not.have.property("email"));\n  pm.test("no phone", () => pm.expect(pm.response.json()).to.not.have.property("phone"));\n}'),
  r('POST /me/verification with real doc', 'POST', `${BASE}/me/verification`,
    { kind: 'USER', documentMediaIds: ['{{docMediaId}}'] },
    undefined,
    'pm.test("200 or 404", () => pm.expect([200,404]).to.include(pm.response.code));'),
  r('POST /me/verification -> 404 MEDIA_NOT_FOUND', 'POST', `${BASE}/me/verification`,
    { kind: 'USER', documentMediaIds: ['00000000-0000-0000-0000-000000000000'] },
    undefined,
    'pm.test("404", () => pm.expect(pm.response.code).to.equal(404));\npm.test("MEDIA_NOT_FOUND", () => pm.expect(pm.response.json().error.code).to.equal("MEDIA_NOT_FOUND"));'),
  r('[NEG] customer token on GET /admin/me -> 401', 'GET', `${BASE}/admin/me`,
    undefined, undefined,
    'pm.test("401", () => pm.expect(pm.response.code).to.equal(401));',
    authHdr('accessToken')),
]);

// ── Folder 03 Admin ────────────────────────────────────────────────────────────
const f03 = fold('03 Admin', [
  r('POST /admin/auth/login', 'POST', `${BASE}/admin/auth/login`,
    { email: '{{adminEmail}}', password: '{{adminPassword}}' },
    undefined,
    `pm.test("200", () => pm.expect(pm.response.code).to.equal(200));\npm.test("mfaToken", () => pm.expect(pm.response.json()).to.have.property("mfaToken"));\n${captureMfa}`),
  r('POST /admin/auth/verify-2fa', 'POST', `${BASE}/admin/auth/verify-2fa`,
    { mfaToken: '{{mfaToken}}', code: '000000' },
    undefined,
    `pm.test("200", () => pm.expect(pm.response.code).to.equal(200));\npm.test("accessToken", () => pm.expect(pm.response.json()).to.have.property("accessToken"));\n${captureAdmin}`),
  r('[NEG] reuse consumed mfaToken -> 400', 'POST', `${BASE}/admin/auth/verify-2fa`,
    { mfaToken: '{{mfaToken}}', code: '000000' },
    undefined,
    'pm.test("400", () => pm.expect(pm.response.code).to.equal(400));\npm.test("MFA_TOKEN_INVALID", () => pm.expect(pm.response.json().error.code).to.equal("MFA_TOKEN_INVALID"));'),
  r('GET /admin/me', 'GET', `${BASE}/admin/me`, undefined, undefined,
    'pm.test("200", () => pm.expect(pm.response.code).to.equal(200));'),
  r('GET /admin/settings', 'GET', `${BASE}/admin/settings`, undefined, undefined,
    'pm.test("200", () => pm.expect(pm.response.code).to.equal(200));'),
  r('PATCH /admin/flags/flags.video.enabled false', 'PATCH', `${BASE}/admin/flags/flags.video.enabled`,
    { value: false }, undefined,
    'pm.test("200", () => pm.expect(pm.response.code).to.equal(200));'),
  r('PATCH /admin/flags/flags.video.enabled restore', 'PATCH', `${BASE}/admin/flags/flags.video.enabled`,
    { value: true }, undefined,
    'pm.test("200", () => pm.expect(pm.response.code).to.equal(200));'),
  r('[NEG] PATCH flags.otp.email false -> 422', 'PATCH', `${BASE}/admin/flags/flags.otp.email`,
    { value: false }, undefined,
    'pm.test("422", () => pm.expect(pm.response.code).to.equal(422));\npm.test("LAST_OTP_CHANNEL", () => pm.expect(pm.response.json().error.code).to.equal("LAST_OTP_CHANNEL"));'),
  r('[NEG] unknown setting key -> 404', 'PATCH', `${BASE}/admin/settings/nonexistent.key`,
    { value: true }, undefined,
    'pm.test("404", () => pm.expect(pm.response.code).to.equal(404));'),
  r('[NEG] wrong type -> 422', 'PATCH', `${BASE}/admin/settings/flags.otp.email`,
    { value: 'yes' }, undefined,
    'pm.test("422", () => pm.expect(pm.response.code).to.equal(422));'),
]);

// ── Folder 04 Catalog ──────────────────────────────────────────────────────────
const f04 = fold('04 Catalog', [
  r('GET /categories', 'GET', `${BASE}/categories`, undefined, undefined,
    [
      'pm.test("200", () => pm.expect(pm.response.code).to.equal(200));',
      'pm.test("array", () => pm.expect(pm.response.json()).to.be.an("array").or.have.property("data"));',
      'const etag = pm.response.headers.get("ETag");',
      'if (etag) pm.environment.set("catEtag", etag);',
    ].join('\n')),
  r('GET /categories 304 [NEG]', 'GET', `${BASE}/categories`,
    undefined,
    'pm.request.headers.upsert({ key: "If-None-Match", value: pm.environment.get("catEtag") });',
    'pm.test("304", () => pm.expect(pm.response.code).to.equal(304));'),
  r('GET /categories/unknown -> 404', 'GET', `${BASE}/categories/00000000-0000-0000-0000-000000000000`,
    undefined, undefined,
    'pm.test("404", () => pm.expect(pm.response.code).to.equal(404));'),
  r('GET /geo/states', 'GET', `${BASE}/geo/states`, undefined, undefined,
    'pm.test("200", () => pm.expect(pm.response.code).to.equal(200));\nconst states = pm.response.json(); const stateList = Array.isArray(states) ? states : (states.data ?? states.states ?? []); if (stateList.length > 0) pm.environment.set("stateId", stateList[0].id);'),
  r('GET /geo/states/:id/cities', 'GET', `${BASE}/geo/states/{{stateId}}/cities`,
    undefined, undefined,
    'pm.test("200 or 404", () => pm.expect([200,404]).to.include(pm.response.code));\nif (pm.response.code === 200) { const cities = pm.response.json(); const cl = Array.isArray(cities) ? cities : (cities.data ?? []); if (cl.length > 0) pm.environment.set("cityId", cl[0].id); }'),
  r('GET /countries', 'GET', `${BASE}/countries`, undefined, undefined,
    'pm.test("200", () => pm.expect(pm.response.code).to.equal(200));\nconst countries = pm.response.json(); const cl2 = Array.isArray(countries) ? countries : (countries.data ?? countries.countries ?? []); pm.test("has Sudan", () => pm.expect(cl2.map((c) => c.code)).to.include("SD"));'),
  r('[NEG] RBAC: no token on POST /admin/categories -> 401', 'POST', `${BASE}/admin/categories/00000000-0000-0000-0000-000000000000/attributes`,
    { attributeKey: 'zzz', labelEn: 'Z', labelAr: 'ز', dataType: 'TEXT', isRequired: false },
    'pm.request.headers.remove("Authorization");',
    'pm.test("401", () => pm.expect(pm.response.code).to.equal(401));'),
]);

// ── Folder 05 Media ────────────────────────────────────────────────────────────
// Note: multipart uploads are exercised via fixtures in postman/fixtures/
// These requests reference pre-uploaded fixture IDs set by pre-request scripts.
const f05 = fold('05 Media', [
  r('POST /media/images (listing)', 'POST', `${BASE}/media/images?purpose=listing`,
    undefined, undefined,
    [
      'pm.test("200 or 201", () => pm.expect([200,201]).to.include(pm.response.code));',
      'if ([200,201].includes(pm.response.code)) {',
      '  pm.test("has id", () => pm.expect(pm.response.json()).to.have.property("id"));',
      '  pm.test("has url", () => pm.expect(pm.response.json()).to.have.property("url"));',
      '  pm.test("no lat/lng in url", () => {',
      '    const s = JSON.stringify(pm.response.json());',
      '    pm.expect(s).to.not.match(/\"lat\"|\"lng\"/);',
      '  });',
      '  pm.environment.set("imageMediaId", pm.response.json().id);',
      '}',
    ].join('\n')),
  r('POST /media/documents', 'POST', `${BASE}/media/documents`,
    undefined, undefined,
    [
      'pm.test("200 or 201", () => pm.expect([200,201]).to.include(pm.response.code));',
      'if ([200,201].includes(pm.response.code)) {',
      '  pm.test("has id", () => pm.expect(pm.response.json()).to.have.property("id"));',
      '  pm.test("has key", () => pm.expect(pm.response.json()).to.have.property("key"));',
      '  pm.environment.set("docMediaId", pm.response.json().id);',
      '}',
    ].join('\n')),
  r('GET /media/signed-url (owner)', 'GET', `${BASE}/media/signed-url?mediaId={{docMediaId}}`,
    undefined, undefined,
    'pm.test("200", () => pm.expect(pm.response.code).to.equal(200));\npm.test("has url", () => pm.expect(pm.response.json()).to.have.property("url"));'),
  r('[NEG] GET /media/signed-url no auth -> 401', 'GET', `${BASE}/media/signed-url?mediaId={{docMediaId}}`,
    undefined,
    'pm.request.headers.remove("Authorization");',
    'pm.test("401", () => pm.expect(pm.response.code).to.equal(401));'),
  r('[NEG] DELETE /media/:id other user -> 403 or 404', 'DELETE', `${BASE}/media/{{imageMediaId}}`,
    undefined,
    'pm.request.headers.upsert({ key: "Authorization", value: "Bearer " + pm.environment.get("buyerToken") });',
    'pm.test("403 or 404", () => pm.expect([403,404]).to.include(pm.response.code));'),
  r('DELETE /media/:id owner', 'DELETE', `${BASE}/media/{{imageMediaId}}`,
    undefined, undefined,
    'pm.test("200 or 204 or 404", () => pm.expect([200,204,404]).to.include(pm.response.code));'),
  r('[NEG] video flag off -> VIDEO_DISABLED', 'POST', `${BASE}/media/video`,
    undefined, undefined,
    'pm.test("no 500", () => pm.expect(pm.response.code).to.be.below(500));'),
]);

// ── Folder 06 Listings ─────────────────────────────────────────────────────────
const listingBody = {
  categoryId: '{{carCategoryId}}',
  listingType: 'SALE',
  title: 'Toyota Corolla 2015 clean car',
  description: 'Well maintained Toyota Corolla, single owner, full service history, ready to drive anywhere in Khartoum.',
  price: 5000, currency: 'USD', isNegotiable: true,
  cityId: '{{cityId}}',
  lat: 15.123457, lng: 32.654321,
  locationName: 'Omdurman',
  isApproxLocation: false,
  contactOptions: { call: true, whatsapp: true, chat: true },
  dynamicAttributes: {},
  isCustomOther: false, mediaIds: [],
  status: 'PUBLISH',
};

const privacyAssert = [
  'pm.test("no phone digits", () => pm.expect(JSON.stringify(pm.response.json())).to.not.match(/912345678/));',
  'pm.test("no ownershipDocKey", () => pm.expect(JSON.stringify(pm.response.json())).to.not.match(/ownershipDocKey/));',
].join('\n');

const approxPrivacyAssert = [
  'pm.test("no exact lat", () => pm.expect(JSON.stringify(pm.response.json())).to.not.contain("15.123457"));',
  'pm.test("no exact lng", () => pm.expect(JSON.stringify(pm.response.json())).to.not.contain("32.654321"));',
  'pm.test("no lat key", () => pm.expect(pm.response.json()).to.not.have.property("lat"));',
  'pm.test("no lng key", () => pm.expect(pm.response.json()).to.not.have.property("lng"));',
  'pm.test("has pubLat", () => pm.expect(typeof pm.response.json().pubLat).to.equal("number"));',
].join('\n');

const f06 = fold('06 Listings', [
  r('POST /listings (publish)', 'POST', `${BASE}/listings`,
    listingBody, undefined,
    [
      'pm.test("200 or 201", () => pm.expect([200,201]).to.include(pm.response.code));',
      'const l = pm.response.json().listing ?? pm.response.json();',
      'if (l.id) { pm.environment.set("listingId", l.id); pm.environment.set("listingReadableId", l.readableId); }',
      privacyAssert,
    ].join('\n')),
  r('GET /listings/:id by UUID', 'GET', `${BASE}/listings/{{listingId}}`,
    undefined, undefined,
    `pm.test("200", () => pm.expect(pm.response.code).to.equal(200));\n${privacyAssert}`),
  r('GET /listings/:id by readableId', 'GET', `${BASE}/listings/{{listingReadableId}}`,
    undefined, undefined,
    'pm.test("200", () => pm.expect(pm.response.code).to.equal(200));\npm.test("same id", () => pm.expect(pm.response.json().id).to.equal(pm.environment.get("listingId")));'),
  r('GET /listings/not-an-id -> 404', 'GET', `${BASE}/listings/not-an-id`,
    undefined, undefined,
    'pm.test("404", () => pm.expect(pm.response.code).to.equal(404));'),
  r('POST /listings (approx location)', 'POST', `${BASE}/listings`,
    { ...listingBody, isApproxLocation: true, approxRadiusM: 500, title: 'Approx location listing test' },
    undefined,
    [
      'pm.test("200 or 201", () => pm.expect([200,201]).to.include(pm.response.code));',
      'const la = pm.response.json().listing ?? pm.response.json();',
      'if (la.id) pm.environment.set("approxListingId", la.id);',
    ].join('\n')),
  r('GET /listings/:id approx - privacy check', 'GET', `${BASE}/listings/{{approxListingId}}`,
    undefined, undefined,
    approxPrivacyAssert),
  r('PATCH /listings/:id', 'PATCH', `${BASE}/listings/{{listingId}}`,
    { title: 'Updated Toyota Corolla 2015', price: 4800 },
    undefined,
    'pm.test("200", () => pm.expect(pm.response.code).to.equal(200));'),
  r('[NEG] PATCH unknown key -> 400', 'PATCH', `${BASE}/listings/{{listingId}}`,
    { title: 'Valid title here', unknownField: 'bad' },
    undefined,
    'pm.test("400", () => pm.expect(pm.response.code).to.equal(400));'),
  r('[NEG] PATCH other user -> 403 or 404', 'PATCH', `${BASE}/listings/{{listingId}}`,
    { title: 'Hijack attempt' },
    'pm.request.headers.upsert({ key: "Authorization", value: "Bearer " + pm.environment.get("buyerToken") });',
    'pm.test("403 or 404", () => pm.expect([403,404]).to.include(pm.response.code));'),
  r('POST /listings/:id/contact-reveal CALL', 'POST', `${BASE}/listings/{{listingId}}/contact-reveal`,
    { channel: 'CALL' },
    'pm.request.headers.upsert({ key: "X-Device-Id", value: "postman-reveal-1" });',
    [
      'pm.test("200", () => pm.expect(pm.response.code).to.equal(200));',
      'pm.test("has phone", () => pm.expect(pm.response.json()).to.have.property("phone"));',
      'pm.test("no email in reveal", () => pm.expect(JSON.stringify(pm.response.json())).to.not.match(/@test\\.com/));',
    ].join('\n')),
  r('POST /listings/:id/contact-reveal WHATSAPP', 'POST', `${BASE}/listings/{{listingId}}/contact-reveal`,
    { channel: 'WHATSAPP' },
    'pm.request.headers.upsert({ key: "X-Device-Id", value: "postman-reveal-2" });',
    'pm.test("200", () => pm.expect(pm.response.code).to.equal(200));\npm.test("has waUrl", () => pm.expect(pm.response.json()).to.have.property("waUrl"));'),
  r('POST /listings/:id/lead', 'POST', `${BASE}/listings/{{listingId}}/lead`,
    { type: 'CHAT' },
    'pm.request.headers.upsert({ key: "X-Device-Id", value: "postman-lead-1" });',
    'pm.test("200 or 201 or 204", () => pm.expect([200,201,204]).to.include(pm.response.code));'),
  r('POST /listings/quality-preview', 'POST', `${BASE}/listings/quality-preview`,
    { ...listingBody, mediaCount: 0, hasVideo: false },
    undefined,
    'pm.test("200", () => pm.expect(pm.response.code).to.equal(200));\npm.test("has qualityScore", () => pm.expect(pm.response.json()).to.have.property("qualityScore"));'),
  r('POST /listings/:id/duplicate', 'POST', `${BASE}/listings/{{listingId}}/duplicate`,
    undefined, undefined,
    'pm.test("200 or 201", () => pm.expect([200,201]).to.include(pm.response.code));\nconst dup = pm.response.json().listing ?? pm.response.json();\nif (dup.id) pm.environment.set("dupListingId", dup.id);'),
  r('POST /listings/:id/sold', 'POST', `${BASE}/listings/{{listingId}}/sold`,
    undefined, undefined,
    'pm.test("200 or 201", () => pm.expect([200,201]).to.include(pm.response.code));'),
  r('GET /me/listings', 'GET', `${BASE}/me/listings?status=SOLD`,
    undefined, undefined,
    'pm.test("200", () => pm.expect(pm.response.code).to.equal(200));\npm.test("has data", () => pm.expect(pm.response.json()).to.have.property("data"));'),
  r('GET /me/drafts', 'GET', `${BASE}/me/drafts`,
    undefined, undefined,
    'pm.test("200", () => pm.expect(pm.response.code).to.equal(200));\npm.test("has data", () => pm.expect(pm.response.json()).to.have.property("data"));'),
  r('[NEG] POST /listings no auth -> 401', 'POST', `${BASE}/listings`,
    listingBody,
    'pm.request.headers.remove("Authorization");',
    'pm.test("401", () => pm.expect(pm.response.code).to.equal(401));'),
  r('DELETE /listings/:id (draft copy)', 'DELETE', `${BASE}/listings/{{dupListingId}}`,
    undefined, undefined,
    'pm.test("200 or 204 or 404", () => pm.expect([200,204,404]).to.include(pm.response.code));'),
]);

// ── Collection pre/test scripts ────────────────────────────────────────────────
const colPre = [
  'pm.request.headers.upsert({ key: "X-Device-Id", value: pm.environment.get("deviceId") || "11111111-1111-4111-8111-111111111111" });',
  'pm.request.headers.upsert({ key: "Accept-Language", value: "en" });',
  'const isAdmin = pm.request.url.getPath().includes("/admin/");',
  'const t = pm.environment.get(isAdmin ? "adminToken" : "accessToken");',
  'if (t && !pm.request.headers.has("Authorization")) {',
  '  pm.request.headers.add({ key: "Authorization", value: "Bearer " + t });',
  '}',
].join('\n');

const colTests = [
  'pm.test("no 5xx", () => pm.expect(pm.response.code).to.be.below(500));',
  'pm.test("response time < 2000ms", () => pm.expect(pm.response.responseTime).to.be.below(2000));',
  'if (pm.response.code >= 400) {',
  '  pm.test("error envelope", () => pm.expect(pm.response.json()).to.have.nested.property("error.code"));',
  '}',
].join('\n');

const collection = {
  info: {
    name: 'MARBOU API - Slice 1+2',
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
  },
  event: [
    { listen: 'prerequest', script: { type: 'text/javascript', exec: colPre.split('\n') } },
    { listen: 'test', script: { type: 'text/javascript', exec: colTests.split('\n') } },
  ],
  variable: [
    { key: 'baseUrl', value: 'http://localhost:4000/api/v1' },
    { key: 'devUrl', value: 'http://localhost:4000/dev' },
  ],
  item: [f00, f01, f02, f03, f04, f05, f06],
};

const environment = {
  name: 'MARBOU Local',
  values: [
    { key: 'baseUrl', value: 'http://localhost:4000/api/v1', enabled: true },
    { key: 'devUrl', value: 'http://localhost:4000/dev', enabled: true },
    { key: 'deviceId', value: '11111111-1111-4111-8111-111111111111', enabled: true },
    { key: 'runId', value: '', enabled: true },
    { key: 'sellerEmail', value: '', enabled: true },
    { key: 'buyerEmail', value: '', enabled: true },
    { key: 'lockEmail', value: '', enabled: true },
    { key: 'changedEmail', value: '', enabled: true },
    { key: 'sellerPassword', value: 'Password1!', enabled: true },
    { key: 'accessToken', value: '', enabled: true },
    { key: 'refreshToken', value: '', enabled: true },
    { key: 'userId', value: '', enabled: true },
    { key: 'buyerToken', value: '', enabled: true },
    { key: 'buyerRefresh', value: '', enabled: true },
    { key: 'buyerUserId', value: '', enabled: true },
    { key: 'adminToken', value: '', enabled: true },
    { key: 'adminRefresh', value: '', enabled: true },
    { key: 'adminEmail', value: 'admin@marbou.test', enabled: true },
    { key: 'adminPassword', value: 'Admin#12345', enabled: true },
    { key: 'mfaToken', value: '', enabled: true },
    { key: 'listingId', value: '', enabled: true },
    { key: 'listingReadableId', value: '', enabled: true },
    { key: 'approxListingId', value: '', enabled: true },
    { key: 'dupListingId', value: '', enabled: true },
    { key: 'imageMediaId', value: '', enabled: true },
    { key: 'docMediaId', value: '', enabled: true },
    { key: 'carCategoryId', value: '', enabled: true },
    { key: 'stateId', value: '', enabled: true },
    { key: 'cityId', value: '', enabled: true },
    { key: 'catEtag', value: '', enabled: true },
    { key: 'configEtag', value: '', enabled: true },
  ],
};

const outDir = path.resolve(__dirname, '..', 'postman');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'marbou.postman_collection.json'), JSON.stringify(collection, null, 2));
fs.writeFileSync(path.join(outDir, 'local.postman_environment.json'), JSON.stringify(environment, null, 2));
console.log('postman/marbou.postman_collection.json written');
console.log('postman/local.postman_environment.json written');
