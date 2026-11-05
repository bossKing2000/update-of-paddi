/**
 * C-3 — the admin refund claim under REAL PostgreSQL concurrency.
 *
 * The unit suite (tests/unit/adminRefundSubmitConcurrency.test.ts) proves the
 * branch logic with a model that serialises transactions. This suite exercises
 * the real `updateRefundStatus` handler against a real PostgreSQL database, so
 * the behaviour that matters is the genuine one:
 *
 *   - `SELECT ... FOR UPDATE` really does serialise the competing submissions
 *     on the Payment row;
 *   - the compare-and-set on `RefundRequest` really does reject the loser;
 *   - the loser's balance reservation is really rolled back by the database;
 *   - the claim really does commit before the external call.
 *
 * PAYSTACK IS FULLY MOCKED. `src/lib/axiosClient` is replaced wholesale, so no
 * HTTP request is ever made and no provider is contacted. Only the provider
 * boundary is faked — every database interaction is real.
 *
 * Requires the disposable test database, configured through the standard
 * harness variables (see tests/README.md). Run with the integration config:
 *   npx jest --config jest.integration.config.js --runInBand \
 *     tests/integration/adminRefundClaimConcurrency.test.ts
 *
 * Self-cleaning: every row it creates is removed in afterAll.
 */
import { PrismaClient, PaymentStatus, RefundStatus } from "@prisma/client";

jest.mock("../../src/lib/axiosClient", () => {
  const post = jest.fn();
  return { __esModule: true, paystack: { post, get: jest.fn() }, __paystackPost: post };
});
jest.mock("../../src/utils/auditLog.service", () => ({
  __esModule: true,
  createAuditLog: jest.fn(async () => ({})),
}));

import prisma from "../../src/lib/prisma";
import { updateRefundStatus } from "../../src/controllers/admin.controller";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { __paystackPost: paystackPost } = require("../../src/lib/axiosClient");

jest.setTimeout(120_000);

const admin = new PrismaClient();
const tag = `c3pg-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const suffix = tag.slice(0, 18);

let customerId = "";
let vendorId = "";
let orderId = "";
let paymentId = "";
/** Every order this suite creates, for cleanup. */
let createdOrderIds: string[] = [];
let paymentRef = "";

/** RefundRequest ids created by this suite. */
let createdRefundIds: string[] = [];

beforeAll(async () => {
  const customer = await admin.user.create({
    data: { name: "C3 customer", email: `${suffix}-cust@example.test` },
  });
  customerId = customer.id;

  const vendor = await admin.user.create({
    data: { name: "C3 vendor", email: `${suffix}-vend@example.test` },
  });
  vendorId = vendor.id;

  orderId = await makeOrder();

  const payment = await admin.payment.create({
    data: {
      userId: customerId,
      orderId,
      // ₦20,000 — leaves room for two legitimate partial refunds.
      amount: 2_000_000,
      reference: `${tag}-txn`.toUpperCase(),
      status: PaymentStatus.SUCCESS,
    },
  });
  paymentId = payment.id;
  paymentRef = payment.reference;
});

afterAll(async () => {
  if (createdRefundIds.length) {
    await admin.refundRequest.deleteMany({ where: { id: { in: createdRefundIds } } });
  }
  if (paymentId) await admin.payment.deleteMany({ where: { id: paymentId } });
  if (createdOrderIds.length) {
    await admin.order.deleteMany({ where: { id: { in: createdOrderIds } } });
  }
  if (vendorId) await admin.user.deleteMany({ where: { id: vendorId } });
  if (customerId) await admin.user.deleteMany({ where: { id: customerId } });
  await admin.$disconnect();
  await prisma.$disconnect();
});

/**
 * A fresh order. Each test seeds its own, because the C-2 partial unique index
 * legitimately forbids two open obligations for the same (paymentRef, orderId)
 * — two distinct obligations must therefore reference distinct orders.
 */
async function makeOrder() {
  const order = await admin.order.create({
    data: { customerId, vendorId, basePrice: 20000, totalPrice: 20000 },
  });
  createdOrderIds.push(order.id);
  return order.id;
}

/** An APPROVED refund obligation for `amountKobo`, wired to our payment. */
async function seedApprovedObligation(amountKobo: number, forOrderId?: string) {
  const row = await admin.refundRequest.create({
    data: {
      userId: customerId,
      paymentRef,
      reason: "C-3 concurrency fixture",
      status: RefundStatus.APPROVED,
      requestedAmountKobo: amountKobo,
      orderId: forOrderId ?? orderId,
    },
  });
  createdRefundIds.push(row.id);
  return row.id;
}

function reqRes() {
  const r: any = {};
  r.status = jest.fn().mockReturnValue(r);
  r.json = jest.fn().mockReturnValue(r);
  return r;
}

function submit(refundRequestId: string) {
  return updateRefundStatus(
    {
      user: { id: customerId },
      params: { id: refundRequestId },
      body: { status: RefundStatus.COMPLETED },
      headers: {},
    } as any,
    reqRes(),
  );
}

beforeEach(() => {
  paystackPost.mockReset();
  paystackPost.mockResolvedValue({ data: { data: { id: 424242, status: "pending" } } });
});

describe("C-3 — real PostgreSQL: two concurrent admin submissions", () => {
  it("claims the obligation exactly once and calls the provider once", async () => {
    const id = await seedApprovedObligation(500_000);

    const settled = await Promise.allSettled([submit(id), submit(id)]);

    // The provider boundary was reached at most once.
    expect(paystackPost).toHaveBeenCalledTimes(1);
    expect(paystackPost).toHaveBeenCalledWith("/refund", {
      transaction: paymentRef,
      amount: 500_000,
    });

    const fulfilled = settled.filter((s) => s.status === "fulfilled");
    const rejected = settled.filter((s) => s.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason.message).toMatch(
      /already being submitted/i,
    );

    // The loser retained NO extra balance reservation.
    const payment = await admin.payment.findUniqueOrThrow({ where: { id: paymentId } });
    expect(payment.refundedAmount).toBe(500_000);

    // The obligation is left in the shape reconciliation expects.
    const row = await admin.refundRequest.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe(RefundStatus.PROCESSING);
    expect(row.requestedAmountKobo).toBe(500_000);
    expect(row.paystackRefundId).toBe("424242");
  });

  it("still permits a SEPARATE approved obligation on the same payment", async () => {
    // Distinct orders: the C-2 index permits only one OPEN obligation per
    // (paymentRef, orderId), so separate obligations must be separate orders.
    const first = await seedApprovedObligation(300_000, await makeOrder());
    const second = await seedApprovedObligation(400_000, await makeOrder());
    // The payment is shared across cases, so assert the delta.
    const before = (await admin.payment.findUniqueOrThrow({ where: { id: paymentId } }))
      .refundedAmount;

    await submit(first);
    await submit(second);

    // Distinct obligations are not blocked by the claim.
    expect(paystackPost).toHaveBeenCalledTimes(2);

    const payment = await admin.payment.findUniqueOrThrow({ where: { id: paymentId } });
    expect(payment.refundedAmount).toBe(before + 700_000);

    for (const id of [first, second]) {
      const row = await admin.refundRequest.findUniqueOrThrow({ where: { id } });
      expect(row.status).toBe(RefundStatus.PROCESSING);
    }
  });

  it("a non-APPROVED obligation is refused without contacting the provider", async () => {
    const id = await seedApprovedObligation(100_000, await makeOrder());
    const before = (await admin.payment.findUniqueOrThrow({ where: { id: paymentId } }))
      .refundedAmount;
    await admin.refundRequest.update({
      where: { id },
      data: { status: RefundStatus.PENDING },
    });

    await expect(submit(id)).rejects.toThrow(/must be APPROVED/i);
    expect(paystackPost).not.toHaveBeenCalled();

    const payment = await admin.payment.findUniqueOrThrow({ where: { id: paymentId } });
    expect(payment.refundedAmount).toBe(before); // unchanged
  });
});
