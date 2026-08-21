import prisma from "../lib/prisma";
import haversine from "haversine-distance";

/**
 * Delivery fee calculation. Did not exist anywhere in update-of-paddi
 * before this — every delivery was effectively free, and there was no
 * check on whether a vendor could even physically reach a customer's
 * address.
 *
 * Tunable via env vars so pricing can be adjusted without a code change.
 */
const BASE_FEE = Number(process.env.DELIVERY_BASE_FEE) || 300; // ₦300 flat base
const PER_KM_RATE = Number(process.env.DELIVERY_PER_KM_RATE) || 100; // ₦100/km
const FREE_DELIVERY_THRESHOLD = Number(process.env.FREE_DELIVERY_THRESHOLD) || 15000; // per-vendor subtotal
const MAX_DELIVERY_DISTANCE_KM = Number(process.env.MAX_DELIVERY_DISTANCE_KM) || 20;

export interface DeliveryFeeResult {
  fee: number;
  distanceKm: number | null;
  withinRange: boolean;
  freeDelivery: boolean;
  reason?: string; // set when coordinates were missing and a flat fallback fee was used
}

/**
 * Computes the delivery fee from one vendor to one delivery address.
 * A cart is often multi-vendor, so this is called once per vendor group —
 * each vendor is a separate pickup point at a (potentially very
 * different) distance, so each gets its own fee.
 */
export async function calculateDeliveryFee(
  vendorId: string,
  addressId: string,
  vendorSubtotal: number
): Promise<DeliveryFeeResult> {
  const [vendorAddress, customerAddress] = await Promise.all([
    prisma.address.findFirst({
      where: { userId: vendorId, isDefault: true },
      select: { latitude: true, longitude: true },
    }),
    prisma.address.findUnique({
      where: { id: addressId },
      select: { latitude: true, longitude: true },
    }),
  ]);

  if (
    !vendorAddress?.latitude || !vendorAddress?.longitude ||
    !customerAddress?.latitude || !customerAddress?.longitude
  ) {
    // Missing coordinates on either side — fall back to the flat base fee
    // rather than blocking checkout entirely. Better to charge a
    // reasonable flat rate than hard-fail an order because a vendor or
    // customer hasn't pinned exact coordinates on their address.
    return {
      fee: BASE_FEE,
      distanceKm: null,
      withinRange: true,
      freeDelivery: false,
      reason: "Missing coordinates — flat base fee applied",
    };
  }

  const distanceKm = haversine(
    { lat: vendorAddress.latitude, lon: vendorAddress.longitude },
    { lat: customerAddress.latitude, lon: customerAddress.longitude }
  ) / 1000;

  const withinRange = distanceKm <= MAX_DELIVERY_DISTANCE_KM;
  const freeDelivery = vendorSubtotal >= FREE_DELIVERY_THRESHOLD;
  const fee = freeDelivery ? 0 : Math.round(BASE_FEE + distanceKm * PER_KM_RATE);

  return {
    fee,
    distanceKm: Math.round(distanceKm * 10) / 10,
    withinRange,
    freeDelivery,
  };
}
