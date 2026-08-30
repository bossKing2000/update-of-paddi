import { OrderStatus, PaymentStatus } from "@prisma/client";
import prisma from "../../config/prismaClient";
import { logger } from "../../lib/logger";
import { nowUtc, isAfterUtc } from "../../utils/time";

/**
 * 🧹 Expire abandoned AWAITING_PAYMENT orders whose payment window has passed.
 * Runs every 5 minutes via node-cron.
 *
 * Criteria:
 *  - status = AWAITING_PAYMENT
 *  - protectedUntil < now (order-level window, 15m from checkout)
 *  - no SUCCESS payment exists
 *  - no payment is currently being finalized (isProcessing=true)
 *  - if a payment exists, its expiresAt < now OR no payment at all (never started)
 *
 * Uses existing statuses: CANCELLED_UNPAID / EXPIRED / FAILED — no new enum.
 * Idempotent, batched, safe to run repeatedly and concurrently with finalize.
 */
export const runExpireAwaitingPaymentJob = async (batchSize = 500) => {
  const now = nowUtc();
  let expiredCount = 0;

  try {
    logger.info({ now: now.toISOString() }, "Running expire awaiting payment job");

    let lastId: string | null = null;
    while (true) {
      const batch: any[] = await prisma.order.findMany({
        where: {
          status: OrderStatus.AWAITING_PAYMENT,
          protectedUntil: { lt: now },
        },
        include: {
          payments: { select: { id: true, status: true, isProcessing: true, expiresAt: true } },
        },
        orderBy: { id: "asc" },
        take: batchSize,
        cursor: lastId ? { id: lastId } : undefined,
        skip: lastId ? 1 : 0,
      });

      if (batch.length === 0) break;

      for (const order of batch) {
        const hasSuccess = order.payments.some((p: any) => p.status === PaymentStatus.SUCCESS);
        if (hasSuccess) continue;

        const isProcessing = order.payments.some((p: any) => p.isProcessing);
        if (isProcessing) {
          logger.info({ orderId: order.id }, "Skipping expiry — payment isProcessing=true");
          continue;
        }

        // If there's a payment, ensure it's expired or none. If no payment, protectedUntil already expired is enough.
        const latestPayment = order.payments.length > 0
          ? order.payments.reduce((a: any, b: any) => (a.expiresAt && b.expiresAt ? (a.expiresAt > b.expiresAt ? a : b) : a))
          : null;

        let shouldExpire = false;
        if (!latestPayment) {
          shouldExpire = true;
        } else if (latestPayment.expiresAt) {
          shouldExpire = isAfterUtc(now, latestPayment.expiresAt);
        } else {
          // No expiresAt but protectedUntil already passed — expire
          shouldExpire = true;
        }

        if (!shouldExpire) continue;

        // Atomic guard: only update if still AWAITING_PAYMENT and no SUCCESS payment was inserted concurrently
        const updated = await prisma.order.updateMany({
          where: {
            id: order.id,
            status: OrderStatus.AWAITING_PAYMENT,
            payments: { none: { status: PaymentStatus.SUCCESS } },
          },
          data: {
            status: OrderStatus.CANCELLED_UNPAID,
            cancellationReason: "PAYMENT_EXPIRED",
            cancelledAt: now,
            paymentStatus: PaymentStatus.EXPIRED,
          },
        });

        if (updated.count > 0) {
          expiredCount++;
          logger.info({ orderId: order.id }, "Expired abandoned AWAITING_PAYMENT order");
        }
      }

      lastId = batch[batch.length - 1].id;
      await new Promise((r) => setTimeout(r, 50));
    }

    logger.info({ expiredCount }, "Expire awaiting payment job complete");
  } catch (err) {
    logger.error({ err }, "Error in expire awaiting payment job");
  }
};
