// src/services/paymentService.ts
import { paystack } from "../lib/axiosClient";

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
// NOTE (Stage 1): the schedule-driven `cancelOrdersForOfflineProduct`
// helper was removed along with the product scheduling system. Unpaid
// orders for archived/offline products are handled by the order cleanup
// cron (`orderCleanupJob`), which also respects the payment window.

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


