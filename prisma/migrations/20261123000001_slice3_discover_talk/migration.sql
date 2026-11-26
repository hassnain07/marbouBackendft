-- Slice 3: Discover + Talk
-- Favorites, SavedSearch, SearchLog, ChatThread, ChatMessage, Offer, Notification
-- Plus: User.quickReplies column

-- ─── Enums ────────────────────────────────────────────────────────────────────

CREATE TYPE "SavedSearchFrequency" AS ENUM ('INSTANT', 'DAILY');
CREATE TYPE "ChatMessageType" AS ENUM ('TEXT', 'IMAGE', 'OFFER', 'SYSTEM');
CREATE TYPE "OfferStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED', 'COUNTERED');

-- ─── Favorite ─────────────────────────────────────────────────────────────────

CREATE TABLE "Favorite" (
  "userId"       TEXT        NOT NULL,
  "listingId"    TEXT        NOT NULL,
  "priceAtSave"  DECIMAL(18,2),
  "createdAt"    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY ("userId", "listingId")
);

CREATE INDEX "Favorite_userId_idx" ON "Favorite"("userId");
CREATE INDEX "Favorite_listingId_idx" ON "Favorite"("listingId");

-- ─── SavedSearch ──────────────────────────────────────────────────────────────

CREATE TABLE "SavedSearch" (
  "id"             TEXT        NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  "userId"         TEXT        NOT NULL,
  "name"           TEXT        NOT NULL,
  "query"          JSONB       NOT NULL DEFAULT '{}',
  "frequency"      "SavedSearchFrequency" NOT NULL DEFAULT 'INSTANT',
  "lastNotifiedAt" TIMESTAMPTZ,
  "createdAt"      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX "SavedSearch_userId_idx" ON "SavedSearch"("userId");

-- ─── SearchLog ────────────────────────────────────────────────────────────────

CREATE TABLE "SearchLog" (
  "id"          TEXT        NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  "userId"      TEXT,
  "deviceHash"  TEXT        NOT NULL,
  "q"           TEXT        NOT NULL DEFAULT '',
  "filters"     JSONB       NOT NULL DEFAULT '{}',
  "resultCount" INT         NOT NULL DEFAULT 0,
  "createdAt"   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX "SearchLog_createdAt_idx" ON "SearchLog"("createdAt" DESC);
CREATE INDEX "SearchLog_userId_idx"    ON "SearchLog"("userId");

-- ─── ChatThread ───────────────────────────────────────────────────────────────

CREATE TABLE "ChatThread" (
  "id"              TEXT        NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  "listingId"       TEXT,
  "buyerId"         TEXT        NOT NULL,
  "sellerId"        TEXT        NOT NULL,
  "businessId"      TEXT,
  "lastMessageAt"   TIMESTAMPTZ,
  "isMutedByBuyer"  BOOLEAN     NOT NULL DEFAULT false,
  "isMutedBySeller" BOOLEAN     NOT NULL DEFAULT false,
  "closedReason"    TEXT,
  "createdAt"       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX "ChatThread_listingId_buyerId_sellerId_key"
  ON "ChatThread"("listingId", "buyerId", "sellerId")
  WHERE "listingId" IS NOT NULL;

CREATE INDEX "ChatThread_buyerId_idx"  ON "ChatThread"("buyerId");
CREATE INDEX "ChatThread_sellerId_idx" ON "ChatThread"("sellerId");
CREATE INDEX "ChatThread_lastMessageAt_idx" ON "ChatThread"("lastMessageAt" DESC NULLS LAST);

-- ─── ChatMessage ──────────────────────────────────────────────────────────────

CREATE TABLE "ChatMessage" (
  "id"               TEXT             NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  "threadId"         TEXT             NOT NULL,
  "senderId"         TEXT             NOT NULL,
  "type"             "ChatMessageType" NOT NULL DEFAULT 'TEXT',
  "body"             TEXT,
  "attachmentUrl"    TEXT,
  "idempotencyKey"   TEXT             NOT NULL,
  "sentAt"           TIMESTAMPTZ      NOT NULL DEFAULT now(),
  "deliveredAt"      TIMESTAMPTZ,
  "readAt"           TIMESTAMPTZ,
  "handledByStaffId" TEXT,
  UNIQUE ("senderId", "idempotencyKey")
);

CREATE INDEX "ChatMessage_threadId_sentAt_idx" ON "ChatMessage"("threadId", "sentAt");

-- ─── Offer ────────────────────────────────────────────────────────────────────

CREATE TABLE "Offer" (
  "id"           TEXT         NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  "threadId"     TEXT         NOT NULL,
  "messageId"    TEXT         NOT NULL UNIQUE,
  "offeredById"  TEXT         NOT NULL,
  "amount"       DECIMAL(18,2) NOT NULL,
  "currency"     TEXT         NOT NULL DEFAULT 'SDG',
  "status"       "OfferStatus" NOT NULL DEFAULT 'PENDING',
  "counterOfId"  TEXT,
  "createdAt"    TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX "Offer_threadId_idx" ON "Offer"("threadId");

-- ─── Notification ─────────────────────────────────────────────────────────────

CREATE TABLE "Notification" (
  "id"         TEXT        NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  "userId"     TEXT        NOT NULL,
  "type"       TEXT        NOT NULL,
  "title"      JSONB       NOT NULL DEFAULT '{}',
  "body"       JSONB       NOT NULL DEFAULT '{}',
  "data"       JSONB       NOT NULL DEFAULT '{}',
  "dedupeKey"  TEXT,
  "readAt"     TIMESTAMPTZ,
  "createdAt"  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX "Notification_userId_dedupeKey_key"
  ON "Notification"("userId", "dedupeKey")
  WHERE "dedupeKey" IS NOT NULL;

CREATE INDEX "Notification_userId_createdAt_idx" ON "Notification"("userId", "createdAt" DESC);
CREATE INDEX "Notification_userId_unread_idx"     ON "Notification"("userId") WHERE "readAt" IS NULL;

-- ─── User.quickReplies column ─────────────────────────────────────────────────

ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "quickReplies" JSONB NOT NULL DEFAULT '[]';

-- ─── FK constraints ───────────────────────────────────────────────────────────

ALTER TABLE "Favorite"    ADD CONSTRAINT "Favorite_userId_fkey"    FOREIGN KEY ("userId")    REFERENCES "User"("id") ON DELETE CASCADE;
ALTER TABLE "Favorite"    ADD CONSTRAINT "Favorite_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "Listing"("id") ON DELETE CASCADE;

ALTER TABLE "SavedSearch" ADD CONSTRAINT "SavedSearch_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE;

ALTER TABLE "ChatThread"  ADD CONSTRAINT "ChatThread_buyerId_fkey"  FOREIGN KEY ("buyerId")  REFERENCES "User"("id");
ALTER TABLE "ChatThread"  ADD CONSTRAINT "ChatThread_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "User"("id");

ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "ChatThread"("id") ON DELETE CASCADE;
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "User"("id");

ALTER TABLE "Offer" ADD CONSTRAINT "Offer_threadId_fkey"  FOREIGN KEY ("threadId")  REFERENCES "ChatThread"("id") ON DELETE CASCADE;
ALTER TABLE "Offer" ADD CONSTRAINT "Offer_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "ChatMessage"("id");

ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE;
