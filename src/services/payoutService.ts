import { paystack } from "../lib/axiosClient";
import { UpstreamServiceError } from "../errors/AppError";
import { logger } from "../lib/logger";

/**
 * Creates (or reuses) a Paystack transfer recipient for a vendor's bank
 * account, then initiates a transfer to it. This is what actually moves
 * money to a vendor — before this, "payout" was just a number on a
 * screen with no way to actually pay anyone.
 *
 * Two-step Paystack flow: create a transfer recipient (once per bank
 * account — the resulting recipient_code is cached on the User record so
 * subsequent payouts skip this step), then initiate a transfer to it.
 */

export interface CreateRecipientInput {
  name: string;
  accountNumber: string;
  bankCode: string;
}

/**
 * N-03: what we actually know about the outcome of a transfer request after
 * it failed to produce a normal response.
 *
 *   REJECTED — Paystack answered 4xx: the request was refused and no
 *              transfer was created. Provably safe to treat as a failure.
 *   UNKNOWN  — we cannot prove the transfer was not created (no response at
 *              all: timeout / ECONNRESET / DNS / socket, OR a 5xx from
 *              Paystack whose edge may have accepted the transfer before
 *              failing). Money MAY have left. Must never be treated as a
 *              definite failure, or a retry can pay the recipient twice.
 *
 * Note this is deliberately NOT the same as the older `retryable` flag
 * (which is `!err?.response` and therefore calls a 5xx "definite"). That
 * flag is consumed by the vendor payout path and is left untouched so no
 * existing behaviour changes; transfer callers that must not risk a double
 * payment should branch on `outcome`.
 */
export type TransferInitiationOutcome = "REJECTED" | "UNKNOWN";

/**
 * Classifies a failed transfer request from the error alone. Never guesses
 * "definitely failed" without an actual 4xx answer from Paystack.
 */
export function classifyTransferInitiationError(err: any): TransferInitiationOutcome {
  const status = err?.response?.status;
  // No HTTP response at all: the request may or may not have reached
  // Paystack (timeout, connection reset, DNS/TLS failure, process kill).
  if (typeof status !== "number") return "UNKNOWN";
  // 5xx: Paystack's own server/edge failed. It may have accepted the
  // transfer before returning an error, so the outcome is still unknown.
  if (status >= 500) return "UNKNOWN";
  // 4xx (and any other answered status): Paystack replied that it refused
  // the request, so no transfer was created.
  return "REJECTED";
}

export const createTransferRecipient = async ({
  name,
  accountNumber,
  bankCode,
}: CreateRecipientInput): Promise<string> => {
  try {
    const response = await paystack.post("/transferrecipient", {
      type: "nuban",
      name,
      account_number: accountNumber,
      bank_code: bankCode,
      currency: "NGN",
    });

    const recipientCode = response.data?.data?.recipient_code;
    if (!recipientCode)
      throw new Error("Paystack did not return a recipient_code");
    return recipientCode;
  } catch (err: any) {
    logger.error(
      { err: err?.response?.data || err.message, bankCode },
      "createTransferRecipient failed",
    );
    throw new UpstreamServiceError(
      "Paystack",
      err?.response?.data?.message || "Failed to create transfer recipient",
      { retryable: !err?.response },
    );
  }
};

export interface InitiateTransferInput {
  amountNaira: number;
  recipientCode: string;
  reason: string;
  reference: string; // our own idempotency reference
}

export const initiateTransfer = async ({
  amountNaira,
  recipientCode,
  reason,
  reference,
}: InitiateTransferInput) => {
  if (!Number.isFinite(amountNaira) || amountNaira <= 0) {
    throw new UpstreamServiceError(
      "Paystack",
      "Payout amount must be greater than zero",
    );
  }
  const amountKobo = Math.round(amountNaira * 100);
  if (!Number.isSafeInteger(amountKobo) || amountKobo <= 0) {
    throw new UpstreamServiceError(
      "Paystack",
      "Payout amount is outside the supported range",
    );
  }

  try {
    const response = await paystack.post("/transfer", {
      source: "balance",
      amount: amountKobo,
      recipient: recipientCode,
      reason,
      reference,
    });
    return response.data?.data;
  } catch (err: any) {
    logger.error(
      { err: err?.response?.data || err.message, reference },
      "initiateTransfer failed",
    );
    throw new UpstreamServiceError(
      "Paystack",
      err?.response?.data?.message || "Failed to initiate transfer",
      {
        // Unchanged legacy semantics, still consumed by the vendor payout
        // path: "no HTTP response" was the only non-retryable signal there.
        retryable: !err?.response,
        // N-03: precise outcome for callers that must not risk paying twice.
        outcome: classifyTransferInitiationError(err),
      },
    );
  }
};

/**
 * Resolves a bank account number against a bank code with Paystack before
 * ever saving it — catches typos/wrong account numbers immediately
 * instead of discovering them when a real transfer fails later.
 */
export const resolveBankAccount = async (
  accountNumber: string,
  bankCode: string,
) => {
  try {
    const response = await paystack.get("/bank/resolve", {
      params: { account_number: accountNumber, bank_code: bankCode },
    });
    return response.data?.data as {
      account_number: string;
      account_name: string;
    };
  } catch (err: any) {
    logger.warn(
      {
        err: err?.response?.data || err.message,
        bankCode,
        accountNumberLast4: accountNumber.slice(-4),
      },
      "resolveBankAccount failed",
    );
    throw new UpstreamServiceError(
      "Paystack",
      err?.response?.data?.message ||
        "Could not verify this bank account. Please check the details and try again.",
    );
  }
};

/** Fetches Paystack's list of supported Nigerian banks (for a bank-picker dropdown on the frontend). */
export const listBanks = async () => {
  try {
    const response = await paystack.get("/bank", {
      params: { country: "nigeria" },
    });
    return (response.data?.data || []) as {
      name: string;
      code: string;
      slug: string;
    }[];
  } catch (err: any) {
    logger.error(
      { err: err?.response?.data || err.message },
      "listBanks failed",
    );
    throw new UpstreamServiceError("Paystack", "Failed to load bank list");
  }
};
