import { OrderStatus, PaymentStatus, RefundStatus, ActivityType } from "@prisma/client";
import prisma from "../../config/prismaClient";
import { logger } from "../../lib/logger";
import { fileRefundOwed } from "../../services/refundObligation.service";
import { nowUtc } from "../../utils/time";
import { recordActivityBundle } from "../../utils/activityUtils/recordActivityBundle";
import { reconcileActiveDeliveryAssignments } from "../../services/deliveryAssignmentReconciliation";

/**
 * ⏰ Expire unconfirmed PAYMENT_CONFIRMED orders (3C vendor timeout).
 * Runs every 2 minutes via node-cron.
 *
 * Business rule (README 3C): vendors get 10 minutes to confirm after
 * payment. A paid order still sitting in PAYMENT_CONFIRMED with no vendor
 * action past that deadline is auto-cancelled, an order-bounded refund
 * request is filed, and the customer is notified.
 *
 * Safety design (mirrors the paid-cancel path in updateOrderStatus):
 * - Selection is advisory only. The CAS `updateMany where {id, status:
 *   PAYMENT_CONFIRMED}` inside the transaction decides the winner — a
 *   concurrent vendor COOKING/cancel, customer cancel, admin override, or
 *   refund completion that moved the order first yields count 0 and this
 *   run touches nothing (no refund, no notify).
 * - Refund filing reuses the paid-cancel guards: SUCCESS payment looked up
 *   by idempotencyKey, open-request (PENDING/APPROVED/PROCESSING) check,
 *   order-bounded requestedAmountKobo. Retried ticks cannot file twice.
 * - Paid orders never restore stock (portions are consumed on success) —
 *   same as the paid-cancel path.
 * - Terminal delivery assignments are reconciled in the same transaction.
 * - Notification fires only when this run won the CAS, post-commit.
 */
export const VENDOR_CONFIRM_TIMEOUT_MS = 10 * 60 * 1000;

export const runExpireUnconfirmedVendorOrders = async (batchSize = 200) => {
  const now = nowUtc();
  // Vendor confirmation deadline is paidAt + 10 minutes for ALL orders,
  // immediate and scheduled alike. `scheduledAt` is the requested fulfilment
  // time — a separate constraint — not the vendor-confirmation deadline.
  // Using scheduledAt as the confirmation deadline would let a vendor leave
  // an order unconfirmed until its fulfilment time has already arrived,
  // defeating the 10-minute confirmation window.
  const deadline = new Date(now.getTime() - VENDOR_CONFIRM_TIMEOUT_MS);
  let expiredCount = 0;

  try {
    logger.info(
      { now: now.toISOString() },
      "Running expire unconfirmed vendor orders job",
    );

    let lastId: string | null = null;
    while (true) {
      const batch: any[] = await prisma.order.findMany({
        where: {
          status: OrderStatus.PAYMENT_CONFIRMED,
          paymentStatus: PaymentStatus.SUCCESS,
          // All orders — immediate and scheduled — share the same
          // confirmation deadline: paidAt + VENDOR_CONFIRM_TIMEOUT_MS.
          paidAt: { lt: deadline },
        },
        select: {
          id: true,
          customerId: true,
          vendorId: true,
          totalPrice: true,
          idempotencyKey: true,
          paidAt: true,
          scheduledAt: true,
        },
        orderBy: { id: "asc" },
        take: batchSize,
        cursor: lastId ? { id: lastId } : undefined,
        skip: lastId ? 1 : 0,
      });

      if (batch.length === 0) break;

      for (const order of batch) {
        let won = false;
        try {
          await prisma.$transaction(async (tx) => {
            const updated = await tx.order.updateMany({
              where: { id: order.id, status: OrderStatus.PAYMENT_CONFIRMED },
              data: {
                status: OrderStatus.CANCELLED,
                cancellationReason: "VENDOR_TIMEOUT",
                cancelledAt: now,
              },
            });
            if (updated.count === 0) return;
            won = true;

            await reconcileActiveDeliveryAssignments(tx, order.id);

            const payment = await tx.payment.findFirst({
              where: {
                idempotencyKey: order.idempotencyKey,
                status: PaymentStatus.SUCCESS,
              },
            });
            if (payment) {
              // Finding C-1: scope the dedupe to THIS order, matching the
              // `orderId` this request is about to be filed with below. A batch
              // payment spans several orders; an unresolved request for a
              // sibling must not suppress this order's obligation. Mirrors
              // fileRefundOwedForCancelledOrder in paymentFinalizer.service.ts.
              // A NULL-orderId row does not match and cannot suppress it.
              const existing = await tx.refundRequest.findFirst({
                where: {
                  paymentRef: payment.reference,
                  orderId: order.id,
                  status: {
                    in: [
                      RefundStatus.PENDING,
                      RefundStatus.APPROVED,
                      RefundStatus.PROCESSING,
                    ],
                  },
                },
              });
              if (!existing) {
                // C-2: conflict-tolerant insert. See
                // src/services/refundObligation.service.ts — the ON CONFLICT
                // target is the partial unique index, so a concurrent tick
                // that filed the same obligation first is a no-op rather than
                // a duplicate row, and no uniqueness error is raised.
                await fileRefundOwed(tx, {
                  userId: order.customerId,
                  paymentRef: payment.reference,
                  reason: "Vendor did not confirm the order in time",
                  orderId: order.id,
                  // order.totalPrice is integer kobo (Phase 3A). Pass directly:
                  // no * 100, which would double-convert kobo.
                  requestedAmountKobo: order.totalPrice,
                });
              }
            }
          });
        } catch (err) {
          // Nothing was committed, so the order is still PAYMENT_CONFIRMED
          // and is retried on the next tick. Logged with identifiers only.
          logger.error(
            { err, orderId: order.id },
            "Failed to expire unconfirmed vendor order; will retry",
          );
          continue;
        }

        if (!won) continue;
        expiredCount++;

        // Post-commit, winner-only: notify the customer. A failure here
        // only costs a missed notification — state is already committed.
        try {
          await recordActivityBundle({
            actorId: order.vendorId,
            orderId: order.id,
            actions: [
              {
                type: ActivityType.GENERAL,
                title: "Order cancelled",
                message: `Order ${order.id} was cancelled because the vendor did not confirm in time. A refund has been requested.`,
                targetId: order.customerId,
                socketEvent: "ORDER",
                metadata: { orderId: order.id, reason: "VENDOR_TIMEOUT" },
              },
            ],
            audit: {
              action: "VENDOR_TIMEOUT_CANCEL",
              metadata: { orderId: order.id, reason: "VENDOR_TIMEOUT" },
            },
            notifyRealtime: true,
            notifyPush: true,
          });
        } catch (err) {
          logger.warn(
            { err, orderId: order.id },
            "Vendor-timeout notification failed after commit",
          );
        }
        logger.info({ orderId: order.id }, "Expired unconfirmed PAYMENT_CONFIRMED order");
      }

      lastId = batch[batch.length - 1].id;
      await new Promise((r) => setTimeout(r, 50));
    }

    logger.info({ expiredCount }, "Expire unconfirmed vendor orders job complete");
  } catch (err) {
    logger.error({ err }, "Error in expire unconfirmed vendor orders job");
  }
};
