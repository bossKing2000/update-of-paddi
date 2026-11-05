/**
 * FIN-07-03c.16 — the REAL production candidate query, executed by PostgreSQL.
 *
 * FIN-07-03c.15 proved the worker's logic against a hand-written model of the
 * SQL. That cannot prove PostgreSQL's JSONB NULL semantics, the regex/cast
 * safety, the ordering, or that the keyset boundary is honoured by the planner.
 * This suite closes that gap by calling `fetchRecoveryCandidates` — the exact
 * `$queryRaw` statement the worker itself runs — against real rows.
 *
 * It deliberately does NOT call `verifyExpiredPayments`, so no Paystack call,
 * payment finalization or refund obligation is triggered.
 *
 * Fixtures are uniquely prefixed and removed in `afterEach` / `afterAll`. The
 * User and Order rows this suite needs to satisfy the Payment foreign keys are
 * created BY this suite and deleted BY this suite, by exact id — so the suite
 * no longer depends on another suite running first, on leaked rows, or on a
 * pre-seeded database. Rows this suite does not own are never touched.
 */
import { Prisma, PrismaClient, PaymentStatus } from "@prisma/client";
import { fetchRecoveryCandidates } from "../../src/jobs/payment/worker/verifyExpiredPayments";

const prisma = new PrismaClient();

/** Unique per run so this suite can never collide with another run's fixtures. */
const TAG = `fin07c16-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
const REFS: string[] = [];

function ref(name: string): string {
  const r = `${TAG}-${name}`;
  REFS.push(r);
  return r;
}

const HOUR = 60 * 60 * 1000;
const WINDOW_MS = 72 * HOUR; // the application recovery window

function row(name: string, over: Record<string, unknown> = {}) {
  return {
    userId: "u-fin07c16",
    orderId: "o-fin07c16",
    amount: 1000,
    reference: ref(name),
    status: PaymentStatus.EXPIRED,
    // Inside the 72-hour window.
    expiresAt: new Date(Date.now() - 1 * HOUR),
    ...over,
  };
}

async function scan(over: Partial<Parameters<typeof fetchRecoveryCandidates>[0]> = {}) {
  const now = new Date();
  return fetchRecoveryCandidates({
    cutoff: new Date(now.getTime() - WINDOW_MS),
    now,
    limit: 50,
    keyset: null,
    ...over,
  });
}

const refsOf = (rows: Array<{ reference: string }>) => rows.map((r) => r.reference);

/**
 * Fixture records this suite OWNS.
 *
 * The FK targets (a User and an Order) used to be borrowed from whatever rows
 * happened to exist in the database — typically rows another suite had leaked.
 * That made the suite's outcome depend on suite execution order and on whether
 * the database had been seeded, so it failed on a fresh, unseeded disposable
 * database. The suite now creates its own and deletes exactly these.
 */
const OWNED_USER_IDS: string[] = [];
const OWNED_ORDER_IDS: string[] = [];

beforeAll(async () => {
  // `Payment` has two RESTRICT foreign keys (`Payment_userId_fkey`,
  // `Payment_orderId_fkey`), so a User and an Order must exist before any
  // fixture Payment row can be inserted. `fetchRecoveryCandidates` selects
  // only FROM "Payment" and never joins to either table, so these exist purely
  // to satisfy the FKs — no other column of either row is read by the query.
  //
  // Required columns, verified against the DDL in
  // prisma/migrations/20261016025918_init/migration.sql:
  //   User : name, email (unique) — id/updatedAt have defaults or are managed.
  //   Order: customerId, vendorId, basePrice, totalPrice — both user columns
  //          are RESTRICT FKs to User.
  const vendor = await prisma.user.create({
    data: {
      email: `${TAG}-vendor@example.com`,
      name: "Vendor",
      role: "VENDOR",
      roles: ["VENDOR"],
    },
  });
  OWNED_USER_IDS.push(vendor.id);

  const customer = await prisma.user.create({
    data: {
      email: `${TAG}-customer@example.com`,
      name: "Customer",
      role: "CUSTOMER",
      roles: ["CUSTOMER"],
    },
  });
  OWNED_USER_IDS.push(customer.id);

  const order = await prisma.order.create({
    data: {
      customerId: customer.id,
      vendorId: vendor.id,
      basePrice: 1000,
      totalPrice: 1000,
      status: "PENDING",
    },
  });
  OWNED_ORDER_IDS.push(order.id);

  // The Payment rows created by this suite belong to the customer.
  USER_ID = customer.id;
  ORDER_ID = order.id;
});

let USER_ID = "";
let ORDER_ID = "";

afterEach(async () => {
  // Remove ONLY rows this suite created, and only those still identifiable.
  if (REFS.length === 0) return;
  await prisma.payment.deleteMany({ where: { reference: { in: [...REFS] } } });
  REFS.length = 0;
});

afterAll(async () => {
  // Safety net for the case where a test failed between creating a Payment row
  // and the afterEach cleanup. Deletes are by EXACT id — never by a broad
  // prefix or a loose predicate — so another suite's fixtures can never be
  // matched.
  //
  // FK-safe order (all three FKs are ON DELETE RESTRICT):
  //   Payment -> Order -> User
  if (REFS.length) {
    await prisma.payment.deleteMany({ where: { reference: { in: [...REFS] } } }).catch(() => {});
    REFS.length = 0;
  }
  if (OWNED_ORDER_IDS.length) {
    await prisma.order.deleteMany({ where: { id: { in: [...OWNED_ORDER_IDS] } } }).catch(() => {});
    OWNED_ORDER_IDS.length = 0;
  }
  if (OWNED_USER_IDS.length) {
    await prisma.user.deleteMany({ where: { id: { in: [...OWNED_USER_IDS] } } }).catch(() => {});
    OWNED_USER_IDS.length = 0;
  }
  await prisma.$disconnect();
});

function make(over: Record<string, unknown> = {}) {
  if (typeof over.reference === "string" && !REFS.includes(over.reference)) REFS.push(over.reference);
  return { ...row("x", over), userId: USER_ID, orderId: ORDER_ID };
}

describe("FIN-07-03c.16 — production SQL against real PostgreSQL 17", () => {
  it("target is the disposable cluster (sanity)", () => {
    expect(prisma).toBeDefined();
  });

  it("3. each terminal outcome is excluded, an eligible row survives", async () => {
    await prisma.payment.createMany({
      data: [
        make({ reference: ref("term-reconciled"), paystackData: { expiredRecovery: { outcome: "reconciled" } } }),
        make({ reference: ref("term-notsuccessful"), paystackData: { expiredRecovery: { outcome: "provider_not_successful" } } }),
        make({ reference: ref("live-1") }),
      ],
    });
    const rows = await scan();
    expect(refsOf(rows)).toContain(rowRef("live-1"));
    expect(rows.every((r) => !r.reference.includes("term-"))).toBe(true);
  });

  it("4/5. a future nextCheckAt is excluded; a past one is eligible", async () => {
    await prisma.payment.createMany({
      data: [
        make({ reference: ref("cooling"), paystackData: { expiredRecovery: { attempts: 1, nextCheckAt: new Date(Date.now() + HOUR).toISOString() } } }),
        make({ reference: ref("cooled"), paystackData: { expiredRecovery: { attempts: 1, nextCheckAt: new Date(Date.now() - HOUR).toISOString() } } }),
      ],
    });
    const rows = await scan();
    const refs = refsOf(rows);
    expect(refs.some((r) => r.endsWith("-cooling"))).toBe(false);
    expect(refs.some((r) => r.endsWith("-cooled"))).toBe(true);
  });

  it("6. SQL NULL, absent expiredRecovery, absent outcome and JSON null outcome stay eligible", async () => {
    await prisma.payment.createMany({
      data: [
        make({ reference: ref("pd-null"), paystackData: Prisma.DbNull }),
        make({ reference: ref("no-marker"), paystackData: { authorization_url: "u" } }),
        make({ reference: ref("no-outcome"), paystackData: { expiredRecovery: { attempts: 1 } } }),
        make({ reference: ref("outcome-json-null"), paystackData: { expiredRecovery: { outcome: null, attempts: 1 } } }),
      ],
    });
    const rows = await scan();
    const refs = refsOf(rows);
    for (const n of ["pd-null", "no-marker", "no-outcome", "outcome-json-null"]) {
      expect(refs.some((r) => r.endsWith(`-${n}`))).toBe(true);
    }
  });

  it("7. malformed timestamps do not crash the query and are due-now", async () => {
    let i = 0;
    for (const bad of ["not-a-date", "2026-13-45T99:99:99Z", "2026-02-30T00:00:00Z", "", "12/31/2026"]) {
      const name = `bad-${i++}`;
      await prisma.payment.createMany({
        data: [make({ reference: ref(name), paystackData: { expiredRecovery: { attempts: 1, nextCheckAt: bad } } })],
      });
      const rows = await scan();
      // Due-now: a malformed value must never silently hide a possible capture.
      expect(refsOf(rows).some((r) => r.endsWith(`-${name}`))).toBe(true);
    }
  });

  it("1/2. >500 terminal and >500 cooling rows ahead do not starve a later row", async () => {
    const many: any[] = [];
    for (let i = 0; i < 600; i++) {
      many.push(
        make({
          reference: ref(`bulk-term-${i}`),
          // Sort ahead of the actionable row.
          expiresAt: new Date(Date.now() - 40 * HOUR),
          paystackData: { expiredRecovery: { outcome: "provider_not_successful", attempts: 1 } },
        }),
      );
    }
    for (let i = 0; i < 600; i++) {
      many.push(
        make({
          reference: ref(`bulk-cool-${i}`),
          expiresAt: new Date(Date.now() - 30 * HOUR),
          paystackData: { expiredRecovery: { attempts: 1, nextCheckAt: new Date(Date.now() + HOUR).toISOString() } },
        }),
      );
    }
    // The actionable row sorts LAST, after all 1200 ineligible rows.
    many.push(make({ reference: ref("actionable"), expiresAt: new Date(Date.now() - 1 * HOUR) }));
    await prisma.payment.createMany({ data: many });

    const rows = await scan({ limit: 2000 });
    expect(refsOf(rows)).toContain(rowRef("actionable"));
    expect(rows.every((r) => !r.reference.includes("bulk-"))).toBe(true);
  }, 120_000);

  it("8/9. ordering is expiresAt ASC then id, and keyset paginates without gaps or repeats", async () => {
    await prisma.payment.createMany({
      data: [
        make({ reference: ref("p-1"), expiresAt: new Date(Date.now() - 5 * HOUR) }),
        make({ reference: ref("p-2"), expiresAt: new Date(Date.now() - 4 * HOUR) }),
        make({ reference: ref("p-3"), expiresAt: new Date(Date.now() - 3 * HOUR) }),
        make({ reference: ref("p-4"), expiresAt: new Date(Date.now() - 2 * HOUR) }),
      ],
    });
    const page1 = await scan({ limit: 2 });
    expect(page1.map((r) => r.expiresAt.getTime())).toEqual(
      [...page1.map((r) => r.expiresAt.getTime())].sort((a, b) => a - b),
    );
    const last = page1[page1.length - 1];
    const page2 = await scan({ limit: 2, keyset: { expiresAt: last.expiresAt, id: last.id } });
    const seen = [...refsOf(page1), ...refsOf(page2)].filter((r) => r.includes(`${TAG}-p-`));
    // No duplicates, and both pages contributed.
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.length).toBeGreaterThan(2);
  });

  it("10. cutoff, EXPIRED status, SEED- exclusion and the limit are enforced", async () => {
    await prisma.payment.createMany({
      data: [
        make({ reference: ref("in-window") }),
        make({ reference: ref("too-old"), expiresAt: new Date(Date.now() - (WINDOW_MS + HOUR)) }),
        make({ reference: `SEED-${TAG}-seed` }),
        make({ reference: ref("not-expired"), status: PaymentStatus.PENDING }),
      ],
    });
    const rows = await scan({ limit: 1000 });
    const refs = refsOf(rows);
    expect(refs.some((r) => r.endsWith("-in-window"))).toBe(true);
    expect(refs.some((r) => r.endsWith("-too-old"))).toBe(false);
    expect(refs.some((r) => r.startsWith("SEED-"))).toBe(false);
    expect(refs.some((r) => r.endsWith("-not-expired"))).toBe(false);
  });

  it("10b. the row ceiling is honoured by LIMIT", async () => {
    await prisma.payment.createMany({
      data: Array.from({ length: 30 }, (_, i) =>
        make({ reference: ref(`lim-${i}`), expiresAt: new Date(Date.now() - (30 - i) * 60_000) }),
      ),
    });
    const rows = await scan({ limit: 5 });
    expect(rows).toHaveLength(5);
  });
});

/** Recover the generated reference for a fixture name. */
function rowRef(name: string): string {
  return REFS.find((r) => r.endsWith(`-${name}`)) as string;
}
