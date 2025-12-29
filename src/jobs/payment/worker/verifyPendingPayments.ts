import prisma from "../../../lib/prisma";
import { handleSuccessfulPayment, verifyPayment } from "../../../services/paymentService";
import { Payment, Order, OrderItem } from "@prisma/client";
import { OrderStatus } from "@prisma/client";

/**
 * 🧾 Verify pending payments in batches (CPU/memory efficient)
 */
export async function verifyPendingPayments(batchSize = 50) {
  console.log("[VERIFY] 🔍 Checking for pending payments...");

  try {
    let lastId: string | null = null;

    while (true) {
      const pendingPayments: (Payment & { order: Order | null })[] = await prisma.payment.findMany({
        where: { status: { in: ["pending", "initiated"] } },
        include: { order: true },
        orderBy: { id: "asc" },
        take: batchSize,
        cursor: lastId ? { id: lastId } : undefined,
        skip: lastId ? 1 : 0,
      });

      if (pendingPayments.length === 0) break;

      const now = new Date();

      for (const payment of pendingPayments) {
        try {
          if (payment.expiresAt && now > payment.expiresAt) {
            console.log(`[VERIFY] ⏰ Payment ${payment.reference} expired locally.`);

            await prisma.$transaction([
              prisma.payment.update({
                where: { id: payment.id },
                data: { status: "expired" },
              }),
              prisma.order.updateMany({
                where: { id: payment.orderId, status: "AWAITING_PAYMENT" },
                data: {
                  status: "CANCELLED",
                  cancellationReason: "PAYMENT_EXPIRED",
                  cancelledAt: now,
                },
              }),
            ]);
            continue;
          }

          const data = await verifyPayment(payment.reference);
          if (data.status === "success" && payment.order) {
            console.log(`[VERIFY] ✅ Payment ${payment.reference} confirmed by Paystack.`);
            await handleSuccessfulPayment(payment.order, payment.reference);
          }
        } catch (err: any) {
          console.error(`[VERIFY] ❌ Error verifying ${payment.reference}: ${err.message}`);
        }
      }

      lastId = pendingPayments[pendingPayments.length - 1].id;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    console.log("[VERIFY] ✅ Pending payment verification completed.");
  } catch (err: any) {
    console.error(`[VERIFY] ❌ Failed to fetch pending payments: ${err.message}`);
  }
}