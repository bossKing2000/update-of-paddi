import { z } from "zod";
import { normalizeOptionName } from "../services/optionName";

// Stable DishType id (e.g. "JOLLOF", "OFADA", "OTHER"). Existence +
// active-state are verified service-side against the DishType table;
// this only enforces shape so vendors cannot inject arbitrary values.
export const dishTypeIdSchema = z
  .string()
  .trim()
  .min(1, "Dish type is required")
  .max(40)
  .regex(/^[A-Z0-9_]+$/, "Invalid dish type format");

// Phase 2 M2: canonical tag id (e.g. "SPICY", "VEGAN"). Same shape rule
// as dishType ids. Existence + active-state are verified service-side
// (resolveActiveTagIds) — vendors attach existing rows, never free text.
export const tagIdSchema = z
  .string()
  .trim()
  .min(1, "Tag is required")
  .max(40)
  .regex(/^[A-Z0-9_]+$/, "Invalid tag format");

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

// Phase 2B.1: nested structured add-on input used inside product create /
// update. Mirrors createOptionGroupSchema / createOptionGroupItemSchema field
// validation, but allows `id` (for update-by-id) and an `items` array. When a
// group is supplied to an update with an `id`, that existing group is updated;
// groups without an `id` are created. Groups/items not mentioned in an update
// array are left untouched (omitted = preserve), matching the existing
// tagIds convention. Cross-product group/item ids are rejected by the
// database scoping (nested writes are scoped to the parent product) and by
// the explicit ownership pre-check in the controller.
//
// Selection limits (min<=max, required->min>=1) mirror the standalone group
// schemas; group/item name uniqueness per product (case-insensitive) is
// enforced by the product-schema refine below.
const optionGroupItemNestedSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(60),
  priceAdd: z.coerce
    .number()
    .refine((n) => Number.isFinite(n), { message: "priceAdd must be a finite number" })
    .refine((n) => Math.abs(n) <= 1000000, { message: "priceAdd is out of range" }),
  isActive: z.boolean().optional().default(true),
  sortOrder: z.coerce.number().int().min(0).max(1000000).optional().default(0),
});

const optionGroupNestedSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(60),
  required: z.boolean(),
  minSelections: z.coerce.number().int().min(0).max(100),
  maxSelections: z.coerce.number().int().min(0).max(100),
  sortOrder: z.coerce.number().int().min(0).max(1000000).optional().default(0),
  items: z.array(optionGroupItemNestedSchema).optional().default([]),
})
  .refine(
    (v) => v.minSelections <= v.maxSelections,
    { message: "minSelections must not exceed maxSelections", path: ["maxSelections"] },
  )
  .refine(
    (v) => v.required !== true || v.minSelections >= 1,
    { message: "A required group must have minSelections >= 1", path: ["minSelections"] },
  );

// Enforce group + item name uniqueness per product (case-insensitive),
// mirroring the legacy ProductOption "add-on names must be unique per product"
// convention so customers can tell add-ons apart at a glance.
// Comparison uses the canonical `normalizeOptionName` (trim + lowercase) so the
// within-request check cannot drift from the live write path or the migration.
function uniqueOptionGroupNames(data: {
  optionGroups?: unknown;
}): boolean {
  const groups: Array<{ name: string; items?: unknown }> =
    (data.optionGroups as Array<{ name: string; items?: unknown }>) ?? [];
  const groupNames = groups.map((g) => normalizeOptionName(g.name));
  if (new Set(groupNames).size !== groupNames.length) return false;
  for (const g of groups) {
    const itemNames = ((g.items ?? []) as Array<{ name: string }>).map((i) =>
      normalizeOptionName(i.name),
    );
    if (new Set(itemNames).size !== itemNames.length) return false;
  }
  return true;
}

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
  // Phase 2B.1: structured add-on groups + items, created atomically with
  // the product. Each entry must be complete (no `id` — these are new rows).
  // Omitted = no groups.
  optionGroups: z.array(optionGroupNestedSchema).optional(),
  // Phase 2 M2: optional canonical tag assignment. Omitted = leave
  // untouched (create: none). Never free text — ids are resolved
  // server-side against active Tag rows.
  tagIds: z.array(tagIdSchema).max(20).optional(),
})
  .refine(
    uniqueOptionGroupNames,
    {
      message: "Group and item names must be unique per product",
      path: ["optionGroups"],
    },
  );

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

  // Phase 2 M2: omitted = leave associations unchanged; explicit [] =
  // remove all; a new array replaces the existing set wholesale.
  tagIds: z.array(tagIdSchema).max(20).optional(),
  // Phase 2B.1: structured add-on groups + items. Omitted = leave existing
  // groups untouched. When supplied, each entry with an `id` updates that
  // existing group (scoped to this product), entries without an `id` are
  // created, and groups/items not mentioned are preserved (not deleted).
  // Use the standalone option-group endpoints to delete groups/items.
  optionGroups: z.array(optionGroupNestedSchema).optional(),
})
  .refine(
    uniqueOptionGroupNames,
    {
      message: "Group and item names must be unique per product",
      path: ["optionGroups"],
    },
  );

// Phase 2B.3: structured add-on groups. min<=max and required→min>=1 are
// enforced here; productId reassignment is not representable (no field).
const optionGroupBase = z.object({
  name: z.string().trim().min(1).max(60),
  required: z.boolean(),
  minSelections: z.coerce.number().int().min(0).max(100),
  maxSelections: z.coerce.number().int().min(0).max(100),
  sortOrder: z.coerce.number().int().min(0).max(1000000).optional().default(0),
});

function withSelectionInvariants<T extends z.ZodTypeAny>(schema: T) {
  return schema
    .refine((v: any) => v.minSelections === undefined || v.maxSelections === undefined || v.minSelections <= v.maxSelections, {
      message: "minSelections must not exceed maxSelections",
    })
    .refine((v: any) => v.required !== true || v.minSelections === undefined || v.minSelections >= 1, {
      message: "A required group must have minSelections >= 1",
    });
}

export const createOptionGroupSchema = withSelectionInvariants(optionGroupBase);

export const updateOptionGroupSchema = withSelectionInvariants(
  z.object({
    name: z.string().trim().min(1).max(60).optional(),
    required: z.boolean().optional(),
    minSelections: z.coerce.number().int().min(0).max(100).optional(),
    maxSelections: z.coerce.number().int().min(0).max(100).optional(),
    sortOrder: z.coerce.number().int().min(0).max(1000000).optional(),
  }),
);

// priceAdd is a surcharge in the existing Float/naira convention (same as
// legacy ProductOption.price). Negative values are representable per the
// approved model; bounds mirror the product-option price ceiling.
const optionGroupItemBase = z.object({
  name: z.string().trim().min(1).max(60),
  priceAdd: z.coerce
    .number()
    .refine((n) => Number.isFinite(n), { message: "priceAdd must be a finite number" })
    .refine((n) => Math.abs(n) <= 1000000, { message: "priceAdd is out of range" }),
  isActive: z.boolean().optional().default(true),
  sortOrder: z.coerce.number().int().min(0).max(1000000).optional().default(0),
});

export const createOptionGroupItemSchema = optionGroupItemBase;

export const updateOptionGroupItemSchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  priceAdd: z.coerce
    .number()
    .refine((n) => Number.isFinite(n), { message: "priceAdd must be a finite number" })
    .refine((n) => Math.abs(n) <= 1000000, { message: "priceAdd is out of range" })
    .optional(),
  isActive: z.boolean().optional(),
  sortOrder: z.coerce.number().int().min(0).max(1000000).optional(),
});