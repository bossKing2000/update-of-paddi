import prisma from "../lib/prisma";
import { redisProducts } from "../lib/redis";
import { DiscountType, PromotionScope } from "@prisma/client";
import { logger } from "../lib/logger";

// ─────────────────────────────────────────────────────────────────────────────
// Canonical promotion resolution (Bottom Pot marketplace discounts)
//
// THIS is the one authoritative mechanism for determining the effective
// promotion for a product. Home, product detail, cart and checkout must all
// resolve through here (or through `attachPromotions`, which delegates here)
// so the same promotion rules always produce the same effective price.
//
// Two promotion concepts (deliberately separate):
//   1. Automatic product/vendor discount (Promotion.code == null):
//      applies by itself — the product embodies the promotion
//      (₦5,000 → 10% OFF → ₦4,500). No code entry.
//   2. Code-gated campaign (Promotion.code != null): redeemed explicitly via
//      applyPromoService in promoService.ts. That path is unchanged.
//
// Eligibility (existing rules only, no invented business logic):
//   - promotion isActive, within [startsAt, expiresAt]
//   - global usageLimit not exhausted (per-user caps are enforced at
//     redemption time, not display time — display cannot know the viewer)
//   - product not archived
//   - scope matches (SINGLE/SELECTED → product listed; VENDOR_WIDE → same
//     vendor, or platform-wide when vendorId is null — mirroring the
//     platform-wide semantics already in applyPromoService)
//   - type is PERCENTAGE or FIXED (DELIVERY promos discount delivery fees,
//     never product prices)
//   - minOrderAmount is NOT evaluated here: it is a cart-level redemption
//     rule enforced by applyPromoService. Automatic (codeless) promotions
//     are required to use minOrderAmount = 0 at creation so display and
//     cart can never disagree.
//
// NOT gated here (gated elsewhere by existing rules):
//   - vendor live / acceptingOrders → gates orderability (see
//     vendorAvailability.service), never the displayed effective price.
//   - stock / soldOut → a sold-out product keeps its promotion visible;
//     purchase is blocked by the existing availability rules.
//
// INTERIM conflict rule (business ambiguity — see report): the backend
// previously defined no priority for overlapping promotions. Until product
// decides otherwise, resolution is deterministic: a product-specific
// promotion (SINGLE_PRODUCT / SELECTED_PRODUCTS) beats VENDOR_WIDE; ties
// break by larger discount amount, then earlier expiry, then earliest
// created. This rule is documented, tested, and easy to replace.
// ─────────────────────────────────────────────────────────────────────────────

export const ACTIVE_PRODUCT_PROMOS_CACHE_KEY = "promotions:active:product";
export const ACTIVE_PRODUCT_PROMOS_TTL_SECONDS = 60;

const round = (v: number) => Number(v.toFixed(2));

export interface LoadedProductPromo {
  id: string;
  code: string | null;
  type: DiscountType;
  value: number;
  maxDiscount: number | null;
  scope: PromotionScope;
  isActive: boolean;
  startsAt: Date | null;
  expiresAt: Date | null;
  usageLimit: number | null;
  usedCount: number;
  vendorId: string | null;
  createdAt: Date;
  productIds: string[];
}

export interface EffectivePromotion {
  promotionId: string;
  scope: PromotionScope;
  discountType: DiscountType;
  discountValue: number;
  maxDiscount: number | null;
  originalPrice: number;
  discountedPrice: number;
  discountAmount: number;
  /** True only for code-gated campaigns (Promotion.code != null). */
  requiresCode: boolean;
  code: string | null;
  startsAt: Date | null;
  expiresAt: Date | null;
  vendorId: string | null;
}

export interface ResolvableProduct {
  id: string;
  price: number;
  vendorId?: string | null;
  vendor?: { id: string } | null;
  archived?: boolean | null;
}

function productVendorId(p: ResolvableProduct): string | null {
  if (p.vendorId) return p.vendorId;
  if (p.vendor?.id) return p.vendor.id;
  return null;
}

/**
 * The single discount calculation. PERCENTAGE takes value% off, capped so
 * the naira discount never exceeds maxDiscount when set. FIXED subtracts
 * value but never below zero. Everything rounds to 2dp.
 */
export function computeDiscountedPrice(args: {
  type: DiscountType;
  value: number;
  maxDiscount: number | null | undefined;
  originalPrice: number;
}): number {
  const { type, value, maxDiscount, originalPrice } = args;
  if (!(originalPrice > 0)) return round(originalPrice);
  if (type === DiscountType.PERCENTAGE) {
    const raw = (originalPrice * value) / 100;
    const capped = maxDiscount != null ? Math.min(raw, maxDiscount) : raw;
    return round(Math.max(originalPrice - capped, 0));
  }
  if (type === DiscountType.FIXED) {
    return round(Math.max(originalPrice - value, 0));
  }
  // DELIVERY and any future non-price type never discount a product price.
  return round(originalPrice);
}

/** Active + started + not expired + global cap not exhausted. */
export function isPromoInWindow(
  promo: Pick<
    LoadedProductPromo,
    "isActive" | "startsAt" | "expiresAt" | "usageLimit" | "usedCount"
  >,
  now: Date = new Date(),
): boolean {
  if (!promo.isActive) return false;
  if (promo.startsAt && now < promo.startsAt) return false;
  if (promo.expiresAt && now > promo.expiresAt) return false;
  if (promo.usageLimit != null && promo.usedCount >= promo.usageLimit)
    return false;
  return true;
}

function scopeMatches(
  promo: LoadedProductPromo,
  productId: string,
  vendorId: string | null,
): boolean {
  switch (promo.scope) {
    case PromotionScope.SINGLE_PRODUCT:
    case PromotionScope.SELECTED_PRODUCTS:
      return promo.productIds.includes(productId);
    case PromotionScope.VENDOR_WIDE:
    default:
      // Vendor-scoped wide promo matches its own vendor's products;
      // platform-wide (vendorId null) matches every vendor — the same
      // platform semantics applyPromoService already uses.
      return promo.vendorId == null || promo.vendorId === vendorId;
  }
}

/**
 * Resolve the single effective promotion for one product, or null.
 * Pure function over preloaded promos — no DB, no cache. Batch callers
 * should load promos once via loadActiveProductPromos() and reuse them.
 */
export function resolveEffectivePromotionForProduct(args: {
  product: ResolvableProduct;
  promos: LoadedProductPromo[];
  now?: Date;
}): EffectivePromotion | null {
  const { product, promos, now = new Date() } = args;
  if (product.archived === true) return null;
  if (!(product.price > 0)) return null;
  const vendorId = productVendorId(product);

  const eligible = promos.filter(
    (p) =>
      (p.type === DiscountType.PERCENTAGE || p.type === DiscountType.FIXED) &&
      isPromoInWindow(p, now) &&
      scopeMatches(p, product.id, vendorId),
  );
  if (eligible.length === 0) return null;

  const ranked = eligible
    .map((p) => {
      const discountedPrice = computeDiscountedPrice({
        type: p.type,
        value: p.value,
        maxDiscount: p.maxDiscount,
        originalPrice: product.price,
      });
      return { promo: p, discountedPrice, amount: round(product.price - discountedPrice) };
    })
    .filter((c) => c.amount > 0)
    .sort((a, b) => {
      // Product-specific beats vendor-wide (interim rule, see header).
      const aSpecific =
        a.promo.scope === PromotionScope.VENDOR_WIDE ? 1 : 0;
      const bSpecific =
        b.promo.scope === PromotionScope.VENDOR_WIDE ? 1 : 0;
      if (aSpecific !== bSpecific) return aSpecific - bSpecific;
      if (b.amount !== a.amount) return b.amount - a.amount;
      const aExp = a.promo.expiresAt?.getTime() ?? Number.POSITIVE_INFINITY;
      const bExp = b.promo.expiresAt?.getTime() ?? Number.POSITIVE_INFINITY;
      if (aExp !== bExp) return aExp - bExp;
      return a.promo.createdAt.getTime() - b.promo.createdAt.getTime();
    });

  if (ranked.length === 0) return null;
  const winner = ranked[0];
  return {
    promotionId: winner.promo.id,
    scope: winner.promo.scope,
    discountType: winner.promo.type,
    discountValue: winner.promo.value,
    maxDiscount: winner.promo.maxDiscount,
    originalPrice: round(product.price),
    discountedPrice: winner.discountedPrice,
    discountAmount: winner.amount,
    requiresCode: winner.promo.code != null,
    code: winner.promo.code,
    startsAt: winner.promo.startsAt,
    expiresAt: winner.promo.expiresAt,
    vendorId: winner.promo.vendorId,
  };
}

/**
 * Load every promotion that can currently discount a product price.
 * Redis-cached for 60s (best-effort — cache failure falls through to DB,
 * DB failure returns an empty list so discovery degrades to full prices
 * instead of failing the request).
 */
export async function loadActiveProductPromos(): Promise<LoadedProductPromo[]> {
  try {
    const cached = await redisProducts.get(ACTIVE_PRODUCT_PROMOS_CACHE_KEY);
    if (cached) {
      const parsed = JSON.parse(cached) as LoadedProductPromo[];
      return parsed.map((p) => ({
        ...p,
        startsAt: p.startsAt ? new Date(p.startsAt) : null,
        expiresAt: p.expiresAt ? new Date(p.expiresAt) : null,
        createdAt: new Date(p.createdAt),
      }));
    }
  } catch (err) {
    logger.warn({ err }, "active product promos cache read failed");
  }

  let rows: LoadedProductPromo[] = [];
  try {
    const now = new Date();
    const promos = await prisma.promotion.findMany({
      where: {
        isActive: true,
        type: { in: [DiscountType.PERCENTAGE, DiscountType.FIXED] },
        OR: [{ startsAt: null }, { startsAt: { lte: now } }],
        AND: [{ OR: [{ expiresAt: null }, { expiresAt: { gte: now } }] }],
      },
      select: {
        id: true,
        code: true,
        type: true,
        value: true,
        maxDiscount: true,
        scope: true,
        isActive: true,
        startsAt: true,
        expiresAt: true,
        usageLimit: true,
        usedCount: true,
        vendorId: true,
        createdAt: true,
        products: { select: { id: true } },
      },
      orderBy: { createdAt: "asc" },
      take: 500,
    });
    rows = promos
      .filter((p) => p.usageLimit == null || p.usedCount < p.usageLimit)
      .map((p) => ({ ...p, productIds: p.products.map((prod) => prod.id) }));
  } catch (err) {
    logger.warn({ err }, "active product promos DB load failed");
    return [];
  }

  try {
    await redisProducts.set(
      ACTIVE_PRODUCT_PROMOS_CACHE_KEY,
      JSON.stringify(rows),
      { EX: ACTIVE_PRODUCT_PROMOS_TTL_SECONDS },
    );
  } catch (err) {
    logger.warn({ err }, "active product promos cache write failed");
  }
  return rows;
}

/** Drop the cached active-promos list (call after any promo mutation). */
export async function invalidateActiveProductPromosCache(): Promise<void> {
  try {
    await redisProducts.del(ACTIVE_PRODUCT_PROMOS_CACHE_KEY);
  } catch (err) {
    logger.warn({ err }, "active product promos cache invalidation failed");
  }
}

/**
 * Batch-attach the effective promotion to product-like objects.
 * Returns new objects with a `promotion` key (EffectivePromotion | null).
 * This is what product list / detail / feed / search payloads use so every
 * surface exposes the same backend-computed promotion.
 */
export function attachPromotions<T extends ResolvableProduct>(
  items: T[],
  promos: LoadedProductPromo[],
  now: Date = new Date(),
): (T & { promotion: EffectivePromotion | null })[] {
  return items.map((item) => ({
    ...item,
    promotion: resolveEffectivePromotionForProduct({
      product: item,
      promos,
      now,
    }),
  }));
}
