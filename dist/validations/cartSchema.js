"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.updateCartItemSchema = exports.addToCartSchema = void 0;
const zod_1 = require("zod");
// Schema for adding an item to cart
exports.addToCartSchema = zod_1.z.object({
    productId: zod_1.z.string().uuid(),
    quantity: zod_1.z.number().int().min(1).optional(), // defaults to 1
    selectedOptions: zod_1.z.array(zod_1.z.string().uuid()).optional(),
    specialRequest: zod_1.z.string().max(500).optional(), // optional note
});
// Schema for updating a cart item
exports.updateCartItemSchema = zod_1.z.object({
    quantity: zod_1.z.number().int().min(0).optional(), // allow 0 (edge case: remove item)
    selectedOptions: zod_1.z.array(zod_1.z.string().uuid()).optional(),
    specialRequest: zod_1.z.string().max(500).optional(),
});
