# MARBOU Backend

Arabic-first multi-vertical marketplace API — Slice 1 (Auth, Users, Admin, Platform Config).

---

## Prerequisites

- Node.js 20 LTS
- Docker Desktop (for PostgreSQL)
- Python 3.x (for Postman collection generation)
- `npm` (comes with Node.js)

---

## Quick Start

```bash
# 1. Clone and install
git clone <repo>
cd marbouBackend2
npm install

# 2. Copy env
cp .env.example .env
# Edit .env — at minimum set JWT_USER_SECRET, JWT_ADMIN_SECRET, OTP_PEPPER, ADMIN_TOTP_ENC_KEY

# 3. Start PostgreSQL (and MinIO placeholder)
docker compose up -d db

# 4. Create test DB and run migrations
npm run test:setup        # creates marbou_test, runs prisma migrate deploy
npm run db:deploy         # runs migrations on marbou (main DB)

# 5. Seed reference data and admin user
npm run db:seed

# 6. Start dev server
npm run dev
# API: http://localhost:4000/api/v1
# Swagger: http://localhost:4000/docs
```

---

## Running Tests

```bash
# Unit + integration tests (Vitest + Supertest against marbou_test DB)
npm test

# Watch mode
npm run test:watch

# Type check only
npm run typecheck

# Lint
npm run lint
```

Tests require the test DB to exist. Run `npm run test:setup` once after `docker compose up -d db`.

---

## Admin Login & 2FA Enrollment

The seed creates one Super Admin:
- **Email:** `admin@marbou.test` (set via `SEED_ADMIN_EMAIL` in `.env`)
- **Password:** `Admin#12345` (set via `SEED_ADMIN_PASSWORD` in `.env`)

**Login flow (2-step):**

```bash
# Step 1 — password
curl -X POST http://localhost:4000/api/v1/admin/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@marbou.test","password":"Admin#12345"}'
# Returns: { mfaToken, needsEnrollment, otpauthUrl?, secret? }

# Step 2 — TOTP
curl -X POST http://localhost:4000/api/v1/admin/auth/verify-2fa \
  -H 'Content-Type: application/json' \
  -d '{"mfaToken":"<from step 1>","code":"000000"}'
# Returns: { accessToken, refreshToken }
```

**First login:** `needsEnrollment: true` — scan the `otpauthUrl` QR with an authenticator app (Google Authenticator, Authy). In dev/test, `DEV_TOTP_FIXED_CODE=000000` is accepted instead of a real TOTP code.

---

## OTP Dev Helper

When `DEV_HELPERS=true` (dev/test only), the last OTP sent for any email is retrievable:

```bash
curl "http://localhost:4000/dev/last-otp?email=user@test.com&purpose=REGISTER"
# Returns: { code: "123456" }
```

This is used by Postman pre-request scripts to automate OTP flows.

---

## Postman / Newman

```bash
# Generate collection from scripts/gen_postman.py
python scripts/gen_postman.py
# or
npm run postman

# Run with Newman (requires server running + seeded admin)
npx newman run postman/marbou.postman_collection.json \
  -e postman/local.postman_environment.json \
  --delay-request 50 \
  --reporters cli

# Run a single folder
npx newman run postman/marbou.postman_collection.json \
  -e postman/local.postman_environment.json \
  --folder "01 Auth"
```

**Folder run order matters** — each folder depends on tokens set by the previous one:
`00 Pre-request and Config` → `01 Auth` → `02 Profile` → `03 Admin`

---

## Adapters (switching from mock to real)

| Adapter | Env var | Values |
|---|---|---|
| Email | `EMAIL_DRIVER` | `console` (default) / `smtp` |
| SMTP URL | `SMTP_URL` | e.g. `smtp://user:pass@host:587` |
| SMS | `SMS_DRIVER` | `mock` (default) / `http` |
| WhatsApp | `WHATSAPP_DRIVER` | `mock` (default) / `http` |
| Storage | `STORAGE_DRIVER` | `local` (default); S3 planned |
| Social login | `AUTH_MOCK` | `true` in dev; set real `GOOGLE_CLIENT_IDS` etc. for prod |

---

## Feature Flags

All flags live in the `Setting` table and are cached for 60 seconds. Toggle via:

```bash
curl -X PATCH http://localhost:4000/api/v1/admin/flags/flags.otp.sms \
  -H 'Authorization: Bearer <adminToken>' \
  -H 'Content-Type: application/json' \
  -d '{"value": true}'
```

Key flags:
- `flags.otp.email` / `flags.otp.sms` / `flags.otp.whatsapp` — OTP channels (at least one must stay enabled)
- `flags.video.enabled` — video uploads
- `flags.bankak.userFlow` — Bankak payment UI (OFF in prod, ON in staging)
- `flags.monetization` — all monetization engines
- `flags.engine.*` — individual dormant engines

---

## Backup & Restore

```bash
# Backup
pg_dump $DATABASE_URL | gzip > backup_$(date +%Y%m%d).sql.gz

# Restore
gunzip -c backup_YYYYMMDD.sql.gz | psql $DATABASE_URL
```

---

## Scale-Out Steps

1. **Separate worker:** run `node dist/server.js` with `RUN_CRON=false` for API instances; run a dedicated cron instance with `RUN_CRON=true`.
2. **Redis:** set `REDIS_URL` — enables shared rate limits and Socket.io adapter (Slice 3+).
3. **PgBouncer:** add a connection pooler in front of PostgreSQL for high concurrency.
4. **CDN:** put Cloudflare R2 or AWS S3 in front of media (Slice 2+, `STORAGE_DRIVER=s3`).

---

## Known Limits (Slice 1)

- No media upload, listings, search, chat, notifications, bookings, jobs, payments yet (Slices 2–5).
- Dormant engines (M18) return 404 — flags exist but no routes.
- Storage is local filesystem only (`./storage`); S3 driver planned for Slice 2.
- No Arabic stemmer — `normalizeArabic()` normalization only.
- Offset cursor pagination (not keyset).
- MFA token single-use map is in-memory (single-instance only; noted in DEVIATIONS.md).

See `DEVIATIONS.md` for the full list of conscious deviations from the PRD.
