import { Payment, Order, OrderItem } from "@prisma/client";
import { nowUtc, addMinutesUtc, isAfterUtc } from "../../utils/time";
import { OrderStatus } from "@prisma/client";
import prisma from "../../config/prismaClient";
import { logger } from "../../lib/logger";

/**
 * 🧹 Automatically cancels expired or offline orders in batches
 */
export const runOrderCleanupJob = async (batchSize = 1000) => {
  const now = nowUtc();
  const graceMinutesDefault = 15;
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
            isLive: boolean;
            liveUntil: Date | null;
            productSchedule: { takeDownAt: Date | null; graceMinutes: number | null } | null;
          };
        })[];
        payments: Payment[];
      })[] = await prisma.order.findMany({
        where: {
          status: OrderStatus.AWAITING_PAYMENT,
          OR: [
            // Product-level offline (existing rule)
            {
              items: {
                some: {
                  product: {
                    OR: [
                      { isLive: false },
                      { productSchedule: { takeDownAt: { lt: now } } },
                    ],
                  },
                },
              },
            },
            // Vendor Live: vendor went offline or paused orders (same
            // lifecycle treatment as product-offline — only affects
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
                  isLive: true,
                  liveUntil: true,
                  productSchedule: {
                    select: { takeDownAt: true, graceMinutes: true },
                  },
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
        const latestPayment = order.payments[0];
        const orderGrace = order.paymentGraceMinutes ?? graceMinutesDefault;

        const productOffline = order.items.some((item) => {
          const prod = item.product;
          const sch = prod.productSchedule;
          const grace = sch?.graceMinutes ?? orderGrace;

          const scheduledClose = sch?.takeDownAt
            ? addMinutesUtc(sch.takeDownAt, grace)
            : null;
          const liveUntilClose = prod.liveUntil ? new Date(prod.liveUntil) : null;

          return (
            !prod.isLive ||
            (scheduledClose && isAfterUtc(now, scheduledClose)) ||
            (liveUntilClose && isAfterUtc(now, liveUntilClose))
          );
        });

        // Vendor Live: vendor offline / paused orders blocks the unpaid
        // purchase flow exactly like product-offline does.
        const vendorOffline =
          !order.vendor.isLive ||
          ((order.vendor.deliveryPreferences as Record<string, unknown> | null)?.acceptingOrders === false);

        const paymentExpired = latestPayment?.expiresAt
          ? isAfterUtc(now, latestPayment.expiresAt)
          : true;

        const offline = productOffline || vendorOffline;
        if (!latestPayment || (offline && paymentExpired)) {
          await prisma.order.update({
            where: { id: order.id },
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
          offlineUpdated++;
        }
      }

      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    logger.info({ offlineUpdated }, "Order cleanup job complete");
  } catch (err: any) {
    logger.error({ err }, "Error in order cleanup job");
  }
};
