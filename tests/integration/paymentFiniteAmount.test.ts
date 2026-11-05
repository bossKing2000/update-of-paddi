/**
 * Stage F (E-01) — finalizer MUST reject non-finite amounts before any
 * success state, receipt, or fulfillment. Uses the real
 * finalizePaymentSuccess against disposable rows (no Paystack involved:
 * gateway values are passed as finalizer input, exactly as the webhook
 * and verify paths do after dividing kobo by 100).
 */
import { PrismaClient } from "@prisma/client";
import fs from "fs";
import { finalizePaymentSuccess } from "../../src/services/paymentFinalizer.service";
import { getReceiptFilePath } from "../../src/utils/receiptsPath";

import { ensureTestDishType, type TestDishTypeHandle } from "../helpers/testDishType";
jest.setTimeout(60000);

const prisma = new PrismaClient();

// FIN-07-05: Product.dishTypeId is a required FK and these tests hard-code
// "JOLLOF", which only exists after a seed. Provide it idempotently here so
// the fixture is self-contained; a pre-existing seeded row is never removed.
let testDishType: TestDishTypeHandle | null = null;
beforeAll(async () => {
  testDishType = await ensureTestDishType(prisma);
});

const tag = `finite-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const created = {
  users: [] as string[],
  products: [] as string[],
  orders: [] as string[],
  items: [] as string[],
  payments: [] as string[],
};

async function makeContext(suffix: string, totalPrice = 5500) {
  const vendor = await prisma.user.create({
    data: {
      email: `${tag}-${suffix}-v@x.test`,
      name: "Finite Vendor",
      role: "VENDOR",
      roles: ["VENDOR"],
    },
  });
  const customer = await prisma.user.create({
    data: {
      email: `${tag}-${suffix}-c@x.test`,
      name: "Finite Customer",
      role: "CUSTOMER",
      roles: ["CUSTOMER"],
    },
  });
  const product = await prisma.product.create({
    data: {
      name: `${tag} Finite Product`,
      description: "finite-amount fixture",
      price: totalPrice - 500,
      dishTypeId: "JOLLOF",
      categoryId: "RICE_DISHES",
      vendorId: vendor.id,
      images: [],
      video: [],
    },
  });
  const order = await prisma.order.create({
    data: {
      customerId: customer.id,
      vendorId: vendor.id,
      basePrice: totalPrice - 500,
      deliveryFee: 500,
      totalPrice,
      status: "AWAITING_PAYMENT",
      idempotencyKey: `${tag}-key-${suffix}`,
      items: {
        create: [
          {
            productId: product.id,
            quantity: 1,
            unitPrice: totalPrice - 500,
            subtotal: totalPrice - 500,
          },
        ],
      },
    },
    include: { items: true },
  });
  const payment = await prisma.payment.create({
    data: {
      userId: customer.id,
      orderId: order.id,
      amount: Math.round(totalPrice * 100),
      reference: `${tag}-ref-${suffix}`.toUpperCase().slice(0, 40),
      status: "PENDING",
      idempotencyKey: `${tag}-key-${suffix}`,
      expiresAt: new Date(Date.now() + 15 * 60_000),
    },
  });
  created.users.push(vendor.id, customer.id);
  created.products.push(product.id);
  created.orders.push(order.id);
  created.payments.push(payment.id);
  return { order, payment, customer };
}

/**
 * Removes the receipt PDFs this suite generated, and reports any that survive.
 *
 * `finalizePaymentSuccess` calls `generateReceipt`, which streams a PDF named
 * `receipt_<payment.reference>.pdf` into the receipts directory. `cleanup()`
 * deleted the `Receipt` ROW but never the FILE, so every run left PDFs behind
 * in the repository (the `receipt_FINITE-*.pdf` files).
 *
 * OWNERSHIP IS ESTABLISHED FROM THE DATABASE, not from a filename prefix: the
 * references are read from the Payment rows this suite created, immediately
 * before those rows are deleted. The file name is then derived with the same
 * helper `generateReceipt` uses, so the two cannot drift. Files belonging to
 * any other suite are never matched.
 */
async function removeOwnedReceiptPdfs(): Promise<string[]> {
  const failures: string[] = [];
  if (!created.payments.length) return failures;

  const owned = await prisma.payment.findMany({
    where: { id: { in: created.payments } },
    select: { reference: true },
  });
  const references = owned.map((p) => p.reference);

  // Each file is attempted independently, so one failure cannot prevent the
  // remaining owned files from being removed.
  for (const reference of references) {
    const file = getReceiptFilePath(reference);
    try {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    } catch (err) {
      failures.push(
        `receipt-pdf.unlink ${file}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const leftover = references.filter((reference) => fs.existsSync(getReceiptFilePath(reference)));
  if (leftover.length) {
    failures.push(`owned receipt PDFs still present after cleanup: ${JSON.stringify(leftover)}`);
  }
  return failures;
}

async function cleanup() {
  // Capture the receipt references BEFORE the Payment rows are deleted.
  const pdfFailures = await removeOwnedReceiptPdfs();
  if (created.payments.length) {
    await prisma.receipt
      .deleteMany({ where: { paymentId: { in: created.payments } } })
      .catch(() => {});
  }
  if (created.users.length) {
    await prisma.notification
      .deleteMany({ where: { userId: { in: created.users } } })
      .catch(() => {});
    await prisma.auditLog
      .deleteMany({ where: { userId: { in: created.users } } })
      .catch(() => {});
  }
  if (created.orders.length) {
    await prisma.activity
      .deleteMany({ where: { orderId: { in: created.orders } } })
      .catch(() => {});
  }
  if (created.payments.length)
    await prisma.payment
      .deleteMany({ where: { id: { in: created.payments } } })
      .catch(() => {});
  if (created.items.length)
    await prisma.orderItem
      .deleteMany({ where: { id: { in: created.items } } })
      .catch(() => {});
  if (created.orders.length)
    await prisma.order
      .deleteMany({ where: { id: { in: created.orders } } })
      .catch(() => {});
  if (created.products.length)
    await prisma.product
      .deleteMany({ where: { id: { in: created.products } } })
      .catch(() => {});
  if (created.users.length)
    await prisma.user
      .deleteMany({ where: { id: { in: created.users } } })
      .catch(() => {});
  created.users.length = 0;
  created.products.length = 0;
  created.orders.length = 0;
  created.items.length = 0;
  created.payments.length = 0;

  // A cleanup failure must be visible: an owned PDF that is still on disk, or
  // an unlink that threw, fails the run instead of being reported as a
  // successful cleanup.
  if (pdfFailures.length) {
    throw new Error(
      `paymentFiniteAmount cleanup failed:\n  - ${pdfFailures.join("\n  - ")}`,
    );
  }
}

afterEach(async () => {
  await cleanup();
});
afterAll(async () => {
  await prisma.$disconnect();
  await testDishType?.dispose();
});

async function readPayment(id: string) {
  return prisma.payment.findUniqueOrThrow({ where: { id } });
}

describe("E-01 finite-amount guard", () => {
  it("Test A: NaN gateway amount rejects as AMOUNT_MISMATCH, never SUCCESS", async () => {
    const { payment } = await makeContext("a");
    const result = await finalizePaymentSuccess({
      reference: (await readPayment(payment.id)).reference,
      amountKobo: NaN,
    });
    expect(result.outcome).toBe("AMOUNT_MISMATCH");
    const reread = await readPayment(payment.id);
    expect(reread.status).toBe("AMOUNT_MISMATCH");
    expect(
      await prisma.receipt.count({ where: { paymentId: payment.id } }),
    ).toBe(0);
  });

  it("Test B: Infinity gateway amount rejects", async () => {
    const { payment } = await makeContext("b");
    const result = await finalizePaymentSuccess({
      reference: (await readPayment(payment.id)).reference,
      amountKobo: Infinity,
    });
    expect(result.outcome).toBe("AMOUNT_MISMATCH");
    expect((await readPayment(payment.id)).status).toBe("AMOUNT_MISMATCH");
  });

  it("Test C: -Infinity gateway amount rejects", async () => {
    const { payment } = await makeContext("c");
    const result = await finalizePaymentSuccess({
      reference: (await readPayment(payment.id)).reference,
      amountKobo: -Infinity,
    });
    expect(result.outcome).toBe("AMOUNT_MISMATCH");
    expect((await readPayment(payment.id)).status).toBe("AMOUNT_MISMATCH");
  });

  it("Test D: NaN gateway amount rejects as AMOUNT_MISMATCH with valid order total", async () => {
    const { payment } = await makeContext("d");
    // The persisted order total is a valid integer kobo (Int column cannot
    // store NaN — see prisma/schema.prisma Order.totalPrice). A corrupt
    // persisted total is no longer representable, so the equivalent invariant
    // is: a non-finite gateway amount is rejected even against a valid order
    // total — no SUCCESS, receipt, or fulfillment.
    const order = await prisma.order.findFirstOrThrow({
      where: { id: { in: created.orders } },
    });
    expect(Number.isFinite(order.totalPrice)).toBe(true);
    const result = await finalizePaymentSuccess({
      reference: (await readPayment(payment.id)).reference,
      amountKobo: NaN,
    });
    expect(result.outcome).toBe("AMOUNT_MISMATCH");
    expect((await readPayment(payment.id)).status).not.toBe("SUCCESS");
    expect(
      await prisma.receipt.count({ where: { paymentId: payment.id } }),
    ).toBe(0);
  });

  it("Test E: valid matching amount still succeeds with receipt", async () => {
    const { payment, order } = await makeContext("e");
    const result = await finalizePaymentSuccess({
      reference: (await readPayment(payment.id)).reference,
      amountKobo: 5500,
      // Phase 3.2.13: the finalizer fails closed when the provider currency is
      // absent (Batch F). Every production finalize path supplies NGN — the
      // only currency this marketplace creates — so the fixture states it
      // explicitly instead of relying on an implicit default.
      currency: "NGN",
    });
    expect(result.outcome).toBe("SUCCESS");
    expect((await readPayment(payment.id)).status).toBe("SUCCESS");
    expect(
      await prisma.receipt.count({ where: { paymentId: payment.id } }),
    ).toBe(1);
    const rereadOrder = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
    });
    expect(rereadOrder.paymentStatus).toBe("SUCCESS");
  });

  it("Test F: one-kobo amount mismatch rejects as AMOUNT_MISMATCH", async () => {
    const { payment, order } = await makeContext("f");
    const result = await finalizePaymentSuccess({
      reference: (await readPayment(payment.id)).reference,
      amountKobo: 5501,
      currency: "NGN",
    });
    expect(result.outcome).toBe("AMOUNT_MISMATCH");
    expect((await readPayment(payment.id)).status).toBe("AMOUNT_MISMATCH");
    // No receipt is produced for a mismatched amount.
    expect(
      await prisma.receipt.count({ where: { paymentId: payment.id } }),
    ).toBe(0);
    // The order is not marked paid.
    const rereadOrder = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
    });
    expect(rereadOrder.paymentStatus).not.toBe("SUCCESS");
  });

  it("Test G: mismatch outside tolerance still rejects (diff 2)", async () => {
    const { payment } = await makeContext("g");
    const result = await finalizePaymentSuccess({
      reference: (await readPayment(payment.id)).reference,
      amountKobo: 5502,
    });
    expect(result.outcome).toBe("AMOUNT_MISMATCH");
    expect((await readPayment(payment.id)).status).toBe("AMOUNT_MISMATCH");
  });
});
