import {Response } from "express";
import prisma from "../config/prismaClient";
import { followVendorSchema, unfollowVendorSchema } from "../validations/vendorFollowSchema";
import { AuthRequest } from "../middlewares/auth.middleware";
import { vendorFollowQueue } from "../utils/activityUtils/vendorFollowNotifications";
import { errorResponse, successResponse } from "../validators/codeMessage";

// 🟢 Follow a vendor
export const followVendor = async (req: AuthRequest, res: Response) => {
  try {
    const parsed = followVendorSchema.safeParse(req.body);
    if (!parsed.success)
      return res.status(422).json(errorResponse("INVALID_INPUT", parsed.error.message));

    const { vendorId } = parsed.data;
    const customerId = req.user!.id;

    if (vendorId === customerId)
      return res.status(400).json(errorResponse("INVALID_ACTION", "You cannot follow yourself."));

    // Prevent duplicate follows
    const existing = await prisma.vendorFollower.findUnique({
      where: { vendorId_customerId: { vendorId, customerId } },
    });
    if (existing)
      return res.status(400).json(errorResponse("ALREADY_FOLLOWING", "You already follow this vendor."));

    // Create follow relationship
    const follow = await prisma.vendorFollower.create({
      data: { vendorId, customerId },
    });

    // Enqueue async notification
    await vendorFollowQueue.add("notifyVendorFollow", { vendorId, customerId });

    res.json(successResponse("FOLLOWED_VENDOR", "Vendor followed successfully.", follow));
  } catch (err) {
    console.error("Follow vendor error:", err);
    res.status(500).json(errorResponse("SERVER_ERROR", "Failed to follow vendor."));
  }
};

// 🔴 Unfollow a vendor
export const unfollowVendor = async (req: AuthRequest, res: Response) => {
  try {
    const parsed = unfollowVendorSchema.safeParse(req.body);
    if (!parsed.success)
      return res.status(422).json(errorResponse("INVALID_INPUT", parsed.error.message));

    const { vendorId } = parsed.data;
    const customerId = req.user!.id;

    const existing = await prisma.vendorFollower.findUnique({
      where: { vendorId_customerId: { vendorId, customerId } },
    });
    if (!existing)
      return res.status(404).json(errorResponse("NOT_FOLLOWING", "You are not following this vendor."));

    await prisma.vendorFollower.delete({
      where: { id: existing.id },
    });

    res.json(successResponse("UNFOLLOWED_VENDOR", "Vendor unfollowed successfully."));
  } catch (err) {
    console.error("Unfollow vendor error:", err);
    res.status(500).json(errorResponse("SERVER_ERROR", "Failed to unfollow vendor."));
  }
};

// 👁️ Check if user follows a vendor
export const isFollowingVendor = async (req: AuthRequest, res: Response) => {
  try {
    const vendorId = req.params.vendorId;
    const customerId = req.user!.id;

    const follow = await prisma.vendorFollower.findUnique({
      where: { vendorId_customerId: { vendorId, customerId } },
    });

    res.json(successResponse("FOLLOW_STATUS", "Follow status fetched.", { following: !!follow }));
  } catch (err) {
    console.error("Follow check error:", err);
    res.status(500).json(errorResponse("SERVER_ERROR", "Failed to check follow status."));
  }
};

// 📋 Get all followers of a vendor
export const getVendorFollowers = async (req: AuthRequest, res: Response) => {
  try {
    const vendorId = req.params.vendorId;

    const followers = await prisma.vendorFollower.findMany({
      where: { vendorId },
      include: {
        customer: { select: { id: true, name: true, avatarUrl: true } },
      },
    });

    res.json(successResponse("VENDOR_FOLLOWERS", "Followers retrieved.", followers));
  } catch (err) {
    console.error("Get vendor followers error:", err);
    res.status(500).json(errorResponse("SERVER_ERROR", "Failed to fetch vendor followers."));
  }
};

// 📋 Get all vendors a customer follows
export const getFollowedVendors = async (req: AuthRequest, res: Response) => {
  try {
    const customerId = req.user!.id;

    const follows = await prisma.vendorFollower.findMany({
      where: { customerId },
      include: {
        vendor: { select: { id: true, name: true, brandName: true, brandLogo: true } },
      },
    });

    res.json(successResponse("FOLLOWED_VENDORS", "Followed vendors retrieved.", follows));
  } catch (err) {
    console.error("Get followed vendors error:", err);
    res.status(500).json(errorResponse("SERVER_ERROR", "Failed to fetch followed vendors."));
  }
};
