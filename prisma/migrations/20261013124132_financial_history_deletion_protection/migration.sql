-- Phase 3.1.1 financial-history deletion protection: replace six
-- destructive or silently-unlinking referential actions with RESTRICT so
-- a hard delete can never erase historical orders or financial records.
-- No columns, rows, or indexes are modified — only foreign-key actions.
-- Existing rows satisfy every new constraint as-is (RESTRICT only blocks
-- future deletes of still-referenced parents).

-- Order.customerId -> User: Cascade -> Restrict. Deleting a customer
-- must never erase their orders (and the payments, refunds, payouts, and
-- earnings attached to them). Close/suspend via isBlocked instead.
ALTER TABLE "Order" DROP CONSTRAINT "Order_customerId_fkey";
ALTER TABLE "Order" ADD CONSTRAINT "Order_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Order.vendorId -> User: Cascade -> Restrict. Deleting a vendor must
-- never erase the orders they sold (shared customer history and the
-- vendor-payout basis). Suspend via vendorStatus/isLive instead.
ALTER TABLE "Order" DROP CONSTRAINT "Order_vendorId_fkey";
ALTER TABLE "Order" ADD CONSTRAINT "Order_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- OrderItem.productId -> Product: Cascade -> Restrict. Deleting a product
-- must never silently delete line items from completed past orders.
-- Removal from sale is via archived=true; both delete paths already
-- refuse products with order history (409) before this constraint.
ALTER TABLE "OrderItem" DROP CONSTRAINT "OrderItem_productId_fkey";
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- OrderItemOption.optionId -> ProductOption (legacy, frozen): Cascade ->
-- Restrict. Matches the new optionGroupItem convention: deleting catalog
-- must never delete historical order records carrying their snapshots.
ALTER TABLE "OrderItemOption" DROP CONSTRAINT "OrderItemOption_optionId_fkey";
ALTER TABLE "OrderItemOption" ADD CONSTRAINT "OrderItemOption_optionId_fkey" FOREIGN KEY ("optionId") REFERENCES "ProductOption"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- RiderWithdrawal.deliveryPersonId -> DeliveryPerson: Cascade -> Restrict.
-- Deleting a rider must never erase the withdrawal ledger. Riders are
-- deactivated via DeliveryPerson.status; withdrawals are terminal records.
ALTER TABLE "RiderWithdrawal" DROP CONSTRAINT "RiderWithdrawal_deliveryPersonId_fkey";
ALTER TABLE "RiderWithdrawal" ADD CONSTRAINT "RiderWithdrawal_deliveryPersonId_fkey" FOREIGN KEY ("deliveryPersonId") REFERENCES "DeliveryPerson"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Order.payoutId -> VendorPayout: SetNull -> Restrict. Deleting a payout
-- must never silently unlink its orders (which would reopen them for a
-- second payout and defeat the double-pay guard). Payouts are never
-- deleted via the API; this guards out-of-band deletes.
ALTER TABLE "Order" DROP CONSTRAINT "Order_payoutId_fkey";
ALTER TABLE "Order" ADD CONSTRAINT "Order_payoutId_fkey" FOREIGN KEY ("payoutId") REFERENCES "VendorPayout"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
