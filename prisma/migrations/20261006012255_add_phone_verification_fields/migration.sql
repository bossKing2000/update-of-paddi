-- AlterTable: Phase 1D.1 phone normalization foundation.
-- Adds canonical E.164 identity + durable verification state.
-- OTP data lives in Redis, never in PostgreSQL.
ALTER TABLE "User" ADD COLUMN "phoneNumberE164" TEXT;

ALTER TABLE "User" ADD COLUMN "isPhoneVerified" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "User" ADD COLUMN "phoneVerifiedAt" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "User_phoneNumberE164_key" ON "User"("phoneNumberE164");
