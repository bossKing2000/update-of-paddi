-- =============================================================================
-- Foodi Paddi — Phase 3D: scheduled / preorder orders
-- =============================================================================
--
-- Adds an optional `scheduledAt` timestamp to Order so a customer can request
-- a future fulfillment time distinct from order-creation (createdAt) and
-- payment (paidAt / completedAt) times. Null = immediate order (existing
-- behaviour unchanged).
--
-- This is an additive, backward-compatible change:
--   * Existing immediate orders keep scheduledAt = NULL.
--   * The column is nullable with no default, so no historical row is touched.
--   * No NOT NULL constraint, no backfill, no data loss on rollback.
--
-- ROLLBACK: dropping the column restores the pre-3D schema exactly; no data
-- migration is needed because scheduledAt is additive only.
-- =============================================================================

ALTER TABLE "Order" ADD COLUMN "scheduledAt" TIMESTAMP(3);

CREATE INDEX "Order_scheduledAt_idx" ON "Order"("scheduledAt");
