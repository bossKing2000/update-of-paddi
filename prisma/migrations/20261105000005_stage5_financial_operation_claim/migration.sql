-- =============================================================================
-- Foodi Paddi — Stage 5 Batch 1: Create FinancialOperationClaim table (Step 3)
-- =============================================================================
-- Creates the FinancialOperationClaim table (serializes external financial
-- operations per payment) and the FinancialOperationClaimLease table
-- (separate worker lease, not co-located on claim).
--
-- Depends on: Payment table (already exists), enum types from Step 1a.

CREATE TABLE "FinancialOperationClaim" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "operationType" "FinancialOperationType" NOT NULL,
    "status" "FinancialOperationStatus" NOT NULL,
    "terminalOutcome" "TerminalOutcome",
    "operationIdempotencyKey" TEXT NOT NULL,
    "externalReference" TEXT,
    "paystackRefundId" TEXT,
    "amountKobo" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'NGN',
    "operationVersion" INTEGER NOT NULL DEFAULT 0,
    "vendorPayoutId" TEXT,
    "refundRequestId" TEXT,
    "originalClaimId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "FinancialOperationClaim_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "FinancialOperationClaim_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "FinancialOperationClaim_vendorPayoutId_fkey" FOREIGN KEY ("vendorPayoutId") REFERENCES "VendorPayout"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "FinancialOperationClaim_refundRequestId_fkey" FOREIGN KEY ("refundRequestId") REFERENCES "RefundRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "FinancialOperationClaim_originalClaimId_fkey" FOREIGN KEY ("originalClaimId") REFERENCES "FinancialOperationClaim"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "FinancialOperationClaim_paymentId_idx" ON "FinancialOperationClaim"("paymentId");

-- CreateIndex
CREATE INDEX "FinancialOperationClaim_externalReference_idx" ON "FinancialOperationClaim"("externalReference");

-- CreateIndex
CREATE INDEX "FinancialOperationClaim_vendorPayoutId_idx" ON "FinancialOperationClaim"("vendorPayoutId");

-- CreateIndex
CREATE INDEX "FinancialOperationClaim_refundRequestId_idx" ON "FinancialOperationClaim"("refundRequestId");

-- CreateIndex
CREATE INDEX "FinancialOperationClaim_originalClaimId_idx" ON "FinancialOperationClaim"("originalClaimId");

-- CreateIndex
CREATE UNIQUE INDEX "FinancialOperationClaim_operationIdempotencyKey_key" ON "FinancialOperationClaim"("operationIdempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "FinancialOperationClaim_originalClaimId_key" ON "FinancialOperationClaim"("originalClaimId");

-- FinancialOperationClaimLease table (separate lease table, not co-located on claim)
CREATE TABLE "FinancialOperationClaimLease" (
    "id" TEXT NOT NULL,
    "claimId" TEXT NOT NULL,
    "workerId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FinancialOperationClaimLease_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "FinancialOperationClaimLease_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "FinancialOperationClaim"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "FinancialOperationClaimLease_claimId_key" ON "FinancialOperationClaimLease"("claimId");

-- CreateIndex
CREATE INDEX "FinancialOperationClaimLease_claimId_expiresAt_idx" ON "FinancialOperationClaimLease"("claimId", "expiresAt");

-- CreateIndex
CREATE INDEX "FinancialOperationClaimLease_expiresAt_idx" ON "FinancialOperationClaimLease"("expiresAt");
