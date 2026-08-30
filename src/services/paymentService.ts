// src/services/paymentService.ts
import { OrderStatus } from "@prisma/client";
import { paystack } from "../lib/axiosClient";
import prisma from "../lib/prisma";
import { logger } from "../lib/logger";
import { nowUtc, toUtc, addMinutesUtc, isAfterUtc } from "../utils/time";

/**
 * ----------------------------
 *  PAYSTACK PAYMENT FUNCTIONS
 * ----------------------------
 */

export const SUPPORTED_CHANNELS = ["card", "bank", "ussd", "bank_transfer"] as const;
export type PaystackChannel = typeof SUPPORTED_CHANNELS[number];

export const initializePayment = async (
  amount: number,
  email: string,
  metadata: Record<string, any>,
  opts?: { channels?: PaystackChannel[]; currency?: string; callbackUrl?: string }
) => {
  const payload: Record<string, any> = { email, amount, metadata };
  if (opts?.channels && opts.channels.length > 0) payload.channels = opts.channels;
  if (opts?.currency) payload.currency = opts.currency;
  else payload.currency = "NGN";
  if (opts?.callbackUrl) payload.callback_url = opts.callbackUrl;
  const response = await paystack.post("/transaction/initialize", payload);
  return response.data.data;
};

export const verifyPayment = async (reference: string) => {
  const response = await paystack.get(`/transaction/verify/${reference}`);
  return response.data.data;
};

// NOTE: the payment-confirmation logic that used to live here
// (`handleSuccessfulPayment`) has been consolidated into
// `services/paymentFinalizer.service.ts`'s `finalizePaymentSuccess`. It
// had diverged from the webhook handler's own (separate, more thorough)
// confirmation logic — no amount validation, no customer-consistency
// check, and it always failed to attach a receipt (passed the Paystack
// reference where a Payment row's `id` was expected). Every entry point
// that can learn a payment succeeded — the webhook, confirmPayment,
// chargeSavedCard, and the verifyPendingPayments job — now calls the one
// canonical implementation instead.

/**
 * ----------------------------
 * CANCEL ORDERS FOR SPECIFIC OFFLINE PRODUCT
 * ----------------------------
 * Cancels AWAITING_PAYMENT orders containing a product that's gone
 * offline, but only once that order's own payment window has also
 * expired — a customer who's already mid-payment shouldn't have their
 * order yanked out from under them just because the vendor happened to
 * close up shop in the same few minutes.
 */
export async function cancelOrdersForOfflineProduct(productId: string) {
  const now = nowUtc();
  const defaultGraceMinutes = 15;

  try {
    const orders = await prisma.order.findMany({
      where: { items: { some: { productId } }, status: OrderStatus.AWAITING_PAYMENT },
      include: {
        payments: { orderBy: { createdAt: "desc" }, take: 1 },
        items: { include: { product: { include: { productSchedule: { select: { takeDownAt: true, graceMinutes: true } } } } } },
      },
    });

    for (const order of orders) {
      const latestPayment = order.payments[0];
      const orderGrace = order.paymentGraceMinutes ?? defaultGraceMinutes;

      const productLiveUntil = order.items.reduce((earliest: Date | null, item) => {
        const sch = item.product.productSchedule;
        if (!sch?.takeDownAt) return earliest;
        const takeDownUtc = toUtc(sch.takeDownAt);
        const grace = sch.graceMinutes ?? orderGrace;
        const effectiveClose = addMinutesUtc(takeDownUtc, grace);
        return earliest ? new Date(Math.min(earliest.getTime(), effectiveClose.getTime())) : effectiveClose;
      }, null as Date | null);

      const productOffline = productLiveUntil && isAfterUtc(now, productLiveUntil);
      const paymentExpired = latestPayment?.expiresAt && isAfterUtc(now, latestPayment.expiresAt);

      if (!latestPayment || (productOffline && paymentExpired)) {
        await prisma.order.update({
          where: { id: order.id },
          data: {
            status: OrderStatus.CANCELLED,
            cancelledAt: now,
            cancellationReason: productOffline ? "PRODUCT_WENT_OFFLINE_BEFORE_PAYMENT" : "PAYMENT_EXPIRED",
            paymentStatus: "FAILED",
          },
        });
      }
    }

    logger.info({ productId, cancelledCount: orders.length }, "cancelOrdersForOfflineProduct completed");
  } catch (err) {
    logger.error({ err, productId }, "cancelOrdersForOfflineProduct failed");
  }
}
