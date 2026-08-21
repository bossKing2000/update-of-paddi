"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkoutCart = exports.getCartSummary = exports.clearCart = exports.removeCartItem = exports.updateCartItem = exports.addToCart = exports.getCart = void 0;
const uuid_1 = require("uuid");
const prisma_1 = __importDefault(require("../lib/prisma"));
const client_1 = require("@prisma/client");
const recordActivityBundle_1 = require("../utils/activityUtils/recordActivityBundle");
const cartSchema_1 = require("../validations/cartSchema");
const redis_1 = require("../lib/redis");
const apiResponse_1 = require("../utils/apiResponse");
const AppError_1 = require("../errors/AppError");
const cartSummary_service_1 = require("../services/cartSummary.service");
const promoService_1 = require("../services/promoService");
const logger_1 = require("../lib/logger");
// Normalize Express params/query values to string
function ensureString(v) {
    if (v === undefined || v === null)
        return "";
    return Array.isArray(v) ? v[0] : String(v);
}
const CART_TTL_SECONDS = 3600; // 1 hour
const MAX_SNAPSHOT_AGE_MS = 30 * 60 * 1000; // 30 minutes
const round = (v) => Number(v.toFixed(2));
// Helper: Calculate cart totals (base = total; discounts happen at
// checkout-summary time via cartSummaryService, not stored on the cart).
const calculateCartTotals = (items) => {
    const basePrice = round(items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0));
    return { basePrice, totalPrice: basePrice };
};
// GET /cart - Get current cart
const getCart = async (req, res) => {
    const userId = req.user.id;
    const cacheKey = `cart:user:${userId}`;
    const cachedCart = await redis_1.ShopCartRedis.get(cacheKey);
    if (cachedCart) {
        return (0, apiResponse_1.sendSuccess)(res, JSON.parse(cachedCart), "Cart retrieved successfully (cache)");
    }
    const cart = await prisma_1.default.cart.findFirst({
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
        await redis_1.ShopCartRedis.set(cacheKey, JSON.stringify(enrichedCart), { EX: CART_TTL_SECONDS });
    }
    return (0, apiResponse_1.sendSuccess)(res, enrichedCart, "Cart retrieved successfully");
};
exports.getCart = getCart;
// POST /cart/items - Add item to cart
const addToCart = async (req, res) => {
    const parsed = cartSchema_1.addToCartSchema.safeParse(req.body);
    if (!parsed.success) {
        throw new AppError_1.ValidationError("Invalid cart item", parsed.error.flatten().fieldErrors);
    }
    const { productId, quantity = 1, selectedOptions = [], specialRequest } = parsed.data;
    const product = await prisma_1.default.product.findUnique({ where: { id: productId }, include: { options: true } });
    if (!product)
        throw new AppError_1.NotFoundError("Product");
    if (product.archived)
        throw new AppError_1.ValidationError("Product is no longer available");
    const invalidOptions = selectedOptions.filter((id) => !product.options.some((o) => o.id === id));
    if (invalidOptions.length > 0) {
        throw new AppError_1.ValidationError("Invalid product options selected", { invalidOptions });
    }
    let cart = await prisma_1.default.cart.findFirst({
        where: { customerId: req.user.id },
        include: { items: { include: { options: true } } },
    });
    if (!cart) {
        cart = await prisma_1.default.cart.create({
            data: { customerId: req.user.id },
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
        await prisma_1.default.cartItem.update({
            where: { id: existingItem.id },
            data: {
                quantity: newQty,
                unitPrice,
                subtotal: round(unitPrice * newQty),
                specialRequest: specialRequest ?? existingItem.specialRequest,
            },
        });
    }
    else {
        await prisma_1.default.cartItem.create({
            data: {
                cartId: cart.id,
                productId,
                quantity,
                unitPrice,
                subtotal: round(unitPrice * quantity),
                specialRequest,
                options: {
                    create: selectedOptions.map((id) => {
                        const opt = product.options.find((o) => o.id === id);
                        return { productOptionId: id, name: opt.name, price: opt.price };
                    }),
                },
            },
        });
    }
    const updatedItems = await prisma_1.default.cartItem.findMany({ where: { cartId: cart.id } });
    await prisma_1.default.cart.update({ where: { id: cart.id }, data: calculateCartTotals(updatedItems) });
    const enhancedCart = await getEnhancedCart(cart.id);
    await redis_1.ShopCartRedis.set(`cart:user:${req.user.id}`, JSON.stringify(enhancedCart), { EX: CART_TTL_SECONDS });
    return (0, apiResponse_1.sendCreated)(res, enhancedCart, "Item added to cart successfully");
};
exports.addToCart = addToCart;
// PATCH /cart/items/:itemId - Update cart item
const updateCartItem = async (req, res) => {
    const itemId = ensureString(req.params.itemId);
    const parsed = cartSchema_1.updateCartItemSchema.safeParse(req.body);
    if (!parsed.success) {
        throw new AppError_1.ValidationError("Invalid update payload", parsed.error.flatten().fieldErrors);
    }
    const { quantity, selectedOptions, specialRequest } = parsed.data;
    const item = await prisma_1.default.cartItem.findFirst({
        where: { id: itemId, cart: { customerId: req.user.id } },
        include: { cart: true, product: { include: { options: true } }, options: true },
    });
    if (!item)
        throw new AppError_1.NotFoundError("Cart item");
    if (selectedOptions) {
        const invalidOptions = selectedOptions.filter((optId) => !item.product.options.some((opt) => opt.id === optId));
        if (invalidOptions.length > 0) {
            throw new AppError_1.ValidationError("Invalid product options selected", { invalidOptions });
        }
    }
    const updateData = {};
    if (quantity !== undefined)
        updateData.quantity = quantity;
    if (specialRequest !== undefined)
        updateData.specialRequest = specialRequest;
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
    await prisma_1.default.cartItem.update({ where: { id: itemId }, data: updateData });
    if (selectedOptions) {
        await prisma_1.default.cartItemOption.deleteMany({ where: { cartItemId: itemId } });
        const optionData = selectedOptions
            .map((optionId) => {
            const opt = item.product.options.find((o) => o.id === optionId);
            if (!opt)
                return null;
            return { cartItemId: itemId, productOptionId: optionId, name: opt.name, price: opt.price };
        })
            .filter(Boolean);
        if (optionData.length > 0)
            await prisma_1.default.cartItemOption.createMany({ data: optionData });
    }
    const updatedItems = await prisma_1.default.cartItem.findMany({ where: { cartId: item.cart.id } });
    await prisma_1.default.cart.update({ where: { id: item.cart.id }, data: calculateCartTotals(updatedItems) });
    const enhancedCart = await getEnhancedCart(item.cart.id);
    await redis_1.ShopCartRedis.set(`cart:user:${req.user.id}`, JSON.stringify(enhancedCart), { EX: CART_TTL_SECONDS });
    return (0, apiResponse_1.sendSuccess)(res, enhancedCart, "Cart item updated successfully");
};
exports.updateCartItem = updateCartItem;
// DELETE /cart/items/:itemId - Remove item from cart
const removeCartItem = async (req, res) => {
    const itemId = ensureString(req.params.itemId);
    const userId = req.user.id;
    const cacheKey = `cart:user:${userId}`;
    const item = await prisma_1.default.cartItem.findFirst({
        where: { id: itemId, cart: { customerId: userId } },
        include: { cart: true },
    });
    if (!item)
        throw new AppError_1.NotFoundError("Cart item");
    const cartId = item.cart.id;
    await prisma_1.default.cartItem.delete({ where: { id: itemId } });
    const remainingItems = await prisma_1.default.cartItem.count({ where: { cartId } });
    if (remainingItems === 0) {
        await prisma_1.default.cart.delete({ where: { id: cartId } });
        await redis_1.ShopCartRedis.del(cacheKey);
        return (0, apiResponse_1.sendSuccess)(res, { id: null, items: [], basePrice: 0, totalPrice: 0 }, "Cart item removed and cart deleted");
    }
    const updatedItems = await prisma_1.default.cartItem.findMany({ where: { cartId } });
    await prisma_1.default.cart.update({ where: { id: cartId }, data: calculateCartTotals(updatedItems) });
    const enhancedCart = await getEnhancedCart(cartId);
    await redis_1.ShopCartRedis.set(cacheKey, JSON.stringify(enhancedCart), { EX: CART_TTL_SECONDS });
    return (0, apiResponse_1.sendSuccess)(res, enhancedCart, "Cart item removed successfully");
};
exports.removeCartItem = removeCartItem;
// DELETE /cart - Clear entire cart
const clearCart = async (req, res) => {
    const userId = req.user.id;
    const cacheKey = `cart:user:${userId}`;
    const cart = await prisma_1.default.cart.findFirst({ where: { customerId: userId } });
    if (!cart) {
        return (0, apiResponse_1.sendSuccess)(res, { id: null, items: [], basePrice: 0, totalPrice: 0 }, "No active cart to clear");
    }
    await prisma_1.default.cartItem.deleteMany({ where: { cartId: cart.id } });
    await prisma_1.default.cart.delete({ where: { id: cart.id } });
    await redis_1.ShopCartRedis.del(cacheKey);
    return (0, apiResponse_1.sendSuccess)(res, { id: null, items: [], basePrice: 0, totalPrice: 0 }, "Cart cleared successfully");
};
exports.clearCart = clearCart;
// GET /cart/summary - Priced, vendor-grouped breakdown incl. delivery fee.
// New endpoint — update-of-paddi previously had no pricing preview at all
// before committing to checkout, and no delivery fee concept whatsoever.
const getCartSummary = async (req, res) => {
    const userId = req.user.id;
    const addressId = req.query.addressId;
    const promoCode = req.query.promoCode;
    const summary = await (0, cartSummary_service_1.cartSummaryService)({ userId, addressId, promoCode });
    if (summary.vendorBreakdown.length === 0) {
        return (0, apiResponse_1.sendSuccess)(res, { ...summary, summaryId: null }, "Cart is empty or has no purchasable items");
    }
    // Persist a snapshot of exactly what was shown — checkout re-validates
    // against this by id, so the price the customer confirms is always the
    // price they were quoted, not whatever the live cart happens to total
    // to by the time they tap "pay".
    const summaryId = (0, uuid_1.v4)();
    await prisma_1.default.cartSummarySnapshot.create({
        data: { id: summaryId, userId, snapshot: summary },
    });
    return (0, apiResponse_1.sendSuccess)(res, { ...summary, summaryId }, "Cart summary generated");
};
exports.getCartSummary = getCartSummary;
// POST /cart/checkout - Convert cart to order(s), one order per vendor
const checkoutCart = async (req, res) => {
    const userId = req.user.id;
    const cacheKey = `cart:user:${userId}`;
    // Idempotency: a stable client-supplied key means retries (double-tap,
    // network timeout + resend) return the original result instead of
    // creating duplicate orders. If the client doesn't send one, a random
    // key is generated as a fallback so the code path never breaks — but
    // that fallback provides no dedup protection, so the Flutter client
    // should always send a stable Idempotency-Key header per checkout
    // attempt (e.g. generated once when the user taps "Pay" and reused on
    // any automatic retry of that same tap).
    const idempotencyKey = String(req.headers["idempotency-key"] || (0, uuid_1.v4)());
    if (req.headers["idempotency-key"]) {
        const existingOrders = await prisma_1.default.order.findMany({ where: { idempotencyKey, customerId: userId } });
        if (existingOrders.length > 0) {
            return (0, apiResponse_1.sendSuccess)(res, { orders: existingOrders }, "Checkout already processed", 200);
        }
    }
    const { summaryId, addressId } = req.body ?? {};
    if (!summaryId)
        throw new AppError_1.ValidationError("summaryId is required");
    if (!addressId)
        throw new AppError_1.ValidationError("addressId is required");
    const address = await prisma_1.default.address.findFirst({ where: { id: addressId, userId } });
    if (!address)
        throw new AppError_1.NotFoundError("Address");
    const snapshot = await prisma_1.default.cartSummarySnapshot.findUnique({ where: { id: summaryId } });
    if (!snapshot)
        throw new AppError_1.NotFoundError("Cart summary");
    if (snapshot.userId !== userId)
        throw new AppError_1.ConflictError("Unauthorized snapshot access");
    const snapshotAge = Date.now() - new Date(snapshot.createdAt).getTime();
    if (snapshotAge > MAX_SNAPSHOT_AGE_MS) {
        throw new AppError_1.ConflictError("Cart summary has expired. Please refresh your cart.");
    }
    const snapshotData = snapshot.snapshot;
    if (!snapshotData?.vendorBreakdown?.length) {
        throw new AppError_1.ValidationError("Invalid cart summary data");
    }
    const cart = await prisma_1.default.cart.findFirst({
        where: { customerId: userId },
        include: { items: { include: { product: { include: { options: true, vendor: true, productSchedule: true } }, options: true } } },
    });
    if (!cart || cart.items.length === 0)
        throw new AppError_1.ValidationError("Your cart is empty");
    // Archived-item cleanup — remove anything the vendor pulled since it
    // was added, keep the rest.
    const archivedItems = cart.items.filter((item) => item.product.archived);
    if (archivedItems.length > 0) {
        const archivedItemIds = archivedItems.map((i) => i.id);
        const removedProductIds = archivedItems.map((i) => i.productId);
        await prisma_1.default.cartItemOption.deleteMany({ where: { cartItemId: { in: archivedItemIds } } });
        await prisma_1.default.cartItem.deleteMany({ where: { id: { in: archivedItemIds } } });
        const remainingItems = await prisma_1.default.cartItem.count({ where: { cartId: cart.id } });
        if (remainingItems === 0)
            await prisma_1.default.cart.delete({ where: { id: cart.id } });
        const updatedCart = remainingItems > 0 ? await getEnhancedCart(cart.id) : { id: null, items: [] };
        await redis_1.ShopCartRedis.set(cacheKey, JSON.stringify(updatedCart), { EX: CART_TTL_SECONDS });
        throw new AppError_1.ValidationError("Some products in your cart were removed because they're no longer available.", { removedProductIds });
    }
    const now = new Date();
    const liveItems = cart.items.filter((item) => {
        const schedule = item.product.productSchedule;
        const withinSchedule = !schedule || ((!schedule.goLiveAt || schedule.goLiveAt <= now) && (!schedule.takeDownAt || schedule.takeDownAt >= now));
        return item.product.isLive && withinSchedule;
    });
    const offlineItems = cart.items.filter((item) => !liveItems.includes(item));
    if (liveItems.length === 0) {
        throw new AppError_1.ValidationError("No products in your cart are currently live. They remain in your cart until the vendor goes live.");
    }
    // Lock the cart for the duration of checkout — a second concurrent
    // checkout attempt on the same cart (double-tap, two browser tabs)
    // gets rejected instead of racing this one.
    const cartLock = await prisma_1.default.cart.updateMany({ where: { id: cart.id, isLocked: false }, data: { isLocked: true } });
    if (cartLock.count === 0) {
        throw new AppError_1.ConflictError("Checkout already in progress");
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
        const promoCodeUsed = snapshotData.promo?.code;
        const freshSummary = await (0, cartSummary_service_1.cartSummaryService)({ userId, addressId, promoCode: promoCodeUsed });
        if (freshSummary.warnings.length > 0) {
            throw new AppError_1.ValidationError(freshSummary.warnings.join(" "));
        }
        const oldTotal = round(snapshotData.finalTotal);
        const newTotal = round(freshSummary.finalTotal);
        if (oldTotal !== newTotal) {
            throw new AppError_1.ConflictError("Cart pricing changed. Please refresh your cart summary.");
        }
        const vendorPricing = new Map(freshSummary.vendorBreakdown.map((v) => [v.vendorId, v]));
        const groupedByVendor = {};
        for (const item of liveItems) {
            const vId = item.product.vendorId;
            if (!groupedByVendor[vId])
                groupedByVendor[vId] = [];
            groupedByVendor[vId].push(item);
        }
        const createdOrders = [];
        const customer = await prisma_1.default.user.findUnique({ where: { id: userId } });
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
            const order = await prisma_1.default.order.create({
                data: {
                    customerId: userId,
                    vendorId,
                    addressId,
                    basePrice,
                    deliveryFee,
                    totalPrice: round(basePrice + deliveryFee),
                    status: client_1.OrderStatus.AWAITING_PAYMENT,
                    idempotencyKey,
                    protectedUntil: new Date(Date.now() + 15 * 60 * 1000),
                    items: { create: orderItemsData },
                },
                include: { items: { include: { options: true } } },
            });
            createdOrders.push(order);
            await (0, recordActivityBundle_1.recordActivityBundle)({
                actorId: userId,
                orderId: order.id,
                actions: [
                    {
                        type: client_1.ActivityType.GENERAL,
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
            await (0, promoService_1.redeemPromo)(freshSummary.promo.promoId, userId, createdOrders.map((o) => o.id), freshSummary.promo.code, freshSummary.discount).catch((err) => logger_1.logger.warn({ err, promoId: freshSummary.promo.promoId }, "Failed to record promo redemption (orders already created successfully)"));
        }
        if (liveItems.length > 0) {
            await prisma_1.default.cartItemOption.deleteMany({ where: { cartItemId: { in: liveItems.map((i) => i.id) } } });
            await prisma_1.default.cartItem.deleteMany({ where: { id: { in: liveItems.map((i) => i.id) } } });
        }
        if (offlineItems.length === 0) {
            await prisma_1.default.cart.delete({ where: { id: cart.id } });
        }
        // Snapshot is single-use — once consumed by a successful checkout it
        // can't be replayed to create a second set of orders.
        await prisma_1.default.cartSummarySnapshot.delete({ where: { id: summaryId } }).catch(() => { });
        const updatedCart = offlineItems.length > 0 ? await getEnhancedCart(cart.id) : { id: null, items: [], basePrice: 0, totalPrice: 0 };
        await redis_1.ShopCartRedis.set(cacheKey, JSON.stringify(updatedCart), { EX: CART_TTL_SECONDS });
        return (0, apiResponse_1.sendCreated)(res, { orders: createdOrders, cart: updatedCart }, "Checkout successful");
    }
    finally {
        // Always release the lock, whether checkout succeeded, failed
        // validation, or threw unexpectedly.
        await prisma_1.default.cart.updateMany({ where: { id: cart.id }, data: { isLocked: false } }).catch((err) => {
            logger_1.logger.error({ err, cartId: cart.id }, "Failed to release cart lock");
        });
    }
};
exports.checkoutCart = checkoutCart;
// Helper: Get enhanced cart data (product info, live/offline status, priced options)
async function getEnhancedCart(cartId) {
    const cart = await prisma_1.default.cart.findUnique({
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
    if (!cart)
        return null;
    const now = new Date();
    const enrichedItems = cart.items.map((item) => {
        const selectedOptionIds = item.options.map((opt) => opt.productOptionId);
        const product = item.product;
        const schedule = product.productSchedule;
        const withinSchedule = !schedule || ((!schedule.goLiveAt || schedule.goLiveAt <= now) && (!schedule.takeDownAt || schedule.takeDownAt >= now));
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
