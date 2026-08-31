-- Refund correctness fixes:
--   1. Payment.refundedAmount — a running ledger (kobo) of how much of a
--      payment has been refunded, so concurrent partial refunds can be
--      checked against the true remaining balance inside a locked
--      transaction instead of racing on a stale read.
--   2. RefundRequest gets PROCESSING/FAILED statuses so a refund is only
--      marked COMPLETED once Paystack's refund.processed webhook confirms
--      it — the initial POST /refund response is only "pending"/"queued",
--      not confirmation that money moved.
--   3. RefundRequest.paystackRefundId / requestedAmountKobo let the
--      webhook match an async refund event back to the right request.

ALTER TABLE "Payment" ADD COLUMN "refundedAmount" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "RefundRequest" ADD COLUMN "paystackRefundId" TEXT;
ALTER TABLE "RefundRequest" ADD COLUMN "requestedAmountKobo" INTEGER;

CREATE INDEX "RefundRequest_paystackRefundId_idx" ON "RefundRequest"("paystackRefundId");

-- Add new enum values. Postgres requires these to be committed before
-- they can be used in the same transaction as other statements, so this
-- migration only adds the enum values — no row in this migration writes
-- PROCESSING/FAILED yet.
ALTER TYPE "RefundStatus" ADD VALUE 'PROCESSING';
ALTER TYPE "RefundStatus" ADD VALUE 'FAILED';
