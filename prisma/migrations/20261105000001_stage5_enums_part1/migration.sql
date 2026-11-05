-- =============================================================================
-- Foodi Paddi — Stage 5 Batch 1: Financial-Operation Claim Enums (Step 1a)
-- =============================================================================
-- Creates new enum types required by the financial-operation claim layer.
-- These types must exist before any table references them.

-- VendorPayoutOrder.associationStatus values
CREATE TYPE "VendorPayoutOrderStatus" AS ENUM (
    'CLAIMED', 'SETTLED', 'REVERSAL_PENDING', 'RELEASED', 'REVERSED'
);

-- FinancialOperationClaim.operationType values
CREATE TYPE "FinancialOperationType" AS ENUM (
    'PAYOUT', 'REFUND', 'PAYOUT_REVERSAL'
);

-- FinancialOperationClaim.status values
CREATE TYPE "FinancialOperationStatus" AS ENUM (
    'CLAIMED', 'SUBMITTED', 'PROCESSING', 'COMPLETED', 'FAILED', 'REVERSED'
);

-- FinancialOperationClaim.terminalOutcome values
CREATE TYPE "TerminalOutcome" AS ENUM (
    'COMPLETED', 'FAILED', 'REVERSED'
);

-- ReversalEvent.status values
CREATE TYPE "ReversalEventStatus" AS ENUM (
    'PENDING', 'PENDING_REVERSAL', 'PROCESSING',
    'AWAITING_BALANCE_CONFIRMATION', 'RESOLVED', 'FAILED', 'MANUAL_REVIEW_REQUIRED'
);

-- LegacyPayoutOutcome.classification values
CREATE TYPE "LegacyPayoutOutcomeClassification" AS ENUM (
    'TRANSFER_SUBMITTED_UNKNOWN', 'TRANSFER_OUTCOME_UNKNOWN',
    'TRANSFER_SUCCESS_CONFIRMED', 'REVERSAL_CONFIRMED', 'MANUAL_INVESTIGATION_REQUIRED'
);
