import { logger } from "../lib/logger";
import { normalizeOptionName } from "./optionName";
import {
  LEGACY_MIGRATION_GROUP_NAME,
  MIGRATION_GROUP_NAME,
} from "./migrationGroupNames";

// Phase 2B.2 one-time data migration: legacy ProductOption rows gain a
// structured OptionGroup/OptionGroupItem counterpart.
//
// Guarantees:
// - Legacy ProductOption rows are NEVER written or deleted here.
// - CartItemOption / OrderItemOption are NEVER touched here.
// - Money is copied 1:1 (Float/naira, no conversion, no rounding).
// - The standard group is "Extras" (product decision). A group left behind by
//   an EARLIER migration run under the old name "Add-ons" is detected and
//   reported, never silently duplicated or rewritten.
// - Items match on the normalized name used by the live write path
//   (`optionName.normalizeOptionName`); ambiguities are reported, never guessed.
// - Each product migrates inside its own transaction (group + items together);
//   products are independent batches, never one giant tx.
// - Dry run and apply share ONE planning function, so the preview cannot drift
//   from what an apply would decide.

// Standard group names live in `migrationGroupNames.ts`, shared with
// `optionMigrationState.ts`. Re-exported here so existing importers of this
// module (e.g. `productMigrationRunner.ts`) keep working unchanged.
export { MIGRATION_GROUP_NAME, LEGACY_MIGRATION_GROUP_NAME };

export interface OptionMigrationPreflight {
  products: number;
  productOptions: number;
  activeOptions: number;
  inactiveOptions: number;
  productsWithOptions: number;
  cartItemOptions: number;
  orderItemOptions: number;
  optionGroups: number;
  optionGroupItems: number;
  orphanOptions: number;
  duplicateNames: number;
  /** Groups still named "Add-ons" from an earlier migration run. */
  legacyNamedGroups: number;
  /** Groups named "Extras" (standard or otherwise). */
  standardNamedGroups: number;
}

export type MigrationConflictKind =
  | "GROUP_DUPLICATE"
  | "GROUP_CONFLICT"
  | "LEGACY_GROUP_NAME"
  | "ITEM_AMBIGUOUS"
  | "ITEM_MISMATCH"
  | "TRANSACTION_FAILED"
  | "TRANSACTION_RETRIES_EXHAUSTED";

export interface OptionMigrationConflict {
  productId: string;
  kind: MigrationConflictKind;
  detail: string;
}

export interface OptionMigrationResult {
  dryRun: boolean;
  productsSeen: number;
  productsMigrated: number;
  productsSkipped: number;
  groupsCreated: number;
  groupsReused: number;
  itemsCreated: number;
  /** Items already present and identical — left untouched. */
  itemsAlreadyMigrated: number;
  conflicts: OptionMigrationConflict[];
}

/* ── row shapes ───────────────────────────────────────────────────────────── */

type LegacyOptionRow = {
  id: string;
  productId: string;
  name: string;
  price: number;
  isActive: boolean;
};

type OptionGroupRow = {
  id: string;
  productId: string;
  name: string;
  required: boolean;
  minSelections: number;
  maxSelections: number;
  sortOrder: number;
};

type OptionGroupItemRow = {
  id: string;
  optionGroupId: string;
  name: string;
  priceAdd: number;
  isActive: boolean;
};

export type MigrationDb = {
  product: { findMany(args: unknown): Promise<Array<{ id: string }>> };
  productOption: {
    findMany(args: unknown): Promise<LegacyOptionRow[]>;
    count(args?: unknown): Promise<number>;
  };
  cartItemOption: { count(args?: unknown): Promise<number> };
  orderItemOption: { count(args?: unknown): Promise<number> };
  optionGroup: {
    findMany(args: unknown): Promise<OptionGroupRow[]>;
    create(args: unknown): Promise<{ id: string }>;
  };
  optionGroupItem: {
    findMany(args: unknown): Promise<OptionGroupItemRow[]>;
    create(args: unknown): Promise<{ id: string }>;
  };
  $transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T>;
};

/* ── planning (shared by dry run and apply) ───────────────────────────────── */

/** What the migration will do with one legacy option. */
export type PlannedItemAction = "create" | "already-migrated" | "mismatch";

export interface PlannedItem {
  legacyName: string;
  priceAdd: number;
  isActive: boolean;
  sortOrder: number;
  action: PlannedItemAction;
  /** Present when action === "mismatch". */
  detail?: string;
}

export type ProductPlan =
  | { action: "no-legacy-options"; productId: string }
  | {
      action: "create-group";
      productId: string;
      groupConfig: OptionGroupRow;
      items: PlannedItem[];
      conflicts: OptionMigrationConflict[];
    }
  | {
      action: "reuse-group";
      productId: string;
      groupId: string;
      groupConfig: OptionGroupRow;
      items: PlannedItem[];
      conflicts: OptionMigrationConflict[];
    }
  | { action: "conflict"; productId: string; conflicts: OptionMigrationConflict[] };

/**
 * The standard selection rules for a consolidated group.
 *
 * required=false / minSelections=0 preserve the legacy behaviour exactly: a
 * customer could previously select any subset of a product's add-ons,
 * including none. Legacy ProductOption carries no selection semantics at all,
 * so any other value would be an invented customer-facing rule.
 *
 * maxSelections counts EVERY legacy option migrated into the group, including
 * inactive ones. Rationale: all legacy rows are preserved, and an inactive row
 * may be reactivated later by the vendor. Counting only today's active rows
 * would permanently cap the group below its intended ceiling and would require
 * a settings migration the moment an item is reactivated. The ceiling is
 * therefore allowed to be temporarily unreachable while an item stays inactive
 * — the safe direction, because it can never block a valid selection.
 */
export function standardGroupConfig(
  productId: string,
  legacyCount: number,
): OptionGroupRow {
  return {
    id: "",
    productId,
    name: MIGRATION_GROUP_NAME,
    required: false,
    minSelections: 0,
    maxSelections: legacyCount,
    sortOrder: 0,
  };
}

function sameConfig(a: OptionGroupRow, b: OptionGroupRow): boolean {
  return (
    a.required === b.required &&
    a.minSelections === b.minSelections &&
    a.maxSelections === b.maxSelections &&
    a.sortOrder === b.sortOrder
  );
}

function describeConfig(c: OptionGroupRow): string {
  return `required=${c.required}, min=${c.minSelections}, max=${c.maxSelections}, sort=${c.sortOrder}`;
}

/**
 * Decide what to do with ONE product, without writing anything.
 *
 * Pure reads plus arithmetic: safe to call outside a transaction (dry run) or
 * inside one (apply, immediately before writing).
 */
export async function planProductMigration(
  db: MigrationDb,
  productId: string,
  legacy: LegacyOptionRow[],
): Promise<ProductPlan> {
  if (legacy.length === 0) return { action: "no-legacy-options", productId };

  const expected = standardGroupConfig(productId, legacy.length);
  const conflicts: OptionMigrationConflict[] = [];

  const groups = await db.optionGroup.findMany({
    where: { productId },
    select: {
      id: true,
      productId: true,
      name: true,
      required: true,
      minSelections: true,
      maxSelections: true,
      sortOrder: true,
    },
  });

  const standardKey = normalizeOptionName(MIGRATION_GROUP_NAME);
  const legacyKey = normalizeOptionName(LEGACY_MIGRATION_GROUP_NAME);

  const standardGroups = groups.filter((g) => normalizeOptionName(g.name) === standardKey);
  const legacyGroups = groups.filter((g) => normalizeOptionName(g.name) === legacyKey);

  // (4) Multiple standard groups — never guess which is authoritative.
  if (standardGroups.length > 1) {
    return {
      action: "conflict",
      productId,
      conflicts: [
        {
          productId,
          kind: "GROUP_DUPLICATE",
          detail: `found ${standardGroups.length} groups named "${MIGRATION_GROUP_NAME}" (case-insensitive). Resolve them manually, then rerun.`,
        },
      ],
    };
  }

  const target = standardGroups[0];

  // (5) A group from an earlier migration run exists and no standard group does.
  // Never duplicate its contents under the new name automatically.
  if (!target && legacyGroups.length > 0) {
    return {
      action: "conflict",
      productId,
      conflicts: [
        {
          productId,
          kind: "LEGACY_GROUP_NAME",
          detail: `this product already has ${legacyGroups.length} group(s) named "${LEGACY_MIGRATION_GROUP_NAME}" from an earlier migration run. Rename or merge them into a single "${MIGRATION_GROUP_NAME}" group manually, then rerun. Nothing was changed.`,
        },
      ],
    };
  }

  // (3) Existing standard group with incompatible settings — never rewritten.
  if (target && !sameConfig(target, expected)) {
    return {
      action: "conflict",
      productId,
      conflicts: [
        {
          productId,
          kind: "GROUP_CONFLICT",
          detail: `existing "${MIGRATION_GROUP_NAME}" has incompatible settings (${describeConfig(target)}); expected ${describeConfig(expected)}. Its settings were left unchanged. Resolve manually, then rerun.`,
        },
      ],
    };
  }

  // (7)(8)(9)(10) Item-level planning against the target group's current items.
  const existingItems = target
    ? await db.optionGroupItem.findMany({
        where: { optionGroupId: target.id },
        select: { id: true, optionGroupId: true, name: true, priceAdd: true, isActive: true },
      })
    : [];

  // Normalized index of the TARGET items. More than one row under the same
  // normalized key is ambiguous — we report it instead of picking one.
  const byKey = new Map<string, OptionGroupItemRow[]>();
  for (const item of existingItems) {
    const key = normalizeOptionName(item.name);
    const bucket = byKey.get(key);
    if (bucket) bucket.push(item);
    else byKey.set(key, [item]);
  }

  // Legacy options are already unique per product by exact name, but two can
  // still normalize to the same key ("Extra Egg" / "extra egg" ).
  const legacyByKey = new Map<string, LegacyOptionRow[]>();
  for (const opt of legacy) {
    const key = normalizeOptionName(opt.name);
    const bucket = legacyByKey.get(key);
    if (bucket) bucket.push(opt);
    else legacyByKey.set(key, [opt]);
  }

  const items: PlannedItem[] = [];
  legacy.forEach((opt, index) => {
    const key = normalizeOptionName(opt.name);
    const legacyDuplicates = legacyByKey.get(key) ?? [];

    if (legacyDuplicates.length > 1) {
      conflicts.push({
        productId,
        kind: "ITEM_AMBIGUOUS",
        detail: `legacy options ${legacyDuplicates
          .map((o) => `"${o.name}"`)
          .join(", ")} normalize to the same add-on name "${key}". Resolve manually; nothing was created for them.`,
      });
      return;
    }

    const matches = byKey.get(key) ?? [];
    if (matches.length > 1) {
      conflicts.push({
        productId,
        kind: "ITEM_AMBIGUOUS",
        detail: `group already has ${matches.length} items normalizing to "${key}". Resolve manually; nothing was changed.`,
      });
      return;
    }

    const existing = matches[0];
    if (existing) {
      if (existing.priceAdd !== opt.price || existing.isActive !== opt.isActive) {
        // (8) Report, never overwrite vendor data.
        items.push({
          legacyName: opt.name,
          priceAdd: opt.price,
          isActive: opt.isActive,
          sortOrder: index,
          action: "mismatch",
          detail: `item "${opt.name}" exists with priceAdd=${existing.priceAdd}, isActive=${existing.isActive} but the legacy option is priceAdd=${opt.price}, isActive=${opt.isActive}. Left untouched.`,
        });
        conflicts.push({
          productId,
          kind: "ITEM_MISMATCH",
          detail: `item "${opt.name}" differs (priceAdd=${existing.priceAdd} vs ${opt.price}, isActive=${existing.isActive} vs ${opt.isActive}) — left untouched`,
        });
        return;
      }
      // (7) Identical — already migrated.
      items.push({
        legacyName: opt.name,
        priceAdd: opt.price,
        isActive: opt.isActive,
        sortOrder: index,
        action: "already-migrated",
      });
      return;
    }

    items.push({
      legacyName: opt.name,
      priceAdd: opt.price,
      isActive: opt.isActive,
      sortOrder: index,
      action: "create",
    });
  });

  if (target) {
    return {
      action: "reuse-group",
      productId,
      groupId: target.id,
      groupConfig: target,
      items,
      conflicts,
    };
  }
  return {
    action: "create-group",
    productId,
    groupConfig: expected,
    items,
    conflicts,
  };
}

/* ── preflight ────────────────────────────────────────────────────────────── */

export async function preflightProductOptionMigration(
  db: MigrationDb,
): Promise<OptionMigrationPreflight> {
  const [products, productOptions, cartItemOptions, orderItemOptions, optionGroups, optionGroupItems] =
    await Promise.all([
      db.product.findMany({ select: { id: true } }),
      db.productOption.findMany({
        // Deterministic legacy order: name ASC (+id tiebreak, though names are
        // unique per product). ProductOption carries no createdAt.
        select: { id: true, productId: true, name: true, price: true, isActive: true },
        orderBy: [{ name: "asc" }, { id: "asc" }],
      }),
      db.cartItemOption.count(),
      db.orderItemOption.count(),
      db.optionGroup.findMany({
        select: { id: true, productId: true, name: true, required: true, minSelections: true, maxSelections: true, sortOrder: true },
      }),
      db.optionGroupItem.findMany({ select: { id: true, optionGroupId: true, name: true, priceAdd: true, isActive: true } }),
    ]);

  const productsWithOptions = new Set(productOptions.map((o) => o.productId)).size;
  const seen = new Set<string>();
  let duplicateNames = 0;
  for (const o of productOptions) {
    const key = `${o.productId}::${o.name}`;
    if (seen.has(key)) duplicateNames++;
    else seen.add(key);
  }
  // Orphans are impossible while the FK exists; verify anyway.
  const productIds = new Set(products.map((p) => p.id));
  const orphanOptions = productOptions.filter((o) => !productIds.has(o.productId)).length;

  const standardKey = normalizeOptionName(MIGRATION_GROUP_NAME);
  const legacyKey = normalizeOptionName(LEGACY_MIGRATION_GROUP_NAME);

  return {
    products: products.length,
    productOptions: productOptions.length,
    activeOptions: productOptions.filter((o) => o.isActive).length,
    inactiveOptions: productOptions.filter((o) => !o.isActive).length,
    productsWithOptions,
    cartItemOptions,
    orderItemOptions,
    optionGroups: optionGroups.length,
    optionGroupItems: optionGroupItems.length,
    orphanOptions,
    duplicateNames,
    legacyNamedGroups: optionGroups.filter((g) => normalizeOptionName(g.name) === legacyKey).length,
    standardNamedGroups: optionGroups.filter((g) => normalizeOptionName(g.name) === standardKey).length,
  };
}

/* ── apply ────────────────────────────────────────────────────────────────── */

function isPrismaKnownError(error: unknown, code: string): boolean {
  const candidate = error as { code?: unknown; name?: unknown } | null;
  return (
    typeof candidate === "object" &&
    candidate !== null &&
    candidate.name === "PrismaClientKnownRequestError" &&
    candidate.code === code
  );
}

/** Raised inside a transaction when a concurrent writer won the group race. */
class GroupRaceLostError extends Error {
  constructor() {
    super("option migration lost the race to create the migration group");
    this.name = "GroupRaceLostError";
  }
}

/**
 * Raised inside a transaction when a concurrent writer won the item race.
 *
 * The transaction is now aborted, so we MUST NOT query inside it — bubble out
 * and let the caller re-read the winner outside the transaction and decide
 * whether the conflict is safely recoverable.
 */
class ItemRaceLostError extends Error {
  readonly productId: string;
  readonly groupId: string;
  /** The item we attempted to create, needed to verify the winner's identity. */
  readonly plannedItem: PlannedItem;
  constructor(productId: string, groupId: string, plannedItem: PlannedItem) {
    super(`option migration lost the race to create item "${plannedItem.legacyName}"`);
    this.name = "ItemRaceLostError";
    this.productId = productId;
    this.groupId = groupId;
    this.plannedItem = plannedItem;
  }
}

/** Raised when a retryable transaction error survived the bounded retry budget. */
class TransactionRetriesExhaustedError extends Error {
  readonly attempts: number;
  readonly cause: unknown;
  constructor(attempts: number, cause: unknown) {
    super(`transaction failed after ${attempts} attempts`);
    this.name = "TransactionRetriesExhaustedError";
    this.attempts = attempts;
    this.cause = cause;
  }
}

/**
 * Prisma v6 `P2034` — "Transaction failed due to a write conflict or a
 * deadlock. Please retry your transaction."
 *
 * This migration runs at PostgreSQL's default isolation level (`ReadCommitted`;
 * the code passes no `isolationLevel`, so Prisma uses the database default).
 * Concurrent inserts that contend on the same rows/index entries can therefore
 * surface as a write conflict rather than the `P2002` unique violation that
 * `GroupRaceLostError` handles. Prisma's documented remedy is a retry, so this
 * is the ONLY error code retried here.
 *
 * Deliberately narrow: `P2002` has dedicated handling, and every other code
 * (auth, connection, `P2028`, programming errors) propagates immediately —
 * retrying those would mask real failures and cannot succeed by re-running.
 */
function isRetryableTransactionError(error: unknown): boolean {
  return isPrismaKnownError(error, "P2034");
}

/**
 * Bounded retry budget for one product.
 *
 * Three attempts is enough to clear ordinary contention and small enough that a
 * genuine deadlock is reported quickly rather than retried indefinitely. The
 * value is a constant so the policy is deterministic and reviewable.
 */
export const MAX_TRANSACTION_ATTEMPTS = 3;

/**
 * Run one product's apply inside a transaction, retrying only `P2034`.
 *
 * SAFETY OF THE RETRY
 * -------------------
 * Each attempt calls `db.$transaction` afresh, so an aborted transaction is
 * never reused, and `applyProductPlan` RE-PLANS inside the new transaction
 * against current committed state. That is what makes a retry idempotent rather
 * than duplicating: if a concurrent writer committed an `Extras` group while we
 * were retrying, the new plan takes the `reuse-group` path and matching items
 * are recorded as `already-migrated` instead of being created twice.
 */
async function applyProductWithRetry(
  db: MigrationDb,
  productId: string,
  legacy: LegacyOptionRow[],
): Promise<ApplyOutcome> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_TRANSACTION_ATTEMPTS; attempt++) {
    try {
      return await db.$transaction((tx) =>
        applyProductPlan(tx as unknown as MigrationDb, productId, legacy),
      );
    } catch (error) {
      lastError = error;
      if (!isRetryableTransactionError(error) || attempt === MAX_TRANSACTION_ATTEMPTS) {
        if (isRetryableTransactionError(error)) {
          throw new TransactionRetriesExhaustedError(attempt, error);
        }
        throw error;
      }
      logger.warn(
        { productId, attempt, of: MAX_TRANSACTION_ATTEMPTS },
        "retrying transaction after a write conflict",
      );
    }
  }
  /* istanbul ignore next — the loop always returns or throws */
  throw lastError;
}

async function loadLegacyOptions(db: MigrationDb): Promise<Map<string, LegacyOptionRow[]>> {
  const allOptions = await db.productOption.findMany({
    select: { id: true, productId: true, name: true, price: true, isActive: true },
    orderBy: [{ name: "asc" }, { id: "asc" }],
  });
  const byProduct = new Map<string, LegacyOptionRow[]>();
  for (const o of allOptions) {
    const list = byProduct.get(o.productId) ?? [];
    list.push(o);
    byProduct.set(o.productId, list);
  }
  return byProduct;
}

/** Outcome of applying one product's plan. */
interface ApplyOutcome {
  /** False when the plan deliberately wrote nothing (no work to do). */
  applied: boolean;
  groupAction: "created" | "reused";
  created: number;
  /** Items found already identical — untouched. Mismatches are NOT counted here. */
  reused: number;
  /** Non-fatal conflicts found while planning. Must be surfaced by the caller. */
  conflicts: OptionMigrationConflict[];
}

/**
 * Control-flow signal, NOT a failure.
 *
 * Thrown when planning decides the product must be left alone. The conflicts
 * carry the operator-facing explanation, so the caller reports them as a normal
 * skip rather than logging an exception — otherwise every expected conflict
 * pollutes the log as a warning and the real errors become invisible.
 */
class PlanConflictSignal extends Error {
  readonly conflicts: OptionMigrationConflict[];
  constructor(conflicts: OptionMigrationConflict[]) {
    super("product requires manual resolution before it can be migrated");
    this.name = "PlanConflictSignal";
    this.conflicts = conflicts;
  }
}

/**
 * Apply one product's plan inside a transaction.
 *
 * Re-plans immediately before writing (source/target drift between preflight and
 * this call is therefore caught), then performs ONLY additive writes. Legacy
 * ProductOption rows and every cart/order record are untouched.
 */
async function applyProductPlan(
  tx: MigrationDb,
  productId: string,
  legacy: LegacyOptionRow[],
): Promise<ApplyOutcome> {
  const plan = await planProductMigration(tx, productId, legacy);

  const nothingToDo: ApplyOutcome = {
    applied: false,
    groupAction: "reused",
    created: 0,
    reused: 0,
    conflicts: [],
  };

  if (plan.action === "no-legacy-options") return nothingToDo;
  if (plan.action === "conflict") throw new PlanConflictSignal(plan.conflicts);

  // A plan with no items at all means every legacy option was ambiguous and
  // resolved to nothing. Creating an empty group with a non-zero selection
  // ceiling would be meaningless state, so write nothing and let the caller
  // report the conflicts.
  if (plan.items.length === 0) {
    return { ...nothingToDo, conflicts: plan.conflicts };
  }

  let groupId: string;
  let groupAction: "created" | "reused";
  if (plan.action === "create-group") {
    try {
      const created = await tx.optionGroup.create({
        data: {
          productId: plan.productId,
          name: MIGRATION_GROUP_NAME,
          required: plan.groupConfig.required,
          minSelections: plan.groupConfig.minSelections,
          maxSelections: plan.groupConfig.maxSelections,
          sortOrder: plan.groupConfig.sortOrder,
        },
      });
      groupId = created.id;
      groupAction = "created";
    } catch (error) {
      if (isPrismaKnownError(error, "P2002")) {
        // Someone else created the same-named group concurrently. The
        // transaction is now aborted, so we MUST NOT query inside it — bubble
        // out and let the caller re-read the winner.
        throw new GroupRaceLostError();
      }
      throw error;
    }
  } else {
    groupId = plan.groupId;
    groupAction = "reused";
  }

  let created = 0;
  let reused = 0;
  for (const item of plan.items) {
    if (item.action === "create") {
      try {
        await tx.optionGroupItem.create({
          data: {
            optionGroupId: groupId,
            name: item.legacyName,
            priceAdd: item.priceAdd,
            isActive: item.isActive,
            sortOrder: item.sortOrder,
          },
        });
        created++;
      } catch (error) {
        if (isPrismaKnownError(error, "P2002")) {
          // A concurrent writer inserted an item with the same normalized
          // name in this group first. The transaction is now aborted — bubble
          // out for recovery outside the transaction.
          throw new ItemRaceLostError(productId, groupId, item);
        }
        throw error;
      }
    } else if (item.action === "already-migrated") {
      reused++;
    }
    // "mismatch": deliberately writes nothing and is already in plan.conflicts.
  }
  return { applied: true, groupAction, created, reused, conflicts: plan.conflicts };
}

/** Last-resort conflict for an unexpected failure. Message only, no stack. */
function conflictFromUnknown(err: unknown, productId: string): OptionMigrationConflict {
  const message = err instanceof Error ? err.message : String(err);
  return {
    productId,
    kind: "TRANSACTION_FAILED",
    detail: `transaction failed: ${message}`,
  };
}

export async function migrateProductOptions(
  db: MigrationDb,
  opts?: { dryRun?: boolean },
): Promise<OptionMigrationResult> {
  const dryRun = opts?.dryRun ?? false;
  const result: OptionMigrationResult = {
    dryRun,
    productsSeen: 0,
    productsMigrated: 0,
    productsSkipped: 0,
    groupsCreated: 0,
    groupsReused: 0,
    itemsCreated: 0,
    itemsAlreadyMigrated: 0,
    conflicts: [],
  };

  const products = await db.product.findMany({ select: { id: true }, orderBy: { id: "asc" } });
  const byProduct = await loadLegacyOptions(db);

  for (const product of products) {
    const legacy = byProduct.get(product.id) ?? [];
    if (legacy.length === 0) continue;
    result.productsSeen++;

    // ── dry run: identical decision path, zero writes ──────────────────────
    if (dryRun) {
      const plan = await planProductMigration(db, product.id, legacy);
      if (plan.action === "no-legacy-options") continue;
      if (plan.action === "conflict") {
        result.productsSkipped++;
        result.conflicts.push(...plan.conflicts);
        continue;
      }
      result.conflicts.push(...plan.conflicts);
      if (plan.items.length === 0) {
        result.productsSkipped++;
        continue;
      }
      result.productsMigrated++;
      if (plan.action === "create-group") result.groupsCreated++;
      else result.groupsReused++;
      result.itemsCreated += plan.items.filter((i) => i.action === "create").length;
      result.itemsAlreadyMigrated += plan.items.filter((i) => i.action === "already-migrated").length;
      continue;
    }

    // ── apply ──────────────────────────────────────────────────────────────
    try {
      const outcome = await applyProductWithRetry(db, product.id, legacy);
      result.conflicts.push(...outcome.conflicts);
      if (!outcome.applied) {
        result.productsSkipped++;
        continue;
      }
      result.productsMigrated++;
      if (outcome.groupAction === "created") result.groupsCreated++;
      else result.groupsReused++;
      result.itemsCreated += outcome.created;
      result.itemsAlreadyMigrated += outcome.reused;
    } catch (err) {
      if (err instanceof PlanConflictSignal) {
        // Expected: the product was deliberately left untouched.
        result.productsSkipped++;
        result.conflicts.push(...err.conflicts);
        continue;
      }

      if (err instanceof TransactionRetriesExhaustedError) {
        // Retryable contention that never cleared within the bounded budget.
        // Reported distinctly so an operator can tell "gave up too early" from
        // "hit a genuine database failure".
        result.productsSkipped++;
        result.conflicts.push({
          productId: product.id,
          kind: "TRANSACTION_RETRIES_EXHAUSTED",
          detail: `transaction still conflicted after ${err.attempts} attempts; rerun the migration to continue`,
        });
        continue;
      }

      if (err instanceof GroupRaceLostError) {
        // Re-read the winning group OUTSIDE the aborted transaction and
        // continue only if it is compatible with what we intended to create.
        const plan = await planProductMigration(db, product.id, legacy);
        if (plan.action === "reuse-group") {
          try {
            const outcome = await applyProductWithRetry(db, product.id, legacy);
            result.conflicts.push(...outcome.conflicts);
            if (!outcome.applied) {
              result.productsSkipped++;
              continue;
            }
            result.productsMigrated++;
            result.groupsReused++;
            result.itemsCreated += outcome.created;
            result.itemsAlreadyMigrated += outcome.reused;
          } catch (retryErr) {
            result.productsSkipped++;
            if (retryErr instanceof PlanConflictSignal) result.conflicts.push(...retryErr.conflicts);
            else if (retryErr instanceof TransactionRetriesExhaustedError) {
              result.conflicts.push({
                productId: product.id,
                kind: "TRANSACTION_RETRIES_EXHAUSTED",
                detail: `transaction still conflicted after ${retryErr.attempts} attempts; rerun the migration to continue`,
              });
            } else if (retryErr instanceof ItemRaceLostError) {
              // The group was recovered, but a concurrent writer won the item
              // race during the reuse attempt. Report it as a conflict rather
              // than a generic transaction failure, and never as a success.
              result.conflicts.push({
                productId: product.id,
                kind: "ITEM_MISMATCH",
                detail: `uniqueness conflict creating migration item "${retryErr.plannedItem.legacyName}" during group-race recovery; the product was not fully migrated. Resolve manually, then rerun.`,
              });
            } else result.conflicts.push(conflictFromUnknown(retryErr, product.id));
          }
        } else if (plan.action === "conflict") {
          result.productsSkipped++;
          result.conflicts.push(...plan.conflicts);
        } else {
          // The re-read shows no reusable group, so the race cannot be resolved
          // safely by retrying. Leave the product untouched.
          result.productsSkipped++;
          result.conflicts.push({
            productId: product.id,
            kind: "GROUP_DUPLICATE",
            detail:
              "a concurrent writer created a group with this name that is not reusable; " +
              "resolve it manually, then rerun",
          });
        }
        continue;
      }

      if (err instanceof ItemRaceLostError) {
        // A concurrent writer won the item race. Recover at PRODUCT level:
        // re-attempt the whole product in a FRESH transaction, exactly as the
        // group-race branch above does.
        //
        // Why the whole product and not just the conflicting item: the aborted
        // transaction rolled back every item it had written, and the items
        // after the conflicting one were never written at all. Verifying only
        // the conflicting item would let a product be reported as migrated
        // while a sibling item was still missing or mismatched.
        //
        // The re-attempt re-plans inside its own transaction, so the
        // concurrent writer's item is recognised as already-migrated and
        // whatever is still missing is created. The result is therefore
        // indistinguishable from an equivalent non-racing migration.
        try {
          const outcome = await applyProductWithRetry(db, product.id, legacy);
          result.conflicts.push(...outcome.conflicts);
          if (!outcome.applied) {
            result.productsSkipped++;
            continue;
          }
          result.productsMigrated++;
          if (outcome.groupAction === "created") result.groupsCreated++;
          else result.groupsReused++;
          result.itemsCreated += outcome.created;
          result.itemsAlreadyMigrated += outcome.reused;
        } catch (retryErr) {
          // The recovery itself failed. Every branch reports a CONFLICT and
          // leaves the product skipped — a failed recovery must never be
          // reported as a successful migration, and must never escape this
          // handler as an unhandled rejection.
          result.productsSkipped++;
          if (retryErr instanceof PlanConflictSignal) {
            result.conflicts.push(...retryErr.conflicts);
          } else if (retryErr instanceof TransactionRetriesExhaustedError) {
            result.conflicts.push({
              productId: product.id,
              kind: "TRANSACTION_RETRIES_EXHAUSTED",
              detail: `transaction still conflicted after ${retryErr.attempts} attempts; rerun the migration to continue`,
            });
          } else if (retryErr instanceof ItemRaceLostError) {
            // The uniqueness conflict persists even after the retry (e.g. the
            // conflicting row is invisible to the application normalizer).
            // Report it as a conflict, never as a success.
            result.conflicts.push({
              productId: product.id,
              kind: "ITEM_MISMATCH",
              detail: `uniqueness conflict creating migration item "${retryErr.plannedItem.legacyName}" persisted after a retry; the product was not fully migrated. Resolve manually, then rerun.`,
            });
          } else if (retryErr instanceof GroupRaceLostError) {
            result.conflicts.push({
              productId: product.id,
              kind: "GROUP_DUPLICATE",
              detail:
                "a concurrent writer created a group with this name that is not reusable; " +
                "resolve it manually, then rerun",
            });
          } else {
            result.conflicts.push(conflictFromUnknown(retryErr, product.id));
          }
        }
        continue;
      }

      result.productsSkipped++;
      logger.warn({ err, productId: product.id }, "option migration product failed");
      result.conflicts.push(conflictFromUnknown(err, product.id));
    }
  }

  return result;
}

/** True when the run left anything an operator must resolve. */
export function hasUnresolvedConflicts(result: OptionMigrationResult): boolean {
  return result.conflicts.length > 0;
}