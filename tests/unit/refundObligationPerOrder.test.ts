/**
 * Track B / Phase 3.2 — Finding C-1 regression tests.
 *
 * THE DEFECT
 * ----------
 * A refund obligation is filed when a paid order dies — the customer cancels
 * it, or the vendor never confirms and the timeout worker cancels it. BOTH
 * paths de-duplicated with
 *
 *     refundRequest.findFirst({ where: { paymentRef, status: { in: [open…] } } })
 *
 * and then created the row with `orderId: order.id`.
 *
 * The lookup omitted `orderId`, so `paymentRef` alone was not a uniqueness
 * key. One Paystack transaction can cover several vendors' orders (Payment
 * .orderId is only the *primary* order), so in a batch an unresolved request
 * filed for order A suppressed the obligation order B was owed — a silently
 * lost customer refund.
 *
 * The fix scopes the lookup with `orderId: order.id`, matching the attribution
 * used at creation and mirroring `fileRefundOwedForCancelledOrder` in
 * paymentFinalizer.service.ts. Open-status semantics and refund amounts are
 * unchanged, and a NULL-orderId row still does not match.
 *
 * WHAT THIS SUITE ACTUALLY EXERCISES
 * ----------------------------------
 * Both affected production entry points are imported and driven for real:
 *
 *   - `updateOrderStatus`               (src/controllers/orderController.ts)
 *   - `runExpireUnconfirmedVendorOrders` (src/jobs/workers jobs/…)
 *
 * There is NO local re-implementation of the dedupe algorithm. `refundRequest
 * .findFirst` is a faithful in-memory filter that evaluates whatever predicate
 * the production code passes against rows that production itself created, so a
 * revert of the fix makes these tests FAIL rather than pass vacuously: with
 * `orderId` absent from the predicate, order A's open row matches and the
 * create for order B is skipped.
 *
 * Only `src/lib/prisma` (which `src/config/prismaClient` re-exports), the
 * cache layer and the notification helper are mocked. This test file does not
 * construct a PrismaClient itself, but importing the real controller
 * transitively loads `notify` and `socket.ts`, which do construct one. No
 * database connection, Redis command or provider socket is opened.
 */
import { OrderStatus, PaymentStatus, RefundStatus } from "@prisma/client";

jest.mock("../../src/lib/prisma", () => ({
  __esModule: true,
  default: {
    order: { findUnique: jest.fn(), findMany: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
    payment: { findFirst: jest.fn(), findUnique: jest.fn() },
    refundRequest: { findFirst: jest.fn(), create: jest.fn() },
    $queryRaw: jest.fn(),
    deliveryAssignment: { updateMany: jest.fn(async () => ({ count: 0 })) },
    user: { findUnique: jest.fn() },
    auditLog: { create: jest.fn(async () => ({})) },
    $transaction: jest.fn(),
  },
}));

jest.mock("../../src/services/inventory.service", () => ({
  __esModule: true,
  restoreStockForOrders: jest.fn(async () => []),
  assertQuantityAvailable: jest.fn(),
  reserveStockForItems: jest.fn(async () => undefined),
}));

jest.mock("../../src/services/clearCaches", () => ({
  __esModule: true,
  clearProductCache: jest.fn(async () => ({ ok: true })),
  clearProductsCache: jest.fn(async () => ({ ok: true })),
}));

jest.mock("../../src/utils/activityUtils/recordActivityBundle", () => ({
  __esModule: true,
  recordActivityBundle: jest.fn(async () => undefined),
}));

import prisma from "../../src/lib/prisma";
import { updateOrderStatus } from "../../src/controllers/orderController";
import { runExpireUnconfirmedVendorOrders } from "../../src/jobs/workers jobs/expireUnconfirmedVendorOrders";

interface TableMock extends jest.Mock {
  [method: string]: any;
}
const db = prisma as unknown as Record<string, TableMock>;

// ── Fixture constants ──────────────────────────────────────────────────────
//
// ONE Paystack transaction (REFERENCE) settles TWO vendors' orders of the same
// customer — the exact multi-order shape the defect needed.
const REFERENCE = "PSK-BATCH-C1";
const BATCH_KEY = "idem-c1";
const PAYMENT_AMOUNT_KOBO = 1_000_000;

const orderA = { id: "order-A", vendorId: "vend-A", customerId: "cust-1", totalPrice: 550000 };
const orderB = { id: "order-B", vendorId: "vend-B", customerId: "cust-1", totalPrice: 450000 };

/** Rows in the RefundRequest table as production has written them. */
type RefundRow = {
  id: string;
  paymentRef: string;
  orderId: string | null;
  status: RefundStatus;
  requestedAmountKobo?: number;
  userId?: string;
  reason?: string;
};

let table: RefundRow[];
/** Rows recorded by the $queryRaw double when the insert actually wrote. */
let insertedRows: RefundRow[];
let seq: number;
/** Rows the timeout worker's candidate query will return on a fresh tick. */
let batchRows: any[];
/** CAS result for the worker's `order.updateMany` — 1 = winner, 0 = loser. */
let workerCasCount: number;

/**
 * Faithful predicate evaluation for the RefundRequest lookup.
 *
 * This is what makes the suite regression-proof: it applies the production
 * `where` to the rows production actually created. Scope every key the
 * production query provides — an omitted key simply is not tested, which is
 * exactly how a revert to payment-scoped dedupe reproduces the original defect.
 */
function rowMatches(row: RefundRow, where: Record<string, any>): boolean {
  return Object.entries(where).every(([key, expected]) => {
    if (expected && typeof expected === "object" && Array.isArray((expected as any).in)) {
      return (expected as any).in.includes(row[key as keyof RefundRow]);
    }
    return row[key as keyof RefundRow] === expected;
  });
}

function seedOpenOrder(overrides: Partial<RefundRow> = {}): void {
  table.push({
    id: `rr-seed-${table.length + 1}`,
    paymentRef: REFERENCE,
    orderId: null,
    status: RefundStatus.PENDING,
    ...overrides,
  });
}

/**
 * Rows the production INSERT actually created.
 *
 * C-2 replaced the typed `refundRequest.create` with
 * `INSERT ... ON CONFLICT DO NOTHING` (see src/services/refundObligation.service.ts),
 * so the $queryRaw double below records what the database would have written.
 */
function createdRows(): RefundRow[] {
  return insertedRows;
}

function res() {
  const r: any = {};
  r.status = jest.fn().mockReturnValue(r);
  r.json = jest.fn().mockReturnValue(r);
  return r;
}

beforeEach(() => {
  jest.clearAllMocks();
  table = [];
  insertedRows = [];
  seq = 0;
  batchRows = [];
  workerCasCount = 1;

  db.refundRequest.findFirst.mockImplementation(async ({ where }: any) => {
    return table.find((r) => rowMatches(r, where)) ?? null;
  });

  db.refundRequest.create.mockImplementation(async ({ data }: any) => {
    const row: RefundRow = { id: `rr-${++seq}`, ...data };
    table.push(row);
    insertedRows.push(row);
    return row;
  });

  // C-2: the production obligation insert is raw SQL. Model the partial unique
  // index "RefundRequest_open_obligation_per_order" faithfully: one open
  // obligation per non-NULL (paymentRef, orderId); NULL orderId is outside the
  // index; terminal statuses are outside the index. A conflict returns no rows
  // (DO NOTHING) without raising, exactly as PostgreSQL would.
  const OPEN: RefundStatus[] = [
    RefundStatus.PENDING,
    RefundStatus.APPROVED,
    RefundStatus.PROCESSING,
  ];
  db.$queryRaw.mockImplementation(
    async (strings: TemplateStringsArray, ...values: any[]) => {
      const sql = Array.from(strings as unknown as string[]).join(" ");
      if (!sql.includes('INSERT INTO "RefundRequest"')) return [];

      // Value order mirrors the production column list.
      const [id, userId, paymentRef, reason, status, , , orderId, requestedAmountKobo] =
        values as any[];

      if (orderId != null) {
        const conflicts = table.some(
          (r) =>
            r.paymentRef === paymentRef &&
            r.orderId === orderId &&
            OPEN.includes(r.status),
        );
        if (conflicts) return [];
      }

      const row: RefundRow = {
        id: id ?? `rr-${++seq}`,
        userId,
        paymentRef,
        reason,
        status: status as RefundStatus,
        orderId: orderId ?? null,
        ...(requestedAmountKobo != null ? { requestedAmountKobo } : {}),
      };
      table.push(row); // visible to later lookups, exactly as a real table would be
      insertedRows.push(row);
      return [row];
    },
  );

  db.payment.findFirst.mockImplementation(async () => ({
    id: "pay-1",
    reference: REFERENCE,
    idempotencyKey: BATCH_KEY,
    status: PaymentStatus.SUCCESS,
    amount: PAYMENT_AMOUNT_KOBO,
    refundedAmount: 0,
  }));

  // `tx` shares the same delegates as the root client, so both production paths
  // observe the same table.
  db.$transaction.mockImplementation(async (arg: any) => {
    const tx = {
      order: db.order,
      payment: db.payment,
      refundRequest: db.refundRequest,
      $queryRaw: db.$queryRaw,
      deliveryAssignment: db.deliveryAssignment,
      user: db.user,
      auditLog: db.auditLog,
    };
    return typeof arg === "function" ? arg(tx) : arg;
  });

  // The timeout worker pages with a cursor. `cursor` present => same tick, no
  // more rows. No cursor => a fresh tick, which re-selects the same candidate.
  db.order.findMany.mockImplementation(async (args: any) => {
    if (args?.cursor) return [];
    return batchRows;
  });

  db.order.updateMany.mockImplementation(async () => ({ count: workerCasCount }));
  db.order.update.mockImplementation(async (a: any) => ({ id: a.where.id, ...a.data }));
});

// ═══════════════════════════════════════════════════════════════════════════
// Path 1 — updateOrderStatus (paid customer/vendor cancellation)
// ═══════════════════════════════════════════════════════════════════════════

/** Drive the real controller far enough to reach the paid-cancel refund block. */
async function cancelOrder(id: "order-A" | "order-B") {
  const row = id === "order-A" ? orderA : orderB;
  db.order.findUnique.mockResolvedValue({
    ...row,
    status: OrderStatus.PAYMENT_CONFIRMED,
    paymentStatus: PaymentStatus.SUCCESS,
    idempotencyKey: BATCH_KEY,
    basePrice: row.totalPrice - 50000,
    deliveryFee: 50000,
    vendor: { vendorStatus: "ACTIVE" },
  });

  return updateOrderStatus(
    {
      params: { orderId: id },
      body: { status: "CANCELLED" },
      user: { id: row.customerId, role: "CUSTOMER", sessionId: "sess-1" },
    } as never,
    res(),
  );
}

describe("paid cancel (updateOrderStatus) — obligations are deduplicated per order", () => {
  it("1. an unresolved obligation for order A does not suppress order B's under the same paymentRef", async () => {
    // Order A already has an open obligation from an earlier cancellation.
    seedOpenOrder({ orderId: "order-A", status: RefundStatus.PENDING });

    await cancelOrder("order-B");

    expect(createdRows()).toHaveLength(1);
    expect(createdRows()[0]).toMatchObject({
      paymentRef: REFERENCE,
      orderId: "order-B",
      status: RefundStatus.PENDING,
      // Bounded by B's own paid value, never the batch payment total.
      requestedAmountKobo: 450000,
      userId: "cust-1",
    });
    // The lookup was scoped to the order being cancelled.
    expect(db.refundRequest.findFirst.mock.calls[0][0].where).toMatchObject({
      paymentRef: REFERENCE,
      orderId: "order-B",
    });
  });

  it("2. an existing unresolved obligation for the SAME order prevents a duplicate", async () => {
    seedOpenOrder({ orderId: "order-B", status: RefundStatus.PROCESSING });

    await cancelOrder("order-B");

    expect(db.refundRequest.findFirst).toHaveBeenCalled();
    expect(createdRows()).toHaveLength(0);
  });

  it("3. a null-orderId obligation does not suppress an order-scoped obligation", async () => {
    // Legacy/unattributed open row under the same payment. It is not a per-order
    // obligation, so it must not be treated as one.
    seedOpenOrder({ orderId: null, status: RefundStatus.PENDING });

    await cancelOrder("order-B");

    expect(createdRows()).toHaveLength(1);
    expect(createdRows()[0].orderId).toBe("order-B");
  });

  it.each([RefundStatus.COMPLETED, RefundStatus.FAILED, RefundStatus.REJECTED])(
    "4. a settled (%s) obligation for the same order does not block a new one",
    async (status) => {
      // Open-status semantics are unchanged: only PENDING/APPROVED/PROCESSING
      // count as unresolved.
      seedOpenOrder({ orderId: "order-B", status });

      await cancelOrder("order-B");

      expect(createdRows()).toHaveLength(1);
      expect(createdRows()[0].orderId).toBe("order-B");
    },
  );

  it("5. both orders of one batch each receive exactly one obligation", async () => {
    await cancelOrder("order-A");
    await cancelOrder("order-B");

    expect(createdRows().map((r) => r.orderId).sort()).toEqual(["order-A", "order-B"]);
    // Each bounded by its own order's paid value; neither used the total.
    expect(createdRows().map((r) => r.requestedAmountKobo).sort()).toEqual([450000, 550000]);
  });

  it("6. the customer's own unpaid cancellation files nothing (paid-cancel guard unchanged)", async () => {
    // Guards against a regression in the other direction: only a PAID order
    // that actually dies may owe a refund.
    db.order.findUnique.mockResolvedValue({
      ...orderA,
      status: OrderStatus.AWAITING_PAYMENT,
      paymentStatus: PaymentStatus.PENDING,
      idempotencyKey: BATCH_KEY,
      vendor: { vendorStatus: "ACTIVE" },
    });

    await updateOrderStatus(
      {
        params: { orderId: "order-A" },
        body: { status: "CANCELLED" },
        user: { id: "cust-1", role: "CUSTOMER", sessionId: "sess-1" },
      } as never,
      res(),
    );

    expect(createdRows()).toHaveLength(0);
    expect(db.refundRequest.findFirst).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Path 2 — runExpireUnconfirmedVendorOrders (vendor-timeout cancellation)
// ═══════════════════════════════════════════════════════════════════════════

/** One PAYMENT_CONFIRMED order past its deadline, as the worker selects it. */
function timeoutCandidate(row: typeof orderA | typeof orderB) {
  return {
    id: row.id,
    customerId: row.customerId,
    vendorId: row.vendorId,
    totalPrice: row.totalPrice,
    idempotencyKey: BATCH_KEY,
    paidAt: new Date(Date.now() - 60 * 60 * 1000),
  };
}

describe("vendor timeout (runExpireUnconfirmedVendorOrders) — obligations are deduplicated per order", () => {
  it("7. one batch tick files an obligation for EVERY dead order, not just the first", async () => {
    batchRows = [timeoutCandidate(orderA), timeoutCandidate(orderB)];

    await runExpireUnconfirmedVendorOrders();

    expect(createdRows()).toHaveLength(2);
    expect(createdRows().map((r) => r.orderId).sort()).toEqual(["order-A", "order-B"]);
    expect(createdRows().map((r) => r.requestedAmountKobo).sort()).toEqual([450000, 550000]);
    for (const call of db.refundRequest.findFirst.mock.calls) {
      expect(call[0].where).toMatchObject({ paymentRef: REFERENCE });
      expect(call[0].where.orderId).toBeDefined();
    }
  });

  it("8. repeating the tick does not file a second obligation for the same order", async () => {
    // The sweep re-selects the candidate on the next tick; the open-request
    // guard is what makes a retry safe.
    batchRows = [timeoutCandidate(orderA)];

    await runExpireUnconfirmedVendorOrders();
    await runExpireUnconfirmedVendorOrders();

    expect(db.refundRequest.findFirst).toHaveBeenCalledTimes(2);
    expect(createdRows()).toHaveLength(1);
    expect(createdRows()).toHaveLength(1);
    expect(createdRows()[0]).toMatchObject({ orderId: "order-A", requestedAmountKobo: 550000 });
  });

  it("9. a null-orderId obligation does not suppress the timeout worker's obligation", async () => {
    seedOpenOrder({ orderId: null, status: RefundStatus.PENDING });
    batchRows = [timeoutCandidate(orderB)];

    await runExpireUnconfirmedVendorOrders();

    expect(createdRows()).toHaveLength(1);
    expect(createdRows()[0]).toMatchObject({ orderId: "order-B", requestedAmountKobo: 450000 });
  });

  it("10. a CAS loser files nothing at all", async () => {
    // Another writer moved the order first; this run must not owe a refund.
    workerCasCount = 0;
    batchRows = [timeoutCandidate(orderA)];

    await runExpireUnconfirmedVendorOrders();

    expect(createdRows()).toHaveLength(0);
    expect(db.refundRequest.findFirst).not.toHaveBeenCalled();
  });

  it("11. no SUCCESS payment for the batch means no obligation", async () => {
    db.payment.findFirst.mockResolvedValue(null);
    batchRows = [timeoutCandidate(orderA)];

    await runExpireUnconfirmedVendorOrders();

    expect(createdRows()).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Vacuity guard
// ═══════════════════════════════════════════════════════════════════════════
//
// The regression protection rests on ONE property: the matcher used by the
// `refundRequest.findFirst` double applies whatever predicate production sends
// to the rows production actually created. If it always matched, or if it
// ignored `orderId`, a revert of the C-1 fix would leave this suite green.
// These tests demonstrate the sensitivity directly, against the same table and
// the same matcher the production paths run through.

describe("vacuity guard — the suite fails if the order-scoped dedupe is reverted", () => {
  const PRE_FIX_WHERE = {
    paymentRef: REFERENCE,
    status: {
      in: [RefundStatus.PENDING, RefundStatus.APPROVED, RefundStatus.PROCESSING],
    },
  };

  it("the pre-fix predicate WOULD match the sibling's open row, so reverting suppresses order B's create", async () => {
    seedOpenOrder({ orderId: "order-A", status: RefundStatus.PENDING });

    // Payment-scoped, exactly as the defect shipped: order A's open row matches,
    // so production would take the `if (!existing)` branch and skip the create.
    await expect(
      db.refundRequest.findFirst({ where: PRE_FIX_WHERE }),
    ).resolves.toMatchObject({ orderId: "order-A" });

    // Adding the orderId — the fix — makes the very same row stop matching.
    await expect(
      db.refundRequest.findFirst({ where: { ...PRE_FIX_WHERE, orderId: "order-B" } }),
    ).resolves.toBeNull();
  });

  it("the pre-fix predicate WOULD also be satisfied by a null-orderId row", async () => {
    seedOpenOrder({ orderId: null, status: RefundStatus.PENDING });

    // The open row itself still matches when scoped to its own (absent) order…
    await expect(
      db.refundRequest.findFirst({ where: { ...PRE_FIX_WHERE, orderId: null } }),
    ).resolves.toMatchObject({ orderId: null });
    // …but never for a concrete order, which is what test 3 relies on.
    await expect(
      db.refundRequest.findFirst({ where: { ...PRE_FIX_WHERE, orderId: "order-B" } }),
    ).resolves.toBeNull();
  });

  it("every production lookup on BOTH paths is order-scoped", async () => {
    // A revert removes `orderId` from the predicate; that alone fails this.
    await cancelOrder("order-B");
    batchRows = [timeoutCandidate(orderA)];
    await runExpireUnconfirmedVendorOrders();

    expect(db.refundRequest.findFirst).toHaveBeenCalled();
    for (const call of db.refundRequest.findFirst.mock.calls) {
      expect(call[0].where).toMatchObject({
        paymentRef: REFERENCE,
        orderId: expect.any(String),
      });
    }
  });
});
