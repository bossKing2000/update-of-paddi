/**
 * Customer refund guard (POST /api/payments/refund — `requestRefund`).
 *
 * WHAT THIS LOCKS IN
 * ------------------
 * `requestRefund` is deliberately PAYMENT-WIDE, not order-scoped. One Paystack
 * transaction can cover several vendors' orders (Payment.orderId is only the
 * *primary* order), so the "is a refund already open for this payment?" guard
 * keys on `paymentRef` alone:
 *
 *   - blocks while a prior request can still move money (PENDING / APPROVED /
 *     PROCESSING) or already moved it (COMPLETED);
 *   - permits a new request once the prior one is terminal WITHOUT a
 *     reservation (FAILED / REJECTED), so a customer is never locked out of
 *     re-requesting behind a failed attempt;
 *   - stays payment-wide even when the payment spans several of the
 *     customer's orders.
 *
 * This is a different question from *order attribution* (which order the
 * created RefundRequest points at, via `resolveRefundOrderId`) and a different
 * question again from *batching*: `tests/unit/batchRefund.test.ts` pins the
 * admin submit path's amount bounds. This suite pins the customer-facing guard.
 *
 * HOW IT EXERCISES THE REAL CODE
 * ------------------------------
 * The real `requestRefund` handler is imported and invoked directly. Prisma,
 * the Redis client module and the Paystack client module are mocked at their
 * module boundaries, so no database, Redis socket or provider is ever touched.
 *
 * The Prisma delegates are faithful in-memory fakes rather than blind
 * `mockResolvedValue` stubs: `refundRequest.findFirst` actually filters the
 * fixture rows against the `where` clause the controller passes. That matters —
 * a blind stub would keep passing if the controller silently dropped COMPLETED
 * from the blocking set or started scoping the guard to `orderId`. The fakes
 * additionally reject an `orderId` in the guard's `where` outright, so the
 * payment-wide invariant is enforced by the harness, not merely asserted.
 *
 * `resolveRefundOrderId` is NOT mocked — it is the real implementation from
 * `src/services/orderSnapshot.service.ts`, so attribution is tested against the
 * actual shared rule rather than a restatement of it.
 */

jest.mock("../../src/lib/prisma", () => ({
  __esModule: true,
  default: {
    payment: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
    },
    refundRequest: {
      findFirst: jest.fn(),
      create: jest.fn(),
      findMany: jest.fn(),
    },
    order: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    user: { findUnique: jest.fn() },
    auditLog: { create: jest.fn(async () => ({})) },
    $transaction: jest.fn(async (arg: any) =>
      typeof arg === "function" ? arg(require("../../src/lib/prisma").default) : arg,
    ),
    $queryRaw: jest.fn(),
  },
}));

// Mocked so no Redis client is even constructed and no socket is opened. The
// handler under test does not use Redis; this only removes the import-time
// dependency on a live REDIS_URL.
jest.mock("../../src/lib/redis", () => ({
  __esModule: true,
  redisNotifications: { get: jest.fn(), set: jest.fn(), del: jest.fn(), incr: jest.fn(), isOpen: true },
  redisProducts: { get: jest.fn(), set: jest.fn(), del: jest.fn(), scan: jest.fn() },
  redisSearch: { get: jest.fn(), set: jest.fn(), del: jest.fn(), scan: jest.fn() },
  redisTotalViews: { get: jest.fn(), set: jest.fn(), del: jest.fn(), incr: jest.fn(), scan: jest.fn() },
  redisUsersSessions: { get: jest.fn(), set: jest.fn(), del: jest.fn(), incr: jest.fn(), scan: jest.fn() },
  ShopCartRedis: { get: jest.fn(), set: jest.fn(), del: jest.fn() },
  redisPayments: { get: jest.fn(), set: jest.fn(), del: jest.fn(), incr: jest.fn(), scan: jest.fn() },
  connectRedis: jest.fn(async () => undefined),
  ensureRedisReady: jest.fn(async () => undefined),
}));

// Mocked so the Paystack axios client is never created. The handler under test
// does not call Paystack at all; this makes that guarantee structural.
jest.mock("../../src/services/paymentService", () => ({
  __esModule: true,
  initializePayment: jest.fn(),
  verifyPayment: jest.fn(),
  SUPPORTED_CHANNELS: ["card", "bank", "ussd", "bank_transfer"],
}));

jest.mock("../../src/utils/activityUtils/recordActivityBundle", () => ({
  __esModule: true,
  recordActivityBundle: jest.fn(async () => undefined),
}));

import { PaymentStatus, RefundStatus } from "@prisma/client";
import prisma from "../../src/lib/prisma";
import { requestRefund } from "../../src/controllers/paymentController";
import { recordActivityBundle } from "../../src/utils/activityUtils/recordActivityBundle";
import { ConflictError, NotFoundError, ValidationError } from "../../src/errors/AppError";

const db = prisma as unknown as Record<string, Record<string, jest.Mock>>;
const mockedActivity = recordActivityBundle as jest.Mock;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CUSTOMER_ID = "cust-1";
const OTHER_CUSTOMER_ID = "cust-2";
const REFERENCE = "PSK-BATCH-1";
const BATCH_KEY = "idem-key-1";

type PaymentFixture = {
  id: string;
  userId: string;
  orderId: string;
  idempotencyKey: string | null;
  reference: string;
  amount: number;
  refundedAmount: number;
  status: PaymentStatus;
};

type OrderFixture = {
  id: string;
  vendorId: string;
  customerId: string;
  idempotencyKey: string | null;
  totalPrice: number;
};

type RefundFixture = {
  id: string;
  userId: string;
  paymentRef: string;
  reason: string;
  status: RefundStatus;
  orderId: string | null;
  requestedAmountKobo?: number;
};

let payments: PaymentFixture[];
let orders: OrderFixture[];
let refunds: RefundFixture[];
let refundSeq: number;

function makePayment(overrides: Partial<PaymentFixture> = {}): PaymentFixture {
  return {
    id: "pay-1",
    userId: CUSTOMER_ID,
    orderId: "ord-A",
    idempotencyKey: BATCH_KEY,
    reference: REFERENCE,
    amount: 1_000_000,
    refundedAmount: 0,
    status: PaymentStatus.SUCCESS,
    ...overrides,
  };
}

function makeOrder(overrides: Partial<OrderFixture> = {}): OrderFixture {
  return {
    id: "ord-A",
    vendorId: "vend-A",
    customerId: CUSTOMER_ID,
    idempotencyKey: BATCH_KEY,
    totalPrice: 5500,
    ...overrides,
  };
}

function makeRefund(overrides: Partial<RefundFixture> = {}): RefundFixture {
  return {
    id: "rr-existing",
    userId: CUSTOMER_ID,
    paymentRef: REFERENCE,
    reason: "previous request",
    status: RefundStatus.PENDING,
    orderId: null,
    ...overrides,
  };
}

beforeEach(() => {
  payments = [];
  orders = [];
  refunds = [];
  refundSeq = 0;

  db.payment.findUnique.mockImplementation(async ({ where }) => {
    return payments.find((p) => p.reference === where.reference) ?? null;
  });

  db.order.findMany.mockImplementation(async ({ where }) => {
    return orders
      .filter(
        (o) =>
          o.idempotencyKey === where.idempotencyKey &&
          (where.customerId === undefined || o.customerId === where.customerId),
      )
      .map((o) => ({ id: o.id }));
  });

  db.order.findUnique.mockImplementation(async ({ where }) => {
    return orders.find((o) => o.id === where.id) ?? null;
  });

  // FAITHFUL GUARD FAKE.
  //
  // This filters the fixture rows by the very predicate the controller sends,
  // so the tests prove WHICH statuses block rather than merely proving that a
  // stubbed rejection happened. Removing COMPLETED from the controller's
  // blocking set, or adding a status that must not block, breaks these tests.
  db.refundRequest.findFirst.mockImplementation(async ({ where }) => {
    // The guard must stay payment-wide. An orderId in this predicate would mean
    // the customer guard had been narrowed to a single order of a multi-order
    // batch payment — the exact regression this suite exists to prevent.
    if ("orderId" in where) {
      throw new Error(
        "customer refund guard must stay payment-wide: the findFirst predicate " +
          "was unexpectedly narrowed to an orderId",
      );
    }
    const blocking = where.status?.in as RefundStatus[] | undefined;
    if (!Array.isArray(blocking)) {
      throw new Error("customer refund guard must filter by an explicit status list");
    }
    return (
      refunds.find(
        (r) => r.paymentRef === where.paymentRef && blocking.includes(r.status),
      ) ?? null
    );
  });

  db.refundRequest.create.mockImplementation(async ({ data }) => {
    const row: RefundFixture = { id: `rr-new-${++refundSeq}`, ...data };
    refunds.push(row);
    return row;
  });
});

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function res() {
  const r: any = {};
  r.status = jest.fn().mockReturnValue(r);
  r.json = jest.fn().mockReturnValue(r);
  return r;
}

function req(body: Record<string, unknown>, userId = CUSTOMER_ID) {
  return {
    user: { id: userId, sessionId: "sess-1" },
    body,
    params: {},
    query: {},
    headers: {},
    socket: { remoteAddress: "127.0.0.1" },
  } as never;
}

const SINGLE_KEY = "single-key";

/**
 * Successful payment owned by `userId`, plus the orders it covers.
 *
 * The order's `idempotencyKey` MUST match the payment's: that key is what
 * `resolveRefundOrderId` joins on, so a mismatched fixture would silently
 * produce `orderId: null` for the wrong reason.
 */
function seedSuccessfulPayment(opts: { multiOrder?: boolean; userId?: string } = {}) {
  const owner = opts.userId ?? CUSTOMER_ID;
  const key = opts.multiOrder ? BATCH_KEY : SINGLE_KEY;
  payments.push(makePayment({ userId: owner, orderId: "ord-A", idempotencyKey: key }));
  orders.push(makeOrder({ id: "ord-A", customerId: owner, idempotencyKey: key }));
  if (opts.multiOrder) {
    orders.push(
      makeOrder({
        id: "ord-B",
        vendorId: "vend-B",
        customerId: owner,
        idempotencyKey: key,
        totalPrice: 4500,
      }),
    );
  }
}

/** Seeded, valid request body for a fresh refund request. */
const NEW_REQUEST = { reference: REFERENCE, reason: "food arrived cold" };

// ===========================================================================
// A. An existing ACTIVE refund request blocks a new one
// ===========================================================================

describe("A. an existing active refund request blocks a second request", () => {
  const BLOCKING: RefundStatus[] = [
    RefundStatus.PENDING,
    RefundStatus.APPROVED,
    RefundStatus.PROCESSING,
  ];

  it.each(BLOCKING)("rejects with 409 when a %s request already exists", async (status) => {
    seedSuccessfulPayment();
    refunds.push(makeRefund({ status }));

    const r = res();
    await expect(requestRefund(req(NEW_REQUEST), r)).rejects.toBeInstanceOf(ConflictError);

    // Conflict semantics are part of the contract, not just "it threw".
    await expect(requestRefund(req(NEW_REQUEST), res())).rejects.toMatchObject({
      statusCode: 409,
      message: "Refund already requested for this payment",
    });

    // No second request may be created.
    expect(db.refundRequest.create).not.toHaveBeenCalled();
    expect(refunds).toHaveLength(1);
    expect(refunds[0].status).toBe(status);

    // Nothing downstream of the guard may run either.
    expect(mockedActivity).not.toHaveBeenCalled();
    expect(r.json).not.toHaveBeenCalled();
  });

  it("guards on paymentRef alone, so a request raised under another user id still blocks", async () => {
    // The guard is payment-wide: it does not additionally filter by userId.
    // The payment has exactly one owner, so this can only be reached through
    // an inconsistent row — but the point of the assertion is that the
    // predicate stays payment-wide, matching the documented design.
    seedSuccessfulPayment();
    refunds.push(makeRefund({ userId: OTHER_CUSTOMER_ID, status: RefundStatus.PENDING }));

    await expect(requestRefund(req(NEW_REQUEST), res())).rejects.toBeInstanceOf(ConflictError);

    expect(db.refundRequest.create).not.toHaveBeenCalled();
    expect(refunds).toHaveLength(1);
  });
});

// ===========================================================================
// B. A COMPLETED request still blocks (money already moved)
// ===========================================================================

describe("B. a COMPLETED refund request still blocks", () => {
  it("rejects with 409 and creates nothing", async () => {
    seedSuccessfulPayment();
    refunds.push(makeRefund({ status: RefundStatus.COMPLETED, requestedAmountKobo: 1000000 }));

    await expect(requestRefund(req(NEW_REQUEST), res())).rejects.toMatchObject({
      statusCode: 409,
      code: "CONFLICT",
      message: "Refund already requested for this payment",
    });

    expect(db.refundRequest.create).not.toHaveBeenCalled();
    expect(refunds).toHaveLength(1);
    expect(mockedActivity).not.toHaveBeenCalled();
  });

  it("COMPLETED is blocking because it moved money — proven by the predicate, not a stub", async () => {
    // The fake resolves the row only because the controller's status list
    // actually contains COMPLETED. If COMPLETED were dropped from the guard,
    // this fake would return null and the create would proceed.
    seedSuccessfulPayment();
    refunds.push(makeRefund({ status: RefundStatus.COMPLETED }));

    const before = refunds.length;
    await expect(requestRefund(req(NEW_REQUEST), res())).rejects.toBeInstanceOf(ConflictError);
    expect(refunds.length).toBe(before);
  });
});

// ===========================================================================
// C. Retry after a terminal-but-unreserved request is permitted
// ===========================================================================

describe("C. a FAILED or REJECTED prior request permits a new request", () => {
  it.each([RefundStatus.FAILED, RefundStatus.REJECTED])(
    "proceeds when the prior request is %s",
    async (status) => {
      seedSuccessfulPayment();
      refunds.push(makeRefund({ status }));

      const r = res();
      await requestRefund(req(NEW_REQUEST), r);

      expect(db.refundRequest.create).toHaveBeenCalledTimes(1);
      // The prior row survives untouched; a new one is appended.
      expect(refunds).toHaveLength(2);
      expect(refunds[0].status).toBe(status);

      const created = db.refundRequest.create.mock.calls[0][0].data;
      expect(created.status).toBe(RefundStatus.PENDING);
      expect(created.paymentRef).toBe(REFERENCE);
      expect(created.userId).toBe(CUSTOMER_ID);
      expect(created.reason).toBe(NEW_REQUEST.reason);

      // Success envelope, and the customer is told the request landed.
      expect(r.status).toHaveBeenCalledWith(200);
      expect(r.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          message: "Refund request submitted successfully",
        }),
      );

      // The audit/notification side effect only runs on the success path.
      expect(mockedActivity).toHaveBeenCalledTimes(1);
      const bundle = mockedActivity.mock.calls[0][0];
      expect(bundle.actorId).toBe(CUSTOMER_ID);
      expect(bundle.audit.action).toBe("REFUND_REQUESTED");
    },
  );

  it("keeps the customer path amountless so the admin remaining-balance fallback stays available", async () => {
    seedSuccessfulPayment();
    refunds.push(makeRefund({ status: RefundStatus.FAILED }));

    await requestRefund(req(NEW_REQUEST), res());

    const data = db.refundRequest.create.mock.calls[0][0].data;
    // The self-service path never sets an amount: the admin submit path
    // resolves `requestedAmountKobo ?? remaining` (see batchRefund.test.ts 4b).
    expect("requestedAmountKobo" in data).toBe(false);
    expect(data.requestedAmountKobo).toBeUndefined();
  });
});

// ===========================================================================
// D. Multi-order payment attribution
// ===========================================================================

describe("D. multi-order batch payments stay payment-wide and unattributed", () => {
  it("creates the request with orderId null when the payment spans several orders", async () => {
    seedSuccessfulPayment({ multiOrder: true });

    await requestRefund(req(NEW_REQUEST), res());

    // Both orders really are visible to the shared attribution rule …
    expect(db.order.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { idempotencyKey: BATCH_KEY, customerId: CUSTOMER_ID },
      }),
    );
    // … and it still refuses to guess between them.
    const data = db.refundRequest.create.mock.calls[0][0].data;
    expect(data.orderId).toBeNull();
    expect(data.paymentRef).toBe(REFERENCE);
    expect(data.status).toBe(RefundStatus.PENDING);
  });

  it("a blocking request on a multi-order payment blocks the next one just the same", async () => {
    seedSuccessfulPayment({ multiOrder: true });
    refunds.push(
      makeRefund({ status: RefundStatus.PROCESSING, orderId: "ord-A" }),
    );

    await expect(requestRefund(req(NEW_REQUEST), res())).rejects.toBeInstanceOf(ConflictError);

    // The pre-existing row is scoped to ord-A; the customer guard still blocks
    // because it never looks at orderId.
    expect(refunds).toHaveLength(1);
    expect(refunds[0].orderId).toBe("ord-A");
    expect(db.refundRequest.create).not.toHaveBeenCalled();
  });

  it("a single-order payment is still attributed to that exact order", async () => {
    // Counterpart to the multi-order case: proves orderId is not hardcoded to
    // null and that `resolveRefundOrderId`'s real implementation is in play.
    seedSuccessfulPayment();

    await requestRefund(req(NEW_REQUEST), res());

    expect(db.refundRequest.create.mock.calls[0][0].data.orderId).toBe("ord-A");
  });

  it("a legacy null-idempotencyKey payment is attributed via its linked primary order", async () => {
    // Second branch of `resolveRefundOrderId`: no idempotency key, so the
    // FK-linked primary order is used, but only after ownership is verified.
    payments.push(makePayment({ idempotencyKey: null, orderId: "ord-A" }));
    orders.push(makeOrder({ id: "ord-A", idempotencyKey: null }));

    await requestRefund(req(NEW_REQUEST), res());

    expect(db.order.findMany).not.toHaveBeenCalled();
    expect(db.refundRequest.create.mock.calls[0][0].data.orderId).toBe("ord-A");
  });

  it("a legacy null-key payment whose primary order belongs to someone else is not attributed", async () => {
    payments.push(makePayment({ idempotencyKey: null, orderId: "ord-A" }));
    orders.push(makeOrder({ id: "ord-A", customerId: OTHER_CUSTOMER_ID, idempotencyKey: null }));

    await requestRefund(req(NEW_REQUEST), res());

    expect(db.refundRequest.create.mock.calls[0][0].data.orderId).toBeNull();
  });
});

// ===========================================================================
// E. Existing security and validation behavior is preserved
// ===========================================================================

describe("E. existing security and validation behavior is unchanged", () => {
  it("rejects an unknown reference with 404", async () => {
    payments.push(makePayment({ reference: "PSK-OTHER" }));

    await expect(
      requestRefund(req({ ...NEW_REQUEST, reference: "PSK-DOES-NOT-EXIST" }), res()),
    ).rejects.toBeInstanceOf(NotFoundError);

    expect(db.refundRequest.create).not.toHaveBeenCalled();
    expect(db.refundRequest.findFirst).not.toHaveBeenCalled();
  });

  it("rejects another customer's payment with 404 and never reveals refund state", async () => {
    // Ownership is checked BEFORE the guard, so a caller cannot use the guard's
    // response to learn whether a refund exists on a payment that is not theirs.
    seedSuccessfulPayment({ userId: OTHER_CUSTOMER_ID });
    refunds.push(makeRefund({ userId: OTHER_CUSTOMER_ID, status: RefundStatus.PENDING }));

    await expect(
      requestRefund(req(NEW_REQUEST, CUSTOMER_ID), res()),
    ).rejects.toBeInstanceOf(NotFoundError);

    expect(db.refundRequest.findFirst).not.toHaveBeenCalled();
    expect(db.refundRequest.create).not.toHaveBeenCalled();
  });

  it.each([
    PaymentStatus.PENDING,
    PaymentStatus.FAILED,
    PaymentStatus.EXPIRED,
    PaymentStatus.LATE_PAYMENT,
    PaymentStatus.REFUNDED,
  ])("rejects a %s payment with 400", async (status) => {
    payments.push(makePayment({ status }));
    refunds.push(makeRefund({ status: RefundStatus.FAILED })); // would otherwise allow a retry

    await expect(requestRefund(req(NEW_REQUEST), res())).rejects.toBeInstanceOf(ValidationError);
    await expect(requestRefund(req(NEW_REQUEST), res())).rejects.toMatchObject({
      statusCode: 400,
      message: "Only successful payments can be refunded",
    });

    expect(db.refundRequest.findFirst).not.toHaveBeenCalled();
    expect(db.refundRequest.create).not.toHaveBeenCalled();
  });

  it.each([
    ["reference", { reason: "food arrived cold" }],
    ["reason", { reference: REFERENCE }],
    ["both", {}],
  ])("rejects a request missing %s with 400", async (_label, body) => {
    seedSuccessfulPayment();

    await expect(requestRefund(req(body), res())).rejects.toMatchObject({
      statusCode: 400,
      message: "reference and reason are required",
    });

    expect(db.payment.findUnique).not.toHaveBeenCalled();
    expect(db.refundRequest.create).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// E. requestedAmountKobo validation (requestRefund)
// ===========================================================================
//
// Regression for the Phase 3E gap: the customer self-service refund path did
// not supply `requestedAmountKobo`. The controller now accepts an explicit
// amount (strictly positive integer kobo) and rejects anything that would
// corrupt the kobo ledger — zero, negative, fractional, or non-finite — before
// it reaches the database or Paystack. Absent/null means "full remaining
// balance", resolved to a concrete kobo value at admin-approval time.

describe("E. requestedAmountKobo validation", () => {
  const base = () => seedSuccessfulPayment();

  it("leaves requestedAmountKobo absent when not supplied (full balance default)", async () => {
    base();

    const r = res();
    await requestRefund(req({ ...NEW_REQUEST }), r);
    const createCall = db.refundRequest.create.mock.calls[0]?.[0] as any;
    expect("requestedAmountKobo" in (createCall.data ?? {})).toBe(false);
  });

  it("leaves requestedAmountKobo absent when explicitly null (full balance default)", async () => {
    base();

    await requestRefund(req({ ...NEW_REQUEST, requestedAmountKobo: null }), res());
    const createCall = db.refundRequest.create.mock.calls[0]?.[0] as any;
    expect("requestedAmountKobo" in (createCall.data ?? {})).toBe(false);
  });

  it("persists a valid positive integer requestedAmountKobo", async () => {
    base();
    await requestRefund(
      req({ ...NEW_REQUEST, requestedAmountKobo: 50000 }),
      res(),
    );
    expect(db.refundRequest.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ requestedAmountKobo: 50000 }),
      }),
    );
  });

  it.each([
    ["zero", 0],
    ["negative", -1000],
    ["fractional", 500.5],
    ["non-finite NaN", NaN],
    ["string", "50000" as any],
    ["object", {} as any],
  ])("rejects requestedAmountKobo of %s with 400", async (_label, amount) => {
    base();

    await expect(
      requestRefund(req({ ...NEW_REQUEST, requestedAmountKobo: amount }), res()),
    ).rejects.toMatchObject({ statusCode: 400 });

    expect(db.refundRequest.create).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// Harness integrity
// ===========================================================================
//
// The regression protection above is carried by the `refundRequest.findFirst`
// fake actually FILTERING on the controller's status list. A double that just
// returned the first fixture row would keep every assertion green even after the
// guard regressed, so the fake's discriminating power is asserted explicitly.

describe("harness integrity — the guard fake filters, it does not always match", () => {
  it("returns the row only when the controller's status list contains its status", async () => {
    refunds.push(makeRefund({ status: RefundStatus.COMPLETED }));

    // Exactly what the controller sends today -> blocking.
    await expect(
      db.refundRequest.findFirst({
        where: { paymentRef: REFERENCE, status: { in: [RefundStatus.COMPLETED] } },
      }),
    ).resolves.toMatchObject({ status: RefundStatus.COMPLETED });

    // Same row, COMPLETED absent from the list -> no match, so a regression that
    // dropped COMPLETED from the guard would let a second request through.
    await expect(
      db.refundRequest.findFirst({
        where: { paymentRef: REFERENCE, status: { in: [RefundStatus.PENDING] } },
      }),
    ).resolves.toBeNull();
  });

  it("does not match a row belonging to a different payment reference", async () => {
    refunds.push(makeRefund({ paymentRef: "PSK-UNRELATED" }));

    await expect(
      db.refundRequest.findFirst({
        where: { paymentRef: REFERENCE, status: { in: [RefundStatus.PENDING] } },
      }),
    ).resolves.toBeNull();
  });

  it("refuses an order-scoped predicate, so the payment-wide invariant cannot be narrowed", async () => {
    await expect(
      db.refundRequest.findFirst({
        where: {
          paymentRef: REFERENCE,
          orderId: "ord-A",
          status: { in: [RefundStatus.PENDING] },
        },
      }),
    ).rejects.toThrow(/payment-wide/);
  });
});
