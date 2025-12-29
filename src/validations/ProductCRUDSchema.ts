import { availableMemory } from "process";
import { z } from "zod";
import { Category } from "@prisma/client";


export const createProductSchema = z.object({
  name: z.string().min(3),
  description: z.string().min(5),
  price: z.coerce.number().positive(),
  category: z.nativeEnum(Category),
  archived: z
    .union([z.boolean(), z.enum(['true', 'false', '0', '1'])])
    .transform((val) => {
      if (typeof val === 'boolean') return val;
      if (val === 'true' || val === '1') return true;
      if (val === 'false' || val === '0') return false;
      return false; // default
    })
    .optional()
    .default(false),
  images: z.array(z.string().min(1)).optional(),
  video: z.array(z.string()).optional(),
  options: z
    .array(
      z.object({
        name: z.string().min(1),
        price: z.coerce.number().positive(),
      })
    )
    .optional(),
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
  page: z.string().optional().transform(Number).refine(n => !isNaN(n) && n > 0, {
    message: "Page must be a positive number",
  }).optional(),
  limit: z.string().optional().transform(Number).refine(n => !isNaN(n) && n > 0, {
    message: "Limit must be a positive number",
  }).optional(),
});


export const createVendorReviewSchema = z.object({
  vendorId: z.string().uuid(),
  rating: z.number().min(1).max(5),
  comment: z.string().optional(),
});


// Update product schema (only define once!)
export const updateProductSchema = z.object({
  name: z.string().min(2).max(100).optional(),
  description: z.string().nullable().optional(),
  price: z.coerce.number().positive().optional(),
  category: z.nativeEnum(Category).optional(),
  
  // For backward compatibility - old format
  images: z.array(z.string().url()).optional(),
  video: z.array(z.string().url()).optional(),
  
  // New: Smart update format
  imageUpdates: z.object({
    keep: z.array(z.string().url()).optional().default([]),
    delete: z.array(z.string().url()).optional().default([]),
  }).optional(),

  archived: z
  .union([
    z.boolean(),
    z.string().refine(val => val === 'true' || val === 'false', {
      message: "Archived must be 'true' or 'false' string",
    }).transform(val => val === 'true'),
    z.enum(['true', 'false']).transform(val => val === 'true'),
  ])
  .optional(),


  videoUpdates: z.object({
    keep: z.string().url().optional(),
    delete: z.boolean().optional().default(false),
  }).optional(),
  
  options: z.array(
    z.object({
      id: z.string().optional(),
      name: z.string().min(1),
      price: z.coerce.number().positive(),
    })
  ).optional(),
});









