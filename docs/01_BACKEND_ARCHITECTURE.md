# MARBOU — Backend Architecture (Simplified & Scalable)

> **Audience:** the coding agent that will build the MARBOU backend.
> **Companion file:** `02_BACKEND_IMPLEMENTATION_GUIDE.md` (step-by-step build + testing + Postman).
> **Source of truth for features:** `MARBOU_PRD_V3.md` (26 modules, M01–M26). This document keeps **every user-facing feature** of the PRD but replaces heavy technology choices with simpler ones. Requirement IDs (AUTH-05, LST-13 …) are quoted so you can trace back to the PRD.
> **Frontend is already finished.** If the frontend repo is available to you, **match its API client** (route names, request/response shapes) before inventing new ones. Where it is silent, follow the endpoint catalogue in §10.

---

## 1. Design Principles

1. **One codebase, two entry points.** `api` (HTTP + Socket.io) and `worker` (background jobs). Same Docker image, different command. For a tiny single-server deployment the API can run the worker in-process (`RUN_WORKER=true`).
2. **Modular monolith, feature folders.** One folder per module; no cross-module imports except through that module's `service.ts`.
3. **PostgreSQL does the heavy lifting** (JSONB for EAV, `pg_trgm` for fuzzy search, `percentile_cont` for price insights, `FOR UPDATE`/advisory locks for atomicity). **No Elasticsearch, no PostGIS, no Kafka, no BullMQ.**
4. **Redis is optional.** Everything works without it (in-memory cache, rate limit, socket). Setting `REDIS_URL` turns on horizontal-scale mode (shared rate limits, Socket.io Redis adapter).
5. **Everything configurable lives in one `Setting` table** (feature flags, Appendix C defaults, media limits, OTP channels, app versions, maintenance, WhatsApp templates). Cached 60 s in memory → satisfies "changes take effect within 60 seconds" (AUTH-15, SYS-01).
6. **Third parties sit behind small adapter interfaces** (email, SMS, WhatsApp, push, storage, content-classifier, maps, social-login verifiers) with a **console/mock implementation by default**, so the whole system runs and is testable with zero external accounts.
7. **Write the simplest thing that meets the acceptance criterion.** If a PRD item needs an expensive technology, use the "Simple approach" in §2 and leave a `// SCALE-UP:` comment with the upgrade path.

---

## 2. PRD → Simplified Decisions (read this first)

| PRD says | We build | Why / upgrade path |
|---|---|---|
| NestJS + shared package `@ahmed-org/marketplace-core` | **Express 4 + TypeScript**, feature folders, a single `defineRoute()` helper that validates (Zod), authorizes, and registers OpenAPI docs in one declaration. Shared code lives in `src/shared`. | Less boilerplate. Can be extracted to a package later. |
| Prisma + PostGIS + partitioning + hand-written GIN/expression indexes | **Prisma + plain PostgreSQL** (`pg_trgm` extension only). Listing location = `lat`/`lng` floats + bounding-box prefilter + Haversine in SQL. Optional index helper for `promoteToIndex` attributes (§7.2). | PostGIS & partitioning not needed below ~1M rows. **SCALE-UP:** add PostGIS column + partition by `createdAt`. |
| BullMQ + Redis queues | **pg-boss** (queue + cron inside PostgreSQL, retries, dead-letter included). | No extra infra. Same worker code works with any queue later. |
| Elasticsearch-style ranking | **SQL scoring**: trigram similarity + freshness + quality + engagement, keyset pagination. | Fast enough for 100k+ listings with indexes. |
| Chunked/resumable video upload + ffmpeg transcoding worker | Client already compresses video (MED-05). Server accepts **one multipart upload**, validates with `ffprobe` (duration, size, codec), extracts poster with `ffmpeg`. **No server transcoding**; reject with a clear localized error if over limits. | Keeps the worker light. **SCALE-UP:** S3 multipart + ffmpeg transcode job. |
| Separate FeatureFlag, RemoteConfig, Defaults-console tables | **One `Setting` table** (key → JSON). | One mechanism for ADM-09/10/15/16/23, SYS-01/02. |
| Separate VehicleMake/VehicleModel/PropertyProject/ServiceSlot tables | Makes/models/types are **EAV option lists with `dependsOn`**; project fields are EAV attributes; service slots are **computed** from `workingHours`, `slotMinutes`, `capacityPerSlot` and existing appointments. | Fewer tables, fewer admin screens. |
| 12 dormant monetization/commerce engines | Built last (Phase 12), each **minimum to the PRD Appendix B bar**, behind `requireFlag()`. | They are hidden at launch; build only after core is stable. |
| Google Maps via gateway with caps | `GET /geo/autocomplete` & `/geo/reverse` proxy with a DB-backed **daily counter + hard cap**; on cap → returns `{degraded:true}` and client falls back to manual city/pin. | GEO-03/04/05. |
| Content classification, hash-list source | `ContentClassifier` adapter; default = no-op "safe". Perceptual hash = small built-in **dHash via `sharp`**; blacklist table. | Provider chosen by client later (OD-04). |
| SMS & WhatsApp OTP | Adapters implemented with a **mock + one generic HTTP provider shape**; flags OFF. | AUTH-13/14/21. |
| Argon2id | **bcryptjs** (cost 12). | No native build issues. Allowed by NFR-SEC-02. |
| PDF CV export (JOB-12) | Server renders **HTML CV layouts** (`/me/candidate-profile/cv.html?layout=`); **client prints to PDF**. Arabic shaping in server PDF libs is unreliable. | Optional later: headless Chromium. |
| Offline sync | **Out of scope** (PRD §13.1). Only server-side drafts. | — |

---

## 3. Final Technology Stack

| Concern | Choice |
|---|---|
| Runtime | Node.js 20 LTS, TypeScript (strict) |
| HTTP | Express 4, `helmet`, `cors` (allow-list), `compression`, `express-rate-limit` |
| Validation + Docs | **Zod** + `@asteasolutions/zod-to-openapi` → Swagger UI at `/docs`, JSON at `/openapi.json` |
| DB | PostgreSQL 15/16 + **Prisma** ORM (+ raw SQL through `prisma.$queryRaw` for search/insights) |
| Queue/Cron | `pg-boss` |
| Real-time | `socket.io` (+ `@socket.io/redis-adapter` only if `REDIS_URL`) |
| Cache | in-memory TTL map; optional `ioredis` |
| Auth | `jsonwebtoken` (HS256), `bcryptjs`, `otplib` (admin TOTP), `google-auth-library`, `jose` (Apple/Facebook JWKS & Graph checks) |
| Storage | S3-compatible via `@aws-sdk/client-s3` + presigner (**MinIO** locally, R2/S3 in prod) |
| Images | `sharp` (WebP, thumbnails, EXIF strip, dHash) |
| Video | `ffprobe`/`ffmpeg` binaries (installed in Docker image) |
| Email | `nodemailer` (SMTP) behind `EmailAdapter`; `console` driver in dev |
| Push | `firebase-admin` behind `PushAdapter`; `console` driver in dev |
| Logging/Errors | `pino`, optional Sentry |
| Tests | `vitest` + `supertest`, Postman/Newman |
| Packaging | Docker, docker-compose (api, worker, postgres, minio; redis optional) |

---

## 4. Runtime Topology

```
 Mobile / Web / Admin  ──HTTPS──►  [ API process ]  ──► PostgreSQL  (data + pg-boss queue + cron)
        │                          │  Express REST  /api/v1
        └──WebSocket(Socket.io)──► │  Socket.io /chat   (JWT-auth, rooms per thread)
                                   │  Swagger /docs
                                   ├──► S3/R2/MinIO  (public media bucket + private docs bucket)
                                   ├──► Redis (OPTIONAL: rate-limit store, socket adapter)
                                   └──► Adapters: Email, Push(FCM), SMS, WhatsApp, Maps, Classifier
                         [ WORKER process ]  (same image: `node dist/worker.js`)
                                   └─ pg-boss handlers + cron: scan, expiry, reminders,
                                      notifications, cleanup, export, deletion, rollups, broadcasts
```

* API and worker are **stateless** → scale by adding instances behind a load balancer. Sockets need sticky sessions **or** Redis adapter.
* All timestamps stored UTC. Money = `Decimal(14,2)` + `Currency` (SDG|USD), never converted silently.

---

## 5. Folder Structure

```
marbou-backend/
├─ prisma/
│  ├─ schema.prisma
│  ├─ migrations/                 # prisma migrate + 1 hand-written SQL (pg_trgm + indexes)
│  └─ seed.ts                     # countries, geo, categories+attributes, settings, admin, legal, i18n
├─ src/
│  ├─ server.ts                   # API entry (express + socket.io)
│  ├─ worker.ts                   # worker entry (pg-boss)
│  ├─ app.ts                      # express app factory (used by tests)
│  ├─ config/env.ts               # zod-validated env
│  ├─ shared/
│  │  ├─ db.ts                    # prisma singleton
│  │  ├─ route.ts                 # defineRoute() helper (+ OpenAPI registry)
│  │  ├─ errors.ts                # AppError + error codes + handler
│  │  ├─ auth.ts                  # requireAuth, optionalAuth, requireAdmin, requirePerm, requireCapability
│  │  ├─ settings.ts              # Setting cache + getters + audit on change
│  │  ├─ audit.ts                 # hash-chained audit log
│  │  ├─ idempotency.ts           # Idempotency-Key middleware
│  │  ├─ rateLimit.ts             # factory (memory|redis)
│  │  ├─ i18n.ts                  # t(lang,key), localized error/notification text
│  │  ├─ pagination.ts            # cursor encode/decode
│  │  ├─ arabic.ts                # normalizeArabic(), stem()
│  │  ├─ crypto.ts                # hash(), randomToken(), otp()
│  │  ├─ geo.ts                   # bbox(), haversine SQL fragment, jitter()
│  │  └─ money.ts                 # convert() with exchange-rate staleness rules
│  ├─ adapters/                   # email, push, sms, whatsapp, storage, classifier, maps, social
│  │  └─ <name>/{index.ts, console.ts, real.ts}
│  ├─ modules/
│  │  ├─ auth/ users/ admin-auth/ catalog/ geo/ media/ listings/ search/
│  │  ├─ chat/ notifications/ rentals/ appointments/ hotels/ jobs/ business/
│  │  ├─ trust/ (reports, moderation, appeals, reviews, blacklist, fraud, scan)
│  │  ├─ payments/ engines/ (dormant M18) / content/ (help, legal, pages, banners, tickets, sitemap)
│  │  ├─ dashboard/ (favorites, export, deletion) / analytics/ / admin/ (aggregated admin routes)
│  │  └─ <module>/{routes.ts, service.ts, schemas.ts, jobs.ts?, *.test.ts}
│  ├─ jobs/                       # queue names, registry, cron schedule
│  └─ sockets/chat.ts
├─ test/                          # integration tests, factories, helpers
├─ postman/                       # generated collection + environments
├─ docker-compose.yml  Dockerfile  .env.example  README.md
```

**Module file contract:** `routes.ts` (only `defineRoute` calls) → `service.ts` (business logic, Prisma) → `schemas.ts` (Zod). Routes never touch Prisma directly.

---

## 6. Module Map (PRD → folder → URL prefix)

| PRD | Folder | Prefix | Notes |
|---|---|---|---|
| M01 | `auth` | `/auth` | register, OTP, login, social, refresh, sessions |
| M02 | `users` | `/me`, `/users` | profile, capabilities, verification, blocks, badges |
| M03 | `catalog` | `/categories`, `/admin/categories` | tree, schema+ETag, Other, promote |
| M04 | `listings` | `/listings`, `/me/listings` | lifecycle, quality, duplicates, renew, bulk |
| M05 | `search` | `/search`, `/home`, `/compare`, `/saved-searches` | |
| M06 | `listings` | `/listings/:id/contact-reveal` | lead channels |
| M07 | `chat` | `/threads`, `/offers`, socket `/chat` | |
| M08 | `rentals`, `appointments` | `/rental-requests`, `/providers`, `/appointments` | |
| M09 | (EAV only) | — | area conversion in listing serializer |
| M10 | `jobs` | `/jobs`, `/applications`, `/me/candidate-profile`, `/cv-requests` | |
| M11 | `hotels` | `/inquiries`, `/listings/:id/availability` | |
| M12, M13 | (EAV seed) | — | categories & attributes only |
| M14 | `business` | `/business` | |
| M15 | `trust` | `/reports`, `/reviews`, `/appeals` | |
| M16 | `notifications` | `/notifications` | |
| M17 | `payments` | `/payments` | |
| M18 | `engines` | `/engines/*` | all behind flags |
| M19 | `media` | `/media` | |
| M20 | `geo` | `/geo` | |
| M21 | `content` + settings | `/config`, `/translations` | |
| M22 | `dashboard` | `/me/favorites`, `/me/export`, `/me/deletion` | |
| M23 | `content` | `/help`, `/legal`, `/pages`, `/banners`, `/sitemap*` | |
| M24 | `admin`, `admin-auth` | `/admin/*` | |
| M25 | `analytics` | `/events`, `/admin/analytics` | |
| M26 | `shared`, `jobs` | `/health`, `/admin/system-health` | |

---

## 7. Cross-Cutting Design

### 7.1 API conventions (PRD §10.1)
* Base path `/api/v1`. JSON only. `Authorization: Bearer <accessJWT>`.
* **Error envelope:** `{ "error": { "code": "LISTING_CAP_REACHED", "message": "<localized by Accept-Language>", "details": {...}, "traceId": "..." } }`. HTTP codes: 400 validation, 401 unauth, 403 forbidden, 404, 409 conflict, 422 business-rule, 429 rate limit, 503 maintenance.
* **Success:** return the resource directly or `{ data, nextCursor }` for lists.
* **Pagination:** cursor (opaque base64). `?limit=20&cursor=...` (max 50).
* **Idempotency:** `Idempotency-Key` header honored on `POST /threads/:id/messages`, `/media/*`, `/payments/bankak`, `/listings`, `/rental-requests`, `/appointments`, `/jobs/:id/apply`.
* **ETag/Cache-Control:** `/categories`, `/categories/:id/schema`, `/config`, `/translations`, `/help`, `/legal/*` → weak ETag from content hash, honor `If-None-Match` → `304`.
* **Language:** `Accept-Language: ar|en` (default `ar`) selects error/notification text; payloads carry both `nameAr`/`nameEn`.
* **Device header:** `X-Device-Id` (client-generated UUID) used for unique views, contact-reveal caps, sessions.
* **Maintenance mode:** global middleware returns 503 + localized banner payload when `app.maintenance.enabled` (admin routes exempt).
* **Min app version:** header `X-App-Version` + `X-Platform`; if below `app.minVersion.<platform>` → 426 `APP_UPDATE_REQUIRED` (ADM-15).

### 7.2 Dynamic EAV (M03)
* `Listing.dynamicAttributes` JSONB = `{ attributeKey: value }`. Validated on write against the category's **active** attributes: build a Zod schema at runtime from `CategoryAttribute` rows (type, required, min/max/regex, options). Unknown keys → rejected; archived keys already on the listing → kept.
* `GET /categories/:id/schema` returns attributes (including **inherited from ancestors**, nearest wins), ordered; ETag = hash of (schemaVersion). `Category.schemaVersion` Int is bumped by every attribute/option/category change; the ETag is `W/"<categoryId>-<version>"` (parent change bumps all descendants lazily by also hashing the ancestor versions).
* **Other option:** every picker returns a virtual `OTHER` entry. If listing sets `isCustomOther=true` + `customOtherText` → upsert `OtherEntry(categoryId,text normalized)` and increment `count`. Admin `promote` converts it into a new subcategory or attribute option and optionally migrates matching listings (`UPDATE ... SET categoryId=...`).
* **Required-flag change** applies to new listings/edits only (CAT-16) — never re-validate old rows.
* **`promoteToIndex`:** when toggled on for a NUMBER/DATE attribute, run `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_attr_<key> ON "Listing" ((("dynamicAttributes"->>'<key>')::numeric))` — `<key>` MUST match `^[a-z][a-z0-9_]{1,40}$`. Toggle off → `DROP INDEX`. Nice-to-have; do it after search works.
* Option dependencies: option item `{value, labelEn, labelAr, dependsOn?: {attr, value}}` (Make→Model, Region→City).
* New data types need a client release (PRD 4.1); the 8 types are fixed: TEXT, NUMBER, BOOLEAN, SINGLE_SELECT, MULTI_SELECT, DATE, RANGE, FILE_URL.

### 7.3 Settings / flags / defaults
Table `Setting(key PK, value JSON, updatedBy, updatedAt)`. Loaded fully into memory, refreshed every 60 s and on local write. API: `settings.get<T>(key)`, `settings.set(key, value, actor)` (writes audit before/after). `requireFlag('flags.engine.auctions')` middleware → 404 when off (so hidden). **Registry (all seeded):**

| Key | Default |
|---|---|
| `flags.otp.email` / `.sms` / `.whatsapp` | true / false / false (**never allow all three registration channels false** — AUTH-15) |
| `flags.video.enabled` | true; `media.video.disabledCategoryIds` = [] |
| `flags.bankak.userFlow` | **false** in production, **true** in staging (PAY-13) |
| `flags.monetization` | false |
| `flags.engine.{subscriptions,promotions,credits,boosts,auctions,barter,assetRental,cart,delivery,admob,wholesale,hotelReservations}` | false |
| `flags.contactReveal.policy` | `"GUESTS_RATE_LIMITED"` (or `"SIGNED_IN_ONLY"`); `limits.guestRevealsPerDay`=20 |
| `moderation.delayedVisibility` | `[]` (rules `{categoryId, maxAccountAgeDays}`; empty = OFF everywhere) |
| `limits.activeListingsIndividual` / `Business` | 50 / 500 (+ optional per-category override map) |
| `limits.listingsPerHour` / `PerDay` | 5 / 20 |
| `limits.applicationsPerDay` | 20 |
| `media.maxPhotos` | 10; `media.video.maxSeconds`=30; `media.video.maxMB`=15; `media.photo.maxMB`=8 |
| `listing.expiryDaysDefault` | 30 (category overrides via `Category.expiryDays`); `listing.renewWindowDays`=30; reminders at 7 and 1 days |
| `quality.weights` | `{titleDesc:25, photos:25, requiredAttrs:20, optionalAttrs:10, location:10, video:5, price:5}` |
| `dup.textSimilarity` | 0.85 |
| `moderation.autoHide` | `{reports:5, windowHours:24, fraudScore:85}`; `fraud.alert`=70; `fraud.rateLimit`=80 |
| `insight.minComparables` / `bandPct` | 8 / 15 |
| `fx.staleAlertHours` / `fx.staleSuppressDays` | 72 / 7 |
| `auth.lockout` | `{maxFails:5, delaysMin:[1,5,15,60]}` |
| `chat.throttle` | `{perMinute:20, perRecipientPerMinute:10, sameTextRecipients:3, sameTextWindowMin:10}`; `chat.reviewMinMessagesEach`=2; `chat.bannedPhrases`=[] |
| `appointment.confirmWindowHours` | 72 |
| `deletion.graceDays` | 30 |
| `app.minVersion` | `{ios:"1.0.0", android:"1.0.0"}`; `app.maintenance` `{enabled:false, messageAr, messageEn, from, to}` |
| `whatsapp.template.ar` / `.en` | e.g. `"مرحباً، مهتم بـ {title} ({listingId}) بسعر {price}"` |
| `maps.googleDailyCap` | 1000; `maps.perUserPerDay` 50; `maps.perIpPerDay` 100 |
| `contact.support` | `{email, phone, whatsapp}` |
| `currencies.enabled` | ["SDG","USD"]; `countries` handled in `CountrySetting` table |

### 7.4 AuthN / AuthZ
* **Users:** access JWT 15 min (`sub`, `sid`=sessionId, `fam`) signed with `JWT_USER_SECRET`; refresh token = random 48 bytes, stored as SHA-256 in `Session.refreshHash`, **rotated on every use**. Reuse of an old refresh hash ⇒ revoke whole `familyId` (AUTH-06). `requireAuth` loads the session from a 30 s in-memory cache keyed by `sid` to check `revokedAt` and user `status` (suspend/ban ⇒ instant invalidation — AUTH-19; cache is also invalidated locally on revoke).
* **Verified-email gate (AUTH-01/22):** `requireVerifiedEmail` on post/message/apply/offer/rental/appointment/review. Social users with no/relay email stay browse-only until verified.
* **Capabilities:** `UserCapability` rows; `requireCapability('EMPLOYER')`. Granted self-service via `POST /me/capabilities` (PROF-10) — setup data goes to the corresponding profile (EmployerProfile, BusinessProfile, ServiceProfile).
* **Admins:** separate `AdminUser` + `AdminSession`; signed with `JWT_ADMIN_SECRET`, 30-min access, sliding; **login = password then TOTP** (enrollment on first login); IP logged in `AdminSession.ip`; optional `ipAllowlist` check; Super Admin can revoke admin sessions. Customer tokens are rejected on `/admin/*` and vice-versa.
* **RBAC permission map** (one file `shared/permissions.ts`; guard `requirePerm('x')`):

| Role | Permissions |
|---|---|
| SUPER_ADMIN | `*` |
| CONTENT_MODERATOR | `listings.moderate`, `users.suspend`, `reports.manage`, `appeals.manage`, `blacklist.manage`, `verification.review`, `analytics.read`, `users.read` |
| SUPPORT_AGENT | `tickets.manage`, `cv.manage`, `verification.review`, `users.read`, `lookup.rentals_appointments`, `analytics.read` |
| FINANCIAL_AUDITOR | `payments.decide`, `payments.read`, `auditlog.read`, `analytics.read`, `users.read` |

Only SUPER_ADMIN: categories/EAV, settings/flags/defaults/media limits, content, translations, geo, country settings, admin management, broadcasts, exchange rates.

### 7.5 Audit log (TRS-12, SYS-10)
Insert-only table. `hash = sha256(prevHash + JSON({actorType,actorId,action,entity,entityId,before,after,createdAt}))`. Serialize inserts with `pg_advisory_xact_lock(777)` inside the transaction so the chain stays linear. **Never store emails/names/phones in `before/after`** — only IDs and non-personal fields. `GET /admin/audit-logs/verify` recomputes the chain. No UPDATE/DELETE grants for the app DB role on this table (documented in README).
Audited actions: every moderation action, verification decision, payment decision, setting change, category/attribute change, admin create/role change, badge grant/revoke, user suspend/ban/restore, CV deliveries, broadcast send.

### 7.6 Rate limiting
`express-rate-limit` presets: `auth` (10/min/IP + per-account), `otp` (60 s cooldown enforced in DB too), `search` (60/min), `messages`, `reveal`, `upload` (30/min), `global` (300/min/IP). Redis store if `REDIS_URL`. Login lockout (AUTH-16) uses `LoginEvent` rows (count failures in window) — no Redis needed.

### 7.7 i18n
* `Translation(key, lang, value)` table is the single source for client strings (LOC-02/03): `GET /translations?lang=ar` (ETag). Admin upserts; `GET /admin/translations/missing` lists keys lacking AR or EN. Fallback to EN.
* Server-side texts (errors, notifications, emails) live in `src/shared/messages.ts` as `{ KEY: { ar, en } }` with `{placeholders}`; chosen by recipient's `User.language`.

### 7.8 Security checklist (built-in)
`helmet`, CORS allow-list (`CORS_ORIGINS`), body size limits (json 1 MB), Zod on every input, `sanitize-html` (no tags) on all free text, Prisma/parameterized SQL only (`Prisma.sql`), private docs in private bucket + SSE + 5-minute signed URLs, secrets only via env (`.env.example` provided), startup refuses weak secrets in production, dev-only helpers (`/dev/*`) disabled when `NODE_ENV=production`.

---

## 8. Data Model (Prisma-level field lists)

Conventions: `id` = `String @id @default(uuid())`; `createdAt`, `updatedAt` on every table; `?` = nullable. Enums listed in §8.0. Foreign keys indexed.

### 8.0 Enums
`AccountStatus{ACTIVE,SUSPENDED,DEACTIVATED,PENDING_DELETION}` · `Capability{SELLER,DEALER,EMPLOYER,SERVICE_PROVIDER,CANDIDATE}` · `AdminRole{SUPER_ADMIN,CONTENT_MODERATOR,SUPPORT_AGENT,FINANCIAL_AUDITOR}` · `Language{AR,EN}` · `Currency{SDG,USD}` · `ListingType{SALE,RENT,WANTED,SERVICE}` · `ListingStatus{DRAFT,PENDING_REVIEW,ACTIVE,HIDDEN,AUTO_HIDDEN,SUSPENDED,SOLD,EXPIRED,ARCHIVED}` (*PENDING_REVIEW* = the TRS-15 delayed-visibility hold; the only addition to the PRD list) · `AttributeType{TEXT,NUMBER,BOOLEAN,SINGLE_SELECT,MULTI_SELECT,DATE,RANGE,FILE_URL}` · `MessageType{TEXT,IMAGE,OFFER,SYSTEM}` · `OfferStatus{PENDING,ACCEPTED,REJECTED,COUNTERED,WITHDRAWN}` · `CvBuildStatus{PENDING,IN_PROGRESS,DELIVERED,REVISION_REQUESTED,APPROVED}` · `ApplicationStatus{SUBMITTED,VIEWED,SHORTLISTED,INTERVIEW,REJECTED,HIRED,WITHDRAWN}` · `ReviewContext{CHAT,RENTAL,APPOINTMENT,HOTEL_INQUIRY}` · `OtpPurpose{REGISTER,RESET,CHANGE_EMAIL,PHONE,DELETE_ACCOUNT}` · `OtpChannel{EMAIL,SMS,WHATSAPP}` · `RentalStatus{REQUESTED,ACCEPTED,DECLINED,COUNTERED,CANCELLED,COMPLETED}` · `AppointmentStatus{REQUESTED,CONFIRMED,DECLINED,RESCHEDULE_PROPOSED,CANCELLED,COMPLETED,NO_SHOW}` · `InquiryStatus{SENT,CONFIRMED_STAY,DISPUTED,CANCELLED}` · `ReportReason{FRAUD,INCORRECT_PRICE,SOLD,DUPLICATE,INAPPROPRIATE,OTHER}` · `ReportTarget{LISTING,USER,REVIEW,CONVERSATION,JOB}` · `PaymentState{PENDING,APPROVED,REJECTED,REFUNDED}` · `BusinessType{STORE,DEALERSHIP,AGENCY,COMPANY,HOTEL,WORKSHOP}` · `StaffRole{MANAGER,EDITOR,SUPPORT}`.

### 8.1 Identity & access
* **User**: email? unique, emailVerifiedAt?, phone? (**not unique**), verifiedPhone? unique, passwordHash?, fullName, avatarUrl?, coverUrl?, bio?, city?, languages String[], contactPrefs Json `{call,whatsapp,chatOnly}`, language, status, statusReason?, statusUntil?, countryId?, ratingAvg Float, ratingCount Int, responseRate Float?, avgResponseMin Int?, fraudScore Int, lastActiveAt, deactivatedAt?, deletionRequestedAt?, deletedAt?
* **UserCapability**(userId, capability, grantedAt, revokedAt?) unique(userId,capability) · **UserBadge**(userId, badge, grantedBy, grantedAt, revokedAt?)
* **SocialIdentity**(userId, provider, providerId, email?) unique(provider,providerId)
* **Session**(userId, familyId, refreshHash, deviceId?, deviceName?, os?, ip?, approxLocation?, lastActiveAt, revokedAt?)
* **OtpCode**(email?, phone?, userId?, purpose, channel, codeHash, attempts, expiresAt, usedAt?, sentAt) — index(email,purpose)
* **LoginEvent**(userId?, email, outcome, ip, deviceId?, deviceName?, createdAt) — used for activity log (last 20) & lockout
* **AdminUser**(email unique, passwordHash, fullName, role, totpSecretEnc?, totpEnrolledAt?, ipAllowlist String[], isActive, mustChangePassword) · **AdminSession**(adminId, ip, userAgent, refreshHash, revokedAt?, lastActiveAt)
* **VerificationRequest**(userId, kind `USER|DEALER|BUSINESS|EMPLOYER|SERVICE_PROVIDER`, documentKeys String[] (private), status `PENDING|APPROVED|REJECTED|MORE_INFO`, reason?, decidedBy?, decidedAt?)
* **BlockedUser**(blockerId, blockedId) unique pair

### 8.2 Geography & config
* **Country**(code unique, dialCode, nameEn, nameAr, defaultCurrency, isActive) · **State**(countryId, nameEn, nameAr) · **City**(stateId, nameEn, nameAr, lat?, lng?) · **Neighborhood**(cityId, nameEn, nameAr)
* **CountrySetting**(countryId, key, value Json) — per-country overrides (categories hidden, languages, payment methods, flags)
* **Setting**(key PK, value Json, updatedBy, updatedAt)
* **ExchangeRate**(base, quote, rate Decimal(18,6), effectiveFrom, setBy)
* **Translation**(key, lang, value) unique(key,lang)
* **GeoUsage**(date, provider, kind, userId?, ip?, count) — Google cap tracking

### 8.3 Catalog
* **Category**(parentId?, slug unique, nameEn, nameAr, iconUrl?, displayOrder, isActive, isArchived, postingRestricted, postingMessage?, expiryDays, schemaVersion Int, listingTypeDefault, supportsCompare Boolean, isVideoAllowed Boolean default true)
* **CategoryAttribute**(categoryId, attributeKey, labelEn, labelAr, dataType, isRequired, isFilterable, isSearchable, isArchived, promoteToIndex, displayOrder, optionsList Json?, validationRules Json?, unit?, showInCompare Boolean) **unique(categoryId, attributeKey)**
* **OtherEntry**(categoryId, text, count, promotedTo?)

### 8.4 Listings
* **Listing**: publicSeq Int unique autoincrement (→ `MARBOU-00001`), ownerId, businessId?, countryId, cityId?, neighborhoodId?, categoryId, listingType, title, description, **searchText** (normalized Arabic/English concat, trigram-indexed), price Decimal?, budgetMin?, budgetMax?, currency, isNegotiable, condition?, status, statusReason?, isCustomOther, customOtherText?, `lat?`, `lng?` (exact, **never** returned publicly if approx), `pubLat?`, `pubLng?` (what the public sees), locationName?, isApproxLocation, approxRadiusM?, contactOptions Json `{call,whatsapp,chat}`, dynamicAttributes Json, qualityScore, riskScore, viewCount, favoriteCount, leadCount, videoUrl?, videoPosterUrl?, vehicleVin? & ownershipDocKey? (private), publishedAt?, expiresAt?, soldAt?, deletedAt?
  Indexes: `(categoryId,status,publishedAt desc)`, `(ownerId,status)`, `(countryId,cityId,status)`, `(pubLat,pubLng)`, GIN `dynamicAttributes jsonb_path_ops`, GIN trigram on `searchText`, partial index `WHERE status='ACTIVE' AND "deletedAt" IS NULL`.
* **ListingMedia**(listingId, mediaId, url, thumbUrl, position, isCover, phash?) · **ListingEdit**(listingId, editorId, diff Json) · **Favorite**(userId, listingId, priceAtSave) pk(userId,listingId)
* **SavedSearch**(userId, name, query Json, frequency `INSTANT|DAILY`, lastNotifiedAt?) · **SearchLog**(userId?, deviceHash, q, filters Json, resultCount, createdAt) — recent searches & zero-result analytics
* **ListingView**(listingId, viewerKey (hash of userId|deviceId), day) unique(listingId,viewerKey,day) → unique viewer per 24 h
* **QuickReply**(userId, title, body)

### 8.5 Media
* **MediaAsset**(ownerId, kind `IMAGE|VIDEO|DOC`, isPrivate, key, url?, thumbKeys Json?, phash?, sizeBytes, mime, width?, height?, durationSec?, attachedAt?, createdAt) — `attachedAt IS NULL` older than 24 h ⇒ orphan cleanup.

### 8.6 Messaging
* **ChatThread**(listingId?, buyerId, sellerId, businessId?, lastMessageAt?, isMutedByBuyer, isMutedBySeller, closedReason?) unique(listingId,buyerId,sellerId)
* **ChatMessage**(threadId, senderId, type, body?, attachmentUrl?, idempotencyKey, sentAt, deliveredAt?, readAt?, handledByStaffId?) unique(senderId,idempotencyKey), index(threadId,sentAt)
* **Offer**(threadId, messageId unique, offeredById, amount, currency, status, counterOfId?)

### 8.7 Verticals
* **RentalRequest**(listingId, renterId, ownerId, startDate, endDate, withDriver, pickupPreference?, notes?, status, counterTerms Json?, termsSnapshot Json, decidedAt?)
* **ServiceProfile**(userId unique, businessId?, name, services Json `[ {key,nameEn,nameAr,rate} ]`, workingHours Json `{mon:[["08:00","16:00"]],...}`, slotMinutes, capacityPerSlot, timezone, isActive)
* **ServiceAppointment**(providerId, userId, serviceKey, vehicleInfo Json, issue, imageMediaIds String[], startsAt, endsAt, status, proposedStartsAt?, completedAt?, userConfirmedAt?, disputedAt?, remindedFlags Json)
* **AccommodationInquiry**(listingId, guestId, hostId, checkIn, checkOut, guests, message, status, confirmedAt?, disputedAt?) · **AvailabilityBlock**(listingId, from, to, note?)
* **Review**(reviewerId, subjectId, context, contextRef, listingId?, rating 1–5, body?, reply?, status `VISIBLE|HIDDEN`) unique(reviewerId,context,contextRef)

### 8.8 Jobs
* **EmployerProfile**(userId unique, companyName, description?, logoUrl?, website?, businessId?)
* **Job**(employerUserId, employerProfileId?, title, categoryId, employmentType, salaryMin?, salaryMax?, currency?, cityId?, locationName?, requirements, benefits, deadline?, screeningQuestions Json, status ListingStatus, expiresAt, riskScore, createdAt) + `searchText`
* **JobApplication**(jobId, candidateId, tier `QUICK|FULL`, snapshot Json, documentKeys String[] (private keys shared for this job only), answers Json, status, employerNotes?) unique(jobId,candidateId)
* **CandidateProfile**(userId unique, dateOfBirth?, nationality?, city?, maritalStatus?, hasDrivingLicense, licenseCategory?, licenseIssueDate?, ownsVehicle, vehicleDetails?, education Json, experience Json, skills String[], languages Json, summary?, photoKey?, cvKey?, certificateKeys String[], isPrivate=true)
* **CvBuildRequest**(userId, payload Json, status CvBuildStatus, assignedTo?, deliveredKey?, revisionNote?)
* **JobAlert**(userId, categoryId?, cityId?, keywords String[], isActive)

### 8.9 Business
* **BusinessProfile**(ownerId, type, name, slug unique, logoUrl?, coverUrl?, description?, hours Json, lat?, lng?, cityId?, contacts Json, verifiedAt?)
* **BusinessStaff**(businessId, userId?, email, role, inviteTokenHash?, acceptedAt?) · Listing.businessId links inventory.
* Daily metrics: **ListingMetricDaily**(listingId, businessId?, day, views, uniqueViews, chats, whatsapp, calls, favorites, impressions) — rolled up nightly from `AnalyticsEvent`.

### 8.10 Trust & safety
* **Report**(reporterId, targetType, targetId, reason, note?, status `OPEN|ACTIONED|DISMISSED`, priority Int, resolvedBy?, resolvedAt?)
* **ModerationAction**(adminId, targetType, targetId, action `EDIT|HIDE|SUSPEND|DELETE|RESTORE|BAN_USER|SUSPEND_USER|RESTORE_USER|DISMISS`, reasonCode, note?) — every one requires `reasonCode`
* **Appeal**(userId, moderationActionId, message, status `OPEN|UPHELD|OVERTURNED`, decidedBy?, decisionNote?)
* **FraudSignal**(subjectType, subjectId, signal, weight, createdAt) · **Blacklist**(type `PHONE|EMAIL|DEVICE|KEYWORD|PHASH`, value, note?, createdBy)
* **ScanResult**(listingId, flags Json, riskScore, scannedAt)

### 8.11 Notifications & content
* **Notification**(userId, type, titleKey/title Json{ar,en}, body Json{ar,en}, data Json, dedupeKey? unique per user, readAt?) · **DeviceToken**(userId, token unique, platform) · **NotificationPreference**(userId, category, push Boolean, email Boolean) · **Broadcast**(title Json, body Json, audience Json `{all|role|city|categoryInterest}`, scheduledAt?, sentAt?, stats Json, createdBy)
* **EmailOutbox**(to, template, payload, status, attempts, lastError?) — simple retry log for NFR-REL-04
* **Banner**(placement, imageUrl, link, titleAr/En, startsAt?, endsAt?, lang?, countryId?, order, isActive) · **HelpArticle**(slug, category, titleAr/En, bodyAr/En, order, isPublished) · **StaticPage**(slug, titleAr/En, bodyAr/En, isPublished) · **LegalDocumentVersion**(type `PRIVACY|TERMS|TRADING_RULES`, version, bodyAr, bodyEn, effectiveAt, requiresAcceptance) · **LegalAcceptance**(userId, docId, acceptedAt)
* **SupportTicket**(userId?, email?, subject, status, assignedTo?) · **TicketMessage**(ticketId, authorType, authorId, body)

### 8.12 Payments & ops
* **Payment**(userId, purpose, refId?, amount, currency, method, reference, receiptMediaId?, receiptHash?, state, reason?, decidedBy?, decidedAt?, flags String[] e.g. `DUP_REF`,`DUP_RECEIPT`) indexes(reference, receiptHash, state+createdAt) · **Invoice**(paymentId, number Int unique sequence, issuedAt) · **LedgerEntry**(paymentId?, userId, type `CHARGE|REFUND|REVERSAL|ADJUST`, amount, currency, reason)
* **AuditLog**(BigInt id, actorType, actorId, action, entity, entityId, before?, after?, prevHash, hash, createdAt)
* **AnalyticsEvent**(type, userHash?, deviceHash?, listingId?, categoryId?, cityId?, props Json (no PII), createdAt) · **JobRun**(name, startedAt, finishedAt, status, stats Json) · **IdempotencyKey**(key, userKey, route, responseStatus, responseBody Json, createdAt)
* **DataExport**(userId, status, fileKey?, expiresAt?) 

### 8.13 Dormant engines (Phase 12; tables only if building them)
`Plan, Subscription, Promotion, CreditBalance, CreditLedger, Auction, Bid, BarterProposal, Cart, CartItem, Order, OrderItem, DeliveryZone, DeliveryFeeRule, Delivery, WholesaleTier (or fields on Listing: moq, tierPrices Json), Reservation (hotels)`. Exact minimums in §9.12.

---

## 9. Key Flows & State Machines

### 9.1 Listing lifecycle (M04, TRS)
```
create(DRAFT) ─publish─► ACTIVE (instant)  ──────────────► SOLD / ARCHIVED (owner)
create(PUBLISH)────────► ACTIVE   or PENDING_REVIEW (only if TRS-15 rule matches) ─scan ok/mod approve─► ACTIVE
ACTIVE ─report threshold or risk≥85─► AUTO_HIDDEN ─mod restore─► ACTIVE   | mod hide → HIDDEN | mod suspend → SUSPENDED
ACTIVE ─expiresAt passed (cron)─► EXPIRED ─renew (≤30 days after)─► ACTIVE (new expiresAt)
any status + deletedAt (soft delete by owner/mod; purge after 90 days)
```
Visible in search/feeds only when `status='ACTIVE' AND deletedAt IS NULL AND expiresAt>now()`. Owner always sees own listing + `statusReason`.
**On create/publish (single transaction):** validate (category not posting-restricted, caps, hourly/daily rate, verified email, not banned, EAV validation, price/currency, media count ≤ `media.maxPhotos`, video allowed) → compute `searchText`, `qualityScore`, `expiresAt`, `pubLat/pubLng` → insert listing + ListingMedia + ListingEdit(`created`) → enqueue `listing.scan` + `listing.index-notify` (saved-search matches) → return listing with readable ID + share URL.

### 9.2 Scan pipeline (`listing.scan` job, runs after publish **and** after edit)
1. banned keywords (`Blacklist KEYWORD` + `chat.bannedPhrases`), 2. blacklisted phone/email in `contactOptions`/description (regex for phone numbers), 3. image phash exact/near (Hamming ≤ 5) vs other listings by other users & `Blacklist PHASH`, 4. text duplicate: `similarity(searchText, other.searchText) ≥ 0.85` among same owner/phone, 5. `ContentClassifier.classify(images)`, 6. job-scam patterns (JOB-21: "fee", "pay to apply", "WhatsApp only", "transfer money"), 7. compute `riskScore` from signals (§9.8) → store `ScanResult`; if score ≥ `moderation.autoHide.fraudScore` ⇒ status `AUTO_HIDDEN`; if ≥ alert threshold ⇒ add to moderator queue (a `Report` row with `reporterId=null`, `reason=FRAUD`, priority high). If listing was `PENDING_REVIEW` and scan is clean ⇒ `ACTIVE`.

### 9.3 Chat & offers (M07)
Thread is get-or-create on `(listingId,buyerId,sellerId)`; buyer ≠ seller; blocked users → 403 (PROF-07). Send message: validate throttle (`chat.throttle`), idempotency key (unique(senderId,key) → return existing on retry), save, emit socket `message:new` to room, if recipient not in room ⇒ enqueue push (MSG-06). Offers: `OFFER` message + Offer row; `accept|reject|counter` only by the other party; accept ⇒ system message "agreed price X"; counter creates new Offer with `counterOfId`, previous → COUNTERED. Listing sold/expired/removed ⇒ thread banner computed on read (`thread.listingState`).

### 9.4 Rental request (AUTO-12/13)
`REQUESTED → ACCEPTED | DECLINED | COUNTERED(→ renter accepts→ACCEPTED / cancels) | CANCELLED(by renter) ; ACCEPTED → COMPLETED (owner marks after end date)`. Store `termsSnapshot` (rates, deposit, mileage cap, conditions) at request time. Notify counterpart each transition.

### 9.5 Appointment (AUTO-14..18)
Slots = for the date, iterate `workingHours` in `slotMinutes` steps; remaining = `capacityPerSlot − count(appointments in REQUESTED/CONFIRMED at that slot)`. Create uses a transaction with `SELECT ... FOR UPDATE` on the provider profile row to prevent over-booking. `REQUESTED → CONFIRMED | DECLINED | RESCHEDULE_PROPOSED(→user accepts→CONFIRMED)`; `CONFIRMED → COMPLETED(provider) | NO_SHOW(provider) | CANCELLED(either)`. After `COMPLETED`: user may `confirm` or `dispute` within 72 h; review opens on confirm or when the window lapses without dispute (cron `appointments.confirm-window`). Reminders 24 h and 2 h before (cron every 10 min; flags in `remindedFlags` prevent duplicates).

### 9.6 Job application & CV (M10)
Apply: enforce daily limit (20), one per job, job active, candidate verified email. `QUICK` stores `{fullName, phone, email, city, photoKey?, summary?, cvKey?}`; `FULL` snapshots current `CandidateProfile` + chosen document keys. **Employer can only see data inside `JobApplication.snapshot/documentKeys`**; documents are fetched through `GET /applications/:id/documents/:key` which checks employer owns the job, application exists, key ∈ `documentKeys`, then returns a **≤5-minute signed URL**. Statuses: SUBMITTED → VIEWED (auto on first employer open) → SHORTLISTED → INTERVIEW → REJECTED/HIRED; candidate may WITHDRAW. CV request: `PENDING → IN_PROGRESS (support assigns) → DELIVERED (support uploads/generates; candidate notified) → APPROVED | REVISION_REQUESTED (→ IN_PROGRESS)`.

### 9.7 Hotel inquiry (M11)
`SENT → CONFIRMED_STAY (host one-tap) → review eligible` ; guest may `DISPUTE` within 72 h (moderator sees it). Availability blocks displayed as notes. Reservation engine (flag OFF) adds `Reservation` with overlap prevention.

### 9.8 Fraud / risk score (TRS-05)
`score = min(100, Σ signal weights)`; default weights: listings>3 in last hour +20, new account (<24 h) +15, duplicate text/image +25, price < 30% of comparable median +15, blacklisted contact +50, scam keyword +25, abnormal contact-reveal volume +10, receipt fraud flag +30, per distinct report +5 (max 25). Stored on listing (`riskScore`) and rolled to `User.fraudScore` (max of recent). `≥70` ⇒ moderator alert; `≥80` ⇒ user posting rate halved + flagged; `≥85` ⇒ auto-hide.

### 9.9 Reviews (TRS-08)
A review is allowed only if a **qualifying interaction** exists for `(reviewer, subject, context, contextRef)`:
(a) CHAT: thread where each party sent ≥ `chat.reviewMinMessagesEach` messages; (b) RENTAL: request `COMPLETED`; (c) APPOINTMENT: `COMPLETED` and (user confirmed or window lapsed); (d) HOTEL_INQUIRY: `CONFIRMED_STAY`. Unique(reviewer, context, contextRef). On create/hide: recompute `User.ratingAvg/ratingCount`. Subject may reply once. Reviews are reportable (`ReportTarget.REVIEW`).

### 9.10 Payments — Bankak (M17)
`POST /payments/bankak` (only if `flags.bankak.userFlow`): store Payment `PENDING`; compute `receiptHash` (sha256 of image bytes) and detect duplicates: same `reference` for another payment ⇒ flag `DUP_REF`; same `receiptHash` ⇒ `DUP_RECEIPT` (add FraudSignal). Finance/Super Admin `approve` ⇒ state APPROVED, create Invoice (sequential number via Postgres sequence), call `PaymentPurposeHandler[purpose].onApproved()` (activates subscription/credits/etc. — registry pattern = PAY-09), notify; `reject` requires reason enum (ILLEGIBLE, INCORRECT_AMOUNT, DUPLICATE_REFERENCE, OTHER) + notify. Every transition audited. `refund` = LedgerEntry (flag OFF).

### 9.11 Account deletion & export (DASH-04..07)
* Export: `POST /me/export` ⇒ `DataExport` + job builds JSON (profile, listings, favorites, saved searches, applications, rentals, appointments, messages sent, reviews) ⇒ private bucket ⇒ notification with signed link (valid 24 h). 
* Deletion: re-auth (password or fresh OTP) + email confirmation code ⇒ `status=PENDING_DELETION`, sessions revoked, `deletionRequestedAt`. Cancellable (login + `DELETE /me/deletion`) within grace period. Daily job after `deletion.graceDays`: delete CV/docs/media/contact data, anonymize name/email/phone (`deleted_<id>@deleted.local`), keep chat/review rows with anonymized author, soft-delete listings. Audit rows untouched (pseudonymous IDs only).
* Deactivate: `status=DEACTIVATED`, listings hidden; next successful login reactivates.

### 9.12 Dormant engines — minimum bar (PRD Appendix B)
Each: tables + endpoints under `/engines/<name>` + admin endpoints + tests; guarded by `requireFlag`.
| Engine | Minimum |
|---|---|
| Subscriptions | Admin CRUD `Plan`(monthly/yearly, listingQuota, price); subscribe after APPROVED Payment; quota enforced in listing create; daily job expires/renews; cancel-at-period-end |
| Promotions | Promotion(type FEATURED/TOP_BOOST/BADGE/BANNER, start, end, listingId); search ranking adds boost only while active; impressions/clicks counters |
| Credits | CreditBalance + CreditLedger; purchase (approved payment), spend per promotion type; no negative balance (`CHECK balance>=0`); admin adjust with reason |
| Boosts/badging | Time-boxed boost/badge bought with credits or payment; auto-expiry job; price config per country (CountrySetting) |
| Auctions | Auction(listingId, start, end, reserve, increment); `placeBid` in a transaction with row lock, validates ≥ current+increment; end job picks winner (≥ reserve), notifies; no payment capture |
| Barter | BarterProposal(fromListing, toListing, status); accept/reject/counter; on accept mark both listings reserved (`dynamicAttributes._reserved=true` or status flag) + open chat thread |
| Asset rental | Reuse RentalRequest for non-vehicle listings + AvailabilityBlock + termsSnapshot |
| Cart/Order | Cart per user per seller; checkout → Order(Created→Confirmed→Fulfilled/Cancelled); seller confirms; no payment |
| Delivery | DeliveryZone + fee matrix; Delivery states Requested→In Transit→Delivered; `CourierAdapter` interface + one mock impl |
| AdMob | `GET /config` exposes `admob.unitIds` only when flag on |
| Wholesale | `moq`, `tierPrices Json [{minQty,price}]` on Listing (nullable); price by quantity; order qty ≥ MOQ validated |
| Hotel reservations | Reservation(Requested→Confirmed→Cancelled→Completed) with date-overlap check inside transaction |

---

## 10. API Catalogue (`/api/v1`)

Legend — **Auth:** `P` public, `U` signed-in user, `V` signed-in + verified email, `C:<cap>` needs capability, `A:<perm>` admin permission, `A` any admin. All lists use cursor pagination. Items marked ⚑ are flag-gated.

### 10.1 Auth (M01)
| Method & path | Auth | Purpose |
|---|---|---|
| POST `/auth/register` | P | `{email,password,fullName,phone?,language?}` → creates user + sends email OTP |
| GET `/auth/otp/channels` | P | enabled channels (from flags) |
| POST `/auth/otp/request` | P | `{email,purpose,channel?}` (60 s cooldown) |
| POST `/auth/otp/verify` | P | `{email,code,purpose}` (≤5 attempts) → verifies email; for REGISTER returns tokens |
| POST `/auth/login` | P | `{email,password,device{id,name,os}}` → tokens (+ lockout) |
| POST `/auth/social/:provider` | P | provider = google\|facebook\|apple; `{idToken?|accessToken?,device}`; links by verified email; may return `needsEmail:true` |
| POST `/auth/refresh` | P | rotate refresh token |
| POST `/auth/logout` | U | revoke current session |
| POST `/auth/password/forgot` · `/auth/password/reset` | P | OTP reset; revokes other sessions |
| POST `/auth/phone/request` · `/auth/phone/verify` | U ⚑ | phone OTP (flag) |
| GET `/me/sessions` · DELETE `/me/sessions/:id` · DELETE `/me/sessions` (others) | U | AUTH-09 |
| GET `/me/login-events` | U | last 20 |
| POST `/me/password/change` · POST `/me/email/change` (request) · POST `/me/email/confirm` · PATCH `/me/phone` | U | AUTH-11/12 |

### 10.2 Users & profile (M02)
| GET `/me` · PATCH `/me` | U | profile (name, avatar, city, bio, languages, contactPrefs, language) |
| GET `/me/capabilities` · POST `/me/capabilities` `{capability, setup{...}}` | U | PROF-01/10 |
| POST `/me/verification` `{kind, documentMediaIds[]}` · GET `/me/verification` | V | PROF-05 |
| GET `/users/:id` | P | public seller profile (badges, rating, response rate, active listing count) |
| GET `/users/:id/listings` · GET `/users/:id/reviews` | P | |
| POST/DELETE `/users/:id/block` · GET `/me/blocks` | U | PROF-07 |
| GET/PATCH `/me/notification-preferences` · POST `/me/device-tokens` · DELETE `/me/device-tokens/:token` | U | |
| GET `/me/dashboard` | U | counts for DASH-01/08 |

### 10.3 Catalog, geo, config (M03, M20, M21)
| GET `/categories` | P | tree (ETag) `?parentId=&country=` |
| GET `/categories/:id` | P | node + breadcrumbs + subcategories + top filters (CAT-14) |
| GET `/categories/:id/schema` | P | attributes incl. inherited (ETag) |
| GET `/countries` · `/geo/states?countryId=` · `/geo/states/:id/cities` · `/geo/cities/:id/neighborhoods` | P | GEO-06 |
| GET `/geo/autocomplete?q=` · `/geo/reverse?lat=&lng=` | U | Google proxy + caps |
| GET `/config` | P | ETag; flags (public subset), media limits, otp channels, currencies, min versions, maintenance, exchange rates + staleness, contact support, admob unit ids |
| GET `/translations?lang=` | P | ETag |
| GET `/exchange-rate?base=&quote=` | P | current rate + `stale` flag |

### 10.4 Media (M19)
| POST `/media/images` (multipart `file`, `?private=false`) | V | → `{id,url,thumbs}` WebP, EXIF stripped, phash; max 8 MB |
| POST `/media/video` (multipart `file`) | V | validates limits (flags/category), poster; returns `{id,url,posterUrl,durationSec}` |
| POST `/media/documents` (multipart) | U | private PDF/JPG/PNG (≤10 MB) → `{id,key}` |
| GET `/media/signed-url?mediaId=` | U | only for owner/authorized (5 min) |
| DELETE `/media/:id` | U | owner only |

### 10.5 Listings (M04, M06)
| POST `/listings` | V | body `{categoryId,listingType,title,description,price?|budgetMin/Max,currency,isNegotiable,condition?,cityId,lat,lng,locationName,isApproxLocation,approxRadiusM,contactOptions,dynamicAttributes,isCustomOther,customOtherText,mediaIds[],coverMediaId,videoMediaId?,status:"DRAFT"|"PUBLISH"}` |
| GET `/listings/:idOrReadable` | P | accepts UUID or `MARBOU-00042`; **no phone numbers**; records view (device/user, excludes owner) |
| PATCH `/listings/:id` | V owner/staff | edits → rescan + ListingEdit |
| POST `/listings/:id/publish` | V | draft → active |
| POST `/listings/:id/renew` · `/sold` · `/duplicate` · `/archive` | V | |
| DELETE `/listings/:id` | V | soft delete |
| POST `/listings/bulk` `{action:RENEW\|HIDE\|SOLD\|DELETE, ids[]}` | C:DEALER or business staff | LST-15 |
| GET `/me/listings?status=` · GET `/me/drafts` | U | |
| POST `/listings/:id/contact-reveal` `{channel:CALL\|WHATSAPP}` | P/U | policy + caps; returns `{phone}` or `{waUrl}`; logs lead event |
| POST `/listings/:id/lead` `{type:CHAT\|WHATSAPP\|CALL}` | P | analytics lead event |
| GET `/listings/:id/similar` · `/listings/:id/price-insight` | P | |
| POST/DELETE `/listings/:id/favorite` · GET `/me/favorites` | U | price-drop tracking |
| GET `/public/listings/:id/meta` | P | OG tags + JSON-LD for SSR |
| GET `/listings/quality-preview` (POST) | U | live quality score for unsaved form data |

### 10.6 Search & discovery (M05)
| GET `/search` | P | params: `q, categoryId, type, cityId, minPrice, maxPrice, currency, lat, lng, radiusKm, sort=relevance\|newest\|price_asc\|price_desc\|distance, filters=<json>, limit, cursor, areaUnit` |
| GET `/search/suggest?q=` | P | autocomplete (titles, categories) |
| GET/DELETE `/me/recent-searches` | U | |
| GET `/home?lat=&lng=` | P | banners, category grid, recent, popular, nearby (cached 60 s) |
| GET `/nearby?lat=&lng=` · GET `/recommendations` | P/U | |
| GET `/compare?ids=a,b,c,d` | P | ≤4, same compare-enabled category, specs matrix + verification |
| CRUD `/saved-searches` | U | |

### 10.7 Chat (M07)
REST: GET `/threads` (inbox, `?businessId=`) · POST `/threads` `{listingId, message?}` · GET `/threads/:id` · GET `/threads/:id/messages` · POST `/threads/:id/messages` (idempotent) · POST `/threads/:id/read` · PATCH `/threads/:id/mute` · POST `/threads/:id/offers` · POST `/offers/:id/accept|reject|counter` · GET `/threads/unread-count` · CRUD `/me/quick-replies`.
Socket `/chat` (auth via `auth:{token}`): client→server `thread:join`, `message:send` (ack), `typing`, `message:read`; server→client `message:new`, `message:delivered`, `message:read`, `typing`, `offer:updated`, `unread:update`.

### 10.8 Verticals
| Rentals | POST `/listings/:id/rental-requests` (V) · GET `/me/rental-requests?role=renter\|owner` · GET `/rental-requests/:id` · PATCH `/rental-requests/:id` `{action:ACCEPT\|DECLINE\|COUNTER\|CANCEL\|COMPLETE, counter?}` |
| Services | PUT `/me/service-profile` (C:SERVICE_PROVIDER) · GET `/providers/:userId` · GET `/providers/:id/slots?date=` · POST `/appointments` (V) · GET `/me/appointments?role=` · PATCH `/appointments/:id` `{action:CONFIRM\|DECLINE\|PROPOSE\|ACCEPT_PROPOSAL\|CANCEL\|COMPLETE\|NO_SHOW\|USER_CONFIRM\|DISPUTE, ...}` |
| Hotels | POST `/listings/:id/inquiries` (V) · GET `/me/inquiries?role=` · PATCH `/inquiries/:id` `{action:CONFIRM_STAY\|DISPUTE\|CANCEL}` · GET/PUT `/listings/:id/availability` ⚑reservations: POST `/listings/:id/reservations` |
| Jobs | POST `/jobs` (C:EMPLOYER) · GET `/jobs` (search/filter) · GET `/jobs/:id` · PATCH `/jobs/:id` · POST `/jobs/:id/renew` · DELETE `/jobs/:id` · GET `/me/jobs` · GET `/jobs/:id/applications` (employer) · PATCH `/applications/:id` `{status,notes}` · GET `/applications/:id/documents/:key` (signed URL) · POST `/jobs/:id/apply` (V) · GET `/me/applications` · POST `/applications/:id/withdraw` · GET/PUT `/me/candidate-profile` · POST/DELETE `/me/candidate-profile/documents` · GET `/me/candidate-profile/cv.html?layout=` · POST `/cv-requests` · GET `/me/cv-requests` · POST `/cv-requests/:id/approve` · POST `/cv-requests/:id/revision` · CRUD `/job-alerts` · PUT `/me/employer-profile` |
| Business | POST `/business` (becomes DEALER/…) · GET `/business/:idOrSlug` (public) · PATCH `/business/:id` · GET `/business/:id/listings` · POST `/business/:id/staff/invite` · POST `/business/staff/accept` · PATCH/DELETE `/business/:id/staff/:sid` · GET `/business/:id/analytics?from&to` · GET `/business/:id/analytics.csv` |

### 10.9 Trust & safety, notifications, payments, content
| POST `/reports` `{targetType,targetId,reason,note?}` (U) · POST `/reviews` (V) · POST `/reviews/:id/reply` · POST `/appeals` · GET `/me/appeals` · GET `/safety-center` (tips + my reports/status + blocks) |
| GET `/notifications` · POST `/notifications/:id/read` · POST `/notifications/read-all` · GET `/notifications/unread-count` |
| ⚑ POST `/payments/bankak` · GET `/me/payments` · GET `/payments/:id/invoice` |
| GET `/help` · `/help/:slug` · `/legal/:type` · POST `/legal/:type/accept` · GET `/pages/:slug` · GET `/banners?placement=` · POST `/support/tickets` · GET `/me/support/tickets` · POST `/support/tickets/:id/messages` · GET `/sitemap.xml` · `/sitemap-listings-:n.xml` · `/robots.txt` · POST `/public/account-deletion` `{email}` (sends confirmation link/OTP; same grace flow) |
| Data rights | POST `/me/export` · GET `/me/export/:id` · POST `/me/deletion/request` · POST `/me/deletion/confirm` · DELETE `/me/deletion` · POST `/me/deactivate` |
| Analytics | POST `/events` `{events:[{type,listingId?,props}]}` (anonymized, batched) |
| Health | GET `/health` (db ping), GET `/health/ready` |

### 10.10 Admin (`/admin/*`, separate token)
| Auth | POST `/admin/auth/login` → `{mfaToken, needsEnrollment, otpauthUrl?}` · POST `/admin/auth/verify-2fa` → tokens · POST `/admin/auth/refresh` · POST `/admin/auth/logout` · POST `/admin/auth/change-password` |
| Admins (A:`*`) | CRUD `/admin/admins` (role change, deactivate, reset 2FA) · GET `/admin/admin-sessions` · DELETE `/admin/admin-sessions/:id` |
| Dashboard | GET `/admin/dashboard/kpis` (new users, new listings, active chats, open reports, pending verifications, pending payments) · GET `/admin/system-health` |
| Users (`users.read`/`users.suspend`) | GET `/admin/users?q=` · GET `/admin/users/:id` (context view) · PATCH `/admin/users/:id` · POST `/admin/users/:id/suspend` `{reasonCode,days?}` · `/ban` · `/restore` · `/revoke-sessions` · POST/DELETE `/admin/users/:id/badges` |
| Verification | GET `/admin/verifications` · POST `/admin/verifications/:id/decide` `{decision,reason?}` · GET `/admin/verifications/:id/documents/:i` (signed URL) |
| Listings (`listings.moderate`) | GET `/admin/listings` · GET `/admin/listings/:id` (+history) · PATCH edit · POST `/hide` `/suspend` `/delete` `/restore` (reasonCode required) · GET `/admin/moderation/feed` (live new listings) · GET `/admin/moderation/flagged` |
| Reports & appeals | GET `/admin/reports` (priority-sorted) · POST `/admin/reports/:id/resolve` · GET `/admin/appeals` · POST `/admin/appeals/:id/decide` · CRUD `/admin/blacklist` · GET `/admin/reviews` · POST `/admin/reviews/:id/hide` |
| Catalog (SA) | `/admin/categories` CRUD/archive/restore/reorder · `/admin/categories/:id/attributes` CRUD/archive · GET `/admin/categories/:id/preview` · GET `/admin/other-entries` · POST `/admin/other-entries/:id/promote` · option-list endpoints reuse attribute update |
| Settings (SA) | GET `/admin/settings` · PATCH `/admin/settings/:key` · PATCH `/admin/flags/:key` · PATCH `/admin/media-limits` · PATCH `/admin/defaults` · GET `/admin/settings-history?key=` (from audit) |
| Content (SA) | CRUD `/admin/banners` `/admin/help` `/admin/pages` · POST `/admin/legal` (new version) · PUT `/admin/translations` · GET `/admin/translations/missing` · CRUD `/admin/exchange-rates` · CRUD `/admin/geo/{states,cities,neighborhoods}` · CRUD `/admin/country-settings` |
| Notifications | POST `/admin/broadcasts` (schedule) · GET `/admin/broadcasts` (stats) |
| CV portal (`cv.manage`) | GET `/admin/cv-requests` · POST `/:id/assign` · `/:id/deliver` (upload doc id) · `/:id/status` |
| Payments (`payments.*`) | GET `/admin/payments?state=` · GET `/admin/payments/:id` (receipt signed URL) · POST `/approve` · POST `/reject` · GET `/admin/payments.csv` |
| Support | GET `/admin/tickets` · POST `/admin/tickets/:id/reply` · GET `/admin/lookup/rentals` · `/admin/lookup/appointments` |
| Audit (`auditlog.read`) | GET `/admin/audit-logs?actor&entity&from&to` · GET `/admin/audit-logs/verify` |
| Analytics | GET `/admin/analytics/{overview,retention,listings-by-category,search-trends,zero-results,funnel,other-entries,signup-funnel}` · each `?format=csv` |
| Maps | GET `/admin/geo-usage` |
| Engines ⚑ | `/admin/engines/*` (plans, promotions, delivery zones, etc.) |

---

## 11. Background Jobs (pg-boss)

| Job / cron | Schedule | Does |
|---|---|---|
| `listing.scan` | on publish/edit | §9.2 |
| `listing.notify-matches` | on publish | saved-search matches (reuse search with `listingId` constraint) + job alerts |
| `notify.send` | queue | create Notification row, send push/email with retry (3x exponential), log to EmailOutbox |
| `notify.dedupe-batch` | inline | key = `type:subject:minuteBucket`; collapse many new-message pushes for same thread into one |
| `listing.expire` | every 15 min | ACTIVE & `expiresAt<now` → EXPIRED |
| `listing.expiry-reminders` | hourly | 7-day and 1-day reminders (flags on listing prevent duplicates) |
| `job.expire` | hourly | jobs past deadline/expiry |
| `appointment.reminders` | every 10 min | 24 h & 2 h |
| `appointment.confirm-window` | hourly | lapse → review eligible |
| `price-drop.check` | on price edit | notify favoriters |
| `media.cleanup` | daily | unattached > 24 h; deleted listing media after purge |
| `listing.purge` | daily | soft-deleted > 90 days |
| `account.deletion` | daily | §9.11 |
| `export.build` | on request | §9.11 |
| `broadcast.dispatch` | every minute | due broadcasts, chunked 500/run |
| `metrics.rollup` | nightly | `AnalyticsEvent` → `ListingMetricDaily`; response-rate calc; fx staleness alert |
| `retention.purge` | daily | Appendix D (OTP 24 h, login events 12 mo, raw events 13 mo, chat 24 mo, verification docs 90 d after decision, expired OTP…) logs a `JobRun` |
| `engines.*` ⚑ | varied | subscription expiry, boost expiry, auction end |

Each handler is idempotent and records a `JobRun`.

---

## 12. Adapters (interfaces)

```ts
EmailAdapter   { send(to, template, data, lang): Promise<void> }          // console | smtp
PushAdapter    { send(tokens[], {title, body, data}): Promise<{invalid:string[]}> } // console | fcm
SmsAdapter     { send(phone, text): Promise<void> }                        // mock | http
WhatsAppAdapter{ sendOtp(phone, code): Promise<void> }                     // mock | http
StorageAdapter { put(key, buf, {mime, isPrivate}), signedGet(key, ttl), delete(key), publicUrl(key) } // s3
ContentClassifier { classify(imageUrls[]): Promise<{flagged:boolean, labels:string[]}> } // noop | provider
MapsAdapter    { autocomplete(q), reverse(lat,lng) }                       // mock | google
SocialVerifier { verify(provider, token): Promise<{providerId,email?,emailVerified,name?}> } // google|facebook|apple (+mock when AUTH_MOCK=true)
CourierAdapter ⚑ { quote(zone), create(order) }                            // mock
```
Adapters are chosen by env (`EMAIL_DRIVER=console|smtp`, etc.). Failures never break the request: catch, log, queue retry (NFR-REL-04).

---

## 13. Search Design (M05) — summary

* `searchText` = normalized (title + description + customOtherText + searchable attribute values + category names AR/EN). Normalization (`shared/arabic.ts`): remove diacritics & tatweel; `أ إ آ ٱ → ا`; `ى → ي`; `ة → ه`; `ؤ → و`; `ئ → ي`; Arabic-Indic digits → ASCII; lower-case Latin; light stem: strip prefix `ال`, `وال`, `بال`; suffixes `ات ون ين ان ها ه`. Query goes through the same function. Admin synonyms (`search.synonyms` setting: `[["سيارة","عربية"],...]`) expand the query terms.
* Match: `searchText % :q OR searchText ILIKE '%'||:q||'%'` (word-wise AND of tokens, each token matched by ILIKE or similarity > 0.3).
* Score = `0.45*similarity + 0.25*freshness(exp decay, half-life 14 d) + 0.20*quality/100 + 0.10*engagement(log(views+3*favorites+5*leads))` (+ promotion boost ⚑ only if monetization on).
* Geo: bbox on `pubLat/pubLng` + Haversine `distanceKm` select; sort by distance when lat/lng provided.
* Filters: category subtree (recursive CTE of descendant IDs, cached), city, price range **in the requested currency** (convert via fresh rate or exclude other-currency rows if stale), type, `filters` JSON → for each key look up attribute definition → SELECT/MULTI via `dynamicAttributes @> '{"k":"v"}'`/`?|`, NUMBER/RANGE via `(dynamicAttributes->>'k')::numeric BETWEEN`, BOOLEAN, DATE.
* Keyset pagination on `(sortValue, id)` with the cursor carrying `asOf` timestamp so scores stay stable between pages.
* Always: `status='ACTIVE' AND deletedAt IS NULL AND expiresAt>now()` + exclude owners blocked relation when viewer signed in (blocked users still see public listings per PROF-07 — **do not** filter).
* Log query to `SearchLog` async (zero-results flag). Target p95 < 500 ms at 100k rows with filters.

---

## 14. Deployment & Scalability Path

* **Single small server (launch):** docker-compose → `api` (with `RUN_WORKER=true`), `postgres`, `minio` or R2. Daily `pg_dump` to object storage (cron container), restore documented in README and tested before launch (SYS-11).
* **Growth path (no redesign):** (1) separate `worker` container; (2) add Redis → shared rate-limits + socket adapter → run N API instances; (3) PgBouncer + read replica for search/home; (4) CDN in front of R2; (5) PostGIS/partitioning when > ~1M listings.
* **Environments:** dev / staging / prod via env files; CI (GitHub Actions): lint → typecheck → test (Postgres service) → build image → migrate → deploy. Staging sets `flags.bankak.userFlow=true`.
* **Observability:** `pino` JSON logs with `traceId`, `/health`, optional Sentry DSN, queue depth + p95 latency visible in `/admin/system-health` (counts from pg-boss tables, `pg_stat_*`).

---

## 15. Build Order (summary — details in file 02)

0 Bootstrap → 1 Foundation (settings, audit, adapters, i18n, errors, idempotency) → 2 Auth/Users/Admin-auth → 3 Geo + Catalog/EAV + seed → 4 Media → 5 Listings + scan → 6 Search/Home/Compare/Saved/Favorites → 7 Chat → 8 Notifications → 9 Verticals (rentals, appointments, hotels, jobs/CV, business) → 10 Trust & safety + reviews → 11 Admin, CMS, analytics, data rights, payments → 12 Dormant engines → 13 Hardening, Swagger, tests, Postman, Docker.

**Definition of Done (per module):** routes + Zod schemas + OpenAPI docs, service logic with permissions, Prisma migration, seed data if needed, audit entries for admin/moderation actions, notifications wired, integration tests for happy path + auth + validation + key business rule, Postman requests exist.
