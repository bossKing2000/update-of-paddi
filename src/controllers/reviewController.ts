import { Request, Response } from "express";
import prisma from "../lib/prisma";
import { AuthRequest } from "../middlewares/auth.middleware";
import {reviewProductSchema,replyToReviewSchema,reviewVoteSchema, reportReviewSchema, reviewSummaryQuerySchema,createVendorReviewSchema,} from "../validations/ProductCRUDSchema";
import { ZodError } from "zod";
import { getIO } from "../socket";
import { recordActivityBundle } from "../utils/activityUtils/recordActivityBundle";
import { ActivityType } from "@prisma/client";

function getRatingLabel(rating: number): string {
  if (rating >= 4.5) return "Excellent";
  if (rating >= 4) return "Very Good";
  if (rating >= 3) return "Good";
  if (rating >= 2) return "Fair";
  return "Poor";
}


// ✅ Utility: Extract Cloudinary URLs from Multer files
function extractImagePaths(files: AuthRequest["files"]): string[] {
  if (!files || typeof files !== "object" || !("images" in files)) return [];
  const imageFiles = (files as { [fieldname: string]: Express.Multer.File[] })["images"];
  return imageFiles.map((file) => file.path); // Already Cloudinary URL
}

// ======= PRODUCT REVIEWS =======
// Create a product review
export const reviewProduct = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user || req.user.role !== "CUSTOMER") {
      res.status(403).json({ message: "Only customers can review products" });
      return;
    }

    const parsed = reviewProductSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: (parsed.error as ZodError).issues });
      return;
    }

    const existing = await prisma.productReview.findFirst({
      where: { productId: parsed.data.productId, customerId: req.user.id },
    });

    if (existing) {
      res.status(400).json({ message: "You already reviewed this product" });
      return;
    }

    const imageUrls = extractImagePaths(req.files);

    const review = await prisma.productReview.create({
      data: {
        ...parsed.data,
        customerId: req.user.id,
        images: imageUrls,
      },
    });

    res.status(201).json({ message: "Review submitted", review });
  } catch (err) {
    console.error("Submit review error:", err);
    res.status(500).json({ error: "Server error" });
  }
};

// Update a product review
export const updateReview = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user || req.user.role !== "CUSTOMER") {
      res.status(403).json({ message: "Only customers can update reviews" });
      return;
    }
    const review = await prisma.productReview.findUnique({
      where: { id: req.params.id },
    });

    if (!review || review.customerId !== req.user.id) {
      res.status(403).json({ message: "Unauthorized or review not found" });
      return;
    }

    const parsed = reviewProductSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: (parsed.error as ZodError).issues });
      return;
    }

    const imageUrls = extractImagePaths(req.files);

    const updated = await prisma.productReview.update({
      where: { id: req.params.id },
      data: {
        ...parsed.data,
        images: imageUrls.length > 0 ? imageUrls : review.images,
      },
    });

    res.json({ message: "Review updated", updated });
  } catch (err) {
    console.error("Update review error:", err);
    res.status(500).json({ error: "Server error" });
  }
};

// Delete a product review
export const deleteReview = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user || req.user.role !== "CUSTOMER") {
      res.status(403).json({ message: "Only customers can delete reviews" });
      return;
    }

    const review = await prisma.productReview.findUnique({
      where: { id: req.params.id },
    });

    if (!review || review.customerId !== req.user.id) {
      res.status(403).json({ message: "Unauthorized or review not found" });
      return;
    }

    await prisma.productReview.delete({ where: { id: req.params.id } });
    res.json({ message: "Review deleted" });
  } catch (err) {
    console.error("Delete review error:", err);
    res.status(500).json({ error: "Server error" });
  }
};

// Get product reviews (with optional pagination)
export const getProductReviews = async (req: Request, res: Response): Promise<void> => {
  try {
    const productId = req.params.productId;
    const { page = "1", limit = "10" } = req.query;

    const skip = (Number(page) - 1) * Number(limit);
    const take = Number(limit);

    const reviews = await prisma.productReview.findMany({
      where: { productId },
      include: {
        customer: { select: { id: true, name: true, avatarUrl: true } },
        reply: true,
        votes: true,
        reports: true,
      },
      orderBy: { createdAt: "desc" },
      skip,
      take,
    });

    const total = await prisma.productReview.count({ where: { productId } });

    res.json({ page: Number(page), limit: Number(limit), total, reviews });
  } catch (err) {
    console.error("Get reviews error:", err);
    res.status(500).json({ error: "Server error" });
  }
};

// Get product review summary
export const getProductReviewSummary = async (req: Request, res: Response): Promise<void> => {
  try {
    const productId = req.params.productId;

    const parseResult = reviewSummaryQuerySchema.safeParse(req.query);
    if (!parseResult.success) {
      res.status(400).json({ error: parseResult.error.issues });
      return;
    }

    const { page = 1, limit = 10 } = parseResult.data;

    const breakdown = await prisma.productReview.groupBy({
      by: ["rating"],
      where: { productId },
      _count: { rating: true },
      orderBy: { rating: "desc" },
    });

    const average = await prisma.productReview.aggregate({
      where: { productId },
      _avg: { rating: true },
      _count: { rating: true },
    });

    const formattedBreakdown = [5, 4, 3, 2, 1].map((star) => {
      const found = breakdown.find((b) => b.rating === star);
      return { stars: star, count: found ? found._count.rating : 0, label: getRatingLabel(star) };
    });

    res.json({
      averageRating: Number(average._avg.rating?.toFixed(2)) || 0,
      totalReviews: average._count.rating,
      breakdown: formattedBreakdown,
    });
  } catch (err) {
    console.error("Review summary error:", err);
    res.status(500).json({ error: "Server error" });
  }
};


// ===== VENDOR REPLIES =====

// Vendor reply to product review
export const replyToReview = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user || req.user.role !== "VENDOR") {
      res.status(403).json({ message: "Only vendors can reply to reviews" });
      return;
    }

    const parsed = replyToReviewSchema.safeParse({ reviewId: req.params.id, ...req.body });
    if (!parsed.success) {
      res.status(400).json({ error: (parsed.error as ZodError).issues });
      return;
    }

    const review = await prisma.productReview.findUnique({
      where: { id: parsed.data.reviewId },
      include: { product: true },
    });

    if (!review || review.product.vendorId !== req.user.id) {
      res.status(403).json({ message: "You do not own this product" });
      return;
    }

    const reply = await prisma.vendorReply.upsert({
      where: { reviewId: parsed.data.reviewId },
      update: { message: parsed.data.message },
      create: {
        reviewId: parsed.data.reviewId,
        vendorId: req.user.id,
        message: parsed.data.message,
      },
    });

    res.json({ message: "Reply added", reply });
  } catch (err) {
    console.error("Reply error:", err);
    res.status(500).json({ error: "Server error" });
  }
};

// Delete vendor reply
export const deleteReplyToReview = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user || req.user.role !== "VENDOR") {
      res.status(403).json({ message: "Only vendors can delete replies" });
      return;
    }

    const reply = await prisma.vendorReply.findUnique({
      where: { reviewId: req.params.id },
      include: { review: { include: { product: true } } },
    });

    if (!reply || reply.vendorId !== req.user.id) {
      res.status(403).json({ message: "Unauthorized or reply not found" });
      return;
    }

    await prisma.vendorReply.delete({ where: { reviewId: req.params.id } });
    res.json({ message: "Reply deleted successfully" });
  } catch (err) {
    console.error("Delete reply error:", err);
    res.status(500).json({ error: "Server error" });
  }
};

// ===== REVIEW VOTES & REPORTS =====
// Vote on a review
export const voteReview = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user) {
      res.status(401).json({ message: "Unauthorized" });
      return;
    }

    const parsed = reviewVoteSchema.safeParse({ reviewId: req.params.id, ...req.body });
    if (!parsed.success) {
      res.status(400).json({ error: (parsed.error as ZodError).issues });
      return;
    }

    await prisma.reviewVote.upsert({
      where: { reviewId_userId: { reviewId: parsed.data.reviewId, userId: req.user.id } },
      update: { isHelpful: parsed.data.isHelpful },
      create: { reviewId: parsed.data.reviewId, userId: req.user.id, isHelpful: parsed.data.isHelpful },
    });

    res.json({ message: "Voted successfully" });
  } catch (err) {
    console.error("Vote error:", err);
    res.status(500).json({ error: "Server error" });
  }
};

// Report a review
export const reportReview = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user) {
      res.status(401).json({ message: "Unauthorized" });
      return;
    }

    const parsed = reportReviewSchema.safeParse({ reviewId: req.params.id, ...req.body });
    if (!parsed.success) {
      res.status(400).json({ error: (parsed.error as ZodError).issues });
      return;
    }

    await prisma.reviewReport.create({
      data: { reviewId: parsed.data.reviewId, userId: req.user.id, reason: parsed.data.reason },
    });

    res.json({ message: "Report submitted" });
  } catch (err) {
    console.error("Report error:", err);
    res.status(500).json({ error: "Server error" });
  }
};

// ===== VENDOR REVIEWS =====

// Create a vendor review
// export const reviewVendor = async (req: AuthRequest, res: Response): Promise<void> => {
//   try {
//     if (!req.user || req.user.role !== "CUSTOMER") {
//       res.status(403).json({ message: "Only customers can review vendors" });
//       return;
//     }

//     const parsed = createVendorReviewSchema.safeParse(req.body);
//     if (!parsed.success) {
//       res.status(400).json({ error: (parsed.error as ZodError).issues });
//       return;
//     }

//     const existing = await prisma.vendorReview.findFirst({
//       where: { vendorId: parsed.data.vendorId, customerId: req.user.id },
//     });

//     if (existing) {
//       res.status(400).json({ message: "You already reviewed this vendor" });
//       return;
//     }

//     const review = await prisma.vendorReview.create({
//       data: { ...parsed.data, customerId: req.user.id },
//     });

//     res.status(201).json({ message: "Vendor review submitted", review });
//   } catch (err) {
//     console.error("Vendor review error:", err);
//     res.status(500).json({ error: "Server error" });
//   }
// };


export const reviewVendor = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user || req.user.role !== "CUSTOMER") {
      res.status(403).json({ message: "Only customers can review vendors" });
      return;
    }

    const parsed = createVendorReviewSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: (parsed.error as ZodError).issues });
      return;
    }

    const existing = await prisma.vendorReview.findFirst({
      where: { vendorId: parsed.data.vendorId, customerId: req.user.id },
    });

    if (existing) {
      res.status(400).json({ message: "You already reviewed this vendor" });
      return;
    }

    const review = await prisma.vendorReview.create({
      data: { ...parsed.data, customerId: req.user.id },
    });


    const customer = await prisma.user.findUnique({
      where: {id: req.user!.id},
    });

    const notificationTitle = "New Vendor Review";
    const notificationMessage = `${customer?.name || "Someone"} submitted a review for you`;

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

    
        
    res.status(201).json({ message: "Vendor review submitted", review });
  } catch (err) {
    console.error("Vendor review error:", err);
    res.status(500).json({ error: "Server error" });
  }
};

// Get vendor reviews (with pagination)
export const getVendorReviews = async (req: Request, res: Response): Promise<void> => {
  try {
    const vendorId = req.params.vendorId;
    const { page = "1", limit = "10" } = req.query;

    const skip = (Number(page) - 1) * Number(limit);
    const take = Number(limit);

    const reviews = await prisma.vendorReview.findMany({
      where: { vendorId },
      include: { customer: { select: { id: true, name: true, avatarUrl: true } } },
      orderBy: { createdAt: "desc" },
      skip,
      take,
    });

    const total = await prisma.vendorReview.count({ where: { vendorId } });

    res.json({ page: Number(page), limit: Number(limit), total, reviews });
  } catch (err) {
    console.error("Get vendor reviews error:", err);
    res.status(500).json({ error: "Server error" });
  }
};

// Vendor review summary
export const getVendorReviewSummary = async (req: Request, res: Response): Promise<void> => {
  try {
    const vendorId = req.params.vendorId;

    const breakdown = await prisma.vendorReview.groupBy({
      by: ["rating"],
      where: { vendorId },
      _count: { rating: true },
      orderBy: { rating: "desc" },
    });

    const average = await prisma.vendorReview.aggregate({
      where: { vendorId },
      _avg: { rating: true },
      _count: { rating: true },
    });

    const formattedBreakdown = [5, 4, 3, 2, 1].map((star) => {
      const found = breakdown.find((b) => b.rating === star);
      return { stars: star, count: found ? found._count.rating : 0, label: getRatingLabel(star) };
    });

    res.json({
      averageRating: Number(average._avg.rating?.toFixed(2)) || 0,
      totalReviews: average._count.rating,
      breakdown: formattedBreakdown,
    });
  } catch (err) {
    console.error("Vendor summary error:", err);
    res.status(500).json({ error: "Server error" });
  }
};


// Get single review by id
export const getVendorReviewById = async (req: Request, res: Response) => {
  const reviewId = req.params.reviewId;
  const review = await prisma.vendorReview.findUnique({
    where: { id: reviewId },
    include: { customer: { select: { id: true, name: true, avatarUrl: true } } },
  });
  if (!review) return res.status(404).json({ error: "Review not found" });
  res.json({ review });
};
