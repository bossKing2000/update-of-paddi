-- Stage F (E-02): database backstop for active-payment idempotency.
-- At most one in-flight (PENDING/INITIATED) Payment per
-- (userId, idempotencyKey). Terminal rows (SUCCESS/FAILED/EXPIRED/...)
-- and NULL keys are unaffected, so legitimate retry-after-expiry history
-- keeps working. Prisma cannot declare partial unique indexes, so this
-- is raw SQL by necessity (same pattern as the search infrastructure):
-- future `migrate diff` runs will propose dropping it — DO NOT accept
-- such a DROP; the index is load-bearing. Covered by a guard test that
-- asserts its existence and predicate.
CREATE UNIQUE INDEX "Payment_userId_idempotencyKey_active_key"
  ON "Payment" ("userId", "idempotencyKey")
  WHERE "status" IN ('PENDING', 'INITIATED') AND "idempotencyKey" IS NOT NULL;
