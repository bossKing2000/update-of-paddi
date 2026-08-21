import prisma from "../lib/prisma";
import { DiscountType } from "@prisma/client";

const round = (v: number) => Number(v.toFixed(2));

export interface VendorGroup {
  vendorId: string;
  subtotal: number;
  deliveryFee: number;
}

export interface ApplyPromoInput {
  userId: string;
  promoCode: string;
  vendorGroups: VendorGroup[];
}

export interface PromoResult {
  applied: boolean;
  promoId: string | null;
  promoCode: string;
  discountType: DiscountType | null;
  reason: string | null;
  /** Discount allocated to each vendor's subtotal, keyed by vendorId. */
  vendorDiscounts: Record<string, number>;
  /** Discount allocated to each vendor's delivery fee, keyed by vendorId (only ever non-zero for DELIVERY-type promos). */
  vendorDeliveryDiscounts: Record<string, number>;
  totalDiscount: number;
}

/**
 * Pure discount-calculation core, extracted for independent testing (see
 * tests/unit/promoCalculation.test.ts) — this is the part most prone to
 * subtle bugs (proportional allocation across vendors, capping, rounding).
 */
export function calculateDiscountAllocation(
  type: DiscountType,
  value: number,
  maxDiscount: number | null,
  eligibleGroups: VendorGroup[],
): {
  vendorDiscounts: Record<string, number>;
  vendorDeliveryDiscounts: Record<string, number>;
  totalDiscount: number;
} {
  const vendorDiscounts: Record<string, number> = {};
  const vendorDeliveryDiscounts: Record<string, number> = {};
  let totalDiscount = 0;

  if (type === DiscountType.DELIVERY) {
    for (const group of eligibleGroups) {
      const discount = round(Math.min(value, group.deliveryFee));
      if (discount > 0) {
        vendorDeliveryDiscounts[group.vendorId] = discount;
        totalDiscount += discount;
      }
    }
    return {
      vendorDiscounts,
      vendorDeliveryDiscounts,
      totalDiscount: round(totalDiscount),
    };
  }

  const eligibleSubtotal = round(
    eligibleGroups.reduce((sum, v) => sum + v.subtotal, 0),
  );
  const rawDiscount =
    type === DiscountType.PERCENTAGE
      ? (eligibleSubtotal * value) / 100
      : Math.min(value, eligibleSubtotal);
  const cappedDiscount =
    maxDiscount != null ? Math.min(rawDiscount, maxDiscount) : rawDiscount;

  for (const group of eligibleGroups) {
    const share = eligibleSubtotal > 0 ? group.subtotal / eligibleSubtotal : 0;
    const discount = round(cappedDiscount * share);
    if (discount > 0) {
      vendorDiscounts[group.vendorId] = discount;
      totalDiscount += discount;
    }
  }

  return {
    vendorDiscounts,
    vendorDeliveryDiscounts,
    totalDiscount: round(totalDiscount),
  };
}

function emptyResult(
  promoCode: string,
  reason: string,
  promoId: string | null = null,
  discountType: DiscountType | null = null,
): PromoResult {
  return {
    applied: false,
    promoId,
    promoCode,
    discountType,
    reason,
    vendorDiscounts: {},
    vendorDeliveryDiscounts: {},
    totalDiscount: 0,
  };
}

/**
 * Applies a promo code across a multi-vendor cart. A vendor-scoped promo
 * only discounts that vendor's portion; a platform-wide promo (vendorId
 * null on the Promotion) discounts proportionally across every vendor in
 * the cart, so the per-vendor breakdown still sums correctly to the
 * overall total.
 *
 * This is a read-only preview — it does NOT increment usedCount or
 * create a PromotionUsage record. Actual redemption happens atomically
 * at checkout (see redeemPromo below), so a promo that looked valid at
 * preview time but got exhausted by a concurrent checkout in the
 * meantime is caught rather than silently over-redeemed.
 */
export async function applyPromoService({
  userId,
  promoCode,
  vendorGroups,
}: ApplyPromoInput): Promise<PromoResult> {
  const code = promoCode.trim().toUpperCase();
  if (!code) return emptyResult(promoCode, "No promo code provided");

  const cartVendorIds = vendorGroups.map((v) => v.vendorId);

  // Prefer a vendor-specific match over a platform-wide one sharing the
  // same code text — more specific intent wins.
  const promo =
    (await prisma.promotion.findFirst({
      where: { code, vendorId: { in: cartVendorIds }, isActive: true },
    })) ??
    (await prisma.promotion.findFirst({
      where: { code, vendorId: null, isActive: true },
    }));

  if (!promo) return emptyResult(promoCode, "Promo code not found");

  const now = new Date();
  if (promo.startsAt && now < promo.startsAt)
    return emptyResult(
      code,
      "This promo hasn't started yet",
      promo.id,
      promo.type,
    );
  if (promo.expiresAt && now > promo.expiresAt)
    return emptyResult(code, "This promo has expired", promo.id, promo.type);
  if (promo.usageLimit != null && promo.usedCount >= promo.usageLimit)
    return emptyResult(
      code,
      "This promo has reached its usage limit",
      promo.id,
      promo.type,
    );

  const userUsageCount = await prisma.promotionUsage.count({
    where: { promotionId: promo.id, userId },
  });
  if (userUsageCount >= promo.maxUsesPerUser)
    return emptyResult(
      code,
      "You've already used this promo the maximum number of times",
      promo.id,
      promo.type,
    );

  // Which vendor groups does this promo actually apply to?
  const eligibleGroups = promo.vendorId
    ? vendorGroups.filter((v) => v.vendorId === promo.vendorId)
    : vendorGroups;

  if (eligibleGroups.length === 0) {
    return emptyResult(
      code,
      "This promo doesn't apply to any vendor in your cart",
      promo.id,
      promo.type,
    );
  }

  const eligibleSubtotal = round(
    eligibleGroups.reduce((sum, v) => sum + v.subtotal, 0),
  );
  if (eligibleSubtotal < promo.minOrderAmount) {
    return emptyResult(
      code,
      `This promo requires a minimum order of ₦${promo.minOrderAmount}`,
      promo.id,
      promo.type,
    );
  }

  const { vendorDiscounts, vendorDeliveryDiscounts, totalDiscount } =
    calculateDiscountAllocation(
      promo.type,
      promo.value,
      promo.maxDiscount,
      eligibleGroups,
    );

  if (totalDiscount <= 0)
    return emptyResult(
      code,
      "This promo doesn't apply any discount to your current cart",
      promo.id,
      promo.type,
    );

  return {
    applied: true,
    promoId: promo.id,
    promoCode: promo.code,
    discountType: promo.type,
    reason: null,
    vendorDiscounts,
    vendorDeliveryDiscounts,
    totalDiscount: round(totalDiscount),
  };
}

/**
 * Atomically redeems a promo at checkout: increments usedCount only if
 * still under the limit, in one SQL statement, and records a
 * PromotionUsage. Race-safe against two concurrent checkouts both trying
 * to use the last remaining redemption of a limited promo — Postgres
 * serializes concurrent UPDATEs on the same row, so the second racer's
 * WHERE condition re-evaluates against the already-incremented value and
 * correctly fails to match. Returns false if the promo was exhausted
 * between the cart-summary preview and this checkout attempt.
 */
export async function redeemPromo(
  promoId: string,
  userId: string,
  orderIds: string[],
  promoCode: string,
  discount: number,
): Promise<boolean> {
  const promo = await prisma.promotion.findUnique({
    where: { id: promoId },
    select: { usageLimit: true },
  });
  if (!promo) return false;

  const claimed = await prisma.promotion.updateMany({
    where: {
      id: promoId,
      OR: [
        { usageLimit: null },
        { usedCount: { lt: promo.usageLimit ?? undefined } },
      ],
    },
    data: { usedCount: { increment: 1 } },
  });
  if (claimed.count === 0) return false;

  await prisma.promotionUsage.create({
    data: { promotionId: promoId, userId, orderIds, promoCode, discount },
  });
  return true;
}
