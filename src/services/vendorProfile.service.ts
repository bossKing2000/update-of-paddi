/**
 * Public vendor profile (catalog hardening B-2).
 *
 * A read-only, PUBLIC view of a vendor for the customer-facing Vendor
 * Profile screen. It is deliberately NOT part of the vendor dashboard
 * (`/api/vendor/*`): that surface is the vendor's own, authenticated view of
 * their account, and nothing here weakens it.
 *
 * WHAT IS EXPOSED
 * ---------------
 * Only what the profile screen needs, and only what the backend can
 * determine truthfully:
 *
 *   id, name, brandName, brandLogo, avatarUrl  — public identity
 *   bio                                        — the vendor's public biography
 *   isOpen                                     — the canonical operating state
 *   averageRating / reviewCount                — from the vendor's reviews
 *   followerCount                              — from the vendor's followers
 *   productCount                               — from the vendor's catalogue
 *
 * WHAT IS NOT EXPOSED
 * -------------------
 * Moderation state and reasons, KYC data, the internal delivery settings,
 * payout/bank details, commission rates, account credentials and any other
 * private user field. The response is built from an explicit `select`, so a
 * field that is not listed here cannot appear by accident.
 *
 * VISIBILITY RULES (documented, not invented)
 * -------------------------------------------
 * A vendor is publicly discoverable when:
 *   - the account exists AND holds the VENDOR role, and
 *   - the account is not blocked (`isBlocked`), and
 *   - the vendor is not SUSPENDED (a moderated vendor is not advertised).
 *
 * An OFFLINE vendor (isLive = false) is still discoverable: plain browse
 * keeps an offline vendor's products visible with `orderable = false`, so
 * hiding the vendor would contradict the catalogue. `isOpen` reports the
 * difference truthfully instead.
 */
import { Role } from "@prisma/client";
import prisma from "../lib/prisma";
import { NotFoundError, ValidationError } from "../errors/AppError";
import { isVendorOperating } from "./vendorAvailability.service";

/** A UUID — the shape every id in this schema uses. */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PublicVendorProfile {
  id: string;
  /** The account display name. */
  name: string;
  /** The public store name. */
  brandName: string | null;
  /** The public store logo. */
  brandLogo: string | null;
  /** The public avatar. */
  avatarUrl: string | null;
  /** The vendor's public biography. */
  bio: string | null;
  /**
   * Whether the vendor is currently operating (live + ACTIVE + accepting
   * orders). Computed by the canonical availability rules, so it is never a
   * guess and never a raw internal flag.
   */
  isOpen: boolean;
  /** Average of the vendor's ratings (null when they have none yet). */
  averageRating: number | null;
  /** How many vendor reviews exist. */
  reviewCount: number;
  /** How many customers follow the vendor. */
  followerCount: number;
  /**
   * How many products the vendor has in the catalogue.
   *
   * SEMANTICS: non-archived products only, regardless of whether the vendor
   * is currently operating or whether a product is in stock. That is the same
   * count semantic the category list documents ("the count describes the
   * category's catalog size"), so the two numbers mean the same thing.
   */
  productCount: number;
}

/**
 * Loads the public profile of one vendor.
 *
 * @throws {ValidationError} HTTP 400 / VALIDATION_ERROR when the id is not
 *   a well-formed id.
 * @throws {NotFoundError} HTTP 404 / NOT_FOUND when the vendor does not
 *   exist, is not a vendor, is blocked, or is suspended.
 */
export async function loadPublicVendorProfile(
  rawVendorId: string,
): Promise<PublicVendorProfile> {
  const vendorId = String(rawVendorId ?? "").trim();
  if (!UUID_PATTERN.test(vendorId)) {
    throw new ValidationError("Invalid vendor id");
  }

  const vendor = await prisma.user.findUnique({
    where: { id: vendorId },
    select: {
      id: true,
      name: true,
      brandName: true,
      brandLogo: true,
      avatarUrl: true,
      bio: true,
      isLive: true,
      vendorStatus: true,
      deliveryPreferences: true,
      role: true,
      roles: true,
      isBlocked: true,
    },
  });

  if (!vendor) throw new NotFoundError("Vendor");

  const holdsVendorRole =
    vendor.roles.includes(Role.VENDOR) || vendor.role === Role.VENDOR;
  if (!holdsVendorRole) throw new NotFoundError("Vendor");

  // A blocked account is not publicly discoverable.
  if (vendor.isBlocked) throw new NotFoundError("Vendor");

  // A suspended vendor is under moderation and must not be advertised.
  if (vendor.vendorStatus === "SUSPENDED") throw new NotFoundError("Vendor");

  const [ratingStats, followerCount, productCount] = await Promise.all([
    prisma.vendorReview.aggregate({
      where: { vendorId: vendor.id },
      _avg: { rating: true },
      _count: { rating: true },
    }),
    prisma.vendorFollower.count({ where: { vendorId: vendor.id } }),
    prisma.product.count({ where: { vendorId: vendor.id, archived: false } }),
  ]);

  return {
    id: vendor.id,
    name: vendor.name,
    brandName: vendor.brandName,
    brandLogo: vendor.brandLogo,
    avatarUrl: vendor.avatarUrl,
    bio: vendor.bio,
    isOpen: isVendorOperating({
      isLive: vendor.isLive,
      vendorStatus: vendor.vendorStatus,
      deliveryPreferences: vendor.deliveryPreferences,
    }),
    averageRating: ratingStats._avg.rating ?? null,
    reviewCount: ratingStats._count.rating ?? 0,
    followerCount,
    productCount,
  };
}
