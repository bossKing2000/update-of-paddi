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

/**
 * GET /refund/:id — fetch a single refund's current status by Paystack's
 * own numeric/string refund id. Used by the reconciliation job once we
 * have a recorded paystackRefundId to check on.
 * https://paystack.com/docs/api/refund/#fetch
 */
export const fetchRefundById = async (paystackRefundId: string) => {
  const response = await paystack.get(`/refund/${paystackRefundId}`);
  return response.data.data as {
    id: number;
    transaction: number | { id: number; reference: string };
    amount: number;
    status: "pending" | "processing" | "needs-attention" | "processed" | "failed";
    [key: string]: any;
  };
};

/**
 * GET /refund?transaction=<reference> — list refunds Paystack has on
 * record for a transaction. Used by reconciliation ONLY for the crash
 * case where we reserved+recorded PROCESSING locally but never got back
 * (or never persisted) Paystack's refund id, so we have nothing to fetch
 * by id directly.
 * https://paystack.com/docs/api/refund/#list
 */
export const listRefundsForTransaction = async (transactionReference: string) => {
  const response = await paystack.get("/refund", { params: { transaction: transactionReference } });
  return response.data.data as Array<{
    id: number;
    transaction: number | { id: number; reference: string };
    amount: number;
    status: "pending" | "processing" | "needs-attention" | "processed" | "failed";
    [key: string]: any;
  }>;
};

/**
 * Distinguishes a DEFINITE Paystack refund-submission failure (Paystack
 * received our POST /refund and responded, rejecting it — no refund was
 * created, safe to release the reservation) from an UNKNOWN outcome
 * (timeout, connection reset, no response ever received — Paystack may
 * or may not have created the refund before we lost the connection).
 *
 * This distinction is the whole point of FIX 2/7: releasing a
 * reservation for an outcome we don't actually know risks a second
 * refund attempt on top of one that silently succeeded.
 */
export function classifyRefundSubmitError(err: any): "definite_failure" | "unknown" {
  const code = err?.code as string | undefined;
  const message = String(err?.message || "").toLowerCase();
  if (
    code === "ECONNABORTED" ||
    code === "ETIMEDOUT" ||
    code === "ECONNRESET" ||
    code === "ENOTFOUND" ||
    code === "EAI_AGAIN" ||
    message.includes("timeout") ||
    message.includes("socket hang up") ||
    message.includes("network error")
  ) {
    return "unknown";
  }
  if (err?.response) {
    // Paystack received the request and sent back a definite answer
    // (rejection) — nothing was queued on their side.
    return "definite_failure";
  }
  if (err?.request) {
    // Request went out over the wire but no response ever came back —
    // we cannot tell whether Paystack actioned it first.
    return "unknown";
  }
  // Never left our process (e.g. request-construction error) — Paystack
  // never saw it.
  return "definite_failure";
}
