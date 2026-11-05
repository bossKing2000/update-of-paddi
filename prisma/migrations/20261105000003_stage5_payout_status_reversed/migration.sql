-- =============================================================================
-- Foodi Paddi — Stage 5 Batch 1: Add PayoutStatus.REVERSED (Step 1c)
-- =============================================================================
-- Must be a separate migration file committed after Step 1b.

ALTER TYPE "PayoutStatus" ADD VALUE IF NOT EXISTS 'REVERSED';
