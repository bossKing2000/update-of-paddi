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
      { retryable: !err?.response },
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
