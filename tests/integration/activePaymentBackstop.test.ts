/**
 * Stage F (E-02) — partial unique backstop:
 * Payment_userId_idempotencyKey_active_key ON ("userId","idempotencyKey")
 * WHERE status IN (PENDING, INITIATED) AND key IS NOT NULL.
 * Disposable rows only; full cleanup after each test.
 */
import { PrismaClient } from "@prisma/client";

jest.setTimeout(60000);

const prisma = new PrismaClient();
const tag = `backstop-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const created = { users: [] as string[], orders: [] as string[], payments: [] as string[] };

async function makeUser(suffix: string, role: "VENDOR" | "CUSTOMER" = "CUSTOMER") {
  const u = await prisma.user.create({
    data: {
      email: `${tag}-${suffix}@x.test`,
      name: `Backstop ${suffix}`,
      role,
      roles: [role],
    },
  });
  created.users.push(u.id);
  return u;
}

async function makeOrder(customerId: string, key: string) {
  const o = await prisma.order.create({
    data: {
      customerId,
      vendorId: (await ensureVendor()).id,
      basePrice: 5000,
      totalPrice: 5500,
      status: "AWAITING_PAYMENT",
      idempotencyKey: key,
    },
  });
  created.orders.push(o.id);
  return o;
}

let vendorCache: { id: string } | null = null;

/**
 * FIN-07-04b — the vendor is created here, not borrowed from a global seed.
 *
 * This previously did `prisma.product.findFirst({ id: "seed-fin-prod-5000-a" })`
 * and dereferenced `product!.vendorId`. That row is produced by
 * src/jobs/seedFinancialFixtures.ts, which the integration workflow does not
 * run, so every test calling makeOrder() died on a null dereference before it
 * reached an assertion.
 *
 * No product is actually required: Order.vendorId is a foreign key to User
 * (relation "VendorOrders", onDelete Restrict), not to Product. So the minimal,
 * hermetic repair is to mint one VENDOR user per run and track it in
 * `created.users`, which the existing cleanup() already removes. This drops the
 * dependency on out-of-band seed state, touches no schema, and resets nothing.
 */
async function ensureVendor() {
  if (vendorCache) return vendorCache;
  const vendor = await makeUser("vendor", "VENDOR");
  vendorCache = { id: vendor.id };
  return vendorCache;
}

async function makePayment(
  suffix: string,
  input: { userId: string; orderId: string; key: string | null; status: "PENDING" | "INITIATED" | "SUCCESS" | "FAILED" | "EXPIRED" },
) {
  const p = await prisma.payment.create({
    data: {
      userId: input.userId,
      orderId: input.orderId,
      amount: 550000,
      reference: `${tag}-ref-${suffix}`.toUpperCase().slice(0, 40),
      status: input.status,
      idempotencyKey: input.key,
      expiresAt: new Date(Date.now() + 15 * 60_000),
    },
  });
  created.payments.push(p.id);
  return p;
}

async function cleanup() {
  if (created.payments.length)
    await prisma.payment.deleteMany({ where: { id: { in: created.payments } } }).catch(() => {});
  if (created.orders.length)
    await prisma.order.deleteMany({ where: { id: { in: created.orders } } }).catch(() => {});
  if (created.users.length)
    await prisma.user.deleteMany({ where: { id: { in: created.users } } }).catch(() => {});
  created.users.length = 0;
  created.orders.length = 0;
  created.payments.length = 0;
  // The vendor is one of the tracked users and is deleted above, so the cached
  // id must be dropped too — otherwise the next test reuses a User that no
  // longer exists and Order_vendorId_fkey rejects it.
  vendorCache = null;
}

afterEach(cleanup);
afterAll(async () => {
  await prisma.$disconnect();
});

/**
 * FIN-07-04a — why this is not just `isP2002`.
 *
 * The invariant is enforced by the PARTIAL unique index
 * "Payment_userId_idempotencyKey_active_key" (migration
 * 20261006203325_phase_3_2f_active_payment_backstop):
 *
 *   CREATE UNIQUE INDEX ... ON "Payment" ("userId","idempotencyKey")
 *     WHERE "status" IN ('PENDING','INITIATED') AND "idempotencyKey" IS NOT NULL;
 *
 * When two inserts race on the same partial index, PostgreSQL may reject the
 * loser either way:
 *   * 23505 unique_violation        -> Prisma P2002
 *   * 40001 serialization_failure  -> Prisma P2010 wrapping the raw error
 *
 * Which one occurs depends on the interleaving, so asserting a single code
 * tests PostgreSQL's error-reporting choice rather than the invariant this test
 * exists to protect. The accepted set is deliberately narrow:
 *
 *   * P2002                        — unique-constraint conflict
 *   * P2010 with underlying 40001  — serialization failure, and nothing else
 *
 * P2014 (required relation not found) is NOT accepted: it describes a different
 * operation and is not an expected outcome of this insert. Any other error —
 * a real connection failure, a missing column, a genuine application bug — is
 * still rejected, so the test cannot pass by swallowing a genuine fault.
 */
function isExpectedConcurrentConflict(err: unknown): boolean {
  const e = err as {
    code?: string;
    meta?: { code?: string; message?: string; modelName?: string; target?: string[] };
    message?: string;
  } | null;

  if (e?.code === "P2002") {
    // FIN-07-04c: accept P2002 ONLY for the active-payment backstop.
    //
    // The constraint is the partial unique index created by migration
    // 20261006203325_phase_3_2f_active_payment_backstop:
    //   CREATE UNIQUE INDEX "Payment_userId_idempotencyKey_active_key"
    //     ON "Payment" ("userId","idempotencyKey")
    //     WHERE "status" IN ('PENDING','INITIATED') AND "idempotencyKey" IS NOT NULL;
    //
    // The shape below was established empirically against PostgreSQL 17.10 by
    // provoking this exact violation and reading the thrown error, NOT assumed:
    //   code       = "P2002"
    //   meta       = {"modelName":"Payment","target":["userId","idempotencyKey"]}
    //
    // So a P2002 raised by any OTHER unique constraint on Payment — notably
    // "Payment_reference_key", which the concurrent inserts also touch — carries
    // a different target and is REJECTED. That is the point of the narrowing: a
    // duplicate reference would otherwise satisfy this test while the active
    // -payment invariant was never actually exercised.
    if (e.meta?.modelName !== "Payment") return false;
    const target = e.meta?.target;
    if (!Array.isArray(target)) return false;
    const fields = [...target].sort();
    return fields.length === 2 && fields[0] === "idempotencyKey" && fields[1] === "userId";
  }

  if (e?.code === "P2010") {
    // Serialization failure only. PostgreSQL 40001 is what a concurrent insert
    // loser against the same partial index actually produced in this suite.
    const underlying = String(e?.meta?.code ?? e?.meta?.message ?? e?.message ?? "");
    return underlying.includes("40001");
  }

  return false;
}

describe("E-02 partial unique backstop", () => {
  it("guard: the partial unique index exists with the intended predicate", async () => {
    const rows = (await prisma.$queryRaw`
      SELECT indexdef FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname = 'Payment_userId_idempotencyKey_active_key'
    `) as { indexdef: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].indexdef).toContain("UNIQUE");
    expect(rows[0].indexdef).toContain('"userId"');
    expect(rows[0].indexdef).toContain('"idempotencyKey"');
    expect(rows[0].indexdef).toContain("PENDING");
    expect(rows[0].indexdef).toContain("INITIATED");
  });

  it("Test A: PENDING + PENDING same user/key is rejected", async () => {
    const user = await makeUser("a");
    const order = await makeOrder(user.id, `${tag}-key-a`);
    await makePayment("a1", { userId: user.id, orderId: order.id, key: `${tag}-key-a`, status: "PENDING" });
    await expect(
      makePayment("a2", { userId: user.id, orderId: order.id, key: `${tag}-key-a`, status: "PENDING" }),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  it("Test B: PENDING + INITIATED same user/key cannot coexist", async () => {
    const user = await makeUser("b");
    const order = await makeOrder(user.id, `${tag}-key-b`);
    await makePayment("b1", { userId: user.id, orderId: order.id, key: `${tag}-key-b`, status: "PENDING" });
    await expect(
      makePayment("b2", { userId: user.id, orderId: order.id, key: `${tag}-key-b`, status: "INITIATED" }),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  it("Test C: terminal SUCCESS history with the same key is allowed", async () => {
    const user = await makeUser("c");
    const order = await makeOrder(user.id, `${tag}-key-c`);
    const first = await makePayment("c1", {
      userId: user.id, orderId: order.id, key: `${tag}-key-c`, status: "PENDING",
    });
    await prisma.payment.update({ where: { id: first.id }, data: { status: "SUCCESS" } });
    const second = await makePayment("c2", {
      userId: user.id, orderId: order.id, key: `${tag}-key-c`, status: "PENDING",
    });
    expect(second.id).toBeDefined();
  });

  it("Test D: concurrent creates converge to one active payment", async () => {
    const user = await makeUser("d");
    const order = await makeOrder(user.id, `${tag}-key-d`);
    const results = await Promise.allSettled([
      makePayment("d1", { userId: user.id, orderId: order.id, key: `${tag}-key-d`, status: "PENDING" }),
      makePayment("d2", { userId: user.id, orderId: order.id, key: `${tag}-key-d`, status: "PENDING" }),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    // The loser must be a genuine concurrency conflict, not an arbitrary error.
    expect(
      isExpectedConcurrentConflict((rejected[0] as PromiseRejectedResult).reason),
    ).toBe(true);
    expect(
      await prisma.payment.count({
        where: { userId: user.id, idempotencyKey: `${tag}-key-d` },
      }),
    ).toBe(1);
  });

  it("Test G: same key different users remains allowed", async () => {
    const u1 = await makeUser("g1");
    const u2 = await makeUser("g2");
    const o1 = await makeOrder(u1.id, `${tag}-key-g`);
    const o2 = await makeOrder(u2.id, `${tag}-key-g`);
    await makePayment("g1", { userId: u1.id, orderId: o1.id, key: `${tag}-key-g`, status: "PENDING" });
    const second = await makePayment("g2", { userId: u2.id, orderId: o2.id, key: `${tag}-key-g`, status: "PENDING" });
    expect(second.id).toBeDefined();
  });

  it("Test H: same user different keys remains allowed", async () => {
    const user = await makeUser("h");
    const o1 = await makeOrder(user.id, `${tag}-key-h1`);
    const o2 = await makeOrder(user.id, `${tag}-key-h2`);
    await makePayment("h1", { userId: user.id, orderId: o1.id, key: `${tag}-key-h1`, status: "PENDING" });
    const second = await makePayment("h2", { userId: user.id, orderId: o2.id, key: `${tag}-key-h2`, status: "PENDING" });
    expect(second.id).toBeDefined();
  });
});
