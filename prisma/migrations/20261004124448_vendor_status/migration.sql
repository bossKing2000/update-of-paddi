-- CreateEnum
CREATE TYPE "VendorStatus" AS ENUM ('NEW', 'PENDING_REVIEW', 'ACTIVE', 'SUSPENDED');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "vendorStatus" "VendorStatus",
ADD COLUMN     "vendorStatusChangedAt" TIMESTAMP(3),
ADD COLUMN     "vendorStatusReason" TEXT;

-- Backfill (safety net — databases were reset, so this normally matches zero
-- rows). Vendors meeting the ACTIVE requirements become ACTIVE, the rest NEW.
-- Idempotent: only touches rows whose vendorStatus is still NULL.
UPDATE "User" SET
  "vendorStatus" = CASE
    WHEN "kycStatus" = 'VERIFIED' AND "brandName" IS NOT NULL AND "phoneNumber" IS NOT NULL THEN 'ACTIVE'::"VendorStatus"
    ELSE 'NEW'::"VendorStatus"
  END,
  "vendorStatusChangedAt" = NOW()
WHERE "roles" @> ARRAY['VENDOR'::"Role"] AND "vendorStatus" IS NULL;
