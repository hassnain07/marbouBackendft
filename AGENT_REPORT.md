# AGENT REPORT — Slice 1 + Slice 2 (Fix Round 1)

---

## Slice 2 — Fix Round 1

### Items from the Slice 2 Fix Round prompt

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | Publish rules — `assertCanPublish` in same tx, advisory lock, cap, hourly/daily, fraud halving, delayed visibility | ✅ Done | `create.ts`: `assertCanPublish(tx,user,categoryId)` with `pg_advisory_xact_lock`; called inside `$transaction` in `createListing` and `publishListing`; `renewListing` does cap-only tx for EXPIRED |
| 2 | Location — exact lat/lng stored, deterministic jitter (hash→PRNG, uniform disc, cos correction), approxRadiusM clamped 100..2000, lat/lng range in Zod, PATCH recomputes, duplicate copies coords | ✅ Done | `computeJitterFixed` in `create.ts`; Zod `min(-90).max(90)` / `min(-180).max(180)` in `routes.ts`; `duplicateListing` copies `lat,lng,pubLat,pubLng,videoMediaId` |
| 3 | Validator — `dependsOn` superRefine, TEXT default maxLength 500, unknown keys → 400 | ✅ Done | `validator.ts`: `.strict()` + `superRefine`; TEXT now defaults to `max(rules?.maxLength ?? 500)` |
| 4 | Auth & state machine — bulkAction one-query load, NOT_FOUND for unowned, HIDE checked, markSold ACTIVE only, archive states, SUSPENDED → LISTING_LOCKED, AUTO_HIDDEN/PENDING_REVIEW patchable | ✅ Done | `write.ts`: `bulkAction` loads with `where id in ids AND ownerId = me`; `LOCKED_STATUSES`; `ARCHIVABLE` list |
| 5 | Input handling — strict PATCH schema (unknown keys → 400), cleanText everywhere, media attach validation, VIDEO kind normalized to uppercase | ✅ Done | `routes.ts`: `patchBody.strict()`; `media/service.ts`: `kind: 'VIDEO'` |
| 6 | Contact reveal — phone check before recording, advisory lock + await in tx, lead endpoint | ✅ Done | `write.ts` `contactReveal`: phone check before `$transaction`; tx with advisory lock and `await` |
| 7 | Scan — Arabic-Indic digits, Sudanese phone patterns, currency exclusion, price exclusion, logged errors, retry, conditional updateMany, cron sweeper every 5 min | ✅ Done | `scan.ts`; `cron.ts`: `sweepPendingReview` on `*/5 * * * *` |
| 8 | Media & infra — MulterError mapping, `/me/listings` status enum + cursor + `{data,nextCursor}`, OpenAPI for multipart routes | ✅ Done | `errors.ts`: `multer.MulterError` handler; `routes.ts`: `listingStatusEnum`, cursor query; `read.ts`: `paginate()`; `media/routes.ts`: `registry.registerPath` for 3 upload routes |
| 9 | Postman — rewritten in TypeScript, folders 00–06, gen_postman.py deleted | ✅ Done | `scripts/build-postman.ts` is pure TypeScript; `scripts/gen_postman.py` deleted; folders 04 Catalog, 05 Media, 06 Listings added |
| 10 | Docs & cleanup — `tmp_q.sql` deleted, README updated (media/listings/Postman), DEVIATIONS.md cleaned, AGENT_REPORT.md updated | ✅ Done | `tmp_q.sql` deleted; README has Media + Listings sections; DEVIATIONS.md: "planned Slice 2" wording removed, new deviations added |

### Test results (all 146 passing — confirmed by user before this fix round)

```
Test Files  3 passed (3)
Tests       146 passed (146)
```

All fixes in this round are non-test-breaking: strict PATCH schema, lat/lng ranges, TEXT maxLength, VIDEO kind normalization, MulterError mapping, cursor pagination, OpenAPI registration, docs.

---

## Slice 1 — Fix Round 2

| Item | Status | Evidence |
|---|---|---|
| B3 OTP public route restrictions | ✅ Done | `auth/routes.ts`: public `/auth/otp/request` and `/auth/otp/verify` accept only `REGISTER`/`RESET`; email `.transform(trim+lowercase)`; `/dev/last-otp` lowercases email |
| B7 Admin password change + settings validation | ✅ Done | `admin/service.ts`: ≥12 chars, bumps tokenVersion; `updateSetting` rejects null/wrong types |
| A7 env.ts strict bool + prod guards | ✅ Done | `strictBool` parser; `ADMIN_TOTP_ENC_KEY`/`ANALYTICS_SALT` guards |
| A4 Postman collection | ✅ Done | Now TypeScript; folders 00–06 |
| A5 README + docs | ✅ Done | README, AGENT_REPORT, DEVIATIONS all updated |

## All Slice 1 Items

| Item | Status |
|---|---|
| A1 setup-test-db.ts | ✅ Done |
| A4 Postman collection | ✅ Done |
| A5 README + docs | ✅ Done |
| A7 env.ts strict bool + prod guards + canonicalJson | ✅ Done |
| B01 JWT errors → 401 | ✅ Done |
| B02 Canonical JSON in audit | ✅ Done |
| B03 OTP public route restrictions | ✅ Done |
| B04 Login lockout timing | ✅ Done |
| B05 Session cache invalidation | ✅ Done |
| B06 Social login fixes | ✅ Done |
| B07 Admin password change + settings validation | ✅ Done |
| B08 Crypto randomInt for OTP | ✅ Done |
| B09 validatePhone | ✅ Done |
| B10 Misc fixes | ✅ Done |
| B11 Tests for B09-B10 | ✅ Done |
