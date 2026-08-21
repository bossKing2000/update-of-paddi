import prisma from "../lib/prisma";
import { calculateDeliveryFee } from "./deliveryFee.service";
import { applyPromoService } from "./promoService";

type SummaryInput = {
  userId: string;
  promoCode?: string;
  /** Delivery fee can only be computed once a destination is known. Cart
   * preview (before the customer has picked an address) can be called
   * without this — it just won't have a real delivery fee yet. Checkout
   * always requires one. */
  addressId?: string;
};

export interface CartSummaryItem {
  productId: string;
  name: string;
  image: string | null;
  quantity: number;
  unitPrice: number;
  subtotal: number;
}

export interface CartVendorBreakdown {
  vendorId: string;
  vendorName: string;
  items: CartSummaryItem[];
  subtotal: number;
  discount: number;
  deliveryFee: number;
  deliveryDistanceKm: number | null;
  final: number;
}

export interface CartSummaryResult {
  subtotal: number;
  discount: number;
  deliveryFee: number;
  finalTotal: number;
  promo: { code: string | null; applied: boolean; promoId: string | null; meta: Record<string, unknown> | null };
  vendorBreakdown: CartVendorBreakdown[];
  /** Live items excluded because their vendor hasn't gone live / schedule
   * window hasn't opened yet — these stay in the cart but can't check out. */
  excludedOfflineItemCount: number;
  warnings: string[];
}

const round = (v: number) => Number(v.toFixed(2));

export const cartSummaryService = async ({
  userId,
  addressId,
  promoCode,
}: SummaryInput): Promise<CartSummaryResult> => {
  const cart = await prisma.cart.findFirst({
    where: { customerId: userId },
    include: {
      items: {
        include: {
          product: { include: { vendor: true, productSchedule: true } },
        },
      },
    },
  });

  const empty: CartSummaryResult = {
    subtotal: 0,
    discount: 0,
    deliveryFee: 0,
    finalTotal: 0,
    promo: { code: null, applied: false, promoId: null, meta: { reason: "Cart is empty" } },
    vendorBreakdown: [],
    excludedOfflineItemCount: 0,
    warnings: [],
  };

  if (!cart || cart.items.length === 0) return empty;

  // Only items that are currently purchasable (live + within schedule
  // window + not archived) count toward the summary — mirrors the same
  // live/offline split checkoutCart already applies, so the total shown
  // here always matches what checkout will actually charge.
  const now = new Date();
  const purchasableItems = cart.items.filter((item) => {
    const product = item.product;
    if (product.archived) return false;
    const schedule = product.productSchedule;
    const withinSchedule =
      !schedule || ((!schedule.goLiveAt || schedule.goLiveAt <= now) && (!schedule.takeDownAt || schedule.takeDownAt >= now));
    return product.isLive && withinSchedule;
  });

  const excludedOfflineItemCount = cart.items.length - purchasableItems.length;

  if (purchasableItems.length === 0) {
    return { ...empty, excludedOfflineItemCount, promo: { ...empty.promo, meta: { reason: "No purchasable items" } } };
  }

  const globalBase = round(purchasableItems.reduce((sum, i) => sum + i.unitPrice * i.quantity, 0));

  const grouped = purchasableItems.reduce((acc, item) => {
    const vid = item.product.vendorId;
    if (!acc[vid]) acc[vid] = [];
    acc[vid].push(item);
    return acc;
  }, {} as Record<string, typeof purchasableItems>);

  // Delivery fees — per vendor, since a multi-vendor cart has a separate
  // pickup point (and therefore a separate fee) for each vendor. Only
  // computed once a destination address is known.
  const deliveryFeeByVendor: Record<
    string,
    { fee: number; distanceKm: number | null; withinRange: boolean; freeDelivery: boolean }
  > = {};
  const warnings: string[] = [];

  if (addressId) {
    const vendorIds = Object.keys(grouped);
    await Promise.all(
      vendorIds.map(async (vendorId) => {
        const vendorSubtotal = round(grouped[vendorId].reduce((sum, i) => sum + i.unitPrice * i.quantity, 0));
        const result = await calculateDeliveryFee(vendorId, addressId, vendorSubtotal);
        deliveryFeeByVendor[vendorId] = result;

        if (!result.withinRange) {
          const vendorName = grouped[vendorId][0].product.vendor.name;
          warnings.push(`${vendorName} is outside the delivery range for your address (${result.distanceKm}km away).`);
        }
      })
    );
  }

  const totalDeliveryFee = round(Object.values(deliveryFeeByVendor).reduce((sum, d) => sum + d.fee, 0));

  // Real promo application — previously a documented no-op stub from the
  // Cart phase, since Promotion/PromotionUsage didn't exist yet.
  let promoResult: Awaited<ReturnType<typeof applyPromoService>> | null = null;
  if (promoCode) {
    const vendorGroups = Object.keys(grouped).map((vendorId) => ({
      vendorId,
      subtotal: round(grouped[vendorId].reduce((sum, i) => sum + i.unitPrice * i.quantity, 0)),
      deliveryFee: deliveryFeeByVendor[vendorId]?.fee || 0,
    }));
    promoResult = await applyPromoService({ userId, promoCode, vendorGroups });
    if (!promoResult.applied && promoResult.reason) warnings.push(promoResult.reason);
  }

  const globalDiscount = promoResult?.applied ? promoResult.totalDiscount : 0;
  const deliveryDiscountTotal = promoResult?.applied
    ? round(Object.values(promoResult.vendorDeliveryDiscounts).reduce((sum, d) => sum + d, 0))
    : 0;

  const vendorBreakdown: CartVendorBreakdown[] = Object.keys(grouped).map((vendorId) => {
    const items = grouped[vendorId];
    const subtotal = round(items.reduce((sum, i) => sum + i.unitPrice * i.quantity, 0));
    const deliveryFeeInfo = deliveryFeeByVendor[vendorId];
    const rawDeliveryFee = deliveryFeeInfo?.fee || 0;
    const discount = promoResult?.vendorDiscounts[vendorId] || 0;
    const deliveryDiscount = promoResult?.vendorDeliveryDiscounts[vendorId] || 0;
    const deliveryFee = round(Math.max(rawDeliveryFee - deliveryDiscount, 0));
    const final = round(subtotal - discount + deliveryFee);

    return {
      vendorId,
      vendorName: items[0].product.vendor.name,
      items: items.map((i) => ({
        productId: i.productId,
        name: i.product.name,
        image: i.product.images?.[0] || null,
        quantity: i.quantity,
        unitPrice: round(i.unitPrice),
        subtotal: round(i.unitPrice * i.quantity),
      })),
      subtotal,
      discount,
      deliveryFee,
      deliveryDistanceKm: deliveryFeeInfo?.distanceKm ?? null,
      final,
    };
  });

  const finalTotal = round(globalBase - globalDiscount + totalDeliveryFee - deliveryDiscountTotal);

  return {
    subtotal: globalBase,
    discount: globalDiscount,
    deliveryFee: round(totalDeliveryFee - deliveryDiscountTotal),
    finalTotal,
    promo: {
      code: promoResult?.applied ? promoResult.promoCode : null,
      applied: promoResult?.applied ?? false,
      promoId: promoResult?.applied ? promoResult.promoId : null,
      meta: promoResult ? { discountType: promoResult.discountType, reason: promoResult.reason } : null,
    },
    vendorBreakdown,
    excludedOfflineItemCount,
    warnings,
  };
};
