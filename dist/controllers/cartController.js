"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.clearCart = exports.removeCartItem = exports.checkoutCart = exports.updateCartItem = exports.addToCart = exports.getCart = void 0;
const prisma_1 = __importDefault(require("../lib/prisma"));
const client_1 = require("@prisma/client");
const recordActivityBundle_1 = require("../utils/activityUtils/recordActivityBundle");
const cartSchema_1 = require("../validations/cartSchema");
const redis_1 = require("../lib/redis");
const codeMessage_1 = require("../validators/codeMessage");
// Helper: Calculate cart totals
const calculateCartTotals = (items) => {
    const basePrice = items.reduce((sum, item) => sum + (item.unitPrice * item.quantity), 0);
    return {
        basePrice,
        totalPrice: basePrice
    };
};
const CART_TTL_SECONDS = 3600; // 1 hour
// GET /cart - Get current cart
const getCart = async (req, res) => {
    try {
        const userId = req.user.id;
        // 1️⃣ Try Redis cache first
        const cacheKey = `cart:user:${userId}`;
        const cachedCart = await redis_1.ShopCartRedis.get(cacheKey);
        if (cachedCart) {
            return res.json((0, codeMessage_1.successResponse)("CART_FETCHED", "Cart retrieved successfully (cache)", JSON.parse(cachedCart)));
        }
        // 2️⃣ Fetch cart from DB
        const cart = await prisma_1.default.cart.findFirst({
            where: { customerId: userId },
            include: {
                items: {
                    include: {
                        product: {
                            include: {
                                options: true, // all product options
                                vendor: { select: { id: true, name: true } },
                                productSchedule: true
                            },
                        },
                        options: { include: { productOption: true } }, // user-selected options
                    },
                },
            },
        });
        // 3️⃣ If no cart exists, return empty cart structure
        const enrichedCart = cart
            ? await getEnhancedCart(cart.id)
            : { id: null, items: [], basePrice: 0, totalPrice: 0 };
        if (enrichedCart && enrichedCart.items.length > 0) {
            await redis_1.ShopCartRedis.set(cacheKey, JSON.stringify(enrichedCart), { EX: CART_TTL_SECONDS });
        }
        // 4️⃣ Save cart to Redis with TTL
        // 5️⃣ Return cart
        res.json((0, codeMessage_1.successResponse)("CART_FETCHED", "Cart retrieved successfully", enrichedCart));
    }
    catch (error) {
        console.error("Get cart error:", error);
        res.status(500).json((0, codeMessage_1.errorResponse)("CART_FETCH_FAILED", "Failed to retrieve cart"));
    }
};
exports.getCart = getCart;
const addToCart = async (req, res) => {
    try {
        // ✅ Validate input with Zod
        const parsed = cartSchema_1.addToCartSchema.safeParse(req.body);
        if (!parsed.success) {
            return res.status(422).json((0, codeMessage_1.errorResponse)("INVALID_INPUT", parsed.error.message));
        }
        const { productId, quantity = 1, selectedOptions = [], specialRequest } = parsed.data;
        // Validate product exists
        const product = await prisma_1.default.product.findUnique({
            where: { id: productId },
            include: { options: true, vendor: true },
        });
        if (!product) {
            return res.status(404).json((0, codeMessage_1.errorResponse)("PRODUCT_NOT_FOUND", "Product not found"));
        }
        // Reject if product unavailable
        if (product.archived) {
            return res.status(400).json((0, codeMessage_1.errorResponse)("PRODUCT_UNAVAILABLE", "Product is out of stock"));
        }
        // Validate selected options
        const invalidOptions = selectedOptions.filter((optId) => !product.options.some(opt => opt.id === optId));
        if (invalidOptions.length > 0) {
            return res.status(400).json((0, codeMessage_1.errorResponse)("INVALID_OPTIONS", "Invalid product options selected", { invalidOptions }));
        }
        // Get or create cart
        let cart = await prisma_1.default.cart.findFirst({
            where: { customerId: req.user.id },
            include: { items: true },
        });
        if (!cart) {
            cart = await prisma_1.default.cart.create({
                data: { customerId: req.user.id },
                include: { items: true },
            });
        }
        // Calculate item price with options
        const optionsPrice = product.options
            .filter(opt => selectedOptions.includes(opt.id))
            .reduce((sum, opt) => sum + opt.price, 0);
        const unitPrice = product.price + optionsPrice;
        const subtotal = unitPrice * quantity;
        // Check if product already in cart
        const existingItem = cart.items.find(item => item.productId === productId);
        if (existingItem) {
            // Update existing item
            await prisma_1.default.cartItem.update({
                where: { id: existingItem.id },
                data: {
                    quantity: existingItem.quantity + quantity,
                    unitPrice,
                    subtotal,
                    specialRequest: specialRequest ?? existingItem.specialRequest,
                },
            });
            // Update options
            await prisma_1.default.cartItemOption.deleteMany({
                where: { cartItemId: existingItem.id },
            });
            await prisma_1.default.cartItemOption.createMany({
                data: selectedOptions.map(optionId => ({
                    cartItemId: existingItem.id,
                    productOptionId: optionId,
                    name: product.options.find(opt => opt.id === optionId).name,
                    price: product.options.find(opt => opt.id === optionId).price,
                })),
            });
        }
        else {
            // Create new cart item
            await prisma_1.default.cartItem.create({
                data: {
                    cartId: cart.id,
                    productId,
                    quantity,
                    unitPrice,
                    subtotal,
                    options: {
                        create: selectedOptions.map(optionId => ({
                            productOptionId: optionId,
                            name: product.options.find(opt => opt.id === optionId).name,
                            price: product.options.find(opt => opt.id === optionId).price,
                        })),
                    },
                    specialRequest,
                },
            });
        }
        // Recalculate cart totals
        const updatedItems = await prisma_1.default.cartItem.findMany({
            where: { cartId: cart.id },
        });
        const totals = calculateCartTotals(updatedItems);
        await prisma_1.default.cart.update({
            where: { id: cart.id },
            data: totals,
        });
        // ✅ Return uniform success response
        const enhancedCart = await getEnhancedCart(cart.id);
        const cacheKey = `cart:user:${req.user.id}`;
        await redis_1.ShopCartRedis.set(cacheKey, JSON.stringify(enhancedCart), { EX: CART_TTL_SECONDS });
        res.json((0, codeMessage_1.successResponse)("CART_ITEM_ADDED", "Item added to cart successfully", enhancedCart));
    }
    catch (error) {
        console.error("Add to cart error:", error);
        res.status(500).json((0, codeMessage_1.errorResponse)("CART_ADD_FAILED", "Failed to add item to cart"));
    }
};
exports.addToCart = addToCart;
// PUT /cart/items/:itemId - Update cart item
const updateCartItem = async (req, res) => {
    try {
        const { itemId } = req.params;
        const { quantity, selectedOptions, specialRequest } = req.body;
        // Validate cart item belongs to user
        const item = await prisma_1.default.cartItem.findFirst({
            where: {
                id: itemId,
                cart: { customerId: req.user.id }
            },
            include: {
                cart: true,
                product: {
                    include: { options: true }
                },
                options: true
            }
        });
        if (!item) {
            return res.status(404).json((0, codeMessage_1.errorResponse)("CART_ITEM_NOT_FOUND", "Cart item not found"));
        }
        // Validate options if provided
        if (selectedOptions) {
            const invalidOptions = selectedOptions.filter((optId) => !item.product.options.some(opt => opt.id === optId));
            if (invalidOptions.length > 0) {
                return res.status(400).json((0, codeMessage_1.errorResponse)("INVALID_OPTIONS", "Invalid product options selected", { invalidOptions }));
            }
        }
        // Prepare update object dynamically
        const updateData = {};
        if (quantity !== undefined)
            updateData.quantity = quantity;
        if (specialRequest !== undefined)
            updateData.specialRequest = specialRequest;
        // Recalculate price if quantity or options change
        if (quantity !== undefined || selectedOptions) {
            const finalOptions = selectedOptions || item.options.map(opt => opt.productOptionId);
            const optionsPrice = item.product.options
                .filter(opt => finalOptions.includes(opt.id))
                .reduce((sum, opt) => sum + opt.price, 0);
            const unitPrice = item.product.price + optionsPrice;
            const subtotal = unitPrice * (quantity ?? item.quantity);
            updateData.unitPrice = unitPrice;
            updateData.subtotal = subtotal;
        }
        // Update cart item
        await prisma_1.default.cartItem.update({
            where: { id: itemId },
            data: updateData
        });
        // Update options if changed
        if (selectedOptions) {
            await prisma_1.default.cartItemOption.deleteMany({
                where: { cartItemId: itemId }
            });
            await prisma_1.default.cartItemOption.createMany({
                data: selectedOptions.map((optionId) => ({
                    cartItemId: itemId,
                    productOptionId: optionId,
                    name: item.product.options.find(opt => opt.id === optionId).name,
                    price: item.product.options.find(opt => opt.id === optionId).price
                }))
            });
        }
        // Recalculate cart totals
        const updatedItems = await prisma_1.default.cartItem.findMany({
            where: { cartId: item.cart.id }
        });
        const totals = calculateCartTotals(updatedItems);
        await prisma_1.default.cart.update({
            where: { id: item.cart.id },
            data: totals
        });
        // ✅ Return uniform success response
        const enhancedCart = await getEnhancedCart(item.cart.id);
        const cacheKey = `cart:user:${req.user.id}`; // backticks!
        await redis_1.ShopCartRedis.set(cacheKey, JSON.stringify(enhancedCart), { EX: CART_TTL_SECONDS });
        res.json((0, codeMessage_1.successResponse)("CART_ITEM_UPDATED", "Cart item updated successfully", enhancedCart));
    }
    catch (error) {
        console.error("Update cart item error:", error);
        res.status(500).json((0, codeMessage_1.errorResponse)("CART_UPDATE_FAILED", "Failed to update cart item"));
    }
};
exports.updateCartItem = updateCartItem;
// POST  convert to order 
const checkoutCart = async (req, res) => {
    try {
        const userId = req.user.id;
        const cacheKey = `cart:user:${userId}`;
        const customer = await prisma_1.default.user.findUnique({ where: { id: userId } });
        const customerName = customer?.name || "Unknown Customer";
        // 🛒 1. Fetch cart with items, product, options, vendor, and schedule
        const cart = await prisma_1.default.cart.findFirst({
            where: { customerId: userId },
            include: {
                items: {
                    include: {
                        product: {
                            include: {
                                options: true,
                                vendor: true,
                                productSchedule: true
                            }
                        },
                        options: true
                    }
                }
            }
        });
        if (!cart || cart.items.length === 0) {
            return res.status(400).json((0, codeMessage_1.errorResponse)("CART_EMPTY", "Your cart is empty"));
        }
        const now = new Date();
        // 🔹 2. Split items: live vs offline and archived
        const archivedItems = cart.items.filter(item => item.product.archived);
        if (archivedItems.length > 0) {
            const archivedItemIds = archivedItems.map(i => i.id);
            const removedProductIds = archivedItems.map(i => i.productId);
            // 🧹 1. Delete related cart item options first
            await prisma_1.default.cartItemOption.deleteMany({
                where: { cartItemId: { in: archivedItemIds } },
            });
            // 🗑️ 2. Delete archived cart items
            await prisma_1.default.cartItem.deleteMany({
                where: { id: { in: archivedItemIds } },
            });
            // 🧮 3. If cart now has no items, delete it completely
            const remainingItems = await prisma_1.default.cartItem.count({
                where: { cartId: cart.id },
            });
            if (remainingItems === 0) {
                await prisma_1.default.cart.delete({ where: { id: cart.id } });
            }
            // 🔁 4. Update Redis cache with current state
            const updatedCart = remainingItems > 0 ? await getEnhancedCart(cart.id) : { id: null, items: [] };
            await redis_1.ShopCartRedis.set(cacheKey, JSON.stringify(updatedCart), { EX: 3600 });
            // 🚫 5. Return response
            return res.status(400).json((0, codeMessage_1.errorResponse)("PRODUCT_ARCHIVED", "Some products in your cart were removed because they’re no longer available.", { removedProductIds }));
        }
        const liveItems = cart.items.filter(item => {
            const p = item.product;
            const schedule = p.productSchedule;
            // Product must be live and within schedule window if exists
            const withinSchedule = !schedule || ((!schedule.goLiveAt || schedule.goLiveAt <= now) &&
                (!schedule.takeDownAt || schedule.takeDownAt >= now));
            return p.isLive && withinSchedule;
        });
        const offlineItems = cart.items.filter(item => !liveItems.includes(item));
        if (liveItems.length === 0) {
            return res.status(400).json((0, codeMessage_1.errorResponse)("NO_LIVE_PRODUCTS", "No products in your cart are currently live. They remain in your cart until the vendor goes live."));
        }
        // 🧩 3. Group live items by vendorId (1 order per vendor)
        const groupedByVendor = {};
        for (const item of liveItems) {
            const vId = item.product.vendorId;
            if (!groupedByVendor[vId])
                groupedByVendor[vId] = [];
            groupedByVendor[vId].push(item);
        }
        const createdOrders = [];
        // 🧾 4. Create one order per vendor
        for (const [vendorId, vendorItems] of Object.entries(groupedByVendor)) {
            const orderItemsData = vendorItems.map(ci => ({
                productId: ci.productId,
                quantity: ci.quantity,
                unitPrice: ci.unitPrice,
                subtotal: ci.subtotal,
                // specialRequest: ci.specialRequest || null,
                options: {
                    create: ci.options.map(opt => ({
                        optionId: opt.productOptionId,
                        name: opt.name,
                        price: opt.price
                    }))
                }
            }));
            const basePrice = orderItemsData.reduce((sum, i) => sum + i.subtotal, 0);
            const order = await prisma_1.default.order.create({
                data: {
                    customerId: userId,
                    vendorId,
                    basePrice,
                    totalPrice: basePrice,
                    status: client_1.OrderStatus.AWAITING_PAYMENT, // ← change this
                    items: { create: orderItemsData }
                },
                include: { items: { include: { options: true } } }
            });
            createdOrders.push(order);
            // Notify vendor & record activity
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
                            route: `/orders/${order.id}`, // 🌐 Web route (for website)
                            target: {
                                screen: "order_detail", // 📱 Flutter route name
                                id: order.id
                            },
                            orderId: order.id,
                            customerId: userId,
                            vendorId: vendorId,
                            frontendEvent: "NEW_ORDER"
                        }
                    }
                ],
                audit: {
                    action: "ORDER_CREATED",
                    metadata: {
                        orderId: order.id,
                        customerId: userId,
                        vendorId: vendorId
                    }
                },
                notifyRealtime: true,
                notifyPush: true
            });
        }
        // 🔹 5. Remove only live items from cart (keep offline items)
        if (liveItems.length > 0) {
            await prisma_1.default.cartItemOption.deleteMany({ where: { cartItemId: { in: liveItems.map(i => i.id) } } });
            await prisma_1.default.cartItem.deleteMany({ where: { id: { in: liveItems.map(i => i.id) } } });
        }
        // If cart has remaining offline items, keep cart; otherwise, delete
        if (offlineItems.length === 0) {
            await prisma_1.default.cart.delete({ where: { id: cart.id } });
        }
        // ✅ Update Redis cache
        const updatedCart = offlineItems.length > 0
            ? await getEnhancedCart(cart.id)
            : { id: null, items: [], basePrice: 0, totalPrice: 0 };
        await redis_1.ShopCartRedis.set(cacheKey, JSON.stringify(updatedCart), { EX: 3600 });
        res.status(201).json((0, codeMessage_1.successResponse)("CHECKOUT_SUCCESS", "Checkout successful", { orders: createdOrders, cart: updatedCart }));
    }
    catch (error) {
        console.error("Checkout error:", error);
        res.status(500).json((0, codeMessage_1.errorResponse)("CHECKOUT_FAILED", "Failed to checkout cart"));
    }
};
exports.checkoutCart = checkoutCart;
// DELETE /cart/items/:itemId - Remove item from cart
const removeCartItem = async (req, res) => {
    try {
        const { itemId } = req.params;
        const userId = req.user.id;
        // Validate cart item belongs to user
        const item = await prisma_1.default.cartItem.findFirst({
            where: {
                id: itemId,
                cart: { customerId: userId }
            },
            include: { cart: true }
        });
        if (!item) {
            return res.status(404).json((0, codeMessage_1.errorResponse)("CART_ITEM_NOT_FOUND", "Cart item not found"));
        }
        const cartId = item.cart.id;
        // Delete item
        await prisma_1.default.cartItem.delete({ where: { id: itemId } });
        // Check if cart is now empty
        const remainingItems = await prisma_1.default.cartItem.count({ where: { cartId } });
        const cacheKey = `cart:user:${userId}`;
        if (remainingItems === 0) {
            await prisma_1.default.cart.delete({ where: { id: cartId } });
            // Remove cart from Redis
            await redis_1.ShopCartRedis.del(cacheKey);
            return res.json((0, codeMessage_1.successResponse)("CART_EMPTY", "Cart item removed and cart deleted", { id: null, items: [], basePrice: 0, totalPrice: 0 }));
        }
        // Recalculate totals if cart still has items
        const updatedItems = await prisma_1.default.cartItem.findMany({ where: { cartId } });
        const totals = calculateCartTotals(updatedItems);
        await prisma_1.default.cart.update({ where: { id: cartId }, data: totals });
        // Update Redis
        const enhancedCart = await getEnhancedCart(cartId);
        await redis_1.ShopCartRedis.set(cacheKey, JSON.stringify(enhancedCart), { EX: CART_TTL_SECONDS });
        res.json((0, codeMessage_1.successResponse)("CART_ITEM_REMOVED", "Cart item removed successfully", enhancedCart));
    }
    catch (error) {
        console.error("Remove cart item error:", error);
        res.status(500).json((0, codeMessage_1.errorResponse)("CART_REMOVE_FAILED", "Failed to remove cart item"));
    }
};
exports.removeCartItem = removeCartItem;
// DELETE /cart - Clear entire cart
const clearCart = async (req, res) => {
    try {
        const userId = req.user.id;
        const cacheKey = `cart:user:${userId}`;
        const cart = await prisma_1.default.cart.findFirst({
            where: { customerId: req.user.id }
        });
        if (!cart) {
            return res.json({ message: "No active cart to clear" });
        }
        await prisma_1.default.cartItem.deleteMany({
            where: { cartId: cart.id }
        });
        await prisma_1.default.cart.delete({
            where: { id: cart.id }
        });
        // ✅ Clear Redis cache
        await redis_1.ShopCartRedis.del(cacheKey);
        res.json((0, codeMessage_1.successResponse)("CART_CLEARED", "Cart cleared successfully", { id: null, items: [], basePrice: 0, totalPrice: 0 }));
    }
    catch (error) {
        console.error("Clear cart error:", error);
        res.status(500).json({ error: "Failed to clear cart" });
    }
};
exports.clearCart = clearCart;
// Helper: Get enhanced cart data
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
                            productSchedule: true // include schedule to check live window
                        }
                    },
                    options: { include: { productOption: true } }
                }
            }
        }
    });
    if (!cart)
        return null;
    const now = new Date();
    const enrichedItems = cart.items.map(item => {
        const selectedOptionIds = item.options.map(opt => opt.productOptionId);
        const product = item.product;
        const schedule = product.productSchedule;
        // Determine if the product is currently live
        const withinSchedule = !schedule || ((!schedule.goLiveAt || schedule.goLiveAt <= now) &&
            (!schedule.takeDownAt || schedule.takeDownAt >= now));
        const productonline = product.isLive && withinSchedule;
        return {
            id: item.id,
            productId: item.productId,
            quantity: item.quantity,
            unitPrice: item.unitPrice,
            subtotal: item.unitPrice * item.quantity,
            specialRequest: item.specialRequest || null,
            productonline, // NEW: true if product is live and can be ordered
            product: {
                id: product.id,
                name: product.name,
                price: product.price,
                image: product.images,
                vendor: {
                    id: product.vendor.id,
                    name: product.vendor.name
                },
                options: product.options.map(opt => ({
                    id: opt.id,
                    name: opt.name,
                    price: opt.price,
                    selected: selectedOptionIds.includes(opt.id)
                }))
            },
            selectedOptions: item.options.map(opt => ({
                id: opt.id,
                cartItemId: opt.cartItemId,
                productOptionId: opt.productOptionId,
                name: opt.productOption.name,
                price: opt.productOption.price
            }))
        };
    });
    return {
        id: cart.id,
        items: enrichedItems,
        basePrice: cart.basePrice,
        totalPrice: cart.totalPrice
    };
}
