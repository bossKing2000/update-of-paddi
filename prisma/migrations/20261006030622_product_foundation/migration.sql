-- Phase 2B.1 product foundation: OptionGroup/OptionGroupItem,
-- ProductDailyCounter, Product.categoryId (+backfill), scheduling and
-- capacity columns. ProductOption and its cart/order FKs are untouched;
-- no option data is migrated here (Phase 2B.2).

-- CreateTable
CREATE TABLE "OptionGroup" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "minSelections" INTEGER NOT NULL DEFAULT 0,
    "maxSelections" INTEGER NOT NULL DEFAULT 1,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OptionGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OptionGroupItem" (
    "id" TEXT NOT NULL,
    "optionGroupId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "priceAdd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OptionGroupItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductDailyCounter" (
    "productId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ProductDailyCounter_pkey" PRIMARY KEY ("productId", "date")
);

-- AlterTable: new columns first (categoryId nullable for the backfill).
ALTER TABLE "Product" ADD COLUMN "categoryId" TEXT,
ADD COLUMN "isScheduled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "orderCutoffTime" TEXT,
ADD COLUMN "dailyCap" INTEGER;

-- Backfill the denormalized shortcut from the authoritative chain
-- Product.dishTypeId -> DishType.categoryId (no hardcoded assignments).
UPDATE "Product" p
SET "categoryId" = d."categoryId"
FROM "DishType" d
WHERE p."dishTypeId" = d."id"
AND p."categoryId" IS NULL;

-- AlterTable: enforce NOT NULL only after the backfill.
ALTER TABLE "Product" ALTER COLUMN "categoryId" SET NOT NULL;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OptionGroup" ADD CONSTRAINT "OptionGroup_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OptionGroupItem" ADD CONSTRAINT "OptionGroupItem_optionGroupId_fkey" FOREIGN KEY ("optionGroupId") REFERENCES "OptionGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductDailyCounter" ADD CONSTRAINT "ProductDailyCounter_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "OptionGroup_productId_sortOrder_idx" ON "OptionGroup"("productId", "sortOrder");

-- CreateIndex
CREATE INDEX "OptionGroupItem_optionGroupId_isActive_sortOrder_idx" ON "OptionGroupItem"("optionGroupId", "isActive", "sortOrder");

-- CreateIndex
CREATE INDEX "ProductDailyCounter_date_idx" ON "ProductDailyCounter"("date");

-- CreateIndex
CREATE INDEX "Product_categoryId_idx" ON "Product"("categoryId");

-- CreateIndex
CREATE INDEX "Product_categoryId_archived_idx" ON "Product"("categoryId", "archived");
