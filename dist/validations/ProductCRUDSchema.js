"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.updateProductSchema = exports.createVendorReviewSchema = exports.reviewSummaryQuerySchema = exports.reportReviewSchema = exports.reviewVoteSchema = exports.replyToReviewSchema = exports.reviewProductSchema = exports.archiveProductSchema = exports.createProductSchema = void 0;
const zod_1 = require("zod");
const client_1 = require("@prisma/client");
exports.createProductSchema = zod_1.z.object({
    name: zod_1.z.string().min(3),
    description: zod_1.z.string().min(5),
    price: zod_1.z.coerce.number().positive(),
    category: zod_1.z.nativeEnum(client_1.Category),
    archived: zod_1.z
        .union([zod_1.z.boolean(), zod_1.z.enum(['true', 'false', '0', '1'])])
        .transform((val) => {
        if (typeof val === 'boolean')
            return val;
        if (val === 'true' || val === '1')
            return true;
        if (val === 'false' || val === '0')
            return false;
        return false; // default
    })
        .optional()
        .default(false),
    images: zod_1.z.array(zod_1.z.string().min(1)).optional(),
    video: zod_1.z.array(zod_1.z.string()).optional(),
    options: zod_1.z
        .array(zod_1.z.object({
        name: zod_1.z.string().min(1),
        price: zod_1.z.coerce.number().positive(),
    }))
        .optional(),
});
exports.archiveProductSchema = zod_1.z.object({
    archived: zod_1.z.boolean(),
});
exports.reviewProductSchema = zod_1.z.object({
    productId: zod_1.z.string().uuid(),
    rating: zod_1.z.coerce.number().min(1).max(5),
    comment: zod_1.z.string().optional(),
});
// ✍️ Reply to review (vendor only)
exports.replyToReviewSchema = zod_1.z.object({
    reviewId: zod_1.z.string().uuid(),
    message: zod_1.z.string().min(2, "Reply must be at least 2 characters long"),
});
// 👍 Vote helpful or not
exports.reviewVoteSchema = zod_1.z.object({
    reviewId: zod_1.z.string().uuid(),
    isHelpful: zod_1.z.boolean(),
});
// ⚠️ Report a review for abuse or spam
exports.reportReviewSchema = zod_1.z.object({
    reviewId: zod_1.z.string().uuid(),
    reason: zod_1.z.string().min(3, "Please provide a reason"),
});
exports.reviewSummaryQuerySchema = zod_1.z.object({
    page: zod_1.z.string().optional().transform(Number).refine(n => !isNaN(n) && n > 0, {
        message: "Page must be a positive number",
    }).optional(),
    limit: zod_1.z.string().optional().transform(Number).refine(n => !isNaN(n) && n > 0, {
        message: "Limit must be a positive number",
    }).optional(),
});
exports.createVendorReviewSchema = zod_1.z.object({
    vendorId: zod_1.z.string().uuid(),
    rating: zod_1.z.number().min(1).max(5),
    comment: zod_1.z.string().optional(),
});
// Update product schema (only define once!)
exports.updateProductSchema = zod_1.z.object({
    name: zod_1.z.string().min(2).max(100).optional(),
    description: zod_1.z.string().nullable().optional(),
    price: zod_1.z.coerce.number().positive().optional(),
    category: zod_1.z.nativeEnum(client_1.Category).optional(),
    // For backward compatibility - old format
    images: zod_1.z.array(zod_1.z.string().url()).optional(),
    video: zod_1.z.array(zod_1.z.string().url()).optional(),
    // New: Smart update format
    imageUpdates: zod_1.z.object({
        keep: zod_1.z.array(zod_1.z.string().url()).optional().default([]),
        delete: zod_1.z.array(zod_1.z.string().url()).optional().default([]),
    }).optional(),
    archived: zod_1.z
        .union([
        zod_1.z.boolean(),
        zod_1.z.string().refine(val => val === 'true' || val === 'false', {
            message: "Archived must be 'true' or 'false' string",
        }).transform(val => val === 'true'),
        zod_1.z.enum(['true', 'false']).transform(val => val === 'true'),
    ])
        .optional(),
    videoUpdates: zod_1.z.object({
        keep: zod_1.z.string().url().optional(),
        delete: zod_1.z.boolean().optional().default(false),
    }).optional(),
    options: zod_1.z.array(zod_1.z.object({
        id: zod_1.z.string().optional(),
        name: zod_1.z.string().min(1),
        price: zod_1.z.coerce.number().positive(),
    })).optional(),
});
