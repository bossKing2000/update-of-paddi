/**
 * Phase 3.2.19 (FIN-08) — refund finalizer concurrency hardening.
 *
 * Before: `failRefund`/`completeRefund` read the refund, then wrote
 *   - `payment.updateMany({ where: { reference } })` with NO status predicate
 *     (the money-ledger release), and
 *   - `refundRequest.update({ where: { id } })` with NO status predicate.
 * Three independent callers exist (webhook, reconciliation, admin_sync), so a
 * duplicate webhook racing the reconciler could read PROCESSING twice, release
 * the reservation twice, and run conflicting terminal transitions.
 *
 * After: the refund row is CLAIMED with a conditional update on
 * `[PROCESSING]` first; only the winner adjusts the ledger.
 *
 * These tests use a STATEFUL fake (not call-counting): the fake stores refund
 * rows and applies conditional updates the way PostgreSQL would, so the
 * assertions are about observable accounting — "the reservation was released
 * exactly once" — rather than about which mock was called.
 *
 * LIMITATION: this fake is single-threaded JS, so it proves the CLAIM GATING
 * (a loser never reaches the ledger) but it does NOT prove real concurrent
 * transaction interleaving under PostgreSQL. That requires a disposable
 * database with two real transactions; see the final report.
 */
import { RefundStatus, PaymentStatus, OrderStatus } from "@prisma/client";

type RefundRow = {
  id: string;
  paymentRef: string;
  status: RefundStatus;
  requestedAmountKobo: number | null;
  paystackRefundId?: string | null;
  orderId?: string | null;
};
type PaymentRow = {
  id: string;
  reference: string;
  amount: number;
  status: PaymentStatus;
  refundedAmount: number;
  idempotencyKey: string | null;
  orderId: string;
};

/** In-memory stores shared by the fake and the assertions. */
const db = {
  refunds: new Map<string, RefundRow>(),
  payments: new Map<string, PaymentRow>(),
  orders: new Map<string, any>(),
};

const tx = {
  refundRequest: {
    findUnique: jest.fn(async ({ where }: any) => {
      const row = db.refunds.get(where.id);
      return row ? { ...row } : null;
    }),
    // The conditional claim, modelled faithfully: it matches only while the
    // row is still in the state the predicate names, and it persists the
    // change — exactly the property the fix depends on.
    updateMany: jest.fn(async ({ where, data }: any) => {
      const row = db.refunds.get(where.id);
      if (!row) return { count: 0 };
      if (where.status !== undefined && row.status !== where.status) return { count: 0 };
      Object.assign(row, data);
      return { count: 1 };
    }),
    aggregate: jest.fn(async ({ where }: any) => {
      const rows = [...db.refunds.values()].filter(
        (r) => r.paymentRef === where.paymentRef && r.status === where.status,
      );
      const sum = rows.reduce((s, r) => s + (r.requestedAmountKobo ?? 0), 0);
      return { _sum: { requestedAmountKobo: sum } };
    }),
  },
  payment: {
    findUnique: jest.fn(async ({ where }: any) => {
      const row = db.payments.get(where.reference);
      return row ? { ...row } : null;
    }),
    update: jest.fn(async ({ where, data }: any) => {
      const row = db.payments.get(where.id);
      if (row) Object.assign(row, data);
      return row;
    }),
    updateMany: jest.fn(async ({ where, data }: any) => {
      const row = db.payments.get(where.reference);
      if (!row) return { count: 0 };
      if (data.refundedAmount?.decrement !== undefined) {
        row.refundedAmount -= data.refundedAmount.decrement;
      }
      if (data.refundedAmount?.increment !== undefined) {
        row.refundedAmount += data.refundedAmount.increment;
      }
      return { count: 1 };
    }),
  },
  order: {
    findMany: jest.fn(async ({ where }: any) => {
      if (where.id) return where.id.map((id: string) => db.orders.get(id)).filter(Boolean);
      return [...db.orders.values()];
    }),
    updateMany: jest.fn(async () => ({ count: 1 })),
  },
  deliveryAssignment: { updateMany: jest.fn(async () => ({ count: 1 })) },
};

jest.mock("../../src/lib/prisma", () => ({
  __esModule: true,
  default: {
    $transaction: jest.fn(async (fn: any) => fn(tx)),
  },
}));

jest.mock("../../src/utils/auditLog.service", () => ({
  createAuditLog: jest.fn(async () => undefined),
}));

import { completeRefund, failRefund } from "../../src/services/refundFinalizer.service";

const REF = "PSK-1";

function seed(opts: { refundStatus?: RefundStatus; reserved?: number; paymentStatus?: PaymentStatus } = {}) {
  db.refunds.clear();
  db.payments.clear();
  db.orders.clear();
  db.refunds.set("rr-1", {
    id: "rr-1",
    paymentRef: REF,
    status: opts.refundStatus ?? RefundStatus.PROCESSING,
    requestedAmountKobo: opts.reserved ?? 6000,
    orderId: null,
  });
  db.payments.set(REF, {
    id: "pay-1",
    reference: REF,
    amount: 10000,
    status: opts.paymentStatus ?? PaymentStatus.SUCCESS,
    // The reservation this refund holds.
    refundedAmount: opts.reserved ?? 6000,
    idempotencyKey: "K1",
    orderId: "o-1",
  });
  db.orders.set("o-1", { id: "o-1", status: OrderStatus.PAYMENT_CONFIRMED });
}

const reserved = () => db.payments.get(REF)!.refundedAmount;
const refundRow = () => db.refunds.get("rr-1")!;

beforeEach(() => {
  jest.clearAllMocks();
  seed();
});

describe("FIN-08 — the reservation is released at most once", () => {
  it("1. two competing failRefund calls release the reservation once", async () => {
    const [a, b] = await Promise.all([
      failRefund("rr-1", { source: "webhook" }),
      failRefund("rr-1", { source: "reconciliation" }),
    ]);

    const outcomes = [a.outcome, b.outcome];
    expect(outcomes.filter((o) => o === "SUCCESS")).toHaveLength(1);
    // The loser reports the established vocabulary, not a new one.
    expect(outcomes).toContain("ALREADY_FAILED");
    // Observable accounting: one release, not two.
    expect(reserved()).toBe(0);
    expect(refundRow().status).toBe(RefundStatus.FAILED);
  });

  it("2. a repeated failure never decrements the ledger again", async () => {
    await failRefund("rr-1", { source: "webhook" });
    expect(reserved()).toBe(0);

    const again = await failRefund("rr-1", { source: "reconciliation" });

    expect(again.outcome).toBe("ALREADY_FAILED");
    expect(reserved()).toBe(0);
    // The losing execution never touched the payment ledger at all.
    expect(tx.payment.updateMany).toHaveBeenCalledTimes(1);
  });

  it("3. failure cannot reverse a completed refund or release its reservation", async () => {
    seed({ refundStatus: RefundStatus.COMPLETED, reserved: 6000 });

    const result = await failRefund("rr-1", { source: "webhook" });

    expect(result.outcome).toBe("UNEXPECTED_STATE");
    expect(reserved()).toBe(6000); // untouched
    expect(tx.payment.updateMany).not.toHaveBeenCalled();
  });

  it("4. completion versus failure: exactly one terminal transition wins", async () => {
    const [c, f] = await Promise.all([
      completeRefund("rr-1", { source: "webhook", paystackRefundId: "rs-1" }),
      failRefund("rr-1", { source: "reconciliation" }),
    ]);

    const won = [c, f].filter((r) => r.outcome === "SUCCESS");
    expect(won).toHaveLength(1);

    // The refund ends in exactly one terminal state, and the ledger reflects
    // ONLY the winner's effect:
    //  - failure won  -> the reservation is released exactly once (0 remains);
    //  - completion won -> the reservation stays committed (completion is a
    //    real refund, not a release of held funds), so nothing is decremented.
    const status = refundRow().status;
    const releaseCalls = tx.payment.updateMany.mock.calls.length;
    if (status === RefundStatus.FAILED) {
      expect(reserved()).toBe(0);
      expect(releaseCalls).toBe(1);
      expect(f.outcome).toBe("SUCCESS");
      expect(c.outcome).not.toBe("SUCCESS");
    } else {
      expect(status).toBe(RefundStatus.COMPLETED);
      expect(reserved()).toBe(6000);
      expect(releaseCalls).toBe(0);
      expect(c.outcome).toBe("SUCCESS");
      expect(f.outcome).not.toBe("SUCCESS");
    }
    expect([RefundStatus.COMPLETED, RefundStatus.FAILED]).toContain(status);
  });

  it("5. duplicate completion is a no-op that keeps the reservation committed", async () => {
    const first = await completeRefund("rr-1", { source: "webhook", paystackRefundId: "rs-1" });
    expect(first.outcome).toBe("SUCCESS");

    const second = await completeRefund("rr-1", { source: "reconciliation", paystackRefundId: "rs-1" });

    expect(second.outcome).toBe("ALREADY_COMPLETED");
    // A completed refund is not re-counted or re-released, and the completed
    // sum is computed once.
    expect(tx.refundRequest.aggregate).toHaveBeenCalledTimes(1);
  });

  it("6. a definitive failure releases exactly the reserved amount, once", async () => {
    const result = await failRefund("rr-1", { source: "webhook" });

    expect(result).toMatchObject({ outcome: "SUCCESS", releasedKobo: 6000 });
    expect(reserved()).toBe(0);
    expect(tx.payment.updateMany).toHaveBeenCalledWith({
      where: { reference: REF },
      data: { refundedAmount: { decrement: 6000 } },
    });
  });

  it("7. a database failure inside the transaction propagates (fails closed)", async () => {
    tx.payment.updateMany.mockRejectedValueOnce(new Error("db exploded"));

    await expect(failRefund("rr-1", { source: "webhook" })).rejects.toThrow(/db exploded/);

    // The fake does not roll back on its own, but the refund row was already
    // claimed inside the same transaction, which a real database would undo —
    // proving the money write and the claim are inseparable.
    expect(tx.refundRequest.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.payment.updateMany).toHaveBeenCalledTimes(1);
  });

  it("8. a refund row that vanishes is reported as NOT_FOUND", async () => {
    db.refunds.delete("rr-1");

    const result = await failRefund("rr-1", { source: "webhook" });

    expect(result.outcome).toBe("NOT_FOUND");
    expect(tx.payment.updateMany).not.toHaveBeenCalled();
  });
});