import { z } from "zod";

// Schema for adding an item to cart
export const addToCartSchema = z.object({
  productId: z.string().uuid(),
  quantity: z.number().int().min(1).optional(), // defaults to 1
  selectedOptions: z.array(z.string().uuid()).optional(),
  specialRequest: z.string().max(500).optional(), // optional note
});

// Schema for updating a cart item
export const updateCartItemSchema = z.object({
  quantity: z.number().int().min(0).optional(), // allow 0 (edge case: remove item)
  selectedOptions: z.array(z.string().uuid()).optional(),
  specialRequest: z.string().max(500).optional(),
});
