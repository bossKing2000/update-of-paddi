/**
 * Phase 3.2.1 — payment-finalization and expiry race hardening.
 *
 * P3.2-01: the finalizer's late-payment branch used a stale pre-transaction
 * order snapshot to drive unconditional `order.update({ where: { id } })`
 * writes and derived `killedOrderIds` (hence inventory restoration) from
 * that stale filter. Now every write is conditional and only CAS winners
 * own side effects.
 *
 * P3.2-02: the pending-payment expiry worker overwrote the payment with
 * EXPIRED via an unconditional update, able to clobber a concurrent
 * SUCCESS. Expiry is now a conditional transition on
 * [PENDING, INITIATED], and losing it skips every downstream side effect.
 *
 * Method: real `finalizePaymentSuccess` / `verifyPendingPayments` with
 * mocked Prisma. Interleavings are simulated deterministically by routing
 * conditional-write mocks on their predicates (win => count 1, loss =>
 * count 0) — no timing sleeps. Mocked tests prove application logic, not
 * PostgreSQL isolation; true concurrent execution needs disposable-DB
 * verification (see the integration suite).
 */
import { finalizePaymentSuccess } from "../../src/services/paymentFinalizer.service";
import { verifyPendingPayments } from "../../src/jobs/payment/worker/verifyPendingPayments";
import { verifyPayment } from "../../src/services/paymentService";
import prisma from "../../src/lib/prisma";

jest.mock("../../src/lib/prisma", () => ({
  __esModule: true,
  default: {
    payment: { findMany: jest.fn(), findUnique: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
    order: { findMany: jest.fn(), findUnique: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
    // FIN-07-01: the late-payment branch now files a refund obligation for each
    // order it cancels, so the mocked client needs the RefundRequest model this
    // suite previously never reached. No assertion below is changed by this.
    refundRequest: { findFirst: jest.fn(async () => null), create: jest.fn(async (a: any) => ({ id: "rr-1", ...a.data })) },
    product: { updateMany: jest.fn() },
    userPaymentMethod: { upsert: jest.fn(async () => ({})) },
    $transaction: jest.fn(),
    $queryRaw: jest.fn(),
  },
}));

jest.mock("../../src/services/paymentService", () => ({
  verifyPayment: jest.fn(),
}));

// Stub side-effect layers the late/expiry paths transitively import.
jest.mock("../../src/services/clearCaches", () => ({
  __esModule: true,
  clearProductCache: jest.fn(async () => ({})),
  clearProductsCache: jest.fn(async () => ({})),
}));

jest.mock("../../src/utils/activityUtils/recordActivityBundle", () => ({
  __esModule: true,
  recordActivityBundle: jest.fn(async () => ({})),
}));

jest.mock("../../src/utils/generate Receipt/generateReceipt", () => ({
  __esModule: true,
  generateReceipt: jest.fn(async () => ({ pdfUrl: "http://test/receipt.pdf" })),
}));

const db = prisma as unknown as Record<string, Record<string, jest.Mock>>;
const mockedVerify = verifyPayment as jest.Mock;

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------
const QTY = 2;

function latePaymentRow(over: Record<string, unknown> = {}) {
  return {
    id: "pay-1",
    reference: "PSK-LATE-1",
    orderId: "order-A",
    idempotencyKey: "batch-1",
    status: "PENDING",
    expiresAt: new Date(Date.now() - 60_000),
    channel: null,
    createdAt: new Date(Date.now() - 20 * 60_000),
    ...over,
  };
}

function batchOrder(id: string, productId: string, status = "AWAITING_PAYMENT") {
  return {
    id,
    customerId: "cust-1",
    vendorId: "vend-1",
    idempotencyKey: "batch-1",
    status,
    paymentStatus: "PENDING",
    totalPrice: 500000,
    paidAt: null,
    protectedUntil: null,
    items: [{ productId, quantity: QTY }],
  };
}

let ORDER_ROWS: any[] = [];
/** Per-order CAS outcome for the finalizer's late kill (default: win). */
let ORDER_CAS: Record<string, number> = {};
/** Late-payment claim outcome (default: win). */
let LATE_CLAIM = 1;
/** Expiry-claim outcome (default: win). */
let EXPIRY_CLAIM = 1;

function restoredQty() {
  return db.product.updateMany.mock.calls.reduce(
    (sum, c) => sum + (c[0].data?.stock?.increment ?? 0),
    0,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  ORDER_ROWS = [batchOrder("order-A", "prod-1")];
  ORDER_CAS = {};
  LATE_CLAIM = 1;
  EXPIRY_CLAIM = 1;

  db.$transaction.mockImplementation(async (arg: any) =>
    typeof arg === "function" ? arg(db) : arg,
  );

  // C-2: obligations are filed with `INSERT ... ON CONFLICT DO NOTHING
  // RETURNING ...` (raw SQL) instead of a typed `create`. Route it through the
  // existing `create` double so every assertion below is unchanged.
  db.$queryRaw.mockImplementation(
    async (strings: TemplateStringsArray, ...values: any[]) => {
      const sql = Array.from(strings as unknown as string[]).join(" ");
      if (!sql.includes('INSERT INTO "RefundRequest"')) return [];
      const [id, userId, paymentRef, reason, status, , , orderId, requestedAmountKobo] =
        values as any[];
      const row = await db.refundRequest.create({
        data: { id, userId, paymentRef, reason, status, orderId, requestedAmountKobo },
      });
      return row ? [row] : [];
    },
  );
  db.product.updateMany.mockResolvedValue({ count: 1 });

  // Route order reads: by-id-in (restore re-read) vs batch scope (finalizer).
  db.order.findMany.mockImplementation(async (args: any) => {
    const inIds = args?.where?.id?.in;
    if (Array.isArray(inIds)) return ORDER_ROWS.filter((r) => inIds.includes(r.id));
    return ORDER_ROWS;
  });

  // Phase 3.2.6: when an order loses its confirmation CAS the finalizer
  // re-reads the authoritative row to decide what happens next, so the
  // single-row read must behave like the real one.
  db.order.findUnique.mockImplementation(async (args: any) => {
    const id = args?.where?.id;
    return ORDER_ROWS.find((r) => r.id === id) ?? null;
  });

  // Route order conditional writes by configured CAS outcome.
  db.order.updateMany.mockImplementation(async (args: any) => {
    const id = args?.where?.id;
    if (typeof id === "string" && id in ORDER_CAS) return { count: ORDER_CAS[id] };
    return { count: 1 };
  });

  // Route payment conditional writes: lock acquire/release vs claims.
  db.payment.updateMany.mockImplementation(async (args: any) => {
    const where = args?.where ?? {};
    if ("isProcessing" in where) return { count: 1 }; // lock release
    if (where.OR) return { count: 1 }; // lock acquire
    if (Array.isArray(where?.status?.in)) {
      if (where.status.in.includes("INITIATED")) {
        // Late-payment claim (PENDING, INITIATED) and expiry claim share
        // the shape; the suites set only one of the two knobs per test.
        return { count: Math.min(LATE_CLAIM, EXPIRY_CLAIM) };
      }
    }
    return { count: 1 };
  });
  db.payment.findUnique.mockResolvedValue(latePaymentRow());
  mockedVerify.mockResolvedValue({ status: "failed" });
});

// ---------------------------------------------------------------------------
// P3.2-01 — finalizer late-payment branch
// ---------------------------------------------------------------------------
describe("P3.2-01 — late-payment finalization claims transitions conditionally", () => {
  function finalize(amountKobo = 500000, extra: Record<string, unknown> = {}) {
    return finalizePaymentSuccess({ reference: "PSK-LATE-1", amountKobo, currency: "NGN", ...extra });
  }

  it("1. a valid late-payment transition still succeeds and restores once", async () => {
    const result = await finalize();

    expect(result.outcome).toBe("LATE_PAYMENT");
    // Payment claimed conditionally, never unconditionally.
    expect(db.payment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { reference: "PSK-LATE-1", status: { in: ["PENDING", "INITIATED"] } },
      }),
    );
    // Order killed via status-predicate CAS.
    expect(db.order.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "order-A", status: { in: ["AWAITING_PAYMENT", "PENDING"] } },
      }),
    );
    expect(restoredQty()).toBe(QTY);
  });

  it("2. an order that already left the eligible set is not overwritten", async () => {
    ORDER_CAS = { "order-A": 0 }; // concurrent success/expiry/cancel won first
    const result = await finalize();

    expect(result.outcome).toBe("LATE_PAYMENT");
    // The CAS predicate — not the stale snapshot — decided; the loser owns
    // nothing, so no stock moves for this order.
    expect(db.order.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "order-A", status: { in: ["AWAITING_PAYMENT", "PENDING"] } },
      }),
    );
    expect(restoredQty()).toBe(0);
    expect(db.product.updateMany).not.toHaveBeenCalled();
  });

  it("3. mixed batch: only CAS winners are killed and restored", async () => {
    ORDER_ROWS = [batchOrder("order-A", "prod-1"), batchOrder("order-B", "prod-2")];
    ORDER_CAS = { "order-A": 1, "order-B": 0 };
    const result = await finalize(1000000);

    expect(result.outcome).toBe("LATE_PAYMENT");
    expect(restoredQty()).toBe(QTY);
    expect(db.product.updateMany.mock.calls.map((c) => c[0].where.id)).toEqual(["prod-1"]);
  });

  it("4. a payment already settled concurrently is not touched (ALREADY_PROCESSED)", async () => {
    LATE_CLAIM = 0; // e.g. SUCCESS committed between the read and this tx
    const result = await finalize();

    expect(result.outcome).toBe("ALREADY_PROCESSED");
    expect(db.order.updateMany).not.toHaveBeenCalled();
    expect(db.product.updateMany).not.toHaveBeenCalled();
  });

  it("5. retrying the finalizer does not restore twice", async () => {
    await finalize();
    expect(restoredQty()).toBe(QTY);

    // Second run: the payment is no longer pending (prior LATE_PAYMENT),
    // so the claim loses and nothing moves again.
    LATE_CLAIM = 0;
    const result = await finalize();
    expect(result.outcome).toBe("ALREADY_PROCESSED");
    expect(restoredQty()).toBe(QTY);
  });
});

// ---------------------------------------------------------------------------
// Batch A — success-branch conditional confirmation + terminal guard
// ---------------------------------------------------------------------------
describe("Batch A — success branch claims confirmation conditionally", () => {
  function freshPayment(over: Record<string, unknown> = {}) {
    return latePaymentRow({
      status: "PENDING",
      expiresAt: new Date(Date.now() + 10 * 60_000),
      ...over,
    });
  }

  function succeed() {
    db.payment.findUnique.mockResolvedValue(freshPayment());
    return finalizePaymentSuccess({ reference: "PSK-LATE-1", amountKobo: 500000, currency: "NGN" });
  }

  it("11. success racing with expiry: expired order keeps its state, payment truth recorded", async () => {
    ORDER_CAS = { "order-A": 0 }; // expiry/cancel won first
    const result = await succeed();

    expect(result.outcome).toBe("SUCCESS");
    // Fresh confirmation attempted via status-predicate CAS first.
    expect(db.order.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "order-A", status: { in: ["AWAITING_PAYMENT", "PENDING"] } },
      }),
    );
    const first = db.order.updateMany.mock.calls[0][0];
    expect(first.data.status).toBe("PAYMENT_CONFIRMED");
    // Lost: fallback records payment truth only on still-pending rows,
    // never moves order status.
    const fallback = db.order.updateMany.mock.calls[1][0];
    expect(fallback.where).toEqual({
      id: "order-A",
      paymentStatus: { in: ["PENDING", "INITIATED"] },
    });
    expect(fallback.data).toEqual({ paymentStatus: "SUCCESS" });
    expect(db.product.updateMany).not.toHaveBeenCalled();
  });

  it("12. duplicate finalizer invocation is idempotent (ALREADY_PROCESSED, no new transitions)", async () => {
    // Orders already in sync: the idempotent path writes nothing at all.
    ORDER_ROWS = [{ ...batchOrder("order-A", "prod-1"), status: "PAYMENT_CONFIRMED", paymentStatus: "SUCCESS" }];
    db.payment.findUnique.mockResolvedValue(freshPayment({ status: "SUCCESS" }));
    const result = await finalizePaymentSuccess({ reference: "PSK-LATE-1", amountKobo: 500000, currency: "NGN" });

    expect(result.outcome).toBe("ALREADY_PROCESSED");
    expect(db.order.updateMany).not.toHaveBeenCalled();
    expect(db.order.update).not.toHaveBeenCalled();
    expect(db.payment.update).not.toHaveBeenCalled();
  });

  it("13. terminal payment states reject duplicate success events without writes", async () => {
    for (const status of ["LATE_PAYMENT", "AMOUNT_MISMATCH", "FAILED", "REFUNDED"]) {
      jest.clearAllMocks();
      db.payment.findUnique.mockResolvedValue(freshPayment({ status }));
      const result = await finalizePaymentSuccess({ reference: "PSK-LATE-1", amountKobo: 500000, currency: "NGN" });

      expect(result.outcome).toBe("ALREADY_PROCESSED");
      expect(db.order.updateMany).not.toHaveBeenCalled();
      expect(db.payment.update).not.toHaveBeenCalled();
    }
  });

  it("13b. EXPIRED is terminal too: nothing is rewritten, only an obligation is filed", async () => {
    // FIN-07-02 deliberately separates EXPIRED from the other terminal states.
    // It was previously lumped into the loop above, which asserted that an
    // EXPIRED payment yields ALREADY_PROCESSED and no writes at all. That is
    // no longer true — and it was the bug: a capture arriving after the local
    // expiry had produced captured money with no obligation anywhere.
    //
    // What has NOT changed, and is asserted here just as strictly: the
    // terminal payment record is never rewritten and no order is ever touched.
    jest.clearAllMocks();
    db.payment.findUnique.mockResolvedValue(freshPayment({ status: "EXPIRED" }));
    // The order the expiry path would already have cancelled: that is the
    // state an obligation is owed for.
    ORDER_ROWS = [
      { ...batchOrder("order-A", "prod-1"), status: "CANCELLED_UNPAID", paymentStatus: "EXPIRED" },
    ];
    const result = await finalizePaymentSuccess({ reference: "PSK-LATE-1", amountKobo: 500000, currency: "NGN" });

    expect(result.outcome).toBe("LATE_CAPTURE_REFUND_FILED");
    // The terminal record and the order are untouched...
    expect(db.order.updateMany).not.toHaveBeenCalled();
    expect(db.payment.update).not.toHaveBeenCalled();
    const statusWrites = db.payment.updateMany.mock.calls.filter((c: any) => c[0]?.data?.status);
    expect(statusWrites).toHaveLength(0);
    // ...and the only write is a PENDING refund obligation.
    expect(db.refundRequest.create).toHaveBeenCalledTimes(1);
    expect(db.refundRequest.create.mock.calls[0][0].data).toMatchObject({
      paymentRef: "PSK-LATE-1",
      status: "PENDING",
    });
  });

  it("14. mixed batch: fresh orders confirm, advanced orders keep state", async () => {
    ORDER_ROWS = [batchOrder("order-A", "prod-1"), batchOrder("order-B", "prod-2")];
    ORDER_CAS = { "order-A": 1, "order-B": 0 };
    db.payment.findUnique.mockResolvedValue(freshPayment());

    const result = await finalizePaymentSuccess({ reference: "PSK-LATE-1", amountKobo: 1000000, currency: "NGN" });
    expect(result.outcome).toBe("SUCCESS");
    const writes = db.order.updateMany.mock.calls.map((c) => c[0]);
    // A confirmed via predicate; B's confirm attempt matched nothing, so B
    // fell back to a payment-truth-only write.
    expect(writes[0].where).toEqual({ id: "order-A", status: { in: ["AWAITING_PAYMENT", "PENDING"] } });
    expect(writes[0].data.status).toBe("PAYMENT_CONFIRMED");
    expect(writes[1].where).toEqual({ id: "order-B", status: { in: ["AWAITING_PAYMENT", "PENDING"] } });
    expect(writes[2].where).toEqual({ id: "order-B", paymentStatus: { in: ["PENDING", "INITIATED"] } });
    expect(writes[2].data).toEqual({ paymentStatus: "SUCCESS" });
  });
});

// ---------------------------------------------------------------------------
// Batch F1 — currency fail-closed boundaries
// ---------------------------------------------------------------------------
describe("Batch F1 — provider currency is verified fail-closed", () => {
  it("15. wrong currency takes the mismatch path with no order writes", async () => {
    db.payment.findUnique.mockResolvedValue(latePaymentRow());
    const result = await finalizePaymentSuccess({
      reference: "PSK-LATE-1",
      amountKobo: 500000,
      currency: "USD",
    });

    expect(result.outcome).toBe("AMOUNT_MISMATCH");
    expect(db.order.updateMany).not.toHaveBeenCalled();
    expect(db.order.update).not.toHaveBeenCalled();
  });

  it("16. missing currency fails closed (never assumed)", async () => {
    db.payment.findUnique.mockResolvedValue(latePaymentRow());
    const result = await finalizePaymentSuccess({ reference: "PSK-LATE-1", amountKobo: 500000 });

    expect(result.outcome).toBe("AMOUNT_MISMATCH");
    expect(db.order.updateMany).not.toHaveBeenCalled();
  });

  it("17. matching NGN (any case) proceeds normally", async () => {
    db.payment.findUnique.mockResolvedValue(latePaymentRow());
    const result = await finalizePaymentSuccess({
      reference: "PSK-LATE-1",
      amountKobo: 500000,
      currency: "ngn",
    });

    expect(result.outcome).toBe("LATE_PAYMENT");
  });
});
describe("P3.2-02 — expiry claims the payment conditionally", () => {
  function expiredCandidate(over: Record<string, unknown> = {}) {
    return {
      id: "pay-1",
      reference: "PSK-REF-1",
      orderId: "order-A",
      idempotencyKey: "batch-1",
      status: "PENDING",
      expiresAt: new Date(Date.now() - 60_000),
      createdAt: new Date(Date.now() - 20 * 60_000),
      ...over,
    };
  }

  function queuePayments(payments: any[]) {
    db.payment.findMany.mockResolvedValueOnce(payments).mockResolvedValue([]);
  }

  it("6. a genuinely eligible payment expires with a conditional write", async () => {
    queuePayments([expiredCandidate()]);
    await verifyPendingPayments(10);

    expect(db.payment.updateMany).toHaveBeenCalledWith({
      where: { id: "pay-1", status: { in: ["PENDING", "INITIATED"] } },
      data: { status: "EXPIRED" },
    });
    expect(restoredQty()).toBe(QTY);
  });

  it("7. a payment already SUCCESS is never overwritten", async () => {
    queuePayments([expiredCandidate({ status: "SUCCESS" })]);
    EXPIRY_CLAIM = 0; // persisted state already left [PENDING, INITIATED]
    await verifyPendingPayments(10);

    // The only payment write issued carries the conditional predicate, so
    // the database matches nothing (count 0) instead of overwriting: no
    // cancellation, no restore.
    const paymentWrites = db.payment.updateMany.mock.calls.filter((c) =>
      c[0].data?.status === "EXPIRED",
    );
    expect(paymentWrites).toHaveLength(1);
    expect(paymentWrites[0][0].where).toEqual({
      id: "pay-1",
      status: { in: ["PENDING", "INITIATED"] },
    });
    expect(db.order.updateMany).not.toHaveBeenCalled();
    expect(db.product.updateMany).not.toHaveBeenCalled();
  });

  it("8. a payment that becomes SUCCESS after the candidate read is not clobbered", async () => {
    // Candidate selected while PENDING; the finalizer commits SUCCESS
    // before this execution's transaction runs (claim loses).
    queuePayments([expiredCandidate()]);
    EXPIRY_CLAIM = 0;
    await verifyPendingPayments(10);

    const paymentWrites = db.payment.updateMany.mock.calls.filter((c) =>
      c[0].data?.status === "EXPIRED",
    );
    expect(paymentWrites).toHaveLength(1);
    expect(paymentWrites[0][0].where).toEqual({
      id: "pay-1",
      status: { in: ["PENDING", "INITIATED"] },
    });
    expect(db.order.updateMany).not.toHaveBeenCalled();
    expect(db.product.updateMany).not.toHaveBeenCalled();
  });

  it("9. a database error is logged, not reported as successful expiry", async () => {
    queuePayments([expiredCandidate()]);
    db.payment.updateMany.mockRejectedValueOnce(new Error("db exploded"));

    await expect(verifyPendingPayments(10)).resolves.not.toThrow();
    expect(db.order.updateMany).not.toHaveBeenCalled();
    expect(db.product.updateMany).not.toHaveBeenCalled();
  });

  it("10. retrying expiry after a win repeats no side effects", async () => {
    queuePayments([expiredCandidate()]);
    await verifyPendingPayments(10);
    expect(restoredQty()).toBe(QTY);
    const orderWritesAfterWin = db.order.updateMany.mock.calls.length;
    expect(orderWritesAfterWin).toBe(1);

    // Rerun: payment already EXPIRED, claim loses, nothing moves — the
    // losing conditional write itself matches zero rows.
    EXPIRY_CLAIM = 0;
    queuePayments([expiredCandidate({ status: "EXPIRED" })]);
    await verifyPendingPayments(10);
    expect(restoredQty()).toBe(QTY);
    expect(db.order.updateMany.mock.calls.length).toBe(orderWritesAfterWin);
  });
});
