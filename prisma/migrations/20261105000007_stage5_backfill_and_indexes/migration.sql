-- =============================================================================
-- Foodi Paddi — Stage 5 Batch 1: Backfill and Partial Unique Indexes (Steps 5–7)
-- =============================================================================
-- Step 5: Backfill VendorPayoutOrder from existing Order.payoutId → VendorPayout.id
-- relationships. Must run AFTER Step 2 (table exists) and Step 1a (enum type
-- exists for associationStatus values).
--
-- Step 6: Create VendorPayoutOrder_one_active_per_order partial unique index
-- (must be created AFTER backfill — if existing data has multiple active
-- associations per order, index creation will fail with duplicate-key error).
--
-- Step 7: Create FinancialOperationClaim_one_active_per_payment partial unique
-- index (table starts empty, so no backfill dependency).

-- Step 5: VendorPayoutOrder backfill — all existing associations start as CLAIMED
-- Local PAID alone is NOT provider-confirmed success; local FAILED alone is
-- NOT proof money didn't move.
INSERT INTO "VendorPayoutOrder" (
    "id", "vendorPayoutId", "orderId", "associationStatus",
    "basePriceKobo", "commissionKobo", "vendorPayoutKobo",
    "discountKobo", "deliveryFeeKobo", "claimedAt", "createdAt", "updatedAt"
)
SELECT
    gen_random_uuid()::text,
    o."payoutId",
    o."id",
    'CLAIMED',
    o."basePrice",
    o."commissionKobo",
    o."vendorPayoutKobo",
    o."discountKobo",
    o."deliveryFee",
    o."createdAt",
    o."createdAt",
    o."createdAt"
FROM "Order" o
JOIN "VendorPayout" vp ON vp."id" = o."payoutId"
WHERE o."payoutId" IS NOT NULL
ON CONFLICT ("vendorPayoutId", "orderId") DO NOTHING;

-- Step 5b: LegacyPayoutOutcome backfill — all existing associations classified
-- as TRANSFER_OUTCOME_UNKNOWN. Local PAID alone is NOT provider-confirmed;
-- local FAILED alone is NOT proof money didn't move.
INSERT INTO "LegacyPayoutOutcome" (
    "id", "orderId", "vendorPayoutId", "classification",
    "evidenceSummary", "providerEvidence", "localPayoutStatus",
    "createdAt", "updatedAt"
)
SELECT
    gen_random_uuid()::text,
    o."id",
    o."payoutId",
    'TRANSFER_OUTCOME_UNKNOWN',
    CASE vp."status"
        WHEN 'PENDING' THEN 'Local status PENDING; transfer submission not established'
        WHEN 'PROCESSING' THEN 'Local status PROCESSING; provider outcome unknown'
        WHEN 'PAID' THEN 'Local status PAID; provider evidence not independently verified'
        WHEN 'FAILED' THEN 'Local status FAILED; provider reconciliation required — money may have moved'
        ELSE 'Local status ' || vp."status" || '; provider evidence not inspected'
    END,
    NULL::jsonb,
    vp."status",
    o."createdAt",
    o."createdAt"
FROM "Order" o
JOIN "VendorPayout" vp ON vp."id" = o."payoutId"
WHERE o."payoutId" IS NOT NULL
ON CONFLICT ("orderId") DO NOTHING;

-- Step 6: Create VendorPayoutOrder_one_active_per_order partial unique index
-- (AFTER backfill — creating before backfill would fail if existing data has
-- multiple active associations per order).
-- Active = CLAIMED (being claimed), SETTLED (payout paid, order still bound),
-- or REVERSAL_PENDING (reversal in progress, funds not yet confirmed returned).
-- RELEASED and REVERSED are terminal and do not block new reservations.
CREATE UNIQUE INDEX "VendorPayoutOrder_one_active_per_order"
  ON "VendorPayoutOrder" ("orderId")
  WHERE "associationStatus" IN ('CLAIMED', 'SETTLED', 'REVERSAL_PENDING');

-- Step 7: Create FinancialOperationClaim_one_active_per_payment partial unique
-- index (table starts empty, so no backfill dependency).
-- Enforces: at most ONE active (non-terminal) financial operation of ANY type
-- per payment. Active states: CLAIMED, SUBMITTED, PROCESSING.
CREATE UNIQUE INDEX "FinancialOperationClaim_one_active_per_payment"
  ON "FinancialOperationClaim" ("paymentId")
  WHERE "status" IN ('CLAIMED', 'SUBMITTED', 'PROCESSING');
