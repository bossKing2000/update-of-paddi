-- Add PromotionScope enum
CREATE TYPE "PromotionScope" AS ENUM ('SINGLE_PRODUCT', 'SELECTED_PRODUCTS', 'VENDOR_WIDE');

-- Add scope column to Promotion
ALTER TABLE "Promotion" ADD COLUMN "scope" "PromotionScope" NOT NULL DEFAULT 'VENDOR_WIDE';

-- Create PromotionProducts relation table
CREATE TABLE "PromotionProducts" (
    "promotionId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,

    CONSTRAINT "PromotionProducts_pkey" PRIMARY KEY ("promotionId", "productId")
);

-- Add foreign keys
ALTER TABLE "PromotionProducts" ADD CONSTRAINT "PromotionProducts_promotionId_fkey" FOREIGN KEY ("promotionId") REFERENCES "Promotion"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PromotionProducts" ADD CONSTRAINT "PromotionProducts_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Create indexes
CREATE INDEX "PromotionProducts_productId_idx" ON "PromotionProducts"("productId");