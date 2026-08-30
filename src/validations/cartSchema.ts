import { z } from "zod";

const MAX_QTY = Number(process.env.MAX_CART_ITEM_QTY) || 99;

// Schema for adding an item to cart
export const addToCartSchema = z.object({
  productId: z.string().uuid(),
  quantity: z.number().int().min(1).max(MAX_QTY).optional(), // defaults to 1, capped to prevent DoS/overflow
  selectedOptions: z.array(z.string().uuid()).optional(),
  specialRequest: z.string().max(500).optional(), // optional note
});

// Schema for updating a cart item
export const updateCartItemSchema = z.object({
  quantity: z.number().int().min(1).max(MAX_QTY).optional(),
  selectedOptions: z.array(z.string().uuid()).optional(),
  specialRequest: z.string().max(500).optional(),
});
