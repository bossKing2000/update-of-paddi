-- Phase 2B.4a cart option-source compatibility: CartItemOption can
-- reference EITHER a legacy ProductOption OR a new OptionGroupItem.
-- No existing rows are modified (zero-row backfill); existing rows carry
-- productOptionId and satisfy the new CHECK constraint as-is.

-- AlterTable: legacy FK becomes nullable (existing rows keep their values).
ALTER TABLE "CartItemOption" ALTER COLUMN "productOptionId" DROP NOT NULL;

-- AlterTable: new nullable OptionGroupItem reference.
ALTER TABLE "CartItemOption" ADD COLUMN "optionGroupItemId" TEXT;

-- AddForeignKey (Cascade, matching the legacy productOptionId convention:
-- option rows live and die with their referenced definition row).
ALTER TABLE "CartItemOption" ADD CONSTRAINT "CartItemOption_optionGroupItemId_fkey" FOREIGN KEY ("optionGroupItemId") REFERENCES "OptionGroupItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "CartItemOption_optionGroupItemId_idx" ON "CartItemOption"("optionGroupItemId");

-- Exactly-one option source: one FK set, the other NULL. Added last so
-- existing rows (productOptionId set, optionGroupItemId NULL) satisfy it.
ALTER TABLE "CartItemOption" ADD CONSTRAINT "CartItemOption_option_source_check" CHECK (
  ("productOptionId" IS NOT NULL AND "optionGroupItemId" IS NULL)
  OR ("productOptionId" IS NULL AND "optionGroupItemId" IS NOT NULL)
);
