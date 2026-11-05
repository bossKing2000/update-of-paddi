import { Response } from "express";
import { v4 as uuidv4 } from "uuid";
import { AuthRequest } from "../middlewares/auth.middleware";
import prisma from "../lib/prisma";
import { OrderStatus } from "@prisma/client";
import { createAuditLog } from "../utils/auditLog.service";
import { addToCartSchema, updateCartItemSchema } from "../validations/cartSchema";
import { z } from "zod";
import { ShopCartRedis } from "../lib/redis";
import { sendSuccess, sendCreated, toJsonSafe, koboToNaira } from "../utils/apiResponse";import { AppError, NotFoundError, ForbiddenError, ValidationError, ConflictError, UnprocessableEntityError } from "../errors/AppError";
import { cartSummaryService } from "../services/cartSummary.service";
import {
  loadActiveProductPromos,
  resolveEffectivePromotionForProduct,
} from "../services/promotionPricing.service";
import {
  isProductCurrentlyAvailable,
  isVendorOperating,
  loadVendorOperatingState,
  assertVendorAvailableForOrdering,
} from "../services/vendorAvailability.service";
import {
  assertQuantityAvailable,
  reserveStockForItems,
} from "../services/inventory.service";
import {
  claimCheckoutKey,
  completeCheckoutKey,
  releaseCheckoutKey,
  checkoutPayloadHash,
} from "../services/checkoutIdempotency.service";
import { clearProductCache } from "../services/clearCaches";
import {
  buildOrderMoneySnapshot,
  resolveCommissionRate,
} from "../services/orderSnapshot.service";
import { logger } from "../lib/logger";
import { DateTime } from "luxon";
import {
  LAGOS_TZ,
  parseScheduledAt,
  validateCutOff,
  lagosDayStart,
  reserveDailyCap,
  releaseDailyCap,
} from "../services/scheduling.service";

// Normalize Express params/query values to string
function ensureString(v: any): string {
  if (v === undefined || v === null) return "";
  return Array.isArray(v) ? v[0] : String(v);
}

const CART_TTL_SECONDS = 3600; // 1 hour
const MAX_SNAPSHOT_AGE_MS = 30 * 60 * 1000; // 30 minutes
// F-2.17: versioned cart cache key. Readers ignore old `cart:user:<id>`
// entries, which expire naturally via CART_TTL_SECONDS. The existing
// `cart:user:` maintenance sweep still matches both old and new formats.
const CART_CACHE_VERSION = "v2";
const cartCacheKey = (userId: string) => `cart:user:${CART_CACHE_VERSION}:${userId}`;
const round = (v: number) => Number(v.toFixed(2));

// Helper: Calculate cart totals (base = total; discounts happen at
// checkout-summary time via cartSummaryService, not stored on the cart).
const calculateCartTotals = (items: Array<{ unitPrice: number; quantity: number }>) => {
  const basePrice = round(items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0));
  return { basePrice, totalPrice: basePrice };
};

type CartOptionRow = {
  productOptionId: string | null;
  optionGroupItemId: string | null;
  name: string;
  price: number;
};

// Phase 2B.4b: line identity is representation-aware. A new-authority line
// and a legacy-authority line never match, even if UUIDs collided across
// tables; option order never affects identity (sorted comparison).
function lineSelection(options: Pick<CartOptionRow, "productOptionId" | "optionGroupItemId">[]): {
  kind: "empty" | "legacy" | "new" | "mixed";
  ids: string[];
} {
  if (options.length === 0) return { kind: "empty", ids: [] };
  const legacy = options.filter((o) => o.productOptionId != null);
  const neo = options.filter((o) => o.optionGroupItemId != null);
  if (neo.length > 0 && legacy.length === 0)
    return { kind: "new", ids: neo.map((o) => o.optionGroupItemId as string).sort() };
  if (legacy.length > 0 && neo.length === 0)
    return { kind: "legacy", ids: legacy.map((o) => o.productOptionId as string).sort() };
  return { kind: "mixed", ids: [] };
}

interface ResolvedNewSelection {
  snapshots: Array<{ optionGroupItemId: string; name: string; price: number }>;
  optionsPrice: number;
}

// Shape returned by `prisma.optionGroup.findMany({ include: { items: true } })`.
type CheckoutOptionGroup = {
  id: string;
  productId: string;
  name: string;
  required: boolean;
  minSelections: number;
  maxSelections: number;
  sortOrder: number;
  items: Array<{ id: string; name: string; priceAdd: number; isActive: boolean }>;
};

// Phase 2B.4b: authoritative validation for new-authority selections.
// Every rule is enforced against live PostgreSQL rows (never Redis, never
// client input): ownership chain, active state, per-group min/max
// completeness across ALL of the product's groups, duplicates.
async function resolveNewOptionSelection(
  productId: string,
  itemIds: string[],
  preloadedGroups?: CheckoutOptionGroup[],
): Promise<ResolvedNewSelection> {
  if (new Set(itemIds).size !== itemIds.length)
    throw new ValidationError("Duplicate option selection");

  // No empty shortcut: an explicit [] must still satisfy required groups.
  // `preloadedGroups` lets checkout batch the fetch across all cart lines
  // instead of issuing one query per line; an empty array means "this
  // product has no groups" (already known, so no query is issued).
  const groups =
    preloadedGroups ??
    (await prisma.optionGroup.findMany({
      where: { productId },
      include: { items: true },
    }));
  const itemById = new Map<string, { id: string; name: string; priceAdd: number; isActive: boolean; optionGroupId: string }>();
  for (const group of groups) {
    for (const item of group.items) itemById.set(item.id, { ...item, optionGroupId: group.id });
  }

  const invalid = itemIds.filter((id) => !itemById.has(id));
  if (invalid.length > 0) {
    throw new ValidationError("One or more selected extras are no longer available", { invalidOptions: invalid });
  }
  const selected = itemIds.map((id) => itemById.get(id)!);
  const inactive = selected.filter((item) => !item.isActive);
  if (inactive.length > 0) {
    throw new ValidationError("One or more selected extras are no longer available", {
      invalidOptions: inactive.map((item) => item.id),
    });
  }

  // Completeness: every group of the product is checked, so required
  // groups cannot be bypassed by omission.
  const selectedByGroup = new Map<string, number>();
  for (const item of selected) {
    selectedByGroup.set(item.optionGroupId, (selectedByGroup.get(item.optionGroupId) ?? 0) + 1);
  }
  for (const group of groups) {
    const count = selectedByGroup.get(group.id) ?? 0;
    if (count < group.minSelections || count > group.maxSelections) {
      throw new ValidationError(
        `Option group "${group.name}" requires between ${group.minSelections} and ${group.maxSelections} selections`,
        { optionGroupId: group.id },
      );
    }
  }

  const snapshots = selected.map((item) => ({
    optionGroupItemId: item.id,
    name: item.name,
    price: item.priceAdd,
  }));
  const optionsPrice = selected.reduce((sum, item) => sum + Number(item.priceAdd), 0);
  return { snapshots, optionsPrice };
}

// GET /cart - Get current cart
export const getCart = async (req: AuthRequest, res: Response) => {
  const userId = req.user!.id;
  const cacheKey = cartCacheKey(userId);

  try {
    const cachedCart = await ShopCartRedis.get(cacheKey);
    if (cachedCart) {
      return sendSuccess(res, JSON.parse(cachedCart), "Cart retrieved successfully (cache)");
    }
  } catch (err) {
    logger.warn({ err, cacheKey }, "ShopCartRedis.get failed (best-effort, will load from DB)");
  }

  const cart = await prisma.cart.findFirst({
    where: { customerId: userId },
    include: {
      items: {
        include: {
          product: { include: { options: true, vendor: { select: { id: true, name: true } } } },
          options: { include: { productOption: true } },
        },
      },
    },
  });

  const enrichedCart = cart ? await getEnhancedCart(cart.id) : { id: null, items: [], basePrice: 0, totalPrice: 0 };

  if (enrichedCart && enrichedCart.items.length > 0) {
    try {
      await ShopCartRedis.set(cacheKey, JSON.stringify(enrichedCart), { EX: CART_TTL_SECONDS });
    } catch (err) {
      logger.warn({ err, cacheKey }, "ShopCartRedis.set failed (best-effort)");
    }
  }

  return sendSuccess(res, enrichedCart, "Cart retrieved successfully");
};

// POST /cart/items - Add item to cart
export const addToCart = async (req: AuthRequest, res: Response) => {
  const parsed = addToCartSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new ValidationError("Invalid cart item", parsed.error.flatten().fieldErrors);
  }

  const { productId, quantity = 1, selectedOptions = [], specialRequest } = parsed.data;
  // Presence (not emptiness) selects the new authority; default [] would
  // force a group load on every legacy add.
  const optionGroupItemIds = parsed.data.optionGroupItemIds;

  const product = await prisma.product.findUnique({
    where: { id: productId },
    include: { options: { where: { isActive: true } } },
  });
  if (!product) throw new NotFoundError("Product");
  if (product.archived) throw new ValidationError("Product is no longer available");

  // Phase 1B self-dealing guard: a vendor cannot buy their own product,
  // even while operating in CUSTOMER mode.
  if (product.vendorId === req.user!.id)
    throw new ForbiddenError("You cannot purchase from your own store.");

  // Availability gate — a product can only be ADDED to a cart while its
  // vendor is live + accepting orders and the product itself is not
  // archived and in stock.
  const vendorState = await loadVendorOperatingState(product.vendorId);
  assertVendorAvailableForOrdering(vendorState);
  if (
    !isProductCurrentlyAvailable({
      archived: product.archived,
      trackInventory: product.trackInventory,
      stock: product.stock,
    })
  ) {
    throw new ValidationError("This product is not currently available for ordering.");
  }

  // Add-ons must exist, belong to this product, and still be enabled.
  // Prices always come from the database — never the client.
  const invalidOptions = selectedOptions.filter(
    (id: string) => !product.options.some((o) => o.id === id),
  );
  if (invalidOptions.length > 0) {
    throw new ValidationError("One or more selected extras are no longer available", { invalidOptions });
  }

  // Phase 2B.4b: new-authority selections via explicit optionGroupItemIds.
  // One line carries exactly one representation — mixing legacy and new
  // ids is rejected (the CHECK constraint could not store it anyway).
  // Legacy ids are never reinterpreted as group-item ids and vice versa.
  // Key presence (not emptiness) selects the authority, so an explicit []
  // still validates required groups instead of slipping through.
  const wantsNewOptions = optionGroupItemIds !== undefined;
  let newSelection: ResolvedNewSelection | null = null;
  if (selectedOptions.length > 0 && (optionGroupItemIds ?? []).length > 0) {
    throw new ValidationError("Use either selectedOptions or optionGroupItemIds, not both");
  }
  if (wantsNewOptions) {
    newSelection = await resolveNewOptionSelection(productId, optionGroupItemIds ?? []);
  }

  let cart = await prisma.cart.findFirst({
    where: { customerId: req.user!.id },
    include: { items: { include: { options: true } } },
  });

  if (!cart) {
    cart = await prisma.cart.create({
      data: { customerId: req.user!.id },
      include: { items: { include: { options: true } } },
    });
  }

  const optionsPrice = newSelection
    ? newSelection.optionsPrice
    : product.options
        .filter((o) => selectedOptions.includes(o.id))
        .reduce((sum, o) => sum + o.price, 0);
  // Stored quotes are promotion-aware: an active automatic discount lowers
  // the quoted unit price at add time (canonical resolver — the same price
  // Home and product detail show). Checkout revalidates against the live
  // effective price, so a deal starting/ending afterwards surfaces as a
  // refreshable pricing change, never a silent over/under-charge.
  const activePromos = await loadActiveProductPromos();
  const effectivePromo = resolveEffectivePromotionForProduct({
    product: {
      id: product.id,
      price: product.price,
      vendorId: product.vendorId,
      archived: product.archived,
    },
    promos: activePromos,
  });
  const effectiveBase = effectivePromo ? effectivePromo.discountedPrice : product.price;
  const unitPrice = effectiveBase + optionsPrice;

  // Match by product + selected options combo, not just productId — two
  // cart lines for the same product with different options (e.g. "no
  // spice" vs "extra spice") are genuinely different line items and must
  // not get merged into one. Matching by productId alone (the previous
  // behavior) silently overwrote the first line's options/price whenever
  // the same product was added again with a different option selection.
  // Identity is representation-aware: legacy and new-authority lines never
  // match each other, and id order never affects identity (sorted compare).
  const requestedIds =
    newSelection != null
      ? newSelection.snapshots.map((s) => s.optionGroupItemId)
      : [...selectedOptions];
  const requestedSelection = {
    kind: (requestedIds.length === 0 ? "empty" : newSelection != null ? "new" : "legacy") as
      | "empty"
      | "new"
      | "legacy",
    ids: [...requestedIds].sort(),
  };
  const existingItem = cart.items.find((item) => {
    const line = lineSelection(item.options);
    if (requestedSelection.ids.length === 0 && line.ids.length === 0)
      return item.productId === productId;
    return (
      item.productId === productId &&
      line.kind === requestedSelection.kind &&
      JSON.stringify(line.ids) === JSON.stringify(requestedSelection.ids)
    );
  });

  if (existingItem) {
    const newQty = existingItem.quantity + quantity;
    const MAX_QTY = Number(process.env.MAX_CART_ITEM_QTY) || 99;
    if (newQty > MAX_QTY) {
      throw new ValidationError(`Quantity exceeds maximum allowed (${MAX_QTY})`, { maxQty: MAX_QTY, requested: newQty }, "VALIDATION_ERROR");
    }
    assertQuantityAvailable({
      productId,
      productName: product.name,
      quantity: newQty,
      trackInventory: product.trackInventory,
      stock: product.stock,
    });
    await prisma.cartItem.update({
      where: { id: existingItem.id },
      data: {
        quantity: newQty,
        unitPrice,
        subtotal: round(unitPrice * newQty),
        specialRequest: specialRequest ?? existingItem.specialRequest,
      },
    });
  } else {
    assertQuantityAvailable({
      productId,
      productName: product.name,
      quantity,
      trackInventory: product.trackInventory,
      stock: product.stock,
    });
    await prisma.cartItem.create({
      data: {
        cartId: cart.id,
        productId,
        quantity,
        unitPrice,
        subtotal: round(unitPrice * quantity),
        specialRequest,
        // New-authority rows carry optionGroupItemId with productOptionId
        // NULL (exactly-one CHECK); legacy rows keep the legacy shape.
        // No dual-write, no shadow ProductOptions.
        options: {
          create:
            newSelection != null
              ? newSelection.snapshots.map((s) => ({
                  optionGroupItemId: s.optionGroupItemId,
                  name: s.name,
                  price: s.price,
                }))
              : selectedOptions.map((id: string) => {
                  const opt = product.options.find((o) => o.id === id)!;
                  return { productOptionId: id, name: opt.name, price: opt.price };
                }),
        },
      },
    });
  }

  const updatedItems = await prisma.cartItem.findMany({ where: { cartId: cart.id } });
  await prisma.cart.update({ where: { id: cart.id }, data: calculateCartTotals(updatedItems) });

  const enhancedCart = await getEnhancedCart(cart.id);
  const cacheKey = cartCacheKey(req.user!.id);
  try {
    await ShopCartRedis.set(cacheKey, JSON.stringify(enhancedCart), { EX: CART_TTL_SECONDS });
  } catch (err) {
    logger.warn({ err, cacheKey }, "ShopCartRedis.set failed (best-effort)");
  }

  return sendCreated(res, enhancedCart, "Item added to cart successfully");
};

// PATCH /cart/items/:itemId - Update cart item
export const updateCartItem = async (req: AuthRequest, res: Response) => {
  const itemId = ensureString(req.params.itemId);

  const parsed = updateCartItemSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new ValidationError("Invalid update payload", parsed.error.flatten().fieldErrors);
  }
  const { quantity, selectedOptions, optionGroupItemIds, specialRequest } = parsed.data;

  const item = await prisma.cartItem.findFirst({
    where: { id: itemId, cart: { customerId: req.user!.id } },
    include: {
      cart: true,
      product: { include: { options: { where: { isActive: true } } } },
      options: true,
    },
  });

  if (!item) throw new NotFoundError("Cart item");

  if (selectedOptions) {
    const invalidOptions = selectedOptions.filter(
      (optId: string) => !item.product.options.some((opt) => opt.id === optId),
    );
    if (invalidOptions.length > 0) {
      throw new ValidationError("One or more selected extras are no longer available", { invalidOptions });
    }
  }

  // Phase 2B.4b: one representation per request — mixing is rejected, and
  // new-authority selections are validated against live OptionGroups.
  // Existing lines keep their representation unless explicitly replaced.
  const wantsLegacy = selectedOptions !== undefined;
  const wantsNew = optionGroupItemIds !== undefined;
  if (wantsLegacy && wantsNew && selectedOptions.length > 0 && (optionGroupItemIds ?? []).length > 0) {
    throw new ValidationError("Use either selectedOptions or optionGroupItemIds, not both");
  }
  let newSelection: ResolvedNewSelection | null = null;
  if (wantsNew) {
    newSelection = await resolveNewOptionSelection(item.productId, optionGroupItemIds ?? []);
  }

  const updateData: Record<string, unknown> = {};
  if (quantity !== undefined) updateData.quantity = quantity;
  if (specialRequest !== undefined) updateData.specialRequest = specialRequest;

  if (quantity !== undefined || selectedOptions || optionGroupItemIds) {
    // Quantity-only updates on new-authority lines reprice from their own
    // snapshots (legacy lookup would see null FKs and drop surcharges).
    const line = lineSelection(item.options);
    const finalOptions = selectedOptions ?? item.options.map((opt) => opt.productOptionId);
    const optionsPrice =
      newSelection != null
        ? newSelection.optionsPrice
        : line.kind === "new" && !wantsLegacy
          ? item.options.reduce((sum, opt) => sum + Number(opt.price), 0)
          : item.product.options
              .filter((opt) => finalOptions.includes(opt.id))
              .reduce((sum, opt) => sum + opt.price, 0);

    // Same promotion-aware quoting as addToCart (see above).
    const updatePromos = await loadActiveProductPromos();
    const updateEffective = resolveEffectivePromotionForProduct({
      product: {
        id: item.product.id,
        price: item.product.price,
        vendorId: item.product.vendorId,
        archived: item.product.archived,
      },
      promos: updatePromos,
    });
    const updateBase = updateEffective ? updateEffective.discountedPrice : item.product.price;
    const unitPrice = updateBase + optionsPrice;
    const qty = quantity ?? item.quantity;

    assertQuantityAvailable({
      productId: item.productId,
      productName: item.product.name,
      quantity: qty,
      trackInventory: item.product.trackInventory,
      stock: item.product.stock,
    });

    updateData.unitPrice = unitPrice;
    updateData.subtotal = round(unitPrice * qty);
  }

  await prisma.cartItem.update({ where: { id: itemId }, data: updateData });

  // An explicit key (even []) replaces the line's options; absence leaves
  // them untouched. New-authority rows store optionGroupItemId with
  // productOptionId NULL — never both, never neither-when-nonempty.
  if (wantsNew && newSelection != null) {
    await prisma.cartItemOption.deleteMany({ where: { cartItemId: itemId } });
    if (newSelection.snapshots.length > 0) {
      await prisma.cartItemOption.createMany({
        data: newSelection.snapshots.map((s) => ({
          cartItemId: itemId,
          optionGroupItemId: s.optionGroupItemId,
          name: s.name,
          price: s.price,
        })),
      });
    }
  } else if (selectedOptions) {
    await prisma.cartItemOption.deleteMany({ where: { cartItemId: itemId } });
    const optionData = selectedOptions
      .map((optionId: string) => {
        const opt = item.product.options.find((o) => o.id === optionId);
        if (!opt) return null;
        return { cartItemId: itemId, productOptionId: optionId, name: opt.name, price: opt.price };
      })
      .filter(Boolean) as { cartItemId: string; productOptionId: string; name: string; price: number }[];

    if (optionData.length > 0) await prisma.cartItemOption.createMany({ data: optionData });
  }

  const updatedItems = await prisma.cartItem.findMany({ where: { cartId: item.cart.id } });
  await prisma.cart.update({ where: { id: item.cart.id }, data: calculateCartTotals(updatedItems) });

  const enhancedCart = await getEnhancedCart(item.cart.id);
  const cacheKey = cartCacheKey(req.user!.id);
  try {
    await ShopCartRedis.set(cacheKey, JSON.stringify(enhancedCart), { EX: CART_TTL_SECONDS });
  } catch (err) {
    logger.warn({ err, cacheKey }, "ShopCartRedis.set failed (best-effort)");
  }

  return sendSuccess(res, enhancedCart, "Cart item updated successfully");
};

// DELETE /cart/items/:itemId - Remove item from cart
export const removeCartItem = async (req: AuthRequest, res: Response) => {
  const itemId = ensureString(req.params.itemId);
  const userId = req.user!.id;
  const cacheKey = cartCacheKey(userId);

  const item = await prisma.cartItem.findFirst({
    where: { id: itemId, cart: { customerId: userId } },
    include: { cart: true },
  });
  if (!item) throw new NotFoundError("Cart item");

  const cartId = item.cart.id;
  await prisma.cartItem.delete({ where: { id: itemId } });

  const remainingItems = await prisma.cartItem.count({ where: { cartId } });

  if (remainingItems === 0) {
    await prisma.cart.delete({ where: { id: cartId } });
    try {
      await ShopCartRedis.del(cacheKey);
    } catch (err) {
      logger.warn({ err, cacheKey }, "ShopCartRedis.del failed (best-effort)");
    }
    return sendSuccess(res, { id: null, items: [], basePrice: 0, totalPrice: 0 }, "Cart item removed and cart deleted");
  }

  const updatedItems = await prisma.cartItem.findMany({ where: { cartId } });
  await prisma.cart.update({ where: { id: cartId }, data: calculateCartTotals(updatedItems) });

  const enhancedCart = await getEnhancedCart(cartId);
  try {
    await ShopCartRedis.set(cacheKey, JSON.stringify(enhancedCart), { EX: CART_TTL_SECONDS });
  } catch (err) {
    logger.warn({ err, cacheKey }, "ShopCartRedis.set failed (best-effort)");
  }

  return sendSuccess(res, enhancedCart, "Cart item removed successfully");
};

// DELETE /cart - Clear entire cart
export const clearCart = async (req: AuthRequest, res: Response) => {
  const userId = req.user!.id;
  const cacheKey = cartCacheKey(userId);

  const cart = await prisma.cart.findFirst({ where: { customerId: userId } });
  if (!cart) {
    return sendSuccess(res, { id: null, items: [], basePrice: 0, totalPrice: 0 }, "No active cart to clear");
  }

  await prisma.cartItem.deleteMany({ where: { cartId: cart.id } });
  await prisma.cart.delete({ where: { id: cart.id } });
  try {
    await ShopCartRedis.del(cacheKey);
  } catch (err) {
    logger.warn({ err, cacheKey }, "ShopCartRedis.del failed (best-effort)");
  }

  return sendSuccess(res, { id: null, items: [], basePrice: 0, totalPrice: 0 }, "Cart cleared successfully");
};

// GET /cart/summary - Priced, vendor-grouped breakdown incl. delivery fee.
// New endpoint — update-of-paddi previously had no pricing preview at all
// before committing to checkout, and no delivery fee concept whatsoever.
export const getCartSummary = async (req: AuthRequest, res: Response) => {
  const userId = req.user!.id;
  const addressId = req.query.addressId as string | undefined;
  const promoCode = req.query.promoCode as string | undefined;

  const summary = await cartSummaryService({ userId, addressId, promoCode });

  if (summary.vendorBreakdown.length === 0) {
    return sendSuccess(res, { ...summary, summaryId: null }, "Cart is empty or has no purchasable items");
  }

  // Phase 3A: cartSummaryService reports integer kobo internally. The snapshot
  // stored for checkout re-validation stays in kobo (compared against the
  // live kobo summary at checkout), but the client-facing response reports
  // naira so legacy Flutter/web clients keep seeing naira amounts.
  const summaryForClient = {
    ...summary,
    subtotal: koboToNaira(summary.subtotal),
    discount: koboToNaira(summary.discount),
    autoDiscount: koboToNaira(summary.autoDiscount),
    codeDiscount: koboToNaira(summary.codeDiscount),
    deliveryFee: koboToNaira(summary.deliveryFee),
    finalTotal: koboToNaira(summary.finalTotal),
    vendorBreakdown: summary.vendorBreakdown.map((vb) => ({
      ...vb,
      subtotal: koboToNaira(vb.subtotal),
      discount: koboToNaira(vb.discount),
      autoDiscount: koboToNaira(vb.autoDiscount),
      codeDiscount: koboToNaira(vb.codeDiscount),
      deliveryFee: koboToNaira(vb.deliveryFee),
      final: koboToNaira(vb.final),
      items: vb.items.map((it) => ({
        ...it,
        unitPrice: koboToNaira(it.unitPrice),
        subtotal: koboToNaira(it.subtotal),
        originalUnitPrice: koboToNaira(it.originalUnitPrice),
        effectiveUnitPrice: koboToNaira(it.effectiveUnitPrice),
        unitDiscount: koboToNaira(it.unitDiscount),
      })),
    })),
  };

  // Persist a snapshot of exactly what was shown — checkout re-validates
  // against this by id, so the price the customer confirms is always the
  // price they were quoted, not whatever the live cart happens to total
  // to by the time they tap "pay".
  const summaryId = uuidv4();
  await prisma.cartSummarySnapshot.create({
    data: { id: summaryId, userId, snapshot: summary as any },
  });

  return sendSuccess(res, { ...summaryForClient, summaryId }, "Cart summary generated");
};

// POST /cart/checkout - Convert cart to order(s), one order per vendor
export const checkoutCart = async (req: AuthRequest, res: Response) => {
  const userId = req.user!.id;
  const cacheKey = cartCacheKey(userId);

  // Idempotency: a stable client-supplied key means retries (double-tap,
  // network timeout + resend) return the original result instead of
  // creating duplicate orders. If the client doesn't send one, a random
  // key is generated as a fallback so the code path never breaks — but
  // that fallback provides no dedup protection, so the Flutter client
  // should always send a stable Idempotency-Key header per checkout
  // attempt (e.g. generated once when the user taps "Pay" and reused on
  // any automatic retry of that same tap).
  const idempotencyKey = req.headers["idempotency-key"]
    ? String(req.headers["idempotency-key"])
    : null;

  if (!idempotencyKey) {
    return res.status(400).json({
      message: "idempotency-key header is required"
    });
  }

  if (req.headers["idempotency-key"]) {
    const existingOrders = (await prisma.order.findMany({ where: { idempotencyKey, customerId: userId } })) ?? [];
    if (existingOrders.length > 0) {
      return sendSuccess(res, { orders: existingOrders }, "Checkout already processed", 200);
    }
  }

  const { summaryId, addressId, scheduledAt } = req.body ?? {};
  if (!summaryId) throw new ValidationError("summaryId is required");
  if (!addressId) throw new ValidationError("addressId is required");

  const address = await prisma.address.findFirst({ where: { id: addressId, userId } });
  if (!address) throw new NotFoundError("Address");

  // Phase 3D: optional scheduled/preorder fulfillment time. Validated
  // server-side; client-supplied dates are never trusted.
  const resolvedScheduledAt = parseScheduledAt(scheduledAt);
  const nowLagos = DateTime.now().setZone(LAGOS_TZ);

  const snapshot = await prisma.cartSummarySnapshot.findUnique({ where: { id: summaryId } });
  if (!snapshot) throw new NotFoundError("Cart summary");
  if (snapshot.userId !== userId) throw new ConflictError("Unauthorized snapshot access");

  const snapshotAge = Date.now() - new Date(snapshot.createdAt).getTime();
  if (snapshotAge > MAX_SNAPSHOT_AGE_MS) {
    throw new ConflictError("Cart summary has expired. Please refresh your cart.");
  }

  const snapshotData = snapshot.snapshot as any;
  if (!snapshotData?.vendorBreakdown?.length) {
    throw new ValidationError("Invalid cart summary data");
  }

  // B2: fail fast if email is invalid — before creating any orders.
  const checkoutUser = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
  if (!checkoutUser?.email || !z.string().email().safeParse(checkoutUser.email).success) {
    throw new AppError("Your profile email is invalid. Please update email before checkout.", 409, "PROFILE_EMAIL_INVALID", { code: "PROFILE_EMAIL_INVALID", nextStep: { action: "UPDATE_EMAIL" } });
  }

  const cart = await prisma.cart.findFirst({
    where: { customerId: userId },
    include: { items: { include: { product: { include: { vendor: true } }, options: true } } },
  });

  if (!cart || cart.items.length === 0) throw new ValidationError("Your cart is empty");

  // Phase 1B self-dealing guard (checkout-time backstop — addToCart already
  // rejects own products, but carts predating the vendor upgrade may hold them).
  if (cart.items.some((i) => i.product.vendorId === userId))
    throw new ForbiddenError("You cannot purchase from your own store.");

  // Re-read every product and its ACTIVE add-ons straight from the
  // database. The cart stores quoted prices; the database is the truth.
  // Any drift (price edit, disabled add-on, depleted stock) rejects the
  // checkout so the customer refreshes — client totals are never trusted.
  const checkoutProductIds = [...new Set(cart.items.map((i) => i.productId))];
  const freshProducts = await prisma.product.findMany({
    where: { id: { in: checkoutProductIds } },
    select: {
      id: true,
      name: true,
      price: true,
      archived: true,
      trackInventory: true,
      stock: true,
      vendorId: true,
      isScheduled: true,
      orderCutoffTime: true,
      dailyCap: true,
      options: {
        where: { isActive: true },
        select: { id: true, name: true, price: true },
      },
    },
  });
  const freshById = new Map(freshProducts.map((p) => [p.id, p]));

  // Authoritative per-line totals, keyed by cart item id.
  const authoritativeLines = new Map<string, { unitPrice: number; subtotal: number }>();
  // Lines whose stored quote no longer matches the live effective price
  // (a deal started/ended, or the vendor edited a price). They are healed
  // to the live price below and the checkout is rejected so the customer
  // re-confirms a fresh summary — never silently charged a stale total.
  const driftedLines: { id: string; unitPrice: number; subtotal: number }[] = [];
  const checkoutPromos = await loadActiveProductPromos();
  // Aggregate quantities per product: one cart can hold the same product
  // on several lines (different add-on combos), but stock is per product.
  const qtyByProduct = new Map<string, number>();
  for (const item of cart.items) {
    qtyByProduct.set(item.productId, (qtyByProduct.get(item.productId) ?? 0) + item.quantity);
  }

  // Phase 2B.5b: authoritative option snapshots per cart line, rebuilt from
  // the database during revalidation (never copied from the cart's stored
  // snapshots, never from client input). Legacy lines resolve
  // ProductOption; new lines resolve OptionGroupItem. Keyed by cart item id
  // and consumed by order creation below.
  type AuthoritativeOption = {
    optionId?: string;
    optionGroupItemId?: string;
    name: string;
    price: number;
  };
  const authoritativeOptions = new Map<string, AuthoritativeOption[]>();

  // Phase 2B.5b: batch-load the option groups of every product that is
  // evaluated under the new authority, so checkout issues ONE query for the
  // whole cart instead of one per line. Lines carrying legacy rows are
  // excluded; optionless lines are included because an empty selection must
  // still satisfy the product's current required groups.
  const newAuthorityProductIds = [
    ...new Set(
      cart.items
        .filter(
          (i) =>
            i.options.some((o) => o.optionGroupItemId != null) ||
            !i.options.some((o) => o.productOptionId != null),
        )
        .map((i) => i.productId),
    ),
  ];
  const groupsByProduct = new Map<string, CheckoutOptionGroup[]>();
  if (newAuthorityProductIds.length > 0) {
    const allGroups = (await prisma.optionGroup.findMany({
      where: { productId: { in: newAuthorityProductIds } },
      include: { items: true },
    })) as unknown as CheckoutOptionGroup[];
    for (const group of allGroups) {
      const list = groupsByProduct.get(group.productId) ?? [];
      list.push(group);
      groupsByProduct.set(group.productId, list);
    }
  }

  for (const item of cart.items) {
    const fresh = freshById.get(item.productId);
    if (!fresh || fresh.archived) continue; // handled by the archived cleanup below

    // Representation-aware: the DB CHECK guarantees a line carries either
    // legacy ProductOption rows or new OptionGroupItem rows, never both.
    const groupItemIds = item.options
      .map((o) => o.optionGroupItemId)
      .filter((id): id is string => id != null);
    const hasLegacyRows = item.options.some((o) => o.productOptionId != null);

    let resolvedOptions: AuthoritativeOption[];
    let optionsTotal: number;

    // New authority applies when the line carries group-item rows, and also
    // when it carries NO rows at all (an empty selection must still satisfy
    // the product's current required groups — e.g. a line quoted before the
    // vendor added a required group). Legacy rows always take the legacy path.
    if (groupItemIds.length > 0 || !hasLegacyRows) {
      // NEW authority — full live revalidation: item→group→product chain,
      // active state, per-group min/max across ALL of the product's groups,
      // and duplicate rejection. Fails closed on any violation.
      const resolved = await resolveNewOptionSelection(
        item.productId,
        groupItemIds,
        groupsByProduct.get(item.productId) ?? [],
      );
      resolvedOptions = resolved.snapshots.map((s) => ({
        optionGroupItemId: s.optionGroupItemId,
        name: s.name,
        price: s.price,
      }));
      optionsTotal = resolved.optionsPrice;
    } else {
      // LEGACY authority — unchanged validation.
      const selectedIds = item.options.map((o) => o.productOptionId!);
      const activeById = new Map(fresh.options.map((o) => [o.id, o]));
      const staleOption = selectedIds.find((id) => !activeById.has(id));
      if (staleOption) {
        throw new ValidationError(
          `An extra selected for "${fresh.name}" is no longer available. Please refresh your cart.`,
        );
      }
      resolvedOptions = selectedIds.map((id) => {
        const opt = activeById.get(id)!;
        return { optionId: id, name: opt.name, price: opt.price };
      });
      optionsTotal = resolvedOptions.reduce((sum, o) => sum + o.price, 0);
    }

    authoritativeOptions.set(item.id, resolvedOptions);

    // Effective unit = live discounted product price + add-ons (canonical
    // resolver — identical to Home, detail and summary math).
    const checkoutEffective = resolveEffectivePromotionForProduct({
      product: { id: fresh.id, price: fresh.price, vendorId: fresh.vendorId, archived: fresh.archived },
      promos: checkoutPromos,
    });
    const effectiveBase = checkoutEffective ? checkoutEffective.discountedPrice : fresh.price;
    const unitPrice = round(effectiveBase + optionsTotal);
    if (unitPrice !== round(item.unitPrice)) {
      driftedLines.push({ id: item.id, unitPrice, subtotal: round(unitPrice * item.quantity) });
      continue;
    }
    authoritativeLines.set(item.id, { unitPrice, subtotal: round(unitPrice * item.quantity) });
  }

  if (driftedLines.length > 0) {
    for (const drifted of driftedLines) {
      await prisma.cartItem.update({
        where: { id: drifted.id },
        data: { unitPrice: drifted.unitPrice, subtotal: drifted.subtotal },
      });
    }
    const refreshedItems = await prisma.cartItem.findMany({ where: { cartId: cart.id } });
    await prisma.cart.update({ where: { id: cart.id }, data: calculateCartTotals(refreshedItems) });
    try {
      await ShopCartRedis.del(cacheKey);
    } catch (err) {
      logger.warn({ err, cacheKey }, "ShopCartRedis.del failed after price heal (best-effort)");
    }
    throw new ConflictError(
      "Cart pricing changed (a deal started or ended, or the vendor updated a price). Your cart now shows the current prices — please refresh your summary and try again.",
    );
  }

  for (const [productId, totalQty] of qtyByProduct) {
    const fresh = freshById.get(productId);
    if (!fresh || fresh.archived) continue;
    assertQuantityAvailable({
      productId,
      productName: fresh.name,
      quantity: totalQty,
      trackInventory: fresh.trackInventory,
      stock: fresh.stock,
    });
  }

  // Archived-item cleanup — remove anything the vendor pulled since it
  // was added, keep the rest.
  const archivedItems = cart.items.filter((item) => item.product.archived);
  if (archivedItems.length > 0) {
    const archivedItemIds = archivedItems.map((i) => i.id);
    const removedProductIds = archivedItems.map((i) => i.productId);

    await prisma.cartItemOption.deleteMany({ where: { cartItemId: { in: archivedItemIds } } });
    await prisma.cartItem.deleteMany({ where: { id: { in: archivedItemIds } } });

    const remainingItems = await prisma.cartItem.count({ where: { cartId: cart.id } });
    if (remainingItems === 0) await prisma.cart.delete({ where: { id: cart.id } });

    const updatedCart = remainingItems > 0 ? await getEnhancedCart(cart.id) : { id: null, items: [] };
    try {
      await ShopCartRedis.set(cacheKey, JSON.stringify(updatedCart), { EX: CART_TTL_SECONDS });
    } catch (err) {
      logger.warn({ err, cacheKey }, "ShopCartRedis.set failed after archived cleanup (best-effort)");
    }

    throw new ValidationError("Some products in your cart were removed because they're no longer available.", { removedProductIds });
  }

  // Marketplace-availability rule — an item is checkoutable only while
  // its vendor is live + accepting orders AND the product itself is not
  // archived and in stock. Items failing this stay in the cart (never
  // silently deleted) so customers keep them for when the vendor comes
  // back online. Stock uses the freshly-read values above, never the
  // (possibly stale) cart include.
  const liveItems = cart.items.filter((item) => {
    const vendorOperating = isVendorOperating(item.product.vendor as {
      isLive: boolean;
      vendorStatus?: string | null;
      deliveryPreferences?: unknown;
    });
    const fresh = freshById.get(item.productId);
    if (!fresh) return false;
    return (
      vendorOperating &&
      isProductCurrentlyAvailable({
        archived: fresh.archived,
        trackInventory: fresh.trackInventory,
        stock: fresh.stock,
      })
    );
  });
  const offlineItems = cart.items.filter((item) => !liveItems.includes(item));

  if (liveItems.length === 0) {
    throw new ValidationError("No products in your cart are currently orderable. They remain in your cart until their vendors are available again.");
  }

  // Lock the cart for the duration of checkout — a second concurrent
  // checkout attempt on the same cart (double-tap, two browser tabs)
  // gets rejected instead of racing this one.
  const cartLock = await prisma.cart.updateMany({ where: { id: cart.id, isLocked: false }, data: { isLocked: true } });
  if (cartLock.count === 0) {
    throw new ConflictError("Checkout already in progress");
  }

  // Idempotency-claim state lives outside the try so the finally can see
  // it (block scoping): released on failure, kept-complete on success.
  let idemClaimed = false;
  let idemCompleted = false;
  try {
    // Mandatory idempotency-key claim (Redis SET NX, 24h TTL — see
    // checkoutIdempotency.service). Same key + same cart summary/address
    // replays the stored response; same key + different payload is 422;
    // a still-running attempt is 409. Failures release the claim so the
    // key is never poisoned.
    const payloadHash = checkoutPayloadHash({ summaryId, addressId });
    const claim = await claimCheckoutKey(userId, idempotencyKey, payloadHash);
    if (claim.action === "replay") {
      return sendSuccess(res, claim.response, "Checkout already processed", 200);
    }
    if (claim.action === "mismatch") {
      throw new UnprocessableEntityError(
        "This idempotency key was already used for a different checkout. Generate a new key when the cart changes.",
        { idempotencyKey },
      );
    }
    if (claim.action === "conflict") {
      throw new ConflictError("Checkout already in progress for this key. Please wait, then retry with the same key.");
    }
    // Fail CLOSED on an unconfirmed claim: 503, retryable, no infra detail.
    if (claim.action === "unavailable") {
      // Fail CLOSED. Without a confirmed claim we cannot tell an in-flight
      // duplicate from a fresh request, and proceeding would let two concurrent
      // submissions with the same key each create an order. 503 is retryable
      // and the message deliberately names no infrastructure detail.
      throw new AppError(
        "Checkout is temporarily unavailable. Please retry with the same idempotency key in a moment.",
        503,
        "IDEMPOTENCY_UNAVAILABLE",
        { retryable: true },
      );
    }
    idemClaimed = claim.action === "proceed";
    // Revalidate pricing against the live cart — if anything changed
    // since the snapshot was taken (price edit, vendor went offline,
    // moved out of delivery range), reject rather than silently charging
    // a different amount than what was quoted.
    //
    // Re-uses the exact promo code the snapshot itself was built with
    // (rather than requiring the client to resend it) — omitting this
    // meant the revalidated total never included the discount at all,
    // which both silently dropped the discount from what got charged AND
    // made the price-match check below fail every single time a promo
    // was actually in use (the snapshot's discounted total could never
    // match a freshly computed full-price total).
    const promoCodeUsed = snapshotData.promo?.code as string | undefined;
    const freshSummary = await cartSummaryService({ userId, addressId, promoCode: promoCodeUsed });

    if (freshSummary.warnings.length > 0) {
      throw new ValidationError(freshSummary.warnings.join(" "));
    }

    const oldTotal = round(snapshotData.finalTotal);
    const newTotal = round(freshSummary.finalTotal);
    // Batch G: reconcile components, not just the total. A compensating
    // shift (e.g. subtotal +₦100 with delivery −₦100) keeps the total
    // identical while changing what the customer confirmed, so compare
    // the authoritative money components too. Non-numeric sides (legacy
    // snapshot shapes) fall back to the total-only check rather than
    // crashing or false-rejecting.
    const components: Array<[unknown, unknown]> = [
      [snapshotData.subtotal, freshSummary.subtotal],
      [snapshotData.discount, freshSummary.discount],
      [snapshotData.deliveryFee, freshSummary.deliveryFee],
    ];
    const componentsChanged = components.some(
      ([a, b]) =>
        typeof a === "number" &&
        typeof b === "number" &&
        Number.isFinite(a) &&
        Number.isFinite(b) &&
        round(a) !== round(b),
    );
    if (oldTotal !== newTotal || componentsChanged) {
      throw new ConflictError("Cart pricing changed. Please refresh your cart summary.");
    }

    const vendorPricing = new Map(freshSummary.vendorBreakdown.map((v) => [v.vendorId, v]));

    const groupedByVendor: Record<string, typeof liveItems> = {};
    for (const item of liveItems) {
      const vId = item.product.vendorId;
      if (!groupedByVendor[vId]) groupedByVendor[vId] = [];
      groupedByVendor[vId].push(item);
    }

    const customer = await prisma.user.findUnique({ where: { id: userId } });
    const customerName = customer?.name || "Unknown Customer";

    // Pre-validate all vendors before opening transaction — external read, not in tx
    for (const vendorId of Object.keys(groupedByVendor)) {
      const freshVendorState = await loadVendorOperatingState(vendorId);
      assertVendorAvailableForOrdering(freshVendorState);

      // Phase 3D: scheduling eligibility and vendor cut-off validation.
      // A scheduled order may only contain products that support scheduling,
      // and same-day fulfilment must respect each product's cut-off time.
      const vendorItems = groupedByVendor[vendorId];
      for (const item of vendorItems) {
        const fresh = freshById.get(item.productId);
        if (!fresh) continue;
        if (resolvedScheduledAt && fresh.isScheduled !== true) {
          throw new ValidationError(
            `"${fresh.name}" does not accept scheduled orders.`,
          );
        }
        const cutoffErr = validateCutOff({
          now: nowLagos,
          scheduledAt: resolvedScheduledAt,
          cutoffTime: fresh.orderCutoffTime,
        });
        if (cutoffErr) throw cutoffErr;
      }
    }

    // Atomic DB section: promo claim + stock reservation + all vendor
    // orders + cart cleanup + snapshot delete. If any step fails, the whole
    // batch rolls back — no partial checkout, no orphaned reservation.
    // Promo redemption is now inside the transaction to eliminate the
    // post-commit race where two concurrent checkouts could both consume the
    // last redemption while only one should succeed.
    const createdOrders = await prisma.$transaction(async (tx) => {
      // Pre-claim promo atomically inside transaction — reserve usage slot before creating orders
      // Row-level lock serializes concurrent redemptions for same promo (prevents per-user race)
      let promoClaimed = false;
      if (freshSummary.promo?.applied && freshSummary.promo.promoId) {
        const promoId = freshSummary.promo.promoId;
        await tx.$queryRaw`SELECT id FROM "Promotion" WHERE id = ${promoId} FOR UPDATE`;
        const promo = await tx.promotion.findUnique({ where: { id: promoId }, select: { usageLimit: true, usedCount: true, maxUsesPerUser: true } });
        if (promo && promo.usageLimit != null && promo.usedCount >= promo.usageLimit) {
          throw new AppError("Promo code has been fully redeemed. Please remove it and try checkout again.", 409, "PROMO_EXHAUSTED", { code: "PROMO_EXHAUSTED", promoId });
        }
        const perUserCount = await tx.promotionUsage.count({ where: { promotionId: promoId, userId } });
        if (promo && perUserCount >= promo.maxUsesPerUser) {
          throw new AppError("You have already used this promo the maximum number of times.", 409, "PROMO_EXHAUSTED", { code: "PROMO_EXHAUSTED", promoId });
        }
        const claimed = await tx.promotion.updateMany({
          where: {
            id: promoId,
            OR: [{ usageLimit: null }, { usedCount: { lt: promo?.usageLimit ?? undefined } }],
          },
          data: { usedCount: { increment: 1 } },
        });
        if (claimed.count === 0) {
          throw new AppError("Promo code has been fully redeemed. Please remove it and try checkout again.", 409, "PROMO_EXHAUSTED", { code: "PROMO_EXHAUSTED", promoId });
        }
        promoClaimed = true;
      }

      // Batch E: automatic promotions consume usage atomically, with the
      // same claim discipline as code promos. The winning auto promo IDs
      // come from the revalidated summary lines (server-computed, never
      // client-supplied); code-winning checkouts skip this block because
      // the code claim above already consumed the single discount source.
      // Each promo is row-locked, global-cap-checked, and conditionally
      // incremented — concurrent checkouts serialize here, so the last
      // redemption cannot be consumed twice. Per-user caps are not
      // rejected at claim time (see note below): the pricing resolver
      // grants auto discounts without regard to personal history, so
      // rejecting repeat buyers would block checkout with no recourse.
      // Everything below rolls back with the transaction, so failed or
      // abandoned checkouts never consume usage; committed checkouts replay
      // via idempotency and never re-enter. Usage rows (created with the
      // orders below) share the single PromotionUsage table, so per-user
      // accounting stays unified across both paths — no conflicting
      // counters.
      const autoPromoIds: string[] = [];
      const autoDiscountByPromo = new Map<string, number>();
      if (!promoClaimed) {
        const seen = new Set<string>();
        for (const vendorGroup of freshSummary.vendorBreakdown ?? []) {
          for (const item of (vendorGroup as { items?: { promotionId?: unknown; unitDiscount?: unknown; quantity?: unknown }[] }).items ?? []) {
            if (typeof item.promotionId !== "string" || !item.promotionId) continue;
            const share = Math.max(0, Number(item.unitDiscount ?? 0)) * Math.max(0, Number(item.quantity ?? 0));
            autoDiscountByPromo.set(
              item.promotionId,
              Math.round(((autoDiscountByPromo.get(item.promotionId) ?? 0) + share) * 100) / 100,
            );
            if (!seen.has(item.promotionId)) {
              seen.add(item.promotionId);
              autoPromoIds.push(item.promotionId);
            }
          }
        }
      }
      for (const promoId of autoPromoIds) {
        await tx.$queryRaw`SELECT id FROM "Promotion" WHERE id = ${promoId} FOR UPDATE`;
        const promo = await tx.promotion.findUnique({
          where: { id: promoId },
          select: { usageLimit: true, usedCount: true },
        });
        // Global cap only. Per-user caps are deliberately NOT rejected here:
        // the pricing resolver grants automatic discounts without regard to
        // personal history today, so rejecting repeat buyers (whose standing
        // vendor discounts carry the default maxUsesPerUser) would block
        // checkout with no recourse — there is no code to remove, unlike the
        // code-promo path. The usage rows below still record every auto
        // redemption in the shared table, so per-user accounting stays
        // observable and a future per-user policy has complete data.
        if (!promo || (promo.usageLimit != null && promo.usedCount >= promo.usageLimit)) {
          throw new AppError("A promotion applied to your cart has just been fully redeemed. Please review your cart and try checkout again.", 409, "PROMO_EXHAUSTED", { code: "PROMO_EXHAUSTED", promoId });
        }
        const claimedAuto = await tx.promotion.updateMany({
          where: {
            id: promoId,
            OR: [{ usageLimit: null }, { usedCount: { lt: promo.usageLimit ?? undefined } }],
          },
          data: { usedCount: { increment: 1 } },
        });
        if (claimedAuto.count === 0) {
          throw new AppError("A promotion applied to your cart has just been fully redeemed. Please review your cart and try checkout again.", 409, "PROMO_EXHAUSTED", { code: "PROMO_EXHAUSTED", promoId });
        }
      }

      // Atomically reserve stock for every checkout line. Concurrent
      // checkouts serialize on the product row: exactly one winner per
      // final portion, losers roll back with a sold-out error.
      await reserveStockForItems(
        tx,
        liveItems.map((i) => {
          const fresh = freshById.get(i.productId)!;
          return {
            productId: i.productId,
            productName: fresh.name,
            quantity: i.quantity,
            trackInventory: fresh.trackInventory,
            stock: fresh.stock,
          };
        }),
      );

      // Phase 3D: daily-cap reservation per product per Lagos business day.
      // Serialised on the ProductDailyCounter row, so concurrent checkouts
      // cannot both pass a cap on the strength of the same pre-increment
      // count. Capacity is bucketed by the fulfilment day (scheduledAt when
      // scheduled, otherwise today).
      const orderDayStart = lagosDayStart(resolvedScheduledAt ?? new Date());
      const cappedProducts = new Map<string, number>();
      for (const item of liveItems) {
        const fresh = freshById.get(item.productId)!;
        if (fresh.dailyCap == null) continue;
        if (!cappedProducts.has(fresh.id)) cappedProducts.set(fresh.id, fresh.dailyCap);
      }

      // Phase 3D: generate one order id per vendor upfront so the daily-cap
      // reservation (written before the Order row) can reference it, and so
      // the reservation and order creation stay in the same transaction.
      const orderIdByVendor = new Map(
        Object.keys(groupedByVendor).map((vendorId) => [vendorId, uuidv4()]),
      );
      const productIdToOrderId = new Map<string, string>();
      for (const [vendorId, vendorItems] of Object.entries(groupedByVendor)) {
        const orderId = orderIdByVendor.get(vendorId)!;
        for (const item of vendorItems) {
          productIdToOrderId.set(item.productId, orderId);
        }
      }
      // Phase 3.2b: read every vendor's effective commission rate inside
      // the same transaction, so the snapshotted rate is the rate actually
      // used for that vendor's order below (never a later-mutated value).
      const vendorRateRows = await tx.user.findMany({
        where: { id: { in: Object.keys(groupedByVendor) } },
        select: { id: true, commissionRate: true },
      });
      const rateByVendor = new Map(
        vendorRateRows.map((v) => [v.id, v.commissionRate] as const),
      );

      const orders = [];
      for (const [vendorId, vendorItems] of Object.entries(groupedByVendor)) {
        const pricing = vendorPricing.get(vendorId);
        // Phase 3A: cart line subtotals (CartItem.subtotal) and the cart
        // summary (freshSummary) now report integer kobo, so rawSubtotal,
        // discount and deliveryFee are already kobo. Use them directly — no
        // * 100, which would double-convert kobo into a wrong larger value.
        const rawSubtotal = vendorItems.reduce(
          (sum, i) => sum + (authoritativeLines.get(i.id)?.subtotal ?? i.subtotal),
          0,
        );
        const discountKobo = pricing?.discount ?? 0;
        const basePrice = rawSubtotal - discountKobo;
        const deliveryFeeKobo = pricing?.deliveryFee ?? 0;

        // Phase 3.2b going-forward snapshots: commission/payout/discount in
        // kobo plus the frozen rate, computed from the exact kobo values above.
        const moneySnapshot = buildOrderMoneySnapshot({
          basePriceKobo: basePrice,
          discountKobo,
          commissionRate: resolveCommissionRate(rateByVendor.get(vendorId)),
        });

        const orderItemsData = vendorItems.map((ci) => {
          const line = authoritativeLines.get(ci.id);
          // Phase 3.2b: product name frozen at checkout from the revalidated
          // catalog read (live items always have a fresh entry — see the
          // liveItems filter above). Historical rows stay untouched.
          const fresh = freshById.get(ci.productId)!;
          return {
            productId: ci.productId,
            productName: fresh.name,
            quantity: ci.quantity,
            unitPrice: line?.unitPrice ?? ci.unitPrice,
            subtotal: line?.subtotal ?? ci.subtotal,
            // Phase 2B.5b: option snapshots come from the authoritative
            // revalidation above (rebuilt from the DB), never from the
            // cart's stored snapshots. Each row carries exactly one source
            // FK — legacy optionId or new optionGroupItemId, never both,
            // never a shadow ProductOption.
            options: {
              create: (authoritativeOptions.get(ci.id) ?? []).map((o) =>
                o.optionGroupItemId
                  ? { optionGroupItemId: o.optionGroupItemId, name: o.name, price: o.price }
                  : { optionId: o.optionId!, name: o.name, price: o.price },
              ),
            },
          };
        });

        const order = await tx.order.create({
          data: {
            id: orderIdByVendor.get(vendorId)!,
            customerId: userId,
            vendorId,
            addressId,
            basePrice,
            deliveryFee: deliveryFeeKobo,
            totalPrice: basePrice + deliveryFeeKobo,
            commissionRateSnapshot: moneySnapshot.commissionRateSnapshot,
            commissionKobo: moneySnapshot.commissionKobo,
            vendorPayoutKobo: moneySnapshot.vendorPayoutKobo,
            discountKobo: moneySnapshot.discountKobo,
            status: OrderStatus.AWAITING_PAYMENT,
            idempotencyKey,
            protectedUntil: new Date(Date.now() + 15 * 60 * 1000),
            // Phase 3D: null = immediate order; set = requested fulfilment time.
            scheduledAt: resolvedScheduledAt,
            items: { create: orderItemsData },
          },
          include: { items: { include: { options: true } } },
        });
        orders.push(order);

        // Phase 3D: reserve daily-cap units now that the order row exists.
        // The foreign key on DailyCapReservation.orderId requires the Order
        // row to be present before the reservation can be created.
        for (const item of vendorItems) {
          const fresh = freshById.get(item.productId);
          if (!fresh || fresh.dailyCap == null) continue;
          await reserveDailyCap(
            tx,
            item.productId,
            orderDayStart,
            fresh.dailyCap,
            order.id,
          );
        }
      }

      // Create promo usage with real orderIds after orders exist
      if (promoClaimed && freshSummary.promo?.promoId && orders.length > 0) {
        await tx.promotionUsage.create({
          data: {
            promotionId: freshSummary.promo.promoId,
            userId,
            orderIds: orders.map((o) => o.id),
            promoCode: freshSummary.promo.code!,
            // PromotionUsage.discount is integer kobo (Phase 3A); freshSummary
            // reports kobo — pass through unchanged, no * 100.
            discount: freshSummary.discount,
          },
        });
      }
      // Auto-promo usage rows share the same table (per-user accounting
      // stays unified). `promoCode` has no code for automatic promotions;
      // the sentinel marks the redemption source without affecting the
      // promotionId/userId accounting the limits enforce on.
      if (autoPromoIds.length > 0 && orders.length > 0) {
        for (const promoId of autoPromoIds) {
          await tx.promotionUsage.create({
            data: {
              promotionId: promoId,
              userId,
              orderIds: orders.map((o) => o.id),
              promoCode: "AUTO",
              // autoDiscountByPromo accumulates integer-kobo unitDiscounts;
              // pass through unchanged, no * 100.
              discount: autoDiscountByPromo.get(promoId) ?? 0,
            },
          });
        }
      }

      if (liveItems.length > 0) {
        await tx.cartItemOption.deleteMany({ where: { cartItemId: { in: liveItems.map((i) => i.id) } } });
        await tx.cartItem.deleteMany({ where: { id: { in: liveItems.map((i) => i.id) } } });
      }

      if (offlineItems.length === 0) {
        await tx.cart.delete({ where: { id: cart.id } });
      }

      // Snapshot is single-use — once consumed by a successful checkout it
      // can't be replayed to create a second set of orders.
      await tx.cartSummarySnapshot.delete({ where: { id: summaryId } }).catch(() => {});

      return orders;
    });

    // Stock moved inside the transaction above — cached product rows are
    // stale now. Best-effort invalidation (a miss only costs one DB read).
    await Promise.all(
      [...new Set(liveItems.map((i) => i.productId))].map((productId) =>
        clearProductCache(productId)
          .then((result) => {
            if (result && !result.ok) {
              logger.warn(
                { productId, failures: result.failures },
                "Product cache invalidation incomplete after checkout",
              );
            }
          })
          .catch((err) => {
            logger.warn(
              { err, productId },
              "Product cache invalidation threw unexpectedly after checkout",
            );
          }),
      ),
    );

    // Phase 1 — the vendor is NOT notified here.
    //
    // The orders above were created in AWAITING_PAYMENT inside the transaction
    // (see `status: OrderStatus.AWAITING_PAYMENT`), so at this point nothing has
    // been paid. The previous code emitted an Activity row, a Notification row,
    // a `notification` + `orderUpdate` socket pair and a push — all titled
    // "New Order Received" — to the vendor for an order that could still expire,
    // fail or be abandoned. That is exactly the pre-payment "actionable order"
    // alert this phase removes.
    //
    // The vendor's actionable-order alert now originates from exactly one place:
    // `finalizePaymentSuccess`, which emits `NEW_PAID_ORDER` only after its
    // conditional claim has moved the order to PAYMENT_CONFIRMED
    // (src/services/paymentFinalizer.service.ts). Suppressing it here also
    // preserves that path's idempotency — the vendor now receives precisely one
    // paid-order notification per order, and none at all for a checkout that is
    // never paid.
    //
    // Only the internal audit trail is kept. It is deliberately NOT routed
    // through `recordActivityBundle`, because that helper persists an `Activity`
    // row before it emits anything; passing `notifyRealtime: false` would still
    // have left the "New Order Received" record behind. Audit logs are internal
    // and admin-only (GET /admin/audit-logs), so the order's existence remains
    // on record without reaching the vendor.
    //
    // Nothing customer-facing is removed: this bundle targeted `order.vendorId`
    // only, and the customer's own confirmation is the HTTP 201 body returned
    // below (`sendCreated(..., "Checkout successful")`).
    for (const order of createdOrders) {
      await createAuditLog({
        userId: userId,
        action: "ORDER_CREATED",
        req,
        metadata: {
          orderId: order.id,
          customerId: userId,
          vendorId: order.vendorId,
          orderStatus: OrderStatus.AWAITING_PAYMENT,
          totalPrice: order.totalPrice,
          // Recorded, never used, to identify who the customer was at checkout
          // time without repeating their name in a vendor-visible surface.
          customerName,
        },
      }).catch((err) =>
        logger.warn({ err, orderId: order.id }, "Failed to write checkout audit log (non-critical)"),
      );
    }

    // Promo was already claimed inside the transaction — no post-commit redeem needed

    // Record the completed checkout for same-key replays (24h). The stored
    // response is JSON-sanitized: Order kobo snapshots are bigints, which
    // raw JSON.stringify (used by the Redis idempotency store) rejects.
    //
    // The order above is ALREADY COMMITTED here, so a failed completion write
    // must never be reported as a rolled-back checkout. When the write fails,
    // completeCheckoutKey returns false, idemCompleted stays false, and the
    // finally block releases the claim. Releasing is safe because the DB
    // idempotencyKey lookup at the top of this handler is the authoritative
    // dedup: the committed order carries that key, so a retry short-circuits
    // at the replay check and returns the original order instead of running
    // checkout again. Leaving the claim in-flight instead would strand retries
    // behind a stale 409 for up to five minutes for no protective benefit.
    const completeResult = await completeCheckoutKey(userId, idempotencyKey, payloadHash, toJsonSafe({ orders: createdOrders }));
    idemCompleted = completeResult === true;

    const updatedCart = offlineItems.length > 0 ? await getEnhancedCart(cart.id) : { id: null, items: [], basePrice: 0, totalPrice: 0 };
    try {
      await ShopCartRedis.set(cacheKey, JSON.stringify(updatedCart), { EX: CART_TTL_SECONDS });
    } catch (err) {
      logger.warn({ err, cacheKey }, "ShopCartRedis.set failed after checkout (best-effort, non-critical)");
    }

    return sendCreated(res, { orders: createdOrders, cart: updatedCart }, "Checkout successful");
  } finally {
    // Release the idempotency claim on failure so the same key can be
    // retried; on success the key stays complete for 24h replays.
    if (idemClaimed && !idemCompleted) {
      await releaseCheckoutKey(userId, idempotencyKey);
    }
    // Always release the lock, whether checkout succeeded, failed
    // validation, or threw unexpectedly.
    await prisma.cart.updateMany({ where: { id: cart.id }, data: { isLocked: false } }).catch((err) => {
      logger.error({ err, cartId: cart.id }, "Failed to release cart lock");
    });
  }
};

// Helper: Get enhanced cart data (product info, live/offline status, priced options)
async function getEnhancedCart(cartId: string) {
  const cart = await prisma.cart.findUnique({
    where: { id: cartId },
    include: {
      items: {
        include: {
          product: {
            include: {
              options: true,
              optionGroups: {
                orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
                include: { items: { orderBy: [{ sortOrder: "asc" }, { id: "asc" }] } },
              },
              vendor: { select: { id: true, name: true, isLive: true, vendorStatus: true, deliveryPreferences: true } },
            },
          },
          options: { include: { productOption: true, optionGroupItem: true } },
        },
      },
    },
  });

  if (!cart) return null;

  // Read-only effective pricing per line (canonical resolver). Stored
  // unitPrice is the quote from add-to-cart time; effectiveUnitPrice is the
  // live price after automatic promotions. Clients display the effective
  // price; checkout heals stale quotes and enforces re-confirmation.
  let linePromos: Awaited<ReturnType<typeof loadActiveProductPromos>> = [];
  try {
    linePromos = await loadActiveProductPromos();
  } catch {
    linePromos = [];
  }

  const enrichedItems = cart.items.map((item) => {
    // Dual representation: legacy rows resolve productOption, new rows
    // resolve optionGroupItem; each row carries exactly one (DB CHECK).
    const selectedOptionIds = item.options.map((opt) => opt.productOptionId);
    const selectedGroupItemIds = item.options
      .map((opt) => opt.optionGroupItemId)
      .filter((id): id is string => id != null);
    const product = item.product;

    // Marketplace-orderable right now = vendor live + accepting orders AND
    // product not archived and in stock.
    const productonline =
      isVendorOperating(product.vendor as { isLive: boolean; vendorStatus?: string | null; deliveryPreferences?: unknown }) &&
      isProductCurrentlyAvailable({
        archived: product.archived,
        trackInventory: product.trackInventory,
        stock: product.stock,
      });

    const lineOptionsTotal = round(
      item.options.reduce(
        (sum, opt) => sum + Number(opt.optionGroupItem?.priceAdd ?? opt.productOption?.price ?? opt.price ?? 0),
        0,
      ),
    );
    const linePromotion = resolveEffectivePromotionForProduct({
      product: {
        id: product.id,
        price: typeof product.price === "number" ? product.price : round(item.unitPrice) - lineOptionsTotal,
        vendorId: product.vendorId ?? product.vendor?.id,
        archived: product.archived,
      },
      promos: linePromos,
    });
    const lineOriginalUnit = round(
      (typeof product.price === "number" ? product.price : round(item.unitPrice) - lineOptionsTotal) +
        lineOptionsTotal,
    );
    const lineEffectiveUnit = round(
      (linePromotion ? linePromotion.discountedPrice : lineOriginalUnit - lineOptionsTotal) +
        lineOptionsTotal,
    );

    return {
      id: item.id,
      productId: item.productId,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      subtotal: round(item.unitPrice * item.quantity),
      // Live effective pricing (automatic promotions). unitPrice stays the
      // stored quote; clients should display effectiveUnitPrice.
      originalUnitPrice: lineOriginalUnit,
      effectiveUnitPrice: lineEffectiveUnit,
      unitDiscount: round(Math.max(lineOriginalUnit - lineEffectiveUnit, 0)),
      promotion: linePromotion,
      specialRequest: item.specialRequest || null,
      productonline, // true if product is live and can be ordered right now
      product: {
        id: product.id,
        name: product.name,
        price: product.price,
        images: product.images || [],
        video: product.video || [],
        vendor: { id: product.vendor.id, name: product.vendor.name },
        // F-2.17: the selectable legacy menu is active-only, matching
        // product detail and add-to-cart validation. selectedOptions below
        // remains unfiltered so stale selections stay identifiable/removable.
        options: product.options
          .filter((opt) => opt.isActive !== false)
          .map((opt) => ({
            id: opt.id,
            name: opt.name,
            price: opt.price,
            selected: selectedOptionIds.includes(opt.id),
          })),
        // Phase 2B.4b: structured menu alongside legacy options
        // (compatibility period — both served, no dual-write).
        optionGroups: (product.optionGroups ?? []).map((group: any) => ({
          id: group.id,
          name: group.name,
          required: group.required,
          minSelections: group.minSelections,
          maxSelections: group.maxSelections,
          sortOrder: group.sortOrder,
          items: (group.items ?? []).map((entry: any) => ({
            id: entry.id,
            name: entry.name,
            priceAdd: entry.priceAdd,
            isActive: entry.isActive,
            sortOrder: entry.sortOrder,
            selected: selectedGroupItemIds.includes(entry.id),
          })),
        })),
      },
      selectedOptions: item.options.map((opt) => {
        const source = opt.optionGroupItemId
          ? { name: opt.optionGroupItem?.name ?? opt.name, price: opt.optionGroupItem?.priceAdd ?? opt.price }
          : { name: opt.productOption?.name ?? opt.name, price: opt.productOption?.price ?? opt.price };
        return {
          id: opt.id,
          cartItemId: opt.cartItemId,
          productOptionId: opt.productOptionId,
          optionGroupItemId: opt.optionGroupItemId,
          name: source.name,
          price: source.price,
        };
      }),
    };
  });

  return {
    id: cart.id,
    items: enrichedItems,
    basePrice: cart.basePrice,
    totalPrice: cart.totalPrice,
  };
}
