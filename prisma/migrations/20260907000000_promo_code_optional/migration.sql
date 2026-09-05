-- Make Promotion.code optional so ordinary vendor product discounts can be
-- automatic (no code entry required). Non-null code = code-gated campaign.
-- The existing @@unique([vendorId, code]) is preserved: PostgreSQL treats
-- NULLs as distinct, so any number of automatic (codeless) promotions may
-- coexist per vendor while coded promotions stay unique per vendor.
ALTER TABLE "Promotion" ALTER COLUMN "code" DROP NOT NULL;
