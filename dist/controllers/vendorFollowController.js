"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getFollowedVendors = exports.getVendorFollowerCount = exports.getVendorFollowers = exports.isFollowingVendor = exports.unfollowVendor = exports.followVendor = void 0;
const prisma_1 = __importDefault(require("../lib/prisma"));
const paramUtils_1 = require("../utils/paramUtils");
const vendorFollowSchema_1 = require("../validations/vendorFollowSchema");
const vendorFollowWorker_1 = require("../jobs/workers jobs/vendorFollowWorker");
const apiResponse_1 = require("../utils/apiResponse");
const AppError_1 = require("../errors/AppError");
function getPagination(req) {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25));
    return { page, limit, skip: (page - 1) * limit };
}
// POST /vendor-follow/follow
const followVendor = async (req, res) => {
    const parsed = vendorFollowSchema_1.followVendorSchema.safeParse(req.body);
    if (!parsed.success)
        throw new AppError_1.ValidationError("Invalid request", parsed.error.flatten().fieldErrors);
    const { vendorId } = parsed.data;
    const customerId = req.user.id;
    if (vendorId === customerId)
        throw new AppError_1.ValidationError("You cannot follow yourself.");
    // Previously accepted any userId with no check it was actually a vendor
    // — a customer could "follow" another customer, or an id that doesn't
    // exist at all, producing junk follow records with no vendor to ever
    // show up against.
    const targetVendor = await prisma_1.default.user.findUnique({ where: { id: vendorId }, select: { id: true, role: true } });
    if (!targetVendor || targetVendor.role !== "VENDOR")
        throw new AppError_1.NotFoundError("Vendor");
    const existing = await prisma_1.default.vendorFollower.findUnique({ where: { vendorId_customerId: { vendorId, customerId } } });
    if (existing)
        throw new AppError_1.ConflictError("You already follow this vendor.");
    const follow = await prisma_1.default.vendorFollower.create({ data: { vendorId, customerId } });
    // Previously enqueued to a queue whose only live worker had a local
    // stub that always threw "Function not implemented" — every one of
    // these jobs failed silently, no vendor ever actually got notified.
    // See vendorFollowWorker.ts for the full story (there were actually
    // three separate, competing definitions of this queue).
    await vendorFollowWorker_1.vendorFollowQueue.add("notifyVendorFollow", { vendorId, customerId });
    return (0, apiResponse_1.sendCreated)(res, { follow }, "Vendor followed successfully.");
};
exports.followVendor = followVendor;
// POST /vendor-follow/unfollow
const unfollowVendor = async (req, res) => {
    const parsed = vendorFollowSchema_1.unfollowVendorSchema.safeParse(req.body);
    if (!parsed.success)
        throw new AppError_1.ValidationError("Invalid request", parsed.error.flatten().fieldErrors);
    const { vendorId } = parsed.data;
    const customerId = req.user.id;
    const existing = await prisma_1.default.vendorFollower.findUnique({ where: { vendorId_customerId: { vendorId, customerId } } });
    if (!existing)
        throw new AppError_1.NotFoundError("Follow relationship");
    await prisma_1.default.vendorFollower.delete({ where: { id: existing.id } });
    return (0, apiResponse_1.sendSuccess)(res, {}, "Vendor unfollowed successfully.");
};
exports.unfollowVendor = unfollowVendor;
// GET /vendor-follow/:vendorId/is-following
const isFollowingVendor = async (req, res) => {
    const vendorId = (0, paramUtils_1.ensureString)(req.params.vendorId);
    const customerId = req.user.id;
    const follow = await prisma_1.default.vendorFollower.findUnique({ where: { vendorId_customerId: { vendorId, customerId } } });
    return (0, apiResponse_1.sendSuccess)(res, { following: !!follow }, "Follow status fetched.");
};
exports.isFollowingVendor = isFollowingVendor;
// GET /vendor-follow/:vendorId/followers
const getVendorFollowers = async (req, res) => {
    const vendorId = (0, paramUtils_1.ensureString)(req.params.vendorId);
    const { page, limit, skip } = getPagination(req);
    // A popular vendor could have thousands of followers — this used to
    // return every single one in one unbounded response.
    const [followers, total] = await Promise.all([
        prisma_1.default.vendorFollower.findMany({
            where: { vendorId },
            include: { customer: { select: { id: true, name: true, avatarUrl: true } } },
            orderBy: { createdAt: "desc" },
            skip,
            take: limit,
        }),
        prisma_1.default.vendorFollower.count({ where: { vendorId } }),
    ]);
    return (0, apiResponse_1.sendSuccess)(res, { followers }, "Followers retrieved.", 200, { page, limit, total, totalPages: Math.ceil(total / limit) });
};
exports.getVendorFollowers = getVendorFollowers;
// GET /vendor-follow/:vendorId/follower-count
// Lightweight — for a vendor profile header ("1,234 followers") that
// shouldn't have to fetch every follower row just to display a count.
const getVendorFollowerCount = async (req, res) => {
    const vendorId = (0, paramUtils_1.ensureString)(req.params.vendorId);
    const count = await prisma_1.default.vendorFollower.count({ where: { vendorId } });
    return (0, apiResponse_1.sendSuccess)(res, { count }, "Follower count retrieved.");
};
exports.getVendorFollowerCount = getVendorFollowerCount;
// GET /vendor-follow/following
const getFollowedVendors = async (req, res) => {
    const customerId = req.user.id;
    const { page, limit, skip } = getPagination(req);
    const [follows, total] = await Promise.all([
        prisma_1.default.vendorFollower.findMany({
            where: { customerId },
            include: { vendor: { select: { id: true, name: true, brandName: true, brandLogo: true } } },
            orderBy: { createdAt: "desc" },
            skip,
            take: limit,
        }),
        prisma_1.default.vendorFollower.count({ where: { customerId } }),
    ]);
    return (0, apiResponse_1.sendSuccess)(res, { follows }, "Followed vendors retrieved.", 200, { page, limit, total, totalPages: Math.ceil(total / limit) });
};
exports.getFollowedVendors = getFollowedVendors;
