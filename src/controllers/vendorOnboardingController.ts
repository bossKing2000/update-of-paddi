import { Response } from "express";
import { AuthRequest } from "../middlewares/auth.middleware";
import prisma from "../lib/prisma";
import { sendSuccess } from "../utils/apiResponse";
import { NotFoundError } from "../errors/AppError";

// GET /api/vendor/onboarding
// Phase 1C: the vendor's onboarding state in one call — current lifecycle
// status, whether going live is allowed right now, and per-step progress.
// Bank details are informational only (required: false); they never gate
// going live, only payouts.
export const getVendorOnboarding = async (req: AuthRequest, res: Response) => {
  const vendor = await prisma.user.findUnique({
    where: { id: req.user!.id },
    select: {
      id: true,
      roles: true,
      brandName: true,
      phoneNumber: true,
      kycStatus: true,
      bankName: true,
      bankAccountNumber: true,
      paystackRecipientCode: true,
      vendorStatus: true,
      vendorStatusReason: true,
      vendorStatusChangedAt: true,
      isLive: true,
    },
  });
  if (!vendor) throw new NotFoundError("User");

  const profileDone = !!vendor.brandName && !!vendor.phoneNumber;
  const kycDone = vendor.kycStatus === "VERIFIED";
  const bankDone = !!(vendor.bankName && vendor.bankAccountNumber && vendor.paystackRecipientCode);

  return sendSuccess(
    res,
    {
      status: vendor.vendorStatus,
      reason: vendor.vendorStatusReason,
      statusChangedAt: vendor.vendorStatusChangedAt,
      isLive: vendor.isLive,
      canGoLive: vendor.vendorStatus === "ACTIVE" && kycDone,
      steps: [
        { key: "profile", done: profileDone },
        { key: "kyc", done: kycDone },
        { key: "bank", done: bankDone, required: false },
      ],
    },
    "Vendor onboarding status retrieved",
  );
};
