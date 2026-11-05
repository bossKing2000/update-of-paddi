-- Phase 2B.2 — enforce one OptionGroup per (productId, name).
--
-- Background
-- ----------
-- `OptionGroup` previously carried only a non-unique index on
-- (productId, sortOrder). The legacy add-on consolidation decides whether to
-- CREATE or REUSE the "Extras" group by reading first and writing second, so
-- two concurrent runs (or a run racing a vendor creating a group) could both
-- observe "no Extras group here" and both insert one. Nothing in the database
-- prevented that.
--
-- This migration adds the uniqueness guarantee that makes the race impossible.
-- The Prisma schema declares the identical constraint as
-- `@@unique([productId, name])`, which Prisma materialises as a unique index
-- named "OptionGroup_productId_name_key". Schema and SQL agree on that name.
--
-- Safety
-- ------
-- If duplicate (productId, name) groups already exist, this migration FAILS with
-- an actionable diagnostic and creates nothing. It never deletes, renames, or
-- merges existing groups: doing so would silently change vendor-owned data.
-- An operator must resolve duplicates deliberately, then re-apply.
--
-- This migration has NOT been executed against any database.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "OptionGroup"
    GROUP BY "productId", "name"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION
      'Cannot create OptionGroup(productId, name) unique index: duplicate option-group names already exist for the same product. No rows were changed. Resolve the duplicates manually (rename or merge them), then re-run this migration. Offending (productId, name) pairs: %',
      (
        SELECT string_agg(DISTINCT '"' || g."productId" || '" / "' || g."name" || '"', ', ')
        FROM (
          SELECT DISTINCT "productId", "name"
          FROM "OptionGroup"
          GROUP BY "productId", "name"
          HAVING COUNT(*) > 1
          ORDER BY "productId", "name"
          LIMIT 20
        ) g
      );
  END IF;
END
$$;

CREATE UNIQUE INDEX "OptionGroup_productId_name_key" ON "OptionGroup"("productId", "name");