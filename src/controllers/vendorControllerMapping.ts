import { Request, Response } from "express";
import prisma from "../lib/prisma";

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
    include: {
      addresses: {
        where: { isDefault: true }, // vendor’s main/default address
      },
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
      const distance = R * c;

      return {
        id: vendor.id,
        name: vendor.name,
        brandName: vendor.brandName,
        distance,
      };
    })
    .filter(Boolean)
    .filter((v) => v!.distance <= radiusKm)
    .sort((a, b) => a!.distance - b!.distance);

  return nearby;
}
