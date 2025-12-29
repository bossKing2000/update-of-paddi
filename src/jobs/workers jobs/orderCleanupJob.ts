import { Payment, Order, OrderItem } from "@prisma/client";
import { nowUtc, addMinutesUtc, isAfterUtc } from "../../utils/time";
import { OrderStatus } from "@prisma/client";
import prisma from "../../config/prismaClient";

/**
 * 🧹 Automatically cancels expired or offline orders in batches
 */
export const runOrderCleanupJob = async (batchSize = 1000) => {
  const now = nowUtc();
  const graceMinutesDefault = 15;
  let offlineUpdated = 0;

  try {
    console.log("🧹 Running order cleanup job (UTC)...", now.toISOString());

    let loopCounter = 0;

    while (true) {
      loopCounter++;
      if (loopCounter > 1000) break;

      const batch: (Order & {
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
        include: {
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

        const paymentExpired = latestPayment?.expiresAt
          ? isAfterUtc(now, latestPayment.expiresAt)
          : true;

        if (!latestPayment || (productOffline && paymentExpired)) {
          await prisma.order.update({
            where: { id: order.id },
            data: {
              status: OrderStatus.CANCELLED,
              cancelledAt: now,
              cancellationReason: productOffline
                ? "PRODUCT_WENT_OFFLINE_BEFORE_PAYMENT"
                : "PAYMENT_EXPIRED",
              paymentStatus: "FAILED",
            },
          });
          offlineUpdated++;
        }
      }

      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    console.log(`✅ Cleanup done (UTC) → Offline cancelled: ${offlineUpdated}`);
  } catch (err: any) {
    console.error("❌ Error in order cleanup job:", err instanceof Error ? err.message : err);
  }
};
