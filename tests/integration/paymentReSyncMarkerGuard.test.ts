/**
 * Phase 3.2.12 — real-PostgreSQL verification of the payment re-sync guard
 * (Phase 3.2.10 / F2-01) and the conditional payment claim.
 *
 * These assertions deliberately live here rather than in a unit suite: the
 * property under test is the SQL predicate itself. A mocked `updateMany`
 * returning `{count: 0}` proves the branch was taken; only the database
 * proves the row was actually protected.
 *
 * No Paystack is contacted: gateway values are passed as finalizer input,
 * exactly as the webhook/verify paths do after dividing kobo by 100.
 * Self-cleaning: every row carries a unique tag and is removed in afterAll.
 */
import { PrismaClient } from "@prisma/client";
import fs from "fs";
import { finalizePaymentSuccess } from "../../src/services/paymentFinalizer.service";
import { getReceiptFilePath } from "../../src/utils/receiptsPath";

jest.setTimeout(60000);

const prisma = new PrismaClient();
const tag = `resync-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

const userIds: string[] = [];
const orderIds: string[] = [];
const paymentIds: string[] = [];
const refundIds: string[] = [];
const receiptIds: string[] = [];

const TOTAL = 5500;

async function makePayment(options: {
  orderPaymentStatus?: string;
  orderStatus?: string;
  paymentStatus?: string;
  suffix: string;
}) {
  const vendor = await prisma.user.create({
    data: {
      email: `${tag}-${options.suffix}-v@x.test`,
      name: "Re-sync Vendor",
      role: "VENDOR",
      roles: ["VENDOR"],
      commissionRate: 0.15,
    },
  });
  const customer = await prisma.user.create({
    data: {
      email: `${tag}-${options.suffix}-c@x.test`,
      name: "Re-sync Customer",
      role: "CUSTOMER",
      roles: ["CUSTOMER"],
    },
  });
  userIds.push(vendor.id, customer.id);

  const key = `${tag}-key-${options.suffix}`;
  const order = await prisma.order.create({
    data: {
      customerId: customer.id,
      vendorId: vendor.id,
      basePrice: TOTAL - 500,
      deliveryFee: 500,
      totalPrice: TOTAL,
      status: (options.orderStatus ?? "AWAITING_PAYMENT") as any,
      paymentStatus: (options.orderPaymentStatus ?? "PENDING") as any,
      idempotencyKey: key,
    },
  });
  orderIds.push(order.id);

  const payment = await prisma.payment.create({
    data: {
      reference: `${tag}-${options.suffix}`,
      idempotencyKey: key,
      orderId: order.id,
      userId: customer.id,
      amount: TOTAL * 100,
      status: (options.paymentStatus ?? "SUCCESS") as any,
      expiresAt: new Date(Date.now() + 10 * 60_000),
      channel: "card",
    },
  });
  paymentIds.push(payment.id);
  return { order, payment };
}

const finalize = (payment: { reference: string }) =>
  finalizePaymentSuccess({
    reference: payment.reference,
    amountKobo: TOTAL,
    currency: "NGN",
  });

/**
 * Cleanup, in the order the foreign keys require.
 *
 * WHY THIS ORDER — every ON DELETE RESTRICT below is read from
 * prisma/migrations/20261016025918_init/migration.sql, not assumed:
 *
 *   Receipt       -> Payment      (Receipt_paymentId_fkey,       RESTRICT)
 *   RefundRequest -> Order        (RefundRequest_orderId_fkey,   RESTRICT)
 *   RefundRequest -> User         (RefundRequest_userId_fkey,    RESTRICT)
 *   Payment       -> Order        (Payment_orderId_fkey,         RESTRICT)
 *   Payment       -> User         (Payment_userId_fkey,          RESTRICT)
 *   Order         -> User         (Order_customerId_fkey,        RESTRICT)
 *   Order         -> User         (Order_vendorId_fkey,          RESTRICT)
 *
 * `Receipt` is the row that was previously missing. `finalizePaymentSuccess`
 * calls `generateReceipt` (src/utils/generate Receipt/generateReceipt.ts:213),
 * which inserts a Receipt for the finalized Payment. Because `Receipt` RESTRICTs
 * `Payment`, the Payment delete failed; that RESTRICTed the Order delete, which
 * RESTRICTed the User delete — so every fixture row this suite created was left
 * behind, polluting later suites that happened to read "the first User/Order".
 *
 * `Activity`, `OrderItem`, `DeliveryAssignment` and `_ProductOrders` reference
 * Order/User with ON DELETE CASCADE, so they disappear with their parent and
 * must NOT be deleted explicitly.
 *
 * FAILURES ARE NOT SWALLOWED. The previous implementation appended
 * `.catch(() => {})` to every delete, so a RESTRICT rejection was invisible and
 * the suite reported success while leaking rows. Each step is attempted even if
 * an earlier one failed, failures are collected, the leftover rows are counted,
 * and the whole thing throws at the end.
 */
afterAll(async () => {
  const failures: string[] = [];

  /** Runs one deletion, recording (not hiding) a failure. */
  const step = async (label: string, run: () => Promise<unknown>): Promise<void> => {
    try {
      await run();
    } catch (err) {
      failures.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  try {
    // 0. Capture this suite's own payment references BEFORE the Payment rows
    //    are deleted. `generateReceipt` writes a PDF named
    //    `receipt_<payment.reference>.pdf` into ./receipts
    //    (src/utils/generate Receipt/generateReceipt.ts:30-34), so the
    //    references are the only link back to the files this suite created.
    //    The reference is `${tag}-${suffix}`, so every file this suite owns is
    //    named after a reference it owns — no prefix guessing is needed.
    const ownedPayments = await prisma.payment.findMany({
      where: { id: { in: paymentIds } },
      select: { id: true, reference: true },
    });
    const ownedReferences = ownedPayments.map((p) => p.reference);

    // 1. Receipts, created by the finalizer for this suite's payments.
    const ownedReceipts = await prisma.receipt.findMany({
      where: { OR: [{ paymentId: { in: paymentIds } }, { id: { in: receiptIds } }] },
      select: { id: true },
    });
    receiptIds.push(...ownedReceipts.map((r) => r.id));
    await step("receipt.deleteMany", () =>
      prisma.receipt.deleteMany({ where: { id: { in: receiptIds } } }),
    );

    // 2. Refund obligations, filed by the finalizer for this suite's orders.
    const ownedRefunds = await prisma.refundRequest.findMany({
      where: {
        OR: [
          { orderId: { in: orderIds } },
          { userId: { in: userIds } },
          { id: { in: refundIds } },
        ],
      },
      select: { id: true },
    });
    refundIds.push(...ownedRefunds.map((r) => r.id));
    await step("refundRequest.deleteMany", () =>
      prisma.refundRequest.deleteMany({ where: { id: { in: refundIds } } }),
    );

    // 3. Payments, 4. Orders, 5. Users.
    await step("payment.deleteMany", () =>
      prisma.payment.deleteMany({ where: { id: { in: paymentIds } } }),
    );
    await step("order.deleteMany", () =>
      prisma.order.deleteMany({ where: { id: { in: orderIds } } }),
    );
    await step("user.deleteMany", () =>
      prisma.user.deleteMany({ where: { id: { in: userIds } } }),
    );

    // 5b. The receipt PDFs this suite caused to be written to disk.
    //
    // Deleting the Receipt ROW is not enough: `generateReceipt` also writes
    // `receipt_<reference>.pdf` into ./receipts, and `receipts/` is not
    // git-ignored, so each run otherwise left files behind in the working
    // tree. Only files named after a reference this suite owns are removed —
    // no prefix matching, so another suite's receipts are never touched.
    // Resolved through the same helper `generateReceipt` writes with, so the
    // cleanup always targets the directory the PDF was actually written to
    // (which a test may have redirected via RECEIPTS_DIR).
    await step("receipt-pdf.unlink", async () => {
      for (const reference of ownedReferences) {
        const file = getReceiptFilePath(reference);
        if (fs.existsSync(file)) fs.unlinkSync(file);
      }
    });

    // 6. Verify that nothing this suite owned is still present. A delete that
    // silently matched zero rows is indistinguishable from success without
    // this check.
    const [users, orders, payments, refundsLeft, receiptsLeft] = await Promise.all([
      prisma.user.count({ where: { id: { in: userIds } } }),
      prisma.order.count({ where: { id: { in: orderIds } } }),
      prisma.payment.count({ where: { id: { in: paymentIds } } }),
      prisma.refundRequest.count({ where: { id: { in: refundIds } } }),
      prisma.receipt.count({ where: { id: { in: receiptIds } } }),
    ]);
    const remaining = {
      users,
      orders,
      payments,
      refunds: refundsLeft,
      receipts: receiptsLeft,
    };
    const leftover = Object.entries(remaining).filter(([, n]) => n > 0);
    if (leftover.length) {
      failures.push(`owned rows still present after cleanup: ${JSON.stringify(remaining)}`);
    }

    // The same check for the receipt PDFs this suite wrote to disk.
    const leftoverPdfs = ownedReferences.filter((reference) =>
      fs.existsSync(getReceiptFilePath(reference)),
    );
    if (leftoverPdfs.length) {
      failures.push(
        `owned receipt PDFs still present after cleanup: ${JSON.stringify(leftoverPdfs)}`,
      );
    }

    if (failures.length) {
      throw new Error(
        `paymentReSyncMarkerGuard cleanup failed:\n  - ${failures.join("\n  - ")}`,
      );
    }
  } finally {
    await prisma.$disconnect();
  }
});

describe("A. settled payment markers are protected from re-sync", () => {
  // `paymentStatus: SUCCESS` with an order carrying a settled marker is the
  // exact inconsistent pair the duplicate charge.success webhook produces.
  const settled: Array<[string, string]> = [
    ["REFUNDED", "CANCELLED"],
    ["EXPIRED", "CANCELLED_UNPAID"],
    ["LATE_PAYMENT", "CANCELLED_UNPAID"],
    ["AMOUNT_MISMATCH", "CANCELLED_UNPAID"],
    ["FAILED", "CANCELLED_UNPAID"],
  ];

  it.each(settled)("a %s order marker is not rewritten to SUCCESS", async (marker, orderStatus) => {
    const { order, payment } = await makePayment({
      suffix: `guard-${marker}`,
      orderPaymentStatus: marker,
      orderStatus,
    });

    const result = await finalize(payment);
    expect(result.outcome).toBe("ALREADY_PROCESSED");

    const persisted = await prisma.order.findUnique({ where: { id: order.id } });
    // The database, not a mock, is the assertion here.
    expect(persisted?.paymentStatus).toBe(marker);
    expect(persisted?.status).toBe(orderStatus);
  });

  it("a PENDING marker is still repaired to SUCCESS", async () => {
    const { order, payment } = await makePayment({
      suffix: "repair-pending",
      orderPaymentStatus: "PENDING",
      orderStatus: "COOKING",
    });

    await finalize(payment);

    const persisted = await prisma.order.findUnique({ where: { id: order.id } });
    expect(persisted?.paymentStatus).toBe("SUCCESS");
  });

  it("an INITIATED marker is still repaired to SUCCESS", async () => {
    const { order, payment } = await makePayment({
      suffix: "repair-initiated",
      orderPaymentStatus: "INITIATED",
      orderStatus: "PAYMENT_CONFIRMED",
    });

    await finalize(payment);

    const persisted = await prisma.order.findUnique({ where: { id: order.id } });
    expect(persisted?.paymentStatus).toBe("SUCCESS");
  });

  it("a still-payable order is confirmed without touching a settled marker", async () => {
    // Two orders share one payment: one REFUNDED, one awaiting payment.
    const first = await makePayment({
      suffix: "mixed-refunded",
      orderPaymentStatus: "REFUNDED",
      orderStatus: "CANCELLED",
    });
    const second = await makePayment({
      suffix: "mixed-live",
      orderPaymentStatus: "PENDING",
      orderStatus: "AWAITING_PAYMENT",
    });

    // Point the second order at the first payment so one batch spans both.
    await prisma.payment.update({
      where: { id: second.payment.id },
      data: {
        orderId: first.payment.orderId,
        idempotencyKey: first.order.idempotencyKey,
      },
    });
    await prisma.order.update({
      where: { id: second.order.id },
      data: { idempotencyKey: first.order.idempotencyKey, totalPrice: TOTAL },
    });
    await prisma.payment.update({
      where: { id: first.payment.id },
      data: { amount: TOTAL * 2 * 100 },
    });
    orderIds.push(second.order.id);

    const result = await finalizePaymentSuccess({
      reference: first.payment.reference,
      amountKobo: TOTAL * 2,
      currency: "NGN",
    });
    expect(result.outcome).toBe("ALREADY_PROCESSED");

    const refunded = await prisma.order.findUnique({ where: { id: first.order.id } });
    const live = await prisma.order.findUnique({ where: { id: second.order.id } });
    expect(refunded?.paymentStatus).toBe("REFUNDED");
    expect(refunded?.status).toBe("CANCELLED");
    expect(live?.paymentStatus).toBe("SUCCESS");
    expect(live?.status).toBe("PAYMENT_CONFIRMED");
  });
});

describe("B. concurrent finalization against real transactions", () => {
  it("two concurrent claims on the same payment produce one capture", async () => {
    const { order, payment } = await makePayment({
      suffix: "concurrent-claim",
      orderPaymentStatus: "PENDING",
      orderStatus: "AWAITING_PAYMENT",
      paymentStatus: "PENDING",
    });

    const outcomes = await Promise.all([finalize(payment), finalize(payment)]);
    const successes = outcomes.filter((o) => o.outcome === "SUCCESS");

    // Exactly one execution may own the transition.
    expect(successes).toHaveLength(1);
    const persistedPayment = await prisma.payment.findUnique({ where: { id: payment.id } });
    const persistedOrder = await prisma.order.findUnique({ where: { id: order.id } });
    expect(persistedPayment?.status).toBe("SUCCESS");
    expect(persistedOrder?.status).toBe("PAYMENT_CONFIRMED");
    expect(persistedOrder?.paymentStatus).toBe("SUCCESS");
  });

  it("concurrent duplicate deliveries cannot flip a refunded marker", async () => {
    const { order, payment } = await makePayment({
      suffix: "concurrent-refunded",
      orderPaymentStatus: "REFUNDED",
      orderStatus: "CANCELLED",
    });

    await Promise.all([finalize(payment), finalize(payment), finalize(payment)]);

    const persisted = await prisma.order.findUnique({ where: { id: order.id } });
    expect(persisted?.paymentStatus).toBe("REFUNDED");
    expect(persisted?.status).toBe("CANCELLED");
  });

  it("a cancelled order is not resurrected by concurrent re-sync", async () => {
    const { order, payment } = await makePayment({
      suffix: "concurrent-cancelled",
      orderPaymentStatus: "PENDING",
      orderStatus: "AWAITING_PAYMENT",
    });
    // Cancellation wins first, exactly as the status CAS must tolerate.
    await prisma.order.update({
      where: { id: order.id },
      data: { status: "CANCELLED", cancellationReason: "customer_cancelled" },
    });

    await Promise.all([finalize(payment), finalize(payment)]);

    const persisted = await prisma.order.findUnique({ where: { id: order.id } });
    expect(persisted?.status).toBe("CANCELLED");
    expect(persisted?.paymentStatus).toBe("SUCCESS"); // payment truth recorded
  });

  it("retrying after a settled marker never duplicates the refund obligation", async () => {
    const { order, payment } = await makePayment({
      suffix: "concurrent-refund-owed",
      orderPaymentStatus: "PENDING",
      orderStatus: "CANCELLED",
      paymentStatus: "PENDING",
    });
    // paymentStatus PENDING + CANCELLED is the F-A3 recovery pair.
    await prisma.order.update({
      where: { id: order.id },
      data: { status: "CANCELLED", cancellationReason: "customer_cancelled" },
    });

    await finalize(payment);
    await finalize(payment); // duplicate delivery
    await finalize(payment); // retry after the idempotent early return

    const refunds = await prisma.refundRequest.findMany({ where: { orderId: order.id } });
    refundIds.push(...refunds.map((r) => r.id));
    expect(refunds).toHaveLength(1);
    expect(refunds[0].status).toBe("PENDING");
    expect(refunds[0].requestedAmountKobo).toBe(TOTAL);
    expect(refunds[0].orderId).toBe(order.id);
  });
});