# AGENT REPORT — Slice 1 Complete (A1–A7, B1–B11, Fix Round 2)

## Summary

All Slice 1 items are now done. Items previously reported as done that were not are called out explicitly below.

---

## Fix Round 2 Items

| Item | Status | Evidence |
|---|---|---|
| 1. B3 OTP public route restrictions | ✅ Done | `auth/routes.ts`: public `/auth/otp/request` and `/auth/otp/verify` now accept only `REGISTER`/`RESET` via Zod enum; email `.transform(trim+lowercase)` on all email fields; `.refine` for email-or-phone and channel-matches-identifier; `/dev/last-otp` lowercases+trims email; `requestOtpPublic` returns 200 silently for unknown emails; 5 new tests in `b09-b11.test.ts` |
| 2. B7 remainder | ✅ Done (pre-existing from prior round) | `admin/service.ts`: `checkAdminLockout` uses AuditLog `ADMIN_BAD_PASSWORD`/`ADMIN_BAD_TOTP`; bad password counted before isActive/IP checks; MFA jti single-use via `usedMfaJtis` Map; `updateSetting` rejects null, array/object mismatches, wrong types for flags |
| 3. A7 remainder | ✅ Done (pre-existing from prior round) | `config/env.ts`: `strictBool` parser (`"true"`/`"1"` only); production guards for `ADMIN_TOTP_ENC_KEY` and `ANALYTICS_SALT` ≥32 chars + placeholder check; `audit.ts` `canonicalJson` sorts keys recursively; `helpers.ts` `clearTables()` throws unless DB name ends with `_test` |
| 4. A1 setup-test-db.ts | ✅ Done (pre-existing from prior round) | `scripts/setup-test-db.ts`: tries `docker compose exec -T db psql`, falls back to direct `psql`, prints manual instruction on failure |
| 5. A4 Postman | ✅ Done | `scripts/gen_postman.py` is complete with all required folders (00–03), all NEG requests, lockout sequence, refresh reuse, MFA reuse, finance auditor flow; `npm run postman` delegates to it; `postman/marbou.postman_collection.json` and `postman/local.postman_environment.json` generated and committed |
| 6. A5 docs | ✅ Done | `README.md` written with prerequisites, quick start, admin 2FA, OTP helper, Postman/Newman, adapters, flags, backup/restore, scale-out, known limits; `AGENT_REPORT.md` (this file) rewritten; `DEVIATIONS.md` cleaned |

---

## Previously Reported as Done That Were Not

| Item | What was wrong | Now fixed |
|---|---|---|
| B3 OTP public route | Route accepted all `OtpPurpose` values including `CHANGE_EMAIL`/`PHONE`/`DELETE_ACCOUNT`; no email/phone refine on public verify; `/dev/last-otp` did not trim; no tests | Fixed in this round |
| A4 Postman | `scripts/build-postman.ts` was a one-line placeholder; collection was hand-written and incomplete | `gen_postman.py` now generates the full collection programmatically |
| A5 README | No README.md existed | Written in this round |

---

## All Slice 1 Items

### A Items

| Item | Status | Evidence |
|---|---|---|
| A1 setup-test-db.ts | ✅ Done | `docker compose exec -T` strategy, psql fallback, manual instruction |
| A2 (not in scope) | — | — |
| A3 (not in scope) | — | — |
| A4 Postman collection | ✅ Done | `gen_postman.py` generates full collection; `build-postman.ts` delegates to it |
| A5 README + docs | ✅ Done | `README.md`, `AGENT_REPORT.md`, `DEVIATIONS.md` all updated |
| A6 (not in scope) | — | — |
| A7 env.ts strict bool + prod guards + canonicalJson | ✅ Done | `strictBool`, `ADMIN_TOTP_ENC_KEY`/`ANALYTICS_SALT` guards, placeholder check, recursive key sort |

### B Items

| Item | Status | Evidence |
|---|---|---|
| B01 JWT errors → 401 | ✅ Done | `TOKEN_EXPIRED` for expired; type `access` check rejects refresh/mfa tokens |
| B02 Canonical JSON in audit | ✅ Done | `canonicalJson` sorts keys recursively; `verify()` returns string not BigInt |
| B03 OTP public route restrictions | ✅ Done | This round — see Fix Round 2 above |
| B04 Login lockout timing | ✅ Done | Timing from last failure; LOCKED outcome not counted as BAD_PASSWORD; per-IP threshold |
| B05 Session cache invalidation | ✅ Done | `invalidateUserSessions` called after email confirm, phone verify, capability grant, password reset |
| B06 Social login fixes | ✅ Done | privaterelay treated as unverified; SUSPENDED rejected on link path; pre-registration takeover protection |
| B07 Admin password change + settings validation | ✅ Done | ≥12 chars, bumps tokenVersion, returns tokens; mustChangePassword enforcement; GET /admin/settings SA only; updateSetting validates key/type/null |
| B08 Crypto randomInt for OTP | ✅ Done | `crypto.randomInt(0, 1_000_000)` in `crypto.ts` |
| B09 validatePhone | ✅ Done | E.164 + Sudanese local conversion; applied in register, PATCH /me/phone, phone OTP; verifiedPhone never altered by PATCH |
| B10 Misc fixes | ✅ Done | CORS `cb(null,false)`; strict limiter on /auth/refresh; listSessions returns `isCurrent`+`deviceId`; contactPrefs merges; employer/service setup size-limited; /config marks `suppressed`; changePassword revokes other sessions |
| B11 Tests for B09-B10 | ✅ Done | `test/b09-b11.test.ts` — 29+ tests covering all B items |

## Test Results (last run)

```
Test Files  2 passed (2)
Tests       71 passed (71)
```

- `npm run typecheck` — ✅ 0 errors
- `npm run build` — ✅ success
- `npm run lint` — ✅ 0 errors (4 warnings, unused vars in test file)
- `npm test` — ✅ all tests green
