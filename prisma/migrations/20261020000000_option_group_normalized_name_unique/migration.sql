-- Phase 2B.2 follow-up (F-1) — enforce one OptionGroup per
-- (productId, NORMALIZED name).
--
-- Background
-- ----------
-- 20261018000000_option_group_product_name_unique added the exact-match unique
-- index "OptionGroup_productId_name_key" on ("productId", "name"). That closed
-- the race for two writers using the IDENTICAL name: the second INSERT blocks on
-- the index and is rejected with P2002.
--
-- It did NOT close the race for two writers whose names are equivalent under
-- the application's own comparison rule. The application compares option-group
-- names with `normalizeOptionName` (src/services/optionName.ts):
--
--     name.trim().toLowerCase()
--
-- so "Extras", "extras" and "  Extras  " are the SAME name to the application.
-- The database index is exact-match, so it treats them as three different
-- values and lets all three exist on one product. Both the application
-- pre-check (assertUniqueGroupName) and the nested product writes
-- (productController.ts) read first and write second with no lock, so two
-- concurrent requests can each observe "no group with this normalized name" and
-- each insert one. Nothing in the database prevents that.
--
-- This migration closes that gap at the database level, so the guarantee holds
-- for EVERY writer: the option-group service, the nested product create/update
-- paths, the legacy add-on consolidation runner, and the demo seeder.
--
-- Strategy
-- --------
-- A unique index over a PostgreSQL expression:
--
--     ("productId", lower(btrim("name")))
--
-- The existing exact-match index is KEPT, along with its Prisma schema
-- declaration, for two reasons:
--   1. Prisma's schema language cannot express an expression index, so
--      schema.prisma keeps describing the exact-match constraint while this
--      file adds the stronger one.
--   2. Keeping the exact index means `prisma migrate dev` sees no drift and
--      will not try to recreate or drop it.
--
-- PRISMA LIMITATION / DRIFT WARNING — READ BEFORE TOUCHING THE SCHEMA
-- ------------------------------------------------------------------------
-- Prisma 6 cannot represent an expression-based index in schema.prisma. The
-- official documentation states: "Indexes using a function (such as
-- to_tsvector) to determine the indexed value are not yet supported by Prisma
-- ORM. Indexes defined in this way will not be visible with `prisma db pull`."
--
-- Consequences, all of which are intentional:
--   * `prisma db pull` will NOT report this index, and `prisma migrate dev`
--     will not reproduce it. A schema diff generated from schema.prisma alone
--     would propose dropping it.
--   * This index MUST therefore be preserved deliberately by hand, exactly like
--     the load-bearing partial unique indexes in 20261016025918_init. It is
--     registered in tests/unit/migrationChainIntegrity.test.ts so that a future
--     migration which drops it is caught by CI.
--   * Do NOT remove the exact-match `@@unique([productId, name])` declaration
--     from schema.prisma to "avoid two indexes". It is the Prisma-visible
--     half of the guarantee, and dropping it would make `migrate dev` recreate
--     it and the schema diverge from the database.
--
-- NORMALIZATION CAVEAT — the two rules are NOT identical
-- -------------------------------------------------------
-- Application : name.trim().toLowerCase()   (JavaScript)
-- Database    : lower(btrim(name))          (PostgreSQL)
--
-- They agree for ordinary short ASCII add-on names, which is what this table
-- holds. They differ in two edge cases:
--   * PostgreSQL's default btrim() removes ordinary SPACES only; JavaScript's
--     trim() also removes tabs, newlines, NBSP and other Unicode whitespace.
--   * PostgreSQL's lower() follows the rules of the DATABASE LOCALE;
--     JavaScript's toLowerCase() is locale-independent Unicode.
-- A name that differs only by, say, a leading tab is therefore distinct to the
-- database but identical to the application. This is a known, accepted gap,
-- not an oversight. Closing it would require a stored, application-computed
-- normalized column, which changes the model and two API response shapes
-- (the product create and update responses include OptionGroup wholesale) and
-- is out of scope for this migration.
--
-- Failure safety
-- --------------
-- No explicit BEGIN/COMMIT is used, for two reasons:
--   1. The pre-check below is READ-ONLY. If it raises, nothing has been
--      written and the CREATE INDEX that follows never runs.
--   2. The only write in this file is a single CREATE UNIQUE INDEX statement.
--      PostgreSQL executes DDL transactionally, so a failure inside that
--      statement leaves no partially created index behind.
-- An explicit transaction would add nothing but a hazard: no other migration
-- in this chain uses one, and if the migration runner already wraps the file in
-- a transaction, an inner COMMIT would close the runner's transaction early.
--
-- Existing data
-- -------------
-- If two groups on the same product already differ only by case or surrounding
-- whitespace, the index cannot be created. The pre-check detects that and
-- aborts with an actionable error naming the affected product and the name
-- variants. This migration NEVER deletes, renames, or merges a group: those are
-- vendor-owned records and resolving them is a deliberate, separate operation.
--
-- This migration has NOT been applied to any database.
--
-- Rollback
-- --------
-- Additive only — no column, no data change. To roll back:
--     DROP INDEX "OptionGroup_productId_name_lower_key";
-- The exact-match index is untouched and remains in force.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "OptionGroup"
    GROUP BY "productId", lower(btrim("name"))
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION
      'Cannot create the normalized OptionGroup(productId, name) unique index: option-group names that differ only by case or surrounding whitespace already exist for the same product. No rows were changed. Resolve the duplicates manually (rename or merge them), then re-run this migration. Offending (productId, name variants) pairs: %',
      (
        SELECT string_agg(v, ', ')
        FROM (
          SELECT '"' || g."productId" || '" / ' || g."nameVariants" || '"' AS v
          FROM (
            SELECT "productId",
                   string_agg('"' || "name" || '"', ' | ' ORDER BY "name") AS "nameVariants"
            FROM "OptionGroup"
            GROUP BY "productId", lower(btrim("name"))
            HAVING COUNT(*) > 1
          ) g
          ORDER BY g."productId"
          LIMIT 20
        ) s
      );
  END IF;
END
$$;

CREATE UNIQUE INDEX "OptionGroup_productId_name_lower_key" ON "OptionGroup" ("productId", lower(btrim("name")));
