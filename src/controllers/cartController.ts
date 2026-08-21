import { Response } from "express";
import { v4 as uuidv4 } from "uuid";
import { AuthRequest } from "../middlewares/auth.middleware";
import prisma from "../lib/prisma";
import { ActivityType, OrderStatus } from "@prisma/client";
import { recordActivityBundle } from "../utils/activityUtils/recordActivityBundle";
import { addToCartSchema, updateCartItemSchema } from "../validations/cartSchema";
import { ShopCartRedis } from "../lib/redis";
import { sendSuccess, sendCreated } from "../utils/apiResponse";
import { NotFoundError, ValidationError, ConflictError } from "../errors/AppError";
import { cartSummaryService } from "../services/cartSummary.service";
import { redeemPromo } from "../services/promoService";
import { logger } from "../lib/logger";

// Normalize Express params/query values to string
function ensureString(v: any): string {
  if (v === undefined || v === null) return "";
  return Array.isArray(v) ? v[0] : String(v);
}

const CART_TTL_SECONDS = 3600; // 1 hour
const MAX_SNAPSHOT_AGE_MS = 30 * 60 * 1000; // 30 minutes
const round = (v: number) => Number(v.toFixed(2));

// Helper: Calculate cart totals (base = total; discounts happen at
// checkout-summary time via cartSummaryService, not stored on the cart).
const calculateCartTotals = (items: Array<{ unitPrice: number; quantity: number }>) => {
  const basePrice = round(items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0));
  return { basePrice, totalPrice: basePrice };
};

// GET /cart - Get current cart
export const getCart = async (req: AuthRequest, res: Response) => {
  const userId = req.user!.id;
  const cacheKey = `cart:user:${userId}`;

  const cachedCart = await ShopCartRedis.get(cacheKey);
  if (cachedCart) {
    return sendSuccess(res, JSON.parse(cachedCart), "Cart retrieved successfully (cache)");
  }

  const cart = await prisma.cart.findFirst({
    where: { customerId: userId },
    include: {
      items: {
        include: {
          product: { include: { options: true, vendor: { select: { id: true, name: true } }, productSchedule: true } },
          options: { include: { productOption: true } },
        },
      },
    },
  });

  const enrichedCart = cart ? await getEnhancedCart(cart.id) : { id: null, items: [], basePrice: 0, totalPrice: 0 };

  if (enrichedCart && enrichedCart.items.length > 0) {
    await ShopCartRedis.set(cacheKey, JSON.stringify(enrichedCart), { EX: CART_TTL_SECONDS });
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

  const product = await prisma.product.findUnique({ where: { id: productId }, include: { options: true } });
  if (!product) throw new NotFoundError("Product");
  if (product.archived) throw new ValidationError("Product is no longer available");

  const invalidOptions = selectedOptions.filter((id: string) => !product.options.some((o) => o.id === id));
  if (invalidOptions.length > 0) {
    throw new ValidationError("Invalid product options selected", { invalidOptions });
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

  const optionsPrice = product.options
    .filter((o) => selectedOptions.includes(o.id))
    .reduce((sum, o) => sum + o.price, 0);
  const unitPrice = product.price + optionsPrice;

  // Match by product + selected options combo, not just productId — two
  // cart lines for the same product with different options (e.g. "no
  // spice" vs "extra spice") are genuinely different line items and must
  // not get merged into one. Matching by productId alone (the previous
  // behavior) silently overwrote the first line's options/price whenever
  // the same product was added again with a different option selection.
  const newOptionIds = [...selectedOptions].sort();
  const existingItem = cart.items.find((item) => {
    const existingOptionIds = item.options.map((o) => o.productOptionId).sort();
    return item.productId === productId && JSON.stringify(existingOptionIds) === JSON.stringify(newOptionIds);
  });

  if (existingItem) {
    const newQty = existingItem.quantity + quantity;
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
    await prisma.cartItem.create({
      data: {
        cartId: cart.id,
        productId,
        quantity,
        unitPrice,
        subtotal: round(unitPrice * quantity),
        specialRequest,
        options: {
          create: selectedOptions.map((id: string) => {
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
  await ShopCartRedis.set(`cart:user:${req.user!.id}`, JSON.stringify(enhancedCart), { EX: CART_TTL_SECONDS });

  return sendCreated(res, enhancedCart, "Item added to cart successfully");
};

// PATCH /cart/items/:itemId - Update cart item
export const updateCartItem = async (req: AuthRequest, res: Response) => {
  const itemId = ensureString(req.params.itemId);

  const parsed = updateCartItemSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new ValidationError("Invalid update payload", parsed.error.flatten().fieldErrors);
  }
  const { quantity, selectedOptions, specialRequest } = parsed.data;

  const item = await prisma.cartItem.findFirst({
    where: { id: itemId, cart: { customerId: req.user!.id } },
    include: { cart: true, product: { include: { options: true } }, options: true },
  });

  if (!item) throw new NotFoundError("Cart item");

  if (selectedOptions) {
    const invalidOptions = selectedOptions.filter((optId: string) => !item.product.options.some((opt) => opt.id === optId));
    if (invalidOptions.length > 0) {
      throw new ValidationError("Invalid product options selected", { invalidOptions });
    }
  }

  const updateData: Record<string, unknown> = {};
  if (quantity !== undefined) updateData.quantity = quantity;
  if (specialRequest !== undefined) updateData.specialRequest = specialRequest;

  if (quantity !== undefined || selectedOptions) {
    const finalOptions = selectedOptions ?? item.options.map((opt) => opt.productOptionId);
    const optionsPrice = item.product.options
      .filter((opt) => finalOptions.includes(opt.id))
      .reduce((sum, opt) => sum + opt.price, 0);

    const unitPrice = item.product.price + optionsPrice;
    const qty = quantity ?? item.quantity;

    updateData.unitPrice = unitPrice;
    updateData.subtotal = round(unitPrice * qty);
  }

  await prisma.cartItem.update({ where: { id: itemId }, data: updateData });

  if (selectedOptions) {
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
  await ShopCartRedis.set(`cart:user:${req.user!.id}`, JSON.stringify(enhancedCart), { EX: CART_TTL_SECONDS });

  return sendSuccess(res, enhancedCart, "Cart item updated successfully");
};

// DELETE /cart/items/:itemId - Remove item from cart
export const removeCartItem = async (req: AuthRequest, res: Response) => {
  const itemId = ensureString(req.params.itemId);
  const userId = req.user!.id;
  const cacheKey = `cart:user:${userId}`;

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
    await ShopCartRedis.del(cacheKey);
    return sendSuccess(res, { id: null, items: [], basePrice: 0, totalPrice: 0 }, "Cart item removed and cart deleted");
  }

  const updatedItems = await prisma.cartItem.findMany({ where: { cartId } });
  await prisma.cart.update({ where: { id: cartId }, data: calculateCartTotals(updatedItems) });

  const enhancedCart = await getEnhancedCart(cartId);
  await ShopCartRedis.set(cacheKey, JSON.stringify(enhancedCart), { EX: CART_TTL_SECONDS });

  return sendSuccess(res, enhancedCart, "Cart item removed successfully");
};

// DELETE /cart - Clear entire cart
export const clearCart = async (req: AuthRequest, res: Response) => {
  const userId = req.user!.id;
  const cacheKey = `cart:user:${userId}`;

  const cart = await prisma.cart.findFirst({ where: { customerId: userId } });
  if (!cart) {
    return sendSuccess(res, { id: null, items: [], basePrice: 0, totalPrice: 0 }, "No active cart to clear");
  }

  await prisma.cartItem.deleteMany({ where: { cartId: cart.id } });
  await prisma.cart.delete({ where: { id: cart.id } });
  await ShopCartRedis.del(cacheKey);

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

  // Persist a snapshot of exactly what was shown — checkout re-validates
  // against this by id, so the price the customer confirms is always the
  // price they were quoted, not whatever the live cart happens to total
  // to by the time they tap "pay".
  const summaryId = uuidv4();
  await prisma.cartSummarySnapshot.create({
    data: { id: summaryId, userId, snapshot: summary as any },
  });

  return sendSuccess(res, { ...summary, summaryId }, "Cart summary generated");
};

// POST /cart/checkout - Convert cart to order(s), one order per vendor
export const checkoutCart = async (req: AuthRequest, res: Response) => {
  const userId = req.user!.id;
  const cacheKey = `cart:user:${userId}`;

  // Idempotency: a stable client-supplied key means retries (double-tap,
  // network timeout + resend) return the original result instead of
  // creating duplicate orders. If the client doesn't send one, a random
  // key is generated as a fallback so the code path never breaks — but
  // that fallback provides no dedup protection, so the Flutter client
  // should always send a stable Idempotency-Key header per checkout
  // attempt (e.g. generated once when the user taps "Pay" and reused on
  // any automatic retry of that same tap).
  const idempotencyKey = String(req.headers["idempotency-key"] || uuidv4());

  if (req.headers["idempotency-key"]) {
    const existingOrders = await prisma.order.findMany({ where: { idempotencyKey, customerId: userId } });
    if (existingOrders.length > 0) {
      return sendSuccess(res, { orders: existingOrders }, "Checkout already processed", 200);
    }
  }

  const { summaryId, addressId } = req.body ?? {};
  if (!summaryId) throw new ValidationError("summaryId is required");
  if (!addressId) throw new ValidationError("addressId is required");

  const address = await prisma.address.findFirst({ where: { id: addressId, userId } });
  if (!address) throw new NotFoundError("Address");

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

  const cart = await prisma.cart.findFirst({
    where: { customerId: userId },
    include: { items: { include: { product: { include: { options: true, vendor: true, productSchedule: true } }, options: true } } },
  });

  if (!cart || cart.items.length === 0) throw new ValidationError("Your cart is empty");

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
    await ShopCartRedis.set(cacheKey, JSON.stringify(updatedCart), { EX: CART_TTL_SECONDS });

    throw new ValidationError("Some products in your cart were removed because they're no longer available.", { removedProductIds });
  }

  const now = new Date();
  const liveItems = cart.items.filter((item) => {
    const schedule = item.product.productSchedule;
    const withinSchedule =
      !schedule || ((!schedule.goLiveAt || schedule.goLiveAt <= now) && (!schedule.takeDownAt || schedule.takeDownAt >= now));
    return item.product.isLive && withinSchedule;
  });
  const offlineItems = cart.items.filter((item) => !liveItems.includes(item));

  if (liveItems.length === 0) {
    throw new ValidationError("No products in your cart are currently live. They remain in your cart until the vendor goes live.");
  }

  // Lock the cart for the duration of checkout — a second concurrent
  // checkout attempt on the same cart (double-tap, two browser tabs)
  // gets rejected instead of racing this one.
  const cartLock = await prisma.cart.updateMany({ where: { id: cart.id, isLocked: false }, data: { isLocked: true } });
  if (cartLock.count === 0) {
    throw new ConflictError("Checkout already in progress");
  }

  try {
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
    if (oldTotal !== newTotal) {
      throw new ConflictError("Cart pricing changed. Please refresh your cart summary.");
    }

    const vendorPricing = new Map(freshSummary.vendorBreakdown.map((v) => [v.vendorId, v]));

    const groupedByVendor: Record<string, typeof liveItems> = {};
    for (const item of liveItems) {
      const vId = item.product.vendorId;
      if (!groupedByVendor[vId]) groupedByVendor[vId] = [];
      groupedByVendor[vId].push(item);
    }

    const createdOrders = [];
    const customer = await prisma.user.findUnique({ where: { id: userId } });
    const customerName = customer?.name || "Unknown Customer";

    for (const [vendorId, vendorItems] of Object.entries(groupedByVendor)) {
      const pricing = vendorPricing.get(vendorId);
      const rawSubtotal = round(vendorItems.reduce((sum, i) => sum + i.subtotal, 0));
      const discount = pricing?.discount ?? 0;
      const basePrice = round(rawSubtotal - discount);
      const deliveryFee = pricing?.deliveryFee ?? 0;

      const orderItemsData = vendorItems.map((ci) => ({
        productId: ci.productId,
        quantity: ci.quantity,
        unitPrice: ci.unitPrice,
        subtotal: ci.subtotal,
        options: { create: ci.options.map((opt) => ({ optionId: opt.productOptionId, name: opt.name, price: opt.price })) },
      }));

      const order = await prisma.order.create({
        data: {
          customerId: userId,
          vendorId,
          addressId,
          basePrice,
          deliveryFee,
          totalPrice: round(basePrice + deliveryFee),
          status: OrderStatus.AWAITING_PAYMENT,
          idempotencyKey,
          protectedUntil: new Date(Date.now() + 15 * 60 * 1000),
          items: { create: orderItemsData },
        },
        include: { items: { include: { options: true } } },
      });

      createdOrders.push(order);

      await recordActivityBundle({
        actorId: userId,
        orderId: order.id,
        actions: [
          {
            type: ActivityType.GENERAL,
            title: "New Order Received",
            message: `You have a new order from ${customerName}`,
            targetId: vendorId,
            socketEvent: "ORDER",
            metadata: {
              type: "ORDER_DETAIL",
              route: `/orders/${order.id}`,
              target: { screen: "order_detail", id: order.id },
              orderId: order.id,
              customerId: userId,
              vendorId,
              frontendEvent: "NEW_ORDER",
            },
          },
        ],
        audit: { action: "ORDER_CREATED", metadata: { orderId: order.id, customerId: userId, vendorId } },
        notifyRealtime: true,
        notifyPush: true,
      });
    }

    // Redeem the promo now that every order is actually created — this
    // is the atomic, race-safe increment (see promoService.redeemPromo).
    // If the promo somehow got exhausted by a concurrent checkout between
    // the price-match check above and this exact moment, the orders
    // already created still stand at their (correctly discounted) price
    // — redemption just silently doesn't record a second usage rather
    // than unwinding an already-successful checkout over a bookkeeping
    // race this unlikely.
    if (freshSummary.promo.applied && freshSummary.promo.promoId) {
      await redeemPromo(freshSummary.promo.promoId, userId, createdOrders.map((o) => o.id), freshSummary.promo.code!, freshSummary.discount).catch(
        (err) => logger.warn({ err, promoId: freshSummary.promo.promoId }, "Failed to record promo redemption (orders already created successfully)")
      );
    }

    if (liveItems.length > 0) {
      await prisma.cartItemOption.deleteMany({ where: { cartItemId: { in: liveItems.map((i) => i.id) } } });
      await prisma.cartItem.deleteMany({ where: { id: { in: liveItems.map((i) => i.id) } } });
    }

    if (offlineItems.length === 0) {
      await prisma.cart.delete({ where: { id: cart.id } });
    }

    // Snapshot is single-use — once consumed by a successful checkout it
    // can't be replayed to create a second set of orders.
    await prisma.cartSummarySnapshot.delete({ where: { id: summaryId } }).catch(() => {});

    const updatedCart = offlineItems.length > 0 ? await getEnhancedCart(cart.id) : { id: null, items: [], basePrice: 0, totalPrice: 0 };
    await ShopCartRedis.set(cacheKey, JSON.stringify(updatedCart), { EX: CART_TTL_SECONDS });

    return sendCreated(res, { orders: createdOrders, cart: updatedCart }, "Checkout successful");
  } finally {
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
              vendor: { select: { id: true, name: true } },
              productSchedule: true, // needed to determine live/offline status
            },
          },
          options: { include: { productOption: true } },
        },
      },
    },
  });

  if (!cart) return null;

  const now = new Date();

  const enrichedItems = cart.items.map((item) => {
    const selectedOptionIds = item.options.map((opt) => opt.productOptionId);
    const product = item.product;
    const schedule = product.productSchedule;

    const withinSchedule =
      !schedule || ((!schedule.goLiveAt || schedule.goLiveAt <= now) && (!schedule.takeDownAt || schedule.takeDownAt >= now));
    const productonline = product.isLive && withinSchedule;

    return {
      id: item.id,
      productId: item.productId,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      subtotal: round(item.unitPrice * item.quantity),
      specialRequest: item.specialRequest || null,
      productonline, // true if product is live and can be ordered right now
      product: {
        id: product.id,
        name: product.name,
        price: product.price,
        images: product.images || [],
        video: product.video || [],
        vendor: { id: product.vendor.id, name: product.vendor.name },
        options: product.options.map((opt) => ({
          id: opt.id,
          name: opt.name,
          price: opt.price,
          selected: selectedOptionIds.includes(opt.id),
        })),
      },
      selectedOptions: item.options.map((opt) => ({
        id: opt.id,
        cartItemId: opt.cartItemId,
        productOptionId: opt.productOptionId,
        name: opt.productOption.name,
        price: opt.productOption.price,
      })),
    };
  });

  return {
    id: cart.id,
    items: enrichedItems,
    basePrice: cart.basePrice,
    totalPrice: cart.totalPrice,
  };
}
