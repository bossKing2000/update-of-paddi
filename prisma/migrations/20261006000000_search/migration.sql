-- Search infrastructure migration
-- Provides: pg_trgm extension, Product.tsvector_col, GIN/trigram indexes, trigger function & trigger
-- Idempotent: safe to re-run on a database where objects already exist

-- 0️⃣ pg_trgm extension (required for similarity() and trigram indexes)
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- 1️⃣ tsvector column on Product (stores precomputed full-text search vector)
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS tsvector_col tsvector;

-- 2️⃣ GIN index on tsvector_col for fast full-text search
CREATE INDEX IF NOT EXISTS product_tsv_idx ON "Product" USING GIN(tsvector_col);

-- 3️⃣ Trigram indexes for fuzzy similarity search (pg_trgm)
CREATE INDEX IF NOT EXISTS product_name_trgm_idx ON "Product" USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS product_description_trgm_idx ON "Product" USING gin (description gin_trgm_ops);

-- 4️⃣ Trigger function: automatically maintains tsvector_col on INSERT/UPDATE
CREATE OR REPLACE FUNCTION update_tsvector_col() RETURNS trigger AS $$
BEGIN
  NEW.tsvector_col := to_tsvector(
    'english',
    coalesce(NEW.name,'') || ' ' || coalesce(NEW.description,'')
  );
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

-- 5️⃣ Trigger: fire before INSERT or UPDATE on Product
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trigger_update_tsvector_col') THEN
    CREATE TRIGGER trigger_update_tsvector_col
    BEFORE INSERT OR UPDATE ON "Product"
    FOR EACH ROW EXECUTE FUNCTION update_tsvector_col();
  END IF;
END$$;

-- 6️⃣ Backfill existing rows (idempotent: only touches rows where tsvector_col IS NULL)
UPDATE "Product" SET tsvector_col = to_tsvector('english', coalesce(name,'') || ' ' || coalesce(description,'')) WHERE tsvector_col IS NULL;