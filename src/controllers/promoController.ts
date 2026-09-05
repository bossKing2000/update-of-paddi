import { Response } from "express";
import { z } from "zod";
import prisma from "../lib/prisma";
import { AuthRequest } from "../middlewares/auth.middleware";
import { DiscountType, PromotionScope } from "@prisma/client";
import { sendSuccess, sendCreated } from "../utils/apiResponse";
import { NotFoundError, ForbiddenError, ValidationError } from "../errors/AppError";
import { ensureString } from "../utils/paramUtils";
import { getActivePromotionsForCustomer } from "../services/promoService";
import { invalidateActiveProductPromosCache } from "../services/promotionPricing.service";
import { invalidateMarketplaceDiscoveryCaches } from "../services/clearCaches";

// Maximum products linkable to one SELECTED_PRODUCTS promotion — bounds the
// relation writes and the discovery payload, not a product decision.
const MAX_SELECTED_PRODUCTS = 50;

const createPromoSchema = z.object({
  // Null/absent code = automatic discount (no code entry). Present code =
  // code-gated campaign. Previously every promotion required a code, which
  // forced ordinary product discounts through copy-paste redemption.
  code: z.string().min(3).max(20).regex(/^[A-Za-z0-9]+$/, "Code must be alphanumeric").optional(),
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  type: z.nativeEnum(DiscountType),
  value: z.number().positive(),
  maxDiscount: z.number().positive().optional(),
  scope: z.nativeEnum(PromotionScope).default(PromotionScope.VENDOR_WIDE),
  productIds: z.array(z.string().min(1)).max(MAX_SELECTED_PRODUCTS).optional().default([]),
  startsAt: z.coerce.date().optional(),
  expiresAt: z.coerce.date().optional(),
  usageLimit: z.number().int().positive().optional(),
  maxUsesPerUser: z.number().int().positive().default(1),
  minOrderAmount: z.number().min(0).default(0),
});

const updatePromoSchema = createPromoSchema.partial();

const validatePromoDatesAndValue = (data: { type?: DiscountType; value?: number; startsAt?: Date; expiresAt?: Date }) => {
  if (data.type === DiscountType.PERCENTAGE && (data.value ?? 0) > 100) {
    throw new ValidationError("Percentage discount can't exceed 100");
  }
  if (data.startsAt && data.expiresAt && data.startsAt >= data.expiresAt) {
    throw new ValidationError("expiresAt must be after startsAt");
  }
};

interface ValidatedScope {
  scope: PromotionScope;
  productIds: string[];
}

/**
 * Scope + product validation shared by create and update.
 *
 * Rules (all enforced so display, cart and checkout can never disagree):
 * - DELIVERY promos discount delivery fees, never product prices, so they
 *   must stay code-gated campaigns scoped VENDOR_WIDE (the only shape
 *   applyPromoService redeems for delivery).
 * - Automatic (codeless) promos must be PERCENTAGE/FIXED with
 *   minOrderAmount = 0 and no usageLimit: cart-level minimums and
 *   redemption caps cannot be evaluated per product at display time, so
 *   allowing them would show a discount the cart could not honor.
 * - SINGLE_PRODUCT needs exactly one vendor-owned, non-archived product;
 *   SELECTED_PRODUCTS needs 1..50; VENDOR_WIDE takes none (it resolves
 *   dynamically against all eligible vendor products, which is also why a
 *   product created after a vendor-wide promo automatically qualifies).
 */
async function validateScopeProducts(
  vendorId: string,
  scope: PromotionScope,
  productIds: string[],
  opts: { code: string | null; type: DiscountType; minOrderAmount: number; usageLimit?: number | null },
): Promise<ValidatedScope> {
  if (opts.type === DiscountType.DELIVERY) {
    if (opts.code == null) {
      throw new ValidationError("Delivery promotions require a promo code — they discount the delivery fee at checkout, not product prices.");
    }
    if (scope !== PromotionScope.VENDOR_WIDE) {
      throw new ValidationError("Delivery promotions must use VENDOR_WIDE scope.");
    }
    if (productIds.length > 0) {
      throw new ValidationError("VENDOR_WIDE promotions do not take productIds — they apply to all eligible products of your store.");
    }
    return { scope, productIds: [] };
  }

  if (opts.code == null) {
    if (opts.minOrderAmount > 0) {
      throw new ValidationError("Automatic (codeless) promotions must use minOrderAmount 0 so the displayed discount always matches the cart. Add a promo code to gate a minimum-order campaign instead.");
    }
    if (opts.usageLimit != null) {
      throw new ValidationError("Automatic (codeless) promotions cannot set usageLimit — redemption caps only apply to code-gated campaigns. Add a promo code to cap redemptions instead.");
    }
  }

  if (scope === PromotionScope.VENDOR_WIDE) {
    if (productIds.length > 0) {
      throw new ValidationError("VENDOR_WIDE promotions do not take productIds — they apply to all eligible products of your store.");
    }
    return { scope, productIds: [] };
  }

  if (scope === PromotionScope.SINGLE_PRODUCT && productIds.length !== 1) {
    throw new ValidationError("SINGLE_PRODUCT promotions require exactly one productId.");
  }
  if (scope === PromotionScope.SELECTED_PRODUCTS && productIds.length < 1) {
    throw new ValidationError("SELECTED_PRODUCTS promotions require at least one productId — select the products this discount covers.");
  }

  const uniqueIds = [...new Set(productIds)];
  const products = await prisma.product.findMany({
    where: { id: { in: uniqueIds } },
    select: { id: true, vendorId: true, archived: true, name: true },
  });
  if (products.length !== uniqueIds.length) {
    throw new ValidationError("One or more selected products do not exist.");
  }
  const foreign = products.find((p) => p.vendorId !== vendorId);
  if (foreign) {
    throw new ValidationError("Promotions can only cover your own products.");
  }
  const archived = products.find((p) => p.archived);
  if (archived) {
    throw new ValidationError(`"${archived.name}" is archived and cannot be promoted. Unarchive it first.`);
  }
  return { scope, productIds: uniqueIds };
}

async function invalidatePromoCaches(): Promise<void> {
  await invalidateActiveProductPromosCache();
  // Discovery payloads (home feed 90s, popular, listings) embed resolved
  // promotions — sweep them so new/edited promos surface promptly.
  try {
    await invalidateMarketplaceDiscoveryCaches();
  } catch {
    // Best-effort: TTLs bound staleness anyway.
  }
}

// POST /promotions — vendor creates a promo scoped to their own store
export const createPromo = async (req: AuthRequest, res: Response) => {
  if (!req.user || req.user.role !== "VENDOR") throw new ForbiddenError("Only vendors can create promotions");

  const parsed = createPromoSchema.safeParse(req.body);
  if (!parsed.success) throw new ValidationError("Invalid promotion", parsed.error.flatten().fieldErrors);
  const data = parsed.data;

  validatePromoDatesAndValue(data);

  const code = data.code ? data.code.toUpperCase() : null;
  if (code) {
    const existing = await prisma.promotion.findUnique({ where: { vendorId_code: { vendorId: req.user.id, code } } });
    if (existing) throw new ValidationError("You already have a promotion with this code");
  }

  const { scope, productIds } = await validateScopeProducts(req.user.id, data.scope, data.productIds ?? [], {
    code,
    type: data.type,
    minOrderAmount: data.minOrderAmount,
    usageLimit: data.usageLimit,
  });

  const promo = await prisma.promotion.create({
    data: {
      code,
      vendorId: req.user.id,
      name: data.name,
      description: data.description,
      type: data.type,
      value: data.value,
      maxDiscount: data.maxDiscount,
      scope,
      products: productIds.length > 0 ? { connect: productIds.map((id) => ({ id })) } : undefined,
      startsAt: data.startsAt,
      expiresAt: data.expiresAt,
      usageLimit: data.usageLimit,
      maxUsesPerUser: data.maxUsesPerUser,
      minOrderAmount: data.minOrderAmount,
    },
    include: { products: { select: { id: true, name: true, thumbnail: true, price: true } } },
  });
  await invalidatePromoCaches();
  return sendCreated(res, { promo }, "Promotion created");
};

// GET /promotions/mine
export const getMyPromos = async (req: AuthRequest, res: Response) => {
  if (!req.user || req.user.role !== "VENDOR") throw new ForbiddenError("Only vendors can view their promotions");

  const promos = await prisma.promotion.findMany({
    where: { vendorId: req.user.id },
    orderBy: { createdAt: "desc" },
    include: { products: { select: { id: true, name: true, thumbnail: true, price: true } } },
  });
  return sendSuccess(res, { promos }, "Your promotions retrieved");
};

// PATCH /promotions/:id/deactivate
export const deactivatePromo = async (req: AuthRequest, res: Response) => {
  const id = ensureString(req.params.id);
  const promo = await prisma.promotion.findUnique({ where: { id } });
  if (!promo || promo.vendorId !== req.user!.id) throw new NotFoundError("Promotion");

  const updated = await prisma.promotion.update({ where: { id }, data: { isActive: false } });
  await invalidatePromoCaches();
  return sendSuccess(res, { promo: updated }, "Promotion deactivated");
};

// PATCH /promotions/:id — vendor edits their own promotion.
export const updatePromo = async (req: AuthRequest, res: Response) => {
  const id = ensureString(req.params.id);
  const promo = await prisma.promotion.findUnique({
    where: { id },
    include: { products: { select: { id: true } } },
  });
  if (!promo || promo.vendorId !== req.user!.id) throw new NotFoundError("Promotion");

  const parsed = updatePromoSchema.safeParse(req.body);
  if (!parsed.success) throw new ValidationError("Invalid promotion", parsed.error.flatten().fieldErrors);
  if (Object.keys(parsed.data).length === 0) throw new ValidationError("Provide at least one field to update");

  const data = { ...parsed.data } as typeof parsed.data & { code?: string | null };
  let code: string | null | undefined;
  if (data.code !== undefined) {
    code = data.code ? data.code.toUpperCase() : null;
    if (code) {
      const duplicate = await prisma.promotion.findUnique({ where: { vendorId_code: { vendorId: req.user!.id, code } } });
      if (duplicate && duplicate.id !== id) throw new ValidationError("You already have a promotion with this code");
    }
  }
  validatePromoDatesAndValue({
    type: data.type ?? promo.type,
    value: data.value ?? Number(promo.value),
    startsAt: data.startsAt ?? promo.startsAt ?? undefined,
    expiresAt: data.expiresAt ?? promo.expiresAt ?? undefined,
  });

  const mergedScope = data.scope ?? promo.scope;
  const mergedProductIds = data.productIds ?? promo.products.map((p) => p.id);
  const mergedType = data.type ?? promo.type;
  const mergedMinOrder = data.minOrderAmount ?? Number(promo.minOrderAmount);
  const mergedUsageLimit = data.usageLimit !== undefined ? data.usageLimit : promo.usageLimit;
  const { scope, productIds } = await validateScopeProducts(req.user!.id, mergedScope, mergedProductIds, {
    code: code !== undefined ? code : promo.code,
    type: mergedType,
    minOrderAmount: mergedMinOrder,
    usageLimit: mergedUsageLimit,
  });

  const { productIds: _omit, ...rest } = data;
  const updated = await prisma.promotion.update({
    where: { id },
    data: {
      ...rest,
      ...(code !== undefined ? { code } : {}),
      scope,
      products: { set: productIds.map((pid) => ({ id: pid })) },
    },
    include: { products: { select: { id: true, name: true, thumbnail: true, price: true } } },
  });
  await invalidatePromoCaches();
  return sendSuccess(res, { promo: updated }, "Promotion updated");
};

// PATCH /promotions/:id/reactivate — vendor re-enables a non-expired promotion.
export const reactivatePromo = async (req: AuthRequest, res: Response) => {
  const id = ensureString(req.params.id);
  const promo = await prisma.promotion.findUnique({ where: { id } });
  if (!promo || promo.vendorId !== req.user!.id) throw new NotFoundError("Promotion");
  if (promo.expiresAt && promo.expiresAt < new Date()) throw new ValidationError("Expired promotions cannot be reactivated; create a new promotion instead");
  const updated = await prisma.promotion.update({ where: { id }, data: { isActive: true } });
  await invalidatePromoCaches();
  return sendSuccess(res, { promo: updated }, "Promotion reactivated");
};

// GET /customer/promotions/active — customer-facing browse. Previously
// there was no way for a customer to discover a promo without already
// knowing its code; every existing route in this file is vendor-only
// (self-management of promos a vendor created). The eligibility checks
// (active, within its date window, not exhausted) live in
// promoService.getActivePromotionsForCustomer, shared with GET /api/home/feed.
export const getActivePromotions = async (req: AuthRequest, res: Response) => {
  const userId = req.user!.id;
  const promotions = await getActivePromotionsForCustomer(userId);

  return sendSuccess(res, { promotions }, "Active promotions retrieved");
};
