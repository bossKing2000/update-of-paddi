import { Response } from "express";
import { z } from "zod";
import prisma from "../lib/prisma";
import { AuthRequest } from "../middlewares/auth.middleware";
import { VendorDashboardService } from "./vendorDashboard.service";
import { resolveBankAccount, listBanks } from "../services/payoutService";
import { sendSuccess } from "../utils/apiResponse";
import { ValidationError } from "../errors/AppError";
import { createAuditLog } from "../utils/auditLog.service";

// GET /vendor/payouts
export const getPayoutSummary = async (req: AuthRequest, res: Response) => {
  const service = new VendorDashboardService(req.user!.id);
  const data = await service.getPayoutSummary();
  return sendSuccess(res, data, "Payout summary retrieved");
};

// GET /vendor/payouts/bank-details
export const getBankDetails = async (req: AuthRequest, res: Response) => {
  const vendor = await prisma.user.findUnique({
    where: { id: req.user!.id },
    select: {
      bankName: true,
      bankCode: true,
      bankAccountNumber: true,
      bankAccountName: true,
    },
  });
  return sendSuccess(
    res,
    vendor && {
      bankName: vendor.bankName,
      bankCode: vendor.bankCode,
      bankAccountName: vendor.bankAccountName,
      bankAccountNumber: vendor.bankAccountNumber
        ? `******${vendor.bankAccountNumber.slice(-4)}`
        : null,
    },
    "Bank details retrieved",
  );
};

// GET /vendor/payouts/banks
export const getBankList = async (_req: AuthRequest, res: Response) => {
  const banks = await listBanks();
  return sendSuccess(res, { banks }, "Bank list retrieved");
};

const setBankDetailsSchema = z.object({
  bankName: z.string().min(1),
  bankCode: z.string().min(1),
  bankAccountNumber: z
    .string()
    .min(10)
    .max(10, "Nigerian account numbers are 10 digits"),
});

// PUT /vendor/payouts/bank-details
export const setBankDetails = async (req: AuthRequest, res: Response) => {
  const parsed = setBankDetailsSchema.safeParse(req.body);
  if (!parsed.success)
    throw new ValidationError(
      "Invalid bank details",
      parsed.error.flatten().fieldErrors,
    );
  const { bankName, bankCode, bankAccountNumber } = parsed.data;

  // Verified with Paystack BEFORE saving — catches a mistyped account
  // number immediately (with a clear error) instead of only discovering
  // it's wrong when a real payout transfer fails later. Also means the
  // saved account name comes from the bank's own record, not whatever
  // the vendor typed.
  const resolved = await resolveBankAccount(bankAccountNumber, bankCode);

  await prisma.user.update({
    where: { id: req.user!.id },
    data: {
      bankName,
      bankCode,
      bankAccountNumber,
      bankAccountName: resolved.account_name,
      paystackRecipientCode: null, // re-created fresh on the next payout with these new details
    },
  });

  await createAuditLog({
    userId: req.user!.id,
    action: "VENDOR_BANK_DETAILS_UPDATED",
    req,
    metadata: { bankName, bankCode },
  });

  return sendSuccess(
    res,
    { accountName: resolved.account_name },
    "Bank details verified and saved",
  );
};
