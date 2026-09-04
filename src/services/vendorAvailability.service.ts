import prisma from "../lib/prisma";
import { ValidationError } from "../errors/AppError";

// ─────────────────────────────────────────────────────────────────────────────
// Marketplace-availability service (Bottom Pot Stage 1: no product scheduling)
//
// ONE definition of "can this product be bought right now?" used by the
// home feed, cart, checkout and payment flows. Nothing here mutates state.
//
// Semantics:
//   Vendor operating      = vendor.isLive AND deliveryPreferences does not
//                           explicitly disable acceptingOrders
//   Product available     = NOT archived AND in stock
//                           (untracked products are always in stock;
//                           tracked products need stock > 0)
//   Marketplace available = vendor operating AND product available
// ─────────────────────────────────────────────────────────────────────────────

export interface VendorOperatingState {
  id: string;
  isLive: boolean;
  kycStatus?: string | null;
  deliveryPreferences?: unknown;
}

export interface ProductAvailabilityInput {
  archived: boolean;
  trackInventory?: boolean | null;
  stock?: number | null;
}

/**
 * Stock rule: untracked products are always in stock; tracked products
 * need at least one remaining portion. Sold out (0) is NOT orderable.
 */
export function isProductInStock(product: {
  trackInventory?: boolean | null;
  stock?: number | null;
}): boolean {
  if (!product.trackInventory) return true;
  return (product.stock ?? 0) > 0;
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
 * Product-level availability: not archived AND in stock.
 * (Vendor operating state is checked separately via isVendorOperating.)
 */
export function isProductCurrentlyAvailable(
  product: ProductAvailabilityInput,
): boolean {
  return product.archived === false && isProductInStock(product);
}

/** The single marketplace-availability rule. */
export function isProductMarketplaceAvailable(
  product: ProductAvailabilityInput,
  vendor: VendorOperatingState,
): boolean {
  return isVendorOperating(vendor) && isProductCurrentlyAvailable(product);
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
