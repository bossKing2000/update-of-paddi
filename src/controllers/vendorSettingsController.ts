import { Response } from "express";
import { AuthRequest } from "../middlewares/auth.middleware";
import prisma from "../lib/prisma";
import { sendSuccess } from "../utils/apiResponse";
import { ValidationError } from "../errors/AppError";
import {
  deliveryPreferencesSchema,
  operatingHoursSchema,
  serviceAreasSchema,
} from "../validations/vendorSettingsSchema";
import { createAuditLog } from "../utils/auditLog.service";
import { invalidateMarketplaceDiscoveryCaches } from "../services/clearCaches";

const vendorSelect = {
  operatingHours: true,
  deliveryPreferences: true,
  serviceAreas: true,
  order_openAT: true,
  order_closeAT: true,
  isLive: true,
} as const;

function parseOrThrow<T>(result: { success: boolean; data?: T; error?: { flatten: () => unknown } }, label: string): T {
  if (!result.success) {
    throw new ValidationError(`Invalid ${label}`, result.error?.flatten());
  }
  return result.data as T;
}

export const getVendorSettings = async (req: AuthRequest, res: Response) => {
  const vendor = await prisma.user.findUnique({ where: { id: req.user!.id }, select: vendorSelect });
  return sendSuccess(res, vendor, "Vendor settings retrieved");
};

export const updateOperatingHours = async (req: AuthRequest, res: Response) => {
  const operatingHours = parseOrThrow(operatingHoursSchema.safeParse(req.body), "operating hours");
  const monday = operatingHours.monday;
  const updated = await prisma.user.update({
    where: { id: req.user!.id },
    data: {
      operatingHours,
      order_openAT: monday.enabled ? monday.open ?? null : null,
      order_closeAT: monday.enabled ? monday.close ?? null : null,
    },
    select: vendorSelect,
  });
  await createAuditLog({ userId: req.user!.id, action: "VENDOR_OPERATING_HOURS_UPDATED", req, metadata: { operatingHours } });
  return sendSuccess(res, updated, "Operating hours saved");
};

export const updateDeliveryPreferences = async (req: AuthRequest, res: Response) => {
  const deliveryPreferences = parseOrThrow(deliveryPreferencesSchema.safeParse(req.body), "delivery preferences");
  const updated = await prisma.user.update({ where: { id: req.user!.id }, data: { deliveryPreferences }, select: vendorSelect });
  await createAuditLog({ userId: req.user!.id, action: "VENDOR_DELIVERY_PREFERENCES_UPDATED", req, metadata: { deliveryPreferences } });
  return sendSuccess(res, updated, "Delivery preferences saved");
};

export const updateServiceAreas = async (req: AuthRequest, res: Response) => {
  const serviceAreas = parseOrThrow(serviceAreasSchema.safeParse(req.body), "service areas");
  const updated = await prisma.user.update({ where: { id: req.user!.id }, data: { serviceAreas }, select: vendorSelect });
  await createAuditLog({ userId: req.user!.id, action: "VENDOR_SERVICE_AREAS_UPDATED", req, metadata: { serviceAreas } });
  return sendSuccess(res, updated, "Service areas saved");
};

// ── Vendor Live (marketplace migration) ─────────────────────────────────────
import { z } from "zod";
import { redisProducts } from "../lib/redis";
import { scanKeys } from "../lib/redisScan";

const vendorLiveSchema = z.object({ isLive: z.boolean() });

async function invalidateVendorLiveCaches(): Promise<void> {
  // Vendor live state affects every marketplace-discovery surface.
  await invalidateMarketplaceDiscoveryCaches();
}

/**
 * PATCH /api/vendor/settings/live
 * Toggles whether this vendor is currently operating on the marketplace.
 * Going LIVE requires KYC verification (platform precondition recorded in
 * the schema). Going offline is always allowed — it pauses NEW marketplace
 * activity only: carts keep their items, existing/paid orders are untouched,
 * and product detail pages remain viewable.
 */
export const updateVendorLive = async (req: AuthRequest, res: Response) => {
  const parsed = vendorLiveSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new ValidationError("Invalid live status", parsed.error.flatten());
  }
  const { isLive } = parsed.data;

  // KYC status lives on the User row, not in the JWT — load it fresh.
  const vendor = await prisma.user.findUnique({
    where: { id: req.user!.id },
    select: { kycStatus: true },
  });
  if (isLive && vendor?.kycStatus !== "VERIFIED") {
    throw new ValidationError("KYC verification is required before going live.");
  }

  const updated = await prisma.user.update({
    where: { id: req.user!.id },
    data: { isLive },
    select: { ...vendorSelect, isLive: true },
  });

  await invalidateVendorLiveCaches();
  await createAuditLog({
    userId: req.user!.id,
    action: isLive ? "VENDOR_WENT_LIVE" : "VENDOR_WENT_OFFLINE",
    req,
    metadata: { isLive },
  });

  return sendSuccess(res, updated, isLive ? "Vendor is now live" : "Vendor is now offline");
};
