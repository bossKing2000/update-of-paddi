import { Product, ProductSchedule } from "@prisma/client";
import { nowUtc, addMinutesUtc } from "../utils/time";

/**
 * 🕒 Computes whether a product is currently "live"
 * - Uses strict UTC comparison across all timestamps
 * - Respects goLiveAt, takeDownAt, and graceMinutes
 * - Returns false if product is archived or marked offline
 */
export function computeIsLive(
  product: Pick<Product, "isLive" | "archived"> &
    Partial<
      Pick<
        ProductSchedule,
        "goLiveAt" | "takeDownAt" | "graceMinutes" | "isLive"
      >
    >
): boolean {
  // 🚫 Not live or archived
  if (!product.isLive || product.archived) return false;

  const now = nowUtc();

  // 🕓 Check schedule if both exist
  if (product.goLiveAt && product.takeDownAt) {
    const graceMinutes = product.graceMinutes ?? 0;

    const liveFromUtc = new Date(product.goLiveAt); 
    const takeDownUtc = new Date(product.takeDownAt);
    const liveUntilUtc = addMinutesUtc(takeDownUtc, graceMinutes);

    // ✅ Compare UTC times
    return now >= liveFromUtc && now <= liveUntilUtc;
  }

  // 🧩 Fallback to product flag
  return product.isLive && !product.archived;
}
