-- =============================================================================
-- Foodi Paddi — Stage 5 Batch 1: Add PayoutStatus.REVERSAL_PENDING (Step 1b)
-- =============================================================================
-- Must be a separate migration file committed before Step 1c, because new enum
-- values become visible within the same transaction but are not visible to
-- other transactions until the transaction commits.

ALTER TYPE "PayoutStatus" ADD VALUE IF NOT EXISTS 'REVERSAL_PENDING';
