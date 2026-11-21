# MARBOU — Backend Implementation Guide (Build · Test · Postman)

> **Audience:** the coding agent. **Read first:** `01_BACKEND_ARCHITECTURE.md` (architecture, data model, API catalogue, flows). This file tells you **what to build, in what order, how, and how to prove it works**.
> **Feature reference:** `MARBOU_PRD_V3.md` (requirement IDs like `LST-13` appear below).

## 0. Working Rules (follow strictly)

1. **Simplest working code wins.** No over-abstraction, no generic frameworks, no extra services. If something feels heavy, check §2 of the architecture file for the simple alternative.
2. **Build phase by phase, in order.** After each phase: run `npm run typecheck && npm test`, commit, and tick the checklist at the end of the phase. Do not start a phase while tests of the previous one fail.
3. **Every endpoint = one `defineRoute()` call** (validation + auth + OpenAPI in one place). Business logic only in `service.ts`.
4. **Never return secrets or other people's contact data.** Public listing payloads never include phone numbers; exact coordinates never leave the server when `isApproxLocation=true`.
5. **Every admin/moderation/financial/config action writes an audit entry** (`audit.log(...)`) with IDs only (no names/emails/phones).
6. **Localize**: errors and notifications must exist in Arabic and English (`shared/messages.ts`).
7. **Third parties are mocked by default** (`*_DRIVER=console|mock`). The app must boot and all tests pass with no external accounts.
8. If the frontend repo exists, **diff its API calls against the catalogue** (arch §10) at the end of Phase 2 and again at Phase 8, and adjust route names/shapes to the frontend (not the other way round).
9. Keep each file under ~300 lines; split by feature if larger.

---

## 1. Phase 0 — Bootstrap

### 1.1 Commands
```bash
mkdir marbou-backend && cd marbou-backend && git init
npm init -y
npm i express helmet cors compression express-rate-limit zod @asteasolutions/zod-to-openapi swagger-ui-express \
  @prisma/client pg-boss socket.io jsonwebtoken bcryptjs otplib google-auth-library jose \
  @aws-sdk/client-s3 @aws-sdk/s3-request-presigner sharp multer nodemailer firebase-admin \
  pino pino-http sanitize-html dotenv
npm i ioredis @socket.io/redis-adapter           # optional scale-out (only used if REDIS_URL set)
npm i -D typescript tsx prisma vitest supertest @types/node @types/express @types/jsonwebtoken \
  @types/bcryptjs @types/multer @types/nodemailer @types/supertest @types/swagger-ui-express \
  @types/sanitize-html eslint prettier
npx prisma init
```
`package.json` scripts:
```json
{
  "dev": "tsx watch src/server.ts",
  "dev:worker": "tsx watch src/worker.ts",
  "build": "tsc -p .",
  "start": "node dist/server.js",
  "start:worker": "node dist/worker.js",
  "typecheck": "tsc --noEmit",
  "test": "vitest run",
  "db:migrate": "prisma migrate dev",
  "db:deploy": "prisma migrate deploy",
  "db:seed": "tsx prisma/seed.ts",
  "seed:load": "tsx prisma/seed-load.ts",
  "openapi": "tsx scripts/export-openapi.ts",
  "postman": "npm run openapi && npx openapi-to-postmanv2 -s openapi.json -o postman/marbou.postman_collection.json -p"
}
```

### 1.2 `docker-compose.yml`
```yaml
services:
  db:
    image: postgres:16
    environment: { POSTGRES_USER: marbou, POSTGRES_PASSWORD: marbou, POSTGRES_DB: marbou }
    ports: ["5432:5432"]
    volumes: [dbdata:/var/lib/postgresql/data]
  minio:
    image: minio/minio
    command: server /data --console-address ":9001"
    environment: { MINIO_ROOT_USER: minio, MINIO_ROOT_PASSWORD: minio12345 }
    ports: ["9000:9000", "9001:9001"]
    volumes: [miniodata:/data]
  api:
    build: .
    command: node dist/server.js
    env_file: .env
    environment: { RUN_WORKER: "true" }
    depends_on: [db, minio]
    ports: ["4000:4000"]
  # redis:            # OPTIONAL — uncomment + set REDIS_URL to scale out
  #   image: redis:7
volumes: { dbdata: {}, miniodata: {} }
```
`Dockerfile`: `node:20-slim`, `apt-get install -y ffmpeg openssl`, `npm ci`, `npx prisma generate`, `npm run build`, `CMD ["sh","-c","npx prisma migrate deploy && node dist/server.js"]`.

### 1.3 `.env.example`
```
NODE_ENV=development
PORT=4000
DATABASE_URL=postgresql://marbou:marbou@localhost:5432/marbou
JWT_USER_SECRET=change-me-32+chars
JWT_ADMIN_SECRET=change-me-too-32+chars
OTP_PEPPER=change-me-pepper
CORS_ORIGINS=http://localhost:3000,http://localhost:3001
PUBLIC_WEB_URL=http://localhost:3000
RUN_WORKER=true
REDIS_URL=
# adapters: console|mock for dev
EMAIL_DRIVER=console
SMTP_URL=
PUSH_DRIVER=console
FIREBASE_SERVICE_ACCOUNT_JSON=
SMS_DRIVER=mock
WHATSAPP_DRIVER=mock
MAPS_DRIVER=mock
GOOGLE_MAPS_API_KEY=
CLASSIFIER_DRIVER=noop
AUTH_MOCK=true               # accept "mock:<email>" tokens for social login in dev/test
GOOGLE_CLIENT_IDS=
FACEBOOK_APP_ID=
APPLE_CLIENT_ID=
S3_ENDPOINT=http://localhost:9000
S3_REGION=us-east-1
S3_ACCESS_KEY=minio
S3_SECRET_KEY=minio12345
S3_BUCKET_PUBLIC=marbou-public
S3_BUCKET_PRIVATE=marbou-private
S3_PUBLIC_BASE_URL=http://localhost:9000/marbou-public
# dev/test only (server refuses to start with these in production)
DEV_HELPERS=true             # exposes /dev/last-otp
DEV_TOTP_FIXED_CODE=000000   # accepted as admin 2FA code when not production
SEED_ADMIN_EMAIL=admin@marbou.test
SEED_ADMIN_PASSWORD=Admin#12345
SENTRY_DSN=
```
`config/env.ts`: parse with Zod; **in production** throw if secrets < 32 chars, `AUTH_MOCK`, `DEV_HELPERS`, or `DEV_TOTP_FIXED_CODE` are set.

### 1.4 Core helpers (write these first)

**`shared/errors.ts`**
```ts
export class AppError extends Error {
  constructor(public status: number, public code: string, public details?: any) { super(code); }
}
export const E = {
  badRequest: (code='BAD_REQUEST', d?) => new AppError(400, code, d),
  unauthorized: (code='UNAUTHORIZED') => new AppError(401, code),
  forbidden: (code='FORBIDDEN') => new AppError(403, code),
  notFound: (code='NOT_FOUND') => new AppError(404, code),
  conflict: (code='CONFLICT', d?) => new AppError(409, code, d),
  rule: (code: string, d?) => new AppError(422, code, d),      // business-rule violation
  tooMany: (code='RATE_LIMITED') => new AppError(429, code),
};
// error middleware: maps AppError/ZodError/Prisma errors -> { error:{ code, message(localized via messages.ts), details, traceId } }
```
**`shared/route.ts` — the single route helper**
```ts
export const registry = new OpenAPIRegistry();
export function defineRoute<B extends ZodTypeAny, Q extends ZodTypeAny, P extends ZodTypeAny>(o: {
  router: Router; method: 'get'|'post'|'put'|'patch'|'delete'; path: string; summary: string; tag: string;
  auth?: 'public'|'optional'|'user'|'verified'|'admin';
  cap?: Capability; perm?: string; flag?: string;
  limit?: keyof typeof limiters; idempotent?: boolean;
  body?: B; query?: Q; params?: P;
  handler: (c: { body: z.infer<B>; query: z.infer<Q>; params: z.infer<P>; user?: AuthUser; admin?: AdminCtx; lang: 'ar'|'en'; req: Request; res: Response }) => Promise<any>;
}) {
  const mw: RequestHandler[] = [];
  if (o.limit) mw.push(limiters[o.limit]);
  if (o.flag) mw.push(requireFlag(o.flag));
  if (o.auth === 'optional') mw.push(optionalAuth);
  if (o.auth === 'user' || o.auth === 'verified') mw.push(requireAuth);
  if (o.auth === 'verified') mw.push(requireVerifiedEmail);
  if (o.auth === 'admin') mw.push(requireAdmin, ...(o.perm ? [requirePerm(o.perm)] : []));
  if (o.cap) mw.push(requireCapability(o.cap));
  if (o.idempotent) mw.push(idempotency);
  o.router[o.method](o.path, ...mw, async (req, res, next) => {
    try {
      const body = o.body ? o.body.parse(req.body) : undefined;
      const query = o.query ? o.query.parse(req.query) : undefined;
      const params = o.params ? o.params.parse(req.params) : undefined;
      const out = await o.handler({ body, query, params, user: (req as any).user, admin: (req as any).admin, lang: (req as any).lang, req, res });
      if (!res.headersSent) res.json(out ?? { ok: true });
    } catch (e) { next(e); }
  });
  registry.registerPath({ method: o.method, path: '/api/v1' + o.path.replace(/:(\w+)/g, '{$1}'), summary: o.summary, tags: [o.tag],
    security: o.auth && o.auth !== 'public' ? [{ bearerAuth: [] }] : [] /* + request schemas */ });
}
```
(Use the zod `.openapi()` extension so request/response schemas appear in Swagger; response schemas may be added gradually, request schemas are mandatory.)

**`shared/settings.ts`**
```ts
let cache = new Map<string, any>(); let loadedAt = 0;
async function load(force=false) { if (!force && Date.now()-loadedAt < 60_000) return;
  const rows = await db.setting.findMany(); cache = new Map(rows.map(r => [r.key, r.value])); loadedAt = Date.now(); }
export const settings = {
  async get<T>(key: string, fallback?: T): Promise<T> { await load(); return (cache.has(key) ? cache.get(key) : DEFAULTS[key] ?? fallback) as T; },
  async set(key: string, value: any, actor: {type:'ADMIN'|'SYSTEM', id: string}) {
    validateSetting(key, value);                         // e.g. AUTH-15: refuse disabling last OTP channel
    const before = await this.get(key);
    await db.setting.upsert({ where:{key}, create:{key,value,updatedBy:actor.id}, update:{value,updatedBy:actor.id} });
    await audit.log({ actor, action:'SETTING_CHANGE', entity:'Setting', entityId:key, before, after:value });
    await load(true);
  },
};
```
`DEFAULTS` = the registry table in arch §7.3 (so a missing row never crashes). `requireFlag(key)` → `E.notFound()` when `settings.get(key)` is falsy.

**`shared/audit.ts`**
```ts
export async function log(e: {actor:{type:string,id:string}, action:string, entity:string, entityId:string, before?:any, after?:any}) {
  return db.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(777)`;
    const last = await tx.auditLog.findFirst({ orderBy:{ id:'desc' }, select:{ hash:true } });
    const prevHash = last?.hash ?? 'GENESIS'; const createdAt = new Date();
    const payload = JSON.stringify({ ...e, actor: undefined, actorType:e.actor.type, actorId:e.actor.id, createdAt });
    const hash = createHash('sha256').update(prevHash + payload).digest('hex');
    return tx.auditLog.create({ data:{ actorType:e.actor.type, actorId:e.actor.id, action:e.action, entity:e.entity, entityId:e.entityId,
      before:e.before, after:e.after, prevHash, hash, createdAt } });
  });
}
// verify(): iterate in id order, recompute with the same payload shape, report first mismatch.
```
(Store the exact JSON string used for hashing or rebuild it deterministically — keep key order fixed.)

**`shared/idempotency.ts`**: middleware reads `Idempotency-Key`; key = `${userId||ip}:${route}:${key}`; if row exists → replay stored status+body; else wrap `res.json` to persist the response (TTL 24 h; purge in retention job). For chat messages the DB unique `(senderId, idempotencyKey)` is the real guard.

**`shared/pagination.ts`**: `encodeCursor(obj)=base64url(JSON)`, `decodeCursor(str)`; list helpers return `{ data, nextCursor }`.

**`shared/arabic.ts`**
```ts
export function normalizeArabic(s: string): string {
  return s.toLowerCase()
    .replace(/[\u064B-\u065F\u0670\u0640]/g, '')        // diacritics + tatweel
    .replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').replace(/ؤ/g, 'و').replace(/ئ/g, 'ي')
    .replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}
export function stem(token: string) {          // light stemmer
  return token.replace(/^(وال|بال|كال|فال|ال)/, '').replace(/(ات|ون|ين|ان|ها|ه)$/, '') || token;
}
export const toSearchText = (...parts: (string|undefined)[]) =>
  normalizeArabic(parts.filter(Boolean).join(' ')).split(' ').map(stem).join(' ');
```

### 1.5 App skeleton (`app.ts`)
Order of middleware: `pino-http` (traceId) → `helmet` → `cors` → `compression` → `express.json({limit:'1mb'})` → language (`Accept-Language`) → maintenance check → min-version check → global rate limit → routers under `/api/v1` → `/docs` Swagger → 404 → error handler. Export `createApp()` for tests; `server.ts` creates HTTP server + Socket.io and (if `RUN_WORKER`) starts the worker.

### 1.6 Prisma schema & first migration
Write `schema.prisma` from arch §8 (all models in §8.1–8.12; skip §8.13 until Phase 12). Then create a **second migration with raw SQL** (`prisma migrate dev --create-only --name extras`):
```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS listing_search_trgm ON "Listing" USING GIN ("searchText" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS listing_attrs_gin   ON "Listing" USING GIN ("dynamicAttributes" jsonb_path_ops);
CREATE INDEX IF NOT EXISTS listing_active_feed ON "Listing" ("categoryId","publishedAt" DESC) WHERE status='ACTIVE' AND "deletedAt" IS NULL;
CREATE INDEX IF NOT EXISTS listing_geo         ON "Listing" ("pubLat","pubLng") WHERE status='ACTIVE';
CREATE INDEX IF NOT EXISTS job_search_trgm     ON "Job" USING GIN ("searchText" gin_trgm_ops);
CREATE SEQUENCE IF NOT EXISTS invoice_number_seq START 1;
-- audit log is append-only
CREATE OR REPLACE FUNCTION audit_no_update() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'AuditLog is append-only'; END; $$ LANGUAGE plpgsql;
CREATE TRIGGER audit_no_update BEFORE UPDATE OR DELETE ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION audit_no_update();
```

**✅ Phase 0 done when:** `docker compose up db minio`, `npm run db:migrate`, `npm run dev`, `GET /api/v1/health` → 200, `/docs` loads.

---

## 2. Phase 1 — Foundation

Build in this order:
1. `adapters/*` interfaces + `console/mock` implementations (+ real SMTP, FCM, S3, Google Maps, social verifiers as thin wrappers). The console email adapter **stores the last OTP per email in memory** so `/dev/last-otp` can expose it when `DEV_HELPERS=true`.
2. `shared/messages.ts`: `msg(key, lang, vars)`; seed initial keys (errors + notification templates + email templates for OTP/reset/expiry/appointment/rental).
3. `shared/rateLimit.ts` limiter presets (arch §7.6).
4. `notify()` service (minimal now, completed in Phase 8): `notify(userId, type, vars, {dedupeKey?, data?})` → inserts `Notification` row, enqueues `notify.send`.
5. `jobs/index.ts`: create pg-boss, register queues, `boss.schedule(name, cron)` for the cron jobs (arch §11); `worker.ts` boots it; handlers added per module.
6. `GET /health`, `GET /health/ready`, `GET /config`, `GET /translations` (ETag helper `etag(json)`: weak sha1, 304 on match).
7. Dev helpers router (mounted only if `DEV_HELPERS && NODE_ENV!=='production'`): `GET /dev/last-otp?email=`.

**Tests:** settings cache refresh; audit chain verify detects tampering; idempotency replay; arabic normalize table-tests (`أحمد`/`احمد`, `مدرسة`/`مدرسه`, `سيارات`→stem equal to `سيار`).

---

## 3. Phase 2 — Auth, Users, Admin Auth (M01, M02, ADM-17/18)

### 3.1 Customer auth rules (implement exactly)
* **Register** `POST /auth/register`: normalize email lower-case; reject if exists (409 `EMAIL_TAKEN`); bcrypt(cost 12); create user (`emailVerifiedAt=null`); create OTP (6 digits, `codeHash=sha256(code+OTP_PEPPER)`, 10 min, attempts=0); send via enabled channel (EMAIL default). Response `{ userId, otpSentTo, resendAfterSec: 60 }`. Unverified users can login but are browse-only (`requireVerifiedEmail` → 403 `EMAIL_NOT_VERIFIED`).
* **OTP request**: enforce 60 s cooldown (`sentAt`), channel must be enabled (`flags.otp.*`) else 422 `OTP_CHANNEL_DISABLED`; invalidate older unused codes for same email+purpose.
* **OTP verify**: find latest unused unexpired code; `attempts>=5` → 429 `OTP_ATTEMPTS_EXCEEDED`; compare hash; increment attempts on wrong; on success set `usedAt`, and for `REGISTER` set `emailVerifiedAt` + issue tokens + record signup-funnel events (`otp_requested`, `otp_verified`, with time-to-verify) → AUTH-23.
* **Login**: lockout check via `LoginEvent` failures in the last window per `(email)` and per `(ip)`: after 5 fails apply delays `[1,5,15,60]` minutes (compute from the failure count beyond the 5th; return 429 `ACCOUNT_LOCKED` with `retryAfterSec`). Record every attempt (`SUCCESS|BAD_PASSWORD|LOCKED|SUSPENDED`). Suspended/banned → 403 `ACCOUNT_SUSPENDED` with `statusReason`. `DEACTIVATED` → reactivate on successful login. `PENDING_DELETION` → login allowed only to cancel (return flag `pendingDeletion:true`).
* **Tokens**: `issueTokens(user, device)` creates `Session(familyId=uuid)` and returns `{ accessToken (15m), refreshToken (opaque), expiresIn, user }`.
* **Refresh rotation** (AUTH-06):
```ts
async function refresh(token: string) {
  const hash = sha256(token);
  const s = await db.session.findFirst({ where: { refreshHash: hash } });
  if (!s) {
    // maybe a reused (already-rotated) token: check history table/column prevRefreshHash
    const reused = await db.session.findFirst({ where: { prevRefreshHash: hash } });
    if (reused) { await db.session.updateMany({ where:{ familyId: reused.familyId }, data:{ revokedAt:new Date() } }); throw E.unauthorized('REFRESH_REUSED'); }
    throw E.unauthorized('INVALID_REFRESH');
  }
  if (s.revokedAt) throw E.unauthorized('SESSION_REVOKED');
  const next = randomToken();
  await db.session.update({ where:{id:s.id}, data:{ prevRefreshHash: hash, refreshHash: sha256(next), lastActiveAt:new Date() } });
  return { accessToken: signAccess(s), refreshToken: next };
}
```
(add `prevRefreshHash String?` to `Session`.)
* **Social** `POST /auth/social/:provider`: `SocialVerifier.verify` → `{providerId,email,emailVerified}`. Find by `(provider,providerId)` → login. Else if `email && emailVerified` and a user exists → **link** (never duplicate, AUTH-08). Else if `email` and no user → create user with `emailVerifiedAt=now` (provider-verified). If no email, or Apple relay (`@privaterelay.appleid.com`), or unverified email → create account **without verified email** and respond `needsEmail:true`; the client then uses `POST /me/email/change` + `/me/email/confirm`. With `AUTH_MOCK=true`, accept `token="mock:<email>:<name>"`.
* **Sessions**: list (device, os, approxLocation from ip header `CF-IPCountry`/city placeholder, lastActive), revoke one/all others; revoking updates the in-memory session cache. **Login events** returns latest 20.
* **Password reset**: `forgot` always returns 200 (no user enumeration); `reset` verifies OTP, sets password, revokes all sessions.
* **Change email**: new email gets OTP (`CHANGE_EMAIL`), confirm swaps `email`, sets verified. **Phone**: `PATCH /me/phone` validates E.164-ish with `+249` priority (regex per country from `Country.dialCode`), stores in `phone`, `verifiedPhone` only via phone OTP flow ⚑.

### 3.2 Users
* `GET/PATCH /me`, `capabilities` (POST creates `UserCapability` + the matching profile: `DEALER` → requires business setup via `/business`; `EMPLOYER` → `EmployerProfile`; `SERVICE_PROVIDER` → `ServiceProfile`; `CANDIDATE` → `CandidateProfile` stub; `SELLER` automatic on first listing).
* Public profile `GET /users/:id`: name, avatar, join date, `ratingAvg/Count`, active listing count, response rate/time, badges, `phone` **never**.
* Verification request: stores private media keys, creates `VerificationRequest(PENDING)`; admin decides (Phase 11).
* Block/unblock; enforcement helper `assertNotBlocked(a,b)` used in chat/offers.
* `GET /me/dashboard`: counts (my listings by status, drafts, favorites, saved searches, applications, rentals, appointments, unread notifications) + last-30-day views/favorites/chats/whatsapp (from `ListingMetricDaily` + live today).

### 3.3 Admin auth (separate module)
* `POST /admin/auth/login {email,password}` → verify bcrypt, `isActive`, IP allow-list (if non-empty) → if `totpEnrolledAt` null: generate secret (`authenticator.generateSecret()`), store **encrypted** (AES-256-GCM using key derived from `JWT_ADMIN_SECRET`) and return `{needsEnrollment:true, mfaToken, otpauthUrl, secret}`; else `{mfaToken}`. `mfaToken` = JWT (5 min, purpose `mfa`).
* `POST /admin/auth/verify-2fa {mfaToken, code}` → `authenticator.check(code, secret)` (or `code===DEV_TOTP_FIXED_CODE` when non-production) → set `totpEnrolledAt` if first time → create `AdminSession(ip, userAgent)` → return `{accessToken (30m), refreshToken}`. Log IP every login.
* `requireAdmin` verifies admin JWT, session not revoked; `requirePerm(p)` uses `shared/permissions.ts`.
* Super Admin: CRUD admins (create returns temp password once), change role, deactivate, reset 2FA, list/revoke admin sessions. Seed one Super Admin from env.

**Tests (must pass):** register→verify→login; OTP cooldown/attempt limit/expiry; lockout delays; refresh rotation + **reuse revokes family**; revoked/suspended session rejected immediately; social link without duplicate; Facebook-no-email cannot post; customer token rejected on `/admin/*`; admin without 2FA cannot get tokens; moderator forbidden on settings.

---

## 4. Phase 3 — Geography, Catalog/EAV, Config, Seed (M03, M20, M21)

1. **Geo read APIs** + admin CRUD (Phase 11). Seed Sudan: states (Khartoum, Gezira, Red Sea, Kassala, River Nile, Northern, North Kordofan, South Kordofan, West Kordofan, North Darfur, South Darfur, West Darfur, Central Darfur, East Darfur, White Nile, Blue Nile, Sennar, Gedaref) with main cities (Khartoum, Omdurman, Bahri, Wad Madani, Port Sudan, Kassala, Atbara, El Obeid, Nyala, El Fasher, Kosti, Sennar, Gedaref, Dongola, …) in AR+EN, `Country SD (+249, SDG)`.
2. **Catalog service**
   * `getTree(countryId?)` – single query, build tree in memory, cache 60 s, ETag from `max(updatedAt)`+count. Hide `isArchived`/inactive; honor `CountrySetting.hiddenCategoryIds`.
   * Append virtual `{id:'OTHER', slug:'other', nameEn:'Other', nameAr:'أخرى', isOther:true}` to every children list in API response (CAT-02).
   * `getSchema(categoryId)`: walk ancestors, merge attributes by `attributeKey` (child overrides), exclude archived unless `?includeArchived=true` (used when editing a listing that already has it); return `{categoryId, version, etag, attributes:[...], postingRestricted, postingMessage, videoAllowed, maxPhotos}`.
   * `buildValidator(categoryId)` → Zod object from attributes: TEXT→string (regex/min/max), NUMBER→number(min/max), BOOLEAN, SINGLE_SELECT→enum(options), MULTI_SELECT→array(enum), DATE→ISO date, RANGE→`{min,max}` numbers, FILE_URL→string URL/mediaId. Required → mandatory else optional. **Cache validators by `(categoryId, version)`**.
   * Admin: create/update/reorder/archive/restore categories; attribute CRUD (key immutable after create; delete forbidden if used → archive); each change `schemaVersion++` for the category (and its descendants via `UPDATE ... WHERE id IN (descendants)`), audit entry, `preview` endpoint returns the same schema + a sample empty form.
   * Other-entry: `promote(entryId, {as:'SUBCATEGORY'|'OPTION', parentId|attributeKey, migrate:boolean})`.
   * `promoteToIndex` toggle → index helper from arch §7.2 (guard key regex!).
3. **Seed categories & attributes** (`prisma/seed.ts`). Use this compact spec (`key:TYPE` flags: `*`=required, `f`=filterable, `s`=searchable, `i`=promoteToIndex). Provide AR+EN labels for all. Options for select types as listed.

| Root → children | Attributes |
|---|---|
| **Vehicles (مركبات)** → Cars for Sale (New / Certified Pre-Owned / Used as `condition` option), Vehicle Rentals, Trucks & Heavy Vehicles, Rickshaws & Tuk-Tuks, Motorcycles, Spare Parts & Accessories, Automotive & Vehicle Services, Towing & Recovery, Computer Diagnostics | **Cars:** make:SINGLE f*,s · model:SINGLE (dependsOn make) f* · year:NUMBER f i* · mileage:NUMBER f i · transmission:SINGLE{manual,automatic} f · fuel:SINGLE{petrol,diesel,hybrid,electric} f · engineCc:NUMBER f · bodyType:SINGLE{sedan,suv,hatchback,pickup,van,coupe} f · dutyPaid:BOOLEAN f · regionalSpec:SINGLE{gcc,japan,usa,europe,other} f · condition:SINGLE{new,certified,used} f* · features:MULTI · vin:TEXT (private, never public) **Rentals:** vehicleType, dailyRate/weeklyRate/monthlyRate:NUMBER f i, deposit, mileageCapKm, withDriver:BOOLEAN f, conditions:TEXT, pickupNotes **Trucks:** axles, payloadTons f i, engineCc, hoursUsed, dutyPaid **Rickshaws:** engineCc, passengers, permitStatus **Parts:** partNumber s, oemOrAftermarket f, compatMake, compatModel, yearFrom, yearTo, condition **Services/Towing/Diagnostics:** serviceTypes MULTI, towType{flatbed,hook}, emergencyPhone, radiusKm, inspectionType, mobileDiagnostics:BOOLEAN, certificateVerified |
| **Real Estate (عقارات)** → Houses, Apartments (Furnished / Unfurnished), Villas, Land (Residential plots / Commercial / Agricultural), Shops, Offices, Warehouses, Buildings, Factories, Farms, Projects & Investments | areaValue:NUMBER f i*, areaUnit:SINGLE{sqm,sqft,acre} f, bedrooms f i, bathrooms f i, floor, yearBuilt, furnishing{furnished,unfurnished,semi}, finishing{basic,good,luxury} f, powerBackup MULTI{generator,solar}, security MULTI, parking, paymentTerms{upfront,instalments}, rentPeriod{daily,monthly,annual} (for RENT), neighborhood TEXT, wantedTransaction{buy,rent} (for WANTED), desiredAreaMin/Max, preferredLocations TEXT; **Projects:** developer, stage, completionDate:DATE, unitTypes MULTI, startingPrice i, brochure:FILE_URL |
| **Hotels & Accommodation** → Hotels, Guest Houses, Furnished Apartments, Long-stay Rentals | pricePerNight i, pricePerMonth i, rooms, beds, capacity f, amenities MULTI{wifi,power,security,ac,parking,breakfast,kitchen} f, starRating |
| **Equipment, Solar & Power** → Solar Panels, Solar Inverters, Batteries, Generators, Pumps, Tractors, Processing Machinery, Excavators & Construction | **Panels:** wattage f i, cellType{mono,poly}, warrantyYears **Inverters:** kva f i, pureSine:BOOLEAN, type{hybrid,offgrid,ongrid} f **Batteries:** chemistry{tubular,lithium,gel} f, capacityAh f i, voltage, warrantyYears **Generators:** kva f i, fuel{diesel,petrol}, soundproof:BOOLEAN, hoursRun **Machinery:** make, model, year, hours, capacity — all: installationIncluded:BOOLEAN f, delivery:BOOLEAN, warranty:BOOLEAN |
| **Livestock & Agriculture** → Cows, Sheep, Goats, Camels, Horses, Poultry, Crops & Commodities (Sorghum, Sesame, Cotton, Wheat, Gum Arabic) | **Livestock:** breed f, ageMonths, weightKg f, health/vaccination:SINGLE, headCount, bulkQuantity **Crops:** quantityTons f i, grade, harvestDate:DATE, delivery:BOOLEAN |
| **Electronics & Appliances** → Phones, Computers, TVs, Appliances, Other | condition f*, brand f s, model, warrantyMonths |
| **Women Fashion & Beauty** (Thobes/ثياب, Dresses, Cosmetics, Tailoring, Salon Services) · **Men Fashion** (Jellabiyas/جلابية, Formal, Casual, Shoes, Accessories) · **Children & Mothers** (School Wear, Toys, Baby Care, Strollers, Mother Equipment) · **Home & Furniture** (Furniture, Kitchen, Appliances, Office, Decor) · **Food & Consumer Goods** (Daily Essentials, Wholesale Produce, Beverages, Bulk Groceries) · **General Marketplace** | condition f, brand s, size/color where relevant, `moq`/`unit` for wholesale (shown only if wholesale flag) |
| **Jobs (وظائف)** → used for `Job.categoryId` (Drivers, Sales, IT, Construction, Healthcare, Education, Hospitality, Other…) | (jobs use their own form; no EAV attributes required) |
| **Services (خدمات)** → Freelancers, Repair, Cleaning, Other | serviceType s, rateType, rate |

Set `supportsCompare=true` for Cars, Real Estate subtypes, Electronics. Set `isVideoAllowed` true everywhere. Also seed: `Setting` defaults, `Translation` base keys (AR/EN), one Super Admin, `LegalDocumentVersion` (privacy/terms/trading rules v1), help articles skeleton, `ExchangeRate` SDG↔USD (placeholder, effective now), demo banners.

**Tests:** ETag returns 304; adding an attribute bumps version and appears in schema; archived attribute hidden in schema but accepted on existing listing; required change doesn't break old listing edit; `OTHER` appears in children; validator rejects wrong type.

---

## 5. Phase 4 — Media (M19)

* **Storage adapter** buckets: public (`listings/`, `avatars/`) and private (`docs/`, `receipts/`, `cv/`, `verification/`, `exports/`). Private uploads use SSE (`ServerSideEncryption:'AES256'`) when `S3_SSE=true`.
* `POST /media/images` (multer memory, limit from `media.photo.maxMB`, mime jpeg/png/webp/heic): 
```ts
const img = sharp(buf).rotate();                           // auto-rotate; sharp drops EXIF by default (do NOT call withMetadata)
const main = await img.clone().resize({ width:1920, height:1080, fit:'inside', withoutEnlargement:true }).webp({ quality:78 }).toBuffer();
const t400 = await img.clone().resize(400).webp({ quality:70 }).toBuffer();
const t150 = await img.clone().resize(150).webp({ quality:60 }).toBuffer();
const phash = await dhash(buf);                            // 64-bit: resize 9x8 grayscale, compare adjacent pixels → hex
```
  Reject blacklisted phash (Hamming ≤ 5 vs `Blacklist PHASH`) with 422 `IMAGE_NOT_ALLOWED`; call `ContentClassifier` for avatars/covers (PROF-12) and flagged ⇒ reject. Create `MediaAsset(attachedAt=null)`. Return `{id,url,thumbs:{s,m}}`. Data-Saver is a **client** choice: provide both `thumbs.s` (150) and `thumbs.m` (400).
* `POST /media/video`: check `flags.video.enabled`, category not in `media.video.disabledCategoryIds` (pass `?categoryId=`), multer to **disk** (temp), size ≤ `media.video.maxMB`; `ffprobe` → duration ≤ `media.video.maxSeconds`, codec/container sane; poster via `ffmpeg -ss 1 -frames:v 1`; upload mp4 + poster (WebP). Reject with localized `VIDEO_TOO_LONG|VIDEO_TOO_LARGE|VIDEO_DISABLED`. Delete temp file in `finally`. (`Idempotency-Key` supported.)
* `POST /media/documents`: PDF/JPG/PNG ≤ 10 MB → private bucket; returns `{id,key}`; compute sha256 (used for receipts).
* `GET /media/signed-url?mediaId=`: authorize via helper `canAccessMedia(user, asset)` → owner, or (employer with application containing the key), or admin with relevant perm; TTL **300 s**.
* Cleanup job: delete `MediaAsset` where `attachedAt IS NULL AND createdAt < now()-24h` (+ storage objects).
* Attach logic lives in listings/profile services: `attachMedia(ids, ownerId)` verifies ownership and sets `attachedAt`.

**Tests:** webp output, EXIF GPS removed, thumbnails exist, oversize rejected, video over limit rejected, private doc unreachable without signed URL, signed URL denied to other users, orphan cleanup.

---

## 6. Phase 5 — Listings (M04, M06) + Scan (TRS-01)

### 6.1 Create/Update service (single transaction)
Order of checks in `createListing(user, input, mode)`:
1. user active & email verified; not blacklisted (phone/email/device).
2. category exists, not archived, `postingRestricted=false` (else 422 `CATEGORY_POSTING_DISABLED` + message).
3. **Caps/rates** from settings: active count (`status IN (ACTIVE,PENDING_REVIEW)`) < cap (individual 50 / business 500, optional per-category override); created last hour < 5; last 24 h < 20 (halve if `user.fraudScore>=80`). → 422 `LISTING_CAP_REACHED|LISTING_RATE_LIMIT`.
4. `dynamicAttributes` via `buildValidator`. Price rules: price required unless category flags optional (jobs/services) or type WANTED (then `budgetMin/Max`). Currency ∈ SDG|USD. Price numeric range sanity (> 0, < 1e12).
5. `isCustomOther` → require `customOtherText` (≤80 chars), upsert `OtherEntry`.
6. media: ≤ `media.maxPhotos`; each owned; set order/cover (first = cover if none) → `ListingMedia` rows with `url/thumbUrl/phash` copied; `videoUrl/poster` if allowed.
7. location: lat/lng valid (Sudan bbox soft check); `pubLat/pubLng` = exact, or (if approx) `jitter(lat,lng,approxRadiusM, seed=listingId)` (deterministic offset ≤ radius).
8. `searchText = toSearchText(title, description, customOtherText, searchable attr values, category names)`; sanitize text (`sanitize-html` with no tags).
9. `qualityScore = computeQuality(...)`; `expiresAt = now + (category.expiryDays ?? settings.listing.expiryDaysDefault)`.
10. status: `DRAFT` if mode=DRAFT; else `ACTIVE`, **unless** a delayed-visibility rule matches (category + account age) → `PENDING_REVIEW`. 
11. insert Listing, ListingMedia, ListingEdit(`{op:'created'}`), analytics `listing_published` (funnel), enqueue `listing.scan` and `listing.notify-matches`.
12. Response includes `readableId`, `shareUrl = PUBLIC_WEB_URL/listing/<readableId>`.

`readableId = 'MARBOU-' + String(publicSeq).padStart(5,'0')` (auto-widens). Accept both UUID and readable ID in `GET /listings/:idOrReadable` (regex `^MARBOU-\d+$`).

**Quality score (LST-06)** pure function `computeQuality(l, schema, weights)`:
```ts
const w = weights; let s = 0;
s += w.titleDesc   * Math.min(1, (min(title.length,60)/60)*0.4 + (min(desc.length,300)/300)*0.6);
s += w.photos      * Math.min(1, photoCount / 5);                       // 5+ photos = full
s += w.requiredAttrs * (reqFilled / Math.max(1, reqTotal));
s += w.optionalAttrs * (optFilled / Math.max(1, optTotal));
s += w.location    * (hasCoords ? 1 : cityId ? 0.5 : 0);
s += w.video       * (hasVideo ? 1 : 0);
s += w.price       * (hasPrice ? 1 : 0);
return Math.round(s);   // weights sum to 100
```
`POST /listings/quality-preview` runs the same function without saving (real-time score).

### 6.2 Other endpoints/rules
* **Edit** (`PATCH`): only owner / business staff (Manager/Editor); re-validate; diff → `ListingEdit`; re-scan; if price decreased → enqueue `price-drop.check`; if status was `SOLD/EXPIRED` editing not allowed except renew.
* **Renew**: allowed for `EXPIRED` (within `listing.renewWindowDays`) or `ACTIVE` expiring (≤7 d): `expiresAt = now + days`, status ACTIVE, reset reminder flags. **Duplicate**: copy as DRAFT (no media ids duplicated if owner changed; copy media rows). **Sold**: `status=SOLD, soldAt`. **Delete**: `deletedAt=now()`. **Bulk**: loop with per-item permission check, return per-id result.
* **View counting**: in `GET /listings/:id` handler: `viewerKey = sha256(userId ?? X-Device-Id ?? ip)`, skip owner; `INSERT ... ON CONFLICT DO NOTHING` into `ListingView(listingId, viewerKey, day)`; if inserted → `UPDATE Listing SET viewCount=viewCount+1`; also emit `AnalyticsEvent(listing_view)` (async, don't block).
* **Detail payload** (DET-01..): media (cover first), specs from schema labels, seller card (badges, rating, response), `contactOptions` flags only (booleans), `pubLat/pubLng`, banners flags (`isSold`, `isExpired`, `isSuspended`), breadcrumbs, `readableId`, similar-count, `areaUnit` conversion if requested (`?areaUnit=sqft` converts `areaValue` using factors sqm=1, sqft=0.092903, acre=4046.86), price-per-sqm if applicable.
* **Contact reveal** `POST /listings/:id/contact-reveal {channel}`:
  1. If listing owner chose to hide that channel (`contactOptions`) → 403 `CONTACT_HIDDEN`.
  2. Policy: `SIGNED_IN_ONLY` and guest → 401. Else for guests count `RevealLog`(deviceId or ip, last 24 h) ≥ `limits.guestRevealsPerDay` → 429 `REVEAL_LIMIT`. Signed-in users unlimited but add fraud signal if > 100/day.
  3. Return `{phone}` for CALL, or `{waUrl:'https://wa.me/<digits>?text=<encoded template>'}` for WHATSAPP using `whatsapp.template.<lang>` with `{title},{listingId},{price}`. Record lead event (`whatsapp|call`). **No other endpoint ever returns a phone number.**
* **Wanted listings** are listings with `listingType=WANTED` + `budgetMin/Max`.
* **Business inventory**: if `businessId` provided, caller must be Manager/Editor/owner of that business.

### 6.3 Scan job (`listing.scan`) — implement per arch §9.2
`jobs` function signature `scanListing(id)`; keep each check as a tiny pure function returning `{signal, weight}[]`; store `ScanResult`; update `riskScore`; apply auto-hide / alert / PENDING_REVIEW→ACTIVE. Duplicate detection SQL:
```sql
SELECT id FROM "Listing"
WHERE id <> $1 AND "deletedAt" IS NULL AND status IN ('ACTIVE','AUTO_HIDDEN')
  AND ("ownerId" = $2 OR "contactOptions"->>'phone' = $3)
  AND similarity("searchText", $4) >= 0.85
LIMIT 5;
```
Image duplicate: for each new `phash`, find `ListingMedia` with the same hash from a listing of another owner (exact match is enough for v1; near-match by Hamming distance is optional).

### 6.4 Listing jobs
`listing.expire` (every 15 min): `UPDATE "Listing" SET status='EXPIRED' WHERE status='ACTIVE' AND "expiresAt"<now()` + notify owners (type `listing_expired`). `listing.expiry-reminders` (hourly): select ACTIVE with `expiresAt` between now+6d..7d and not yet reminded (add `reminded7 Boolean @default(false)` and `reminded1 Boolean @default(false)` columns to `Listing`; reset both on renew).

**Tests:** create → visible in search within seconds (call search directly); caps/rate-limit 422; required attribute missing 400; custom Other stored + OtherEntry count; draft → publish; delayed-visibility rule → `PENDING_REVIEW` then scan clean → ACTIVE; approx location never leaks exact lat/lng; contact reveal limits (guest 21st reveal → 429); response never contains phone; readable ID lookup; view counter counts once/24 h and excludes owner; renew works; bulk actions; edit writes ListingEdit.

---

## 7. Phase 6 — Search, Home, Compare, Insights, Saved Searches, Favorites (M05, M22 part)

### 7.1 Search implementation (single function `searchListings(params, viewer)`)
Build SQL with `Prisma.sql` fragments and `Prisma.join`; **never string-concatenate user input**.
```ts
const where: Prisma.Sql[] = [
  Prisma.sql`l.status='ACTIVE'`, Prisma.sql`l."deletedAt" IS NULL`, Prisma.sql`l."expiresAt" > now()`,
  Prisma.sql`l."countryId" = ${countryId}` ];
if (p.categoryId) where.push(Prisma.sql`l."categoryId" = ANY(${descendantIds(p.categoryId)})`);   // cached recursive CTE
if (p.cityId) where.push(Prisma.sql`l."cityId" = ${p.cityId}`);
if (p.type) where.push(Prisma.sql`l."listingType" = ${p.type}::"ListingType"`);
if (qTokens.length) for (const t of qTokens)                                          // each token must match (ILIKE) or be similar
  where.push(Prisma.sql`(l."searchText" ILIKE ${'%'+t+'%'} OR l."searchText" % ${t})`);
if (p.lat != null) { const b = bbox(p.lat,p.lng,p.radiusKm);
  where.push(Prisma.sql`l."pubLat" BETWEEN ${b.minLat} AND ${b.maxLat} AND l."pubLng" BETWEEN ${b.minLng} AND ${b.maxLng}`); }
for (const f of dynamicFilters(p.filters, schemaAttrs)) where.push(f);               // see below
```
`dynamicFilters`: for each `key` in `filters` JSON → look up attribute in the category schema (ignore unknown keys; require `isFilterable`) →
* SINGLE_SELECT/BOOLEAN/TEXT: `l."dynamicAttributes" @> ${JSON.stringify({[key]: value})}::jsonb`
* MULTI_SELECT: `l."dynamicAttributes" -> ${key} ?| ${values}`
* NUMBER/RANGE: `(l."dynamicAttributes"->>${key})::numeric BETWEEN ${min} AND ${max}` (only when value is numeric — guard with `CASE WHEN ... ~ '^[0-9.]+$'`; simplest: store NUMBER values as JSON numbers and use `jsonb_typeof(...)='number'` condition).
* DATE: `(l."dynamicAttributes"->>${key})::date BETWEEN ...`

Score & select (subquery so keyset can use it):
```sql
SELECT * FROM (
  SELECT l.id, l."publicSeq", l.title, l.price, l.currency, l."pubLat", l."pubLng", l."cityId", l."qualityScore", l."publishedAt", l."ownerId",
         (0.45*COALESCE(similarity(l."searchText", $q),0)
         + 0.25*exp(-extract(epoch FROM ($asOf - l."publishedAt"))/86400/14.0)
         + 0.20*l."qualityScore"/100.0
         + 0.10*least(1, ln(1+l."viewCount"+3*l."favoriteCount"+5*l."leadCount")/6)) AS score,
         <haversine> AS "distanceKm"
  FROM "Listing" l WHERE <all where> ) t
WHERE (<sortCol>, id) < ($cursorValue, $cursorId)         -- direction depends on sort
ORDER BY <sortCol> DESC, id DESC LIMIT $limit+1
```
Sort map: `relevance→score DESC`, `newest→publishedAt DESC`, `price_asc→price ASC NULLS LAST`, `price_desc→price DESC`, `distance→"distanceKm" ASC`. Cursor = `{v: lastSortValue, id, asOf}`. Haversine fragment (in `shared/geo.ts`): `6371*2*asin(sqrt(sin(radians(l."pubLat"-$lat)/2)^2 + cos(radians($lat))*cos(radians(l."pubLat"))*sin(radians(l."pubLng"-$lng)/2)^2))` and additionally `WHERE distanceKm <= radius`.
Currency filter: if `currency` given and rate is fresh → compare `price * rate(listingCurrency→currency)` via `CASE`; if rate stale (>7 d) → only same-currency rows.
Hydrate IDs with media cover + seller badge in one extra query (`findMany where id in`) preserving order. **Never** include phone. Add `Cache-Control: public, max-age=15` only for anonymous requests without geo.
After responding: async `SearchLog` insert (`resultCount`, zero-result flag).

* `GET /search/suggest`: top 5 listing titles via `similarity` + category name matches, from normalized prefix; cache 30 s per query.
* `GET /home`: `{banners, categories(top-level w/ icon), recent (12), popular (by engagement last 7 d), nearby (if lat/lng)}` cached 60 s per country+lang (skip nearby from cache).
* `GET /nearby`, `GET /recommendations`: based on user's last 5 `SearchLog` categories + favorites' categories (fallback to popular).
* `GET /compare?ids=`: validate 2–4 ids all with the same root category having `supportsCompare`; return `columns=[{id,title,price,currency,sellerVerified}]`, `rows=[{key,labelAr,labelEn,values[]}]` from attributes where `showInCompare` (default all filterable) — matrix, aligned.
* **Price insight** `GET /listings/:id/price-insight`:
```sql
SELECT count(*)::int n, percentile_cont(0.5) WITHIN GROUP (ORDER BY price_in_target) median,
       min(price_in_target) lo, max(price_in_target) hi
FROM ( SELECT price * <rate to listing currency at listing date> AS price_in_target FROM "Listing"
       WHERE "categoryId"=$cat AND id<>$id AND price IS NOT NULL
         AND (status='ACTIVE' OR (status='SOLD' AND "soldAt" > now()-interval '90 days')) AND "deletedAt" IS NULL
         AND <key attributes match: same make/model/year±2 etc. from schema attrs flagged showInCompare> ) c;
```
  `n < insight.minComparables (8)` ⇒ `{available:false}`. Label: price < median*(1-0.15) ⇒ `BELOW`, > median*(1+0.15) ⇒ `ABOVE`, else `FAIR`. Exclude cross-currency rows when rate stale (LOC-04/SRCH-13). Cache 10 min.
* **Saved searches**: CRUD; `listing.notify-matches` job: load saved searches with `frequency=INSTANT` and category match (category or ancestor), re-run `searchListings({...saved.query, onlyListingId: newId})` → if hit → `notify(user,'saved_search_match')` with dedupe key `ss:<savedId>:<listingId>`. `DAILY` frequency: digest cron (optional).
* **Favorites** (`POST/DELETE /listings/:id/favorite`): store `priceAtSave`; maintain `favoriteCount`; `price-drop.check` notifies favoriters when new price < old (also notify on SOLD/EXPIRED/HIDDEN status change — hook in status-change helper `onListingStatusChanged()`).

**Tests:** Arabic variants return the same results (أحمد/احمد, سيارة/سياره); filters (year range, KVA range, make/model, boolean); radius & distance sort; keyset pagination no duplicates across pages; hidden/sold/expired excluded; zero-result logging; compare 2–4 limit + mismatched category → 422; insight returns BELOW/FAIR/ABOVE with seeded data and `available:false` with <8; saved-search notification on matching publish. **Perf test** (§12.4) at 100k listings.

---

## 8. Phase 7 — Chat & Offers (M07)

* `sockets/chat.ts`: `io.of('/chat')` with `io.use` auth middleware verifying access JWT and session (same checks as `requireAuth`). On connect join room `user:<id>`; `thread:join` verifies participant (buyer/seller/business staff) then joins `thread:<id>`. If `REDIS_URL` → `createAdapter(pub, sub)`.
* **Service functions** (used by both REST and socket): `getOrCreateThread`, `sendMessage`, `markRead`, `makeOffer`, `respondOffer`. Socket handlers call the same service; REST is the **fallback** (MSG-12) so web/mobile polling `GET /threads/:id/messages?after=` works when websocket is unavailable.
* `sendMessage(user, threadId, {type, body, attachmentMediaId, idempotencyKey})`:
  1. participant check; `assertNotBlocked`; listing owner ≠ self for new thread; email verified.
  2. throttle: counts from DB in last minute (user ≤ 20, user→recipient ≤ 10); same normalized text to ≥ 3 distinct recipients in 10 min ⇒ create FraudSignal + `Report(reporterId=null)` auto-flag; link-spam (≥ 3 URLs) flagged; banned phrases → 422 `MESSAGE_BLOCKED`.
  3. insert with `idempotencyKey`; on unique violation → return the existing message (**retry yields exactly one message**).
  4. update `thread.lastMessageAt`; emit `message:new` to `thread:<id>` and `user:<recipient>`; if the recipient has no socket in that room → enqueue push `new_message` (dedupe key `msg:<threadId>:<minuteBucket>`).
  5. `deliveredAt` set when recipient's socket receives it (client emits `message:delivered`, or server sets on emit if recipient online); `readAt` set by `markRead`.
* **Offers**: `makeOffer` → creates `ChatMessage(type=OFFER)` + `Offer(PENDING)`; `accept` (only non-offerer; sets ACCEPTED, adds SYSTEM message `Agreed price`), `reject`, `counter` (marks old COUNTERED, creates new Offer with `counterOfId`). Emit `offer:updated`. Currency must match listing or be one of SDG/USD.
* **Unread counters**: `unreadCount = count(messages in thread where senderId<>me AND readAt IS NULL)`; aggregated endpoint `GET /threads/unread-count`.
* **Business inbox**: if thread `businessId` set, staff with role MANAGER/SUPPORT can read/reply; message stores `handledByStaffId`.
* **Mute/Block/Report**: `PATCH /threads/:id/mute`, block via users module, report via `/reports` (`targetType=CONVERSATION`) which marks thread visible to moderators; moderators can fetch **only reported threads** (`GET /admin/reports/:id/conversation`).
* Thread payload includes `listingState` (`ACTIVE|SOLD|EXPIRED|REMOVED`) for the banner (MSG-09) and `waUrl` shortcut computed from listing template (MSG-10; does not expose number in thread payload — the shortcut goes through contact-reveal).
* **Quick replies** CRUD for sellers/business.
* Response-rate job (nightly): for each seller, `responseRate = threads with a seller reply within 24h / threads started in last 30 d`, `avgResponseMin = avg first-reply delay`.

**Tests:** socket integration test with `socket.io-client` (two users exchange message < 2 s); retry with same key ×3 ⇒ 1 row; blocked user rejected; throttle; offer flow (offer→counter→accept) with final price on both sides; unread counters; REST fallback returns messages after cursor; push enqueued only when recipient not in room.

---

## 9. Phase 8 — Notifications (M16)

* `notify(userId, type, vars, opts)`:
  1. load user language & `NotificationPreference` for the type's **category** (`messages|offers|listings|saved_searches|jobs|rentals|appointments|account|marketing`); in-app row is **always** created; push/email only if enabled for that category.
  2. render localized `{title, body}` from `messages.ts` template `notif.<type>`.
  3. dedupe: unique `(userId, dedupeKey)` → skip if exists.
  4. enqueue `notify.send` with `{notificationId, channels}` (retries 3×, exponential backoff, failure logged in `EmailOutbox`/job table).
* Push: `PushAdapter.send(tokens)`; remove tokens reported invalid. Email: transactional templates for OTP, reset, expiry reminders, rental/appointment updates (NTF-03).
* **All triggers** (NTF-04) must call `notify`: new message, new offer/offer response, listing published, listing expiring (7d/1d), listing hidden/suspended/auto-hidden/restored, saved-search match, price drop, application status change, CV delivered, rental update, appointment confirmed/updated/reminder, verification outcome, report outcome, appeal decision, payment decision, staff invite, review received.
* Endpoints: list (cursor), mark read, read-all, unread count; preferences GET/PATCH (per category × push/email); device tokens upsert/remove.
* **Broadcasts** (admin): `Broadcast` with audience filter (`all|role (capability)|city|categoryInterest`) + `scheduledAt`; `broadcast.dispatch` cron picks due, resolves users in pages of 500, calls `notify` with `type='broadcast'`, writes stats `{targeted, sent, failed}`.

**Tests:** preference off ⇒ no push but in-app exists; dedupe; push failure retried; localized text by user language; broadcast targets only matching users.

---

## 10. Phase 9 — Verticals (M08, M10, M11, M14)

### 10.1 Rentals (AUTO-09..13)
Create: listing must be in a Rentals category (or `listingType=RENT` with `isRentalCapable` attribute set); renter ≠ owner; dates valid (start ≥ today, end > start, ≤ 365 d); email verified; not blocked; `termsSnapshot = {dailyRate, weeklyRate, monthlyRate, deposit, mileageCapKm, withDriver, conditions, currency, title, readableId}`; notify owner (push+email). Transitions per arch §9.4 with permission checks (only owner: ACCEPT/DECLINE/COUNTER/COMPLETE; only renter: CANCEL / accept counter) — implement a tiny transition table `{from→action→to, actor}` and reuse for appointments & inquiries.
### 10.2 Appointments (AUTO-14..18)
* `PUT /me/service-profile` validates `workingHours` (HH:mm pairs), `slotMinutes` (15–240), `capacityPerSlot` ≥ 1.
* **Slots** `GET /providers/:id/slots?date=YYYY-MM-DD`:
```ts
function slotsFor(profile, date, booked: Map<string,number>) {
  const ranges = profile.workingHours[dayName(date)] ?? [];
  const out = [];
  for (const [from, to] of ranges)
    for (let t = toMin(from); t + profile.slotMinutes <= toMin(to); t += profile.slotMinutes) {
      const startsAt = atTz(date, t, profile.timezone);          // Africa/Khartoum default
      const remaining = profile.capacityPerSlot - (booked.get(startsAt.toISOString()) ?? 0);
      if (startsAt > new Date() && remaining > 0) out.push({ startsAt, remaining });
    }
  return out;
}
```
* **Booking** inside `db.$transaction` with `SELECT id FROM "ServiceProfile" WHERE id=$1 FOR UPDATE`, re-count bookings (`REQUESTED|CONFIRMED`) for that slot, reject 409 `SLOT_FULL`. Images: `imageMediaIds` ≤ 5.
* Actions via transition table; `COMPLETE` sets `completedAt`; `USER_CONFIRM`/`DISPUTE`; review eligibility computed by `isReviewEligible()` (confirmed, or `completedAt + 72h < now && !disputedAt`). Jobs: reminders (24 h/2 h; push, email fallback if no device tokens) and confirm-window.
### 10.3 Hotels (HOT-04..08)
Inquiry create (dates, guests, message) → notify host; `CONFIRM_STAY` by the host only, allowed any time on or after the check-in date; guest `DISPUTE` within 72 h; availability blocks CRUD (host) and `GET /listings/:id/availability` merges blocks (+ reservations when engine ON). Filters (price/night, amenities, capacity, rating) work through EAV search; rating = host's `ratingAvg`.
### 10.4 Jobs (JOB-01..21)
* Employer capability required (auto-granted on first `PUT /me/employer-profile`). Create job: validate fields, `searchText`, `expiresAt = deadline ?? now+30d`, scam scan (`scamPatterns(text)` ⇒ riskScore; if `moderation.delayedVisibility` matches Jobs → `PENDING_REVIEW`), notify alert matches.
* Job list/search: trigram on `searchText`, filters (category, city, type, salary range), only `ACTIVE & not expired`, keyset pagination.
* **Apply** `POST /jobs/:id/apply {tier, quick?{...}, profileDocKeys?, answers?}`: checks (verified email, job active, not own job, ≤20/day, unique per job → 409 `ALREADY_APPLIED`); Quick requires fullName, phone, email, city; Full requires complete `CandidateProfile` (name, phone/email, ≥1 education or experience) and snapshots it; `documentKeys` = chosen subset of the candidate's own private keys; notify employer; status SUBMITTED.
* **Employer dashboard**: `GET /jobs/:id/applications?status=` returns snapshot **without document keys**, only candidate-provided fields; opening an application marks VIEWED (notify candidate). `PATCH /applications/:id` statuses; notes. Document access endpoint per arch §9.6 (signed URL 300 s).
* **Candidate**: `GET/PUT /me/candidate-profile` (validates JSON arrays: education[], experience[], languages[{name,level∈NATIVE|FLUENT|INTERMEDIATE|BASIC}], skills[]); documents upload via `/media/documents` then attach keys; delete any time (also remove keys from future shares; past applications keep their snapshot until job retention).
* **CV build**: `POST /cv-requests` with structured payload (validate with Zod), `GET /me/cv-requests`; admin portal Phase 11; candidate `approve` (only when `DELIVERED`) / `revision {note}` (→ `REVISION_REQUESTED`). `GET /me/candidate-profile/cv.html?layout=classic|modern|compact` renders HTML (server-side template strings, RTL aware) for client print-to-PDF (JOB-12).
* Withdraw, alerts (CRUD) → `listing.notify-matches` equivalent for jobs (`job.notify-matches`).
### 10.5 Business (BIZ-01..09)
* `POST /business` creates profile (slug from name, unique), grants `DEALER` capability, `UserCapability`; verification via `/me/verification kind=BUSINESS` ⇒ on approval sets `verifiedAt` + `VERIFIED_BUSINESS` badge.
* Public: `GET /business/:idOrSlug` (profile, hours, location, active count, badge, rating), `/business/:id/listings` with filters.
* Staff: invite (email token hash, 7 days) → email link `PUBLIC_WEB_URL/business/join?token=` → `POST /business/staff/accept` (must be signed in; email must match). Permission helper `businessRole(userId, businessId)`: OWNER > MANAGER (all but staff mgmt) > EDITOR (listings) > SUPPORT (inbox only). **All business endpoints verify membership** (scope limit).
* Analytics `GET /business/:id/analytics?from&to`: from `ListingMetricDaily` (+ today's live from `AnalyticsEvent`): views, uniqueViews, leads (chat/whatsapp/call), conversion = leads/uniqueViews, top listings (top 10 by leads), search impressions (count of events `search_impression` for business listings), audience cities (counts only, from `cityId` of viewers if known — **aggregated only, no personal data**). CSV variant streams `text/csv`.
* Bulk actions → `/listings/bulk`. Shared inbox → chat module.

**Tests:** rental happy path + wrong-actor 403 + terms snapshot unchanged after listing edit; appointment double-booking race (two parallel requests, capacity 1 ⇒ one 409); slot disappears at capacity; reminders create notifications once; job apply limits and duplicates; employer cannot open docs of non-applicant (403) and can for applicant (URL expires ≤5 min); CV flow statuses; staff scope; hotel review blocked until CONFIRMED_STAY.

---

## 11. Phase 10 — Trust & Safety, Reviews (M15)

* **Reports** `POST /reports`: validate target exists, one open report per (reporter,target) (409), reporter email verified. Compute `priority = reportCount*10 + fraudScore + reporterReliability` (reporterReliability = actioned/total reports of reporter ×20). Visible in `GET /admin/reports` ordered by priority — within one minute (it is synchronous). **Auto-hide**: after insert, count distinct reporters in last `windowHours` for that listing ≥ `reports (5)` ⇒ status `AUTO_HIDDEN` (+ `statusReason='REPORTS'`), notify owner with reason + appeal link, audit as SYSTEM.
* **Moderation actions** (`/admin/listings/:id/hide|suspend|delete|restore`, `PATCH` edit): require `reasonCode` (enum: `SCAM, PROHIBITED, DUPLICATE, WRONG_CATEGORY, MISLEADING, SPAM, OTHER`), write `ModerationAction` + audit + notify owner + resolve related reports. `onListingStatusChanged()` hook triggers favoriters/threads banners.
* **User sanctions** (`suspend` with optional days → `statusUntil`; `ban`; `restore`): sets status, **revokes all sessions** (and clears session cache), hides listings of banned users, audit. A cron lifts expired suspensions.
* **Appeals**: owner of a `ModerationAction` target can appeal once per action; admin decides `UPHELD|OVERTURNED` (overturned ⇒ restore listing); notify; audit.
* **Blacklist** CRUD (PHONE/EMAIL/DEVICE/KEYWORD/PHASH); checked at register (email/device), listing scan, media upload (phash), messages (keywords).
* **Fraud score** `computeFraud(subject)` per arch §9.8, called by scan + report + reveal-abuse + receipt flags; thresholds from settings; ≥70 creates alert in `moderation/flagged`.
* **Reviews**: `POST /reviews {context, contextRef, rating(1–5), body?}` → `assertQualifying(context, contextRef, reviewerId)` implementing arch §9.9 queries; unique constraint ⇒ 409; update subject rating aggregates in the same transaction (`ratingAvg = avg(rating)` from VISIBLE reviews). `POST /reviews/:id/reply` by subject (once). Admin hide ⇒ recompute.
* **Safety center** `GET /safety-center`: static tips from `HelpArticle(category='safety')` + my reports (status) + my blocks.
* **Delayed visibility (TRS-15)** is evaluated in listing create (Phase 5); admin moderation queue lists `PENDING_REVIEW` items; approve ⇒ `ACTIVE`.

**Tests:** report → appears in queue; 5 distinct reporters ⇒ AUTO_HIDDEN and search excludes it; moderator action without reasonCode ⇒ 400; appeal flow; blacklisted phone ⇒ flagged; review rejected without qualifying interaction, accepted with one; duplicate review 409; ban revokes sessions immediately; audit entries exist for each admin action and chain verifies.

---

## 12. Phase 11 — Admin, CMS, Analytics, Data Rights, Payments (M17, M22–M25)

### 12.1 Payments (Bankak)
Implement per arch §9.10. `PaymentPurposeHandler` registry: `{ SUBSCRIPTION: {onApproved}, CREDITS: {...}, PROMOTION: {...}, TEST: {onApproved: noop} }` (only `TEST` needed at launch so the queue can be accepted at UAT). Duplicate detection queries on `reference` and `receiptHash`. Admin list with filters/state, detail with receipt **signed URL**, approve/reject (reason enum), CSV export. All state changes audited. User endpoints guarded by `flags.bankak.userFlow`; admin endpoints **always available**.
### 12.2 Admin dashboard APIs
KPIs query counts (cache 15 s); user/listing management endpoints per arch §10.10; verification decisions (approve ⇒ add badge + notify; reject requires reason; documents auto-deleted 90 days after decision by retention job); system health: DB ping latency, pg-boss queue sizes (`SELECT name, state, count(*) FROM pgboss.job GROUP BY 1,2`), error counts (in-memory ring buffer), process uptime, last `JobRun`s, geo usage, stale FX alert.
### 12.3 CMS / content
* Help articles, static pages, banners (placement + schedule + language/country targeting), legal versions (`POST /admin/legal` creates a new version with `effectiveAt`; `GET /legal/:type` returns latest effective; `requiresAcceptance` ⇒ `/config` returns `pendingLegal:[...]` for the signed-in user; `POST /legal/:type/accept`), translations upsert + missing keys, country settings, exchange rates (new row = new rate; `GET /exchange-rate` returns latest and `stale` if > 72 h (alert) / `suppressed` if > 7 d), app version (`app.minVersion`), maintenance (`app.maintenance`).
* **SEO**: `GET /public/listings/:id/meta` → `{title, description, image, canonical, jsonLd(Product/RealEstateListing/JobPosting where relevant), alternates:{ar,en}}`; `GET /sitemap.xml` (index) + `/sitemap-listings-:n.xml` (45k URLs per file, ACTIVE only, cached 1 h) + categories/business/job sitemaps; `GET /robots.txt`. Deep-link association files (`/.well-known/apple-app-site-association`, `/.well-known/assetlinks.json`) served from config values (`LINKS_IOS_APP_ID`, `LINKS_ANDROID_SHA256`).
* Support tickets: create (guest with email or user), messages, admin reply (SUPPORT_AGENT), status.
* Public account-deletion page backend: `POST /public/account-deletion {email}` → always 200; if user exists send email link/OTP to confirm → then same grace flow.
### 12.4 Analytics
* `POST /events` accepts batches ≤ 50, validates type ∈ whitelist (`session_start, search, listing_view, favorite, lead_chat, lead_whatsapp, lead_call, apply, rental_request, appointment_request, post_step_<n>, post_published, search_impression, signup_step`), **rejects/strips PII keys** (email, phone, name), stores `userHash = HMAC(userId, ANALYTICS_SALT)`; respects a `consent` boolean (if false → drop non-essential).
* Admin analytics endpoints (+CSV): overview (new users, active users DAU/WAU/MAU from `AnalyticsEvent`/`Session.lastActiveAt`), retention (D1/D7/D30 cohorts), listings by category, search trends & zero-result queries (from `SearchLog`), posting funnel (counts per `post_step_n` → drop-off %), conversion, Other-entries top list, signup funnel (AUTH-23: OTP delivered/verified rate, median time-to-verify, drop-off + the **OD-01 trigger flag** if >30% fail at OTP over 14 days).
* Scheduled CSV reports (ANL-05): optional `ReportSchedule` table — implement only on demand.
### 12.5 Data rights (M22)
Implement `export.build` and `account.deletion` jobs per arch §9.11; endpoints; deactivate. `DataExport` file stored in private bucket `exports/<userId>/<id>.json`, link expires 24 h.
### 12.6 Retention job
Implements Appendix D with a table of `{table, where, olderThan}` rules; each run logs a `JobRun` with purged counts. OTP: delete used/expired older than 24 h; LoginEvent/Session > 12 mo; AnalyticsEvent > 13 mo (after rollup); ChatMessage 24 mo after last message in thread (reported threads held); verification docs 90 d after decision; Listing soft-deleted > 90 d (then media via orphan job); IdempotencyKey > 24 h.

**Tests:** payment duplicate detection flags; moderator forbidden on payment approve (403) while auditor allowed; approve creates invoice number sequence; settings change audited with before/after; disabling the last OTP channel refused (422); legal version acceptance; sitemap contains only ACTIVE; analytics rejects PII; export JSON contains user data; deletion job anonymizes and audit verify still passes; retention purge logs JobRun.

---

## 13. Phase 12 — Dormant Engines (M18) — build last, minimum bar only

Create `modules/engines/<name>/` with tables (arch §8.13), routes under `/engines/<name>` (user) and `/admin/engines/<name>` (SA), all via `flag: 'flags.engine.<name>'` (returns 404 when OFF) plus `flags.monetization` for pricing UI exposure; `GET /config` exposes only enabled engines. Implement the exact behaviors in arch §9.12 (Appendix B). One test file per engine covering: flag OFF ⇒ 404; flag ON happy path; core invariant (quota enforced / no negative credits / atomic bids / overlap prevention / MOQ validation / expiry job). Hotel reservations & wholesale are part of this phase. **If time is short, deliver Phase 13 first, then this phase.**

---

## 14. Phase 13 — Hardening & Delivery

1. **Swagger:** every route registered; `GET /openapi.json` + `/docs`. `scripts/export-openapi.ts` writes `openapi.json`.
2. **Security pass:** run through arch §7.8; `npm audit --omit=dev`; verify no endpoint leaks phone/exact coords/document keys; verify rate limits on auth/search/messages/reveal/upload.
3. **Seed demo data:** `prisma/seed-demo.ts` creates ~10 users (seller, buyer, employer, candidate, dealer, provider, moderator…), 60 listings across verticals with media placeholders, threads, a rental, an appointment, jobs + applications, reports. `prisma/seed-load.ts` generates **100k listings** for perf tests.
4. **README.md:** how to run (`docker compose up`, migrate, seed), env vars, adapters, scripts, admin login/2FA enrollment, restore-from-backup steps, scale-out steps.
5. **CI (`.github/workflows/ci.yml`):** services: postgres; steps: install → prisma generate → migrate deploy → lint → typecheck → test → build.
6. **Backups:** `scripts/backup.sh` (`pg_dump | gzip` → upload to object storage); document restore + run one restore drill.

---

## 15. Testing Guide

### 15.1 Automated tests (Vitest + Supertest)
* **Setup:** `docker compose up -d db minio`; `.env.test` points to DB `marbou_test`; `test/setup.ts` runs `prisma migrate deploy` once, then truncates tables between files (`TRUNCATE ... RESTART IDENTITY CASCADE` except seeded reference tables or re-seed minimal categories/settings per file); adapters forced to `console/mock`.
* **Helpers (`test/helpers.ts`):** `createApp()`, `registerAndLogin(email?) → {token, user}` (uses `/dev/last-otp`-equivalent in-process OTP spy), `loginAdmin(role)` (uses `DEV_TOTP_FIXED_CODE`), `makeCategoryWithSchema()`, `makeListing(token, overrides)`, `factory.*` for direct DB inserts.
* **Per-module minimum test matrix** (each test file covers all four columns):

| Module | Happy path | Auth/permission | Validation | Key business rule |
|---|---|---|---|---|
| auth | register→verify→login→refresh | admin token on user route 401 | weak password, bad OTP | lockout delays, refresh reuse revokes family, OTP cooldown/attempts |
| users | profile, capability grant | blocked user can't chat | bad phone | verified phone unique, unverified not unique |
| catalog | tree, schema ETag 304 | non-SA can't edit | duplicate attributeKey | archive not delete, Other promote |
| media | image→webp+thumbs | private doc 403 to others | oversize/mime | EXIF stripped, signed URL ≤5 min |
| listings | create→get→edit→renew→sold→delete | non-owner 403 | missing required attr | caps/rate limits, approx location privacy, no phone in payload, instant publish |
| search | keyword, filters, radius, sort, paging | — | bad filter json | Arabic variants, hidden/sold excluded, stable keyset |
| chat | send/receive, offer flow, read receipts | non-participant 403 | empty message | idempotent retry, throttle, block |
| notifications | list/read/unread-count | other's notification 404 | — | preferences, dedupe, localization |
| rentals/appointments/hotels | full lifecycle | wrong actor 403 | invalid dates | no double booking, terms snapshot, confirm window |
| jobs | post→apply→status→hire | employer-only docs | duplicate apply 409 | daily limit, doc access scope, CV statuses |
| business | create, staff invite/accept, analytics | staff scope | — | CSV export, aggregated-only |
| trust | report→action→appeal | moderator reason required | — | auto-hide at 5 reporters, reviews need interaction, audit written |
| payments | submit→approve→invoice | moderator 403 | missing receipt | duplicate ref/receipt flagged, staging flag |
| admin/settings | flag toggle visible in `/config` ≤60 s (use fake timers/force reload) | non-SA 403 | last OTP channel refused | before/after audit |
| data rights | export, deletion grace, deactivate | — | — | anonymization, audit chain intact |

* **Coverage target:** ≥ 70 % on `modules/*/service.ts` and `shared/*` (`vitest --coverage`).
* **Resilience tests:** adapters throwing (email/push/classifier/maps down) ⇒ request still succeeds, retry queued; Google cap reached ⇒ `/geo/autocomplete` returns `{degraded:true}`.

### 15.2 Manual smoke test (curl) — 12 steps
```bash
BASE=http://localhost:4000/api/v1
# 1 register + OTP (dev helper shows the code)
curl -X POST $BASE/auth/register -H 'Content-Type: application/json' -d '{"email":"seller@test.com","password":"Passw0rd!","fullName":"Seller One"}'
CODE=$(curl -s "http://localhost:4000/dev/last-otp?email=seller@test.com" | jq -r .code)
curl -X POST $BASE/auth/otp/verify -H 'Content-Type: application/json' -d "{\"email\":\"seller@test.com\",\"code\":\"$CODE\",\"purpose\":\"REGISTER\"}"   # → accessToken
# 2 categories + schema
curl $BASE/categories | jq '.[0].id'; curl $BASE/categories/<id>/schema
# 3 upload image (multipart) → mediaId
curl -X POST $BASE/media/images -H "Authorization: Bearer $T" -F file=@car.jpg
# 4 create listing (instant publish) → readableId
# 5 search (public) incl. Arabic variant & filters
# 6 contact-reveal as guest (X-Device-Id header) – 21st call must return 429
# 7 second user chats → offer → counter → accept
# 8 rental request → owner accepts
# 9 appointment slots → book → provider confirms → completes → user confirms → review
# 10 job post → quick apply → employer views → shortlist
# 11 report listing x5 (5 users) → AUTO_HIDDEN → disappears from search
# 12 admin login (+2FA) → toggle flag → GET /config reflects within 60 s → audit-logs/verify = ok
```

### 15.3 Acceptance checklist (maps to PRD acceptance criteria)
- [ ] Register + email OTP verify < 2 min; disabling a channel stops codes ≤ 60 s; last channel cannot be disabled.
- [ ] Revoked session cannot call any authenticated endpoint; Facebook-no-email user cannot post until email verified.
- [ ] Adding an attribute in admin appears in `/categories/:id/schema` (new ETag) and in search filters; every category has `OTHER`.
- [ ] Listing visible in search ≤ 10 s; a server-side draft can be resumed from another device; renewal restores an expired listing (form autosave is client-side only).
- [ ] Arabic spelling variants return the same results; range filter on promoted attr p95 < 500 ms at 100k listings.
- [ ] Bulk scraping of listing endpoints yields **no phone numbers**; guest reveal cap enforced.
- [ ] Message arrives < 2 s; accepted offer shows agreed price both sides; 3 retries ⇒ 1 message; push enqueued when away.
- [ ] Rental request notifies owner; booked slot disappears at capacity; no double booking under concurrency.
- [ ] Quick Apply works with 4 fields; employer cannot open non-applicant's docs; docs URL expires ≤ 5 min.
- [ ] Hotel review impossible before host marks Confirmed Stay.
- [ ] Reported listing in moderator queue ≤ 1 min; appeal produces decision + notification; erased account leaves no PII in audit and chain verifies.
- [ ] Moderator cannot access finance/flags/EAV; Finance Auditor reads but cannot alter audit logs or admin roles.
- [ ] Config change appears in audit log with actor, time, before/after.
- [ ] Data export works; deletion request → grace → anonymized.
- [ ] With Bankak flag ON (staging) a receipt shows in queue immediately; duplicates flagged; decision notifies user; OFF in production config.
- [ ] Fresh clone: `docker compose up` + migrate + seed runs; Swagger loads; all tests green.

### 15.4 Performance smoke test
```bash
npm run seed:load                         # 100k listings
npx autocannon -c 50 -d 20 "http://localhost:4000/api/v1/search?q=%D8%AA%D9%88%D9%8A%D9%88%D8%AA%D8%A7&filters=%7B%22year%22:%7B%22min%22:2015%7D%7D&limit=20"
npx autocannon -c 100 -d 20 http://localhost:4000/api/v1/categories      # expect 304/cached, median < 100 ms
```
Targets (arch/PRD NFR): search p95 < 500 ms; cached reads median < 100 ms; listing create p95 < 800 ms (excluding upload). If search is slow: `EXPLAIN ANALYZE`, ensure trigram + partial indexes used, create expression indexes for hot attributes (`promoteToIndex`), reduce `similarity` to ILIKE-only for long queries.

---

## 16. Postman

### 16.1 Generate the collection (no manual typing)
```bash
npm run postman        # exports openapi.json then converts → postman/marbou.postman_collection.json
```
In Postman: **Import** → `postman/marbou.postman_collection.json` and the two environment files below. (Alternative: Postman → Import → Link → `http://localhost:4000/openapi.json`.)

### 16.2 Environments (`postman/local.postman_environment.json`)
```json
{
  "name": "MARBOU Local",
  "values": [
    {"key":"baseUrl","value":"http://localhost:4000/api/v1","enabled":true},
    {"key":"devUrl","value":"http://localhost:4000/dev","enabled":true},
    {"key":"deviceId","value":"11111111-1111-4111-8111-111111111111","enabled":true},
    {"key":"email","value":"seller1@test.com","enabled":true},
    {"key":"password","value":"Passw0rd!","enabled":true},
    {"key":"adminEmail","value":"admin@marbou.test","enabled":true},
    {"key":"adminPassword","value":"Admin#12345","enabled":true},
    {"key":"accessToken","value":"","enabled":true},{"key":"refreshToken","value":"","enabled":true},
    {"key":"adminToken","value":"","enabled":true},{"key":"adminRefresh","value":"","enabled":true},
    {"key":"categoryId","value":"","enabled":true},{"key":"mediaId","value":"","enabled":true},
    {"key":"listingId","value":"","enabled":true},{"key":"threadId","value":"","enabled":true},
    {"key":"offerId","value":"","enabled":true},{"key":"rentalId","value":"","enabled":true},
    {"key":"jobId","value":"","enabled":true},{"key":"applicationId","value":"","enabled":true},
    {"key":"reportId","value":"","enabled":true},{"key":"paymentId","value":"","enabled":true}
  ]
}
```
Create a `staging` copy with the staging `baseUrl` (and no `/dev` — dev helpers are disabled outside dev/test; on staging use a real mailbox or a seeded verified user).

### 16.3 Collection-level scripts
**Collection → Pre-request Script** (adds headers & token):
```js
pm.request.headers.upsert({ key: 'X-Device-Id', value: pm.environment.get('deviceId') });
pm.request.headers.upsert({ key: 'Accept-Language', value: 'en' });
const isAdmin = pm.request.url.getPath().includes('/admin/');
const t = pm.environment.get(isAdmin ? 'adminToken' : 'accessToken');
if (t && !pm.request.headers.has('Authorization')) pm.request.headers.add({ key:'Authorization', value:'Bearer '+t });
if (['POST','PUT','PATCH'].includes(pm.request.method) && !pm.request.headers.has('Idempotency-Key'))
  pm.request.headers.add({ key:'Idempotency-Key', value: pm.variables.replaceIn('{{$guid}}') });
```
**Collection → Tests** (generic assertions):
```js
pm.test('no 5xx', () => pm.expect(pm.response.code).to.be.below(500));
pm.test('response time < 1500ms', () => pm.expect(pm.response.responseTime).to.be.below(1500));
if (pm.response.code >= 400) pm.test('error envelope', () => pm.expect(pm.response.json()).to.have.nested.property('error.code'));
```
**Token capture** — put in the *Tests* tab of `POST /auth/otp/verify`, `/auth/login`, `/auth/social/*`:
```js
const j = pm.response.json();
if (j.accessToken) { pm.environment.set('accessToken', j.accessToken); pm.environment.set('refreshToken', j.refreshToken); }
```
`POST /admin/auth/verify-2fa` Tests: `pm.environment.set('adminToken', j.accessToken); pm.environment.set('adminRefresh', j.refreshToken);`
Other captures: create listing → `pm.environment.set('listingId', j.id)`; media upload → `mediaId`; threads → `threadId`; etc.

### 16.4 Automating OTP and admin 2FA in Postman (dev/test only)
* Before `POST /auth/otp/verify`, add a **Pre-request** script calling the dev helper:
```js
pm.sendRequest({ url: pm.environment.get('devUrl') + '/last-otp?email=' + pm.environment.get('email'), method:'GET' },
  (err, res) => { if (!err) pm.variables.set('otp', res.json().code); });
```
  Request body: `{"email":"{{email}}","code":"{{otp}}","purpose":"REGISTER"}`.
* Admin login: step 1 `POST /admin/auth/login` (Tests: save `mfaToken` in env), step 2 `POST /admin/auth/verify-2fa` body `{"mfaToken":"{{mfaToken}}","code":"000000"}` (fixed code only when `NODE_ENV!=production` and `DEV_TOTP_FIXED_CODE` set). On staging use a real authenticator app for the seeded admin.

### 16.5 Folder order for a full run (Collection Runner / Newman)
Rename/ordering the generated folders so they run top-to-bottom:
`00 Health & Config` → `01 Auth (register, OTP, login, refresh, sessions)` → `02 Profile & Capabilities` → `03 Admin Login (2FA)` → `04 Catalog & Geo` → `05 Media` → `06 Listings (create, get, edit, renew, sold)` → `07 Search & Discovery` → `08 Favorites & Saved Searches` → `09 Chat & Offers` → `10 Rentals` → `11 Appointments` → `12 Hotels` → `13 Jobs & CV` → `14 Business` → `15 Reports, Moderation, Appeals, Reviews` → `16 Notifications` → `17 Payments (staging flag ON)` → `18 Admin: Users, Listings, Settings, Content, Audit, Analytics` → `19 Data Rights` → `20 Cleanup`.
Use two users: `seller1@test.com` and `buyer1@test.com` (add variables `buyerToken`/`buyerId`; in requests that need the buyer, override the `Authorization` header with `Bearer {{buyerToken}}`).

**Run from CLI (CI-friendly):**
```bash
npm i -g newman
newman run postman/marbou.postman_collection.json -e postman/local.postman_environment.json --delay-request 50 --reporters cli,junit
```
Add this as an optional CI job after the API is started against the seeded test DB. Use `--folder "06 Listings"` to run one module.

### 16.6 What every Postman request must include
* Example valid body (from the Zod schema) and **at least 2 tests**: status code + key field (`readableId` matches `/^MARBOU-\d{5,}$/`, no `phone` key in listing JSON, `nextCursor` present on lists, etc.).
* Negative examples saved as separate requests: missing token (401), wrong role (403), invalid body (400), rate-limit (429) — name them `… [NEG] …`.

---

## 17. Final Delivery Checklist (agent must confirm)

- [ ] All phases 0–11 implemented; phase 12 implemented or explicitly listed as deferred in README.
- [ ] `npm run typecheck`, `npm test`, `npm run build` all green; coverage ≥ 70 % on services.
- [ ] `docker compose up` boots API (+worker), migrations run, seed runs, Swagger at `/docs`.
- [ ] `postman/` contains the generated collection + local & staging environments; Newman run passes on seeded data.
- [ ] `.env.example` complete; production start-up guard rejects dev flags/weak secrets.
- [ ] README documents: run, test, seed, admin login/2FA enrollment, adapters switch-over (SMTP, FCM, S3/R2, Google Maps, social login IDs, SMS/WhatsApp), flag list, backup/restore, scale-out steps.
- [ ] A short `DEVIATIONS.md` lists any place where the implementation differs from the PRD or architecture file, with the reason.
