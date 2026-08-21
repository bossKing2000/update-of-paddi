import prisma from "../../../lib/prisma";
import { verifyPayment } from "../../../services/paymentService";
import { finalizePaymentSuccess } from "../../../services/paymentFinalizer.service";
import { logger } from "../../../lib/logger";
import { PaymentStatus, OrderStatus } from "@prisma/client";

/**
 * Catch-up job for payments that succeeded at Paystack but somehow never
 * got confirmed here — the webhook didn't arrive (network blip on
 * Paystack's end, our server was mid-deploy, etc.) and the customer never
 * hit the post-redirect confirm endpoint either (closed the tab). Runs
 * periodically to reconcile against Paystack directly.
 *
 * Delegates the actual confirmation to the same finalizePaymentSuccess
 * used by the webhook and confirmPayment — this job's only job is to
 * find candidates and ask Paystack "did this actually succeed?"
 */
export async function verifyPendingPayments(batchSize = 50) {
  logger.info("Checking for pending payments to verify");

  let lastId: string | null = null;
  let checked = 0;
  let confirmed = 0;
  let expired = 0;

  try {
    while (true) {
      const pendingPayments: Awaited<
        ReturnType<typeof prisma.payment.findMany>
      > = await prisma.payment.findMany({
        where: {
          status: { in: [PaymentStatus.PENDING, PaymentStatus.INITIATED] },
        },
        orderBy: { id: "asc" },
        take: batchSize,
        cursor: lastId ? { id: lastId } : undefined,
        skip: lastId ? 1 : 0,
      });

      if (pendingPayments.length === 0) break;

      const now = new Date();

      for (const payment of pendingPayments) {
        checked++;
        try {
          // Locally expired and never even queried Paystack — no point
          // asking, just expire it. finalizePaymentSuccess's own lock
          // handles races with a webhook that might still be in flight.
          if (payment.expiresAt && now > payment.expiresAt) {
            await prisma.$transaction([
              prisma.payment.update({
                where: { id: payment.id },
                data: { status: PaymentStatus.EXPIRED },
              }),
              prisma.order.updateMany({
                where: {
                  id: payment.orderId,
                  status: {
                    in: [OrderStatus.AWAITING_PAYMENT, OrderStatus.PENDING],
                  },
                },
                data: {
                  status: OrderStatus.CANCELLED_UNPAID,
                  cancellationReason: "PAYMENT_EXPIRED",
                  cancelledAt: now,
                  paymentStatus: PaymentStatus.EXPIRED,
                },
              }),
            ]);
            expired++;
            continue;
          }

          const data = await verifyPayment(payment.reference);
          if (data.status === "success") {
            const result = await finalizePaymentSuccess({
              reference: payment.reference,
              amountInNaira: data.amount / 100,
              customerIdFromGateway: data.metadata?.userId,
              channel: data.channel,
              paystackData: data,
              authorization: data.authorization,
            });
            if (result.outcome === "SUCCESS") confirmed++;
            logger.info(
              { reference: payment.reference, outcome: result.outcome },
              "verifyPendingPayments: reconciled with Paystack",
            );
          }
        } catch (err) {
          logger.error(
            { err, reference: payment.reference },
            "verifyPendingPayments: error checking payment",
          );
        }
      }

      lastId = pendingPayments[pendingPayments.length - 1].id;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    logger.info(
      { checked, confirmed, expired },
      "verifyPendingPayments completed",
    );
  } catch (err) {
    logger.error(
      { err },
      "verifyPendingPayments failed to fetch pending payments",
    );
  }
}
