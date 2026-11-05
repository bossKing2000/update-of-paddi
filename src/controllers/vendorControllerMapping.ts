import { Request, Response } from "express";
import { Role } from "@prisma/client";
import prisma from "../lib/prisma";
import { isVendorOperating } from "../services/vendorAvailability.service";
import { ensureString } from "../utils/paramUtils";
import { ValidationError } from "../errors/AppError";

/**
 * Whether a vendor is open right now (Bottom Pot Stage 1: no scheduling).
 *
 * A vendor is open while they are live on the marketplace, their status is
 * ACTIVE, and they have not explicitly paused orders via
 * `deliveryPreferences.acceptingOrders`. There is no operating-hours schedule
 * anymore — vendors sell whenever they are accepting orders.
 *
 * The vendor STATUS is part of the answer. `isVendorOperating` requires
 * `vendorStatus === "ACTIVE"`, so it has to be passed through: omitting it
 * made every vendor report as closed (the Phase 1C rule was added to
 * `isVendorOperating` without updating this wrapper). The status is
 * therefore forwarded explicitly here.
 */
export function computeVendorIsOpen(vendor: {
  isLive: boolean;
  vendorStatus?: string | null;
  deliveryPreferences?: unknown;
}): boolean {
  return isVendorOperating({
    isLive: vendor.isLive,
    vendorStatus: vendor.vendorStatus ?? null,
    deliveryPreferences: vendor.deliveryPreferences,
  });
}

/** The default search radius in kilometres. */
const DEFAULT_NEARBY_RADIUS_KM = 5;

/**
 * GET /api/auth/nearby — vendors near a point.
 *
 * ERROR ENVELOPE (B-7)
 * --------------------
 * A validation failure now uses the project's standard envelope:
 *   { success: false, message, code: "VALIDATION_ERROR" }
 * with HTTP 400. It used to return a bespoke
 * `{ success: false, error: "lat & lng required" }`, which no client could
 * read with the same code path as every other validation failure.
 *
 * The SUCCESS envelope is deliberately unchanged
 * (`{ success: true, data: [...] }`): existing clients read `data` as the
 * vendor array.
 */
export async function getNearbyVendors(req: Request, res: Response) {
  const latRaw = ensureString(req.query.lat).trim();
  const lngRaw = ensureString(req.query.lng).trim();

  if (!latRaw || !lngRaw) {
    throw new ValidationError("lat and lng are required");
  }

  const lat = Number(latRaw);
  const lng = Number(lngRaw);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    throw new ValidationError("lat must be a number between -90 and 90");
  }
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) {
    throw new ValidationError("lng must be a number between -180 and 180");
  }

  const radiusRaw = ensureString(req.query.radius).trim();
  let radiusKm = DEFAULT_NEARBY_RADIUS_KM;
  if (radiusRaw) {
    const parsed = Number(radiusRaw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new ValidationError("radius must be a positive number");
    }
    radiusKm = parsed;
  }

  const vendors = await findNearbyVendors(lat, lng, radiusKm);

  return res.json({ success: true, data: vendors });
}

export async function findNearbyVendors(lat: number, lng: number, radiusKm: number) {
  const vendors = await prisma.user.findMany({
    where: { roles: { has: Role.VENDOR } },
    select: {
      id: true,
      name: true,
      brandName: true,
      brandLogo: true,
      avatarUrl: true,
      isLive: true,
      vendorStatus: true,
      deliveryPreferences: true,
      addresses: { where: { isDefault: true } },
    },
  });

  const R = 6371; // Earth radius in km
  const toRad = (value: number) => (value * Math.PI) / 180;

  const nearby = vendors
    .map((vendor) => {
      const addr = vendor.addresses[0];
      if (!addr || addr.latitude == null || addr.longitude == null) return null;

      const dLat = toRad(addr.latitude - lat);
      const dLon = toRad(addr.longitude - lng);

      const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(lat)) * Math.cos(toRad(addr.latitude)) * Math.sin(dLon / 2) ** 2;

      const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      const distanceKm = R * c;

      return {
        id: vendor.id,
        name: vendor.name,
        brandName: vendor.brandName,
        brandLogo: vendor.brandLogo || vendor.avatarUrl,
        distanceKm,
        isOpen: computeVendorIsOpen({
          isLive: vendor.isLive,
          vendorStatus: vendor.vendorStatus,
          deliveryPreferences: vendor.deliveryPreferences,
        }),
      };
    })
    .filter((v): v is NonNullable<typeof v> => v !== null)
    .filter((v) => v.distanceKm <= radiusKm)
    .sort((a, b) => a.distanceKm - b.distanceKm);

  if (nearby.length === 0) return nearby;

  // Single batched aggregate instead of one query per vendor.
  const ratings = await prisma.vendorReview.groupBy({
    by: ["vendorId"],
    where: { vendorId: { in: nearby.map((v) => v.id) } },
    _avg: { rating: true },
    _count: { rating: true },
  });
  const ratingByVendor = new Map(ratings.map((r) => [r.vendorId, r]));

  return nearby.map((v) => {
    const rating = ratingByVendor.get(v.id);
    return {
      ...v,
      averageRating: rating?._avg.rating ?? null,
      reviewCount: rating?._count.rating ?? 0,
    };
  });
}
