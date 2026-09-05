-- Bottom Pot loyalty (Pot Points): minimal ledger + denormalized balance.
-- Earn rule (server-side only): +50 points per COMPLETED order, credited
-- once per order (unique orderId). No client-submitted values anywhere.
-- Redemption is intentionally out of scope for this phase; the ledger and
-- REDEEM type already support it later.

-- 1. Transaction type enum.
CREATE TYPE "PotPointTransactionType" AS ENUM ('EARN', 'REDEEM', 'ADJUST');

-- 2. Denormalized spendable balance on User (ledger is source of truth).
ALTER TABLE "User" ADD COLUMN "potPointsBalance" INTEGER NOT NULL DEFAULT 0;

-- 3. Append-only ledger.
CREATE TABLE "PotPointTransaction" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "points" INTEGER NOT NULL,
  "type" "PotPointTransactionType" NOT NULL,
  "reason" TEXT NOT NULL,
  "orderId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PotPointTransaction_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PotPointTransaction_orderId_key" ON "PotPointTransaction"("orderId");
CREATE INDEX "PotPointTransaction_userId_createdAt_idx" ON "PotPointTransaction"("userId", "createdAt");
ALTER TABLE "PotPointTransaction" ADD CONSTRAINT "PotPointTransaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
