-- Phase 2B.2 follow-up (F-2) — enforce one OptionGroupItem per
-- (optionGroupId, NORMALIZED name).
--
-- Background
-- ----------
-- `OptionGroupItem` had NO uniqueness constraint of any kind: its only index
-- was the non-unique `OptionGroupItem_optionGroupId_isActive_sortOrder_idx`,
-- which does not even cover `name`.
--
-- The application nevertheless treats an item name as unique WITHIN ITS GROUP:
-- `assertUniqueItemName` (src/services/optionGroup.service.ts) compares names
-- with `normalizeOptionName` (trim + lowercase) against the items of that one
-- group, and the legacy add-on consolidation matches items the same way
-- (src/services/productOptionMigration.ts). The migrator also reports an
-- ambiguous normalized name rather than guessing which item it meant.
--
-- But that pre-check is an unlocked read-then-write: two concurrent requests
-- can each observe "no item with this normalized name" and each insert one,
-- and NOTHING in the database prevented it. Unlike the OptionGroup case,
-- there was not even an exact-match index to catch two identical names.
--
-- SCOPE
-- -----
-- Uniqueness is per option group, NOT per product. A product may legitimately
-- carry several groups ("Size", "Protein", "Spice Level") whose item
-- namespaces are independent — the demo seed does exactly that, with "Small" /
-- "Medium" / "Large" under Size and "Chicken" under Protein on the SAME
-- product. The key is therefore ("optionGroupId", lower(btrim("name"))); a
-- product-scoped key would reject valid vendor data and change existing
-- behaviour.
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
--   * `prisma migrate deploy` applies only PENDING migrations and does not
--     detect drift, so this index must be preserved deliberately by hand.
--   * This index MUST therefore be registered in
--     tests/unit/migrationChainIntegrity.test.ts, so a future migration that
--     drops it is caught by CI rather than by a production incident.
--   * The `OptionGroup` model keeps its Prisma-visible `@@unique([productId,
--     name])`; that declaration is untouched here.
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
-- normalized column, which changes the model and two API response shapes (the
-- product create and update responses include OptionGroupItem wholesale) and is
-- out of scope for this migration.
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
-- If two items in the same group already differ only by case or surrounding
-- whitespace, the index cannot be created. The pre-check detects that and
-- aborts with an actionable error naming the affected group ids and the name
-- variants. This migration NEVER deletes, renames, or merges an item: those are
-- vendor-owned records and resolving them is a deliberate, separate operation.
--
-- This migration has NOT been applied to the configured application database.
--
-- Rollback
-- --------
-- Additive only — no column, no data change. To roll back:
--     DROP INDEX "OptionGroupItem_optionGroupId_name_lower_key";
-- No other index is touched.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "OptionGroupItem"
    GROUP BY "optionGroupId", lower(btrim("name"))
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION
      'Cannot create the normalized OptionGroupItem(optionGroupId, name) unique index: add-on names that differ only by case or surrounding whitespace already exist within the same option group. No rows were changed. Resolve the duplicates manually (rename or merge them within the group), then re-run this migration. Offending (optionGroupId, name variants) pairs: %',
      (
        SELECT string_agg(v, ', ')
        FROM (
          SELECT '"' || g."optionGroupId" || '" / ' || g."nameVariants" || '"' AS v
          FROM (
            SELECT "optionGroupId",
                   string_agg('"' || "name" || '"', ' | ' ORDER BY "name") AS "nameVariants"
            FROM "OptionGroupItem"
            GROUP BY "optionGroupId", lower(btrim("name"))
            HAVING COUNT(*) > 1
          ) g
          ORDER BY g."optionGroupId"
          LIMIT 20
        ) s
      );
  END IF;
END
$$;

CREATE UNIQUE INDEX "OptionGroupItem_optionGroupId_name_lower_key" ON "OptionGroupItem" ("optionGroupId", lower(btrim("name")));
