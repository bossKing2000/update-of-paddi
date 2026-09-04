import { Request, Response } from "express";
import prisma from "../lib/prisma";
import { ensureString } from "../utils/paramUtils";
import { AuthRequest } from "../middlewares/auth.middleware";
import {
  reviewProductSchema,
  replyToReviewSchema,
  reviewVoteSchema,
  reportReviewSchema,
  reviewSummaryQuerySchema,
  createVendorReviewSchema,
} from "../validations/ProductCRUDSchema";
import { OrderStatus, ActivityType } from "@prisma/client";
import { refreshProductRatingStats } from "../services/product.service";
import { recordActivityBundle } from "../utils/activityUtils/recordActivityBundle";
import { sendSuccess, sendCreated } from "../utils/apiResponse";
import {
  NotFoundError,
  ForbiddenError,
  ValidationError,
  ConflictError,
} from "../errors/AppError";

export function getRatingLabel(rating: number): string {
  if (rating >= 4.5) return "Excellent";
  if (rating >= 4) return "Very Good";
  if (rating >= 3) return "Good";
  if (rating >= 2) return "Fair";
  return "Poor";
}

function extractImagePaths(files: AuthRequest["files"]): string[] {
  if (!files || typeof files !== "object" || !("images" in files)) return [];
  const imageFiles = (files as { [fieldname: string]: Express.Multer.File[] })[
    "images"
  ];
  return imageFiles.map((file) => file.path);
}

export function ratingBreakdown(
  counts: { rating: number; _count: { rating: number } }[],
) {
  return [5, 4, 3, 2, 1].map((star) => {
    const found = counts.find((c) => c.rating === star);
    return {
      stars: star,
      count: found ? found._count.rating : 0,
      label: getRatingLabel(star),
    };
  });
}

// ======= PRODUCT REVIEWS =======

// POST /reviews/product
export const reviewProduct = async (req: AuthRequest, res: Response) => {
  if (!req.user || req.user.role !== "CUSTOMER")
    throw new ForbiddenError("Only customers can review products");

  const parsed = reviewProductSchema.safeParse(req.body);
  if (!parsed.success)
    throw new ValidationError(
      "Invalid review",
      parsed.error.flatten().fieldErrors,
    );

  const existing = await prisma.productReview.findFirst({
    where: { productId: parsed.data.productId, customerId: req.user.id },
  });
  if (existing) throw new ConflictError("You already reviewed this product");

  // `verifiedPurchase` existed on the schema but was never set or checked
  // anywhere — any CUSTOMER-role account could review any product without
  // ever having ordered it, and even a genuine buyer's review was never
  // actually marked verified. Requiring a completed order containing this
  // product closes an obvious fake-review / competitor-sabotage vector on
  // a marketplace with many independent vendors.
  const hasCompletedOrder = await prisma.orderItem.findFirst({
    where: {
      productId: parsed.data.productId,
      order: { customerId: req.user.id, status: OrderStatus.COMPLETED },
    },
    select: { id: true },
  });
  if (!hasCompletedOrder)
    throw new ForbiddenError(
      "You can only review products from a completed order",
    );

  const imageUrls = extractImagePaths(req.files);

  const review = await prisma.productReview.create({
    data: {
      ...parsed.data,
      customerId: req.user.id,
      images: imageUrls,
      verifiedPurchase: true,
    },
  });

  // Keep the product's denormalized rating stats truthful for ranking and
  // minRating filtering. Awaited: listings must never serve stale stats.
  await refreshProductRatingStats(parsed.data.productId);

  const product = await prisma.product.findUnique({
    where: { id: parsed.data.productId },
    select: { vendorId: true, name: true },
  });
  const customer = await prisma.user.findUnique({
    where: { id: req.user.id },
    select: { name: true },
  });

  // Previously nothing notified the vendor when one of their products got
  // reviewed at all (reviewVendor did this for vendor-profile reviews;
  // product reviews had no equivalent).
  if (product) {
    await recordActivityBundle({
      req,
      actorId: req.user.id,
      actions: [
        {
          type: ActivityType.REVIEW_POSTED,
          title: "New Product Review",
          message: `${customer?.name || "A customer"} left a ${parsed.data.rating}-star review on "${product.name}".`,
          targetId: product.vendorId,
          socketEvent: "REVIEW",
          metadata: {
            reviewId: review.id,
            productId: parsed.data.productId,
            rating: parsed.data.rating,
          },
          relation: "vendor",
        },
      ],
      audit: {
        action: "PRODUCT_REVIEW_POSTED",
        metadata: {
          productId: parsed.data.productId,
          reviewId: review.id,
          actorId: req.user.id,
        },
      },
      notifyRealtime: true,
      notifyPush: true,
    });
  }

  return sendCreated(res, { review }, "Review submitted");
};

// PATCH /reviews/product/:id
export const updateReview = async (req: AuthRequest, res: Response) => {
  if (!req.user || req.user.role !== "CUSTOMER")
    throw new ForbiddenError("Only customers can update reviews");

  const reviewId = ensureString(req.params.id);
  const review = await prisma.productReview.findUnique({
    where: { id: reviewId },
  });
  if (!review || review.customerId !== req.user.id)
    throw new ForbiddenError("Unauthorized or review not found");

  const parsed = reviewProductSchema.safeParse(req.body);
  if (!parsed.success)
    throw new ValidationError(
      "Invalid review",
      parsed.error.flatten().fieldErrors,
    );

  // A review's product must never change after creation — reviewProductSchema
  // requires productId (since it's also used at creation time), but
  // spreading it directly into the update meant a customer editing their
  // own review could pass a *different* productId and silently reassign
  // their review — with its vote/report history intact — onto an
  // unrelated product, polluting that product's rating.
  const { productId: _ignoredProductId, ...updatableFields } = parsed.data;

  const imageUrls = extractImagePaths(req.files);

  const updated = await prisma.productReview.update({
    where: { id: reviewId },
    data: {
      ...updatableFields,
      images: imageUrls.length > 0 ? imageUrls : review.images,
    },
  });

  await refreshProductRatingStats(review.productId);

  return sendSuccess(res, { updated }, "Review updated");
};

// DELETE /reviews/product/:id
export const deleteReview = async (req: AuthRequest, res: Response) => {
  if (!req.user || req.user.role !== "CUSTOMER")
    throw new ForbiddenError("Only customers can delete reviews");

  const reviewId = ensureString(req.params.id);
  const review = await prisma.productReview.findUnique({
    where: { id: reviewId },
  });
  if (!review || review.customerId !== req.user.id)
    throw new ForbiddenError("Unauthorized or review not found");

  // Votes/reports/vendor reply are all onDelete: Cascade — cleaned up
  // automatically, no manual deletion needed here.
  await prisma.productReview.delete({ where: { id: reviewId } });
  await refreshProductRatingStats(review.productId);
  return sendSuccess(res, {}, "Review deleted");
};

// GET /reviews/product/:productId
export const getProductReviews = async (req: Request, res: Response) => {
  const productId = ensureString(req.params.productId);
  const page = Math.max(Number(req.query.page) || 1, 1);
  const limit = Math.min(Number(req.query.limit) || 10, 50);
  const skip = (page - 1) * limit;

  const [reviews, total] = await Promise.all([
    prisma.productReview.findMany({
      where: { productId },
      include: {
        customer: { select: { id: true, name: true, avatarUrl: true } },
        reply: true,
        votes: true,
      },
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
    }),
    prisma.productReview.count({ where: { productId } }),
  ]);

  return sendSuccess(res, { reviews }, "Reviews retrieved", 200, {
    page,
    limit,
    total,
    totalPages: Math.ceil(total / limit),
  });
};

// GET /reviews/product/:productId/summary
export const getProductReviewSummary = async (req: Request, res: Response) => {
  const productId = ensureString(req.params.productId);

  const parseResult = reviewSummaryQuerySchema.safeParse(req.query);
  if (!parseResult.success)
    throw new ValidationError(
      "Invalid query",
      parseResult.error.flatten().fieldErrors,
    );

  const [breakdown, average] = await Promise.all([
    prisma.productReview.groupBy({
      by: ["rating"],
      where: { productId },
      _count: { rating: true },
      orderBy: { rating: "desc" },
    }),
    prisma.productReview.aggregate({
      where: { productId },
      _avg: { rating: true },
      _count: { rating: true },
    }),
  ]);

  return sendSuccess(
    res,
    {
      averageRating: Number(average._avg.rating?.toFixed(2)) || 0,
      totalReviews: average._count.rating,
      breakdown: ratingBreakdown(breakdown),
    },
    "Review summary retrieved",
  );
};

// ===== VENDOR REPLIES =====

// POST /reviews/product/:id/reply
export const replyToReview = async (req: AuthRequest, res: Response) => {
  if (!req.user || req.user.role !== "VENDOR")
    throw new ForbiddenError("Only vendors can reply to reviews");

  const parsed = replyToReviewSchema.safeParse({
    reviewId: ensureString(req.params.id),
    ...req.body,
  });
  if (!parsed.success)
    throw new ValidationError(
      "Invalid reply",
      parsed.error.flatten().fieldErrors,
    );

  const review = await prisma.productReview.findUnique({
    where: { id: parsed.data.reviewId },
    include: { product: true },
  });
  if (!review || review.product.vendorId !== req.user.id)
    throw new ForbiddenError("You do not own this product");

  const isNewReply = !(await prisma.vendorReply.findUnique({
    where: { reviewId: parsed.data.reviewId },
  }));

  const reply = await prisma.vendorReply.upsert({
    where: { reviewId: parsed.data.reviewId },
    update: { message: parsed.data.message },
    create: {
      reviewId: parsed.data.reviewId,
      vendorId: req.user.id,
      message: parsed.data.message,
    },
  });

  // Previously nothing told the customer their review got a reply at all
  // — they'd only find out by happening to revisit the product page.
  if (isNewReply) {
    await recordActivityBundle({
      req,
      actorId: req.user.id,
      actions: [
        {
          type: ActivityType.GENERAL,
          title: "Vendor replied to your review",
          message: `The vendor replied to your review on "${review.product.name}".`,
          targetId: review.customerId,
          socketEvent: "REVIEW",
          metadata: { reviewId: review.id, productId: review.productId },
        },
      ],
      audit: {
        action: "REVIEW_REPLIED",
        metadata: { reviewId: review.id, vendorId: req.user.id },
      },
      notifyRealtime: true,
      notifyPush: true,
    });
  }

  return sendSuccess(res, { reply }, "Reply added");
};

// DELETE /reviews/product/:id/reply
export const deleteReplyToReview = async (req: AuthRequest, res: Response) => {
  if (!req.user || req.user.role !== "VENDOR")
    throw new ForbiddenError("Only vendors can delete replies");

  const reviewId = ensureString(req.params.id);
  const reply = await prisma.vendorReply.findUnique({
    where: { reviewId },
    include: { review: { include: { product: true } } },
  });
  if (!reply || reply.vendorId !== req.user.id)
    throw new ForbiddenError("Unauthorized or reply not found");

  await prisma.vendorReply.delete({ where: { reviewId } });
  return sendSuccess(res, {}, "Reply deleted successfully");
};

// ===== REVIEW VOTES & REPORTS =====

// POST /reviews/product/:id/vote
export const voteReview = async (req: AuthRequest, res: Response) => {
  if (!req.user) throw new ForbiddenError("Authentication required");

  const parsed = reviewVoteSchema.safeParse({
    reviewId: ensureString(req.params.id),
    ...req.body,
  });
  if (!parsed.success)
    throw new ValidationError(
      "Invalid vote",
      parsed.error.flatten().fieldErrors,
    );

  const review = await prisma.productReview.findUnique({
    where: { id: parsed.data.reviewId },
    select: { customerId: true },
  });
  if (!review) throw new NotFoundError("Review");
  if (review.customerId === req.user.id)
    throw new ValidationError("You can't vote on your own review");

  await prisma.reviewVote.upsert({
    where: {
      reviewId_userId: { reviewId: parsed.data.reviewId, userId: req.user.id },
    },
    update: { isHelpful: parsed.data.isHelpful },
    create: {
      reviewId: parsed.data.reviewId,
      userId: req.user.id,
      isHelpful: parsed.data.isHelpful,
    },
  });

  return sendSuccess(res, {}, "Voted successfully");
};

// POST /reviews/product/:id/report
export const reportReview = async (req: AuthRequest, res: Response) => {
  if (!req.user) throw new ForbiddenError("Authentication required");

  const parsed = reportReviewSchema.safeParse({
    reviewId: ensureString(req.params.id),
    ...req.body,
  });
  if (!parsed.success)
    throw new ValidationError(
      "Invalid report",
      parsed.error.flatten().fieldErrors,
    );

  const review = await prisma.productReview.findUnique({
    where: { id: parsed.data.reviewId },
    select: { id: true },
  });
  if (!review) throw new NotFoundError("Review");

  const existing = await prisma.reviewReport.findFirst({
    where: { reviewId: parsed.data.reviewId, userId: req.user.id },
  });
  if (existing) throw new ConflictError("You already reported this review");

  await prisma.reviewReport.create({
    data: {
      reviewId: parsed.data.reviewId,
      userId: req.user.id,
      reason: parsed.data.reason,
    },
  });
  return sendSuccess(res, {}, "Report submitted");
};

// ===== VENDOR REVIEWS =====

// POST /reviews/vendor/:vendorId
export const reviewVendor = async (req: AuthRequest, res: Response) => {
  if (!req.user || req.user.role !== "CUSTOMER")
    throw new ForbiddenError("Only customers can review vendors");

  const parsed = createVendorReviewSchema.safeParse({
    vendorId: ensureString(req.params.vendorId),
    ...req.body,
  });
  if (!parsed.success)
    throw new ValidationError(
      "Invalid review",
      parsed.error.flatten().fieldErrors,
    );

  const existing = await prisma.vendorReview.findFirst({
    where: { vendorId: parsed.data.vendorId, customerId: req.user.id },
  });
  if (existing) throw new ConflictError("You already reviewed this vendor");

  // Same verified-purchase requirement as product reviews — previously
  // anyone with a CUSTOMER account could review any vendor without ever
  // having ordered from them.
  const hasCompletedOrder = await prisma.order.findFirst({
    where: {
      vendorId: parsed.data.vendorId,
      customerId: req.user.id,
      status: OrderStatus.COMPLETED,
    },
    select: { id: true },
  });
  if (!hasCompletedOrder)
    throw new ForbiddenError(
      "You can only review vendors you've ordered from (completed order required)",
    );

  const review = await prisma.vendorReview.create({
    data: { ...parsed.data, customerId: req.user.id },
  });
  const customer = await prisma.user.findUnique({
    where: { id: req.user.id },
    select: { name: true },
  });

  await recordActivityBundle({
    req,
    actorId: req.user.id,
    actions: [
      {
        type: ActivityType.REVIEW_POSTED,
        title: "New Vendor Review",
        message: `${customer?.name || "A customer"} submitted a review for you.`,
        targetId: parsed.data.vendorId,
        socketEvent: "REVIEW",
        metadata: { reviewId: review.id, customerId: req.user.id },
        relation: "vendor",
      },
    ],
    audit: {
      action: "REVIEW_POSTED",
      metadata: {
        vendorId: parsed.data.vendorId,
        reviewId: review.id,
        actorId: req.user.id,
      },
    },
    notifyRealtime: true,
    notifyPush: true,
  });

  return sendCreated(res, { review }, "Vendor review submitted");
};

// GET /reviews/vendor/:vendorId
export const getVendorReviews = async (req: Request, res: Response) => {
  const vendorId = ensureString(req.params.vendorId);
  const page = Math.max(Number(req.query.page) || 1, 1);
  const limit = Math.min(Number(req.query.limit) || 10, 50);
  const skip = (page - 1) * limit;

  const [reviews, total] = await Promise.all([
    prisma.vendorReview.findMany({
      where: { vendorId },
      include: {
        customer: { select: { id: true, name: true, avatarUrl: true } },
      },
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
    }),
    prisma.vendorReview.count({ where: { vendorId } }),
  ]);

  return sendSuccess(res, { reviews }, "Vendor reviews retrieved", 200, {
    page,
    limit,
    total,
    totalPages: Math.ceil(total / limit),
  });
};

// GET /reviews/vendor/:vendorId/summary
export const getVendorReviewSummary = async (req: Request, res: Response) => {
  const vendorId = ensureString(req.params.vendorId);

  const [breakdown, average] = await Promise.all([
    prisma.vendorReview.groupBy({
      by: ["rating"],
      where: { vendorId },
      _count: { rating: true },
      orderBy: { rating: "desc" },
    }),
    prisma.vendorReview.aggregate({
      where: { vendorId },
      _avg: { rating: true },
      _count: { rating: true },
    }),
  ]);

  return sendSuccess(
    res,
    {
      averageRating: Number(average._avg.rating?.toFixed(2)) || 0,
      totalReviews: average._count.rating,
      breakdown: ratingBreakdown(breakdown),
    },
    "Vendor review summary retrieved",
  );
};

// GET /reviews/vendor/single/:reviewId
export const getVendorReviewById = async (req: Request, res: Response) => {
  const reviewId = ensureString(req.params.reviewId);
  const review = await prisma.vendorReview.findUnique({
    where: { id: reviewId },
    include: {
      customer: { select: { id: true, name: true, avatarUrl: true } },
    },
  });
  if (!review) throw new NotFoundError("Review");
  return sendSuccess(res, { review }, "Review retrieved");
};
