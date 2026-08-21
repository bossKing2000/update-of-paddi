import axios from "axios";
import { Response } from "express";

import prisma from "../lib/prisma";
import { AuthRequest } from "../middlewares/auth.middleware";
import { handlePrismaError, resolveOnboardingState } from "../controllers/auth.controller";
import config from "../config/config";

// ─────────────────────────────────────────────────────────────────────────────
// VERIFY NIN SERVICE
// POST /api/auth/kyc/verify-nin
// Private route — VENDOR and DELIVERY only.
// ─────────────────────────────────────────────────────────────────────────────
//
// Flow:
// 1. Auth check
// 2. Validate NIN format (Nigerian NIN = exactly 11 digits)
// 3. Role check — only VENDOR and DELIVERY require KYC
// 4. Already-verified short-circuit
// 5. Duplicate-NIN check (one NIN can't back two accounts)
// 6. Verify with Dojah
// 7. Save verification result + flip kycStatus to VERIFIED
// 8. Return updated onboarding state
//
// ─────────────────────────────────────────────────────────────────────────────

export const verifyNINService = async (
  req: AuthRequest,
  res: Response
): Promise<void> => {
  const userId = req.user?.id;
  const userRole = req.user?.role;

  // ── 1. AUTH CHECK ─────────────────────────────
  if (!userId || !userRole) {
    res.status(401).json({ message: "Unauthorized" });
    return;
  }

  // ── 2. VALIDATE INPUT ─────────────────────────
  const { nin } = req.body;

  if (!nin) {
    res.status(400).json({ message: "NIN is required" });
    return;
  }

  if (!/^\d{11}$/.test(nin)) {
    res.status(400).json({ message: "NIN must be exactly 11 digits" });
    return;
  }

  try {
    // ── 3. FETCH CURRENT USER ───────────────────
    const currentUser = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        role: true,
        nin: true,
        kycStatus: true,
        phoneNumber: true,
        brandName: true,
        brandLogo: true,
      },
    });

    if (!currentUser) {
      res.status(404).json({ message: "User not found" });
      return;
    }

    // ── 4. ROLE CHECK ───────────────────────────
    // Only VENDOR and DELIVERY require KYC
    if (currentUser.role !== "VENDOR" && currentUser.role !== "DELIVERY") {
      res.status(403).json({
        message: "KYC verification is not required for this account type",
      });
      return;
    }

    // ── 5. ALREADY VERIFIED CHECK ───────────────
    if (currentUser.kycStatus === "VERIFIED" && currentUser.nin) {
      res.status(409).json({
        message: "KYC already completed",
        onboarding: resolveOnboardingState({
          role: currentUser.role,
          kycStatus: currentUser.kycStatus,
          phoneNumber: currentUser.phoneNumber,
          brandName: currentUser.brandName,
          brandLogo: currentUser.brandLogo,
        }),
      });
      return;
    }

    // ── 6. DUPLICATE NIN CHECK ──────────────────
    // Prevent multiple accounts sharing the same NIN
    const existingNin = await prisma.user.findFirst({
      where: { nin, NOT: { id: userId } },
      select: { id: true },
    });

    if (existingNin) {
      res.status(409).json({
        message: "This NIN is already linked to another account",
      });
      return;
    }

    // ── 7. DOJAH VERIFICATION ───────────────────
    // Defaults to sandbox so a missing DOJAH_BASE_URL never accidentally
    // hits production. Set DOJAH_BASE_URL explicitly to go live.
    const dojahResponse = await axios.post(
      `${config.dojah.baseUrl}/api/v1/kyc/nin/verify`,
      { nin },
      {
        headers: {
          AppId: config.dojah.appId!,
          Authorization: config.dojah.secretKey!,
          "Content-Type": "application/json",
        },
        timeout: 30000,
      }
    );

    const data = dojahResponse.data;

    // ── 8. VALIDATE DOJAH RESPONSE ──────────────
    if (!data || !data.entity) {
      res.status(400).json({ message: "NIN verification failed" });
      return;
    }

    // ── 9. SAVE VERIFIED KYC ────────────────────
    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: {
        nin,
        ninData: data,
        kycStatus: "VERIFIED",
      },
      select: {
        id: true,
        name: true,
        username: true,
        email: true,
        role: true,
        phoneNumber: true,
        avatarUrl: true,
        bio: true,
        preferences: true,
        brandName: true,
        brandLogo: true,
        kycStatus: true,
        updatedAt: true,
      },
    });

    // ── 10. RECOMPUTE ONBOARDING ────────────────
    const onboarding = resolveOnboardingState({
      role: updatedUser.role,
      kycStatus: updatedUser.kycStatus,
      phoneNumber: updatedUser.phoneNumber,
      brandName: updatedUser.brandName,
      brandLogo: updatedUser.brandLogo,
    });

    // ── 11. SUCCESS RESPONSE ────────────────────
    res.status(200).json({
      message: "NIN verified successfully",
      kycStatus: updatedUser.kycStatus,
      onboarding,
      user: updatedUser,
      verification: {
        ninVerified: true,
        provider: "DOJAH",
      },
    });
  } catch (error: any) {
    // ── DOJAH API ERRORS ────────────────────────
    if (axios.isAxiosError(error)) {
      console.error("Dojah verification error:", error.response?.data || error.message);

      const providerMessage = error.response?.data?.error || error.response?.data?.message;

      res.status(400).json({ message: providerMessage || "NIN verification failed" });
      return;
    }

    // ── DATABASE / SERVER ERRORS ────────────────
    handlePrismaError(error, res);
  }
};
