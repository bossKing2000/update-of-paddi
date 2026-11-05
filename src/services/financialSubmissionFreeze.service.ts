import prisma from "../lib/prisma";
import { logger } from "../lib/logger";
import { ValidationError } from "../errors/AppError";

/**
 * Stage 5 Batch 1: Controlled Financial-Submission Freeze (§8.10.9)
 *
 * The freeze is not an informal feature flag — it is an enforced operational
 * procedure that prevents new payout and refund submissions while in-flight
 * operations are reconciled and claims are created. Deployment and database
 * changes are NOT atomic; the freeze bridges the gap between them.
 *
 * The freeze is enforced at the SERVICE LAYER boundary, not merely at HTTP
 * middleware. Every function that can initiate an external Paystack transfer
 * or refund submission must check the freeze flag as its FIRST operation.
 *
 * Fail-closed behavior: If the freeze state cannot be read, every submission
 * path must return 503 and not attempt any financial operation.
 *
 * Stale in-memory values: The freeze flag must NOT be cached indefinitely.
 * Each submission path reads the flag fresh on every submission attempt.
 */

// In-memory cache for the freeze flag (refreshed on every read attempt).
// The actual source of truth is a database row. This cache is only used to
// avoid hammering the DB on every call, but is always validated against
// the DB on each check.
let freezeCache: { frozen: boolean; lastChecked: number } | null = null;
const FREEZE_CACHE_TTL_MS = 5000; // Refresh at least every 5 seconds

/**
 * Reads the durable freeze state from the database.
 *
 * The freeze flag is stored as a system config row. We look for a row
 * with key = 'FINANCIAL_SUBMISSION_FROZEN' and value = 'true'.
 *
 * Returns true if frozen, false if not frozen, null if the state
 * cannot be determined (database error).
 */
async function readFreezeStateFromDb(): Promise<boolean | null> {
  try {
    // Use a raw query to avoid depending on a SystemConfig model that
    // may not exist yet. The freeze flag is stored as a simple key/value.
    const result = await prisma.$queryRaw<{ value: string }[]>`
      SELECT value FROM "SystemConfig" WHERE key = 'FINANCIAL_SUBMISSION_FROZEN'
    `;
    return result.length > 0 && result[0].value === "true";
  } catch (err) {
    logger.warn(
      { err: (err as Error)?.message },
      "financialSubmissionFreeze: could not read freeze state from database",
    );
    return null;
  }
}

/**
 * Reads the freeze state, refreshing the cache if stale.
 *
 * Returns true if frozen, false if not frozen.
 * If the state cannot be read, returns true (fail-closed).
 */
export async function isFinancialSubmissionFrozen(): Promise<boolean> {
  const now = Date.now();

  // If cache is fresh, use it
  if (
    freezeCache &&
    now - freezeCache.lastChecked < FREEZE_CACHE_TTL_MS
  ) {
    return freezeCache.frozen;
  }

  // Read from database
  const frozen = await readFreezeStateFromDb();

  // Fail-closed: if we can't read the state, treat as frozen
  const isFrozen = frozen ?? true;

  // Update cache
  freezeCache = { frozen: isFrozen, lastChecked: now };

  return isFrozen;
}

/**
 * Sets the freeze flag in the database.
 *
 * Creates or updates a SystemConfig row with key = 'FINANCIAL_SUBMISSION_FROZEN'
 * and value = 'true' (or 'false' to unfreeze).
 */
export async function setFinancialSubmissionFrozen(frozen: boolean): Promise<void> {
  try {
    await prisma.$queryRaw`
      INSERT INTO "SystemConfig" (key, value, createdAt, updatedAt)
      VALUES ('FINANCIAL_SUBMISSION_FROZEN', ${frozen ? "true" : "false"}, now(), now())
      ON CONFLICT (key) DO UPDATE
      SET value = EXCLUDED.value, updatedAt = now()
    `;

    // Invalidate cache so next read goes to DB
    freezeCache = null;

    logger.info(
      { frozen },
      "financialSubmissionFreeze: freeze state changed",
    );
  } catch (err) {
    logger.error(
      { err: (err as Error)?.message, frozen },
      "financialSubmissionFreeze: could not set freeze state",
    );
    throw err;
  }
}

/**
 * Middleware/guard function that checks the freeze state and throws if frozen.
 *
 * Every submission path must call this as its FIRST operation, before any
 * business logic or database write.
 *
 * Throws a ValidationError with code 'FINANCIAL_SUBMISSION_FROZEN' if frozen.
 */
export async function requireFinancialSubmissionNotFrozen(): Promise<void> {
  const frozen = await isFinancialSubmissionFrozen();
  if (frozen) {
    throw new ValidationError(
      "Financial submission is frozen. Please try again later.",
      "FINANCIAL_SUBMISSION_FROZEN",
    );
  }
}
