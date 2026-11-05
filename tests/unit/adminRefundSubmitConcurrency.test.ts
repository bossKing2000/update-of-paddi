/**
 * C-3 — an admin refund submission must not issue TWO Paystack refunds for one
 * underlying refund obligation.
 *
 * The defect: `updateRefundStatus` read the refund request OUTSIDE its
 * transaction and gated submission on `status === APPROVED`. Two concurrent
 * admin submissions both read APPROVED and both proceeded. Inside the
 * transaction the `SELECT ... FOR UPDATE` on Payment serialised the *balance*,
 * and the `refundRequest.update({ where: { id } })` that marked the obligation
 * PROCESSING was an UNCONDITIONAL write — so the loser overwrote the winner's
 * row and went on to call `refundPaymentViaPaystack` a second time.
 *
 * The fix makes that write a compare-and-set on the expected source status, so
 * exactly one request can claim the obligation. These tests drive the real
 * controller with Paystack fully mocked — no provider is ever contacted.
 */
import { PaymentStatus, RefundStatus } from "@prisma/client";

jest.mock("../../src/lib/prisma", () => ({
  __esModule: true,
  default: {
    refundRequest: { findUnique: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
    payment: { findUnique: jest.fn(), findUniqueOrThrow: jest.fn(), updateMany: jest.fn() },
    $transaction: jest.fn(),
    $queryRaw: jest.fn(),
  },
}));

jest.mock("../../src/lib/axiosClient", () => ({
  __esModule: true,
  paystack: { post: jest.fn(), get: jest.fn() },
}));

jest.mock("../../src/services/refundFinalizer.service", () => ({
  __esModule: true,
  failRefund: jest.fn(async () => ({ outcome: "FAILED" })),
}));

jest.mock("../../src/utils/auditLog.service", () => ({
  __esModule: true,
  createAuditLog: jest.fn(async () => ({})),
}));

import prisma from "../../src/lib/prisma";
import { paystack } from "../../src/lib/axiosClient";
import { failRefund } from "../../src/services/refundFinalizer.service";
import { updateRefundStatus } from "../../src/controllers/admin.controller";

const db = prisma as unknown as Record<string, any>;
const paystackMock = paystack as unknown as { post: jest.Mock; get: jest.Mock };

/** In-memory Payment row — `refundedAmount` is the reserved balance. */
let payment: { id: string; reference: string; amount: number; refundedAmount: number; status: string };

/** In-memory RefundRequest rows keyed by id. */
let requests: Record<string, any>;

/** Every Paystack POST /refund that actually left the process. */
let paystackCalls: Array<{ reference: string; amount?: number }>;

/** Serialises transactions, modelling the Payment row lock. */
let txChain: Promise<unknown>;
/** Undo entries for the transaction currently running. */
let undo: Array<() => void>;

/** How the mocked provider should behave for the next call. */
let paystackBehaviour: "ok" | "definite_failure" | "timeout";

function reqRes() {
  const r: any = {};
  r.status = jest.fn().mockReturnValue(r);
  r.json = jest.fn().mockReturnValue(r);
  return r;
}

function adminReq(id: string, body: any) {
  return { user: { id: "admin-1" }, params: { id }, body } as any;
}

beforeEach(() => {
  jest.clearAllMocks();
  payment = {
    id: "pay-1",
    reference: "PSK-TXN-1",
    amount: 2_000_000, // ₦20,000 — leaves room for two legitimate partials
    refundedAmount: 0,
    status: PaymentStatus.SUCCESS,
  };
  requests = {
    "rr-1": {
      id: "rr-1",
      userId: "cust-1",
      paymentRef: "PSK-TXN-1",
      reason: "Order cancelled after payment",
      status: RefundStatus.APPROVED,
      requestedAmountKobo: null,
      paystackRefundId: null,
      adminNote: null,
      resolvedByAdminId: null,
    },
  };
  paystackCalls = [];
  paystackBehaviour = "ok";

  db.refundRequest.findUnique.mockImplementation(async ({ where }: any) => {
    const row = requests[where.id];
    return row ? { ...row } : null;
  });

  db.payment.findUnique.mockImplementation(async ({ where }: any) => {
    if (where.reference !== payment.reference) return null;
    return { ...payment };
  });

  db.payment.findUniqueOrThrow.mockImplementation(async () => ({ ...payment }));

  // Balance reservation: an atomic conditional increment, exactly like the
  // production CAS. A rollback inside the transaction must undo it.
  db.payment.updateMany.mockImplementation(async ({ data, where }: any) => {
    if (where.refundedAmount !== undefined && where.refundedAmount !== payment.refundedAmount) {
      return { count: 0 };
    }
    const prev = payment.refundedAmount;
    payment.refundedAmount += data.refundedAmount.increment;
    undo.push(() => {
      payment.refundedAmount = prev;
    });
    return { count: 1 };
  });

  // C-3: the claim is a COMPARE-AND-SET on the expected source status.
  db.refundRequest.updateMany.mockImplementation(async ({ where, data }: any) => {
    const row = requests[where.id];
    if (!row) return { count: 0 };
    if (where.status !== undefined && row.status !== where.status) {
      return { count: 0 }; // someone else already claimed it
    }
    const prev = { ...row };
    Object.assign(row, data);
    undo.push(() => {
      requests[where.id] = prev;
    });
    return { count: 1 };
  });

  db.refundRequest.update.mockImplementation(async ({ where, data }: any) => {
    Object.assign(requests[where.id], data);
    return { ...requests[where.id] };
  });

  db.$queryRaw.mockResolvedValue([]);

  // Transactions are SERIALIZED, and a failed one rolls back only its own
  // writes. That is what `SELECT ... FOR UPDATE` on the Payment row does in
  // production: the loser waits, then re-reads a fresh balance and passes the
  // balance CAS, so the only thing left that can reject it is the obligation
  // compare-and-set. Modelling the lock is what makes this test meaningful
  // rather than accidentally passing via the balance check.
  txChain = Promise.resolve();
  undo = [];
  db.$transaction.mockImplementation((fn: any) => {
    const run = txChain.then(async () => {
      // Undo exactly the writes THIS transaction made. A blanket snapshot
      // would also revert the winner's post-commit paystackRefundId write.
      undo = [];
      try {
        return await fn(db);
      } catch (err) {
        for (let i = undo.length - 1; i >= 0; i--) undo[i]();
        throw err;
      }
    });
    txChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  });

  paystackMock.post.mockImplementation(async (_url: string, body: any) => {
    if (paystackBehaviour === "definite_failure") {
      const e: any = new Error("Paystack rejected the refund");
      e.response = { data: { message: "Invalid transaction" } };
      throw e;
    }
    if (paystackBehaviour === "timeout") {
      const e: any = new Error("timeout of 30000ms exceeded");
      e.code = "ECONNABORTED";
      e.request = {};
      throw e;
    }
    paystackCalls.push({ reference: body.transaction, amount: body.amount });
    return { data: { data: { id: 9001, status: "pending" } } };
  });
});

/** Submit `id` for processing. `amount` is in NAIRA, as the API accepts. */
function submit(id: string, amount?: number) {
  return updateRefundStatus(
    adminReq(id, { status: RefundStatus.COMPLETED, ...(amount !== undefined ? { amount } : {}) }),
    reqRes(),
  );
}

describe("C-3 — a single submission issues exactly one Paystack refund", () => {
  it("claims the obligation and calls Paystack once", async () => {
    await submit("rr-1", 5000);

    expect(paystackCalls).toHaveLength(1);
    expect(paystackCalls[0]).toEqual({ reference: "PSK-TXN-1", amount: 500_000 });
    expect(requests["rr-1"].status).toBe(RefundStatus.PROCESSING);
    expect(requests["rr-1"].paystackRefundId).toBe("9001");
  });

  it("acquires the claim BEFORE the external call", async () => {
    const order: string[] = [];
    db.refundRequest.updateMany.mockImplementation(async ({ where, data }: any) => {
      order.push("claim");
      const row = requests[where.id];
      if (where.status !== undefined && row.status !== where.status) return { count: 0 };
      Object.assign(row, data);
      return { count: 1 };
    });
    paystackMock.post.mockImplementation(async (_u: string, body: any) => {
      order.push("paystack");
      paystackCalls.push({ reference: body.transaction, amount: body.amount });
      return { data: { data: { id: 9002 } } };
    });

    await submit("rr-1", 5000);

    expect(order).toEqual(["claim", "paystack"]);
  });

  it("claims with a status predicate, not an unconditional write", async () => {
    await submit("rr-1", 5000);
    expect(db.refundRequest.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "rr-1", status: RefundStatus.APPROVED }),
      }),
    );
  });
});

describe("C-3 — two concurrent submissions for the SAME obligation", () => {
  it("only one reaches Paystack; the loser gets a conflict", async () => {
    const first = submit("rr-1", 5000);
    const second = submit("rr-1", 5000);
    const settled = await Promise.allSettled([first, second]);

    // Exactly one provider call — no duplicate refund.
    expect(paystackCalls).toHaveLength(1);

    const fulfilled = settled.filter((s) => s.status === "fulfilled");
    const rejected = settled.filter((s) => s.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason.message).toMatch(
      /already being submitted/i,
    );
  });

  it("does not double-reserve the balance when the loser is rejected", async () => {
    await Promise.allSettled([submit("rr-1", 5000), submit("rr-1", 5000)]);

    // One reservation of ₦5,000 survives; the loser's increment was rolled back.
    expect(payment.refundedAmount).toBe(500_000);
  });

  it("leaves the obligation in the shape reconciliation expects", async () => {
    await Promise.allSettled([submit("rr-1", 5000), submit("rr-1", 5000)]);

    expect(requests["rr-1"].status).toBe(RefundStatus.PROCESSING);
    expect(requests["rr-1"].requestedAmountKobo).toBe(500_000);
    // Recorded for the first attempt; a crash before this point is still
    // recoverable via paymentRef + PROCESSING + no id.
    expect(requests["rr-1"].paystackRefundId).toBe("9001");
  });
});

describe("C-3 — ambiguous and definite provider outcomes", () => {
  it("a DEFINITE Paystack rejection releases the reservation via failRefund", async () => {
    paystackBehaviour = "definite_failure";

    await expect(submit("rr-1", 5000)).rejects.toThrow(/Refund failed/i);

    expect(failRefund).toHaveBeenCalledWith("rr-1", { source: "admin_sync" });
    // Retrying is safe: the obligation is not left claimed.
    expect(paystackCalls).toHaveLength(0);
  });

  it("an AMBIGUOUS timeout does NOT release the reservation or re-submit", async () => {
    paystackBehaviour = "timeout";

    await expect(submit("rr-1", 5000)).rejects.toThrow(/outcome is unknown/i);

    // The reservation stays held and the row stays PROCESSING so
    // verifyPendingRefunds / the webhook can reconcile it.
    expect(failRefund).not.toHaveBeenCalled();
    expect(requests["rr-1"].status).toBe(RefundStatus.PROCESSING);
    expect(payment.refundedAmount).toBe(500_000);
  });

  it("after an ambiguous timeout, a resubmit is refused rather than double-refunded", async () => {
    paystackBehaviour = "timeout";
    await expect(submit("rr-1", 5000)).rejects.toThrow();

    paystackBehaviour = "ok";
    await expect(submit("rr-1", 5000)).rejects.toThrow(
      /must be APPROVED|already being submitted/i,
    );

    // The unknown first attempt is still the only provider call attempted.
    expect(paystackCalls).toHaveLength(0);
  });
});

describe("C-3 — eligibility, authorization and legitimate distinct refunds", () => {
  it("refuses a request that is not APPROVED, without calling Paystack", async () => {
    requests["rr-1"].status = RefundStatus.PENDING;

    await expect(submit("rr-1", 5000)).rejects.toThrow(/must be APPROVED/i);
    expect(paystackCalls).toHaveLength(0);
  });

  it("refuses a payment that is not refundable, without calling Paystack", async () => {
    payment.status = PaymentStatus.FAILED;

    await expect(submit("rr-1", 5000)).rejects.toThrow(/Cannot refund a payment/i);
    expect(paystackCalls).toHaveLength(0);
  });

  it("still rejects an amount beyond the remaining balance", async () => {
    await expect(submit("rr-1", 999_999)).rejects.toThrow(/exceeds remaining/i);
    expect(paystackCalls).toHaveLength(0);
  });

  it("allows two SEPARATE refund obligations on the same payment", async () => {
    requests["rr-2"] = {
      id: "rr-2",
      userId: "cust-1",
      paymentRef: "PSK-TXN-1",
      reason: "Second order in the batch",
      status: RefundStatus.APPROVED,
      requestedAmountKobo: null,
      paystackRefundId: null,
      adminNote: null,
      resolvedByAdminId: null,
    };

    await submit("rr-1", 5000);
    await submit("rr-2", 4000);

    // Distinct obligations are NOT blocked by the claim — partial refunds of a
    // batch payment remain possible.
    expect(paystackCalls).toHaveLength(2);
    expect(requests["rr-2"].status).toBe(RefundStatus.PROCESSING);
    expect(payment.refundedAmount).toBe(900_000);
  });
});
