import { Request, Response } from "express";
import prisma from "../lib/prisma";
import { isVendorOperating } from "../services/vendorAvailability.service";

/**
 * Whether a vendor is open right now (Bottom Pot Stage 1: no scheduling).
 *
 * A vendor is open while they are live on the marketplace AND have not
 * explicitly paused orders via `deliveryPreferences.acceptingOrders`.
 * There is no operating-hours schedule anymore — vendors sell whenever
 * they are accepting orders.
 */
export function computeVendorIsOpen(vendor: {
  isLive: boolean;
  deliveryPreferences?: unknown;
}): boolean {
  return isVendorOperating(vendor);
}

export async function getNearbyVendors(req: Request, res: Response) {
  try {
    const { lat, lng, radius } = req.query;

    if (!lat || !lng) {
      return res.status(400).json({ success: false, error: "lat & lng required" });
    }

    const vendors = await findNearbyVendors(
      parseFloat(lat as string),
      parseFloat(lng as string),
      radius ? parseFloat(radius as string) : 5
    );

    return res.json({ success: true, data: vendors });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, error: "Server error" });
  }
}

export async function findNearbyVendors(lat: number, lng: number, radiusKm: number) {
  const vendors = await prisma.user.findMany({
    where: { role: "VENDOR" },
    select: {
      id: true,
      name: true,
      brandName: true,
      brandLogo: true,
      avatarUrl: true,
      isLive: true,
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
