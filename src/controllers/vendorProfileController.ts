import { Request, Response } from "express";
import { ensureString } from "../utils/paramUtils";
import { sendSuccess } from "../utils/apiResponse";
import { loadPublicVendorProfile } from "../services/vendorProfile.service";

/**
 * GET /api/vendors/:vendorId — the public vendor profile (B-2).
 *
 * Public and read-only: no authentication is required, because the profile
 * only carries public information. The vendor DASHBOARD (`/api/vendor/*`)
 * is a different, authenticated surface and is untouched by this endpoint.
 *
 * Errors follow the project envelope:
 *   400 { success: false, message, code: "VALIDATION_ERROR" } — malformed id
 *   404 { success: false, message, code: "NOT_FOUND" }          — unknown,
 *       non-vendor, blocked or suspended vendor
 */
export const getPublicVendorProfile = async (req: Request, res: Response) => {
  const vendorId = ensureString(req.params.vendorId);
  const vendor = await loadPublicVendorProfile(vendorId);
  return sendSuccess(res, { vendor }, "Vendor profile fetched successfully");
};
