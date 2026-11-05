import { Response, NextFunction } from "express";
import prisma from "../lib/prisma";
import { AuthRequest } from "./auth.middleware";
import { ForbiddenError, UnauthorizedError } from "../errors/AppError";
import {
  assertVendorNotSuspended,
  isVendorStatusEstablishable,
  VENDOR_STATUS_UNRESOLVED_MESSAGE,
} from "../services/vendorStatus.service";

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

  // FAIL CLOSED (Batch 1C hardening). `vendor` is null when the row is gone,
  // and `vendorStatus` is undefined when the field could not be read at all.
  // Neither is evidence that the vendor is unsuspended — it is only evidence
  // that we do not know. Collapsing both into `?? null` turned "unknown" into
  // "permitted", which let a write through on a failed or missing lookup.
  // The order-lifecycle guard already refuses the same ambiguity
  // (orderController.ts, via isVendorStatusEstablishable); this reuses the
  // SAME helper and message so the two enforcement sites cannot drift.
  //
  // A genuinely null vendorStatus — the schema's modelled "holds VENDOR, the
  // status system has not run yet" state — still establishes a status and is
  // therefore allowed through, exactly as before.
  if (!vendor || !isVendorStatusEstablishable(vendor.vendorStatus)) {
    throw new ForbiddenError(VENDOR_STATUS_UNRESOLVED_MESSAGE);
  }

  // Batch 1D.41: the suspension policy now lives in one place
  // (vendorStatus.service.assertVendorNotSuspended) so this middleware and
  // the payout / order-status guards cannot drift apart.
  assertVendorNotSuspended(vendor.vendorStatus);
  next();
};
