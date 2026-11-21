# MARBOU Backend — Fast-Track Simplification (OVERRIDES files 01 and 02)

> **Rule for the coding agent:** where this file conflicts with `01_BACKEND_ARCHITECTURE.md` or `02_BACKEND_IMPLEMENTATION_GUIDE.md`, **this file wins.** Everything user-facing in the PRD is still delivered. What is removed is infrastructure, duplicate tables and "scale-later" machinery.
> **Goal:** one developer + a coding agent ships a working, professional API in roughly **10–12 working days**, in slices that can each be demoed and tested in Postman.

---

## 1. The 12 Big Cuts

| # | Remove | Replace with | Why it is safe |
|---|---|---|---|
| 1 | pg-boss queue | **`node-cron` + plain async functions** (`setImmediate(() => scanListing(id))`). Notifications: send inline in try/catch, retry once. | Single server at launch. If you later run 2+ instances, wrap each cron tick in `pg_try_advisory_lock(<id>)` (3 lines). |
| 2 | Redis / socket Redis adapter / Redis rate-limit store | In-memory rate limit + in-memory cache | Not needed until multiple instances. |
| 3 | Adapter folders (`console.ts`/`real.ts` per integration) | **One file per integration** with `if (env.X_DRIVER==='console') { log; return }` at the top. Files: `email.ts`, `push.ts`, `sms.ts`, `maps.ts`, `storage.ts`, `social.ts`, `classifier.ts`. | Same testability, 1/3 of the files. |
| 4 | MinIO + S3 SDK for dev | **`STORAGE_DRIVER=local`** (files in `./storage`, public ones served by `express.static('/files')`; private ones only via `GET /media/private/:token`, an HMAC-signed 5-minute link). Add `s3` driver (lazy-import SDK) only when you deploy. | No Docker service to run; same API behaviour. |
| 5 | Idempotency table + middleware | Only two real needs: chat messages (`@@unique(senderId, idempotencyKey)`) and payments (`@@unique(reference)`). | Those are the only places the PRD's retry-safety matters. |
| 6 | Dynamic expression-index creation (`promoteToIndex` → `CREATE INDEX`) | Keep the flag column, ship **one GIN index** on `dynamicAttributes`. Add expression indexes by hand only if a load test fails. | Fine for tens of thousands of listings. |
| 7 | Keyset (score-based) pagination | **Opaque cursor = base64(offset)** `{o:40}`; frontend still sees `nextCursor`. | Satisfies "cursor-based"; far simpler SQL. Ranking stays: `0.5*similarity + 0.3*freshness + 0.2*quality`. |
| 8 | Arabic stemmer + synonym engine | Keep **`normalizeArabic()` only** (alef/hamza/ya/ta marbuta/diacritics) + trigram. | This is what gives "same results for spelling variants". Add stemming only if QA finds misses. |
| 9 | Perceptual dHash + near-match | Image duplicate check by **sha256 of the processed image** (exact). Add dHash later. | Catches reposts; 1 line instead of an algorithm. |
| 10 | Video ffmpeg poster/transcode | `ffprobe` only (duration, size, codec). **Poster = client uploads a JPEG with the video** (`posterMediaId`). No server transcoding. | Client already compresses (MED-05). Drops ffmpeg dependency except ffprobe. |
| 11 | 12 dormant engines (M18) | **Defer to after launch.** Ship only: flags in `Setting`, `GET /config` exposing them as `false`, and `requireFlag()` returning 404. Payments queue (M17) **is** built (it is Active). | They are hidden at launch by the PRD itself. ⚠ Check your contract: if Appendix B is contractually due at M3, schedule them as slice 7. |
| 12 | Generic over-engineering: `ScanResult`, `EmailOutbox`, `JobRun`, `DataExport`, `ListingMetricDaily`, `IdempotencyKey`, `AdminSession`, `OtherEntry` tables | See §2 (stored on existing rows or computed). | Fewer migrations, fewer services. |

**Keep as-is (they save time):** `Setting` table + 60 s cache; `defineRoute()` helper (gives Swagger → Postman for free); hash-chained `AuditLog` (≈25 lines); TypeScript + Prisma + Zod; Socket.io; the transition-table pattern.

---

## 2. Data Model: ~75 tables → ~38

**Merge rules**

| New / merged table | Replaces | How |
|---|---|---|
| `User` with array/JSON columns | UserCapability, UserBadge, NotificationPreference, DeviceToken, QuickReply, EmployerProfile, ServiceProfile | `capabilities Capability[]`, `badges String[]`, `notifPrefs Json`, `deviceTokens Json` (`[{token,platform}]`), `quickReplies Json`, `employerProfile Json?`, `serviceProfile Json?` (workingHours, slotMinutes, capacity, services) |
| `Place` (`level` STATE\|CITY\|NEIGHBORHOOD, `parentId`) | State, City, Neighborhood | one table, one admin CRUD, one tree endpoint |
| `Booking` (`kind` RENTAL\|APPOINTMENT\|INQUIRY) | RentalRequest, ServiceAppointment, AccommodationInquiry, AvailabilityBlock (use `kind=BLOCK`) | columns: `listingId?`, `providerId`, `userId`, `startsAt`, `endsAt`, `status String`, `details Json` (terms snapshot / vehicle info / guests / counter-offer / proposed time), `completedAt?`, `confirmedAt?`, `disputedAt?`, `reminded Json` |
| `Listing` with `listingType` incl. **`JOB`** | Job, JobAlert | A job is a listing in the *Jobs* category: employmentType, salary, deadline, requirements, screeningQuestions live in `dynamicAttributes`. It reuses create/validate/expiry/scan/report/favorite/search/saved-search (**job alerts = saved searches**). `/jobs…` routes are thin aliases over listing services. |
| `ChatMessage.meta Json` | Offer | offer = message `type=OFFER`, `meta={amount,currency,status,counterOfMessageId}` |
| `ModerationAction` (+ appeal columns) | Appeal | `appealMessage?`, `appealStatus?`, `appealDecidedBy?`, `appealNote?` |
| `ContentBlock` (`type` BANNER\|HELP\|PAGE, `slug`, `titleAr/En`, `bodyAr/En`, `data Json`, `startsAt?`, `endsAt?`, `order`, `published`) | Banner, HelpArticle, StaticPage | one admin CRUD, one public `GET /content?type=&slug=` (plus the PRD-named aliases `/help`, `/pages`, `/banners`) |
| `SupportTicket` (`messages Json[]`) | SupportTicket + TicketMessage | |
| `Payment` (`invoiceNo Int? @unique` from a sequence) | Invoice, LedgerEntry | refunds (flag OFF) = extra Payment row with negative amount + `refOf` |
| `Listing.scan Json` | ScanResult | `{flags[], risk, scannedAt}` |
| Admin stateless token | AdminSession | `AdminUser.tokenVersion Int`; revoke = increment; sign-in IP written to `AuditLog` (`ADMIN_LOGIN`) |
| Computed on demand | ListingMetricDaily, OtherEntry, DataExport, JobRun | metrics = `GROUP BY` over `AnalyticsEvent` (add index `(listingId, type, createdAt)`); Other-entries = `GROUP BY customOtherText` on Listing; export = generated in the request and streamed as JSON download (users are few at launch); job runs = pino logs |

**Final table list (≈38):**
`User, Session, OtpCode, LoginEvent, SocialIdentity, AdminUser, VerificationRequest, BlockedUser, Place, Setting, ExchangeRate, Translation, GeoUsage, Category, CategoryAttribute, Listing, ListingMedia, ListingView, Favorite, SavedSearch, SearchLog, MediaAsset, ChatThread, ChatMessage, Booking, CandidateProfile, JobApplication, CvBuildRequest, BusinessProfile, BusinessStaff, Review, Report, ModerationAction, Blacklist, Notification, Broadcast, ContentBlock, LegalDocumentVersion, LegalAcceptance, SupportTicket, Payment, AuditLog, AnalyticsEvent`.
(Field lists from file 01 §8 still apply; just apply the merges above.)

---

## 3. Code-Level Simplifications

1. **Folder layout shrinks** to one flat file per concern inside each module: `modules/<name>/{routes.ts, service.ts}`; put Zod schemas at the top of `routes.ts`. Shared: `db.ts, route.ts, errors.ts, auth.ts, settings.ts, audit.ts, arabic.ts, messages.ts, notify.ts, cron.ts`.
2. **Modules: 26 → 14 folders.**
   `auth` (M01+admin-auth) · `users` (M02+M22) · `catalog` (M03+geo+config+translations) · `media` · `listings` (M04, M06, M09, M12, M13, jobs-as-listings) · `search` (M05) · `chat` (M07) · `bookings` (M08 rentals/appointments, M11 inquiries) · `jobs` (applications, candidate, CV) · `business` (M14) · `trust` (M15 + reviews) · `notifications` (M16) · `payments` (M17) · `admin` (M24, M25, M23 CMS, system health; uses CRUD factory below).
3. **Generic admin CRUD factory** (saves ~40 endpoints):
```ts
crud({ router, path:'/admin/content', model:'contentBlock', perm:'content.manage', audit:true,
       createSchema, updateSchema, searchFields:['slug','titleEn'] })
// registers GET list, GET one, POST, PATCH, DELETE, writes audit before/after
```
   Use it for: ContentBlock, Place, Translation, Blacklist, ExchangeRate, Broadcast, LegalDocumentVersion, Category, CategoryAttribute (+ custom `reorder`/`archive`/`preview` endpoints on top).
4. **One status-transition helper** for Booking and similar flows:
```ts
const T = { RENTAL: { REQUESTED: { ACCEPT:['owner','ACCEPTED'], DECLINE:['owner','DECLINED'], COUNTER:['owner','COUNTERED'], CANCEL:['user','CANCELLED'] },
                      COUNTERED: { ACCEPT:['user','ACCEPTED'], CANCEL:['user','CANCELLED'] }, ACCEPTED:{ COMPLETE:['owner','COMPLETED'] } },
            APPOINTMENT: {...}, INQUIRY: {...} };
transition(booking, action, actorRole) // checks actor+state, updates, notifies, audits
```
5. **Notifications:** one `notify(userId, type, vars)` doing: insert Notification → check `notifPrefs` → push/email in try/catch. Templates in one `messages.ts` object `{ key:{ar,en} }`.
6. **Scan:** a single `scanListing(id)` function (keywords, blacklist, sha256 duplicate, text similarity, classifier, scam words → risk). Called via `setImmediate` after create/edit. No queue.
7. **Cron (`cron.ts`)** — only 7 schedules: every 15 min (`expire listings/jobs, lift suspensions, publish scheduled broadcasts`), every 10 min (`appointment reminders, confirm-window`), hourly (`expiry reminders 7d/1d`), daily (`orphan media cleanup, soft-delete purge, account deletion after grace, retention purge, response-rate calc, FX staleness check`).
8. **Auth:** keep all PRD rules but write as **one `auth/service.ts`** (~250 lines). Social login: implement Google + Facebook + Apple verifiers as three small functions; `AUTH_MOCK=true` accepts `mock:<email>:<name>` so you can finish everything without provider accounts.
9. **Search:** one SQL builder function (offset cursor). Filters: category subtree, city, type, price range (same-currency unless fresh rate), `filters` JSON for dynamic attributes (`@>` for selects/booleans, numeric `BETWEEN` for numbers), bbox+Haversine radius, sort by relevance/newest/price/distance.
10. **Chat:** Socket.io only for `message:new`, `typing`, `read`, `offer:updated`. Everything else (history, send fallback, offers, mute, unread) is REST → also provides the polling fallback automatically.
11. **Rate limiting:** two limiters only — `strict` (auth/OTP/reveal/upload: 20/min/IP) and `normal` (300/min/IP) + the DB-based rules the PRD names (lockout via LoginEvent, message throttle, listing caps, guest reveal cap).
12. **Tests:** see §6 — Postman is the main acceptance tool; Vitest only for the 8 rules that are easy to break.

---

## 4. Build Order — 6 Demoable Slices (≈ 10–12 working days)

Each slice ends with: Swagger updated → Postman folder passing → commit. Stop at any slice and you still have a working API.

| Slice | Days | Build | Postman folders that must pass |
|---|---|---|---|
| **1. Core + Identity** | 1.5–2 | Project setup, env, `db`, `route`, errors, settings, audit, messages, rate limits, local storage driver, **auth** (register/OTP/login/refresh rotation/social/sessions/reset/lockout), **users** (profile, capabilities, block, verification request), **admin login + 2FA + RBAC**, `/config`, `/translations`, `/health`, dev helpers | 00 Health, 01 Auth, 02 Profile, 03 Admin login |
| **2. Catalog + Listings** | 2–2.5 | Place seed (Sudan), categories + attributes seed (spec in file 02 §4), schema endpoint with ETag, Other option, validator builder, **media** (image→webp, doc private, video ffprobe), **listings** (create/draft/publish/edit/renew/sold/delete/duplicate/bulk, quality score, readable ID, caps/rate limits, approx location, contact-reveal, view counting, detail payload, jobs-as-listings), scan function, expiry cron | 04 Catalog, 05 Media, 06 Listings |
| **3. Discover + Talk** | 2 | **search** (+suggest, home, nearby, compare, price insight, saved searches, favorites, price-drop notify), **chat** (threads, messages, offers, receipts, unread, throttle, block, sockets), **notifications** (feed, prefs, tokens, push/email, localized) | 07 Search, 08 Favorites/Saved, 09 Chat, 16 Notifications |
| **4. Verticals** | 2 | **bookings** (rentals, appointments with slots + capacity lock, hotel inquiries + confirm-stay + availability blocks), **jobs** (apply quick/full, employer dashboard, status flow, signed document access, candidate profile, CV requests/approve/revision, HTML CV), **business** (profile, staff add-by-email, analytics + CSV) | 10 Rentals, 11 Appointments, 12 Hotels, 13 Jobs & CV, 14 Business |
| **5. Trust + Admin + Content** | 2 | **trust** (reports, auto-hide, moderation actions w/ reason codes, sanctions, appeals, blacklist, fraud score, reviews with qualifying-interaction rules), **admin** (KPIs, users, listings, verification queue, CV portal, payments queue + approve/reject/invoice, settings/flags/media limits/defaults, content CRUD, legal versions, translations, exchange rates, broadcasts, audit viewer + verify, analytics + CSV, system health), sitemap/robots/OG meta, data export, deletion/deactivate, retention job | 15 Reports/Mod, 17 Payments, 18 Admin, 19 Data rights |
| **6. Harden + Ship** | 1 | OpenAPI export → Postman collection + environments, README, `.env.example`, Dockerfile + compose (db + api), seed demo data, 100k load seed + one autocannon run, security pass (no phone/exact coords/doc keys leaks), CI | Full Newman run green |

*(Estimates assume a coding agent doing the typing and you reviewing/running each slice. Treat them as planning numbers, not guarantees.)*

---

## 5. What Is Deferred, Honestly

| Deferred | Impact | When |
|---|---|---|
| 12 dormant engines (auctions, barter, cart, delivery, subscriptions, promotions, credits, boosts, wholesale, asset rental, AdMob, hotel reservations) | Not visible at launch per PRD §11; flags exist and return 404/false | Slice 7 after launch (≈4–5 days), or earlier if the contract demands Appendix B at M3 |
| Chunked/resumable video upload, server transcoding | Clients compress first; oversized files are rejected with a clear message | Later, if uploads fail on weak networks |
| PostGIS, partitioning, Redis, queue server | Not needed under ~100k–500k listings / one server | When load tests or traffic require (upgrade path in file 01 §14) |
| Arabic stemming, synonyms UI, perceptual-hash near-match, expression indexes | Search quality/perf polish | After QA feedback |
| Scheduled CSV report emails (ANL-05 "by schedule") | On-demand CSV is built | Later |

List these in `DEVIATIONS.md` so the client sees them as conscious scope/phase decisions, not omissions.

---

## 6. Leaner Testing (still professional)

1. **Postman/Newman is the acceptance suite** (generated from OpenAPI; folder order in file 02 §16). Every request has: status check + one key-field check; each module has at least one `[NEG]` request (401/403/400/429).
2. **Vitest only for these 8 rules** (pure logic or race-prone):
   1. refresh-token rotation + reuse revokes the session family
   2. OTP attempts/cooldown/expiry + login lockout delays
   3. listing caps/hourly limit + approx-location privacy + no phone in payloads
   4. `normalizeArabic` table tests + one search test (variants return same listing)
   5. chat idempotent retry ×3 ⇒ 1 message + offer counter/accept flow
   6. appointment double-booking race (two parallel requests, capacity 1)
   7. review eligibility (needs qualifying interaction; unique per interaction)
   8. audit chain verify detects tampering; moderator gets 403 on settings/payments
3. **Skip** the full per-module test matrix and the 70% coverage gate; revisit if time allows.
4. **Manual smoke** = the 12-step curl list in file 02 §15.2.

---

## 7. Updated Phase Map (replaces file 02's 13 phases)

| File 02 phase | Becomes |
|---|---|
| 0 Bootstrap, 1 Foundation | Slice 1 (minus pg-boss, adapters folders, idempotency middleware) |
| 2 Auth/Users/Admin | Slice 1 |
| 3 Catalog/Geo/Seed, 4 Media, 5 Listings | Slice 2 |
| 6 Search, 7 Chat, 8 Notifications | Slice 3 |
| 9 Verticals | Slice 4 (bookings merged; jobs-as-listings) |
| 10 Trust, 11 Admin/CMS/Analytics/Payments/Data rights | Slice 5 |
| 12 Dormant engines | Deferred (§5) |
| 13 Hardening | Slice 6 |

Ignore in file 02: §1.4 `idempotency.ts`, §2 items 1 and 5, all pg-boss references, §5 thumbnail 150 px & phash, §7.1 keyset SQL (use offset cursor), §10.4 JobAlert table, §12.4 rollup table, §12.5 DataExport table, and any "optional Redis" wording.

---

## 8. Copy-Paste Instruction for Your Coding Agent

> Build the MARBOU backend from `01_BACKEND_ARCHITECTURE.md` and `02_BACKEND_IMPLEMENTATION_GUIDE.md`, but **`03_FAST_TRACK_SIMPLIFICATION.md` overrides both**. Work slice by slice (§4). Use Express + TypeScript + Prisma + PostgreSQL (pg_trgm only) + Zod + Socket.io + node-cron. No Redis, no queue server, no MinIO in dev (`STORAGE_DRIVER=local`), no PostGIS. Use the merged data model in §2 (about 38 tables) and the 14 modules in §3. Every endpoint must be declared with `defineRoute()` so Swagger and the Postman collection are generated. After each slice: run typecheck, run the Postman folders for that slice, then commit. Mock all third parties by default. Do not build the dormant engines; expose their flags only. Record every deviation from the PRD in `DEVIATIONS.md`.
