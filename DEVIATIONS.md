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

## Data Model

| Deviation | Reason |
|---|---|
| ~38 tables instead of 75+ | File 03 §2 merge rules applied |
| No `Country` table — `User.countryCode String @default("SD")` | Simplified; country list is static for Sudan launch |
| `AdminUser.tokenVersion Int` instead of `AdminSession` table | File 03 §2: stateless admin token revocation |
| `User` has merged columns: `capabilities[]`, `badges[]`, `notifPrefs Json`, `deviceTokens Json`, `employerProfile Json?`, `serviceProfile Json?` | File 03 §2 merge rules |
| `Booking` table merges RentalRequest + ServiceAppointment + AccommodationInquiry | File 03 §2 |
| `Place` table merges State + City + Neighborhood | File 03 §2 |
| `ContentBlock` merges Banner + HelpArticle + StaticPage | File 03 §2 |
| `ChatMessage.meta Json` replaces `Offer` table | File 03 §2 |
| `ModerationAction` has appeal columns instead of separate `Appeal` table | File 03 §2 |
| `Payment.invoiceNo` instead of separate `Invoice` table | File 03 §2 |
| `Listing.scan Json` instead of `ScanResult` table | File 03 §2 |
| `DataExport`, `ListingMetricDaily`, `OtherEntry`, `JobRun`, `EmailOutbox`, `IdempotencyKey` tables deferred | File 03 §2: computed on demand or logged |

## API / Features

| Deviation | Reason |
|---|---|
| Dormant engines (M18) not built — flags exist, return 404 | File 03 §5: hidden at launch per PRD §11 |
| No chunked/resumable video upload | File 03 §5: client compresses first |
| No Arabic stemmer or synonym engine | File 03 §1 cut #8: normalizeArabic() + trigram sufficient |
| Perceptual hash uses sha256 of processed image (exact match only) | File 03 §1 cut #9: catches reposts; dHash deferred |
| Video poster uploaded by client (`posterMediaId`) instead of server ffmpeg extraction | File 03 §1 cut #10 |
| Offset cursor instead of keyset pagination | File 03 §1 cut #7: simpler SQL; frontend sees opaque `nextCursor` |
| Idempotency only for chat messages (DB unique) and payments (reference unique) | File 03 §1 cut #5 |
| `promoteToIndex` flag kept but no dynamic `CREATE INDEX` | File 03 §1 cut #6: one GIN index on `dynamicAttributes` |
| Frontend audit pending | Frontend repo not available; route shapes follow arch §10 catalogue |

## Security / Auth

| Deviation | Reason |
|---|---|
| mfaToken single-use enforced via in-memory Set (single-instance only) | B07 requirement; multi-instance would need Redis; noted in code |
| Admin sessions are stateless JWT (tokenVersion revocation) | File 03 §2: no AdminSession table |

## Testing

| Deviation | Reason |
|---|---|
| Vitest only for 8 core rules + B09-B11 additions | File 03 §6: Postman/Newman is the acceptance suite |
| No 70% coverage gate | File 03 §6: revisit after launch |
| Newman run not executed automatically | Newman not installed in this environment; collection generated at `postman/` |
