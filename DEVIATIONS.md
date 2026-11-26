# DEVIATIONS.md

All conscious deviations from the PRD, architecture file (01), and implementation guide (02).
File 03 (Fast-Track Simplification) overrides 01 and 02 where they conflict.

## Infrastructure / Technology

| Deviation | Reason |
|---|---|
| No pg-boss queue — uses `node-cron` + `setImmediate` | File 03 §1 cut #1: single server at launch |
| No Redis | File 03 §1 cut #2: not needed until multiple instances |
| No MinIO in dev — `STORAGE_DRIVER=local` with `express.static` | File 03 §1 cut #4 |
| No PostGIS, no partitioning | File 03 §1: not needed below ~1M rows |
| `bcryptjs` instead of Argon2id | File 01 §2 table: allowed by NFR-SEC-02 |
| Prisma 5.22 (not latest) | Pinned for stability; upgrade path documented |
| `zod` 3.x (not 4.x) | Pinned for `@asteasolutions/zod-to-openapi` compatibility |

## Data Model (Slice 1 — tables in schema.prisma)

| Deviation | Reason |
|---|---|
| ~15 tables in Slice 1 instead of 75+ (full PRD) | Slices 2–5 add remaining tables |
| No `Country` table — `User.countryCode String @default("SD")` | Simplified; country list is static for Sudan launch |
| `AdminUser.tokenVersion Int` instead of `AdminSession` table | File 03 §2: stateless admin token revocation |
| `User` has merged columns: `capabilities[]`, `badges[]`, `notifPrefs Json`, `deviceTokens Json`, `employerProfile Json?`, `serviceProfile Json?` | File 03 §2 merge rules |
| `Booking` table (merges RentalRequest + ServiceAppointment + AccommodationInquiry) — **planned Slice 4** | File 03 §2 |
| `Place` table (merges State + City + Neighborhood) — added in Slice 2 | File 03 §2 |
| `ContentBlock` (merges Banner + HelpArticle + StaticPage) — **planned Slice 5** | File 03 §2 |
| `ChatMessage.meta Json` replaces `Offer` table — **planned Slice 3** | File 03 §2 |
| `ModerationAction` with appeal columns — **planned Slice 5** | File 03 §2 |
| `Payment.invoiceNo` instead of separate `Invoice` table — **planned Slice 5** | File 03 §2 |
| `Listing.scan Json` instead of `ScanResult` table — added in Slice 2 | File 03 §2 |
| `DataExport`, `ListingMetricDaily`, `OtherEntry`, `JobRun`, `EmailOutbox`, `IdempotencyKey` tables — **planned Slice 5** | File 03 §2: computed on demand or logged |
| `Category`, `CategoryAttribute`, `Listing`, `ListingMedia` — added in Slice 2 | Built |
| `ChatThread`, `ChatMessage`, `Booking`, `CandidateProfile`, `JobApplication`, `CvBuildRequest`, `BusinessProfile`, `BusinessStaff`, `Review`, `Report`, `ModerationAction`, `Blacklist`, `Notification`, `Broadcast`, `Payment`, `SupportTicket` — planned Slices 3–5 | Not yet built |
| `businessId` on `Listing` has no FK constraint — column exists, FK deferred | Slice 3 will add the BusinessProfile table |
| HEIC images rejected with `UNSUPPORTED_IMAGE_FORMAT` | sharp does not support HEIC without native libheif; client must convert first |
| No 150px thumbnail — only 400px (`_m`) thumb generated | File 03 §1 cut: one thumb size sufficient at launch |
| No perceptual hash (phash/dHash) — sha256 of processed image used for exact-duplicate detection | File 03 §1 cut #9: dHash deferred |
| No server-side video poster extraction — `videoPosterUrl` set by client via `posterMediaId` | File 03 §1 cut #10: client compresses and extracts poster |
| Geo autocomplete deferred — `/geo/autocomplete` not implemented | Slice 3+; trigram search sufficient at launch |

## Slice 3 — Discover + Talk

| Deviation | Reason |
|---|---|
| Area unit conversion (sqm ↔ sqft) not implemented | Deferred; Sudan market uses sqm only |
| DAILY saved-search digest is minimal (no diff from last run) | Full diff requires storing last result set; deferred to Slice 5 |
| Business inbox (multi-staff threads) deferred | BusinessProfile table arrives in Slice 4 |
| Moderator access to reported threads deferred | Report table arrives in Slice 5 |
| FCM real delivery untested | firebase-admin loaded lazily via require(); no test account available; console driver used in dev/test |
| Catalog taxonomy is a starter set | seed-data.ts contains representative categories; full PRD taxonomy deferred |
| Gedaref City was incorrectly under Kassala in seed-data.ts | Fixed: Gedaref City is now under Gedaref state; Kassala City renamed to distinguish from state |
| pg_trgm extension required for similarity() in search | Must be enabled on the DB: `CREATE EXTENSION IF NOT EXISTS pg_trgm;` — search falls back gracefully if not installed |
| Search offset cursor (not keyset) | Consistent with Slice 1-2 pagination approach |

| Deviation | Reason |
|---|---|
| Dormant engines (M18) not built — flags exist, return 404 | File 03 §5: hidden at launch per PRD §11 |
| No chunked/resumable video upload | File 03 §5: client compresses first |
| No Arabic stemmer or synonym engine | File 03 §1 cut #8: normalizeArabic() + trigram sufficient |
| Perceptual hash uses sha256 of processed image (exact match only) — **planned Slice 2** | File 03 §1 cut #9: catches reposts; dHash deferred |
| Video poster uploaded by client (`posterMediaId`) instead of server ffmpeg extraction | File 03 §1 cut #10 |
| Offset cursor instead of keyset pagination | File 03 §1 cut #7: simpler SQL; frontend sees opaque `nextCursor` |
| Idempotency only for chat messages (DB unique) and payments (reference unique) | File 03 §1 cut #5 |
| `promoteToIndex` flag kept but no dynamic `CREATE INDEX` | File 03 §1 cut #6: one GIN index on `dynamicAttributes` |
| Frontend audit pending | Frontend repo not available; route shapes follow arch §10 catalogue |

## Security / Auth

| Deviation | Reason |
|---|---|
| MFA token single-use enforced via in-memory Map (single-instance only) | B07 requirement; multi-instance would need Redis; noted here |
| Admin sessions are stateless JWT (tokenVersion revocation) | File 03 §2: no AdminSession table |

## Testing

| Deviation | Reason |
|---|---|
| Vitest only for core rules (B-items) + B09-B11 additions | File 03 §6: Postman/Newman is the acceptance suite |
| No 70% coverage gate | File 03 §6: revisit after launch |
| Newman run requires manual execution | Newman not installed in CI environment; collection generated at `postman/` |
