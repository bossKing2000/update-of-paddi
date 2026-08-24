import { Request, Response } from "express";
import prisma from "../lib/prisma";

const DAY_KEYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

interface DayHours {
  enabled: boolean;
  open?: string | null;
  close?: string | null;
}

interface OperatingHours {
  timezone?: string;
  [day: string]: unknown;
}

interface DeliveryPreferences {
  acceptingOrders?: boolean;
}

/**
 * Whether a vendor is open right now. Two independent signals, either of
 * which can close them:
 *   - `deliveryPreferences.acceptingOrders === false` — an explicit manual
 *     pause, independent of the schedule
 *   - today's entry in `operatingHours` (evaluated in the vendor's own
 *     timezone, defaulting to Africa/Lagos) not being enabled or the
 *     current time falling outside its open/close window
 *
 * A vendor who has never configured either setting is treated as open —
 * same "no schedule configured" default `computeIsLive` uses for products
 * with no ProductSchedule row.
 */
export function computeVendorIsOpen(
  operatingHours: OperatingHours | null | undefined,
  deliveryPreferences: DeliveryPreferences | null | undefined,
): boolean {
  if (deliveryPreferences?.acceptingOrders === false) return false;
  if (!operatingHours) return true;

  const timezone = operatingHours.timezone || "Africa/Lagos";
  let dayKey: string;
  let hhmm: string;
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      weekday: "long",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(new Date());
    dayKey = (parts.find((p) => p.type === "weekday")?.value || "").toLowerCase();
    const hour = parts.find((p) => p.type === "hour")?.value || "00";
    const minute = parts.find((p) => p.type === "minute")?.value || "00";
    hhmm = `${hour === "24" ? "00" : hour}:${minute}`;
  } catch {
    // Bad/unrecognized timezone string shouldn't hide a vendor from search.
    return true;
  }

  if (!DAY_KEYS.includes(dayKey)) return true;
  const today = operatingHours[dayKey] as DayHours | undefined;
  if (!today || today.enabled !== true) return false;
  if (!today.open || !today.close) return true; // enabled, no explicit window = open all day

  // Overnight windows, e.g. open 18:00 close 02:00.
  if (today.close < today.open) return hhmm >= today.open || hhmm <= today.close;
  return hhmm >= today.open && hhmm <= today.close;
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
      operatingHours: true,
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
        isOpen: computeVendorIsOpen(
          vendor.operatingHours as OperatingHours | null,
          vendor.deliveryPreferences as DeliveryPreferences | null,
        ),
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
