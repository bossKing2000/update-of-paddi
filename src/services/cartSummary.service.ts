import prisma from "../lib/prisma";
import { calculateDeliveryFee } from "./deliveryFee.service";
import { applyPromoService } from "./promoService";
import {
  loadActiveProductPromos,
  resolveEffectivePromotionForProduct,
} from "./promotionPricing.service";
import { isProductCurrentlyAvailable, isVendorOperating } from "./vendorAvailability.service";

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
  /** Fresh base unit (product price + selected add-ons) before automatic
   * promotion discounts. Equals unitPrice for carts quoted before any
   * promotion existed. */
  originalUnitPrice: number;
  /** Server-authoritative effective unit after automatic promotions. */
  effectiveUnitPrice: number;
  /** Per-unit automatic saving (original - effective, never negative). */
  unitDiscount: number;
  /** Promotion driving the automatic discount, if any. */
  promotionId: string | null;
}

export interface CartVendorBreakdown {
  vendorId: string;
  vendorName: string;
  items: CartSummaryItem[];
  subtotal: number;
  discount: number;
  /** Automatic product-promotion discount slice of `discount`. */
  autoDiscount: number;
  /** Code-promo discount slice of `discount`. */
  codeDiscount: number;
  deliveryFee: number;
  deliveryDistanceKm: number | null;
  final: number;
}

export interface CartSummaryResult {
  subtotal: number;
  discount: number;
  /** Automatic product-promotion savings (no code required). */
  autoDiscount: number;
  /** Code-gated promo savings (only when a promoCode was supplied). */
  codeDiscount: number;
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
          product: { include: { vendor: true } },
          options: true,
        },
      },
    },
  });

  const empty: CartSummaryResult = {
    subtotal: 0,
    discount: 0,
    autoDiscount: 0,
    codeDiscount: 0,
    deliveryFee: 0,
    finalTotal: 0,
    promo: { code: null, applied: false, promoId: null, meta: { reason: "Cart is empty" } },
    vendorBreakdown: [],
    excludedOfflineItemCount: 0,
    warnings: [],
  };

  if (!cart || cart.items.length === 0) return empty;

  // Only items that are currently marketplace-available count toward the
  // summary — mirrors the exact availability split checkoutCart applies
  // (vendor live + accepting orders AND product not archived + in stock),
  // so the total shown here always matches what checkout will actually
  // charge.
  const purchasableItems = cart.items.filter((item) => {
    const product = item.product;
    if (product.archived) return false;
    const vendorOperating = isVendorOperating(item.product.vendor as {
      isLive: boolean;
      deliveryPreferences?: unknown;
    });
    return (
      vendorOperating &&
      isProductCurrentlyAvailable({
        archived: product.archived,
        trackInventory: product.trackInventory,
        stock: product.stock,
      })
    );
  });

  const excludedOfflineItemCount = cart.items.length - purchasableItems.length;

  if (purchasableItems.length === 0) {
    return { ...empty, excludedOfflineItemCount, promo: { ...empty.promo, meta: { reason: "No purchasable items" } } };
  }

  // Automatic product promotions (canonical resolver): the same effective
  // price Home and product detail show. Resolved once here and reused for
  // every line, so cart math can never drift from display math.
  const activePromos = await loadActiveProductPromos();

  const pricedLines = purchasableItems.map((item) => {
    const storedUnit = round(item.unitPrice);
    const optionsTotal = round(
      ((item as { options?: { price: number }[] }).options ?? []).reduce(
        (sum, o) => sum + Number(o.price ?? 0),
        0,
      ),
    );
    // Fresh base product price from the database; falls back to the stored
    // quote minus add-ons when the product row is unavailable (tests,
    // stale includes) so pricing degrades to "no automatic discount"
    // instead of crashing.
    const productPrice =
      typeof item.product.price === "number"
        ? round(item.product.price)
        : round(Math.max(storedUnit - optionsTotal, 0));
    const effective = resolveEffectivePromotionForProduct({
      product: {
        id: item.productId,
        price: productPrice,
        vendorId: item.product.vendorId,
        archived: item.product.archived,
      },
      promos: activePromos,
    });
    const effectiveBase = effective ? effective.discountedPrice : productPrice;
    const effectiveUnit = round(effectiveBase + optionsTotal);
    const originalUnit = round(productPrice + optionsTotal);
    const unitDiscount = round(Math.max(storedUnit - effectiveUnit, 0));
    return { item, storedUnit, optionsTotal, effectiveUnit, originalUnit, unitDiscount, effective };
  });

  const globalBase = round(pricedLines.reduce((sum, l) => sum + l.storedUnit * l.item.quantity, 0));
  const globalAutoDiscount = round(
    pricedLines.reduce((sum, l) => sum + l.unitDiscount * l.item.quantity, 0),
  );

  const grouped = purchasableItems.reduce((acc, item) => {
    const vid = item.product.vendorId;
    if (!acc[vid]) acc[vid] = [];
    acc[vid].push(item);
    return acc;
  }, {} as Record<string, typeof purchasableItems>);
  const lineByItemId = new Map(pricedLines.map((l) => [l.item.id, l]));

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

  // --- RULE 3: Single best discount (auto OR code, never both) ---
  // 1. Automatic discounts already computed above (globalAutoDiscount, per-line
  //    effectiveUnit, autoDiscount per vendor).
  // 2. If a promo code is supplied, compute code discount on ORIGINAL prices
  //    (the stored unitPrice before auto discounts) so the two discount paths
  //    are comparable. The code discount is evaluated on the same subtotal
  //    basis but without auto discounts already applied.
  // 3. Compare total auto discount vs total code discount and pick the single
  //    best source. The winning source's pricing is used everywhere downstream.

  // Prepare original-price product groups for code discount evaluation.
  const originalPriceProductGroups = purchasableItems.map((i) => ({
    productId: i.productId,
    vendorId: i.product.vendorId,
    subtotal: round((lineByItemId.get(i.id)?.originalUnit ?? round(i.unitPrice)) * i.quantity),
    quantity: i.quantity,
    unitPrice: lineByItemId.get(i.id)?.originalUnit ?? round(i.unitPrice),
  }));

  // Also prepare original-price vendor groups for code discount.
  const originalVendorGroups = Object.keys(grouped).map((vendorId) => ({
    vendorId,
    subtotal: round(
      grouped[vendorId].reduce(
        (sum, i) => sum + (lineByItemId.get(i.id)?.originalUnit ?? round(i.unitPrice)) * i.quantity,
        0,
      ),
    ),
    deliveryFee: deliveryFeeByVendor[vendorId]?.fee || 0,
  }));

  // Compute code discount on ORIGINAL prices (if promo code supplied).
  let promoResult: Awaited<ReturnType<typeof applyPromoService>> | null = null;
  if (promoCode) {
    promoResult = await applyPromoService({ userId, promoCode, vendorGroups: originalVendorGroups, productGroups: originalPriceProductGroups });
    if (!promoResult.applied && promoResult.reason) warnings.push(promoResult.reason);
  }

  const globalCodeDiscount = promoResult?.applied ? promoResult.totalDiscount : 0;

  // Pick the single best discount source: automatic OR code, never both.
  const autoWins = globalAutoDiscount >= globalCodeDiscount;
  const winningAutoDiscount = autoWins ? globalAutoDiscount : 0;
  const winningCodeDiscount = autoWins ? 0 : globalCodeDiscount;
  const globalDiscount = round(winningAutoDiscount + winningCodeDiscount);

  // Delivery discount only applies if code discount wins (auto discounts
  // never apply to delivery fees).
  const deliveryDiscountTotal = !autoWins && promoResult?.applied
    ? round(Object.values(promoResult.vendorDeliveryDiscounts).reduce((sum, d) => sum + d, 0))
    : 0;

  // For vendor breakdown, pick the winning discount per vendor.
  const vendorBreakdown: CartVendorBreakdown[] = Object.keys(grouped).map((vendorId) => {
    const items = grouped[vendorId];
    const subtotal = round(items.reduce((sum, i) => sum + i.unitPrice * i.quantity, 0));
    const autoDiscount = round(
      items.reduce((sum, i) => {
        const line = lineByItemId.get(i.id);
        return sum + (line ? line.unitDiscount * i.quantity : 0);
      }, 0),
    );
    const deliveryFeeInfo = deliveryFeeByVendor[vendorId];
    const rawDeliveryFee = deliveryFeeInfo?.fee || 0;
    const codeDiscount = !autoWins ? (promoResult?.vendorDiscounts[vendorId] || 0) : 0;
    const discount = round(autoWins ? autoDiscount : codeDiscount);
    const deliveryDiscount = !autoWins ? (promoResult?.vendorDeliveryDiscounts[vendorId] || 0) : 0;
    const deliveryFee = round(Math.max(rawDeliveryFee - deliveryDiscount, 0));
    const final = round(subtotal - discount + deliveryFee);

    return {
      vendorId,
      vendorName: items[0].product.vendor.name,
      items: items.map((i) => {
        const line = lineByItemId.get(i.id);
        // If code wins, effective price = original - code discount share;
        // but for line items we just store the winning discount's effective price.
        const effectiveUnit = autoWins ? (line?.effectiveUnit ?? round(i.unitPrice)) : round(i.unitPrice); // code discount is at order level, not per-line
        const originalUnit = line?.originalUnit ?? round(i.unitPrice);
        const unitDiscount = autoWins ? (line?.unitDiscount ?? 0) : (codeDiscount > 0 ? round(codeDiscount * (i.unitPrice * i.quantity) / Math.max(subtotal, 1)) : 0);
        return {
          productId: i.productId,
          name: i.product.name,
          image: i.product.images?.[0] || null,
          quantity: i.quantity,
          unitPrice: round(i.unitPrice),
          subtotal: round(i.unitPrice * i.quantity),
          originalUnitPrice: originalUnit,
          effectiveUnitPrice: effectiveUnit,
          unitDiscount,
          promotionId: autoWins ? (line?.effective?.promotionId ?? null) : (promoResult?.promoId ?? null),
        };
      }),
      subtotal,
      discount,
      autoDiscount: autoWins ? autoDiscount : 0,
      codeDiscount: autoWins ? 0 : codeDiscount,
      deliveryFee,
      deliveryDistanceKm: deliveryFeeInfo?.distanceKm ?? null,
      final,
    };
  });

  const finalTotal = round(globalBase - globalDiscount + totalDeliveryFee - deliveryDiscountTotal);

  return {
    subtotal: globalBase,
    discount: globalDiscount,
    autoDiscount: winningAutoDiscount,
    codeDiscount: winningCodeDiscount,
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
