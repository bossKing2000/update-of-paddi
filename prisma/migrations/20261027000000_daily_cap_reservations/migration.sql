-- =============================================================================
-- Foodi Paddi — Phase 3D: daily-cap reservation records
-- =============================================================================
--
-- Durable record of one order's reserved daily-cap unit for one product on
-- one Africa/Lagos business day. Makes daily-cap release idempotent per
-- reservation: a cancelled or expired order releases exactly the capacity it
-- reserved, and a repeated or concurrent release cannot decrement capacity
-- belonging to another order.
--
-- Created together with the ProductDailyCounter increment inside the checkout
-- transaction; released (released = true) together with the counter decrement
-- inside the cancellation/expiry transaction.
--
-- This is an additive change: no existing column or row is modified.
-- =============================================================================

CREATE TABLE "DailyCapReservation" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "day" TIMESTAMP(3) NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "released" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DailyCapReservation_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "DailyCapReservation" ADD CONSTRAINT "DailyCapReservation_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DailyCapReservation" ADD CONSTRAINT "DailyCapReservation_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateIndex
CREATE UNIQUE INDEX "DailyCapReservation_orderId_productId_day_key" ON "DailyCapReservation"("orderId", "productId", "day");

-- CreateIndex
CREATE INDEX "DailyCapReservation_productId_day_idx" ON "DailyCapReservation"("productId", "day");

-- CreateIndex
CREATE INDEX "DailyCapReservation_orderId_idx" ON "DailyCapReservation"("orderId");
