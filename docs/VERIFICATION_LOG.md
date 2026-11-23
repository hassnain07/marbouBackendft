# VERIFICATION LOG

---

## Slice 2 — Fix Round 2

### typecheck

```
> npx tsc --noEmit

(no output = 0 errors)
```
Exit code: 0 ✅

### build

```
> npx tsc -p .

(no output = success)
```
Exit code: 0 ✅

### lint

```
> marbou-backend@1.0.0 lint
> eslint src test

src/modules/listings/write.ts
  9:15  warning  'ListingStatus' is defined but never used  @typescript-eslint/no-unused-vars

src/modules/media/routes.ts
  7:23  warning  'optionalAuth' is defined but never used  @typescript-eslint/no-unused-vars

src/modules/media/service.ts
  2:8  warning  'path' is defined but never used  @typescript-eslint/no-unused-vars

test/slice1.test.ts
    3:62  warning  'loginUser' is defined but never used
    6:10  warning  'storage' is defined but never used
  165:13  warning  'accessToken' is assigned a value but never used
  195:26  warning  'refreshToken' is assigned a value but never used

test/slice2.test.ts
  1:1  warning  Unused eslint-disable directive

✖ 8 problems (0 errors, 8 warnings)
```
Exit code: 0 ✅ (0 errors, warnings only in existing test files and unused imports)

### prisma migrate status (test DB)

```
> npx prisma migrate status --schema=prisma/schema.prisma

Database schema is up to date!
  20241120000001_init                        — applied
  20241120000002_extras                      — applied
  20261121123323_slice2_catalog_listings     — applied
  20261122000001_rename_columns              — applied
  20261122000002_attr_searchable             — applied
```
✅

### seed (run 1)

```
> marbou-backend@1.0.0 db:seed
> tsx prisma/seed.ts

🌱 Starting seed...
Seeding settings...
  ✓ 60 settings
Seeding exchange rates...
  ✓ exchange rate already exists
Seeding admin users...
  ✓ Super Admin: admin@marbou.test
Seeding Sudan places...
  ✓ 18 states, 18 cities, 12 neighborhoods (new)
Seeding categories...
  ✓ 13 categories, 35 attributes (new)
✅ Seed complete
```
Exit code: 0 ✅

### seed (run 2 — idempotency check)

```
> marbou-backend@1.0.0 db:seed
> tsx prisma/seed.ts

🌱 Starting seed...
Seeding settings...
  ✓ 60 settings
Seeding exchange rates...
  ✓ exchange rate already exists
Seeding admin users...
  ✓ Super Admin: admin@marbou.test
Seeding Sudan places...
  ✓ 0 states, 0 cities, 0 neighborhoods (new)
Seeding categories...
  ✓ 0 categories, 0 attributes (new)
✅ Seed complete
```
Exit code: 0 ✅ — second run changes nothing

### Vitest — full run (all 3 test files)

```
> marbou-backend@1.0.0 test
> vitest run

 RUN  v2.1.8

 ✓ test/slice1.test.ts (43 tests) 28022ms
 ✓ test/b09-b11.test.ts (29 tests) 14388ms
 ✓ test/slice2.test.ts (74 tests) 115234ms

 Test Files  3 passed (3)
      Tests  146 passed (146)
   Start at  ...
   Duration  ~160s
```
Exit code: 0 ✅ — 146/146 tests green

### Newman

Newman requires a running server (`npm run dev`) and seeded DB. Run manually:

```bash
# Working directory must be the project root (postman/ files are relative)
npx newman run postman/marbou.postman_collection.json \
  -e postman/local.postman_environment.json \
  --delay-request 50 \
  --reporters cli

# Single folder
npx newman run postman/marbou.postman_collection.json \
  -e postman/local.postman_environment.json \
  --folder "06 Listings"
```

Folder order: 00 → 01 → 02 → 03 → 04 → 05 → 06

---

## Slice 2 — Fix Round 1

### typecheck

```
> npx tsc --noEmit
(no output = 0 errors)
```
Exit code: 0 ✅

### lint

```
✖ 13 problems (0 errors, 13 warnings)
```
Exit code: 0 ✅

### Vitest

```
Test Files  3 passed (3)
Tests       146 passed (146)
```
Exit code: 0 ✅

---

## Slice 1 — Fix Round 2

### Vitest

```
Test Files  2 passed (2)
Tests       66 passed (66)
Duration    104.95s
```
Exit code: 0 ✅
