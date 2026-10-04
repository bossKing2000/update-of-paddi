-- Phase 1B.2-G: capture objects that exist in production / application
-- expectations but were never created by any migration (verified with
-- `prisma migrate diff`). Additive and idempotent: every statement below
-- is safe to re-run and safe on databases where the objects already exist.
--
-- Deliberately NOT included here (destructive or behaviour-changing —
-- needs a human decision, see the 1B.2 report):
-- - DROP TABLE "PromotionProducts" and its FKs: the old explicit join
--   table may still hold promo<->product links in production. Copy its
--   rows into "_PromotionProducts" ("A"=productId, "B"=promotionId)
--   first, verify counts, then drop it manually.
-- - DishType."updatedAt" DROP DEFAULT: behaviour change, review separately.

-- ── 0. pg_trgm (needed for the trigram indexes below) ────────────────────
-- NOTE: CREATE EXTENSION requires privileges the deploy role may not have.
-- If this statement fails on a managed DB, have an admin run
-- `CREATE EXTENSION IF NOT EXISTS pg_trgm;` once, then re-run the migration.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ── 1. UserSession ───────────────────────────────────────────────────────
-- lib/session.ts treats Postgres as the source of truth (Redis is cache),
-- but no migration ever created this table.
CREATE TABLE IF NOT EXISTS "UserSession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "ip" TEXT,
    "userAgent" TEXT,
    "deviceId" TEXT,
    "geoCity" TEXT,
    "geoRegion" TEXT,
    "geoCountry" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastRefreshedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserSession_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "UserSession_sessionId_key" ON "UserSession"("sessionId");
CREATE INDEX IF NOT EXISTS "UserSession_userId_idx" ON "UserSession"("userId");
CREATE INDEX IF NOT EXISTS "UserSession_sessionId_idx" ON "UserSession"("sessionId");
CREATE INDEX IF NOT EXISTS "UserSession_userId_sessionId_idx" ON "UserSession"("userId", "sessionId");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'UserSession_userId_fkey') THEN
    ALTER TABLE "UserSession" ADD CONSTRAINT "UserSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END$$;

-- ── 2. CustomerSupportTicket ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "CustomerSupportTicket" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "status" "SupportTicketStatus" NOT NULL DEFAULT 'OPEN',
    "orderId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerSupportTicket_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "CustomerSupportTicket_customerId_createdAt_idx" ON "CustomerSupportTicket"("customerId", "createdAt");
CREATE INDEX IF NOT EXISTS "CustomerSupportTicket_customerId_status_idx" ON "CustomerSupportTicket"("customerId", "status");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CustomerSupportTicket_customerId_fkey') THEN
    ALTER TABLE "CustomerSupportTicket" ADD CONSTRAINT "CustomerSupportTicket_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END$$;

-- ── 3. _PromotionProducts (Prisma implicit m-n table) ────────────────────
CREATE TABLE IF NOT EXISTS "_PromotionProducts" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_PromotionProducts_AB_pkey" PRIMARY KEY ("A","B")
);

CREATE INDEX IF NOT EXISTS "_PromotionProducts_B_index" ON "_PromotionProducts"("B");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '_PromotionProducts_A_fkey') THEN
    ALTER TABLE "_PromotionProducts" ADD CONSTRAINT "_PromotionProducts_A_fkey" FOREIGN KEY ("A") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '_PromotionProducts_B_fkey') THEN
    ALTER TABLE "_PromotionProducts" ADD CONSTRAINT "_PromotionProducts_B_fkey" FOREIGN KEY ("B") REFERENCES "Promotion"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END$$;

-- ── 4. Product full-text search (previously boot-created) ────────────────
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS tsvector_col tsvector;

CREATE INDEX IF NOT EXISTS product_tsv_idx ON "Product" USING GIN(tsvector_col);
CREATE INDEX IF NOT EXISTS product_name_trgm_idx ON "Product" USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS product_description_trgm_idx ON "Product" USING gin (description gin_trgm_ops);

CREATE OR REPLACE FUNCTION update_tsvector_col() RETURNS trigger AS $$
BEGIN
  NEW.tsvector_col := to_tsvector(
    'english',
    coalesce(NEW.name,'') || ' ' || coalesce(NEW.description,'')
  );
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trigger_update_tsvector_col') THEN
    CREATE TRIGGER trigger_update_tsvector_col
    BEFORE INSERT OR UPDATE ON "Product"
    FOR EACH ROW EXECUTE FUNCTION update_tsvector_col();
  END IF;
END$$;

UPDATE "Product" SET tsvector_col = to_tsvector('english', coalesce(name,'') || ' ' || coalesce(description,'')) WHERE tsvector_col IS NULL;
