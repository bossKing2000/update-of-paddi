import { Response } from "express";
import crypto from "crypto";
import { z } from "zod";
import prisma from "../lib/prisma";
import { AuthRequest } from "../middlewares/auth.middleware";
import { sendSuccess } from "../utils/apiResponse";
import { ValidationError, NotFoundError, ConflictError } from "../errors/AppError";
import { recordActivityBundle } from "../utils/activityUtils/recordActivityBundle";
import { ActivityType } from "@prisma/client";

function generateReferralCode(name: string): string {
  const prefix = name.replace(/[^A-Za-z]/g, "").slice(0, 5).toUpperCase() || "PADDI";
  const suffix = crypto.randomBytes(3).toString("hex").toUpperCase();
  return `${prefix}${suffix}`;
}

// GET /referrals/my-code — lazily generates one on first request, since
// this feature didn't exist when most accounts were created.
export const getMyReferralCode = async (req: AuthRequest, res: Response) => {
  const user = await prisma.user.findUnique({ where: { id: req.user!.id }, select: { referralCode: true, name: true } });
  if (!user) throw new NotFoundError("User");

  if (user.referralCode) {
    return sendSuccess(res, { referralCode: user.referralCode }, "Referral code retrieved");
  }

  // Retry a couple of times in the vanishingly unlikely event of a
  // collision (unique constraint) with an existing code.
  let code = generateReferralCode(user.name);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const updated = await prisma.user.update({ where: { id: req.user!.id }, data: { referralCode: code } });
      return sendSuccess(res, { referralCode: updated.referralCode }, "Referral code generated");
    } catch {
      code = generateReferralCode(user.name);
    }
  }
  throw new Error("Failed to generate a unique referral code — please try again");
};

const applyReferralSchema = z.object({ code: z.string().min(1) });

// POST /referrals/apply — link the current user to whoever referred them
export const applyReferralCode = async (req: AuthRequest, res: Response) => {
  const parsed = applyReferralSchema.safeParse(req.body);
  if (!parsed.success) throw new ValidationError("A referral code is required");

  const userId = req.user!.id;
  const current = await prisma.user.findUnique({ where: { id: userId }, select: { referredByUserId: true, referralCode: true } });
  if (current?.referredByUserId) throw new ConflictError("You've already used a referral code");

  const code = parsed.data.code.trim().toUpperCase();
  if (current?.referralCode === code) throw new ValidationError("You can't refer yourself");

  const referrer = await prisma.user.findUnique({ where: { referralCode: code }, select: { id: true, name: true } });
  if (!referrer) throw new NotFoundError("Referral code");
  if (referrer.id === userId) throw new ValidationError("You can't refer yourself");

  await prisma.user.update({ where: { id: userId }, data: { referredByUserId: referrer.id } });

  return sendSuccess(res, { referrerName: referrer.name }, "Referral code applied");
};

// GET /referrals/my-rewards
export const getMyReferralRewards = async (req: AuthRequest, res: Response) => {
  const rewards = await prisma.referralReward.findMany({
    where: { referrerId: req.user!.id },
    include: { referred: { select: { id: true, name: true } } },
    orderBy: { createdAt: "desc" },
  });

  const totalEarned = rewards.reduce((sum, r) => sum + r.amount, 0);
  const totalPending = rewards.filter((r) => r.status === "PENDING").reduce((sum, r) => sum + r.amount, 0);

  return sendSuccess(res, { rewards, totalEarned, totalPending }, "Referral rewards retrieved");
};

/**
 * Called from Orders domain (updateOrderStatus) when a customer's order
 * transitions to COMPLETED. Creates a PENDING ReferralReward the first
 * time a referred user completes an order — deliberately does NOT
 * auto-credit any balance, since there's no customer wallet system
 * anywhere else in this app to credit into. An admin settles these
 * manually (same pattern as a vendor payout with no bank details on
 * file: recorded, not silently dropped, reconciled by hand).
 */
export async function creditReferralRewardIfEligible(customerId: string, orderId: string): Promise<void> {
  const rewardAmount = Number(process.env.REFERRAL_REWARD_AMOUNT) || 500;

  const customer = await prisma.user.findUnique({ where: { id: customerId }, select: { referredByUserId: true } });
  if (!customer?.referredByUserId) return;

  const referrerId = customer.referredByUserId;

  const existingReward = await prisma.referralReward.findUnique({ where: { referrerId_referredId: { referrerId, referredId: customerId } } });
  if (existingReward) return; // already credited for this referral relationship

  const priorCompletedOrders = await prisma.order.count({ where: { customerId, status: "COMPLETED", id: { not: orderId } } });
  if (priorCompletedOrders > 0) return; // reward is for the referred user's FIRST completed order only

  await prisma.referralReward.create({ data: { referrerId, referredId: customerId, orderId, amount: rewardAmount } });

  await recordActivityBundle({
    actorId: customerId,
    orderId,
    actions: [
      {
        type: ActivityType.GENERAL,
        title: "Referral Reward Earned",
        message: `Someone you referred completed their first order — you've earned ₦${rewardAmount}.`,
        targetId: referrerId,
        socketEvent: "GENERAL",
        metadata: { referredId: customerId, orderId, amount: rewardAmount },
      },
    ],
    notifyRealtime: true,
    notifyPush: true,
  });
}
