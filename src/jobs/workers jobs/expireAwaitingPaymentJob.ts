import { OrderStatus, PaymentStatus } from "@prisma/client";
import prisma from "../../config/prismaClient";
import { logger } from "../../lib/logger";
import { nowUtc, isAfterUtc } from "../../utils/time";
import { restoreStockForOrders } from "../../services/inventory.service";
import { clearProductCache } from "../../services/clearCaches";
import { releaseOrderDailyCaps } from "../../services/scheduling.service";

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

        // Cancellation and stock restoration now commit TOGETHER.
        //
        // Previously the status CAS ran on the root client and the restore was
        // a separate fire-and-forget call guarded only by a `.catch` log. If the
        // restore failed the order had already left AWAITING_PAYMENT, leaving no
        // durable trace that a restoration was owed — every other restore path
        // filters on AWAITING_PAYMENT and was therefore structurally blind to
        // it. Stock was lost for good.
        //
        // Inside one transaction both effects are atomic: if the restore throws,
        // the status change rolls back and the order stays AWAITING_PAYMENT, so
        // this same sweep naturally retries it on the next tick. No new column,
        // table or reconciliation job is required.
        let restoredProductIds: string[] = [];
        try {
          await prisma.$transaction(async (tx) => {
            // Atomic guard: only update if still AWAITING_PAYMENT and no
            // SUCCESS payment was inserted concurrently.
            const updated = await tx.order.updateMany({
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

            if (updated.count === 0) return;

            expiredCount++;
            // Winner of this CAS owns the reservation release.
            restoredProductIds = await restoreStockForOrders(tx, [order.id]);

            // Phase 3D: release the daily-cap units this unpaid order
            // consumed so another customer can use that day's capacity.
            try {
              const orderForCaps = await tx.order.findUnique({
                where: { id: order.id },
                select: {
                  id: true,
                  scheduledAt: true,
                  items: { select: { productId: true } },
                },
              });
              if (orderForCaps) {
                await releaseOrderDailyCaps(tx, orderForCaps);
              }
            } catch (capErr) {
              // A cap-release failure must not roll back an already-committed
              // cancellation; the capacity stays consumed until a reconciliation
              // sweep can correct it. Logged only.
              logger.warn(
                { err: capErr, orderId: order.id },
                "Failed to release daily cap on order expiry",
              );
            }
          });
        } catch (err) {
          // Nothing was committed, so the order remains AWAITING_PAYMENT and
          // is retried on the next run. Logged with identifiers only.
          logger.error(
            { err, orderId: order.id },
            "Failed to expire order and restore its stock reservation; will retry",
          );
          continue;
        }
        // Post-commit (the catch above continues on failure): the restored
        // portions are purchasable again, so sweep the cached rows. A failure
        // here only costs display staleness — it must not roll anything back
        // or re-trigger the restore.
        await Promise.all(
          [...new Set(restoredProductIds)].map((productId) =>
            clearProductCache(productId)
              .then((result) => {
                if (result && !result.ok) {
                  logger.warn(
                    { productId, orderId: order.id, failures: result.failures },
                    "Product cache invalidation incomplete after expiry stock restore",
                  );
                }
              })
              .catch((err) => {
                logger.warn(
                  { err, productId, orderId: order.id },
                  "Product cache invalidation threw unexpectedly after expiry stock restore",
                );
              }),
          ),
        );
        logger.info({ orderId: order.id }, "Expired abandoned AWAITING_PAYMENT order");
      }

      lastId = batch[batch.length - 1].id;
      await new Promise((r) => setTimeout(r, 50));
    }

    logger.info({ expiredCount }, "Expire awaiting payment job complete");
  } catch (err) {
    logger.error({ err }, "Error in expire awaiting payment job");
  }
};
