import prisma from "../../../lib/prisma";
import { verifyPayment } from "../../../services/paymentService";
import { finalizePaymentSuccess } from "../../../services/paymentFinalizer.service";
import { restoreStockForOrders } from "../../../services/inventory.service";
import { clearProductCache } from "../../../services/clearCaches";
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
          reference: { not: { startsWith: "SEED-" } },
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
            // N-04: one payment can cover several vendors' orders. The
            // authoritative batch key is Order.idempotencyKey — Payment.orderId
            // points only at the *primary/first* order (the same model the
            // finalizer's getOrdersForPayment uses). Expiring only
            // payment.orderId left the sibling orders AWAITING_PAYMENT until
            // the separate order-expiry cron ran, so a multi-vendor batch sat
            // half-expired for up to one cron interval.
            const expirableOrderScope = payment.idempotencyKey
              ? {
                  idempotencyKey: payment.idempotencyKey,
                  status: {
                    in: [OrderStatus.AWAITING_PAYMENT, OrderStatus.PENDING],
                  },
                }
              : {
                  id: payment.orderId,
                  status: {
                    in: [OrderStatus.AWAITING_PAYMENT, OrderStatus.PENDING],
                  },
                };

            // N-04A: this death path used to cancel the order WITHOUT
            // releasing its checkout-time stock reservation. Because the order
            // lands in CANCELLED_UNPAID, every other restoration path
            // (expireAwaitingPaymentJob, orderCleanupJob, the finalizer's
            // LATE_PAYMENT branch, the cancel endpoint) only ever looks at
            // AWAITING_PAYMENT orders — so the reserved portions were stranded
            // permanently, with no recovery.
            //
            // Restoration therefore has to happen HERE, inside the same
            // transaction as the cancellation, and only for orders this
            // execution actually transitioned. `restoreStockForOrders` is not
            // internally idempotent (it just does stock += qty with no
            // restoration marker), so the per-order CAS is the idempotency
            // boundary:
            //
            //   restoreStockForOrders  ⇔  this tx moved the order out of
            //                              [AWAITING_PAYMENT, PENDING]
            //
            // Anything already transitioned by a concurrent order-expiry,
            // cleanup, late-payment or cancellation returns count === 0 and
            // therefore must NOT restore — that other path owns it. Paid or
            // otherwise terminal orders are never in the candidate set and are
            // never touched. A failure anywhere rolls the whole batch back,
            // so there is no state where the payment is EXPIRED while some
            // siblings are cancelled-and-restored and others are not.
            const restoredProductIds: string[] = [];
            // P3.2-02: the candidate above was read before this transaction,
            // so a concurrent success may have settled the payment since.
            // Expiry is a conditional transition: only a payment that is
            // STILL pending may become EXPIRED. count === 0 means this
            // execution lost (or the payment was already settled), so it
            // must skip every downstream side effect — no cancellation, no
            // restore, no notifications. A thrown DB error propagates to the
            // per-payment catch below and is logged, never counted as
            // expired.
            let paymentExpired = false;
            await prisma.$transaction(async (tx) => {
              const paymentClaimed = await tx.payment.updateMany({
                where: {
                  id: payment.id,
                  status: { in: [PaymentStatus.PENDING, PaymentStatus.INITIATED] },
                },
                data: { status: PaymentStatus.EXPIRED },
              });
              if (paymentClaimed.count === 0) {
                logger.warn(
                  { paymentId: payment.id },
                  "verifyPendingPayments: payment already settled concurrently; skipping expiry",
                );
                return;
              }

              const candidates = await tx.order.findMany({
                where: expirableOrderScope,
                select: { id: true },
              });

              for (const candidate of candidates) {
                const updated = await tx.order.updateMany({
                  where: {
                    id: candidate.id,
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
                });
                // Winner of this CAS owns the reservation release.
                if (updated.count === 1) {
                  restoredProductIds.push(
                    ...(await restoreStockForOrders(tx, [candidate.id])),
                  );
                }
              }
              paymentExpired = true;
            });
            // Post-commit: every restored portion is purchasable again, so
            // sweep the cached rows. Best-effort — a failure only costs
            // display staleness and must not touch the committed batch.
            await Promise.all(
              [...new Set(restoredProductIds)].map((productId) =>
                clearProductCache(productId)
                  .then((result) => {
                    if (result && !result.ok) {
                      logger.warn(
                        { productId, paymentId: payment.id, failures: result.failures },
                        "Product cache invalidation incomplete after expiry stock restore",
                      );
                    }
                  })
                  .catch((err) => {
                    logger.warn(
                      { err, productId, paymentId: payment.id },
                      "Product cache invalidation threw unexpectedly after expiry stock restore",
                    );
                  }),
              ),
            );
            expired += paymentExpired ? 1 : 0;
            continue;
          }

          const data = await verifyPayment(payment.reference);
          if (data.status === "success") {
            const result = await finalizePaymentSuccess({
              reference: payment.reference,
              amountKobo: data.amount, // integer kobo from Paystack (Phase 3A)
              currency: data.currency,
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
