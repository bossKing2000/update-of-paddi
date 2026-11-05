/**
 * Phase 3.2.8 (F-2) — conditional confirmation re-sync.
 *
 * The idempotent branch (payment already SUCCESS) previously wrote
 * `status: PAYMENT_CONFIRMED` with `where: { id: { in: [...] } }` — no
 * status predicate — so a cancellation landing between the read and the
 * transaction was overwritten. Each order is now claimed with its own
 * conditional update on the payable-pending set.
 *
 * Real `finalizePaymentSuccess`, mocked Prisma. The race is simulated by
 * the CAS count; PostgreSQL isolation is NOT proven here (see the report).
 */
jest.mock("../../src/lib/prisma", () => ({
  __esModule: true,
  default: {
    payment: { findUnique: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
    order: { findMany: jest.fn(), findUnique: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
    refundRequest: { findFirst: jest.fn(), create: jest.fn() },
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
import prisma from "../../src/lib/prisma";

const db = prisma as unknown as Record<string, Record<string, jest.Mock>>;
const mockedNotify = recordActivityBundle as jest.Mock;

const REFERENCE = "PSK-777";

/** Per-order CAS outcome for the re-sync confirmation. */
let RESYNC_CAS: Record<string, number> = {};

function successPayment() {
  return {
    id: "pay-1",
    reference: REFERENCE,
    orderId: "order-A",
    idempotencyKey: "batch-1",
    status: "SUCCESS",
    expiresAt: new Date(Date.now() + 10 * 60_000),
    channel: "card",
    createdAt: new Date(),
  };
}

function orderRow(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    customerId: "cust-1",
    vendorId: "vend-1",
    idempotencyKey: "batch-1",
    status: "AWAITING_PAYMENT",
    paymentStatus: "SUCCESS",
    totalPrice: 550000,
    paidAt: null,
    protectedUntil: null,
    items: [{ productId: "prod-1", quantity: 1 }],
    ...over,
  };
}

function finalize() {
  return finalizePaymentSuccess({
    reference: REFERENCE,
    amountKobo: 550000,
    currency: "NGN",
  });
}

/** Status-carrying order writes that used the payable-pending CAS. */
const resyncCAs = () =>
  db.order.updateMany.mock.calls
    .filter((c) => c[0].data?.status === "PAYMENT_CONFIRMED")
    .map((c) => c[0]);

beforeEach(() => {
  jest.clearAllMocks();
  RESYNC_CAS = {};

  db.$transaction.mockImplementation(async (arg: any) =>
    typeof arg === "function" ? arg(db) : arg,
  );
  db.payment.findUnique.mockResolvedValue(successPayment());
  db.order.findMany.mockResolvedValue([orderRow("order-A")]);
  db.order.findUnique.mockResolvedValue(null);
  db.payment.updateMany.mockResolvedValue({ count: 1 });
  db.order.updateMany.mockImplementation(async (args: any) => {
    if (args?.data?.status === "PAYMENT_CONFIRMED") {
      const id = args.where.id;
      return { count: id in RESYNC_CAS ? RESYNC_CAS[id] : 1 };
    }
    return { count: 1 };
  });
});

describe("F-2 — conditional confirmation re-sync", () => {
  it("1. an eligible order re-syncs through a status-predicate claim", async () => {
    const result = await finalize();

    expect(result.outcome).toBe("ALREADY_PROCESSED");
    expect(resyncCAs()).toEqual([
      expect.objectContaining({
        where: { id: "order-A", status: { in: ["AWAITING_PAYMENT", "PENDING"] } },
      }),
    ]);
    // The old id-only bulk write must be gone entirely.
    expect(
      db.order.updateMany.mock.calls.filter((c) => Array.isArray(c[0].where?.id?.in)),
    ).toHaveLength(0);
    // This branch performs no winner-only side effects.
    expect(mockedNotify).not.toHaveBeenCalled();
  });

  it("2. cancellation wins first: the cancelled order is not resurrected", async () => {
    RESYNC_CAS = { "order-A": 0 };

    const result = await finalize();

    expect(result.outcome).toBe("ALREADY_PROCESSED");
    // The claim was still attempted (that is the CAS) and matched nothing;
    // the code took the losing branch and stopped.
    expect(resyncCAs()).toHaveLength(1);
    expect(mockedNotify).not.toHaveBeenCalled();
  });

  it("3. re-sync wins when the order is still payable-pending", async () => {
    RESYNC_CAS = { "order-A": 1 };
    await finalize();
    expect(resyncCAs()).toHaveLength(1);
  });

  it("4. a mixed batch claims each order independently", async () => {
    db.order.findMany.mockResolvedValue([
      orderRow("order-A"),
      orderRow("order-B", { totalPrice: 500000 }),
    ]);
    RESYNC_CAS = { "order-A": 1, "order-B": 0 };

    await finalize();

    expect(resyncCAs().map((c: any) => c.where.id)).toEqual(["order-A", "order-B"]);
    for (const write of resyncCAs()) {
      expect(write.where.status).toEqual({ in: ["AWAITING_PAYMENT", "PENDING"] });
    }
  });

  it("5. terminal orders are never even considered for confirmation", async () => {
    // Cancelled order: not in the eligible set, so no status write at all.
    db.order.findMany.mockResolvedValue([orderRow("order-A", { status: "CANCELLED" })]);
    db.order.updateMany.mockResolvedValue({ count: 0 });

    await finalize();

    expect(resyncCAs()).toHaveLength(0);
  });

  it("6. a persistent database error is not swallowed as a race loss", async () => {
    // Every attempt fails, so the error must surface rather than being
    // reported as an ordinary zero-row CAS loss / ALREADY_PROCESSED.
    db.order.updateMany.mockRejectedValue(new Error("db exploded"));

    await expect(finalize()).rejects.toThrow(/db exploded/);
  });

  it("7. payment truth is still repaired for out-of-sync orders", async () => {
    db.order.findMany.mockResolvedValue([
      orderRow("order-A", { status: "COOKING", paymentStatus: "PENDING" }),
    ]);

    await finalize();

    // Payment truth write carries no status — it cannot resurrect anything.
    expect(
      db.order.updateMany.mock.calls.filter((c) => c[0].data?.paymentStatus === "SUCCESS"),
    ).toHaveLength(1);
    expect(resyncCAs()).toHaveLength(0);
  });
});

/**
 * Phase 3.2.10 (F2-01) — the re-sync must never overwrite a settled
 * payment marker. A fully refunded order (CANCELLED + paymentStatus
 * REFUNDED, written together by the refund finalizer) received a duplicate
 * `charge.success`; the unpredicated payment-truth write reset its marker
 * to SUCCESS, contradicting its refund history.
 */
describe("F2-01 — terminal payment markers survive re-sync", () => {
  /** Mirrors a database predicate: only unresolved markers match. */
  function markerAwareOrderUpdate() {
    db.order.updateMany.mockImplementation(async (args: any) => {
      if (args?.data?.status === "PAYMENT_CONFIRMED") {
        const id = args.where.id;
        return { count: id in RESYNC_CAS ? RESYNC_CAS[id] : 1 };
      }
      if (args?.data?.paymentStatus === "SUCCESS") {
        const allowed = args.where?.paymentStatus?.in;
        const inIds = args.where?.id?.in;
        if (!Array.isArray(allowed)) return { count: inIds?.length ?? 0 };
        // Only orders still in an unresolved marker match.
        return {
          count: (inIds ?? []).filter((id: string) =>
            String(MARKERS[id] ?? "").length
              ? allowed.includes(MARKERS[id as keyof typeof MARKERS])
              : false,
          ).length,
        };
      }
      return { count: 1 };
    });
  }

  /** Authoritative `paymentStatus` per order, as the database holds it. */
  let MARKERS: Record<string, string> = {};

  beforeEach(() => {
    MARKERS = {};
    markerAwareOrderUpdate();
  });

  it("1. a fully refunded order keeps REFUNDED after a duplicate charge.success", async () => {
    db.order.findMany.mockResolvedValue([
      orderRow("order-A", { status: "CANCELLED", paymentStatus: "REFUNDED" }),
    ]);
    MARKERS["order-A"] = "REFUNDED";

    const result = await finalize();

    expect(result.outcome).toBe("ALREADY_PROCESSED");
    // The write is still issued, but it cannot match a settled marker.
    const truthWrite = db.order.updateMany.mock.calls.find(
      (c) => c[0].data?.paymentStatus === "SUCCESS",
    );
    expect(truthWrite?.[0].where.paymentStatus).toEqual({
      in: ["PENDING", "INITIATED"],
    });
    // Nothing else was attempted: no confirmation, no refund, no side effect.
    expect(resyncCAs()).toHaveLength(0);
    expect(db.refundRequest.create).not.toHaveBeenCalled();
    expect(mockedNotify).not.toHaveBeenCalled();
  });

  it("2. each settled marker class is preserved, not only REFUNDED", async () => {
    for (const settled of ["REFUNDED", "EXPIRED", "LATE_PAYMENT", "AMOUNT_MISMATCH", "FAILED"]) {
      jest.clearAllMocks();
      MARKERS = { "order-A": settled };
      db.order.findMany.mockResolvedValue([
        orderRow("order-A", { status: "CANCELLED", paymentStatus: settled }),
      ]);
      markerAwareOrderUpdate();

      await finalize();

      const truthWrite = db.order.updateMany.mock.calls.find(
        (c) => c[0].data?.paymentStatus === "SUCCESS",
      );
      // Predicated to unresolved markers only, so a settled row is never
      // eligible regardless of which verdict it carries.
      expect(truthWrite?.[0].where.paymentStatus).toEqual({
        in: ["PENDING", "INITIATED"],
      });
    }
  });

  it("3. a legitimately stale PENDING/INITIATED marker is still repaired", async () => {
    db.order.findMany.mockResolvedValue([
      orderRow("order-A", { status: "COOKING", paymentStatus: "INITIATED" }),
    ]);
    MARKERS["order-A"] = "INITIATED";

    await finalize();

    // The write is issued with the unresolved predicate and matches.
    const truthWrite = db.order.updateMany.mock.calls.find(
      (c) => c[0].data?.paymentStatus === "SUCCESS",
    );
    expect(truthWrite?.[0].where.paymentStatus).toEqual({
      in: ["PENDING", "INITIATED"],
    });
    expect(truthWrite?.[0].where.id).toEqual({ in: ["order-A"] });
  });

  it("4. a concurrent refund that wins produces no unconditional fallback", async () => {
    db.order.findMany.mockResolvedValue([
      orderRow("order-A", { status: "AWAITING_PAYMENT", paymentStatus: "PENDING" }),
    ]);
    MARKERS["order-A"] = "PENDING";
    // A refund completes between the read and the write.
    db.order.updateMany.mockImplementation(async () => ({ count: 0 }));

    await finalize();

    // Exactly one paymentStatus write attempt — no second, unguarded write
    // following a zero-row result.
    const truthWrites = db.order.updateMany.mock.calls.filter(
      (c) => c[0].data?.paymentStatus === "SUCCESS",
    );
    expect(truthWrites).toHaveLength(1);
    expect(
      db.order.updateMany.mock.calls.filter((c) => !c[0].where?.paymentStatus && !c[0].data?.status),
    ).toHaveLength(0);
  });

  it("5. a database error still propagates rather than reading as a lost race", async () => {
    db.order.updateMany.mockRejectedValue(new Error("db exploded"));

    await expect(finalize()).rejects.toThrow(/db exploded/);
  });
});
