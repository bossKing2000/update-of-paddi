import prisma from "../lib/prisma";
import { ValidationError } from "../errors/AppError";
import {
  evaluateProductSchedule,
  EvaluableProductSchedule,
} from "./scheduleRules.service";

// ─────────────────────────────────────────────────────────────────────────────
// Authoritative marketplace-availability service (Vendor Live migration)
//
// ONE definition of "can this product be bought right now?" used by the
// home feed, cart, checkout and payment flows. Product-schedule mirror
// maintenance (fixLiveStatusJob / productLiveWorker / productDeactivateJob)
// remains product-domain logic elsewhere; nothing here mutates state.
//
// Semantics:
//   Vendor operating      = vendor.isLive AND deliveryPreferences does not
//                           explicitly disable acceptingOrders
//   Product available     = NOT archived
//   Product schedule OK   = now inside [goLiveAt, takeDownAt + graceMinutes]
//                           when a schedule exists (missing/incomplete
//                           schedule defers to the stored isLive mirror,
//                           matching computeIsLive everywhere else)
//   Marketplace available = vendor operating AND product available
//                           AND product schedule OK
// ─────────────────────────────────────────────────────────────────────────────

export interface VendorOperatingState {
  id: string;
  isLive: boolean;
  kycStatus?: string | null;
  deliveryPreferences?: unknown;
  /** IANA timezone used to evaluate recurring schedules in vendor-local time. */
  timezone?: string | null;
  /** Legacy fallback for effective-timezone resolution. */
  operatingHours?: unknown;
}

/**
 * Effective business timezone of a vendor.
 * Resolution order: explicit column → legacy operatingHours.timezone → UTC.
 * (Never silently hardcoded to a specific city.)
 */
export function resolveVendorTimezone(
  timezone?: string | null,
  operatingHours?: unknown,
): string {
  if (timezone && timezone.trim() !== "") return timezone.trim();
  if (
    operatingHours &&
    typeof operatingHours === "object" &&
    typeof (operatingHours as Record<string, unknown>).timezone === "string" &&
    ((operatingHours as Record<string, unknown>).timezone as string).trim() !== ""
  ) {
    return ((operatingHours as Record<string, unknown>).timezone as string).trim();
  }
  return "UTC";
}

export interface ProductAvailabilityInput {
  archived: boolean;
  isLive: boolean;
  productSchedule?: EvaluableProductSchedule | null;
}

/** Vendors may pause orders without leaving the platform entirely. */
export function isVendorAcceptingOrders(deliveryPreferences: unknown): boolean {
  if (deliveryPreferences == null) return true;
  if (typeof deliveryPreferences !== "object") return true;
  const prefs = deliveryPreferences as Record<string, unknown>;
  return prefs.acceptingOrders !== false;
}

/** Vendor is currently operating on the marketplace. */
export function isVendorOperating(vendor: {
  isLive: boolean;
  deliveryPreferences?: unknown;
}): boolean {
  return vendor.isLive === true && isVendorAcceptingOrders(vendor.deliveryPreferences);
}

/**
 * Product-level availability — schedule evaluation + archived check.
 * Delegates to the single scheduling evaluator (scheduleRules.service):
 * WEEKLY schedules are evaluated in the vendor's effective timezone;
 * ONE_TIME/legacy rows use the absolute window with grace, deferring to the
 * stored mirror when no window exists (same semantics as computeIsLive).
 */
export function isProductCurrentlyAvailable(
  product: ProductAvailabilityInput,
  now: Date = new Date(),
  vendorTimezone?: string | null,
): boolean {
  if (product.archived) return false;

  return evaluateProductSchedule(
    product.productSchedule,
    now,
    vendorTimezone ?? null,
    product.isLive,
  );
}

/** The single marketplace-availability rule. */
export function isProductMarketplaceAvailable(
  product: ProductAvailabilityInput,
  vendor: VendorOperatingState,
  now: Date = new Date(),
): boolean {
  return (
    isVendorOperating(vendor) &&
    isProductCurrentlyAvailable(
      product,
      now,
      resolveVendorTimezone(vendor.timezone, vendor.operatingHours),
    )
  );
}

/** Loads the minimal vendor state needed for availability decisions. */
export async function loadVendorOperatingState(
  vendorId: string,
): Promise<VendorOperatingState | null> {
  const vendor = await prisma.user.findUnique({
    where: { id: vendorId },
    select: {
      id: true,
      isLive: true,
      deliveryPreferences: true,
      timezone: true,
      operatingHours: true,
    },
  });
  return vendor ?? null;
}

/**
 * Checkout/order-creation gate. Throws with an actionable message when the
 * vendor cannot currently accept orders — called as close to order creation
 * as possible so stale cart state can never bypass availability.
 */
export function assertVendorAvailableForOrdering(
  vendor: VendorOperatingState | null,
  vendorName = "This vendor",
): void {
  if (!vendor || vendor.isLive !== true) {
    throw new ValidationError(`${vendorName} is currently offline and cannot accept new orders.`);
  }
  if (!isVendorAcceptingOrders(vendor.deliveryPreferences)) {
    throw new ValidationError(`${vendorName} has paused new orders and cannot accept them right now.`);
  }
}
