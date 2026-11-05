/**
 * Public vendor projection (catalog hardening B-1).
 *
 * Every ANONYMOUS, customer-facing catalog response exposes the vendor
 * through this projection and NEVER through a raw Prisma vendor row.
 *
 * WHY THIS EXISTS
 * ---------------
 * The browse/search/detail queries used to `select` the vendor relation and
 * spread it into the response as-is. That leaked internal moderation state
 * (`vendorStatus`, `vendorStatusReason`) and the vendor's internal delivery
 * settings (`deliveryPreferences` — which carries `baseDeliveryFee`,
 * `deliveryRadiusKm`, `preparationTimeMinutes`) to anonymous callers. It also
 * leaked the raw `isLive` operating flag, which on its own is a MISLEADING
 * signal: a vendor can be `isLive = true` and still be SUSPENDED or paused,
 * so a client rendering "open" from `isLive` alone can be wrong.
 *
 * WHAT IS APPROVED FOR CUSTOMER DISPLAY
 * -------------------------------------
 * Public IDENTITY only:
 *   - `id`          — the vendor id (needed to build profile/order links)
 *   - `name`        — the account display name
 *   - `brandName`   — the public store name
 *   - `brandLogo`   — the public store logo
 *   - `avatarUrl`   — the public avatar
 *
 * The vendor's OPERATING state is NOT part of the vendor object. It is exposed
 * as a single computed, customer-safe boolean at the level where it is
 * meaningful:
 *   - product cards  -> `vendorOperating` (and `orderable`)
 *   - vendor profile -> `isOpen`
 * Both are computed by the canonical availability rules
 * (src/services/vendorAvailability.service.ts), so a client never has to
 * re-derive "is this vendor open?" from raw flags.
 *
 * This module is intentionally dependency-free so both the product-card
 * mapper and the vendor-profile service can use it without a cycle.
 */

/** The one customer-safe vendor shape used by every public surface. */
export interface PublicVendor {
  id: string;
  name: string;
  brandName: string | null;
  brandLogo: string | null;
  avatarUrl: string | null;
}

/**
 * Prisma `select` for a public vendor projection.
 *
 * Used by every query that reads a vendor for a customer-facing response.
 * It deliberately contains NO moderation, settings, money or account field.
 */
export const PUBLIC_VENDOR_SELECT = {
  id: true,
  name: true,
  brandName: true,
  brandLogo: true,
  avatarUrl: true,
} as const;

/**
 * The minimal row shape `toPublicVendor` accepts.
 *
 * Extra fields on the source row (isLive, vendorStatus, deliveryPreferences,
 * …) are accepted and IGNORED — that is the point: the projection is what
 * decides what leaves the server.
 */
export interface VendorRowLike {
  id?: string | null;
  name?: string | null;
  brandName?: string | null;
  brandLogo?: string | null;
  avatarUrl?: string | null;
}

/**
 * Projects any vendor-shaped row onto the public projection.
 *
 * Never throws: a missing vendor row degrades to empty identity fields rather
 * than failing the whole catalog response.
 */
export function toPublicVendor(
  vendor: VendorRowLike | null | undefined,
): PublicVendor {
  return {
    id: vendor?.id ?? "",
    name: vendor?.name ?? "",
    brandName: vendor?.brandName ?? null,
    brandLogo: vendor?.brandLogo ?? null,
    avatarUrl: vendor?.avatarUrl ?? null,
  };
}

/**
 * Re-projects the vendor of every product-shaped item in a list.
 *
 * Used on CACHE READ paths: entries written before this projection existed
 * still carry the raw vendor object for the remaining TTL (the product-list
 * caches live for hours), and a cache hit must never be able to re-introduce
 * a field the projection removed. Items without a `vendor` key are returned
 * untouched.
 */
export function projectPublicVendorList<T extends object>(
  items: T[] | null | undefined,
): T[] {
  if (!Array.isArray(items)) return [];
  return items.map((item) => {
    if (!item || typeof item !== "object") return item;
    const vendor = (item as { vendor?: unknown }).vendor;
    if (!vendor || typeof vendor !== "object") return item;
    return {
      ...item,
      vendor: toPublicVendor(vendor as VendorRowLike),
    } as T;
  });
}

/**
 * Internal vendor fields that must NEVER appear in an anonymous public
 * response.
 *
 * This list is the executable form of the B-1 requirement. It is exported so
 * the regression tests can assert on the exact same list the implementation
 * documents, instead of each test inventing its own copy.
 *
 * It covers four families:
 *   1. moderation / lifecycle state (vendorStatus, KYC, blocked)
 *   2. internal operating settings (deliveryPreferences, serviceAreas)
 *   3. money / payout details (bank details, commission rate)
 *   4. account credentials and private identifiers (email, phone, password…)
 */
export const PROHIBITED_PUBLIC_VENDOR_KEYS = [
  // 1. Moderation / lifecycle
  "vendorStatus",
  "vendorStatusReason",
  "vendorStatusChangedAt",
  "kycStatus",
  "nin",
  "ninData",
  "isBlocked",
  "blockedReason",
  "blockedAt",
  // 2. Internal operating settings
  "deliveryPreferences",
  "baseDeliveryFee",
  "deliveryRadiusKm",
  "preparationTimeMinutes",
  "acceptingOrders",
  "serviceAreas",
  "isLive",
  // 3. Money / payout
  "commissionRate",
  "bankName",
  "bankCode",
  "bankAccountNumber",
  "bankAccountName",
  "paystackRecipientCode",
  "potPointsBalance",
  // 4. Account, credentials and private identifiers
  "email",
  "emailVerificationToken",
  "emailVerificationExpiresAt",
  "password",
  "passwordResetToken",
  "username",
  "googleId",
  "phoneNumber",
  "phoneNumberE164",
  "phoneVerifiedAt",
  "isPhoneVerified",
  "authProviders",
  "loginMethod",
  "lastLoginAt",
  "tokenVersion",
  "referralCode",
  "referredByUserId",
  "role",
  "roles",
  "preferences",
  "emailVerificationTokenExpiresAt",
] as const;

/**
 * Returns the prohibited keys that are present on the given object.
 *
 * Used by the regression tests (and available to any future assertion) so a
 * leak is reported as the exact key that leaked.
 */
export function findProhibitedPublicVendorKeys(
  value: unknown,
): string[] {
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  return PROHIBITED_PUBLIC_VENDOR_KEYS.filter((key) =>
    Object.prototype.hasOwnProperty.call(record, key),
  );
}
