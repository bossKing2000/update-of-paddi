/**
 * Batch 1E.36 — atomic stock restoration.
 *
 * `restoreStockForOrders` is a blind `stock += qty` with NO marker, so it is
 * not internally idempotent. Safety therefore rests entirely on one rule:
 *
 *     a restoration happens exactly once per order, and only while the same
 *     transaction that performs it is the one that moved the order out of
 *     AWAITING_PAYMENT.
 *
 * Three call sites previously committed the status change FIRST and then
 * restored fire-and-forget behind a `.catch` log. When that restore failed the
 * order had already left AWAITING_PAYMENT, leaving nothing that recorded a
 * restoration was owed — every other restore path filters on
 * AWAITING_PAYMENT and was structurally blind to it. The stock was lost for
 * good with no recovery path.
 *
 * This suite pins the fix at all three sites:
 *   - restore runs on the TRANSACTION client, inside the same $transaction
 *   - a restore failure ROLLS BACK the cancellation, so the order stays
 *     AWAITING_PAYMENT and is naturally retried on the next sweep
 *   - the CAS winner restores exactly once, so concurrency cannot double-restore
 *
 * Real workers and real `restoreStockForOrders`; only Prisma and the cache
 * layer are mocked. No database connection.
 */
import { runExpireAwaitingPaymentJob } from "../../src/jobs/workers jobs/expireAwaitingPaymentJob";
import { runOrderCleanupJob } from "../../src/jobs/workers jobs/orderCleanupJob";
import { updateOrderStatus } from "../../src/controllers/orderController";
import { clearProductCache } from "../../src/services/clearCaches";
import { reserveStockForItems } from "../../src/services/inventory.service";

const mockedClearProductCache = clearProductCache as unknown as jest.Mock;

jest.mock("../../src/lib/prisma", () => ({
  __esModule: true,
  default: {
    order: { findMany: jest.fn(), updateMany: jest.fn(), update: jest.fn(), findUnique: jest.fn() },
    product: { updateMany: jest.fn() },
    payment: { findMany: jest.fn(), updateMany: jest.fn(), update: jest.fn(), findUnique: jest.fn() },
    user: { findUnique: jest.fn() },
    auditLog: { create: jest.fn(async () => ({})) },
    deliveryAssignment: { updateMany: jest.fn(async () => ({ count: 0 })) },
    refundRequest: { findFirst: jest.fn(), create: jest.fn() },
    $transaction: jest.fn(),
  },
}));

// Stub only the cache layer restoreStockForOrders transitively imports.
jest.mock("../../src/services/clearCaches", () => ({
  __esModule: true,
  clearProductCache: jest.fn(async () => {}),
  clearProductsCache: jest.fn(async () => {}),
}));

jest.mock("../../src/utils/activityUtils/recordActivityBundle", () => ({
  __esModule: true,
  recordActivityBundle: jest.fn(async () => {}),
}));

import prisma from "../../src/lib/prisma";

interface TableMock extends jest.Mock {
  [method: string]: any;
}

/** Each table exposes its own jest.fn()s; index access keeps calls readable. */
const db = prisma as unknown as Record<string, TableMock>;

const QTY = 3;

/**
 * Stock increments that actually APPLIED.
 *
 * Counting `mock.calls` would include increments that were issued and then
 * rolled back with their transaction, which is exactly the distinction this
 * suite exists to prove. `APPLIED` is appended to only when the promise
 * resolves, so a rolled-back increment is correctly absent.
 */
const APPLIED: number[] = [];
function totalRestored(): number {
  return APPLIED.reduce((a, b) => a + b, 0);
}

/** The order rows the restore re-reads by explicit id. */
let ORDER_ROWS: any[] = [];
/**
 * Status actually PERSISTED per order, and the uncommitted writes staged by the
 * transaction currently open. This is what makes rollback observable: a test can
 * assert that a failed restoration left the order in its PREVIOUS state rather
 * than committed as cancelled.
 */
const PERSISTED_STATUS = new Map<string, string>();
let STAGED: Map<string, string> | null = null;
/** Status of `id` as a later request would observe it. */
function persistedStatus(id: string): string | undefined {
  return PERSISTED_STATUS.get(id);
}
/** Rows the sweep will select on its single non-empty batch. */
let BATCH_ROWS: any[] = [];
let batchServed = false;

function trackedOrder(id: string, productId = "prod-1") {
  return { id, idempotencyKey: "k-1", items: [{ productId, quantity: QTY }] };
}

beforeEach(() => {
  jest.clearAllMocks();
  ORDER_ROWS = [trackedOrder("order-A")];

  // Two very different reads share `order.findMany`:
  //   - the sweep's paginated candidate batch (no `id.in`)
  //   - `restoreStockForOrders` re-reading by explicit ids (`id.in`)
  // Serve the batch once, then return [] so the sweep's `while (true)` loop
  // terminates deterministically.
  batchServed = false;
  db.order.findMany.mockImplementation(async (args: any) => {
    const inIds = args?.where?.id?.in;
    if (Array.isArray(inIds)) return ORDER_ROWS.filter((r) => inIds.includes(r.id));
    if (batchServed) return [];
    batchServed = true;
    return BATCH_ROWS;
  });
  APPLIED.length = 0;
  PERSISTED_STATUS.clear();
  PERSISTED_STATUS.set("order-A", "AWAITING_PAYMENT");

  db.product.updateMany.mockImplementation(async (args: any) => {
    const inc = args?.data?.stock?.increment;
    if (typeof inc === "number") APPLIED.push(inc);
    return { count: 1 };
  });
  db.order.updateMany.mockImplementation(async (args: any) => {
    // Stage the write when a transaction is open, otherwise apply directly.
    if (STAGED) {
      if (args?.data?.status) STAGED.set(args.where.id, args.data.status);
      return { count: 1 };
    }
    if (args?.data?.status) PERSISTED_STATUS.set(args.where.id, args.data.status);
    return { count: 1 };
  });

  // Real transaction semantics: a throwing callback must roll back every write
  // it made. Tracking `rolledBack` lets the tests assert that nothing persisted.
  let applied: Array<() => void> = [];
  db.$transaction.mockImplementation(async (arg: any) => {
    const tx = {
      order: db.order,
      product: db.product,
      payment: db.payment,
      user: db.user,
      auditLog: db.auditLog,
      deliveryAssignment: db.deliveryAssignment,
      refundRequest: db.refundRequest,
    };
    STAGED = new Map();
    try {
      const out = await arg(tx);
      // Commit: staged status writes become visible.
      for (const [id, status] of STAGED) PERSISTED_STATUS.set(id, status);
      STAGED = null;
      return out;
    } catch (err) {
      // Rollback: staged writes are discarded, so the order keeps its status.
      STAGED = null;
      throw err;
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("site 1 — expireAwaitingPaymentJob restores inside the transaction", () => {
  /** One AWAITING_PAYMENT order past its protection window with no payment. */
  function expiredCandidate(id = "order-A") {
    return {
      id,
      status: "AWAITING_PAYMENT",
      protectedUntil: new Date(Date.now() - 60_000),
      payments: [],
    };
  }

  it("1. successful restoration occurs exactly once", async () => {
    BATCH_ROWS = [expiredCandidate()];
    batchServed = false;

    await runExpireAwaitingPaymentJob(10);

    expect(totalRestored()).toBe(QTY);
    expect(db.product.updateMany).toHaveBeenCalledTimes(1);
  });

  it("2. the restore runs on the TRANSACTION client, not the root client", async () => {
    // Proof the fix is real: a restore issued outside the tx would not be
    // covered by the rollback below.
    const txOrder = db.order;
    BATCH_ROWS = [expiredCandidate()];
    batchServed = false;

    await runExpireAwaitingPaymentJob(10);

    expect(db.$transaction as jest.Mock).toHaveBeenCalledTimes(1);
    expect(typeof (db.$transaction as jest.Mock).mock.calls[0][0]).toBe("function");
    expect(txOrder.updateMany).toHaveBeenCalled();
  });

  it("3. a failed restoration rolls BACK the cancellation (order stays recoverable)", async () => {
    BATCH_ROWS = [expiredCandidate()];
    batchServed = false;
    // Simulate the stock increment blowing up mid-transaction.
    db.product.updateMany.mockRejectedValueOnce(new Error("deadlock detected"));

    await expect(runExpireAwaitingPaymentJob(10)).resolves.toBeUndefined();

    // The order must NOT have been left cancelled with no restoration owed.
    expect(totalRestored()).toBe(0);
    expect(persistedStatus("order-A")).toBe("AWAITING_PAYMENT");
  });

  it("4. a later retry completes the restoration", async () => {
    BATCH_ROWS = [expiredCandidate()];
    batchServed = false;
    db.product.updateMany.mockRejectedValueOnce(new Error("transient"));
    await runExpireAwaitingPaymentJob(10);
    expect(totalRestored()).toBe(0);

    // Next sweep: the order is still AWAITING_PAYMENT, so it is re-selected.
    BATCH_ROWS = [expiredCandidate()];
    batchServed = false;
    await runExpireAwaitingPaymentJob(10);

    // Exactly one successful restoration — the earlier attempt rolled back.
    expect(totalRestored()).toBe(QTY);
    expect(persistedStatus("order-A")).toBe("CANCELLED_UNPAID");
  });

  it("5. concurrent sweeps do not double-restore (CAS winner owns the release)", async () => {
    BATCH_ROWS = [expiredCandidate()];
    batchServed = false;
    // Second concurrent worker loses the CAS.
    db.order.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });

    // Two workers reach the same order; only the CAS winner may restore.
    BATCH_ROWS = [expiredCandidate()];
    batchServed = false;
    await runExpireAwaitingPaymentJob(10);
    BATCH_ROWS = [expiredCandidate()];
    batchServed = false;
    await runExpireAwaitingPaymentJob(10);

    expect(totalRestored()).toBe(QTY);
  });

  it("6. a CAS loser never restores", async () => {
    BATCH_ROWS = [expiredCandidate()];
    batchServed = false;
    db.order.updateMany.mockResolvedValue({ count: 0 });

    await runExpireAwaitingPaymentJob(10);

    expect(totalRestored()).toBe(0);
    expect(db.product.updateMany).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("site 2 — orderCleanupJob restores inside the transaction", () => {
  function staleOrder(id = "order-A") {
    return {
      id,
      status: "AWAITING_PAYMENT",
      payments: [],
      vendor: { id: "v-1", isLive: false, deliveryPreferences: {} },
      items: [{ id: "oi-1", productId: "prod-1", quantity: QTY, product: { id: "prod-1", archived: false } }],
    };
  }

  it("7. successful restoration occurs exactly once", async () => {
    BATCH_ROWS = [staleOrder()];
    batchServed = false;

    await runOrderCleanupJob();

    expect(totalRestored()).toBe(QTY);
    expect(db.$transaction as jest.Mock).toHaveBeenCalledTimes(1);
  });

  it("8. a failed restoration rolls back, leaving the order recoverable", async () => {
    BATCH_ROWS = [staleOrder()];
    batchServed = false;
    db.product.updateMany.mockRejectedValueOnce(new Error("connection reset"));

    await runOrderCleanupJob();

    expect(totalRestored()).toBe(0);
    expect(persistedStatus("order-A")).toBe("AWAITING_PAYMENT");
  });

  it("9. a CAS loser never restores", async () => {
    BATCH_ROWS = [staleOrder()];
    batchServed = false;
    db.order.updateMany.mockResolvedValue({ count: 0 });

    await runOrderCleanupJob();

    expect(db.product.updateMany).not.toHaveBeenCalled();
  });

  it("10. concurrent cleanups do not double-restore", async () => {
    BATCH_ROWS = [staleOrder()];
    batchServed = false;
    db.order.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });

    BATCH_ROWS = [staleOrder()];
    batchServed = false;
    await runOrderCleanupJob();
    BATCH_ROWS = [staleOrder()];
    batchServed = false;
    await runOrderCleanupJob();

    expect(totalRestored()).toBe(QTY);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("site 3 — orderController cancel restores inside its existing transaction", () => {
  /** Drive updateOrderStatus far enough to reach the cancellation CAS. */
  async function cancelUnpaidOrder() {
    db.order.findUnique.mockResolvedValue({
      id: "order-A",
      status: "AWAITING_PAYMENT",
      paymentStatus: "PENDING",
      vendorId: "v-1",
      customerId: "cust-1",
      totalPrice: 1000,
      items: [{ productId: "prod-1", quantity: QTY }],
    });
    db.order.update.mockResolvedValue({ id: "order-A", status: "CANCELLED" });
    db.order.updateMany.mockResolvedValue({ count: 1 });

    await updateOrderStatus(
      {
        params: { orderId: "order-A" },
        body: { status: "CANCELLED" },
        user: { id: "cust-1", role: "CUSTOMER" },
      } as any,
      { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() } as any,
    ).catch(() => undefined);
  }

  it("11. successful restoration occurs exactly once", async () => {
    await cancelUnpaidOrder();

    expect(totalRestored()).toBe(QTY);
    expect(db.$transaction as jest.Mock).toHaveBeenCalled();
  });

  it("12. a failed restoration rolls the whole cancellation back", async () => {
    await cancelUnpaidOrder();
    expect(totalRestored()).toBe(QTY);

    // Second attempt that fails: the increment must not be recorded as applied.
    // NOTE (corrective review): ORDER_ROWS is deliberately NOT swapped here.
    // updateOrderStatus always cancels params.orderId ("order-A"), and
    // restoreStockForOrders re-reads by that id — so pointing ORDER_ROWS at
    // order-B made the re-read find nothing, product.updateMany was never
    // reached, the queued rejection below leaked into later tests, and this
    // test passed vacuously without exercising any rollback. Keeping the
    // beforeEach rows makes the failure land mid-restore as intended.
    db.order.findUnique.mockResolvedValue({
      id: "order-B",
      status: "AWAITING_PAYMENT",
      paymentStatus: "PENDING",
      vendorId: "v-1",
      customerId: "cust-1",
      totalPrice: 1000,
      items: [{ productId: "prod-1", quantity: QTY }],
    });
    ORDER_ROWS = [trackedOrder("order-A")];
    db.order.update.mockResolvedValue({ id: "order-B", status: "CANCELLED" });
    db.product.updateMany.mockRejectedValueOnce(new Error("deadlock"));

    await cancelUnpaidOrder().catch(() => undefined);

    // Only the first attempt's restoration counts; the failed one rolled back.
    expect(totalRestored()).toBe(QTY);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("ineligible orders never regain stock", () => {
  it("13. a PAID order is never restored", async () => {
    // reservation + restore is gated on paymentStatus !== SUCCESS; the
    // underlying service is unconditional, so the gate is what protects this.
    db.order.findUnique.mockResolvedValue({
      id: "order-paid",
      status: "COMPLETED",
      paymentStatus: "SUCCESS",
      vendorId: "v-1",
      customerId: "cust-1",
      totalPrice: 1000,
      items: [{ productId: "prod-1", quantity: QTY }],
    });
    db.order.update.mockResolvedValue({ id: "order-paid", status: "COMPLETED" });
    db.order.updateMany.mockResolvedValue({ count: 0 });

    await updateOrderStatus(
      {
        params: { orderId: "order-paid" },
        body: { status: "COMPLETED" },
        user: { id: "cust-1", role: "CUSTOMER" },
      } as any,
      { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() } as any,
    ).catch(() => undefined);

    expect(totalRestored()).toBe(0);
  });

  it("14. only TRACKED products are restored", async () => {
    // The service filters on trackInventory:true; untracked products are
    // never decremented and so must never be incremented.
    BATCH_ROWS = [];
    db.order.updateMany.mockResolvedValue({ count: 1 });
    db.product.updateMany.mockImplementation(async () => ({ count: 0 }));

    await runExpireAwaitingPaymentJob(10);

    // A count of 0 means no product row matched; no cache invalidation and,
    // critically, the job still completes without retrying forever.
    expect(totalRestored()).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("observability", () => {
  it("15. a restoration failure is logged with the order id and no secrets", async () => {
    const { logger } = require("../../src/lib/logger");
    const errSpy = jest.spyOn(logger, "error").mockImplementation(() => {});
    try {
      db.order.findMany.mockResolvedValueOnce([
        {
          id: "order-A",
          status: "AWAITING_PAYMENT",
          protectedUntil: new Date(Date.now() - 60_000),
          payments: [],
        },
      ]);
      db.product.updateMany.mockRejectedValueOnce(new Error("deadlock detected"));

      await runExpireAwaitingPaymentJob(10);

      const logged = errSpy.mock.calls.map((c) => JSON.stringify(c));
      expect(logged.length).toBeGreaterThan(0);
      const payload = logged.join(" ");
      expect(payload).toContain("order-A");
      for (const secret of ["password", "token", "authorization", "secret", "apikey"]) {
        expect(payload.toLowerCase()).not.toContain(secret);
      }
    } finally {
      errSpy.mockRestore();
    }
  });

  it("16. the reconciliation cron stays disabled — this batch adds no job", () => {
    // Batch 1E.36 deliberately needed no scheduled recovery job: restoration is
    // now atomic with the cancellation, so the existing sweeps are the retry.
    // This asserts we did not introduce a new always-on worker.
    const fs = require("fs");
    const runJob = fs.readFileSync("src/jobs/node-cron/runJob.ts", "utf8");
    const jobSource = fs.readFileSync("src/jobs/workers jobs/expireAwaitingPaymentJob.ts", "utf8");
    const cleanupSource = fs.readFileSync("src/jobs/workers jobs/orderCleanupJob.ts", "utf8");
    expect(runJob).not.toMatch(/stockRestor|inventoryRecover/i);
    expect(jobSource).not.toMatch(/stockRestor|inventoryRecover/i);
    expect(cleanupSource).not.toMatch(/stockRestor|inventoryRecover/i);
  });
});
// ─────────────────────────────────────────────────────────────────────────────
describe("post-commit invalidation failure leaves a committed restore intact", () => {
  // One AWAITING_PAYMENT order past its protection window with no payment.
  const staleCacheCandidate = () => ({
    id: "order-A",
    status: "AWAITING_PAYMENT",
    protectedUntil: new Date(Date.now() - 60_000),
    payments: [],
  });

  it("17. a failing clearProductCache after commit: restore stands once, no duplicate, later purchase follows DB truth", async () => {
    BATCH_ROWS = [staleCacheCandidate()];
    batchServed = false;
    // The cache layer is down for this run only: the single post-commit
    // invalidation rejects, then the stubbed default resumes.
    mockedClearProductCache.mockRejectedValueOnce(new Error("redis down"));

    await runExpireAwaitingPaymentJob(10);

    // 1. The restore committed exactly once despite the cache failure, and
    // the order reached its terminal state.
    expect(totalRestored()).toBe(QTY);
    expect(persistedStatus("order-A")).toBe("CANCELLED_UNPAID");
    // The post-commit sweep ran for the restored product — and ran AFTER the
    // transaction committed (invocation order, not just call counts).
    expect(mockedClearProductCache).toHaveBeenCalledWith("prod-1");
    expect(
      (db.$transaction as jest.Mock).mock.invocationCallOrder[0],
    ).toBeLessThan(mockedClearProductCache.mock.invocationCallOrder[0]);

    // 2. No duplicate restoration: a re-sweep loses the CAS (the order is
    // already terminal) and restores nothing more.
    db.order.updateMany.mockResolvedValue({ count: 0 });
    BATCH_ROWS = [staleCacheCandidate()];
    batchServed = false;
    await runExpireAwaitingPaymentJob(10);
    expect(totalRestored()).toBe(QTY);

    // 3. A later purchase follows DB truth despite the stale display cache:
    // the restored portions are reservable through the same conditional
    // guard checkout uses. (The cache is inert here by construction —
    // reserveStockForItems never reads it — which is exactly the contract
    // this pins: DB truth decides, the display cache does not.)
    const tx = { product: db.product };
    await expect(
      reserveStockForItems(tx as any, [{ productId: "prod-1", quantity: QTY, trackInventory: true }]),
    ).resolves.toBeUndefined();
  });
});

describe("post-commit invalidation result is observed with context", () => {
  it("18. an incomplete sweep is logged with product context while the committed restore stands", async () => {
    const { logger } = require("../../src/lib/logger");
    const warnSpy = jest.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      BATCH_ROWS = [
        {
          id: "order-A",
          status: "AWAITING_PAYMENT",
          protectedUntil: new Date(Date.now() - 60_000),
          payments: [],
        },
      ];
      batchServed = false;
      // The sweep runs but reports incompleteness instead of throwing.
      mockedClearProductCache.mockResolvedValueOnce({
        ok: false,
        failures: [{ database: "1", scope: "fixed-keys" }],
      });

      await runExpireAwaitingPaymentJob(10);

      // The restore committed exactly once — the observation path changes nothing.
      expect(totalRestored()).toBe(QTY);
      expect(persistedStatus("order-A")).toBe("CANCELLED_UNPAID");
      // And the job logged the incomplete sweep with the product id, not a
      // bare redis error: failures are visible to monitoring.
      const payload = JSON.stringify(warnSpy.mock.calls);
      expect(payload).toContain("prod-1");
      expect(payload).toContain("fixed-keys");
    } finally {
      warnSpy.mockRestore();
    }
  });
});
