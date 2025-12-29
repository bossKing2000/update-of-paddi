// src/services/paymentService.ts
import { ActivityType, OrderStatus } from "@prisma/client";
import { paystack } from "../lib/axiosClient";
import { recordActivityBundle } from "../utils/activityUtils/recordActivityBundle";
import prisma from "../lib/prisma";
import retry from "async-retry";
// import { generateReceipt } from "../utils/generate Receipt/generateReceipt";
import {
  nowUtc,
  toUtc,
  addMinutesUtc,
  isAfterUtc,
  isBeforeUtc,
} from "../utils/time";

/**
 * ----------------------------
 *  PAYSTACK PAYMENT FUNCTIONS
 * ----------------------------
 */

export const initializePayment = async (
  amount: number,
  email: string,
  metadata: Record<string, any>
) => {
  const response = await paystack.post("/transaction/initialize", {
    email,
    amount,
    metadata,
  });
  return response.data.data;
};

export const verifyPayment = async (reference: string) => {
  const response = await paystack.get(`/transaction/verify/${reference}`);
  return response.data.data;
};

/**
 * ----------------------------
 *  INTERFACES
 * ----------------------------
 */

export interface OrderFromHandler {
  id: string;
  customerId: string;
  vendorId: string;
  totalPrice: number;
  status: OrderStatus;
  paymentInitiatedAt?: Date | null;
  paymentGraceMinutes?: number | null;
  Product?: OrderProduct[];
}

interface PaymentMeta {
  channel?: string;
  ipAddress?: string;
  userAgent?: string;
  deviceId?: string;
  geoCity?: string;
  geoCountry?: string;
}

interface ProductSchedule {
  takeDownAt: Date | null;
  graceMinutes: number | null;
}

interface OrderProduct {
  id: string;
  name: string;
  productSchedule?: ProductSchedule | null;
}

/**
 * ----------------------------
 *  HANDLE SUCCESSFUL PAYMENT
 * ----------------------------
 */

export const handleSuccessfulPayment = async (
  order: OrderFromHandler,
  reference: string,
  meta: PaymentMeta = {}
) => {
  const amountInNaira = order.totalPrice;

  await retry(
    async (bail: (err: Error) => void, attempt: number) => {
      try {
        const now = nowUtc();
        const graceMinutes = order.paymentGraceMinutes ?? 15;

        // 🕒 Determine earliest product takeDown + grace window (UTC)
        const productLiveUntil: Date | null =
          order.Product?.reduce((earliest: Date | null, prod: OrderProduct) => {
            if (!prod.productSchedule?.takeDownAt) return earliest;
            const takeDownUtc = toUtc(prod.productSchedule.takeDownAt);
            const grace = prod.productSchedule.graceMinutes ?? graceMinutes;
            const effectiveClose = addMinutesUtc(takeDownUtc, grace);
            return earliest
              ? new Date(Math.min(earliest.getTime(), effectiveClose.getTime()))
              : effectiveClose;
          }, null) ?? null;

        // Grace deadline for order itself (UTC)
        const paymentStartUtc = order.paymentInitiatedAt
          ? toUtc(order.paymentInitiatedAt)
          : now;
        const graceDeadline = addMinutesUtc(paymentStartUtc, graceMinutes);

        const productStillLive =
          productLiveUntil && isBeforeUtc(now, productLiveUntil);
        const isWithinGrace = isBeforeUtc(now, graceDeadline);

        // ❌ CASE: Payment never started & product offline
        if (!order.paymentInitiatedAt && !productStillLive) {
          console.warn(
            `[WEBHOOK] ❌ Order ${order.id} expired before payment — marking expired`
          );
          await prisma.payment.upsert({
            where: { reference },
            update: { status: "expired_before_payment" },
            create: {
              userId: order.customerId,
              orderId: order.id,
              amount: amountInNaira,
              reference,
              status: "expired_before_payment",
              channel: meta.channel || "saved_card",
              ipAddress: meta.ipAddress,
              deviceId: meta.deviceId,
              geoCity: meta.geoCity || "",
              geoCountry: meta.geoCountry || "",
              expiresAt: graceDeadline,
            },
          });
          return;
        }

        // ⚠️ CASE: Grace expired or product went offline before payment
        if (!productStillLive || !isWithinGrace) {
          console.warn(
            `[WEBHOOK] ⚠️ Late or expired payment for order ${order.id}`
          );
          await prisma.payment.upsert({
            where: { reference },
            update: { status: "late_payment_flagged" },
            create: {
              userId: order.customerId,
              orderId: order.id,
              amount: amountInNaira,
              reference,
              status: "late_payment_flagged",
              channel: meta.channel || "saved_card",
              ipAddress: meta.ipAddress,
              deviceId: meta.deviceId,
              geoCity: meta.geoCity || "",
              geoCountry: meta.geoCountry || "",
              expiresAt: graceDeadline,
            },
          });
          return;
        }

        // ✅ Normal successful payment
        const existingPayment = await prisma.payment.findUnique({
          where: { reference },
        });

        if (existingPayment) {
          if (existingPayment.status === "success") return;

          await prisma.$transaction([
            prisma.payment.update({
              where: { reference },
              data: {
                status: "success",
                expiresAt: graceDeadline,
                channel: meta.channel,
                ipAddress: meta.ipAddress,
                deviceId: meta.deviceId,
                geoCity: meta.geoCity || "",
                geoCountry: meta.geoCountry || "",
              },
            }),
            prisma.order.update({
              where: { id: order.id },
              data: {
                status: OrderStatus.PAYMENT_CONFIRMED,
                paidAt: now,
              },
            }),
          ]);
        } else {
          await prisma.$transaction([
            prisma.payment.create({
              data: {
                userId: order.customerId,
                orderId: order.id,
                amount: amountInNaira,
                reference,
                status: "success",
                channel: meta.channel || "saved_card",
                ipAddress: meta.ipAddress,
                deviceId: meta.deviceId,
                geoCity: meta.geoCity || "",
                geoCountry: meta.geoCountry || "",
                expiresAt: graceDeadline,
              },
            }),
            prisma.order.update({
              where: { id: order.id },
              data: {
                status: OrderStatus.PAYMENT_CONFIRMED,
                paidAt: now,
              },
            }),
          ]);
        }

        // 🧾 Generate receipt + record activity
        try {
          // const receipt = await generateReceipt(reference);
          // console.log(`[RECEIPT] ✅ Generated at ${receipt.pdfUrl}`);
        } catch (err: any) {
          console.error(
            `[RECEIPT] ❌ Failed to generate receipt: ${err.message}`
          );
        }

        await recordActivityBundle({
          actorId: order.customerId,
          orderId: order.id,
          actions: [
            {
              type: ActivityType.PAYMENT_SUCCESS,
              title: "Payment Successful",
              message: `Your payment for order #${order.id} confirmed.`,
              targetId: order.customerId,
              socketEvent: "PAYMENT",
              metadata: { orderId: order.id, amount: amountInNaira, reference },
            },
            {
              type: ActivityType.NEW_PAID_ORDER,
              title: "New Paid Order",
              message: `You have received a new paid order #${order.id}.`,
              targetId: order.vendorId,
              socketEvent: "ORDER",
              metadata: { orderId: order.id, amount: amountInNaira, reference },
            },
          ],
          audit: {
            action: "HANDLE_PAYMENT_WEBHOOK",
            metadata: {
              orderId: order.id,
              customerId: order.customerId,
              vendorId: order.vendorId,
              reference,
              amount: amountInNaira,
            },
          },
          notifyRealtime: true,
          notifyPush: true,
        });
      } catch (err: any) {
        if (err.code === "P2002") bail(err);
        throw err;
      }
    },
    { retries: 3, factor: 2, minTimeout: 500, maxTimeout: 2000 }
  );
};

/**
 * ----------------------------
 * CANCEL ORDERS FOR SPECIFIC OFFLINE PRODUCT
 * ----------------------------
 */
export async function cancelOrdersForOfflineProduct(productId: string) {
  try {
    const now = nowUtc();
    const defaultGraceMinutes = 15;

    // Fetch active orders containing this product
    const orders = await prisma.order.findMany({
      where: {
        items: { some: { productId } },
        status: { in: [OrderStatus.AWAITING_PAYMENT] },
      },
      include: {
        payments: { orderBy: { createdAt: "desc" }, take: 1 },
        items: {
          include: {
            product: {
              include: {
                productSchedule: {
                  select: { takeDownAt: true, graceMinutes: true },
                },
              },
            },
          },
        },
      },
    });

    for (const order of orders) {
      const latestPayment = order.payments[0];
      const orderGrace = order.paymentGraceMinutes ?? defaultGraceMinutes;

      // Determine earliest product offline time (UTC)
      const productLiveUntil = order.items.reduce((earliest: Date | null, item) => {
        const sch = item.product.productSchedule;
        if (!sch?.takeDownAt) return earliest;
        const takeDownUtc = toUtc(sch.takeDownAt);
        const grace = sch.graceMinutes ?? orderGrace;
        const effectiveClose = addMinutesUtc(takeDownUtc, grace);
        return earliest
          ? new Date(Math.min(earliest.getTime(), effectiveClose.getTime()))
          : effectiveClose;
      }, null);

      const productOffline =
        productLiveUntil && isAfterUtc(now, productLiveUntil);
      const paymentExpired =
        latestPayment?.expiresAt && isAfterUtc(now, latestPayment.expiresAt);

      // Only cancel if both product is offline and payment expired (or no payment)
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
      }
    }

    console.log(
      `[cancelOrdersForOfflineProduct] 🧹 Completed for product ${productId}`
    );
  } catch (err) {
    console.error(
      `[cancelOrdersForOfflineProduct] ❌ Failed for product ${productId}:`,
      err
    );
  }
}
