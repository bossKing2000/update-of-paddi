import prisma from "../lib/prisma";
import { DiscountType, PromotionScope } from "@prisma/client";

const round = (v: number) => Number(v.toFixed(2));

export interface VendorGroup {
  vendorId: string;
  subtotal: number;
  deliveryFee: number;
}

export interface ProductGroup {
  productId: string;
  vendorId: string;
  subtotal: number;
  quantity: number;
  unitPrice: number;
}

export interface ApplyPromoInput {
  userId: string;
  promoCode: string;
  vendorGroups: VendorGroup[];
  productGroups?: ProductGroup[];
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
  /** For product-specific promotions, which products were discounted */
  discountedProductIds?: string[];
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
    discountedProductIds: [],
  };
}

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

export async function applyPromoService({
  userId,
  promoCode,
  vendorGroups,
  productGroups,
}: ApplyPromoInput): Promise<PromoResult> {
  const code = promoCode.trim().toUpperCase();
  if (!code) return emptyResult(promoCode, "No promo code provided");

  const cartVendorIds = vendorGroups.map((v) => v.vendorId);

  // Prefer a vendor-specific match over a platform-wide one sharing the
  // same code text — more specific intent wins.
  const promo =
    (await prisma.promotion.findFirst({
      where: { code, vendorId: { in: cartVendorIds }, isActive: true },
      include: { products: true },
    })) ??
    (await prisma.promotion.findFirst({
      where: { code, vendorId: null, isActive: true },
      include: { products: true },
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

  let eligibleGroups: VendorGroup[];
  let discountedProductIds: string[] = [];

  switch (promo.scope) {
    case PromotionScope.SINGLE_PRODUCT:
    case PromotionScope.SELECTED_PRODUCTS:
      // For product-specific promotions, filter productGroups to only those in the promotion
      if (!productGroups || productGroups.length === 0) {
        return emptyResult(
          code,
          "This promo applies to specific products not in your cart",
          promo.id,
          promo.type,
        );
      }
      const promoProductIds = promo.products.map((p) => p.id);
      const eligibleProductGroups = productGroups.filter((pg) =>
        promoProductIds.includes(pg.productId),
      );
      if (eligibleProductGroups.length === 0) {
        return emptyResult(
          code,
          "None of the eligible products for this promo are in your cart",
          promo.id,
          promo.type,
        );
      }
      // Group by vendor to create vendorGroups for discount allocation
      const vendorMap = new Map<string, { subtotal: number; deliveryFee: number }>();
      for (const pg of eligibleProductGroups) {
        const existing = vendorMap.get(pg.vendorId) || { subtotal: 0, deliveryFee: 0 };
        existing.subtotal += pg.subtotal;
        // Find the delivery fee from vendorGroups
        const vg = vendorGroups.find((v) => v.vendorId === pg.vendorId);
        if (vg) existing.deliveryFee = vg.deliveryFee;
        vendorMap.set(pg.vendorId, existing);
        discountedProductIds.push(pg.productId);
      }
      eligibleGroups = Array.from(vendorMap.entries()).map(([vendorId, data]) => ({
        vendorId,
        subtotal: data.subtotal,
        deliveryFee: data.deliveryFee,
      }));
      break;

    case PromotionScope.VENDOR_WIDE:
    default:
      // Vendor-wide or platform-wide promotion
      eligibleGroups = promo.vendorId
        ? vendorGroups.filter((v) => v.vendorId === promo.vendorId)
        : vendorGroups;
      break;
  }

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
    discountedProductIds,
  };
}

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

// ─────────────────────────────────────────────────────────────────────────────
// Active customer promotions listing (Phase 3A)
//
// Extracted verbatim from promoController.getActivePromotions so that both
// the original endpoint and the new GET /api/home/feed composition share one
// implementation. Read-only: does not touch redemption/usage logic.
// ─────────────────────────────────────────────────────────────────────────────
export async function getActivePromotionsForCustomer(userId: string) {
  const now = new Date();

  const candidates = await prisma.promotion.findMany({
    where: {
      isActive: true,
      OR: [{ startsAt: null }, { startsAt: { lte: now } }],
      AND: [{ OR: [{ expiresAt: null }, { expiresAt: { gte: now } }] }],
    },
    include: {
      vendor: { select: { id: true, brandName: true, brandLogo: true } },
      products: { select: { id: true, name: true, thumbnail: true, price: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 20,
  });

  // Global usage cap not yet exhausted.
  const withinGlobalLimit = candidates.filter(
    (p) => p.usageLimit == null || p.usedCount < p.usageLimit,
  );

  // This customer hasn't personally exhausted their own per-user cap —
  // batched in one groupBy rather than a count-query per candidate.
  const personalUsage = await prisma.promotionUsage.groupBy({
    by: ["promotionId"],
    where: { userId, promotionId: { in: withinGlobalLimit.map((p) => p.id) } },
    _count: { promotionId: true },
  });
  const usedByMe = new Map(personalUsage.map((u) => [u.promotionId, u._count.promotionId]));

  return withinGlobalLimit
    .filter((p) => (usedByMe.get(p.id) ?? 0) < p.maxUsesPerUser)
    .map((p) => ({
      id: p.id,
      code: p.code,
      name: p.name,
      description: p.description,
      type: p.type,
      value: p.value,
      maxDiscount: p.maxDiscount,
      minOrderAmount: p.minOrderAmount,
      expiresAt: p.expiresAt,
      scope: p.scope,
      vendor: p.vendor ? { id: p.vendor.id, name: p.vendor.brandName, logo: p.vendor.brandLogo } : null,
      products: p.products.map((prod) => ({
        id: prod.id,
        name: prod.name,
        thumbnail: prod.thumbnail,
        price: prod.price,
      })),
    }));
}