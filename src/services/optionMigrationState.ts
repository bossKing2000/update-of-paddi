/**
 * Phase 2B.2 (review follow-up, F-2) — is a product's legacy add-on set fully
 * represented in its structured `Extras` group?
 *
 * WHY THIS EXISTS
 * ---------------
 * A migrated product legitimately carries BOTH representations forever:
 *   - legacy `ProductOption[]` rows (frozen read-only; historical carts and
 *     orders keep referencing them by id), and
 *   - a structured `Extras` group holding 1:1 copies.
 * Several product/cart responses select both, so the same add-on can appear
 * twice in one payload. Before this module there was no backend-computed way to
 * tell a fully-migrated product from a partially-migrated or conflicted one, so
 * no consumer could safely filter.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 * ----------------------------------
 * It does NOT decide to drop `options[]` from any response. See the note at the
 * bottom of `productController.ts`'s use site and the review report: removing a
 * field is a client-visible contract change, and whether any deployed client
 * reads `options[]` rather than `optionGroups[]` cannot be determined from this
 * repository. This module supplies the verified fact; the contract decision
 * stays with the API owner.
 *
 * PURE — no database access. Callers pass the rows they already loaded.
 */
import { normalizeOptionName } from "./optionName";
import {
  LEGACY_MIGRATION_GROUP_NAME,
  MIGRATION_GROUP_NAME,
} from "./migrationGroupNames";

/**
 * The name of the consolidated group the Phase 2B.2 migration writes.
 *
 * Backwards-compatible alias for the shared `MIGRATION_GROUP_NAME`; the literal
 * is defined once in `migrationGroupNames.ts`.
 */
export const MIGRATED_GROUP_NAME = MIGRATION_GROUP_NAME;

export interface LegacyOptionLike {
  name: string;
  price: number;
  isActive: boolean;
}

export interface OptionGroupItemLike {
  name: string;
  priceAdd: number;
  isActive: boolean;
}

export interface OptionGroupLike {
  name: string;
  items: OptionGroupItemLike[];
}

export type MigrationBlocker =
  | "NO_MIGRATED_GROUP"
  | "MULTIPLE_MIGRATED_GROUPS"
  | "LEGACY_ADDONS_GROUP_PRESENT"
  | "LEGACY_NAME_AMBIGUOUS"
  | "MIGRATED_NAME_AMBIGUOUS"
  | "LEGACY_OPTION_UNMATCHED"
  | "PRICE_MISMATCH"
  | "ACTIVE_MISMATCH";

export interface LegacyOptionMigrationState {
  /**
   * True only when an `Extras` group EXISTS and every legacy add-on has an exact
   * counterpart in it.
   *
   * Note the deliberate choice for a product with NO legacy add-ons and no
   * `Extras` group: this is `false`, because no `Extras` group exists to have
   * migrated anything. Claiming `true` there would assert that a migration
   * happened when nothing was ever migrated. Consumers are unaffected either
   * way — with zero legacy add-ons there is nothing that could render twice —
   * but the strict reading keeps the flag honest.
   */
  fullyMigrated: boolean;
  legacyCount: number;
  migratedItemCount: number;
  /** Sorted, de-duplicated. Empty when `fullyMigrated` is true. */
  blockers: MigrationBlocker[];
}

/**
 * Decide whether every legacy add-on is fully and unambiguously present in a
 * single `Extras` group.
 *
 * The comparison is deliberately STRICT — it is the same predicate the
 * migration itself uses to decide "already migrated":
 *   - names match after trim+lowercase,
 *   - `priceAdd` equals `price` exactly (Float/naira, no conversion),
 *   - `isActive` is equal.
 *
 * Any deviation is reported as a blocker rather than tolerated, so a partially
 * migrated or conflicted product can never be mistaken for a complete one.
 */
/**
 * Coerce to an array without throwing.
 *
 * This runs inside RESPONSE BUILDERS. If a caller ever hands us a non-array
 * (a nested-write descriptor, a null, a partial mock), throwing here would turn
 * an otherwise successful product create/update into a 500 — the response
 * assembly must never be able to fail the write that already succeeded. A
 * non-array is treated as "no rows", which yields `fullyMigrated: false`: the
 * conservative answer.
 */
function toRows<T>(value: T[] | unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

export function deriveLegacyOptionMigrationState(
  legacyOptions: LegacyOptionLike[],
  optionGroups: OptionGroupLike[],
): LegacyOptionMigrationState {
  const blockers = new Set<MigrationBlocker>();
  const legacy = toRows<LegacyOptionLike>(legacyOptions);
  const groups = toRows<OptionGroupLike>(optionGroups);
  const key = normalizeOptionName(MIGRATED_GROUP_NAME);

  const migrated = groups.filter((g) => g && normalizeOptionName(g.name) === key);
  if (migrated.length === 0) blockers.add("NO_MIGRATED_GROUP");
  if (migrated.length > 1) blockers.add("MULTIPLE_MIGRATED_GROUPS");

  // A leftover "Add-ons" group means an earlier migration run is unresolved.
  if (
    groups.some(
      (g) => g && normalizeOptionName(g.name) === normalizeOptionName(LEGACY_MIGRATION_GROUP_NAME),
    )
  ) {
    blockers.add("LEGACY_ADDONS_GROUP_PRESENT");
  }

  // Index migrated items, detecting ambiguity on both sides.
  const byKey = new Map<string, OptionGroupItemLike[]>();
  for (const group of migrated) {
    for (const item of toRows<OptionGroupItemLike>(group.items)) {
      const k = normalizeOptionName(item.name);
      const bucket = byKey.get(k);
      if (bucket) bucket.push(item);
      else byKey.set(k, [item]);
    }
  }

  const legacyByKey = new Map<string, LegacyOptionLike[]>();
  for (const opt of legacy) {
    const k = normalizeOptionName(opt.name);
    const bucket = legacyByKey.get(k);
    if (bucket) bucket.push(opt);
    else legacyByKey.set(k, [opt]);
  }
  if (legacyByKey.size !== legacy.length) blockers.add("LEGACY_NAME_AMBIGUOUS");
  for (const bucket of byKey.values()) {
    if (bucket.length > 1) blockers.add("MIGRATED_NAME_AMBIGUOUS");
  }

  for (const opt of legacy) {
    const matches = byKey.get(normalizeOptionName(opt.name)) ?? [];
    if (matches.length === 0) {
      blockers.add("LEGACY_OPTION_UNMATCHED");
      continue;
    }
    const match = matches[0];
    if (match.priceAdd !== opt.price) blockers.add("PRICE_MISMATCH");
    if (match.isActive !== opt.isActive) blockers.add("ACTIVE_MISMATCH");
  }

  const sorted = [...blockers].sort();
  return {
    // No `Extras` group means nothing was migrated, even when there were no
    // legacy add-ons to migrate. See `fullyMigrated` on the interface.
    fullyMigrated: sorted.length === 0,
    legacyCount: legacy.length,
    migratedItemCount: migrated.reduce((n, g) => n + toRows<OptionGroupItemLike>(g.items).length, 0),
    blockers: sorted,
  };
}