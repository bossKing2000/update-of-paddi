-- =============================================================================
-- Foodi Paddi — Stage 5 Batch 1: Create VendorPayoutOrder table (Step 2)
-- =============================================================================
-- Creates the VendorPayoutOrder association table that independently records
-- every order-payout relationship, preserving historical associations that
-- Order.payoutId alone would lose when cleared.
--
-- Depends on: VendorPayoutOrderStatus enum (Step 1a), VendorPayout table,
-- Order table (both already exist).

CREATE TABLE "VendorPayoutOrder" (
    "id" TEXT NOT NULL,
    "vendorPayoutId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "associationStatus" "VendorPayoutOrderStatus" NOT NULL DEFAULT 'CLAIMED',
    "basePriceKobo" INTEGER NOT NULL,
    "commissionKobo" BIGINT,
    "vendorPayoutKobo" BIGINT,
    "discountKobo" BIGINT,
    "deliveryFeeKobo" INTEGER NOT NULL,
    "claimedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settledAt" TIMESTAMP(3),
    "releasedAt" TIMESTAMP(3),
    "reversesId" TEXT UNIQUE,
    "legacySnapshotVerified" BOOLEAN NOT NULL DEFAULT false,
    "legacySnapshotVerifiedBy" TEXT,
    "legacySnapshotVerifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VendorPayoutOrder_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "VendorPayoutOrder_vendorPayoutId_fkey" FOREIGN KEY ("vendorPayoutId") REFERENCES "VendorPayout"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "VendorPayoutOrder_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "VendorPayoutOrder_reversesId_fkey" FOREIGN KEY ("reversesId") REFERENCES "VendorPayoutOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "VendorPayoutOrder_vendorPayoutId_idx" ON "VendorPayoutOrder"("vendorPayoutId");

-- CreateIndex
CREATE INDEX "VendorPayoutOrder_orderId_idx" ON "VendorPayoutOrder"("orderId");

-- CreateIndex
CREATE INDEX "VendorPayoutOrder_associationStatus_idx" ON "VendorPayoutOrder"("associationStatus");

-- CreateIndex
CREATE UNIQUE INDEX "VendorPayoutOrder_vendorPayoutId_orderId_key" ON "VendorPayoutOrder"("vendorPayoutId", "orderId");

-- Note: @@index([reversesId]) — covered by @unique, no redundant index
