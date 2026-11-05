/**
 * Phase 2B.2 — Legacy ProductOption → OptionGroup consolidation,
 * proven against a real local PostgreSQL database.
 *
 * These suites exercise the ACTUAL database constraints, transaction
 * rollback, concurrency behaviour, and legacy-data preservation of the
 * migration. No Prisma delegates are mocked for the guarantees under test.
 *
 * Safety
 * ------
 * Runs only against the disposable test database validated by
 * tests/setup/integrationPreflight.ts (TEST_DATABASE_URL on a non-default
 * loopback port). Never targets the application database. All temp rows are
 * self-cleaning.
 */
import { PrismaClient } from "@prisma/client";
import { readFileSync } from "fs";
import { join } from "path";
import {
  migrateProductOptions,
  MIGRATION_GROUP_NAME,
  type MigrationDb,
} from "../../src/services/productOptionMigration";
import { ensureTestDishType, type TestDishTypeHandle } from "../helpers/testDishType";

jest.setTimeout(60000);

const prisma = new PrismaClient();
let testDishType: TestDishTypeHandle | null = null;

beforeAll(async () => {
  testDishType = await ensureTestDishType(prisma);
});

afterAll(async () => {
  // Leave the database exactly as `prisma migrate deploy` left it: ALL
  // migration-owned name indexes present (the two OptionGroup ones and the
  // OptionGroupItem one), because `_prisma_migrations` records those
  // migrations as applied and a non-pending migration is never recreated
  // by `migrate deploy`.
  //
  // A restoration failure is deliberately NOT swallowed: it fails the run
  // rather than leaving a database that has silently lost its uniqueness
  // guarantee. All describe-level teardowns have already removed their own
  // rows by this point, so the migrations' duplicate pre-checks pass.
  await ensureMigrationIndexes();
  await prisma.$disconnect();
  await testDishType?.dispose();
});

const MIGRATION_SQL = readFileSync(
  join(
    __dirname,
    "..",
    "..",
    "prisma",
    "migrations",
    "20261018000000_option_group_product_name_unique",
    "migration.sql",
  ),
  "utf8",
);

// The migration file contains a DO block followed by a CREATE INDEX.
// Prisma's $executeRawUnsafe does not allow multiple commands in a single
// prepared statement, so split them into two executable parts.
const DO_BLOCK_END = "$$;";
const doBlockIdx = MIGRATION_SQL.indexOf(DO_BLOCK_END);
const DO_BLOCK = MIGRATION_SQL.slice(0, doBlockIdx + DO_BLOCK_END.length);
const CREATE_INDEX = MIGRATION_SQL.slice(doBlockIdx + DO_BLOCK_END.length).trim();

const DISH_TYPE_ID = "JOLLOF";
const CATEGORY_ID = "TEST_CAT_JOLLOF";

const createdRows: string[][] = [];
function track(table: string, id: string) {
  createdRows.push([table, id]);
}
async function cleanupTracked() {
  // Delete in child-before-parent order to respect RESTRICT FKs.
  const order = [
    "OrderItemOption",
    "CartItemOption",
    "OrderItem",
    "CartItem",
    "Order",
    "Cart",
    "OptionGroupItem",
    "OptionGroup",
    "ProductOption",
    "Product",
    "User",
  ];
  for (const table of order) {
    const ids = createdRows
      .filter(([t]) => t === table)
      .map(([, id]) => id);
    if (ids.length) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (prisma as any)[table]
        .deleteMany({ where: { id: { in: ids } } })
        .catch(() => undefined);
    }
  }
  createdRows.length = 0;
}

function db(): MigrationDb {
  return new PrismaClient({ datasources: { db: { url: process.env.TEST_DATABASE_URL ?? "" } } }) as unknown as MigrationDb;
}

async function seedProductWithOptions(tag: string, names: string[]) {
  const vendor = await prisma.user.create({
    data: { email: `${tag}-vendor@example.com`, name: "Vendor", role: "VENDOR", roles: ["VENDOR"] },
  });
  track("User", vendor.id);
  const product = await prisma.product.create({
    data: {
      name: `${tag} product`,
      description: "migration fixture",
      price: 1000,
      dishTypeId: DISH_TYPE_ID,
      categoryId: CATEGORY_ID,
      vendorId: vendor.id,
      images: [],
      video: [],
    },
  });
  track("Product", product.id);
  const options = await Promise.all(
    names.map((name) =>
      prisma.productOption.create({
        data: { productId: product.id, name, price: 100, isActive: true },
      }),
    ),
  );
  for (const o of options) track("ProductOption", o.id);
  return { productId: product.id, vendorId: vendor.id, options };
}

async function countGroupsForProduct(productId: string, name = MIGRATION_GROUP_NAME) {
  return prisma.optionGroup.count({
    where: { productId, name },
  });
}

async function constraintExists() {
  const rows = await prisma.$queryRawUnsafe<{ indexname: string }[]>(
    `SELECT indexname FROM pg_indexes WHERE tablename = 'OptionGroup' AND indexname = 'OptionGroup_productId_name_key'`,
  );
  return rows.length > 0;
}

async function dropConstraintIfPresent() {
  await prisma.$executeRawUnsafe(`DROP INDEX IF EXISTS "OptionGroup_productId_name_key"`);
}

async function applyConstraintMigration() {
  await dropConstraintIfPresent();
  await prisma.$executeRawUnsafe(DO_BLOCK);
  await prisma.$executeRawUnsafe(CREATE_INDEX);
}

/* ── F-1 follow-up: the normalized (expression) unique index ───────────── */

const NORMALIZED_MIGRATION_SQL = readFileSync(
  join(
    __dirname,
    "..",
    "..",
    "prisma",
    "migrations",
    "20261020000000_option_group_normalized_name_unique",
    "migration.sql",
  ),
  "utf8",
);

// Same split as above: Prisma's $executeRawUnsafe cannot run several
// commands in one prepared statement.
const normalizedBlockIdx = NORMALIZED_MIGRATION_SQL.indexOf(DO_BLOCK_END);
const NORMALIZED_DO_BLOCK = NORMALIZED_MIGRATION_SQL.slice(0, normalizedBlockIdx + DO_BLOCK_END.length);
const NORMALIZED_CREATE_INDEX = NORMALIZED_MIGRATION_SQL.slice(normalizedBlockIdx + DO_BLOCK_END.length).trim();

async function normalizedIndexExists() {
  const rows = await prisma.$queryRawUnsafe<{ indexname: string }[]>(
    `SELECT indexname FROM pg_indexes WHERE tablename = 'OptionGroup' AND indexname = 'OptionGroup_productId_name_lower_key'`,
  );
  return rows.length > 0;
}

async function dropNormalizedIndexIfPresent() {
  await prisma.$executeRawUnsafe(`DROP INDEX IF EXISTS "OptionGroup_productId_name_lower_key"`);
}

async function applyNormalizedIndexMigration() {
  await dropNormalizedIndexIfPresent();
  await prisma.$executeRawUnsafe(NORMALIZED_DO_BLOCK);
  await prisma.$executeRawUnsafe(NORMALIZED_CREATE_INDEX);
}

/* ── F-2 follow-up: the normalized OptionGroupItem name index ─────────────── */

const ITEM_NORMALIZED_MIGRATION_SQL = readFileSync(
  join(
    __dirname,
    "..",
    "..",
    "prisma",
    "migrations",
    "20261021000000_option_group_item_normalized_name_unique",
    "migration.sql",
  ),
  "utf8",
);

const itemNormalizedBlockIdx = ITEM_NORMALIZED_MIGRATION_SQL.indexOf(DO_BLOCK_END);
const ITEM_NORMALIZED_DO_BLOCK = ITEM_NORMALIZED_MIGRATION_SQL.slice(
  0,
  itemNormalizedBlockIdx + DO_BLOCK_END.length,
);
const ITEM_NORMALIZED_CREATE_INDEX = ITEM_NORMALIZED_MIGRATION_SQL.slice(
  itemNormalizedBlockIdx + DO_BLOCK_END.length,
).trim();

async function itemNormalizedIndexExists() {
  const rows = await prisma.$queryRawUnsafe<{ indexname: string }[]>(
    `SELECT indexname FROM pg_indexes WHERE tablename = 'OptionGroupItem' AND indexname = 'OptionGroupItem_optionGroupId_name_lower_key'`,
  );
  return rows.length > 0;
}

async function dropItemNormalizedIndexIfPresent() {
  await prisma.$executeRawUnsafe(
    `DROP INDEX IF EXISTS "OptionGroupItem_optionGroupId_name_lower_key"`,
  );
}

async function applyItemNormalizedIndexMigration() {
  await dropItemNormalizedIndexIfPresent();
  await prisma.$executeRawUnsafe(ITEM_NORMALIZED_DO_BLOCK);
  await prisma.$executeRawUnsafe(ITEM_NORMALIZED_CREATE_INDEX);
}

/**
 * Index-state management.
 *
 * The three name indexes are OWNED BY THE MIGRATION CHAIN (20261018000000 and
 * 20261020000000 for OptionGroup, 20261021000000 for OptionGroupItem). The
 * test database is created by `prisma migrate deploy`, so `_prisma_migrations`
 * records them as applied. A test that DROPS one of them and leaves it dropped
 * leaves the database without a uniqueness guarantee that its own migration
 * history claims exists — and `prisma migrate deploy` will NOT recreate it,
 * because the migration is not pending.
 *
 * So the index state is managed explicitly:
 *   - a describe that needs an index ABSENT drops it deliberately, and says so;
 *   - a describe that needs it PRESENT ensures it;
 *   - the root teardown restores ALL of them and fails loudly if it cannot.
 *
 * Note the check is by index NAME and the CREATE is guarded by existence, not
 * by `IF NOT EXISTS`: PostgreSQL documents that IF NOT EXISTS matches on the
 * relation name only, with "no guarantee that the existing index is anything
 * like the one that would have been created". Existence is therefore verified
 * against pg_indexes and the index is re-created only when it is genuinely
 * absent.
 */

/** Drops every migration-owned name index. */
async function dropAllMigrationIndexes() {
  await dropConstraintIfPresent();
  await dropNormalizedIndexIfPresent();
  await dropItemNormalizedIndexIfPresent();
}

/** Creates the exact-match index if it is absent. Throws if it cannot. */
async function ensureExactIndex() {
  if (await constraintExists()) return;
  await prisma.$executeRawUnsafe(DO_BLOCK);
  await prisma.$executeRawUnsafe(CREATE_INDEX);
  if (!(await constraintExists())) {
    throw new Error("failed to restore the exact-match OptionGroup name index");
  }
}

/** Creates the normalized expression index if it is absent. Throws if it cannot. */
async function ensureNormalizedIndex() {
  if (await normalizedIndexExists()) return;
  await prisma.$executeRawUnsafe(NORMALIZED_DO_BLOCK);
  await prisma.$executeRawUnsafe(NORMALIZED_CREATE_INDEX);
  if (!(await normalizedIndexExists())) {
    throw new Error("failed to restore the normalized OptionGroup name index");
  }
}

/** Creates the normalized OptionGroupItem index if absent. Throws if it cannot. */
async function ensureItemNormalizedIndex() {
  if (await itemNormalizedIndexExists()) return;
  await prisma.$executeRawUnsafe(ITEM_NORMALIZED_DO_BLOCK);
  await prisma.$executeRawUnsafe(ITEM_NORMALIZED_CREATE_INDEX);
  if (!(await itemNormalizedIndexExists())) {
    throw new Error("failed to restore the normalized OptionGroupItem name index");
  }
}

/** Restores the full migrated index state. Throws on failure. */
async function ensureMigrationIndexes() {
  await ensureExactIndex();
  await ensureNormalizedIndex();
  await ensureItemNormalizedIndex();
}

/* ── A. Unique constraint ─────────────────────────────────────────── */

describe("A — OptionGroup (productId, name) unique constraint", () => {
  let productId: string;

  beforeAll(async () => {
    // This describe verifies the EXACT-match index in isolation, so the
    // normalized expression index is deliberately absent here. Its own
    // "case-differing names" case is only meaningful without it — the
    // normalized index is exercised separately in describe G.
    await dropAllMigrationIndexes();
    const seeded = await seedProductWithOptions("ua-", ["Alpha"]);
    productId = seeded.productId;
    await ensureExactIndex();
  });

  afterAll(async () => {
    // No index dropping here: the root teardown restores the migrated state.
    await cleanupTracked();
  });

  it("allows the first exact-name group", async () => {
    const group = await prisma.optionGroup.create({
      data: { productId, name: "Extras", required: false, minSelections: 0, maxSelections: 1, sortOrder: 0 },
    });
    track("OptionGroup", group.id);
    expect(group.productId).toBe(productId);
    expect(group.name).toBe("Extras");
  });

  it("rejects a duplicate exact (productId, name) with P2002", async () => {
    await expect(
      prisma.optionGroup.create({
        data: { productId, name: "Extras", required: false, minSelections: 0, maxSelections: 1, sortOrder: 0 },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  it("allows different names on the same product", async () => {
    const group = await prisma.optionGroup.create({
      data: { productId, name: "Size", required: false, minSelections: 0, maxSelections: 1, sortOrder: 1 },
    });
    track("OptionGroup", group.id);
    expect(group.name).toBe("Size");
  });

  it("allows the same name on a different product", async () => {
    const other = await seedProductWithOptions("ua2-", ["Beta"]);
    const group = await prisma.optionGroup.create({
      data: { productId: other.productId, name: "Extras", required: false, minSelections: 0, maxSelections: 1, sortOrder: 0 },
    });
    track("OptionGroup", group.id);
    expect(group.productId).toBe(other.productId);
    expect(group.name).toBe("Extras");
  });

  it("allows case-differing names (exact-match, not case-insensitive)", async () => {
    const group = await prisma.optionGroup.create({
      data: { productId, name: "extras", required: false, minSelections: 0, maxSelections: 1, sortOrder: 2 },
    });
    track("OptionGroup", group.id);
    expect(group.name).toBe("extras");
  });

  it("constraint is present in pg_indexes after migration SQL", async () => {
    expect(await constraintExists()).toBe(true);
  });
});

/* ── B. Migration SQL duplicate pre-check ─────────────────────────── */

describe("B — Migration SQL duplicate pre-check", () => {
  let productId: string;

  beforeAll(async () => {
    // BOTH indexes must be absent here: the fixture below inserts two groups
    // with the SAME exact name, which the exact index would reject and the
    // normalized index would also reject. Dropping only the exact index left
    // this test dependent on the previous run's teardown having removed the
    // normalized one — the order dependence this change removes.
    await dropAllMigrationIndexes();
    const seeded = await seedProductWithOptions("ub-", ["Dup"]);
    productId = seeded.productId;
    // Insert two exact-duplicate groups so the migration's DO-block pre-check
    // has something to reject. Both are TRACKED so the suite's own cleanup
    // removes them: leaving them behind would make the root teardown's
    // duplicate pre-check fail.
    const dupA = await prisma.optionGroup.create({
      data: { productId, name: "Extras", required: false, minSelections: 0, maxSelections: 1, sortOrder: 0 },
    });
    track("OptionGroup", dupA.id);
    const dupB = await prisma.optionGroup.create({
      data: { productId, name: "Extras", required: false, minSelections: 0, maxSelections: 1, sortOrder: 0 },
    });
    track("OptionGroup", dupB.id);
  });

  afterAll(async () => {
    await cleanupTracked();
  });

  it("migration SQL aborts with a clear duplicate-data error", async () => {
    await expect(prisma.$executeRawUnsafe(DO_BLOCK)).rejects.toThrow();
  });

  it("failed migration leaves no partial constraint", async () => {
    try {
      await prisma.$executeRawUnsafe(DO_BLOCK);
    } catch {
      // expected
    }
    expect(await constraintExists()).toBe(false);
  });

  it("duplicate rows still exist (nothing deleted or merged)", async () => {
    const count = await prisma.optionGroup.count({
      where: { productId, name: "Extras" },
    });
    expect(count).toBe(2);
  });

  it("migration succeeds on clean data and creates the constraint", async () => {
    // Remove the duplicates first so the pre-check passes.
    await prisma.optionGroup.deleteMany({ where: { productId, name: "Extras" } });
    await prisma.$executeRawUnsafe(DO_BLOCK);
    await prisma.$executeRawUnsafe(CREATE_INDEX);
    expect(await constraintExists()).toBe(true);
  });
});

/* ── C. Concurrent migration runs ─────────────────────────────────── */

describe("C — Concurrent migration runs (no duplicates)", () => {
  let productId: string;

  beforeAll(async () => {
    // The migrated state: both indexes present. The exact index is the
    // backstop for the identical-name race these tests exercise.
    await ensureMigrationIndexes();
    const seeded = await seedProductWithOptions("uc-", ["Alpha", "Beta", "Gamma"]);
    productId = seeded.productId;
  });

  afterAll(async () => {
    await cleanupTracked();
  });

  it("two concurrent runs produce exactly one group and no duplicate items", async () => {
    // Deterministic barrier: both runs wait here, then start together.
    let gateResolve: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      gateResolve = resolve;
    });
    const run = (d: MigrationDb) => gate.then(() => migrateProductOptions(d));

    // Launch both runs (each awaits the gate), release the gate, then await both.
    const run1 = run(db());
    const run2 = run(db());
    gateResolve();
    const results = await Promise.all([run1, run2]);

    // Both runs completed without throwing.
    expect(results).toHaveLength(2);
    expect(results.every((r) => typeof r.productsMigrated === "number")).toBe(true);

    // Final state: exactly one Extras group, exactly one item per legacy option,
    // no duplicates regardless of which run won the race.
    const groups = await countGroupsForProduct(productId, "Extras");
    expect(groups).toBe(1);

    const [group] = await prisma.optionGroup.findMany({
      where: { productId, name: "Extras" },
    });
    track("OptionGroup", group.id);
    const items = await prisma.optionGroupItem.findMany({
      where: { optionGroupId: group.id },
      orderBy: { name: "asc" },
    });
    expect(items).toHaveLength(3);
    expect(items.map((i) => i.name).sort()).toEqual(["Alpha", "Beta", "Gamma"]);

    // No duplicate names within the group.
    const names = items.map((i) => i.name);
    expect(new Set(names).size).toBe(names.length);

    // EXACTLY-ONCE INVARIANT, independent of which run won the race.
    //
    // Whichever run inserts the group first, the other observes it, recovers
    // by REUSING it, and finds the items already migrated. So across the two
    // runs the total number of items CREATED must equal the number of legacy
    // options — no run may create a second copy of anything.
    //
    // NOTE: `itemsCreated + itemsAlreadyMigrated` is deliberately NOT
    // asserted. When the two runs interleave, the loser may create the items
    // the winner had not yet written, so the two counters can legitimately sum
    // to 2N. The deterministic, schedule-independent invariant is the number
    // of CREATES, plus the persisted row count asserted above.
    const totalItemsCreated = results.reduce((n, r) => n + r.itemsCreated, 0);
    expect(totalItemsCreated).toBe(3);
    // Only one run may create the group; the other must reuse it.
    const totalGroupsCreated = results.reduce((n, r) => n + r.groupsCreated, 0);
    expect(totalGroupsCreated).toBe(1);

    // eslint-disable-next-line no-console
    console.log(
      `[C] results: ${JSON.stringify(
        results.map((r) => ({
          migrated: r.productsMigrated,
          skipped: r.productsSkipped,
          groupsCreated: r.groupsCreated,
          groupsReused: r.groupsReused,
          itemsCreated: r.itemsCreated,
          itemsAlreadyMigrated: r.itemsAlreadyMigrated,
          conflicts: r.conflicts.map((c) => c.kind),
        })),
      )}`,
    );
  });
});

/* ── D. Real P2034 contention and retry behaviour ─────────────────── */

describe("D — P2034 write-contention / retry (documented behaviour)", () => {
  let productId: string;

  beforeAll(async () => {
    await ensureMigrationIndexes();
    const seeded = await seedProductWithOptions("ud-", ["Alpha", "Beta"]);
    productId = seeded.productId;
  });

  afterAll(async () => {
    await cleanupTracked();
  });

  it("concurrent runs complete without duplicating groups or items", async () => {
    let gateResolve: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      gateResolve = resolve;
    });
    const run = (d: MigrationDb) => gate.then(() => migrateProductOptions(d));

    const run1 = run(db());
    const run2 = run(db());
    gateResolve();
    const results = await Promise.all([run1, run2]);

    expect(results).toHaveLength(2);

    const groups = await countGroupsForProduct(productId, "Extras");
    expect(groups).toBe(1);

    const [group] = await prisma.optionGroup.findMany({
      where: { productId, name: "Extras" },
    });
    track("OptionGroup", group.id);
    const items = await prisma.optionGroupItem.findMany({
      where: { optionGroupId: group.id },
    });
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.name).sort()).toEqual(["Alpha", "Beta"]);

    // EXACTLY-ONCE INVARIANT, independent of which run won the race.
    // (See the note in test C: created + alreadyMigrated may legitimately sum
    // to 2N when the runs interleave, so only the CREATES count is asserted.)
    const totalItemsCreated = results.reduce((n, r) => n + r.itemsCreated, 0);
    expect(totalItemsCreated).toBe(2);
    const totalGroupsCreated = results.reduce((n, r) => n + r.groupsCreated, 0);
    expect(totalGroupsCreated).toBe(1);

    // P2034 FINDING (evidence, not an assertion of a particular error).
    //
    // Across repeated runs of this scenario, the migration reported NO
    // unresolved conflicts: the run that lost the insert race recovered by
    // reusing the winner's group, so nothing was left for the operator.
    //
    // P2034 ("write conflict or a deadlock") was NOT observed. That is
    // expected for this query pattern: at PostgreSQL's default ReadCommitted
    // isolation, two concurrent INSERTs of the same value into a UNIQUE index
    // serialise on the index entry, and the loser receives P2002 (unique
    // violation) — which the migration handles directly via
    // GroupRaceLostError — not P2034. P2034 is a serialization/deadlock
    // failure mode that the migration's INSERT-only write pattern does not
    // reach. The bounded P2034 retry budget therefore remains covered ONLY by
    // the unit test that injects a synthetic P2034; it is NOT exercised here.
    const details = results.flatMap((r) => r.conflicts.map((c) => c.detail));
    // eslint-disable-next-line no-console
    console.log(
      `[D] results: ${JSON.stringify(
        results.map((r) => ({
          migrated: r.productsMigrated,
          skipped: r.productsSkipped,
          groupsCreated: r.groupsCreated,
          groupsReused: r.groupsReused,
          itemsCreated: r.itemsCreated,
          itemsAlreadyMigrated: r.itemsAlreadyMigrated,
          conflicts: r.conflicts.map((c) => c.kind),
        })),
      )} | conflictDetails: ${JSON.stringify(details)}`,
    );
  });
});

/* ── E. Actual rollback ───────────────────────────────────────────── */

describe("E — Transaction rollback", () => {
  let productId: string;

  beforeAll(async () => {
    await ensureMigrationIndexes();
    const seeded = await seedProductWithOptions("ue-", ["Alpha"]);
    productId = seeded.productId;
  });

  afterAll(async () => {
    await cleanupTracked();
  });

  it("a failed transaction leaves no partial writes", async () => {
    // Begin a transaction, write a group, then deliberately fail before commit.
    await prisma.$transaction(async (tx) => {
      await tx.optionGroup.create({
        data: {
          productId,
          name: "ShouldRollback",
          required: false,
          minSelections: 0,
          maxSelections: 1,
          sortOrder: 0,
        },
      });
      // Deliberate failure: insert into a non-existent table.
      await tx.$executeRawUnsafe("INSERT INTO pg_type_nonexistent (x) VALUES (1)");
    }).catch(() => {
      // expected failure
    });

    // Fresh read: the group must not exist (rolled back).
    const count = await prisma.optionGroup.count({
      where: { productId, name: "ShouldRollback" },
    });
    expect(count).toBe(0);
  });

  it("a subsequent clean transaction commits successfully", async () => {
    const group = await prisma.$transaction(async (tx) => {
      return tx.optionGroup.create({
        data: {
          productId,
          name: "CommittedGroup",
          required: false,
          minSelections: 0,
          maxSelections: 1,
          sortOrder: 0,
        },
      });
    });
    track("OptionGroup", group.id);
    const count = await prisma.optionGroup.count({
      where: { productId, name: "CommittedGroup" },
    });
    expect(count).toBe(1);
  });
});

/* ── F. Legacy data preservation ──────────────────────────────────── */

describe("F — Legacy data preservation", () => {
  let productId: string;
  let legacySnapshot: Array<{ id: string; name: string; price: number; isActive: boolean }>;

  beforeAll(async () => {
    await ensureMigrationIndexes();
    const seeded = await seedProductWithOptions("uf-", ["KeepMe", "RemoveMe"]);
    productId = seeded.productId;
    const vendorId = seeded.vendorId;
    legacySnapshot = await prisma.productOption.findMany({
      where: { productId },
      select: { id: true, name: true, price: true, isActive: true },
      orderBy: { name: "asc" },
    });
    for (const o of legacySnapshot) track("ProductOption", o.id);

    // Create legacy cart and order references that must be preserved.
    const customer = await prisma.user.create({
      data: { email: "uf-customer@example.com", name: "Customer", role: "CUSTOMER", roles: ["CUSTOMER"] },
    });
    track("User", customer.id);
    const cart = await prisma.cart.create({ data: { customerId: customer.id } });
    track("Cart", cart.id);
    const cartItem = await prisma.cartItem.create({
      data: { cartId: cart.id, productId, quantity: 1, unitPrice: 100, subtotal: 100 },
    });
    track("CartItem", cartItem.id);
    await prisma.cartItemOption.create({
      data: {
        cartItemId: cartItem.id,
        productOptionId: legacySnapshot[0].id,
        optionGroupItemId: null,
        name: legacySnapshot[0].name,
        price: legacySnapshot[0].price,
      } as never,
    });

    const order = await prisma.order.create({
      data: { customerId: customer.id, vendorId, basePrice: 100, totalPrice: 100, status: "PENDING" },
    });
    track("Order", order.id);
    const orderItem = await prisma.orderItem.create({
      data: { orderId: order.id, productId, quantity: 1, unitPrice: 100, subtotal: 100 },
    });
    track("OrderItem", orderItem.id);
    await prisma.orderItemOption.create({
      data: {
        orderItemId: orderItem.id,
        optionId: legacySnapshot[1].id,
        optionGroupItemId: null,
        name: legacySnapshot[1].name,
        price: legacySnapshot[1].price,
      } as never,
    });
  });

  afterAll(async () => {
    await cleanupTracked();
  });

  it("migration creates groups/items without touching legacy rows", async () => {
    const result = await migrateProductOptions(db());

    expect(result.productsMigrated).toBe(1);
    expect(result.conflicts).toEqual([]);

    const [group] = await prisma.optionGroup.findMany({ where: { productId, name: "Extras" } });
    track("OptionGroup", group.id);
    expect(group).toBeDefined();
    const items = await prisma.optionGroupItem.findMany({
      where: { optionGroupId: group.id },
      orderBy: { name: "asc" },
    });
    expect(items.map((i) => i.name).sort()).toEqual(["KeepMe", "RemoveMe"]);

    // Legacy rows still exist with unchanged IDs and field values.
    const after = await prisma.productOption.findMany({
      where: { productId },
      select: { id: true, name: true, price: true, isActive: true },
      orderBy: { name: "asc" },
    });
    expect(after).toHaveLength(legacySnapshot.length);
    for (const row of after) {
      const before = legacySnapshot.find((o) => o.id === row.id);
      expect(before).toBeDefined();
      expect(before!.name).toBe(row.name);
      expect(before!.price).toBe(row.price);
      expect(before!.isActive).toBe(row.isActive);
    }
  });

  it("re-running the migration does not duplicate groups or items", async () => {
    const result = await migrateProductOptions(db());

    expect(result.productsMigrated).toBe(1);
    expect(result.groupsCreated).toBe(0);
    expect(result.groupsReused).toBe(1);
    expect(result.itemsCreated).toBe(0);
    expect(result.itemsAlreadyMigrated).toBe(2);

    const groups = await countGroupsForProduct(productId, "Extras");
    expect(groups).toBe(1);

    const [group] = await prisma.optionGroup.findMany({ where: { productId, name: "Extras" } });
    track("OptionGroup", group.id);
    const items = await prisma.optionGroupItem.findMany({
      where: { optionGroupId: group.id },
    });
    expect(items).toHaveLength(2);
  });
});

/* ── G. Normalized (expression) unique index — F-1 follow-up ──────────── */
/*
 * NOT EXECUTED IN THE TASK THAT ADDED THEM. These require the disposable
 * local PostgreSQL instance and are the ONLY evidence that can establish
 * database-level uniqueness and genuine concurrent-writer safety. A mocked
 * equivalent cannot demonstrate either.
 */

describe("G — normalized OptionGroup name uniqueness (expression index)", () => {
  let productId: string;

  beforeAll(async () => {
    await ensureMigrationIndexes();
    const seeded = await seedProductWithOptions("ug-", ["Alpha"]);
    productId = seeded.productId;
  });

  afterAll(async () => {
    await cleanupTracked();
  });

  it("rejects a case-differing group name on the same product", async () => {
    await applyNormalizedIndexMigration();

    // Its own product, so this test cannot be affected by (or affect) the
    // groups another test in this describe created.
    const own = await seedProductWithOptions("ug1-", ["Alpha"]);
    const productId = own.productId;

    const first = await prisma.optionGroup.create({
      data: { productId, name: "Extras", required: false, minSelections: 0, maxSelections: 1, sortOrder: 0 },
    });
    track("OptionGroup", first.id);

    // "extras" is the SAME name to the application (trim + lowercase) but a
    // different value to the old exact-match index. The normalized index must
    // reject it.
    await expect(
      prisma.optionGroup.create({
        data: { productId, name: "extras", required: false, minSelections: 0, maxSelections: 1, sortOrder: 0 },
      }),
    ).rejects.toMatchObject({ code: "P2002" });

    const count = await prisma.optionGroup.count({ where: { productId } });
    expect(count).toBe(1);
  });

  it("rejects a whitespace-differing group name on the same product", async () => {
    await applyNormalizedIndexMigration();

    const own = await seedProductWithOptions("ug2-", ["Alpha"]);
    const productId = own.productId;

    const first = await prisma.optionGroup.create({
      data: { productId, name: "Spicy", required: false, minSelections: 0, maxSelections: 1, sortOrder: 1 },
    });
    track("OptionGroup", first.id);

    await expect(
      prisma.optionGroup.create({
        data: { productId, name: "  spicy  ", required: false, minSelections: 0, maxSelections: 1, sortOrder: 2 },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  it("two concurrent writers using normalized-equivalent names leave at most one group", async () => {
    await applyNormalizedIndexMigration();

    // Its own product, so neither writer can be pre-empted by a group an
    // earlier test in this describe already created.
    const own = await seedProductWithOptions("ug3-", ["Alpha"]);
    const productId = own.productId;

    // Two independent clients, each in its own transaction, released together
    // by a gate so the two INSERTs genuinely contend on the index entry.
    let gateResolve: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      gateResolve = resolve;
    });

    const write = async (client: PrismaClient, name: string) =>
      client.$transaction(async (tx) => {
        await gate;
        return tx.optionGroup.create({
          data: { productId, name, required: false, minSelections: 0, maxSelections: 1, sortOrder: 0 },
        });
      });

    const clientA = new PrismaClient({ datasources: { db: { url: process.env.TEST_DATABASE_URL ?? "" } } });
    const clientB = new PrismaClient({ datasources: { db: { url: process.env.TEST_DATABASE_URL ?? "" } } });

    // Start BOTH transactions first, THEN release the gate. Resolving the gate
    // only after awaiting the results deadlocks: each transaction waits on the
    // gate inside its own transaction, so neither can settle until the gate
    // opens, and the gate opens only once both have settled.
    const attemptA = write(clientA, "Extras");
    const attemptB = write(clientB, "extras");
    gateResolve();
    const settled = await Promise.allSettled([attemptA, attemptB]);

    await clientA.$disconnect();
    await clientB.$disconnect();

    // Exactly one writer may succeed.
    const fulfilled = settled.filter((s) => s.status === "fulfilled");
    const rejected = settled.filter((s) => s.status === "rejected");
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: "P2002" });

    // And the database holds exactly one group.
    const count = await prisma.optionGroup.count({ where: { productId } });
    expect(count).toBe(1);
    const [group] = await prisma.optionGroup.findMany({ where: { productId } });
    track("OptionGroup", group.id);
  });

  it("the migration pre-check rejects existing normalized duplicates without deleting or merging rows", async () => {
    // The normalized index must be ABSENT for the duplicates to be insertable
    // (that is the whole point: they are the data the index would reject).
    await dropNormalizedIndexIfPresent();
    await cleanupTracked();

    const seeded = await seedProductWithOptions("ug4-", ["Alpha"]);
    const dupProductId = seeded.productId;

    const a = await prisma.optionGroup.create({
      data: { productId: dupProductId, name: "Extras", required: false, minSelections: 0, maxSelections: 1, sortOrder: 0 },
    });
    const b = await prisma.optionGroup.create({
      data: { productId: dupProductId, name: "extras", required: false, minSelections: 0, maxSelections: 1, sortOrder: 1 },
    });
    track("OptionGroup", a.id);
    track("OptionGroup", b.id);

    // The pre-check must abort...
    await expect(prisma.$executeRawUnsafe(NORMALIZED_DO_BLOCK)).rejects.toThrow(/duplicate|already exist/i);

    // ...and must not have created the index.
    expect(await normalizedIndexExists()).toBe(false);

    // ...and must not have deleted, merged or renamed either row.
    const rows = await prisma.optionGroup.findMany({
      where: { productId: dupProductId },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    });
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.name).sort()).toEqual(["Extras", "extras"]);
  });

  it("a clean migration preserves BOTH the exact and the normalized unique indexes", async () => {
    await cleanupTracked();
    await applyConstraintMigration();
    await applyNormalizedIndexMigration();

    const rows = await prisma.$queryRawUnsafe<{ indexname: string }[]>(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'OptionGroup' AND indexname IN ('OptionGroup_productId_name_key','OptionGroup_productId_name_lower_key') ORDER BY indexname`,
    );
    expect(rows.map((r) => r.indexname)).toEqual([
      "OptionGroup_productId_name_key",
      "OptionGroup_productId_name_lower_key",
    ]);
  });
});

/* ── H. Normalized OptionGroupItem name uniqueness (expression index) ──── */
/*
 * F-2 follow-up. The item-name constraint is scoped to ONE option group:
 * the same item name in two different groups of the same product is valid
 * data and must remain allowed.
 */

describe("H — normalized OptionGroupItem name uniqueness (expression index)", () => {
  /** A product with one option group, both owned by (and tracked for cleanup by) this suite. */
  async function seedGroup(tag: string): Promise<{ productId: string; groupId: string }> {
    const vendor = await prisma.user.create({
      data: { email: `${tag}-vendor@example.com`, name: "Vendor", role: "VENDOR", roles: ["VENDOR"] },
    });
    track("User", vendor.id);
    const product = await prisma.product.create({
      data: {
        name: `${tag} product`,
        description: "item fixture",
        price: 1000,
        dishTypeId: DISH_TYPE_ID,
        categoryId: CATEGORY_ID,
        vendorId: vendor.id,
        images: [],
        video: [],
      },
    });
    track("Product", product.id);
    const group = await prisma.optionGroup.create({
      data: {
        productId: product.id,
        name: "Extras",
        required: false,
        minSelections: 0,
        maxSelections: 5,
        sortOrder: 0,
      },
    });
    track("OptionGroup", group.id);
    return { productId: product.id, groupId: group.id };
  }

  beforeAll(async () => {
    await ensureMigrationIndexes();
  });

  afterAll(async () => {
    await cleanupTracked();
  });

  it("rejects the same normalized item name twice within one group", async () => {
    const { groupId } = await seedGroup("uh1-");

    const first = await prisma.optionGroupItem.create({
      data: { optionGroupId: groupId, name: "Extra Egg", priceAdd: 500, sortOrder: 0 },
    });
    track("OptionGroupItem", first.id);

    await expect(
      prisma.optionGroupItem.create({
        data: { optionGroupId: groupId, name: "Extra Egg", priceAdd: 700, sortOrder: 1 },
      }),
    ).rejects.toMatchObject({ code: "P2002" });

    expect(await prisma.optionGroupItem.count({ where: { optionGroupId: groupId } })).toBe(1);
  });

  it("rejects case-only and ordinary-whitespace variants within one group", async () => {
    const { groupId } = await seedGroup("uh2-");

    const first = await prisma.optionGroupItem.create({
      data: { optionGroupId: groupId, name: "Extra Egg", priceAdd: 500, sortOrder: 0 },
    });
    track("OptionGroupItem", first.id);

    // Case-only variant.
    await expect(
      prisma.optionGroupItem.create({
        data: { optionGroupId: groupId, name: "extra egg", priceAdd: 700, sortOrder: 1 },
      }),
    ).rejects.toMatchObject({ code: "P2002" });

    // Ordinary surrounding-whitespace variant (PostgreSQL btrim removes spaces).
    await expect(
      prisma.optionGroupItem.create({
        data: { optionGroupId: groupId, name: "  Extra Egg  ", priceAdd: 700, sortOrder: 2 },
      }),
    ).rejects.toMatchObject({ code: "P2002" });

    expect(await prisma.optionGroupItem.count({ where: { optionGroupId: groupId } })).toBe(1);
  });

  it("two concurrent writers with normalized-equivalent names leave exactly one item", async () => {
    const { groupId } = await seedGroup("uh3-");

    let gateResolve: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      gateResolve = resolve;
    });
    const write = async (client: PrismaClient, name: string) =>
      client.$transaction(async (tx) => {
        await gate;
        return tx.optionGroupItem.create({
          data: { optionGroupId: groupId, name, priceAdd: 500, sortOrder: 0 },
        });
      });

    const clientA = new PrismaClient({ datasources: { db: { url: process.env.TEST_DATABASE_URL ?? "" } } });
    const clientB = new PrismaClient({ datasources: { db: { url: process.env.TEST_DATABASE_URL ?? "" } } });

    // Start BOTH transactions first, THEN release the gate, then await. Awaiting
    // before releasing the gate deadlocks: each transaction waits on the gate
    // inside its own transaction, so neither can settle until it opens.
    const attemptA = write(clientA, "Extra Egg");
    const attemptB = write(clientB, "extra egg");
    gateResolve();
    const settled = await Promise.allSettled([attemptA, attemptB]);

    await clientA.$disconnect();
    await clientB.$disconnect();

    const fulfilled = settled.filter((s) => s.status === "fulfilled");
    const rejected = settled.filter((s) => s.status === "rejected");
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: "P2002" });

    // Exactly one item persisted.
    const items = await prisma.optionGroupItem.findMany({ where: { optionGroupId: groupId } });
    expect(items).toHaveLength(1);
    track("OptionGroupItem", items[0].id);
  });

  it("the migration pre-check rejects normalized duplicates without changing rows", async () => {
    // The index must be ABSENT for the duplicates to be insertable — that is
    // the whole point: they are the data the index would reject.
    await dropItemNormalizedIndexIfPresent();
    await cleanupTracked();

    const { groupId } = await seedGroup("uh4-");
    const a = await prisma.optionGroupItem.create({
      data: { optionGroupId: groupId, name: "Extra Egg", priceAdd: 500, sortOrder: 0 },
    });
    const b = await prisma.optionGroupItem.create({
      data: { optionGroupId: groupId, name: "extra egg", priceAdd: 700, sortOrder: 1 },
    });
    track("OptionGroupItem", a.id);
    track("OptionGroupItem", b.id);

    // The pre-check must abort...
    await expect(prisma.$executeRawUnsafe(ITEM_NORMALIZED_DO_BLOCK)).rejects.toThrow(
      /duplicate|already exist/i,
    );

    // ...and must not have created the index.
    expect(await itemNormalizedIndexExists()).toBe(false);

    // ...and must not have deleted, merged or renamed either row.
    const rows = await prisma.optionGroupItem.findMany({
      where: { optionGroupId: groupId },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    });
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.name).sort()).toEqual(["Extra Egg", "extra egg"]);
  });

  it("identical item names in different groups of one product remain allowed", async () => {
    const { productId } = await seedGroup("uh6-");

    const groupA = await prisma.optionGroup.create({
      data: { productId, name: "Size", required: false, minSelections: 0, maxSelections: 5, sortOrder: 1 },
    });
    track("OptionGroup", groupA.id);
    const groupB = await prisma.optionGroup.create({
      data: { productId, name: "Protein", required: false, minSelections: 0, maxSelections: 5, sortOrder: 2 },
    });
    track("OptionGroup", groupB.id);

    // The SAME item name in two different groups is valid data.
    const itemA = await prisma.optionGroupItem.create({
      data: { optionGroupId: groupA.id, name: "Cheese", priceAdd: 100, sortOrder: 0 },
    });
    const itemB = await prisma.optionGroupItem.create({
      data: { optionGroupId: groupB.id, name: "Cheese", priceAdd: 200, sortOrder: 0 },
    });
    track("OptionGroupItem", itemA.id);
    track("OptionGroupItem", itemB.id);

    expect(itemA).toBeDefined();
    expect(itemB).toBeDefined();
    expect(await prisma.optionGroupItem.count({ where: { name: "Cheese" } })).toBe(2);
  });

  it("a clean migration leaves both OptionGroup indexes and the item index present", async () => {
    await cleanupTracked();
    await applyConstraintMigration();
    await applyNormalizedIndexMigration();
    await applyItemNormalizedIndexMigration();

    const rows = await prisma.$queryRawUnsafe<{ indexname: string }[]>(
      `SELECT indexname FROM pg_indexes
        WHERE (tablename = 'OptionGroup' AND indexname IN ('OptionGroup_productId_name_key','OptionGroup_productId_name_lower_key'))
           OR (tablename = 'OptionGroupItem' AND indexname = 'OptionGroupItem_optionGroupId_name_lower_key')
        ORDER BY indexname`,
    );
    expect(rows.map((r) => r.indexname)).toEqual([
      "OptionGroupItem_optionGroupId_name_lower_key",
      "OptionGroup_productId_name_key",
      "OptionGroup_productId_name_lower_key",
    ]);
  });
});
