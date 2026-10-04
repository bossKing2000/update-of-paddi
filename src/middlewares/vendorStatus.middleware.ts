import { Response, NextFunction } from "express";
import prisma from "../lib/prisma";
import { AuthRequest } from "./auth.middleware";
import { ForbiddenError, UnauthorizedError } from "../errors/AppError";

/**
 * Phase 1C vendor onboarding enforcement.
 *
 * Blocks SUSPENDED vendors from vendor WRITE surfaces (products, promos,
 * uploads, settings). NEW / PENDING_REVIEW vendors pass through (they may
 * prepare menus and settings); orderability itself is gated separately by
 * vendorStatus === ACTIVE in the availability service. Read routes
 * (dashboard, settings reads, support tickets) intentionally stay open.
 */
export const requireVendorNotSuspended = async (
  req: AuthRequest,
  _res: Response,
  next: NextFunction,
) => {
  const userId = req.user?.id;
  if (!userId) throw new UnauthorizedError();

  const vendor = await prisma.user.findUnique({
    where: { id: userId },
    select: { vendorStatus: true },
  });
  if (vendor?.vendorStatus === "SUSPENDED") {
    throw new ForbiddenError(
      "Your vendor account is suspended and cannot make changes right now. Contact support.",
    );
  }
  next();
};
