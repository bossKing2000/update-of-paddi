import { availableMemory } from "process";
import { z } from "zod";

// Stable DishType id (e.g. "JOLLOF", "OFADA", "OTHER"). Existence +
// active-state are verified service-side against the DishType table;
// this only enforces shape so vendors cannot inject arbitrary values.
export const dishTypeIdSchema = z
  .string()
  .trim()
  .min(1, "Dish type is required")
  .max(40)
  .regex(/^[A-Z0-9_]+$/, "Invalid dish type format");

export const portionLabelSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .optional();

export const stockSchema = z.coerce.number().int().min(0).max(1000000).optional();

const productOptionInputSchema = z.object({
  name: z.string().trim().min(1).max(60),
  price: z.coerce.number().positive().max(1000000),
});

export const createProductSchema = z.object({
  name: z.string().trim().min(3).max(120),
  description: z.string().trim().min(5).max(2000),
  price: z.coerce.number().positive().max(10000000),
  dishTypeId: dishTypeIdSchema,
  portionLabel: portionLabelSchema,
  trackInventory: z
    .union([z.boolean(), z.enum(["true", "false", "0", "1"])])
    .transform((val) => {
      if (typeof val === "boolean") return val;
      if (val === "true" || val === "1") return true;
      return false;
    })
    .optional()
    .default(false),
  stock: stockSchema,
  archived: z
    .union([z.boolean(), z.enum(["true", "false", "0", "1"])])
    .transform((val) => {
      if (typeof val === "boolean") return val;
      if (val === "true" || val === "1") return true;
      if (val === "false" || val === "0") return false;
      return false; // default
    })
    .optional()
    .default(false),
  images: z.array(z.string().min(1)).optional(),
  video: z.array(z.string()).optional(),
  options: z.array(productOptionInputSchema).max(20).optional(),
});

export const archiveProductSchema = z.object({
  archived: z.boolean(),
});

export const reviewProductSchema = z.object({
  productId: z.string().uuid(),
  rating: z.coerce.number().min(1).max(5),
  comment: z.string().optional(),
});

// ✍️ Reply to review (vendor only)
export const replyToReviewSchema = z.object({
  reviewId: z.string().uuid(),
  message: z.string().min(2, "Reply must be at least 2 characters long"),
});

// 👍 Vote helpful or not
export const reviewVoteSchema = z.object({
  reviewId: z.string().uuid(),
  isHelpful: z.boolean(),
});

// ⚠️ Report a review for abuse or spam
export const reportReviewSchema = z.object({
  reviewId: z.string().uuid(),
  reason: z.string().min(3, "Please provide a reason"),
});

export const reviewSummaryQuerySchema = z.object({
  page: z
    .string()
    .optional()
    .transform(Number)
    .refine((n) => !isNaN(n) && n > 0, {
      message: "Page must be a positive number",
    })
    .optional(),
  limit: z
    .string()
    .optional()
    .transform(Number)
    .refine((n) => !isNaN(n) && n > 0, {
      message: "Limit must be a positive number",
    })
    .optional(),
});

export const createVendorReviewSchema = z.object({
  vendorId: z.string().uuid(),
  rating: z.number().min(1).max(5),
  comment: z.string().optional(),
});

// Update product schema (only define once!)
export const updateProductSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  description: z.string().trim().min(1).max(2000).optional(),
  price: z.coerce.number().positive().max(10000000).optional(),
  dishTypeId: dishTypeIdSchema.optional(),
  portionLabel: z.string().trim().min(1).max(80).nullable().optional(),
  trackInventory: z
    .union([z.boolean(), z.enum(["true", "false", "0", "1"])])
    .transform((val) => {
      if (typeof val === "boolean") return val;
      if (val === "true" || val === "1") return true;
      return false;
    })
    .optional(),
  stock: z.coerce.number().int().min(0).max(1000000).nullable().optional(),

  // For backward compatibility - old format
  images: z.array(z.string().url()).optional(),
  video: z.array(z.string().url()).optional(),

  // New: Smart update format
  imageUpdates: z
    .object({
      keep: z.array(z.string().url()).optional().default([]),
      delete: z.array(z.string().url()).optional().default([]),
    })
    .optional(),

  archived: z
    .union([
      z.boolean(),
      z
        .string()
        .refine((val) => val === "true" || val === "false", {
          message: "Archived must be 'true' or 'false' string",
        })
        .transform((val) => val === "true"),
      z.enum(["true", "false"]).transform((val) => val === "true"),
    ])
    .optional(),

  videoUpdates: z
    .object({
      keep: z.string().url().optional(),
      delete: z.boolean().optional().default(false),
    })
    .optional(),

  options: z
    .array(
      productOptionInputSchema.extend({
        id: z.string().uuid().optional(),
        isActive: z.boolean().optional(),
      }),
    )
    .max(20)
    .optional(),
});
