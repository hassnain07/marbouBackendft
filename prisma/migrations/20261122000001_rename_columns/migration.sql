-- Rename CategoryAttribute.type → dataType (avoids reserved-word confusion)
ALTER TABLE "CategoryAttribute" RENAME COLUMN "type" TO "dataType";

-- Rename Category.sort → displayOrder (matches test contract)
ALTER TABLE "Category" RENAME COLUMN "sort" TO "displayOrder";

-- Rename Place.sort → displayOrder for consistency
ALTER TABLE "Place" RENAME COLUMN "sort" TO "displayOrder";

-- Rename ListingMedia sort-related: none needed

-- Rename CategoryAttribute.sort → displayOrder
ALTER TABLE "CategoryAttribute" RENAME COLUMN "sort" TO "displayOrder";
