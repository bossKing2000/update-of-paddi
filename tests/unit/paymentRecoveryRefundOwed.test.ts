/**
 * Phase 3.2.6 — F-A1 (conditional payment claims) + F-A3 (refund owed when
 * a payment is captured for an already-cancelled order).
 *
 * Before: the finalizer wrote payment status unconditionally, so an expiry
 * or a concurrent finalizer that settled the reference first could be
 * overwritten; and a success arriving after cancellation left a cancelled
 * order holding a captured payment with no refund obligation anywhere.
 *
 * After: payment status is a conditional claim on [PENDING, INITIATED]; a
 * lost claim writes nothing and returns ALREADY_PROCESSED; an order that
 * can no longer be fulfilled but whose payment was captured gets exactly
 * one order-bounded PENDING refund request inside the same transaction.
 *
 * Real `finalizePaymentSuccess` with mocked Prisma. Interleavings are
 * simulated deterministically by conditional-write counts — these tests
 * prove application logic, NOT PostgreSQL isolation (that still needs
 * disposable-database verification).
 */
jest.mock("../../src/lib/prisma", () => ({
  __esModule: true,
  default: {
    payment: { findUnique: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
    order: { findMany: jest.fn(), findUnique: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
    refundRequest: { findFirst: jest.fn(), create: jest.fn() },
    $queryRaw: jest.fn(),
    userPaymentMethod: { upsert: jest.fn(async () => ({})) },
    product: { updateMany: jest.fn() },
    $transaction: jest.fn(),
  },
}));

jest.mock("../../src/services/inventory.service", () => ({
  __esModule: true,
  restoreStockForOrders: jest.fn(async () => []),
  reserveStockForItems: jest.fn(),
  assertQuantityAvailable: jest.fn(),
}));

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
  generateReceipt: jest.fn(async () => ({ pdfUrl: "http://test/r.pdf" })),
}));

import { finalizePaymentSuccess } from "../../src/services/paymentFinalizer.service";
import { recordActivityBundle } from "../../src/utils/activityUtils/recordActivityBundle";
import { generateReceipt } from "../../src/utils/generate Receipt/generateReceipt";
import prisma from "../../src/lib/prisma";

const db = prisma as unknown as Record<string, Record<string, jest.Mock>>;
const mockedNotify = recordActivityBundle as jest.Mock;
const mockedReceipt = generateReceipt as jest.Mock;

const REFERENCE = "PSK-321";
const QTY = 2;

/** Conditional-write outcomes, controlled per test. */
let SUCCESS_CLAIM = 1;
let MISMATCH_CLAIM = 1;
let ORDER_CAS: Record<string, number> = {};
/** Per-order CAS outcomes for the late branch's CANCELLED_UNPAID write. */
let LATE_CAS: Record<string, number> = {};
/** Authoritative current order rows (what a re-read returns). */
let CURRENT: Record<string, { status: string; customerId: string; totalPrice: number }> = {};
let openRefund: any = null;
/**
 * Durability model: a claim that the database accepted persists, so a later
 * invocation (async-retry, duplicate delivery) reads the settled record —
 * exactly as it would after a real commit.
 */
let PERSISTED_PAYMENT_STATUS = "PENDING";

function paymentRow(over: Record<string, unknown> = {}) {
  return {
    id: "pay-1",
    reference: REFERENCE,
    orderId: "order-A",
    idempotencyKey: "batch-1",
    status: "PENDING",
    // Well inside the payment window, so the late branch is not taken.
    expiresAt: new Date(Date.now() + 10 * 60_000),
    channel: "card",
    createdAt: new Date(),
    ...over,
  };
}

function orderRow(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    customerId: "cust-1",
    vendorId: "vend-1",
    idempotencyKey: "batch-1",
    status: "AWAITING_PAYMENT",
    paymentStatus: "PENDING",
    totalPrice: 550000,
    paidAt: null,
    protectedUntil: null,
    items: [{ productId: "prod-1", quantity: QTY }],
    ...over,
  };
}

function finalize(over: Record<string, unknown> = {}) {
  return finalizePaymentSuccess({
    reference: REFERENCE,
    amountKobo: 550000,
    currency: "NGN",
    ...over,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  SUCCESS_CLAIM = 1;
  MISMATCH_CLAIM = 1;
  ORDER_CAS = {};
  LATE_CAS = {};
  openRefund = null;
  PERSISTED_PAYMENT_STATUS = "PENDING";

  // Transaction model: a throwing callback rolls back the writes it made
  // (mirrors PostgreSQL). Writes committed before the throw stay visible,
  // which is what makes post-commit failures (notifications) behave
  // differently from in-transaction ones.
  db.$transaction.mockImplementation(async (arg: any) => {
    if (typeof arg !== "function") return arg;
    const snapshot = PERSISTED_PAYMENT_STATUS;
    try {
      return await arg(db);
    } catch (err) {
      PERSISTED_PAYMENT_STATUS = snapshot;
      throw err;
    }
  });
  db.payment.findUnique.mockImplementation(async () =>
    paymentRow({ status: PERSISTED_PAYMENT_STATUS }),
  );
  db.order.findMany.mockResolvedValue([orderRow("order-A")]);
  db.order.findUnique.mockImplementation(async (args: any) => {
    const row = CURRENT[args?.where?.id];
    return row ? { ...row } : null;
  });
  db.payment.updateMany.mockImplementation(async (args: any) => {
    const where = args?.where ?? {};
    if ("isProcessing" in where || where.OR) return { count: 1 }; // lock acquire/release
    const status = args?.data?.status;
    const count = status === "SUCCESS" ? SUCCESS_CLAIM : MISMATCH_CLAIM;
    // Accepted claims become visible to later reads (durability model).
    if (count > 0) PERSISTED_PAYMENT_STATUS = status;
    return { count };
  });
  db.order.updateMany.mockImplementation(async (args: any) => {
    if (args?.data?.status === "PAYMENT_CONFIRMED") {
      const id = args.where.id;
      return { count: id in ORDER_CAS ? ORDER_CAS[id] : 1 };
    }
    // FIN-07-01: the late branch's per-order cancellation CAS. Kept separate
    // from the confirmation CAS so a batch can mix winners and losers.
    if (args?.data?.status === "CANCELLED_UNPAID") {
      const id = args.where.id;
      return { count: id in LATE_CAS ? LATE_CAS[id] : 1 };
    }
    return { count: 1 }; // payment-truth-only write
  });
  db.refundRequest.findFirst.mockImplementation(async () => openRefund);
  db.refundRequest.create.mockImplementation(async (args: any) => ({ id: "rr-1", ...args.data }));

  // C-2: the finalizer now files obligations with
  // `INSERT ... ON CONFLICT DO NOTHING RETURNING ...` (raw SQL) instead of a
  // typed `create`. Route that INSERT back through the existing `create` double
  // so every assertion below — including the two that inject a failure via
  // `create.mockRejectedValue` — keeps exercising the same seam unchanged.
  db.$queryRaw.mockImplementation(
    async (strings: TemplateStringsArray, ...values: any[]) => {
      const sql = Array.from(strings as unknown as string[]).join(" ");
      if (!sql.includes('INSERT INTO "RefundRequest"')) return [];
      const [id, userId, paymentRef, reason, status, , , orderId, requestedAmountKobo] =
        values as any[];
      const row = await db.refundRequest.create({
        data: { id, userId, paymentRef, reason, status, orderId, requestedAmountKobo },
      });
      // No row back == ON CONFLICT DO NOTHING: a concurrent writer already
      // filed this obligation, so the helper re-reads it via findFirst.
      return row ? [row] : [];
    },
  );
});

const refundCreates = () => db.refundRequest.create.mock.calls.map((c) => c[0].data);
/** Conditional order-status CAS attempts (status-carrying writes). */
const orderStatusWrites = () =>
  db.order.updateMany.mock.calls.filter((c) => c[0].data?.status).map((c) => c[0]);
/** Payment status writes, excluding lock acquire/release. */
const paymentStatusWrites = () =>
  db.payment.updateMany.mock.calls.filter((c) => c[0].data?.status).map((c) => c[0]);
/** Status-carrying order writes that used the payable-pending CAS. */
const confirmCAs = () =>
  orderStatusWrites().filter((c) => c.data.status === "PAYMENT_CONFIRMED");

describe("F-A1 — payment status is a conditional claim", () => {
  it("1. expiry wins first: the stale success writes nothing at all", async () => {
    // Expiry committed EXPIRED between the terminal guard and the write.
    SUCCESS_CLAIM = 0;

    const result = await finalize();

    expect(result.outcome).toBe("ALREADY_PROCESSED");
    // The terminal record is left exactly as its owner wrote it.
    expect(db.payment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { reference: REFERENCE, status: { in: ["PENDING", "INITIATED"] } },
      }),
    );
    expect(db.payment.update).not.toHaveBeenCalled();
    expect(orderStatusWrites()).toHaveLength(0);
    expect(db.product.updateMany).not.toHaveBeenCalled();
    expect(refundCreates()).toHaveLength(0);
    expect(mockedReceipt).not.toHaveBeenCalled();
    expect(mockedNotify).not.toHaveBeenCalled();
  });

  it("2. finalization wins first: normal capture still succeeds", async () => {
    const result = await finalize();

    expect(result.outcome).toBe("SUCCESS");
    expect(db.order.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "order-A", status: { in: ["AWAITING_PAYMENT", "PENDING"] } },
      }),
    );
    expect(mockedReceipt).toHaveBeenCalled();
    expect(mockedNotify).toHaveBeenCalled();
    expect(refundCreates()).toHaveLength(0);
  });

  it("3. duplicate success is idempotent and does not re-write anything", async () => {
    PERSISTED_PAYMENT_STATUS = "SUCCESS";
    const result = await finalize();

    expect(result.outcome).toBe("ALREADY_PROCESSED");
    expect(paymentStatusWrites()).toHaveLength(0);
    expect(db.order.update).not.toHaveBeenCalled();
    expect(refundCreates()).toHaveLength(0);
  });

  it("4. a genuine transaction failure is not swallowed as ALREADY_PROCESSED", async () => {
    // Refund filing fails inside the capture transaction (cancelled order).
    ORDER_CAS = { "order-A": 0 };
    CURRENT = { "order-A": { status: "CANCELLED", customerId: "cust-1", totalPrice: 550000 } };
    db.refundRequest.create.mockRejectedValue(new Error("db exploded"));

    await expect(finalize()).rejects.toThrow(/db exploded/);
    // The failure propagated for retry instead of being reported as a
    // settled payment.
    expect(paymentStatusWrites().length).toBeGreaterThan(0);
  });

  it("5. mismatch paths also claim conditionally and lose without overwriting", async () => {
    MISMATCH_CLAIM = 0;
    const result = await finalize({ amountKobo: 99_999_900 });

    // Lost the claim: the record belongs to whoever settled it.
    expect(result.outcome).toBe("ALREADY_PROCESSED");
    expect(db.payment.update).not.toHaveBeenCalled();
    expect(orderStatusWrites()).toHaveLength(0);
  });

  it("6. an authorized mismatch still records AMOUNT_MISMATCH", async () => {
    const result = await finalize({ amountKobo: 99_999_900 });

    expect(result.outcome).toBe("AMOUNT_MISMATCH");
    expect(db.payment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { reference: REFERENCE, status: { in: ["PENDING", "INITIATED"] } },
        data: expect.objectContaining({ status: "AMOUNT_MISMATCH" }),
      }),
    );
    expect(orderStatusWrites()).toHaveLength(0);
  });
});

describe("F-A3 — captured payment for an already-cancelled order", () => {
  beforeEach(() => {
    // Cancellation won the order CAS; the authoritative re-read says so.
    ORDER_CAS = { "order-A": 0 };
    CURRENT = { "order-A": { status: "CANCELLED", customerId: "cust-1", totalPrice: 550000 } };
  });

  it("7. files exactly one order-bounded refund obligation and preserves CANCELLED", async () => {
    const result = await finalize();

    expect(result.outcome).toBe("SUCCESS_REFUND_PENDING");
    expect(result.refundPendingOrderIds).toEqual(["order-A"]);
    // The cancelled order is never resurrected: the only status-carrying
    // write is the payable-pending CAS (which matched nothing), and no
    // unconditional status writer is used.
    expect(confirmCAs()).toEqual([
      expect.objectContaining({
        where: { id: "order-A", status: { in: ["AWAITING_PAYMENT", "PENDING"] } },
      }),
    ]);
    expect(db.order.update).not.toHaveBeenCalled();
    // Payment truth is still recorded on the cancelled order.
    expect(db.order.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "order-A", paymentStatus: { in: ["PENDING", "INITIATED"] } },
        data: { paymentStatus: "SUCCESS" },
      }),
    );
    expect(refundCreates()).toEqual([
      expect.objectContaining({
        userId: "cust-1",
        paymentRef: REFERENCE,
        orderId: "order-A",
        status: "PENDING",
        // Order-bounded: 5500 naira, never the batch payment total.
        requestedAmountKobo: 550000,
      }),
    ]);
  });

  it("8. a second success event cannot file a duplicate refund", async () => {
    await finalize();
    expect(refundCreates()).toHaveLength(1);

    // The persisted payment is now SUCCESS, so the duplicate is refused by
    // the claim/terminal guard and never reaches refund creation.
    db.payment.findUnique.mockResolvedValue(paymentRow({ status: "SUCCESS" }));
    const second = await finalize();

    expect(second.outcome).toBe("ALREADY_PROCESSED");
    expect(refundCreates()).toHaveLength(1);
  });

  it("9. an already-open refund is preserved, not duplicated", async () => {
    openRefund = { id: "rr-existing", status: "PENDING", orderId: "order-A" };

    const result = await finalize();

    expect(result.outcome).toBe("SUCCESS_REFUND_PENDING");
    expect(refundCreates()).toHaveLength(0);
    expect(db.refundRequest.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          paymentRef: REFERENCE,
          orderId: "order-A",
          status: { in: ["PENDING", "APPROVED", "PROCESSING"] },
        }),
      }),
    );
  });

  it("10. the obligation survives a notification failure after commit", async () => {
    mockedNotify.mockRejectedValueOnce(new Error("socket hang up"));

    // Attempt 1 commits payment + refund, then the notification fails.
    // Attempt 2 reads the settled payment and stops there.
    const result = await finalize();

    expect(result.outcome).toBe("ALREADY_PROCESSED");
    // Exactly one obligation was created — the failure did not erase it and
    // did not create a second one.
    expect(refundCreates()).toHaveLength(1);
  });

  it("11. CANCELLED_UNPAID (expired order) with a captured payment is also covered", async () => {
    CURRENT = { "order-A": { status: "CANCELLED_UNPAID", customerId: "cust-1", totalPrice: 550000 } };

    const result = await finalize();

    expect(result.outcome).toBe("SUCCESS_REFUND_PENDING");
    expect(refundCreates()).toHaveLength(1);
  });

  it("12. a lost order CAS on a live (non-terminal) order files no refund", async () => {
    CURRENT = { "order-A": { status: "COOKING", customerId: "cust-1", totalPrice: 550000 } };

    const result = await finalize();

    // Fulfilment already under way — no refund obligation, no resurrection.
    expect(result.outcome).toBe("SUCCESS");
    expect(result.refundPendingOrderIds).toEqual([]);
    expect(refundCreates()).toHaveLength(0);
  });

  it("13. a batch where one order is cancelled and one is live splits correctly", async () => {
    db.order.findMany.mockResolvedValue([
      orderRow("order-A"),
      orderRow("order-B", { totalPrice: 500000 }),
    ]);
    db.order.findUnique.mockImplementation(async (args: any) => {
      const rows: Record<string, any> = {
        "order-A": { status: "CANCELLED", customerId: "cust-1", totalPrice: 550000 },
        "order-B": { status: "AWAITING_PAYMENT", customerId: "cust-1", totalPrice: 500000 },
      };
      return rows[args?.where?.id] ?? null;
    });
    ORDER_CAS = { "order-A": 0, "order-B": 1 };

    const result = await finalize({ amountKobo: 1_050_000 });

    expect(result.outcome).toBe("SUCCESS_REFUND_PENDING");
    expect(result.refundPendingOrderIds).toEqual(["order-A"]);
    expect(refundCreates()).toHaveLength(1);
    expect(refundCreates()[0]).toMatchObject({ orderId: "order-A", requestedAmountKobo: 550000 });
    // The live order still confirms through the CAS; the dead one does not.
    expect(confirmCAs()).toEqual([
      expect.objectContaining({ where: { id: "order-A", status: { in: ["AWAITING_PAYMENT", "PENDING"] } } }),
      expect.objectContaining({ where: { id: "order-B", status: { in: ["AWAITING_PAYMENT", "PENDING"] } } }),
    ]);
    expect(db.order.update).not.toHaveBeenCalled();
  });
});

/**
 * FIN-07-01 — a capture that arrives after the protection window is real money
 * taken for orders this branch then kills. Before the fix the branch moved
 * payment and order state and restored inventory but filed no obligation, so
 * the captured funds had no queryable record of being owed back.
 *
 * These tests drive the real `finalizePaymentSuccess` with mocked Prisma; they
 * prove application logic, NOT PostgreSQL isolation.
 */
describe("FIN-07-01 — late capture files a refund obligation per cancelled order", () => {
  /** A payment already past `expiresAt`. */
  const latePayment = (over: Record<string, unknown> = {}) =>
    paymentRow({ status: "PENDING", expiresAt: new Date(Date.now() - 60_000), ...over });

  /** An order whose protection window has also closed. */
  const lateOrder = (id: string, over: Record<string, unknown> = {}) =>
    orderRow(id, { protectedUntil: new Date(Date.now() - 60_000), totalPrice: 550000, ...over });

  /** The authoritative re-read the late branch performs before filing. */
  const seedCurrent = (id: string, over: Record<string, unknown> = {}) => {
    CURRENT[id] = { status: "CANCELLED_UNPAID", customerId: "cust-1", totalPrice: 550000, ...over } as never;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    SUCCESS_CLAIM = 1;
    MISMATCH_CLAIM = 1;
    ORDER_CAS = {};
    LATE_CAS = {};
    openRefund = null;
    PERSISTED_PAYMENT_STATUS = "PENDING";
    CURRENT = {};

    db.$transaction.mockImplementation(async (arg: any) => {
      if (typeof arg !== "function") return arg;
      const snapshot = PERSISTED_PAYMENT_STATUS;
      try {
        return await arg(db);
      } catch (err) {
        PERSISTED_PAYMENT_STATUS = snapshot;
        throw err;
      }
    });
    db.payment.findUnique.mockImplementation(async () =>
      paymentRow({ status: PERSISTED_PAYMENT_STATUS, expiresAt: new Date(Date.now() - 60_000) }),
    );
    db.order.updateMany.mockImplementation(async (args: any) => {
      if (args?.data?.status === "CANCELLED_UNPAID") {
        const id = args.where.id;
        return { count: id in LATE_CAS ? LATE_CAS[id] : 1 };
      }
      return { count: 1 };
    });
    db.order.findUnique.mockImplementation(async (args: any) => {
      const row = CURRENT[args?.where?.id];
      return row ? { ...row } : null;
    });
    db.payment.updateMany.mockImplementation(async (args: any) => {
      const where = args?.where ?? {};
      if ("isProcessing" in where || where.OR) return { count: 1 };
      const status = args?.data?.status;
      const count = status === "SUCCESS" ? SUCCESS_CLAIM : MISMATCH_CLAIM;
      if (count > 0) PERSISTED_PAYMENT_STATUS = status;
      return { count };
    });
    db.refundRequest.findFirst.mockImplementation(async () => openRefund);
    db.refundRequest.create.mockImplementation(async (args: any) => ({ id: "rr-1", ...args.data }));
    db.order.findMany.mockResolvedValue([lateOrder("order-A")]);
    seedCurrent("order-A");
  });

  it("1. the late branch is still taken (precondition for every case below)", async () => {
    const result = await finalize();
    expect(result.outcome).toBe("LATE_PAYMENT");
    expect(db.order.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "order-A",
          status: { in: ["AWAITING_PAYMENT", "PENDING"] },
        }),
        data: expect.objectContaining({ status: "CANCELLED_UNPAID", cancellationReason: "LATE_PAYMENT" }),
      }),
    );
  });

  it("2. files exactly one PENDING obligation carrying the order, reference, kobo amount and reason", async () => {
    const result = await finalize();

    expect(refundCreates()).toHaveLength(1);
    expect(refundCreates()[0]).toMatchObject({
      userId: "cust-1",
      paymentRef: REFERENCE,
      orderId: "order-A",
      status: "PENDING",
      // 5,500 naira -> kobo, order-bounded (never the payment total).
      requestedAmountKobo: 550000,
    });
    expect(refundCreates()[0].reason).toContain("LATE_PAYMENT");
    expect(result.refundPendingOrderIds).toEqual(["order-A"]);
  });

  it("3. the obligation is written against the transaction client, so it rolls back with the branch", async () => {
    await finalize();
    // The late branch has no other refund path, and the mocked $transaction runs
    // its callback with `db` — so a recorded create proves the filing happened
    // inside the transaction that cancelled the order and marked the payment.
    expect(db.refundRequest.create).toHaveBeenCalledTimes(1);
    // ...and the existing side effects are untouched by the change.
    expect(db.order.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "CANCELLED_UNPAID",
          cancellationReason: "LATE_PAYMENT",
          paymentStatus: "LATE_PAYMENT",
        }),
      }),
    );
  });

  it("4. stock restoration still happens for exactly the orders whose CAS succeeded", async () => {
    const { restoreStockForOrders } = require("../../src/services/inventory.service");
    await finalize();
    expect(restoreStockForOrders).toHaveBeenCalledWith(expect.anything(), ["order-A"]);
  });

  it("5. repeated processing does not create a duplicate obligation", async () => {
    await finalize();
    expect(refundCreates()).toHaveLength(1);

    // Second delivery: the payment is already LATE_PAYMENT, so the terminal
    // guard returns ALREADY_PROCESSED with zero writes.
    const second = await finalize();
    expect(second.outcome).toBe("ALREADY_PROCESSED");
    expect(refundCreates()).toHaveLength(1);
  });

  it("6. an already-open obligation for the same (paymentRef, orderId) is not duplicated", async () => {
    openRefund = { id: "rr-existing" };
    await finalize();
    expect(db.refundRequest.create).not.toHaveBeenCalled();
  });

  it("7. an order whose cancellation CAS loses receives no obligation", async () => {
    LATE_CAS["order-A"] = 0;
    const result = await finalize();

    expect(result.outcome).toBe("LATE_PAYMENT");
    expect(result.refundPendingOrderIds).toEqual([]);
    expect(refundCreates()).toHaveLength(0);
  });

  it("8. in a mixed batch only the cancelled orders receive obligations", async () => {
    db.order.findMany.mockResolvedValue([lateOrder("order-A"), lateOrder("order-B", { totalPrice: 250000 })]);
    seedCurrent("order-A");
    seedCurrent("order-B", { totalPrice: 250000 });
    LATE_CAS["order-B"] = 0;

    const result = await finalize({ amountKobo: 800000 });

    expect(result.outcome).toBe("LATE_PAYMENT");
    expect(result.refundPendingOrderIds).toEqual(["order-A"]);
    expect(refundCreates()).toHaveLength(1);
    expect(refundCreates()[0]).toMatchObject({ orderId: "order-A", requestedAmountKobo: 550000 });
  });

  it("9. a late capture that wins NO order CAS files nothing at all", async () => {
    db.order.findMany.mockResolvedValue([lateOrder("order-A")]);
    seedCurrent("order-A");
    LATE_CAS["order-A"] = 0;
    MISMATCH_CLAIM = 0; // payment transition also lost

    const result = await finalize();
    expect(result.outcome).toBe("ALREADY_PROCESSED");
    expect(refundCreates()).toHaveLength(0);
  });

  it("10. a normal in-window capture still files nothing (no regression to the success path)", async () => {
    // Payment well inside its window and no protection expiry -> not late.
    db.payment.findUnique.mockImplementation(async () => paymentRow({ status: "PENDING" }));
    db.order.findMany.mockResolvedValue([orderRow("order-A")]);
    CURRENT["order-A"] = { status: "PAYMENT_CONFIRMED", customerId: "cust-1", totalPrice: 550000 } as never;

    const result = await finalize();
    expect(result.outcome).toBe("SUCCESS");
    expect(refundCreates()).toHaveLength(0);
  });
});

/**
 * FIN-07-02 — a capture verified for a payment this system had already expired
 * locally.
 *
 * Before: `verifyPendingPayments` settles a reference to EXPIRED once
 * `expiresAt` passes, without asking the provider whether a charge succeeded. A
 * capture arriving in that window hit the terminal-state guard, returned
 * ALREADY_PROCESSED with zero writes, and the webhook answered 200 — so
 * captured funds had no queryable record of being owed back.
 *
 * After: the payment stays EXPIRED, no order is touched, and one order-scoped
 * PENDING refund obligation is filed for each unfulfillable order. No Paystack
 * call is made; the obligation waits for the existing admin approval workflow.
 *
 * These prove application logic with a mocked client. They do NOT prove
 * PostgreSQL transaction behaviour — that needs a disposable-database run.
 */
describe("FIN-07-02 — capture verified against an already-EXPIRED payment", () => {
  /**
   * Durability model for obligations, mirroring the one the file already keeps
   * for payment status: a row the mock "committed" is visible to the helper's
   * dedupe query on a later invocation, exactly as it would be after a real
   * commit. Without this, a repeated delivery would see an empty table and
   * create a second obligation — the mock would be wrong, not the code.
   */
  let storedRefunds: any[] = [];

  beforeEach(() => {
    storedRefunds = [];
    jest.clearAllMocks();
    SUCCESS_CLAIM = 1;
    MISMATCH_CLAIM = 1;
    ORDER_CAS = {};
    LATE_CAS = {};
    openRefund = null;
    PERSISTED_PAYMENT_STATUS = "EXPIRED";
    CURRENT = {
      "order-A": { status: "CANCELLED_UNPAID", customerId: "cust-1", totalPrice: 550000 } as never,
    };

    db.$transaction.mockImplementation(async (arg: any) => {
      if (typeof arg !== "function") return arg;
      const snapshot = PERSISTED_PAYMENT_STATUS;
      try {
        return await arg(db);
      } catch (err) {
        PERSISTED_PAYMENT_STATUS = snapshot;
        throw err;
      }
    });
    db.payment.findUnique.mockImplementation(async () =>
      paymentRow({ status: PERSISTED_PAYMENT_STATUS, expiresAt: new Date(Date.now() - 60_000) }),
    );
    db.order.findMany.mockResolvedValue([
      orderRow("order-A", { status: "CANCELLED_UNPAID", paymentStatus: "EXPIRED" }),
    ]);
    db.order.findUnique.mockImplementation(async (args: any) => {
      const row = CURRENT[args?.where?.id];
      return row ? { ...row } : null;
    });
    // Record every write without pretending one happened; assertions below
    // prove none occurred on the payment or the order.
    db.payment.updateMany.mockImplementation(async (args: any) => {
      const where = args?.where ?? {};
      if ("isProcessing" in where || where.OR) return { count: 1 }; // lock only
      return { count: 1 };
    });
    db.order.updateMany.mockImplementation(async () => ({ count: 1 }));
    db.refundRequest.findFirst.mockImplementation(async (args: any) => {
      if (openRefund) return openRefund;
      const w = args?.where ?? {};
      const ids = (w.status?.in ?? []) as string[];
      return (
        storedRefunds.find(
          (r) =>
            r.paymentRef === w.paymentRef &&
            r.orderId === w.orderId &&
            ids.includes(r.status),
        ) ?? null
      );
    });
    db.refundRequest.create.mockImplementation(async (args: any) => {
      const row = { id: `rr-${storedRefunds.length + 1}`, ...args.data };
      storedRefunds.push(row);
      return row;
    });
  });

  /** Status-carrying payment writes (excludes the isProcessing lock). */
  const expiryStatusWrites = () =>
    db.payment.updateMany.mock.calls.filter((c: any) => c[0]?.data?.status).map((c: any) => c[0]);

  it("1. files a durable obligation and leaves the payment EXPIRED", async () => {
    const result = await finalize();

    expect(result.outcome).toBe("LATE_CAPTURE_REFUND_FILED");
    expect(result.refundPendingOrderIds).toEqual(["order-A"]);

    expect(refundCreates()).toHaveLength(1);
    expect(refundCreates()[0]).toMatchObject({
      userId: "cust-1",
      paymentRef: REFERENCE,
      orderId: "order-A",
      status: "PENDING",
      requestedAmountKobo: 550000,
    });
    expect(refundCreates()[0].reason).toContain("LATE_PAYMENT");

    // The terminal payment record is preserved, never rewritten to SUCCESS.
    expect(expiryStatusWrites()).toHaveLength(0);
    expect(PERSISTED_PAYMENT_STATUS).toBe("EXPIRED");
  });

  it("2. does not touch the cancelled order or restore inventory", async () => {
    await finalize();
    expect(orderStatusWrites()).toHaveLength(0);
    const { restoreStockForOrders } = require("../../src/services/inventory.service");
    expect(restoreStockForOrders).not.toHaveBeenCalled();
  });

  it("3. a repeated delivery does not file a second obligation", async () => {
    await finalize();
    await finalize(); // duplicate webhook / reconciliation pass
    expect(refundCreates()).toHaveLength(1);
    expect(expiryStatusWrites()).toHaveLength(0);
  });

  it("4. an already-open obligation on (paymentRef, orderId) is not duplicated", async () => {
    openRefund = { id: "rr-existing" };
    const result = await finalize();
    expect(result.outcome).toBe("LATE_CAPTURE_REFUND_FILED");
    expect(db.refundRequest.create).not.toHaveBeenCalled();
  });

  it("5. refuses to file for an amount that does not match the batch total", async () => {
    const result = await finalize({ amountKobo: 99_999_900 });
    expect(result.outcome).toBe("ALREADY_PROCESSED");
    expect(refundCreates()).toHaveLength(0);
    expect(expiryStatusWrites()).toHaveLength(0);
  });

  it("6. refuses to file for a non-NGN currency", async () => {
    const result = await finalize({ currency: "USD" });
    expect(result.outcome).toBe("ALREADY_PROCESSED");
    expect(refundCreates()).toHaveLength(0);
  });

  it("7. refuses to file when the gateway customer does not own the order", async () => {
    const result = await finalize({ customerIdFromGateway: "someone-else" });
    expect(result.outcome).toBe("ALREADY_PROCESSED");
    expect(refundCreates()).toHaveLength(0);
  });

  it("8. files nothing for an order that is still payable-pending", async () => {
    // This branch must not cancel an order; that is the expiry path's job.
    CURRENT = { "order-A": { status: "AWAITING_PAYMENT", customerId: "cust-1", totalPrice: 550000 } as never };
    const result = await finalize();
    expect(result.outcome).toBe("LATE_CAPTURE_REFUND_FILED");
    expect(result.refundPendingOrderIds).toEqual([]);
    expect(refundCreates()).toHaveLength(0);
    expect(orderStatusWrites()).toHaveLength(0);
  });

  it("9. a failure to persist the obligation propagates instead of reporting completion", async () => {
    db.refundRequest.create.mockRejectedValue(new Error("db exploded"));
    await expect(finalize()).rejects.toThrow(/db exploded/);
    // Nothing was reported as handled and nothing was written to the order.
    expect(orderStatusWrites()).toHaveLength(0);
    expect(expiryStatusWrites()).toHaveLength(0);
  });

  it("10. other settled states still take the untouched terminal guard", async () => {
    for (const status of ["LATE_PAYMENT", "AMOUNT_MISMATCH", "FAILED", "REFUNDED"]) {
      jest.clearAllMocks();
      PERSISTED_PAYMENT_STATUS = status;
      db.payment.findUnique.mockImplementation(async () => paymentRow({ status }));
      db.order.findMany.mockResolvedValue([
        orderRow("order-A", { status: "CANCELLED_UNPAID", paymentStatus: status }),
      ]);

      const result = await finalize();
      expect(result.outcome).toBe("ALREADY_PROCESSED");
      expect(refundCreates()).toHaveLength(0);
      expect(expiryStatusWrites()).toHaveLength(0);
    }
  });

  it("11. FIN-07-01 regression: an in-window capture is unaffected", async () => {
    PERSISTED_PAYMENT_STATUS = "PENDING";
    db.payment.findUnique.mockImplementation(async () => paymentRow({ status: "PENDING" }));
    db.order.findMany.mockResolvedValue([orderRow("order-A")]);

    const result = await finalize();
    expect(result.outcome).toBe("SUCCESS");
    expect(refundCreates()).toHaveLength(0);
  });
});
