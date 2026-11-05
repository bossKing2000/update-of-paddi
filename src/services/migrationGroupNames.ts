/**
 * Standard option-group names shared by the Phase 2B.2 legacy add-on migration
 * (`productOptionMigration.ts`) and the dual-representation state derivation
 * (`optionMigrationState.ts`).
 *
 * ONE definition, so the migration's write path and the state check can never
 * disagree about which group is the standard one or which name belongs to an
 * earlier migration run. This module is intentionally tiny and dependency-free:
 * both consumers already depend only on `optionName.ts`, so importing these
 * constants introduces no circular dependency and no Prisma/Redis import.
 *
 * The strings are a product decision. Do not change them here without changing
 * the migration semantics (and existing catalog data) deliberately.
 */

/** The standard group name for consolidated legacy add-ons. */
export const MIGRATION_GROUP_NAME = "Extras";

/**
 * The group name used by the first version of this migration. Kept only to
 * DETECT it. We never rename, merge, or delete such a group automatically:
 * doing so would silently rewrite vendor-owned catalog data. A product holding
 * one is reported as a conflict for an operator to resolve.
 */
export const LEGACY_MIGRATION_GROUP_NAME = "Add-ons";
