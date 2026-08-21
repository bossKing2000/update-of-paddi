import { paystack } from "../lib/axiosClient";

/**
 * Calls Paystack's refund API directly. Previously there was no code path
 * anywhere in the app that actually moved money back to a customer —
 * `requestRefund` (Payments domain) only ever created a RefundRequest
 * row; nothing acted on it.
 *
 * This function does ONE thing: talk to Paystack. It does not touch the
 * database — the caller (adminUpdateRefundStatus) is responsible for
 * updating Payment/Order/RefundRequest records only *after* this call
 * succeeds, so a Paystack failure never leaves local records claiming
 * money moved when it didn't.
 *
 * @param reference   The original Paystack transaction reference being refunded.
 * @param amountKobo  Optional partial-refund amount, in kobo. Omit for a full refund.
 */
export const refundPaymentViaPaystack = async (reference: string, amountKobo?: number) => {
  const response = await paystack.post("/refund", {
    transaction: reference,
    ...(amountKobo ? { amount: amountKobo } : {}),
  });
  return response.data.data;
};
