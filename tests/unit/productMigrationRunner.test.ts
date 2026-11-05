/**
 * Phase 2B.2 review F-4 + F-5 — runner lifecycle and environment precedence.
 *
 * DATABASE-INDEPENDENT BY CONSTRUCTION: `loadPrisma` is injected. Every test
 * supplies its own fake and additionally asserts HOW MANY TIMES it was called,
 * which is the property review finding F-4 was about. This file never imports
 * `src/lib/prisma`, so no real client is ever constructed and no socket is
 * opened.
 */
import {
  runProductOptionMigration,
  type MigrationDbHandle,
  type RunnerDeps,
} from "../../src/services/productMigrationRunner";

const LOOPBACK = "postgresql://user:secret@127.0.0.1:55434/foodpaddi_test";
const DENIED = "localhost,0.0.0.0";
const GOOD_ENV = {
  DATABASE_URL: LOOPBACK,
  TEST_DATABASE_URL: LOOPBACK,
  TEST_DATABASE_DENIED_HOSTS: DENIED,
};

const emptyStore = {
  product: { findMany: async () => [] },
  productOption: { findMany: async () => [], count: async () => 0 },
  cartItemOption: { count: async () => 0 },
  orderItemOption: { count: async () => 0 },
  optionGroup: { findMany: async () => [], create: async () => ({ id: "g" }) },
  optionGroupItem: { findMany: async () => [], create: async () => ({ id: "i" }) },
  $transaction: async (cb: (tx: unknown) => Promise<unknown>) => cb(emptyStore),
};

/** Harness that records whether the client loader was reached, and disconnect calls. */
function harness(overrides: Partial<RunnerDeps> = {}) {
  const calls = { load: 0, disconnect: 0 };
  const out: string[] = [];
  const deps: RunnerDeps = {
    env: { ...GOOD_ENV },
    apply: false,
    loadPrisma: async () => {
      calls.load++;
      return {
        ...emptyStore,
        $disconnect: async () => {
          calls.disconnect++;
        },
      } as unknown as MigrationDbHandle;
    },
    log: (m) => out.push(m),
    warn: (m) => out.push(m),
    error: (m) => out.push(m),
    ...overrides,
  };
  return { deps, calls, out };
}

describe("F-4 — a refused run never constructs a database client", () => {
  it("missing DATABASE_URL: refuses, loads no client, disconnects nothing", async () => {
    const h = harness({ env: { TEST_DATABASE_URL: LOOPBACK, TEST_DATABASE_DENIED_HOSTS: DENIED } });
    const r = await runProductOptionMigration(h.deps);
    expect(r.outcome).toBe("REFUSED_TARGET");
    expect(r.exitCode).toBe(1);
    expect(r.clientInitialized).toBe(false);
    expect(h.calls.load).toBe(0);
    expect(h.calls.disconnect).toBe(0);
  });

  it("remote/production host: refuses, loads no client", async () => {
    const remote = "postgresql://u:p@db.prod.example.com:5432/foodpaddi";
    const h = harness({
      env: { DATABASE_URL: remote, TEST_DATABASE_URL: remote, TEST_DATABASE_DENIED_HOSTS: DENIED },
    });
    const r = await runProductOptionMigration(h.deps);
    expect(r.outcome).toBe("REFUSED_TARGET");
    expect(h.calls.load).toBe(0);
  });

  it("database-name mismatch: refuses, loads no client", async () => {
    const h = harness({
      env: {
        DATABASE_URL: "postgresql://u:p@127.0.0.1:55434/foodpaddi_dev",
        TEST_DATABASE_URL: LOOPBACK,
        TEST_DATABASE_DENIED_HOSTS: DENIED,
      },
    });
    const r = await runProductOptionMigration(h.deps);
    expect(r.outcome).toBe("REFUSED_TARGET");
    expect(h.calls.load).toBe(0);
  });

  it("malformed URL: refuses, loads no client, and emits no stack trace", async () => {
    const h = harness({
      env: { DATABASE_URL: "not a url", TEST_DATABASE_URL: LOOPBACK, TEST_DATABASE_DENIED_HOSTS: DENIED },
    });
    const r = await runProductOptionMigration(h.deps);
    expect(r.outcome).toBe("REFUSED_TARGET");
    expect(h.calls.load).toBe(0);
    expect(h.out.join("\n")).not.toContain("at Object.");
  });

  it("missing write authorization: refuses BEFORE loading the client", async () => {
    const h = harness({ apply: true }); // no PRODUCT_OPTION_MIGRATION_ALLOW
    const r = await runProductOptionMigration(h.deps);
    expect(r.outcome).toBe("REFUSED_NOT_AUTHORIZED");
    expect(r.exitCode).toBe(1);
    expect(h.calls.load).toBe(0);
    expect(h.calls.disconnect).toBe(0);
  });

  it("wrong opt-in value (case) still refuses", async () => {
    const h = harness({ apply: true, env: { ...GOOD_ENV, PRODUCT_OPTION_MIGRATION_ALLOW: "YES" } });
    const r = await runProductOptionMigration(h.deps);
    expect(r.outcome).toBe("REFUSED_NOT_AUTHORIZED");
    expect(h.calls.load).toBe(0);
  });

  it("dry-run without opt-in is ALLOWED to load a client (it only reads)", async () => {
    const h = harness({ apply: false });
    const r = await runProductOptionMigration(h.deps);
    expect(r.outcome).toBe("DRY_RUN");
    expect(r.exitCode).toBe(0);
    expect(h.calls.load).toBe(1);
    expect(h.calls.disconnect).toBe(1); // cleaned up after initialization
  });
});

describe("F-5 — environment precedence is re-verified, not assumed", () => {
  it("loadDotenv runs and its effect is re-checked by the full guard", async () => {
    let dotenvCalls = 0;
    const h = harness({
      loadDotenv: () => {
        dotenvCalls++;
      },
    });
    await runProductOptionMigration(h.deps);
    expect(dotenvCalls).toBe(1);
  });

  it("refuses when the environment changes to a non-authorised database after loading", async () => {
    const env: Record<string, string | undefined> = { ...GOOD_ENV };
    const h = harness({
      env,
      // Simulates `.env` winning: DATABASE_URL is repointed at another database.
      loadDotenv: (e) => {
        e.DATABASE_URL = "postgresql://u:p@127.0.0.1:55434/some_other_db";
      },
    });
    const r = await runProductOptionMigration(h.deps);
    expect(r.outcome).toBe("REFUSED_ENV_PRECEDENCE");
    expect(r.exitCode).toBe(1);
    expect(r.clientInitialized).toBe(false);
    expect(h.calls.load).toBe(0);
  });

  it("refuses when .env repoints the host to a remote server", async () => {
    const env: Record<string, string | undefined> = { ...GOOD_ENV };
    const h = harness({
      env,
      loadDotenv: (e) => {
        e.DATABASE_URL = "postgresql://u:p@db.prod.example.com:5432/foodpaddi_test";
      },
    });
    const r = await runProductOptionMigration(h.deps);
    expect(r.outcome).toBe("REFUSED_ENV_PRECEDENCE");
    expect(h.calls.load).toBe(0);
  });

  it("refuses when .env clears the explicit port", async () => {
    const env: Record<string, string | undefined> = { ...GOOD_ENV };
    const h = harness({
      env,
      loadDotenv: (e) => {
        e.DATABASE_URL = "postgresql://u:p@127.0.0.1/foodpaddi_test";
      },
    });
    const r = await runProductOptionMigration(h.deps);
    expect(r.outcome).toBe("REFUSED_ENV_PRECEDENCE");
    expect(h.calls.load).toBe(0);
  });

  it("an unchanged environment proceeds normally", async () => {
    const env: Record<string, string | undefined> = { ...GOOD_ENV };
    const h = harness({ env, loadDotenv: () => undefined });
    const r = await runProductOptionMigration(h.deps);
    expect(r.outcome).toBe("DRY_RUN");
    expect(h.calls.load).toBe(1);
  });

  it("the guard runs BEFORE dotenv, so a bad target short-circuits immediately", async () => {
    let dotenvCalls = 0;
    const h = harness({
      env: {},
      loadDotenv: () => {
        dotenvCalls++;
      },
    });
    await runProductOptionMigration(h.deps);
    // No point loading .env once the environment is already known to be unusable.
    expect(dotenvCalls).toBe(0);
  });
});

describe("authorized apply path", () => {
  it("requires the opt-in and reports success, disconnecting exactly once", async () => {
    const h = harness({
      apply: true,
      env: { ...GOOD_ENV, PRODUCT_OPTION_MIGRATION_ALLOW: "yes" },
    });
    const r = await runProductOptionMigration(h.deps);
    expect(r.outcome).toBe("APPLIED");
    expect(r.exitCode).toBe(0);
    expect(h.calls.load).toBe(1);
    expect(h.calls.disconnect).toBe(1);
  });

  it("integrity problems refuse after initialization but still disconnect", async () => {
    const store = {
      ...emptyStore,
      productOption: {
        findMany: async () => [
          { id: "o1", productId: "ghost", name: "X", price: 1, isActive: true },
        ],
        count: async () => 1,
      },
    };
    const h = harness({
      apply: true,
      env: { ...GOOD_ENV, PRODUCT_OPTION_MIGRATION_ALLOW: "yes" },
      loadPrisma: async () => ({ ...store, $disconnect: async () => { h.calls.disconnect++; } }) as never,
    });
    const r = await runProductOptionMigration(h.deps);
    expect(r.outcome).toBe("REFUSED_INTEGRITY");
    expect(h.calls.disconnect).toBe(1);
  });

  it("a client-initialization failure never echoes the raw error", async () => {
    const h = harness({
      loadPrisma: async () => {
        throw new Error("connection string postgresql://u:secret@h/db is invalid");
      },
    });
    const r = await runProductOptionMigration(h.deps);
    expect(r.exitCode).toBe(1);
    expect(r.clientInitialized).toBe(false);
    expect(h.out.join("\n")).not.toContain("secret");
    expect(h.out.join("\n")).not.toContain("postgresql://");
  });
});

/**
 * Review follow-up B-2 — initialization errors must be sanitized.
 *
 * The runner's console is the only place in this codebase that prints raw
 * driver text, and Prisma initialization failures routinely embed the
 * datasource URL — a URL embeds credentials. `P1000` alone quotes the database
 * user. These tests pin that the message never reaches stdout, using fake
 * credentials only; no real environment value is read or printed.
 */
describe("B-2 — initialization errors are sanitized", () => {
  const SECRET = "sup3rs3cr3t";

  const initFailing = (err: unknown) =>
    harness({
      loadPrisma: async () => {
        throw err;
      },
    });

  it("does not print a password embedded in a connection URL", async () => {
    const h = initFailing(
      new Error(`failed to load postgresql://appuser:${SECRET}@127.0.0.1:55434/foodpaddi_test`),
    );
    const r = await runProductOptionMigration(h.deps);
    const text = h.out.join("\n");

    // Credentials and the assembled URL must never appear.
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("appuser");
    expect(text).not.toContain("postgresql://");
    // NOTE: host:port IS intentionally printed by the "Target verified" line —
    // it is the already-authorized, non-secret destination the operator asked
    // to confirm, and the guard deliberately reports host and port only. The
    // bug was the *unfiltered error*, not this line, so host is not asserted
    // absent here.
    expect(r.exitCode).toBe(1);
    expect(r.clientInitialized).toBe(false);
  });

  it("does not print a username or internal host from a P1000-style error", async () => {
    const err = Object.assign(
      new Error(`P1000: authentication failed for database user "reporting_svc" on db.internal.corp`),
      { name: "PrismaClientInitializationError" },
    );
    const h = initFailing(err);
    const r = await runProductOptionMigration(h.deps);
    const text = h.out.join("\n");

    expect(text).not.toContain("reporting_svc");
    expect(text).not.toContain("db.internal.corp");
    expect(text).not.toContain("P1000");
  });

  it("does not print a stack trace", async () => {
    const h = initFailing(
      new Error("boom\n    at Object.<anonymous> (/srv/app/scripts/x.js:1:1)\n    at Module._compile"),
    );
    const r = await runProductOptionMigration(h.deps);
    const text = h.out.join("\n");

    expect(text).not.toContain("at Object.");
    expect(text).not.toContain("/srv/app");
    expect(r.exitCode).toBe(1);
  });

  it("still reports a stable, actionable, non-sensitive message", async () => {
    const h = initFailing(new Error("plain harmless failure"));
    const r = await runProductOptionMigration(h.deps);
    const text = h.out.join("\n");

    expect(text).toContain("could not initialise its database client");
    expect(text).toContain("nothing was read or written");
    // Classification preserved, and now distinguishable from a target refusal.
    expect(r.exitCode).toBe(1);
    expect(r.outcome).toBe("CLIENT_INIT_FAILED");
    expect(r.clientInitialized).toBe(false);
  });

  it("no client is constructed and nothing is written before the guards pass", async () => {
    const h = initFailing(new Error("should never be reached"));
    // Force a refusal by removing the opt-in on an --apply run.
    h.deps.apply = true;
    const r = await runProductOptionMigration(h.deps);

    expect(r.outcome).toBe("REFUSED_NOT_AUTHORIZED");
    expect(h.calls.load).toBe(0);
    expect(h.calls.disconnect).toBe(0);
  });

  it("refusal paths still refuse before any initialization attempt", async () => {
    const h = harness({
      env: {},
      loadPrisma: async () => {
        throw new Error("must not run");
      },
    });
    const r = await runProductOptionMigration(h.deps);
    expect(r.outcome).toBe("REFUSED_TARGET");
    expect(h.calls.load).toBe(0);
  });

  it("cleanup still runs for a client that WAS initialized", async () => {
    const h = harness();
    const r = await runProductOptionMigration(h.deps);
    expect(r.outcome).toBe("DRY_RUN");
    expect(h.calls.load).toBe(1);
    expect(h.calls.disconnect).toBe(1);
  });
});
/* ── F-2.6.4 — dry-run exit status reflects unresolved conflicts ──────────
 *
 * A dry run is the script's default mode and the operator's pre-flight gate,
 * so its exit code must distinguish "the preview is clean" from "the preview
 * already contains unresolved conflicts". These tests drive the real runner
 * end-to-end with an in-memory fake: no PrismaClient, no socket, no database.
 */

type LegacyRow = {
  id: string;
  productId: string;
  name: string;
  price: number;
  isActive: boolean;
};
type GroupRow = {
  id: string;
  productId: string;
  name: string;
  required: boolean;
  minSelections: number;
  maxSelections: number;
  sortOrder: number;
};
type ItemRow = {
  id: string;
  optionGroupId: string;
  name: string;
  priceAdd: number;
  isActive: boolean;
};

/**
 * Minimal stand-in for the migration's full read/write surface.
 *
 * The mutation counters are the point: the dry-run tests assert that the apply
 * path was never entered, so "read-only" is proven by behaviour rather than by
 * trusting the implementation.
 */
function migrationStore(seed: {
  products?: string[];
  options?: LegacyRow[];
  groups?: GroupRow[];
  items?: ItemRow[];
}) {
  const products = (seed.products ?? []).map((id) => ({ id }));
  const options: LegacyRow[] = [...(seed.options ?? [])];
  const groups: GroupRow[] = [...(seed.groups ?? [])];
  const items: ItemRow[] = [...(seed.items ?? [])];
  const calls = { groupCreate: 0, itemCreate: 0, transactions: 0, disconnect: 0 };

  const byWhere = <T>(rows: T[], where?: Record<string, unknown>): T[] =>
    rows.filter((row) =>
      Object.entries(where ?? {}).every(
        ([k, v]) => (row as Record<string, unknown>)[k] === v,
      ),
    );

  const db = {
    product: { findMany: async () => products.map((p) => ({ id: p.id })) },
    productOption: {
      findMany: async () => options.map((o) => ({ ...o })),
      count: async () => options.length,
    },
    cartItemOption: { count: async () => 0 },
    orderItemOption: { count: async () => 0 },
    optionGroup: {
      findMany: async (args?: { where?: Record<string, unknown> }) =>
        byWhere(groups, args?.where).map((g) => ({ ...g })),
      create: async (args: { data: Omit<GroupRow, "id"> }) => {
        calls.groupCreate++;
        const row: GroupRow = { id: `g-new-${calls.groupCreate}`, ...args.data };
        groups.push(row);
        return { id: row.id };
      },
    },
    optionGroupItem: {
      findMany: async (args?: { where?: Record<string, unknown> }) =>
        byWhere(items, args?.where).map((i) => ({ ...i })),
      create: async (args: { data: Omit<ItemRow, "id"> }) => {
        calls.itemCreate++;
        const row: ItemRow = { id: `i-new-${calls.itemCreate}`, ...args.data };
        items.push(row);
        return { id: row.id };
      },
    },
    $transaction: async (cb: (tx: unknown) => Promise<unknown>) => {
      calls.transactions++;
      return cb(db);
    },
    $disconnect: async () => {
      calls.disconnect++;
    },
  };

  return { db, calls, groups, items };
}

const APPLY_ENV = { ...GOOD_ENV, PRODUCT_OPTION_MIGRATION_ALLOW: "yes" };

/** One legacy option, no group yet: the migration can complete cleanly. */
const cleanSeed = () => ({
  products: ["pA"],
  options: [{ id: "o1", productId: "pA", name: "A", price: 100, isActive: true }],
});

/** Sibling item already exists with a different priceAdd → ITEM_MISMATCH. */
const conflictedSeed = () => ({
  products: ["pA"],
  options: [
    { id: "o1", productId: "pA", name: "A", price: 100, isActive: true },
    { id: "o2", productId: "pA", name: "B", price: 200, isActive: true },
  ],
  groups: [
    {
      id: "g-pA-Extras",
      productId: "pA",
      name: "Extras",
      required: false,
      minSelections: 0,
      maxSelections: 2,
      sortOrder: 0,
    },
  ],
  items: [
    { id: "i-A", optionGroupId: "g-pA-Extras", name: "A", priceAdd: 100, isActive: true },
    { id: "i-B", optionGroupId: "g-pA-Extras", name: "B", priceAdd: 999, isActive: true },
  ],
});

/** Run the real runner against the fake, overriding only the client loader. */
function runWith(
  h: ReturnType<typeof harness>,
  store: ReturnType<typeof migrationStore>,
  apply: boolean,
) {
  return runProductOptionMigration({
    ...h.deps,
    apply,
    loadPrisma: async () => store.db as unknown as MigrationDbHandle,
  });
}

describe("F-2.6.4 — dry-run exit status reflects unresolved conflicts", () => {
  it("clean apply: APPLIED and exit 0, with writes actually performed", async () => {
    const store = migrationStore(cleanSeed());
    const h = harness({ env: APPLY_ENV });
    const r = await runWith(h, store, true);

    expect(r.outcome).toBe("APPLIED");
    expect(r.exitCode).toBe(0);
    expect(r.conflicts).toBeUndefined();
    // Proves this fixture really exercises the apply path.
    expect(store.calls.groupCreate).toBe(1);
    expect(store.calls.itemCreate).toBe(1);
    expect(store.calls.disconnect).toBe(1);
  });

  it("apply with unresolved conflicts: APPLIED_WITH_CONFLICTS and exit 1", async () => {
    const store = migrationStore(conflictedSeed());
    const h = harness({ env: APPLY_ENV });
    const r = await runWith(h, store, true);

    expect(r.outcome).toBe("APPLIED_WITH_CONFLICTS");
    expect(r.exitCode).toBe(1);
    expect(r.conflicts).toBe(1);
    // The status is backed by a real conflict in the underlying result.
    const resultJson = h.out.find((m) => m.includes('"conflicts"'))!;
    expect(resultJson).toContain("ITEM_MISMATCH");
    // Additive-only: the mismatched row was never rewritten.
    expect(store.items.find((i) => i.name === "B")!.priceAdd).toBe(999);
  });

  it("clean dry run: DRY_RUN, exit 0, and nothing is written", async () => {
    const store = migrationStore(cleanSeed());
    const h = harness({ env: GOOD_ENV });
    const r = await runWith(h, store, false);

    expect(r.outcome).toBe("DRY_RUN");
    expect(r.exitCode).toBe(0);
    expect(r.conflicts).toBeUndefined();
    // Read-only: no transaction was opened and no row was created.
    expect(store.calls.transactions).toBe(0);
    expect(store.calls.groupCreate).toBe(0);
    expect(store.calls.itemCreate).toBe(0);
    expect(store.calls.disconnect).toBe(1);
  });

  it("dry run with unresolved conflicts: DRY_RUN_WITH_CONFLICTS and exit 1", async () => {
    const store = migrationStore(conflictedSeed());
    const h = harness({ env: GOOD_ENV });
    const r = await runWith(h, store, false);

    expect(r.outcome).toBe("DRY_RUN_WITH_CONFLICTS");
    expect(r.exitCode).toBe(1);
    expect(r.conflicts).toBe(1);

    const text = h.out.join("\n");
    // Actionable, and consistent with the apply-conflict remediation message.
    expect(text).toContain("1 unresolved conflict(s) found in the dry-run preview");
    expect(text).toContain("Resolve the conflicts above manually, then rerun the dry run.");
    // The printed preview keeps the actual conflict details.
    const previewJson = h.out.find((m) => m.includes('"conflicts"'))!;
    expect(previewJson).toContain("ITEM_MISMATCH");

    // The gap being fixed: a conflicted preview must not look like a clean run.
    expect(r.outcome).not.toBe("DRY_RUN");

    // Still a preview: the apply/mutation path was never entered.
    expect(store.calls.transactions).toBe(0);
    expect(store.calls.groupCreate).toBe(0);
    expect(store.calls.itemCreate).toBe(0);
    expect(store.items.find((i) => i.name === "B")!.priceAdd).toBe(999);
  });
});
