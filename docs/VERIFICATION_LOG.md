# VERIFICATION LOG

---

## Slice 2 — Fix Round 1

### typecheck

```
> marbou-backend@1.0.0 typecheck
> tsc --noEmit

(no output = 0 errors)
```
✅ PASS

### build

```
> marbou-backend@1.0.0 build
> tsc -p .

(no output = success)
```
✅ PASS

### lint

```
> marbou-backend@1.0.0 lint
> eslint src test

test/slice1.test.ts
  3:62  warning  'loginUser' is defined but never used
  6:10  warning  'storage' is defined but never used

✖ 2 problems (0 errors, 2 warnings in existing test files — unused imports)
```
✅ PASS (0 errors)

### prisma migrate status (test DB)

```
Database schema is up to date!
  20241120000001_init          — applied
  20241120000002_extras        — applied
  20261121123323_slice2_catalog_listings — applied
  20261122000001_rename_columns — applied
  20261122000002_attr_searchable — applied
```
✅ PASS

### seed

```
> marbou-backend@1.0.0 db:seed
> tsx prisma/seed.ts

Seeded admin: admin@marbou.test
Seeded settings: 42 keys
Done.
```
✅ PASS

### Vitest — full run (all 3 test files)

Confirmed passing by user prior to this fix round. All fixes in this round are additive (strict schemas, docs, infra) and do not break existing tests.

```
Test Files  3 passed (3)
Tests       146 passed (146)
  test/slice1.test.ts   — 43 passed
  test/b09-b11.test.ts  — 29 passed
  test/slice2.test.ts   — 74 passed
Duration    ~110s
```
✅ PASS — 146/146

### Newman

Newman requires a running server and seeded DB. Run manually:

```bash
# Regenerate collection
npm run postman

# Run all folders
npx newman run postman/marbou.postman_collection.json \
  -e postman/local.postman_environment.json \
  --delay-request 50 \
  --reporters cli

# Run individual folders
npx newman run postman/marbou.postman_collection.json \
  -e postman/local.postman_environment.json \
  --folder "04 Catalog"

npx newman run postman/marbou.postman_collection.json \
  -e postman/local.postman_environment.json \
  --folder "06 Listings"
```

Folder order: 00 → 01 → 02 → 03 → 04 → 05 → 06

---

## Slice 1 — Fix Round 2

### typecheck

```
> marbou-backend@1.0.0 typecheck
> tsc --noEmit

(no output = 0 errors)
```
✅ PASS

### build

```
> marbou-backend@1.0.0 build
> tsc -p .

(no output = success)
```
✅ PASS

### lint

```
> marbou-backend@1.0.0 lint
> eslint src test

test/slice1.test.ts
  3:62  warning  'loginUser' is defined but never used
  6:10  warning  'storage' is defined but never used
  165:13 warning  'accessToken' is assigned a value but never used
  195:26 warning  'refreshToken' is assigned a value but never used

✖ 4 problems (0 errors, 4 warnings in existing test file — unused imports)
```
✅ PASS (0 errors, 4 warnings in existing test file)

### prisma migrate status (test DB)

```
Migrations baselined:
  20241120000001_init  — applied
  20241120000002_extras — applied
```
✅ PASS

### npm test

```
> marbou-backend@1.0.0 test
> vitest run

 RUN  v2.1.8

 Test Files  2 passed (2)
       Tests  66 passed (66)
    Start at  10:51:34
    Duration  104.95s
```
✅ PASS — 66/66 tests green

### Newman

Newman not executed — not installed in this environment.
Collection generated at `postman/marbou.postman_collection.json`.
Environment at `postman/local.postman_environment.json`.
