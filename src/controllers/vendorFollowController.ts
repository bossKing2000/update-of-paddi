import { Response } from "express";
import prisma from "../lib/prisma";
import { ensureString } from "../utils/paramUtils";
import { followVendorSchema, unfollowVendorSchema } from "../validations/vendorFollowSchema";
import { AuthRequest } from "../middlewares/auth.middleware";
import { vendorFollowQueue } from "../jobs/workers jobs/vendorFollowWorker";
import { sendSuccess, sendCreated } from "../utils/apiResponse";
import { NotFoundError, ValidationError, ConflictError } from "../errors/AppError";

function getPagination(req: AuthRequest) {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25));
  return { page, limit, skip: (page - 1) * limit };
}

// POST /vendor-follow/follow
export const followVendor = async (req: AuthRequest, res: Response) => {
  const parsed = followVendorSchema.safeParse(req.body);
  if (!parsed.success) throw new ValidationError("Invalid request", parsed.error.flatten().fieldErrors);

  const { vendorId } = parsed.data;
  const customerId = req.user!.id;

  if (vendorId === customerId) throw new ValidationError("You cannot follow yourself.");

  // Previously accepted any userId with no check it was actually a vendor
  // — a customer could "follow" another customer, or an id that doesn't
  // exist at all, producing junk follow records with no vendor to ever
  // show up against.
  const targetVendor = await prisma.user.findUnique({ where: { id: vendorId }, select: { id: true, role: true } });
  if (!targetVendor || targetVendor.role !== "VENDOR") throw new NotFoundError("Vendor");

  const existing = await prisma.vendorFollower.findUnique({ where: { vendorId_customerId: { vendorId, customerId } } });
  if (existing) throw new ConflictError("You already follow this vendor.");

  const follow = await prisma.vendorFollower.create({ data: { vendorId, customerId } });

  // Previously enqueued to a queue whose only live worker had a local
  // stub that always threw "Function not implemented" — every one of
  // these jobs failed silently, no vendor ever actually got notified.
  // See vendorFollowWorker.ts for the full story (there were actually
  // three separate, competing definitions of this queue).
  await vendorFollowQueue.add("notifyVendorFollow", { vendorId, customerId });

  return sendCreated(res, { follow }, "Vendor followed successfully.");
};

// POST /vendor-follow/unfollow
export const unfollowVendor = async (req: AuthRequest, res: Response) => {
  const parsed = unfollowVendorSchema.safeParse(req.body);
  if (!parsed.success) throw new ValidationError("Invalid request", parsed.error.flatten().fieldErrors);

  const { vendorId } = parsed.data;
  const customerId = req.user!.id;

  const existing = await prisma.vendorFollower.findUnique({ where: { vendorId_customerId: { vendorId, customerId } } });
  if (!existing) throw new NotFoundError("Follow relationship");

  await prisma.vendorFollower.delete({ where: { id: existing.id } });
  return sendSuccess(res, {}, "Vendor unfollowed successfully.");
};

// GET /vendor-follow/:vendorId/is-following
export const isFollowingVendor = async (req: AuthRequest, res: Response) => {
  const vendorId = ensureString(req.params.vendorId);
  const customerId = req.user!.id;

  const follow = await prisma.vendorFollower.findUnique({ where: { vendorId_customerId: { vendorId, customerId } } });
  return sendSuccess(res, { following: !!follow }, "Follow status fetched.");
};

// GET /vendor-follow/:vendorId/followers
export const getVendorFollowers = async (req: AuthRequest, res: Response) => {
  const vendorId = ensureString(req.params.vendorId);
  const { page, limit, skip } = getPagination(req);

  // A popular vendor could have thousands of followers — this used to
  // return every single one in one unbounded response.
  const [followers, total] = await Promise.all([
    prisma.vendorFollower.findMany({
      where: { vendorId },
      include: { customer: { select: { id: true, name: true, avatarUrl: true } } },
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
    }),
    prisma.vendorFollower.count({ where: { vendorId } }),
  ]);

  return sendSuccess(res, { followers }, "Followers retrieved.", 200, { page, limit, total, totalPages: Math.ceil(total / limit) });
};

// GET /vendor-follow/:vendorId/follower-count
// Lightweight — for a vendor profile header ("1,234 followers") that
// shouldn't have to fetch every follower row just to display a count.
export const getVendorFollowerCount = async (req: AuthRequest, res: Response) => {
  const vendorId = ensureString(req.params.vendorId);
  const count = await prisma.vendorFollower.count({ where: { vendorId } });
  return sendSuccess(res, { count }, "Follower count retrieved.");
};

// GET /vendor-follow/following
export const getFollowedVendors = async (req: AuthRequest, res: Response) => {
  const customerId = req.user!.id;
  const { page, limit, skip } = getPagination(req);

  const [follows, total] = await Promise.all([
    prisma.vendorFollower.findMany({
      where: { customerId },
      include: { vendor: { select: { id: true, name: true, brandName: true, brandLogo: true } } },
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
    }),
    prisma.vendorFollower.count({ where: { customerId } }),
  ]);

  return sendSuccess(res, { follows }, "Followed vendors retrieved.", 200, { page, limit, total, totalPages: Math.ceil(total / limit) });
};
