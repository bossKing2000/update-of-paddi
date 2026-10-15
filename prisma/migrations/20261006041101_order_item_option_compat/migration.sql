-- Phase 2B.5a order option-source compatibility: OrderItemOption can
-- reference EITHER a legacy ProductOption OR a new OptionGroupItem.
-- No existing rows are modified (zero-row backfill); existing rows carry
-- optionId and satisfy the new CHECK constraint as-is.

-- AlterTable: legacy FK becomes nullable (existing rows keep their values).
ALTER TABLE "OrderItemOption" ALTER COLUMN "optionId" DROP NOT NULL;

-- AlterTable: new nullable OptionGroupItem reference.
ALTER TABLE "OrderItemOption" ADD COLUMN "optionGroupItemId" TEXT;

-- AddForeignKey (RESTRICT, NOT Cascade): deleting a catalog item must
-- never silently delete historical order records. Deactivate via
-- isActive instead. Legacy ProductOption FK remains CASCADE (frozen).
ALTER TABLE "OrderItemOption" ADD CONSTRAINT "OrderItemOption_optionGroupItemId_fkey" FOREIGN KEY ("optionGroupItemId") REFERENCES "OptionGroupItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "OrderItemOption_optionGroupItemId_idx" ON "OrderItemOption"("optionGroupItemId");

-- Exactly-one option source: one FK set, the other NULL. Added last so
-- existing rows (optionId set, optionGroupItemId NULL) satisfy it.
ALTER TABLE "OrderItemOption" ADD CONSTRAINT "OrderItemOption_option_source_check" CHECK (
  ("optionId" IS NOT NULL AND "optionGroupItemId" IS NULL)
  OR ("optionId" IS NULL AND "optionGroupItemId" IS NOT NULL)
);
