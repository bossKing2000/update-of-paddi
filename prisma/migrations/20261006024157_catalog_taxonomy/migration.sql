-- Phase 2A.1 catalog taxonomy: Category, Tag/TagType, ProductTag,
-- CategorySuggestion/SuggestionStatus, DishType.categoryId (backfilled).
-- Safe on databases with existing DishType/Product rows: new tables start
-- empty, the categoryId backfill covers every existing DishType, and the
-- NOT NULL + FK apply only after the guard-checked backfill.

-- CreateEnum
CREATE TYPE "TagType" AS ENUM ('CUISINE', 'DIET', 'OCCASION');

-- CreateEnum
CREATE TYPE "SuggestionStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateTable: 12 canonical categories are inserted below (stable ids).
CREATE TABLE "Category" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "icon" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 100,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Category_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Tag" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "TagType" NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Tag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductTag" (
    "productId" TEXT NOT NULL,
    "tagId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductTag_pkey" PRIMARY KEY ("productId", "tagId")
);

-- CreateTable
CREATE TABLE "CategorySuggestion" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "suggestedName" TEXT NOT NULL,
    "suggestedCategoryId" TEXT NOT NULL,
    "status" "SuggestionStatus" NOT NULL DEFAULT 'PENDING',
    "adminNote" TEXT,
    "reviewedByAdminId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "approvedDishTypeId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CategorySuggestion_pkey" PRIMARY KEY ("id")
);

-- Seed the 12 canonical categories (required before the DishType backfill).
INSERT INTO "Category" ("id", "name", "slug", "sortOrder", "isActive", "createdAt", "updatedAt") VALUES
    ('RICE_DISHES', 'Rice Dishes', 'rice-dishes', 10, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('SOUPS_AND_SWALLOW', 'Soups and Swallow', 'soups-and-swallow', 20, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('GRILLS_AND_PROTEINS', 'Grills and Proteins', 'grills-and-proteins', 30, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('SNACKS_AND_SMALL_CHOPS', 'Snacks and Small Chops', 'snacks-and-small-chops', 40, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('BREAKFAST', 'Breakfast', 'breakfast', 50, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('DRINKS', 'Drinks', 'drinks', 60, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('PASTRIES_AND_BAKERY', 'Pastries and Bakery', 'pastries-and-bakery', 70, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('LOCAL_SPECIALS', 'Local Specials', 'local-specials', 80, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('NOODLES_AND_PASTA', 'Noodles and Pasta', 'noodles-and-pasta', 90, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('SALADS_AND_HEALTHY', 'Salads and Healthy', 'salads-and-healthy', 100, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('COMBOS_AND_PACKS', 'Combos and Packs', 'combos-and-packs', 110, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('DESSERTS_AND_SMOOTHIES', 'Desserts and Smoothies', 'desserts-and-smoothies', 120, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;

-- AlterTable: add categoryId nullable first so existing rows survive.
ALTER TABLE "DishType" ADD COLUMN "categoryId" TEXT;

-- Backfill every existing DishType (covers all 50 canonical rows; any
-- unexpected id falls back to LOCAL_SPECIALS rather than failing).
UPDATE "DishType" SET "categoryId" = CASE "id"
    WHEN 'JOLLOF' THEN 'RICE_DISHES'
    WHEN 'FRIED_RICE' THEN 'RICE_DISHES'
    WHEN 'OFADA' THEN 'RICE_DISHES'
    WHEN 'WHITE_RICE' THEN 'RICE_DISHES'
    WHEN 'COCONUT_RICE' THEN 'RICE_DISHES'
    WHEN 'AMALA' THEN 'SOUPS_AND_SWALLOW'
    WHEN 'EBA' THEN 'SOUPS_AND_SWALLOW'
    WHEN 'POUNDED_YAM' THEN 'SOUPS_AND_SWALLOW'
    WHEN 'FUFU' THEN 'SOUPS_AND_SWALLOW'
    WHEN 'SEMOVITA' THEN 'SOUPS_AND_SWALLOW'
    WHEN 'TUWO' THEN 'SOUPS_AND_SWALLOW'
    WHEN 'EGUSI' THEN 'SOUPS_AND_SWALLOW'
    WHEN 'OGBONO' THEN 'SOUPS_AND_SWALLOW'
    WHEN 'OKRA' THEN 'SOUPS_AND_SWALLOW'
    WHEN 'EFO_RIRO' THEN 'SOUPS_AND_SWALLOW'
    WHEN 'AFANG' THEN 'SOUPS_AND_SWALLOW'
    WHEN 'EDIKANG' THEN 'SOUPS_AND_SWALLOW'
    WHEN 'BANGA' THEN 'SOUPS_AND_SWALLOW'
    WHEN 'OHA' THEN 'SOUPS_AND_SWALLOW'
    WHEN 'BITTERLEAF' THEN 'SOUPS_AND_SWALLOW'
    WHEN 'NSALA' THEN 'SOUPS_AND_SWALLOW'
    WHEN 'FISHERMAN' THEN 'SOUPS_AND_SWALLOW'
    WHEN 'PEPPER_SOUP' THEN 'SOUPS_AND_SWALLOW'
    WHEN 'ASUN' THEN 'GRILLS_AND_PROTEINS'
    WHEN 'SUYA' THEN 'GRILLS_AND_PROTEINS'
    WHEN 'CHICKEN' THEN 'GRILLS_AND_PROTEINS'
    WHEN 'GOAT_MEAT' THEN 'GRILLS_AND_PROTEINS'
    WHEN 'FISH' THEN 'GRILLS_AND_PROTEINS'
    WHEN 'KILISHI' THEN 'GRILLS_AND_PROTEINS'
    WHEN 'PONMO' THEN 'GRILLS_AND_PROTEINS'
    WHEN 'PUFF_PUFF' THEN 'SNACKS_AND_SMALL_CHOPS'
    WHEN 'AKARA' THEN 'SNACKS_AND_SMALL_CHOPS'
    WHEN 'SMALL_CHOPS' THEN 'SNACKS_AND_SMALL_CHOPS'
    WHEN 'SNACKS' THEN 'SNACKS_AND_SMALL_CHOPS'
    WHEN 'BOLI' THEN 'SNACKS_AND_SMALL_CHOPS'
    WHEN 'FRIED_YAM' THEN 'SNACKS_AND_SMALL_CHOPS'
    WHEN 'PLANTAIN' THEN 'SNACKS_AND_SMALL_CHOPS'
    WHEN 'SHAWARMA' THEN 'SNACKS_AND_SMALL_CHOPS'
    WHEN 'EWA_AGOYIN' THEN 'BREAKFAST'
    WHEN 'AGIDI_PAP' THEN 'BREAKFAST'
    WHEN 'BEANS' THEN 'BREAKFAST'
    WHEN 'MOI_MOI' THEN 'BREAKFAST'
    WHEN 'YAM_PORRIDGE' THEN 'BREAKFAST'
    WHEN 'ABACHA' THEN 'LOCAL_SPECIALS'
    WHEN 'NKWOBI' THEN 'LOCAL_SPECIALS'
    WHEN 'ISIEWU' THEN 'LOCAL_SPECIALS'
    WHEN 'OKPA' THEN 'LOCAL_SPECIALS'
    WHEN 'NOODLES' THEN 'NOODLES_AND_PASTA'
    WHEN 'DRINKS' THEN 'DRINKS'
    ELSE 'LOCAL_SPECIALS'
END
WHERE "categoryId" IS NULL;

-- AlterTable: enforce NOT NULL only after the backfill.
ALTER TABLE "DishType" ALTER COLUMN "categoryId" SET NOT NULL;

-- AddForeignKey
ALTER TABLE "DishType" ADD CONSTRAINT "DishType_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductTag" ADD CONSTRAINT "ProductTag_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductTag" ADD CONSTRAINT "ProductTag_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "Tag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CategorySuggestion" ADD CONSTRAINT "CategorySuggestion_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CategorySuggestion" ADD CONSTRAINT "CategorySuggestion_suggestedCategoryId_fkey" FOREIGN KEY ("suggestedCategoryId") REFERENCES "Category"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CategorySuggestion" ADD CONSTRAINT "CategorySuggestion_reviewedByAdminId_fkey" FOREIGN KEY ("reviewedByAdminId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CategorySuggestion" ADD CONSTRAINT "CategorySuggestion_approvedDishTypeId_fkey" FOREIGN KEY ("approvedDishTypeId") REFERENCES "DishType"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateIndex
CREATE UNIQUE INDEX "Category_name_key" ON "Category"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Category_slug_key" ON "Category"("slug");

-- CreateIndex
CREATE INDEX "Category_isActive_sortOrder_idx" ON "Category"("isActive", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "Tag_name_key" ON "Tag"("name");

-- CreateIndex
CREATE INDEX "Tag_type_isActive_idx" ON "Tag"("type", "isActive");

-- CreateIndex
CREATE INDEX "ProductTag_tagId_productId_idx" ON "ProductTag"("tagId", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "CategorySuggestion_approvedDishTypeId_key" ON "CategorySuggestion"("approvedDishTypeId");

-- CreateIndex
CREATE INDEX "CategorySuggestion_status_createdAt_idx" ON "CategorySuggestion"("status", "createdAt");

-- CreateIndex
CREATE INDEX "CategorySuggestion_vendorId_status_idx" ON "CategorySuggestion"("vendorId", "status");

-- CreateIndex
CREATE INDEX "DishType_categoryId_idx" ON "DishType"("categoryId");

-- CreateIndex
CREATE INDEX "DishType_categoryId_isActive_sortOrder_idx" ON "DishType"("categoryId", "isActive", "sortOrder");
