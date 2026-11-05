-- =============================================================================
-- Foodi Paddi — Stage 5 Batch 1: Create ReversalEvent, ReversalEventLease,
-- FinancialWebhookReceipt, FinancialWebhookReceiptConflict tables (Step 4)
-- =============================================================================
-- Depends on: VendorPayout table (already exists), enum types from Step 1a.

-- ReversalEvent table — durable log of every reversal notification before
-- any business logic. NO unique constraint on paystackReference — Paystack
-- does not document reversal event ID uniqueness.
CREATE TABLE "ReversalEvent" (
    "id" TEXT NOT NULL,
    "vendorPayoutId" TEXT,
    "paystackReference" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "providerEvent" TEXT,
    "source" TEXT,
    "payload" JSONB NOT NULL,
    "rawPayload" TEXT,
    "status" "ReversalEventStatus" NOT NULL,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "ReversalEvent_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ReversalEvent_vendorPayoutId_fkey" FOREIGN KEY ("vendorPayoutId") REFERENCES "VendorPayout"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "ReversalEvent_vendorPayoutId_status_idx" ON "ReversalEvent"("vendorPayoutId", "status");

-- CreateIndex
CREATE INDEX "ReversalEvent_status_idx" ON "ReversalEvent"("status");

-- ReversalEventLease table (separate lease table, not co-located on event)
CREATE TABLE "ReversalEventLease" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "workerId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "lastAttemptAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReversalEventLease_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ReversalEventLease_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "ReversalEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "ReversalEventLease_eventId_key" ON "ReversalEventLease"("eventId");

-- CreateIndex
CREATE INDEX "ReversalEventLease_eventId_expiresAt_idx" ON "ReversalEventLease"("eventId", "expiresAt");

-- CreateIndex
CREATE INDEX "ReversalEventLease_expiresAt_idx" ON "ReversalEventLease"("expiresAt");

-- FinancialWebhookReceipt table — durable receipt for ALL financial webhook
-- events (charge.success, charge.failed, transfer.success, transfer.failed,
-- transfer.reversed, refund.processed, refund.failed).
CREATE TABLE "FinancialWebhookReceipt" (
    "id" TEXT NOT NULL,
    "providerEvent" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "rawPayload" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "signatureValid" BOOLEAN NOT NULL DEFAULT false,
    "processed" BOOLEAN NOT NULL DEFAULT false,
    "processingLeaseId" TEXT,
    "processingLeaseExpiresAt" TIMESTAMP(3),
    "vendorPayoutId" TEXT,

    CONSTRAINT "FinancialWebhookReceipt_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "FinancialWebhookReceipt_vendorPayoutId_fkey" FOREIGN KEY ("vendorPayoutId") REFERENCES "VendorPayout"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "FinancialWebhookReceipt_providerEvent_receivedAt_idx" ON "FinancialWebhookReceipt"("providerEvent", "receivedAt");

-- CreateIndex
CREATE INDEX "FinancialWebhookReceipt_vendorPayoutId_idx" ON "FinancialWebhookReceipt"("vendorPayoutId");

-- CreateIndex
CREATE INDEX "FinancialWebhookReceipt_processed_idx" ON "FinancialWebhookReceipt"("processed");

-- CreateIndex
CREATE INDEX "FinancialWebhookReceipt_processingLeaseId_idx" ON "FinancialWebhookReceipt"("processingLeaseId");

-- FinancialWebhookReceiptConflict table — preserves conflicting evidence
-- (conflicting payloads for the same provider event).
CREATE TABLE "FinancialWebhookReceiptConflict" (
    "id" TEXT NOT NULL,
    "receiptId" TEXT NOT NULL,
    "conflictingReceiptId" TEXT NOT NULL,
    "conflictType" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "resolution" TEXT,
    "resolvedBy" TEXT,

    CONSTRAINT "FinancialWebhookReceiptConflict_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "FinancialWebhookReceiptConflict_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "FinancialWebhookReceipt"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "FinancialWebhookReceiptConflict_conflictingReceiptId_fkey" FOREIGN KEY ("conflictingReceiptId") REFERENCES "FinancialWebhookReceipt"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "FinancialWebhookReceiptConflict_receiptId_idx" ON "FinancialWebhookReceiptConflict"("receiptId");

-- CreateIndex
CREATE INDEX "FinancialWebhookReceiptConflict_conflictingReceiptId_idx" ON "FinancialWebhookReceiptConflict"("conflictingReceiptId");

-- CreateIndex
CREATE INDEX "FinancialWebhookReceiptConflict_conflictType_idx" ON "FinancialWebhookReceiptConflict"("conflictType");
