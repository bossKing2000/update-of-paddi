"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getFollowedVendors = exports.getVendorFollowers = exports.isFollowingVendor = exports.unfollowVendor = exports.followVendor = void 0;
const prismaClient_1 = __importDefault(require("../config/prismaClient"));
const vendorFollowSchema_1 = require("../validations/vendorFollowSchema");
const vendorFollowNotifications_1 = require("../utils/activityUtils/vendorFollowNotifications");
const codeMessage_1 = require("../validators/codeMessage");
// 🟢 Follow a vendor
const followVendor = async (req, res) => {
    try {
        const parsed = vendorFollowSchema_1.followVendorSchema.safeParse(req.body);
        if (!parsed.success)
            return res.status(422).json((0, codeMessage_1.errorResponse)("INVALID_INPUT", parsed.error.message));
        const { vendorId } = parsed.data;
        const customerId = req.user.id;
        if (vendorId === customerId)
            return res.status(400).json((0, codeMessage_1.errorResponse)("INVALID_ACTION", "You cannot follow yourself."));
        // Prevent duplicate follows
        const existing = await prismaClient_1.default.vendorFollower.findUnique({
            where: { vendorId_customerId: { vendorId, customerId } },
        });
        if (existing)
            return res.status(400).json((0, codeMessage_1.errorResponse)("ALREADY_FOLLOWING", "You already follow this vendor."));
        // Create follow relationship
        const follow = await prismaClient_1.default.vendorFollower.create({
            data: { vendorId, customerId },
        });
        // Enqueue async notification
        await vendorFollowNotifications_1.vendorFollowQueue.add("notifyVendorFollow", { vendorId, customerId });
        res.json((0, codeMessage_1.successResponse)("FOLLOWED_VENDOR", "Vendor followed successfully.", follow));
    }
    catch (err) {
        console.error("Follow vendor error:", err);
        res.status(500).json((0, codeMessage_1.errorResponse)("SERVER_ERROR", "Failed to follow vendor."));
    }
};
exports.followVendor = followVendor;
// 🔴 Unfollow a vendor
const unfollowVendor = async (req, res) => {
    try {
        const parsed = vendorFollowSchema_1.unfollowVendorSchema.safeParse(req.body);
        if (!parsed.success)
            return res.status(422).json((0, codeMessage_1.errorResponse)("INVALID_INPUT", parsed.error.message));
        const { vendorId } = parsed.data;
        const customerId = req.user.id;
        const existing = await prismaClient_1.default.vendorFollower.findUnique({
            where: { vendorId_customerId: { vendorId, customerId } },
        });
        if (!existing)
            return res.status(404).json((0, codeMessage_1.errorResponse)("NOT_FOLLOWING", "You are not following this vendor."));
        await prismaClient_1.default.vendorFollower.delete({
            where: { id: existing.id },
        });
        res.json((0, codeMessage_1.successResponse)("UNFOLLOWED_VENDOR", "Vendor unfollowed successfully."));
    }
    catch (err) {
        console.error("Unfollow vendor error:", err);
        res.status(500).json((0, codeMessage_1.errorResponse)("SERVER_ERROR", "Failed to unfollow vendor."));
    }
};
exports.unfollowVendor = unfollowVendor;
// 👁️ Check if user follows a vendor
const isFollowingVendor = async (req, res) => {
    try {
        const vendorId = req.params.vendorId;
        const customerId = req.user.id;
        const follow = await prismaClient_1.default.vendorFollower.findUnique({
            where: { vendorId_customerId: { vendorId, customerId } },
        });
        res.json((0, codeMessage_1.successResponse)("FOLLOW_STATUS", "Follow status fetched.", { following: !!follow }));
    }
    catch (err) {
        console.error("Follow check error:", err);
        res.status(500).json((0, codeMessage_1.errorResponse)("SERVER_ERROR", "Failed to check follow status."));
    }
};
exports.isFollowingVendor = isFollowingVendor;
// 📋 Get all followers of a vendor
const getVendorFollowers = async (req, res) => {
    try {
        const vendorId = req.params.vendorId;
        const followers = await prismaClient_1.default.vendorFollower.findMany({
            where: { vendorId },
            include: {
                customer: { select: { id: true, name: true, avatarUrl: true } },
            },
        });
        res.json((0, codeMessage_1.successResponse)("VENDOR_FOLLOWERS", "Followers retrieved.", followers));
    }
    catch (err) {
        console.error("Get vendor followers error:", err);
        res.status(500).json((0, codeMessage_1.errorResponse)("SERVER_ERROR", "Failed to fetch vendor followers."));
    }
};
exports.getVendorFollowers = getVendorFollowers;
// 📋 Get all vendors a customer follows
const getFollowedVendors = async (req, res) => {
    try {
        const customerId = req.user.id;
        const follows = await prismaClient_1.default.vendorFollower.findMany({
            where: { customerId },
            include: {
                vendor: { select: { id: true, name: true, brandName: true, brandLogo: true } },
            },
        });
        res.json((0, codeMessage_1.successResponse)("FOLLOWED_VENDORS", "Followed vendors retrieved.", follows));
    }
    catch (err) {
        console.error("Get followed vendors error:", err);
        res.status(500).json((0, codeMessage_1.errorResponse)("SERVER_ERROR", "Failed to fetch followed vendors."));
    }
};
exports.getFollowedVendors = getFollowedVendors;
