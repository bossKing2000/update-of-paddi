import { Payment, Order, OrderItem } from "@prisma/client";
import { nowUtc, isAfterUtc } from "../../utils/time";
import { OrderStatus } from "@prisma/client";
import prisma from "../../config/prismaClient";
import { logger } from "../../lib/logger";
import { restoreStockForOrders } from "../../services/inventory.service";
import { clearProductCache } from "../../services/clearCaches";

/**
 * 🧹 Automatically cancels expired or offline orders in batches
 *
 * Stage 1 (no product scheduling): an AWAITING_PAYMENT order becomes
 * unfulfillable when its product was archived or its vendor went offline /
 * paused orders. Cancellation still requires the order's own payment window
 * to have expired too — a customer mid-payment is never yanked. Paid,
 * cooking, ready, delivery and completed orders are untouched.
 */
export const runOrderCleanupJob = async (batchSize = 1000) => {
  const now = nowUtc();
  let offlineUpdated = 0;

  try {
    logger.info({ now: now.toISOString() }, "Running order cleanup job");

    let loopCounter = 0;

    while (true) {
      loopCounter++;
      if (loopCounter > 1000) break;

      const batch: (Order & {
        vendor: { id: string; isLive: boolean; deliveryPreferences: unknown };
        items: (OrderItem & {
          product: {
            id: string;
            archived: boolean;
          };
        })[];
        payments: Payment[];
      })[] = await prisma.order.findMany({
        where: {
          status: OrderStatus.AWAITING_PAYMENT,
          OR: [
            // Product-level offline: vendor archived the product.
            {
              items: {
                some: {
                  product: {
                    archived: true,
                  },
                },
              },
            },
            // Vendor went offline or paused orders (only affects
            // AWAITING_PAYMENT orders; paid/completed orders are untouched)
            {
              vendor: {
                OR: [
                  { isLive: false },
                  { deliveryPreferences: { path: ["acceptingOrders"], equals: false } },
                ],
              },
            },
          ],
        },
        include: {
          vendor: { select: { id: true, isLive: true, deliveryPreferences: true } },
          items: {
            include: {
              product: {
                select: {
                  id: true,
                  archived: true,
                },
              },
            },
          },
          payments: { orderBy: { createdAt: "desc" }, take: 1 },
        },
        take: batchSize,
      });

      if (batch.length === 0) break;

      for (const order of batch) {
        try {
          const latestPayment = order.payments[0];

          const productOffline = order.items.some((item) => item.product.archived);

          // Vendor offline / paused orders blocks the unpaid purchase flow
          // exactly like product-offline does.
          const vendorOffline =
            !order.vendor.isLive ||
            ((order.vendor.deliveryPreferences as Record<string, unknown> | null)?.acceptingOrders === false);

          const paymentExpired = latestPayment?.expiresAt
            ? isAfterUtc(now, latestPayment.expiresAt)
            : true;

          // Protect against finalization race — skip if payment is actively being processed
          const isProcessing = order.payments.some((p) => (p as any).isProcessing === true);
          if (isProcessing) {
            logger.info({ orderId: order.id }, "Skipping order cleanup — payment isProcessing=true");
            continue;
          }

          const offline = productOffline || vendorOffline;
          if (!latestPayment || (offline && paymentExpired)) {
            // Cancellation and stock restoration commit TOGETHER — see the
            // matching comment in expireAwaitingPaymentJob. Previously the CAS
            // ran on the root client and the restore was fire-and-forget, so a
            // failed restore left an order that had already left AWAITING_PAYMENT
            // with no durable record that a restoration was owed.
            let cancelled = false;
            let cancelledProductIds: string[] = [];
            try {
              await prisma.$transaction(async (tx) => {
                // Atomic: only cancel if still AWAITING_PAYMENT and no SUCCESS
                // payment was inserted concurrently.
                const updated = await tx.order.updateMany({
                  where: {
                    id: order.id,
                    status: OrderStatus.AWAITING_PAYMENT,
                    payments: { none: { status: "SUCCESS" as any } },
                  },
                  data: {
                    status: OrderStatus.CANCELLED,
                    cancelledAt: now,
                    cancellationReason: productOffline
                      ? "PRODUCT_WENT_OFFLINE_BEFORE_PAYMENT"
                      : vendorOffline
                        ? "VENDOR_WENT_OFFLINE_BEFORE_PAYMENT"
                        : "PAYMENT_EXPIRED",
                    paymentStatus: "FAILED",
                  },
                });
                if (updated.count === 0) return;

                cancelled = true;
                offlineUpdated++;
                // Winner of this CAS owns the reservation release.
                cancelledProductIds = await restoreStockForOrders(tx, [order.id]);
              });
            } catch (err) {
              // Rolled back: the order remains AWAITING_PAYMENT and the next run
              // retries it. Identifiers only, no secrets.
              logger.error(
                { err, orderId: order.id },
                "Failed to clean up order and restore its stock reservation; will retry",
              );
              cancelled = false;
            }

            if (cancelled) {
              // Post-commit: the restored portions are purchasable again, so
              // sweep the cached rows. Best-effort — a failure only costs
              // display staleness and must not touch the committed restore.
              await Promise.all(
                [...new Set(cancelledProductIds)].map((productId) =>
                  clearProductCache(productId)
                    .then((result) => {
                      if (result && !result.ok) {
                        logger.warn(
                          { productId, orderId: order.id, failures: result.failures },
                          "Product cache invalidation incomplete after cleanup stock restore",
                        );
                      }
                    })
                    .catch((err) => {
                      logger.warn(
                        { err, productId, orderId: order.id },
                        "Product cache invalidation threw unexpectedly after cleanup stock restore",
                      );
                    }),
                ),
              );
              await prisma.auditLog
                .create({
                  data: {
                    action: "ORDER_AUTO_CANCELLED",
                    ipAddress: "system",
                    userAgent: "orderCleanupJob",
                    path: "/jobs/orderCleanup",
                    details: {
                      reason: "PAYMENT_EXPIRED",
                      orderId: order.id,
                      cancellationReason: productOffline
                        ? "PRODUCT_WENT_OFFLINE_BEFORE_PAYMENT"
                        : vendorOffline
                          ? "VENDOR_WENT_OFFLINE_BEFORE_PAYMENT"
                          : "PAYMENT_EXPIRED",
                    },
                  },
                })
                .catch((err) =>
                  logger.error({ err, orderId: order.id }, "Failed to write audit log for cleaned-up order"),
                );
            }
          }
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error));
          logger.error(`orderCleanupJob: failed to process order ${order.id}: ${err.message}`);
          // continue to next order
        }
      }

      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    logger.info({ offlineUpdated }, "Order cleanup job complete");
  } catch (err: any) {
    logger.error({ err }, "Error in order cleanup job");
  }
};
