import { Response, NextFunction } from "express";
import prisma from "../lib/prisma";
import { AuthRequest } from "./auth.middleware";
import { UnauthorizedError } from "../errors/AppError";
import {
  assertRiderApproved,
  assertRiderOperational,
  loadRiderEligibility,
} from "../services/riderEligibility.service";

/**
 * Task 3 rider onboarding enforcement.
 *
 * authorizeDeliveryPerson (auth.middleware.ts) proves the account HOLDS the
 * DELIVERY role. That is an identity check, not a permission check: a profile
 * created by /register or /select-role is INACTIVE, and an administrator must
 * move it to ACTIVE before the rider may do delivery work. These two
 * middlewares close that gap on the delivery router, mirroring
 * requireVendorNotSuspended on the vendor router.
 *
 * requireRiderApproved  -> approved account, NOT necessarily on shift.
 *                          Used for account-management surfaces (bank details).
 * requireRiderOnShift   -> approved AND isOnline. Used for dispatch-facing
 *                          surfaces (offers, acceptance, location, status).
 *
 * Both run the authoritative read at the boundary, so a direct service call
 * that bypasses the router is still covered by the controller-level assertion.
 */
export const requireRiderApproved = async (
  req: AuthRequest,
  _res: Response,
  next: NextFunction,
) => {
  const userId = req.user?.id;
  if (!userId) throw new UnauthorizedError();
  // A read failure throws out of here and no handler runs: fail closed.
  assertRiderApproved(await loadRiderEligibility(userId, prisma));
  next();
};

export const requireRiderOnShift = async (
  req: AuthRequest,
  _res: Response,
  next: NextFunction,
) => {
  const userId = req.user?.id;
  if (!userId) throw new UnauthorizedError();
  assertRiderOperational(await loadRiderEligibility(userId, prisma));
  next();
};