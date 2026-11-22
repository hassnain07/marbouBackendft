-- CreateEnum
CREATE TYPE "ListingType" AS ENUM ('SALE', 'RENT', 'WANTED', 'SERVICE', 'JOB');

-- CreateEnum
CREATE TYPE "ListingStatus" AS ENUM ('DRAFT', 'PENDING_REVIEW', 'ACTIVE', 'HIDDEN', 'AUTO_HIDDEN', 'SUSPENDED', 'SOLD', 'EXPIRED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "AttributeType" AS ENUM ('TEXT', 'NUMBER', 'BOOLEAN', 'SINGLE_SELECT', 'MULTI_SELECT', 'DATE', 'RANGE', 'FILE_URL');

-- CreateEnum
CREATE TYPE "PlaceLevel" AS ENUM ('STATE', 'CITY', 'NEIGHBORHOOD');

-- AlterTable
ALTER TABLE "AnalyticsEvent" ADD COLUMN     "actorKey" TEXT;

-- AlterTable
ALTER TABLE "MediaAsset" ADD COLUMN     "sha256" TEXT;

-- CreateTable
CREATE TABLE "Place" (
    "id" TEXT NOT NULL,
    "level" "PlaceLevel" NOT NULL,
    "parentId" TEXT,
    "countryCode" TEXT NOT NULL DEFAULT 'SD',
    "nameAr" TEXT NOT NULL,
    "nameEn" TEXT NOT NULL,
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sort" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Place_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Category" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "parentId" TEXT,
    "nameAr" TEXT NOT NULL,
    "nameEn" TEXT NOT NULL,
    "descriptionAr" TEXT,
    "descriptionEn" TEXT,
    "iconUrl" TEXT,
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    "postingRestricted" BOOLEAN NOT NULL DEFAULT false,
    "postingMessage" TEXT,
    "expiryDays" INTEGER,
    "supportsCompare" BOOLEAN NOT NULL DEFAULT false,
    "isVideoAllowed" BOOLEAN NOT NULL DEFAULT true,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isArchived" BOOLEAN NOT NULL DEFAULT false,
    "sort" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Category_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CategoryAttribute" (
    "id" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "attributeKey" TEXT NOT NULL,
    "labelAr" TEXT NOT NULL,
    "labelEn" TEXT NOT NULL,
    "type" "AttributeType" NOT NULL,
    "isRequired" BOOLEAN NOT NULL DEFAULT false,
    "isPrivate" BOOLEAN NOT NULL DEFAULT false,
    "isFilterable" BOOLEAN NOT NULL DEFAULT false,
    "promoteToIndex" BOOLEAN NOT NULL DEFAULT false,
    "showInCompare" BOOLEAN NOT NULL DEFAULT false,
    "optionsList" JSONB,
    "validationRules" JSONB,
    "dependsOn" TEXT,
    "sort" INTEGER NOT NULL DEFAULT 0,
    "isArchived" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CategoryAttribute_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Listing" (
    "id" TEXT NOT NULL,
    "publicSeq" SERIAL NOT NULL,
    "ownerId" TEXT NOT NULL,
    "businessId" TEXT,
    "countryCode" TEXT NOT NULL DEFAULT 'SD',
    "cityId" TEXT,
    "neighborhoodId" TEXT,
    "categoryId" TEXT NOT NULL,
    "listingType" "ListingType" NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "searchText" TEXT NOT NULL DEFAULT '',
    "price" DECIMAL(18,2),
    "budgetMin" DECIMAL(18,2),
    "budgetMax" DECIMAL(18,2),
    "currency" TEXT NOT NULL DEFAULT 'SDG',
    "isNegotiable" BOOLEAN NOT NULL DEFAULT false,
    "condition" TEXT,
    "status" "ListingStatus" NOT NULL DEFAULT 'DRAFT',
    "statusReason" TEXT,
    "isCustomOther" BOOLEAN NOT NULL DEFAULT false,
    "customOtherText" TEXT,
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,
    "pubLat" DOUBLE PRECISION,
    "pubLng" DOUBLE PRECISION,
    "locationName" TEXT,
    "isApproxLocation" BOOLEAN NOT NULL DEFAULT false,
    "approxRadiusM" INTEGER,
    "contactOptions" JSONB NOT NULL DEFAULT '{"call":true,"whatsapp":true,"chat":true}',
    "dynamicAttributes" JSONB NOT NULL DEFAULT '{}',
    "qualityScore" INTEGER NOT NULL DEFAULT 0,
    "riskScore" INTEGER NOT NULL DEFAULT 0,
    "scan" JSONB,
    "viewCount" INTEGER NOT NULL DEFAULT 0,
    "favoriteCount" INTEGER NOT NULL DEFAULT 0,
    "leadCount" INTEGER NOT NULL DEFAULT 0,
    "videoMediaId" TEXT,
    "videoUrl" TEXT,
    "videoPosterUrl" TEXT,
    "vehicleVin" TEXT,
    "ownershipDocKey" TEXT,
    "reminded7" BOOLEAN NOT NULL DEFAULT false,
    "reminded1" BOOLEAN NOT NULL DEFAULT false,
    "publishedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "soldAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Listing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ListingMedia" (
    "id" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "mediaId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "thumbUrl" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,
    "isCover" BOOLEAN NOT NULL DEFAULT false,
    "hash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ListingMedia_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ListingView" (
    "id" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "viewerKey" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ListingView_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Place_level_countryCode_idx" ON "Place"("level", "countryCode");

-- CreateIndex
CREATE INDEX "Place_parentId_idx" ON "Place"("parentId");

-- CreateIndex
CREATE UNIQUE INDEX "Category_slug_key" ON "Category"("slug");

-- CreateIndex
CREATE INDEX "Category_parentId_idx" ON "Category"("parentId");

-- CreateIndex
CREATE INDEX "Category_isActive_isArchived_idx" ON "Category"("isActive", "isArchived");

-- CreateIndex
CREATE INDEX "CategoryAttribute_categoryId_idx" ON "CategoryAttribute"("categoryId");

-- CreateIndex
CREATE UNIQUE INDEX "CategoryAttribute_categoryId_attributeKey_key" ON "CategoryAttribute"("categoryId", "attributeKey");

-- CreateIndex
CREATE UNIQUE INDEX "Listing_publicSeq_key" ON "Listing"("publicSeq");

-- CreateIndex
CREATE INDEX "Listing_categoryId_status_publishedAt_idx" ON "Listing"("categoryId", "status", "publishedAt" DESC);

-- CreateIndex
CREATE INDEX "Listing_ownerId_status_idx" ON "Listing"("ownerId", "status");

-- CreateIndex
CREATE INDEX "Listing_cityId_status_idx" ON "Listing"("cityId", "status");

-- CreateIndex
CREATE INDEX "Listing_pubLat_pubLng_idx" ON "Listing"("pubLat", "pubLng");

-- CreateIndex
CREATE INDEX "ListingMedia_listingId_idx" ON "ListingMedia"("listingId");

-- CreateIndex
CREATE INDEX "ListingMedia_mediaId_idx" ON "ListingMedia"("mediaId");

-- CreateIndex
CREATE INDEX "ListingView_listingId_idx" ON "ListingView"("listingId");

-- CreateIndex
CREATE UNIQUE INDEX "ListingView_listingId_viewerKey_day_key" ON "ListingView"("listingId", "viewerKey", "day");

-- CreateIndex
CREATE INDEX "MediaAsset_sha256_idx" ON "MediaAsset"("sha256");

-- AddForeignKey
ALTER TABLE "Place" ADD CONSTRAINT "Place_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Place"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Category" ADD CONSTRAINT "Category_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Category"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CategoryAttribute" ADD CONSTRAINT "CategoryAttribute_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Listing" ADD CONSTRAINT "Listing_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Listing" ADD CONSTRAINT "Listing_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ListingMedia" ADD CONSTRAINT "ListingMedia_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "Listing"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ListingMedia" ADD CONSTRAINT "ListingMedia_mediaId_fkey" FOREIGN KEY ("mediaId") REFERENCES "MediaAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ListingView" ADD CONSTRAINT "ListingView_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "Listing"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Raw extras: GIN indexes and partial index
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX "Listing_dynamicAttributes_gin_idx"
  ON "Listing" USING GIN ("dynamicAttributes" jsonb_path_ops);

CREATE INDEX "Listing_searchText_trgm_idx"
  ON "Listing" USING GIN ("searchText" gin_trgm_ops);

CREATE INDEX "Listing_active_partial_idx"
  ON "Listing" ("categoryId", "publishedAt" DESC)
  WHERE status = 'ACTIVE' AND "deletedAt" IS NULL;
