/**
 * Phase 2B.2 — ProductOption → OptionGroup migration logic.
 *
 * In-memory fake DB (no live database required, no PrismaClient instantiated).
 *
 * LIMITATION, stated plainly: the fake's `$transaction` is a pass-through, so
 * these tests prove APPLICATION logic only. They do NOT prove PostgreSQL
 * transaction isolation, unique-constraint enforcement, or that two genuinely
 * concurrent runs cannot both insert a group. That guarantee lives in the
 * database (the new `@@unique([productId, name])`) and requires a real
 * PostgreSQL test before it can be claimed as verified.
 */
import {
  migrateProductOptions,
  preflightProductOptionMigration,
  planProductMigration,
  hasUnresolvedConflicts,
  MIGRATION_GROUP_NAME,
  LEGACY_MIGRATION_GROUP_NAME,
  MAX_TRANSACTION_ATTEMPTS,
  type MigrationDb,
} from "../../src/services/productOptionMigration";
import { normalizeOptionName } from "../../src/services/optionName";
import {
  MIGRATION_GROUP_NAME as SHARED_GROUP_NAME,
  LEGACY_MIGRATION_GROUP_NAME as SHARED_LEGACY_GROUP_NAME,
} from "../../src/services/migrationGroupNames";
import { MIGRATED_GROUP_NAME } from "../../src/services/optionMigrationState";

interface LegacyOption {
  id: string;
  productId: string;
  name: string;
  price: number;
  isActive: boolean;
}
interface Group {
  id: string;
  productId: string;
  name: string;
  required: boolean;
  minSelections: number;
  maxSelections: number;
  sortOrder: number;
}
interface Item {
  id: string;
  optionGroupId: string;
  name: string;
  priceAdd: number;
  isActive: boolean;
}

interface FakeStore {
  products: Array<{ id: string }>;
  options: LegacyOption[];
  groups: Group[];
  items: Item[];
}

const matches = (row: Record<string, unknown>, where: Record<string, unknown> | undefined) =>
  Object.entries(where ?? {}).every(([k, v]) => (row as Record<string, unknown>)[k] === v);

function fakeDb(
  seed: { products?: string[]; options?: LegacyOption[]; groups?: Group[]; items?: Item[] } = {},
) {
  const products = (seed.products ?? []).map((id) => ({ id }));
  const options: LegacyOption[] = [...(seed.options ?? [])];
  const groups: Group[] = [...(seed.groups ?? [])];
  const items: Item[] = [...(seed.items ?? [])];
  let seq = 0;

  const api: Record<string, any> = {
    product: { findMany: async () => products.map((p) => ({ id: p.id })) },
    productOption: {
      findMany: async (args?: { where?: Record<string, unknown> }) =>
        options
          .filter((o) => matches(o as unknown as Record<string, unknown>, args?.where))
          .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : 1)),
      count: async (args?: { where?: Record<string, unknown> }) =>
        args?.where
          ? options.filter((o) => matches(o as unknown as Record<string, unknown>, args.where)).length
          : options.length,
    },
    cartItemOption: { count: async () => 0 },
    orderItemOption: { count: async () => 0 },
    optionGroup: {
      findMany: async (args?: { where?: Record<string, unknown> }) =>
        groups.filter((g) => matches(g as unknown as Record<string, unknown>, args?.where)),
      create: async (args: { data: Omit<Group, "id"> }) => {
        // Exact (@@unique([productId, name])) — case-sensitive, matching the real
        // index. Never case-insensitive: the real schema does not enforce that.
        const existing = groups.find(
          (g) => g.productId === args.data.productId && g.name === args.data.name,
        );
        if (existing) {
          const err: any = new Error(
            'Unique constraint failed on the `OptionGroup`(`productId`, `name`)',
          );
          err.name = "PrismaClientKnownRequestError";
          err.code = "P2002";
          err.meta = { target: ["productId", "name"] };
          throw err;
        }
        const g = { ...args.data, id: `group-${++seq}` };
        groups.push(g);
        return { id: g.id };
      },
    },
    optionGroupItem: {
      findMany: async (args?: { where?: Record<string, unknown> }) =>
        items.filter((i) => matches(i as unknown as Record<string, unknown>, args?.where)),
      create: async (args: { data: Omit<Item, "id"> }) => {
        const it = { ...args.data, id: `item-${++seq}` };
        items.push(it);
        return { id: it.id };
      },
    },
    $transaction: async (cb: (tx: unknown) => Promise<unknown>) => {
      // ROLLBACK SIMULATION (Phase 2B.2 review F-7).
      //
      // This snapshots the mutable collections and restores them if the
      // callback throws, so a test can assert that a failed product leaves no
      // partial group/item rows behind.
      //
      // THIS IS A SIMULATION, NOT PROOF. It only demonstrates that the
      // production code's control flow does not swallow the error and continue
      // writing. Real rollback is a PostgreSQL guarantee that only the
      // separately-authorized integration test can establish. A unit test here
      // must never be cited as evidence that transactions roll back for real.
      const groupsSnapshot = groups.map((g) => ({ ...g }));
      const itemsSnapshot = items.map((i) => ({ ...i }));
      const seqSnapshot = seq;
      try {
        return await cb(api);
      } catch (err) {
        groups.length = 0;
        groups.push(...groupsSnapshot);
        items.length = 0;
        items.push(...itemsSnapshot);
        seq = seqSnapshot;
        throw err;
      }
    },
    __store: { products, options, groups, items } satisfies FakeStore,
  };
  return api as unknown as MigrationDb & { __store: FakeStore };
}

const db = (seed?: Parameters<typeof fakeDb>[0]) => fakeDb(seed);

const OPT = (
  productId: string,
  name: string,
  price: number,
  isActive = true,
  id = `opt-${productId}-${name}`,
): LegacyOption => ({ id, productId, name, price, isActive });

const GROUP = (
  productId: string,
  name: string,
  overrides: Partial<Group> = {},
): Group => ({
  id: overrides.id ?? `g-${productId}-${name}`,
  productId,
  name,
  required: false,
  minSelections: 0,
  maxSelections: 1,
  sortOrder: 0,
  ...overrides,
});

describe("preflight", () => {
  it("reports empty datasets as clean", async () => {
    await expect(preflightProductOptionMigration(db())).resolves.toMatchObject({
      products: 0,
      productOptions: 0,
      orphanOptions: 0,
      duplicateNames: 0,
      legacyNamedGroups: 0,
      standardNamedGroups: 0,
    });
  });

  it("counts legacy-named and standard-named groups separately", async () => {
    const d = db({
      products: ["p1"],
      groups: [GROUP("p1", "Add-ons"), GROUP("p1", "Size"), GROUP("p2", "Extras")],
    });
    const pre = await preflightProductOptionMigration(d);
    expect(pre.legacyNamedGroups).toBe(1);
    expect(pre.standardNamedGroups).toBe(1);
  });
});

describe("B1 — standard group name is Extras", () => {
  it('MIGRATION_GROUP_NAME is "Extras", not "Add-ons"', () => {
    expect(MIGRATION_GROUP_NAME).toBe("Extras");
    expect(LEGACY_MIGRATION_GROUP_NAME).toBe("Add-ons");
  });

  it("both consumers resolve to the one shared definition", () => {
    // F-2.8: the literal is defined once in `migrationGroupNames.ts`. The
    // migration module re-exports it and the state module aliases it as
    // MIGRATED_GROUP_NAME; all three references must stay identical.
    expect(MIGRATION_GROUP_NAME).toBe(SHARED_GROUP_NAME);
    expect(LEGACY_MIGRATION_GROUP_NAME).toBe(SHARED_LEGACY_GROUP_NAME);
    expect(MIGRATED_GROUP_NAME).toBe(SHARED_GROUP_NAME);
  });

  it("checks the standard name before the legacy name when both exist", async () => {
    // Matching order is part of the existing behaviour: a standard "Extras"
    // group wins, and the leftover "Add-ons" group never triggers the
    // legacy-name conflict once a standard group exists.
    const d = db({
      products: ["pA"],
      options: [OPT("pA", "Opt1", 100)],
      groups: [GROUP("pA", "Extras", { maxSelections: 1 }), GROUP("pA", "Add-ons")],
    });
    const result = await migrateProductOptions(d);
    expect(result.groupsReused).toBe(1);
    expect(result.groupsCreated).toBe(0);
    expect(result.conflicts).toEqual([]);
    expect(d.__store.items.filter((i) => i.optionGroupId === "g-pA-Extras")).toHaveLength(1);
    // The legacy group is never written or deleted.
    expect(d.__store.groups.filter((g) => g.name === "Add-ons")).toHaveLength(1);
  });

  it("creates an Extras group with 1:1 fidelity for every legacy option", async () => {
    const d = db({ products: ["pA"], options: [OPT("pA", "Opt1", 100), OPT("pA", "Opt2", 500), OPT("pA", "Opt3", 1000, false)] });
    const result = await migrateProductOptions(d);

    expect(result.productsMigrated).toBe(1);
    expect(result.groupsCreated).toBe(1);
    expect(result.itemsCreated).toBe(3);
    expect(result.conflicts).toEqual([]);

    const [group] = d.__store.groups;
    expect(group).toMatchObject({
      productId: "pA",
      name: "Extras",
      required: false,
      minSelections: 0,
      maxSelections: 3,
      sortOrder: 0,
    });
    const byName = new Map<string, Item>(d.__store.items.map((i) => [i.name, i] as const));
    expect(byName.get("Opt1")).toMatchObject({ priceAdd: 100, isActive: true });
    expect(byName.get("Opt3")).toMatchObject({ priceAdd: 1000, isActive: false });
    // New ids, never reusing legacy ids.
    for (const item of d.__store.items) expect(item.id).not.toMatch(/^opt-/);
    // Legacy rows untouched.
    expect(d.__store.options).toHaveLength(3);
  });

  it("detects an existing legacy 'Add-ons' group and refuses to duplicate it", async () => {
    const d = db({
      products: ["pA"],
      options: [OPT("pA", "Opt1", 100)],
      groups: [GROUP("pA", "Add-ons")],
    });
    const result = await migrateProductOptions(d);
    expect(result.productsSkipped).toBe(1);
    expect(result.conflicts[0].kind).toBe("LEGACY_GROUP_NAME");
    expect(result.conflicts[0].detail).toContain("Add-ons");
    // Nothing was created under the new name.
    expect(d.__store.groups.filter((g) => g.name === "Extras")).toHaveLength(0);
    expect(d.__store.items).toHaveLength(0);
  });
});

describe("B4 — dry run shares the planning path with apply", () => {
  it("dry run makes no writes", async () => {
    const d = db({ products: ["pA"], options: [OPT("pA", "Opt1", 100), OPT("pA", "Opt2", 500)] });
    const before = JSON.stringify(d.__store);
    const preview = await migrateProductOptions(d, { dryRun: true });
    expect(JSON.stringify(d.__store)).toBe(before);
    expect(preview.dryRun).toBe(true);
    expect(preview.itemsCreated).toBe(2);
  });

  it("dry run reports the same conflicts as the equivalent apply", async () => {
    const seed = {
      products: ["pA", "pB"],
      options: [OPT("pA", "Opt1", 100), OPT("pB", "Opt1", 100)],
      groups: [GROUP("pB", "Add-ons")],
    };
    const preview = await migrateProductOptions(db(seed), { dryRun: true });
    const applied = await migrateProductOptions(db(seed));

    expect(preview.productsSkipped).toBe(applied.productsSkipped);
    expect(preview.groupsCreated).toBe(applied.groupsCreated);
    expect(preview.itemsCreated).toBe(applied.itemsCreated);
    expect(preview.conflicts.map((c) => c.kind)).toEqual(applied.conflicts.map((c) => c.kind));
  });

  it("dry run distinguishes already-migrated from to-be-created items", async () => {
    const d = db({
      products: ["pA"],
      options: [OPT("pA", "Opt1", 100), OPT("pA", "Opt2", 500)],
      groups: [GROUP("pA", "Extras", { maxSelections: 2 })],
      items: [{ id: "it-1", optionGroupId: "g-pA-Extras", name: "Opt1", priceAdd: 100, isActive: true }],
    });
    const preview = await migrateProductOptions(d, { dryRun: true });
    expect(preview.groupsReused).toBe(1);
    expect(preview.itemsAlreadyMigrated).toBe(1);
    expect(preview.itemsCreated).toBe(1);
  });
});

describe("B2 — group lookup and conflict policy", () => {
  it("reuses a compatible Extras group", async () => {
    const d = db({
      products: ["pA"],
      options: [OPT("pA", "Opt1", 100)],
      groups: [GROUP("pA", "Extras", { maxSelections: 1 })],
    });
    const result = await migrateProductOptions(d);
    expect(result.groupsReused).toBe(1);
    expect(result.groupsCreated).toBe(0);
    expect(result.itemsCreated).toBe(1);
  });

  it("conflicts on an incompatible Extras group and never rewrites its settings", async () => {
    const existing = GROUP("pA", "Extras", { required: true, minSelections: 1, maxSelections: 1 });
    const d = db({ products: ["pA"], options: [OPT("pA", "Opt1", 100)], groups: [existing] });
    const result = await migrateProductOptions(d);
    expect(result.conflicts[0].kind).toBe("GROUP_CONFLICT");
    expect(d.__store.groups[0]).toMatchObject({ required: true, minSelections: 1 });
  });

  it("conflicts when multiple Extras groups exist and does not guess which is authoritative", async () => {
    const d = db({
      products: ["pA"],
      options: [OPT("pA", "Opt1", 100)],
      groups: [GROUP("pA", "Extras", { id: "g1", maxSelections: 1 }), GROUP("pA", "extras", { id: "g2", maxSelections: 1 })],
    });
    const result = await migrateProductOptions(d);
    expect(result.conflicts[0].kind).toBe("GROUP_DUPLICATE");
    expect(d.__store.items).toHaveLength(0);
  });

  it("unrelated groups (Size, Spice Level) do not block creating Extras", async () => {
    const d = db({
      products: ["pA"],
      options: [OPT("pA", "Opt1", 100)],
      groups: [GROUP("pA", "Size"), GROUP("pA", "Spice Level")],
    });
    const result = await migrateProductOptions(d);
    expect(result.conflicts).toEqual([]);
    expect(result.groupsCreated).toBe(1);
    expect(d.__store.groups.some((g) => g.name === "Extras")).toBe(true);
  });
});

describe("N1 — normalized item matching", () => {
  it("matches an existing item whose name differs only by case/whitespace", async () => {
    const d = db({
      products: ["pA"],
      options: [OPT("pA", "Extra Egg", 500)],
      groups: [GROUP("pA", "Extras", { maxSelections: 1 })],
      items: [{ id: "it-1", optionGroupId: "g-pA-Extras", name: "  extra egg  ", priceAdd: 500, isActive: true }],
    });
    const result = await migrateProductOptions(d);
    expect(result.conflicts).toEqual([]);
    expect(result.itemsCreated).toBe(0);
    expect(result.itemsAlreadyMigrated).toBe(1);
    // No duplicate item was created.
    expect(d.__store.items).toHaveLength(1);
  });

  it("reports a conflict when two existing items normalize to the same name", async () => {
    const d = db({
      products: ["pA"],
      options: [OPT("pA", "Extra Egg", 500)],
      groups: [GROUP("pA", "Extras", { maxSelections: 1 })],
      items: [
        { id: "it-1", optionGroupId: "g-pA-Extras", name: "Extra Egg", priceAdd: 500, isActive: true },
        { id: "it-2", optionGroupId: "g-pA-Extras", name: "extra egg", priceAdd: 600, isActive: true },
      ],
    });
    const result = await migrateProductOptions(d);
    expect(result.conflicts.some((c) => c.kind === "ITEM_AMBIGUOUS")).toBe(true);
    expect(d.__store.items).toHaveLength(2);
  });

  it("reports a conflict when two legacy options normalize to the same name", async () => {
    const d = db({ products: ["pA"], options: [OPT("pA", "Extra Egg", 500), OPT("pA", "extra egg", 600)] });
    const result = await migrateProductOptions(d);
    expect(result.conflicts.some((c) => c.kind === "ITEM_AMBIGUOUS")).toBe(true);
    expect(d.__store.items).toHaveLength(0);
  });
});

describe("item fidelity and mismatch handling", () => {
  it("reports an item mismatch and never overwrites existing data", async () => {
    const d = db({
      products: ["pA"],
      options: [OPT("pA", "Opt1", 100)],
      groups: [GROUP("pA", "Extras", { maxSelections: 1 })],
      items: [{ id: "it-1", optionGroupId: "g-pA-Extras", name: "Opt1", priceAdd: 999, isActive: true }],
    });
    const result = await migrateProductOptions(d);
    expect(result.conflicts.some((c) => c.kind === "ITEM_MISMATCH")).toBe(true);
    expect(d.__store.items[0].priceAdd).toBe(999);
  });

  it("copies price 1:1 with no conversion and preserves isActive", async () => {
    const d = db({ products: ["pA"], options: [OPT("pA", "A", 2000.55), OPT("pA", "B", 0, false)] });
    await migrateProductOptions(d);
    const byName = new Map<string, Item>(d.__store.items.map((i) => [i.name, i] as const));
    expect(byName.get("A")!.priceAdd).toBe(2000.55);
    expect(byName.get("B")!.isActive).toBe(false);
  });
});

describe("N2 — maxSelections policy", () => {
  it("counts every migrated legacy option, including inactive ones", async () => {
    const d = db({ products: ["pA"], options: [OPT("pA", "A", 100), OPT("pA", "B", 200, false), OPT("pA", "C", 300, false)] });
    await migrateProductOptions(d);
    expect(d.__store.groups[0].maxSelections).toBe(3);
    expect(d.__store.groups[0].required).toBe(false);
    expect(d.__store.groups[0].minSelections).toBe(0);
  });
});

describe("idempotency and historical safety", () => {
  it("reruns create nothing and change nothing", async () => {
    const d = db({ products: ["pA"], options: [OPT("pA", "Opt1", 100), OPT("pA", "Opt2", 500)] });
    const first = await migrateProductOptions(d);
    expect(first.itemsCreated).toBe(2);
    const snapshot = JSON.stringify(d.__store);

    const second = await migrateProductOptions(d);
    expect(second.groupsCreated).toBe(0);
    expect(second.itemsCreated).toBe(0);
    expect(second.groupsReused).toBe(1);
    expect(second.itemsAlreadyMigrated).toBe(2);
    expect(second.conflicts).toEqual([]);
    expect(JSON.stringify(d.__store)).toBe(snapshot);
  });

  it("never changes legacy ids, cart/order references, or snapshots", async () => {
    const legacy = [OPT("pA", "Opt1", 500, true, "legacy-id-1")];
    const d = db({ products: ["pA"], options: legacy });
    const before = JSON.stringify(d.__store.options);
    await migrateProductOptions(d);
    await migrateProductOptions(d);
    expect(JSON.stringify(d.__store.options)).toBe(before);
    expect(d.__store.options[0].id).toBe("legacy-id-1");
  });

  it("gives each product its own independent group", async () => {
    const d = db({ products: ["pA", "pB"], options: [OPT("pA", "Same", 100), OPT("pB", "Same", 200)] });
    const result = await migrateProductOptions(d);
    expect(result.groupsCreated).toBe(2);
    expect(d.__store.groups.filter((g) => g.productId === "pA")).toHaveLength(1);
    expect(d.__store.groups.filter((g) => g.productId === "pB")).toHaveLength(1);
  });
});

describe("transaction failure isolation", () => {
  it("a failing product does not corrupt another product", async () => {
    const d = db({ products: ["pA", "pB"], options: [OPT("pA", "A", 100), OPT("pB", "B", 200)] });
    // Make pA's item creation fail via a throw in the fake.
    const items = (d as unknown as { optionGroupItem: { create: (a: { data: { name: string } }) => Promise<unknown> } }).optionGroupItem;
    const originalCreate = items.create.bind(items);
    items.create = async (args) => {
      if (args.data.name === "A") throw new Error("boom");
      return originalCreate(args);
    };
    const result = await migrateProductOptions(d);
    expect(result.productsMigrated).toBe(1);
    expect(result.productsSkipped).toBe(1);
    expect(result.conflicts[0].kind).toBe("TRANSACTION_FAILED");
    // pB still committed.
    expect(d.__store.groups.some((g) => g.productId === "pB")).toBe(true);
  });

  it("review F-7: the failed product leaves NO partial group or item behind", async () => {
    const d = db({ products: ["pA", "pB"], options: [OPT("pA", "A", 100), OPT("pB", "B", 200)] });
    const items = (d as unknown as { optionGroupItem: { create: (a: { data: { name: string } }) => Promise<unknown> } }).optionGroupItem;
    const originalCreate = items.create.bind(items);
    items.create = async (args) => {
      if (args.data.name === "A") throw new Error("boom");
      return originalCreate(args);
    };
    await migrateProductOptions(d);

    // pA's group is created BEFORE its item write, so without rollback it would
    // survive as an empty orphan group. Asserting its absence is what makes this
    // test meaningful — see the rollback-simulation caveat in fakeDb.
    expect(d.__store.groups.filter((g) => g.productId === "pA")).toHaveLength(0);
    expect(d.__store.items.filter((i) => i.name === "A")).toHaveLength(0);
    // And the healthy product is untouched.
    expect(d.__store.groups.filter((g) => g.productId === "pB")).toHaveLength(1);
    expect(d.__store.items.filter((i) => i.name === "B")).toHaveLength(1);
  });

  it("a failure after some items were created discards those items too", async () => {
    const d = db({
      products: ["pA"],
      options: [OPT("pA", "A", 100), OPT("pA", "B", 200), OPT("pA", "C", 300)],
    });
    const items = (d as unknown as { optionGroupItem: { create: (a: { data: { name: string } }) => Promise<unknown> } }).optionGroupItem;
    const originalCreate = items.create.bind(items);
    items.create = async (args) => {
      // Fail on the SECOND item, after the first has already been written.
      if (args.data.name === "B") throw new Error("boom");
      return originalCreate(args);
    };
    await migrateProductOptions(d);
    expect(d.__store.items).toHaveLength(0);
    expect(d.__store.groups).toHaveLength(0);
  });
});

/**
 * Phase 2B.2 review F-3 — retry policy.
 *
 * Prisma v6 documents P2034 as "Transaction failed due to a write conflict or a
 * deadlock. Please retry your transaction." Only P2034 is retried, and only
 * because `applyProductPlan` RE-PLANS inside each fresh transaction, which is
 * what makes a retry idempotent rather than duplicating rows.
 *
 * These tests drive the retry through the fake; they do NOT prove PostgreSQL
 * produces P2034 under contention.
 */
describe("P2034 retry policy", () => {
  const p2034 = () =>
    Object.assign(new Error("Transaction failed due to a write conflict"), {
      name: "PrismaClientKnownRequestError",
      code: "P2034",
    });

  const withFailingCreate = (d: ReturnType<typeof db>, failFor: number, error: () => Error) => {
    const items = (d as unknown as {
      optionGroupItem: { create: (a: { data: { name: string } }) => Promise<unknown> };
    }).optionGroupItem;
    const originalCreate = items.create.bind(items);
    let calls = 0;
    items.create = async (args) => {
      calls++;
      if (calls <= failFor) throw error();
      return originalCreate(args);
    };
    return () => calls;
  };

  it("retries a P2034 and succeeds, creating no duplicates", async () => {
    const d = db({ products: ["pA"], options: [OPT("pA", "A", 100), OPT("pA", "B", 200)] });
    const calls = withFailingCreate(d, 1, p2034);
    const result = await migrateProductOptions(d);

    expect(calls()).toBe(3); // 2 items on the successful attempt
    expect(result.productsMigrated).toBe(1);
    expect(result.productsSkipped).toBe(0);
    expect(result.conflicts).toEqual([]);
    // Exactly one group and one copy of each item — a retry must not duplicate.
    expect(d.__store.groups).toHaveLength(1);
    expect(d.__store.items).toHaveLength(2);
  });

  it("gives up after the bounded budget and reports exhaustion distinctly", async () => {
    const d = db({ products: ["pA"], options: [OPT("pA", "A", 100)] });
    const calls = withFailingCreate(d, Number.MAX_SAFE_INTEGER, p2034);
    const result = await migrateProductOptions(d);

    expect(calls()).toBe(MAX_TRANSACTION_ATTEMPTS);
    expect(result.productsMigrated).toBe(0);
    expect(result.productsSkipped).toBe(1);
    expect(result.conflicts[0].kind).toBe("TRANSACTION_RETRIES_EXHAUSTED");
    expect(d.__store.groups).toHaveLength(0);
  });

  it("does NOT retry a non-retryable database error", async () => {
    const d = db({ products: ["pA"], options: [OPT("pA", "A", 100)] });
    const calls = withFailingCreate(d, 1, () =>
      Object.assign(new Error("Foreign key constraint failed"), {
        name: "PrismaClientKnownRequestError",
        code: "P2003",
      }),
    );
    const result = await migrateProductOptions(d);

    expect(calls()).toBe(1); // failed once, never retried
    expect(result.conflicts[0].kind).toBe("TRANSACTION_FAILED");
  });

  it("does NOT retry a plain application error", async () => {
    const d = db({ products: ["pA"], options: [OPT("pA", "A", 100)] });
    const calls = withFailingCreate(d, 1, () => new Error("boom"));
    await migrateProductOptions(d);
    expect(calls()).toBe(1);
  });

  it("a P2034 on the second attempt still succeeds and stays idempotent", async () => {
    const d = db({ products: ["pA"], options: [OPT("pA", "A", 100)] });
    const items = (d as unknown as {
      optionGroupItem: { create: (a: { data: { name: string } }) => Promise<unknown> };
    }).optionGroupItem;
    const originalCreate = items.create.bind(items);
    let attempts = 0;
    items.create = async (args) => {
      attempts++;
      if (attempts <= 2) throw p2034();
      return originalCreate(args);
    };
    const result = await migrateProductOptions(d);
    expect(result.productsMigrated).toBe(1);
    expect(d.__store.groups).toHaveLength(1);
    expect(d.__store.items).toHaveLength(1);
  });

  it("retries never create a second group for the same product", async () => {
    // Simulates the worst case: the first attempt's group write is visible to
    // the next attempt's re-plan. The retry must REUSE it, not create another.
    const d = db({ products: ["pA"], options: [OPT("pA", "A", 100)] });
    const items = (d as unknown as {
      optionGroupItem: { create: (a: { data: { name: string } }) => Promise<unknown> };
    }).optionGroupItem;
    const originalCreate = items.create.bind(items);
    let first = true;
    items.create = async (args) => {
      if (first) {
        first = false;
        throw p2034();
      }
      return originalCreate(args);
    };
    await migrateProductOptions(d);
    expect(d.__store.groups.filter((g) => g.productId === "pA")).toHaveLength(1);
  });
});

describe("planProductMigration is reusable for callers", () => {
  it("exposes the same decisions the runner acts on", async () => {
    const d = db({ products: ["pA"], options: [OPT("pA", "A", 100)] });
    const plan = await planProductMigration(d, "pA", d.__store.options);
    expect(plan.action).toBe("create-group");
  });
});

/**
 * P2002 race recovery (GroupRaceLostError).
 *
 * The deterministic simulation:
 *   - `optionGroup.create` enforces exact `(productId, name)` uniqueness and
 *     throws a `P2002`-like error on a duplicate (matching the real index).
 *   - Tests override `optionGroup.findMany` so our *plan* does not yet see the
 *     competing writer's group (plans `create-group`), but our *create* attempt
 *     sees it (it was committed between plan and write) and throws `P2002`.
 *   - That models the race: plan reads committed state at T0, another writer
 *     commits at T1, our create fails at T2.
 *
 * These are timing-independent, single-threaded simulations. They exercise the
 * application's recovery control flow; they do NOT prove PostgreSQL enforces
 * the constraint or that two real concurrent runs behave this way.
 */
describe("P2002 race recovery", () => {
  const p2002Error = () => {
    const err: any = new Error(
      'Unique constraint failed on the `OptionGroup`(`productId`, `name`)',
    );
    err.name = "PrismaClientKnownRequestError";
    err.code = "P2002";
    err.meta = { target: ["productId", "name"] };
    return err;
  };

  /** Make our plan miss the pre-seeded competing group, but create see it. */
  function simulateRace(d: ReturnType<typeof db>) {
    let planCalls = 0;
    d.optionGroup.findMany = async (args?: { where?: Record<string, unknown> }) => {
      planCalls++;
      if (planCalls === 1) return [];
      return d.__store.groups.filter((g) =>
        matches(g as unknown as Record<string, unknown>, args?.where),
      );
    };
  }

  it("race lost, matching group found: reuses instead of duplicating", async () => {
    const d = db({
      products: ["pA"],
      options: [OPT("pA", "A", 100)],
      groups: [GROUP("pA", "Extras", { maxSelections: 1 })],
    });
    simulateRace(d);

    const result = await migrateProductOptions(d);

    expect(result.productsMigrated).toBe(1);
    expect(result.groupsReused).toBe(1);
    expect(result.groupsCreated).toBe(0);
    expect(result.itemsCreated).toBe(1);
    expect(result.conflicts).toEqual([]);
    // The concurrent writer's group is the single Extras group; no duplicate.
    expect(
      d.__store.groups.filter(
        (g) => g.productId === "pA" && normalizeOptionName(g.name) === "extras",
      ),
    ).toHaveLength(1);
    expect(d.__store.items).toHaveLength(1);
    expect(d.__store.items[0].name).toBe("A");
  });

  it("does not recreate items already present in the concurrent writer's group", async () => {
    const d = db({
      products: ["pA"],
      options: [OPT("pA", "A", 100)],
      groups: [GROUP("pA", "Extras", { maxSelections: 1 })],
      items: [{ id: "it-1", optionGroupId: "g-pA-Extras", name: "A", priceAdd: 100, isActive: true }],
    });
    simulateRace(d);

    const result = await migrateProductOptions(d);

    expect(result.productsMigrated).toBe(1);
    expect(result.groupsReused).toBe(1);
    expect(result.itemsCreated).toBe(0);
    expect(result.itemsAlreadyMigrated).toBe(1);
    expect(result.conflicts).toEqual([]);
    expect(d.__store.items).toHaveLength(1);
  });

  it("conflicting group: reports GROUP_CONFLICT and writes nothing", async () => {
    // Two legacy options => expected maxSelections 2, but the competing group
    // has maxSelections 1, so it is incompatible and must not be reused.
    const d = db({
      products: ["pA"],
      options: [OPT("pA", "A", 100), OPT("pA", "B", 200)],
      groups: [GROUP("pA", "Extras", { required: true, minSelections: 1, maxSelections: 1 })],
    });
    simulateRace(d);

    const result = await migrateProductOptions(d);

    expect(result.productsSkipped).toBe(1);
    expect(result.conflicts.some((c) => c.kind === "GROUP_CONFLICT")).toBe(true);
    // Nothing was written: the concurrent writer's group is untouched, no items.
    expect(d.__store.groups).toHaveLength(1);
    expect(d.__store.items).toHaveLength(0);
  });

  it("group not found after race: reports GROUP_DUPLICATE and writes nothing", async () => {
    const d = db({ products: ["pA"], options: [OPT("pA", "A", 100)] });
    // Our create always loses the race with P2002, and no group is ever visible
    // to our reads, so recovery cannot find a reusable group.
    let createCalls = 0;
    const originalCreate = d.optionGroup.create.bind(d.optionGroup);
    d.optionGroup.create = async (args: unknown) => {
      createCalls++;
      if (createCalls === 1) throw p2002Error();
      return originalCreate(args);
    };
    d.optionGroup.findMany = async () => [];

    const result = await migrateProductOptions(d);

    expect(result.productsSkipped).toBe(1);
    expect(result.conflicts.some((c) => c.kind === "GROUP_DUPLICATE")).toBe(true);
    expect(d.__store.groups).toHaveLength(0);
    expect(d.__store.items).toHaveLength(0);
  });

  it("recovery is bounded: P2034 exhaustion during reuse reports TRANSACTION_RETRIES_EXHAUSTED", async () => {
    const d = db({
      products: ["pA"],
      options: [OPT("pA", "A", 100)],
      groups: [GROUP("pA", "Extras", { maxSelections: 1 })],
    });
    simulateRace(d);
    // The reuse attempt's item insert always hits a write conflict.
    d.optionGroupItem.create = async () => {
      const err = Object.assign(
        new Error("Transaction failed due to a write conflict"),
        { name: "PrismaClientKnownRequestError", code: "P2034" },
      );
      throw err;
    };

    const result = await migrateProductOptions(d);

    expect(result.productsSkipped).toBe(1);
    expect(
      result.conflicts.some((c) => c.kind === "TRANSACTION_RETRIES_EXHAUSTED"),
    ).toBe(true);
    expect(
      result.conflicts.some((c) => c.detail.includes("attempts")),
    ).toBe(true);
    // Bounded: no infinite recovery loop; the concurrent writer's group stands.
    expect(d.__store.groups).toHaveLength(1);
    expect(d.__store.items).toHaveLength(0);
  });
});

/**
 * F-2.6 — P2002 on OptionGroupItem creation.
 *
 * The fake's `optionGroupItem.create` is overridden to throw a P2002-like
 * error for a chosen item name, modeling a concurrent writer winning the
 * uniqueness race. These are timing-independent simulations; they exercise the
 * application's recovery control flow, not PostgreSQL enforcement.
 */
describe("P2002 on item creation", () => {
  const p2002 = () => {
    const err: any = new Error(
      'Unique constraint failed on the `OptionGroupItem`(`optionGroupId`, lower(btrim("name")))',
    );
    err.name = "PrismaClientKnownRequestError";
    err.code = "P2002";
    err.meta = { target: ["optionGroupId", "name"] };
    return err;
  };

  /** Plan sees no items; recovery reads see the seeded items. Models a
   *  concurrent writer committing the item between our plan and our write.
   *  `invisiblePlans` = how many leading reads (i.e. plans) must NOT see the
   *  item. 1 models a single lost race; 2 models a race that persists across
   *  the recovery re-attempt. */
  function simulateItemRace(d: ReturnType<typeof db>, invisiblePlans = 1) {
    let calls = 0;
    d.optionGroupItem.findMany = async (args?: { where?: Record<string, unknown> }) => {
      calls++;
      if (calls <= invisiblePlans) return [];
      return d.__store.items.filter((i) =>
        matches(i as unknown as Record<string, unknown>, args?.where),
      );
    };
  }

  it("recovers as already-migrated when the concurrent writer's item matches", async () => {
    const d = db({
      products: ["pA"],
      options: [OPT("pA", "A", 100)],
      groups: [GROUP("pA", "Extras", { maxSelections: 1 })],
      items: [{ id: "it-concurrent", optionGroupId: "g-pA-Extras", name: "A", priceAdd: 100, isActive: true }],
    });
    simulateItemRace(d);
    const originalCreate = d.optionGroupItem.create.bind(d.optionGroupItem);
    d.optionGroupItem.create = async (args: { data: { name: string } }) => {
      if (args.data.name === "A") throw p2002();
      return originalCreate(args);
    };

    const result = await migrateProductOptions(d);

    expect(result.productsMigrated).toBe(1);
    expect(result.groupsReused).toBe(1);
    expect(result.itemsCreated).toBe(0);
    expect(result.itemsAlreadyMigrated).toBe(1);
    expect(result.conflicts).toEqual([]);
    // The concurrent writer's row is the only item — no duplicate.
    expect(d.__store.items.filter((i) => i.name === "A")).toHaveLength(1);
  });

  it("reports ITEM_MISMATCH when the conflicting item has different priceAdd/isActive", async () => {
    const d = db({
      products: ["pA"],
      options: [OPT("pA", "A", 100)],
      groups: [GROUP("pA", "Extras", { maxSelections: 1 })],
      items: [{ id: "it-concurrent", optionGroupId: "g-pA-Extras", name: "A", priceAdd: 999, isActive: true }],
    });
    simulateItemRace(d);
    const originalCreate = d.optionGroupItem.create.bind(d.optionGroupItem);
    d.optionGroupItem.create = async (args: { data: { name: string } }) => {
      if (args.data.name === "A") throw p2002();
      return originalCreate(args);
    };

    const result = await migrateProductOptions(d);

    // The recovery now re-attempts the product, so its outcome is decided by
    // the SAME code path as an equivalent non-racing migration: the
    // mismatched item produces a conflict and the product is reported as
    // migrated-with-a-conflict, not as "skipped". The item counters still
    // show that nothing was migrated for that item.
    expect(result.productsMigrated).toBe(1);
    expect(result.productsSkipped).toBe(0);
    expect(result.itemsCreated).toBe(0);
    expect(result.itemsAlreadyMigrated).toBe(0);
    expect(result.conflicts.some((c) => c.kind === "ITEM_MISMATCH")).toBe(true);
    expect(result.conflicts.some((c) => c.detail.includes("999"))).toBe(true);
    expect(result.conflicts.some((c) => c.detail.includes("100"))).toBe(true);
    expect(hasUnresolvedConflicts(result)).toBe(true);
    // Nothing was written: the existing item is untouched.
    expect(d.__store.items).toHaveLength(1);
    expect(d.__store.items[0].priceAdd).toBe(999);
  });

  it("reports ITEM_MISMATCH (not TRANSACTION_FAILED) when the conflicting item cannot be identified", async () => {
    const d = db({
      products: ["pA"],
      options: [OPT("pA", "A", 100)],
      groups: [GROUP("pA", "Extras", { maxSelections: 1 })],
    });
    simulateItemRace(d);
    const originalCreate = d.optionGroupItem.create.bind(d.optionGroupItem);
    d.optionGroupItem.create = async (args: { data: { name: string } }) => {
      if (args.data.name === "A") throw p2002();
      return originalCreate(args);
    };

    const result = await migrateProductOptions(d);

    expect(result.productsSkipped).toBe(1);
    expect(result.conflicts.some((c) => c.kind === "ITEM_MISMATCH")).toBe(true);
    expect(result.conflicts.some((c) => c.kind === "TRANSACTION_FAILED")).toBe(false);
    expect(d.__store.items).toHaveLength(0);
  });

  it("never leaks raw Prisma details into the conflict output", async () => {
    const d = db({
      products: ["pA"],
      options: [OPT("pA", "A", 100)],
      groups: [GROUP("pA", "Extras", { maxSelections: 1 })],
    });
    simulateItemRace(d);
    d.optionGroupItem.create = async (args: { data: { name: string } }) => {
      if (args.data.name === "A") throw p2002();
      return { id: "item-x" };
    };

    const result = await migrateProductOptions(d);

    const detail = result.conflicts[0]?.detail ?? "";
    expect(detail).not.toContain("P2002");
    expect(detail).not.toContain("optionGroupId");
    expect(detail).not.toContain("lower(btrim");
    expect(detail).not.toContain("OptionGroupItem");
    expect(detail).not.toContain("Unique constraint");
  });

  it("non-P2002 item-creation errors still report TRANSACTION_FAILED and are not retried", async () => {
    const d = db({
      products: ["pA"],
      options: [OPT("pA", "A", 100)],
      groups: [GROUP("pA", "Extras", { maxSelections: 1 })],
    });
    let calls = 0;
    d.optionGroupItem.create = async () => {
      calls++;
      const err: any = new Error("Foreign key constraint failed");
      err.name = "PrismaClientKnownRequestError";
      err.code = "P2003";
      throw err;
    };

    const result = await migrateProductOptions(d);

    expect(calls).toBe(1); // failed once, never retried
    expect(result.productsSkipped).toBe(1);
    expect(result.conflicts[0].kind).toBe("TRANSACTION_FAILED");
  });

  /* ── F-2.6.2: product-level recovery ────────────────────────────────────
   *
   * The recovery must decide the outcome for the WHOLE product, not only for
   * the item that raised P2002. The aborted transaction rolled back every
   * item it had written, and the items after the conflicting one were never
   * written at all, so verifying the conflicting item alone could report a
   * product as migrated while a sibling item was still missing.
   */

  it("migrates the sibling item the aborted transaction never wrote", async () => {
    const d = db({
      products: ["pA"],
      options: [OPT("pA", "A", 100), OPT("pA", "B", 200)],
      groups: [GROUP("pA", "Extras", { maxSelections: 2 })],
      items: [{ id: "it-concurrent", optionGroupId: "g-pA-Extras", name: "A", priceAdd: 100, isActive: true }],
    });
    simulateItemRace(d);
    const originalCreate = d.optionGroupItem.create.bind(d.optionGroupItem);
    d.optionGroupItem.create = async (args: { data: { name: string } }) => {
      if (args.data.name === "A") throw p2002();
      return originalCreate(args);
    };

    const result = await migrateProductOptions(d);

    // BOTH items are present: the rollback did not leave the product
    // half-migrated.
    expect(d.__store.items.map((i) => i.name).sort()).toEqual(["A", "B"]);
    expect(result.productsMigrated).toBe(1);
    expect(result.productsSkipped).toBe(0);
    expect(result.groupsReused).toBe(1);
    // A was the concurrent writer's row (already migrated); B was created.
    expect(result.itemsCreated).toBe(1);
    expect(result.itemsAlreadyMigrated).toBe(1);
    expect(result.conflicts).toEqual([]);
    // Counters are not duplicated by the failed attempt plus the recovery,
    // and they account for every legacy option.
    expect(result.itemsCreated + result.itemsAlreadyMigrated).toBe(2);
  });

  it("surfaces a mismatched sibling item and never overwrites the existing row", async () => {
    const d = db({
      products: ["pA"],
      options: [OPT("pA", "A", 100), OPT("pA", "B", 200)],
      groups: [GROUP("pA", "Extras", { maxSelections: 2 })],
      items: [
        { id: "it-c1", optionGroupId: "g-pA-Extras", name: "A", priceAdd: 100, isActive: true },
        { id: "it-c2", optionGroupId: "g-pA-Extras", name: "B", priceAdd: 999, isActive: true },
      ],
    });
    simulateItemRace(d);
    const originalCreate = d.optionGroupItem.create.bind(d.optionGroupItem);
    d.optionGroupItem.create = async (args: { data: { name: string } }) => {
      if (args.data.name === "A") throw p2002();
      return originalCreate(args);
    };

    const result = await migrateProductOptions(d);

    // The mismatch is surfaced, so the run is not reported as clean.
    expect(result.conflicts.some((c) => c.kind === "ITEM_MISMATCH")).toBe(true);
    expect(result.conflicts.some((c) => c.detail.includes("999"))).toBe(true);
    expect(result.conflicts.some((c) => c.detail.includes("200"))).toBe(true);
    expect(hasUnresolvedConflicts(result)).toBe(true);
    // B is NOT claimed as migrated: it counts as neither created nor already
    // migrated, so the counters cannot report a complete migration.
    expect(result.itemsCreated).toBe(0);
    expect(result.itemsAlreadyMigrated).toBe(1); // only A
    expect(result.itemsCreated + result.itemsAlreadyMigrated).toBe(1);
    // The vendor's row is untouched and no duplicate row was added.
    expect(d.__store.items).toHaveLength(2);
    expect(d.__store.items.find((i) => i.name === "B")!.priceAdd).toBe(999);
  });

  it("produces the same result as an equivalent non-racing migration", async () => {
    const seed = {
      products: ["pA"],
      options: [OPT("pA", "A", 100), OPT("pA", "B", 200)],
      groups: [GROUP("pA", "Extras", { maxSelections: 2 })],
      items: [{ id: "it-1", optionGroupId: "g-pA-Extras", name: "A", priceAdd: 100, isActive: true }],
    };

    // No race at all: A is already present, B is created normally.
    const plain = db(seed);
    const plainResult = await migrateProductOptions(plain);

    // Same fixture, but A's creation loses the race to a concurrent writer.
    const raced = db(seed);
    simulateItemRace(raced);
    const originalCreate = raced.optionGroupItem.create.bind(raced.optionGroupItem);
    raced.optionGroupItem.create = async (args: { data: { name: string } }) => {
      if (args.data.name === "A") throw p2002();
      return originalCreate(args);
    };
    const racedResult = await migrateProductOptions(raced);

    // The recovery is indistinguishable from a non-racing migration.
    expect(racedResult).toEqual(plainResult);
    expect(plainResult.itemsCreated).toBe(1);
    expect(plainResult.itemsAlreadyMigrated).toBe(1);
  });

  it("reports a conflict when the uniqueness conflict persists after the retry", async () => {
    const d = db({
      products: ["pA"],
      options: [OPT("pA", "A", 100), OPT("pA", "B", 200)],
      groups: [GROUP("pA", "Extras", { maxSelections: 2 })],
      items: [{ id: "it-concurrent", optionGroupId: "g-pA-Extras", name: "A", priceAdd: 100, isActive: true }],
    });
    // The conflicting row stays invisible to BOTH plans, so the recovery
    // re-attempt hits the very same uniqueness conflict again.
    simulateItemRace(d, 2);
    const originalCreate = d.optionGroupItem.create.bind(d.optionGroupItem);
    d.optionGroupItem.create = async (args: { data: { name: string } }) => {
      if (args.data.name === "A") throw p2002();
      return originalCreate(args);
    };

    const result = await migrateProductOptions(d);

    // A conflict that persists is a conflict, never a success.
    expect(result.productsMigrated).toBe(0);
    expect(result.productsSkipped).toBe(1);
    expect(result.conflicts.some((c) => c.kind === "ITEM_MISMATCH")).toBe(true);
    expect(result.conflicts.some((c) => c.kind === "TRANSACTION_FAILED")).toBe(false);
    expect(hasUnresolvedConflicts(result)).toBe(true);
    // The recovery did not escape as an unhandled rejection, and B was never
    // written.
    expect(d.__store.items.map((i) => i.name)).toEqual(["A"]);
  });

  it("reports TRANSACTION_FAILED when the recovery attempt fails for a non-race reason", async () => {
    const d = db({
      products: ["pA"],
      options: [OPT("pA", "A", 100), OPT("pA", "B", 200)],
      groups: [GROUP("pA", "Extras", { maxSelections: 2 })],
      items: [{ id: "it-concurrent", optionGroupId: "g-pA-Extras", name: "A", priceAdd: 100, isActive: true }],
    });
    simulateItemRace(d);
    d.optionGroupItem.create = async (args: { data: { name: string } }) => {
      // The race that starts the recovery...
      if (args.data.name === "A") throw p2002();
      // ...and then the recovery itself fails for an unrelated reason.
      const err: any = new Error("Foreign key constraint failed");
      err.name = "PrismaClientKnownRequestError";
      err.code = "P2003";
      throw err;
    };

    const result = await migrateProductOptions(d);

    // The failed recovery is reported, never silently treated as success.
    expect(result.productsMigrated).toBe(0);
    expect(result.productsSkipped).toBe(1);
    expect(result.conflicts[0].kind).toBe("TRANSACTION_FAILED");
    // It did not escape as an unhandled rejection, and B was never written.
    expect(d.__store.items.map((i) => i.name)).toEqual(["A"]);
  });
});
