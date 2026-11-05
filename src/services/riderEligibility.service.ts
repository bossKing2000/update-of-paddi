import { DeliveryPersonStatus, Prisma } from "@prisma/client";
import prisma from "../lib/prisma";
import { ForbiddenError, NotFoundError } from "../errors/AppError";

/**
 * Rider OPERATIONAL eligibility (Task 3).
 *
 * Holding the DELIVERY role proves identity, not permission. A rider profile
 * is created INACTIVE by /register and /select-role, and only an
 * administrator moves it to ACTIVE via PATCH /api/admin/delivery/:userId/status.
 * This module is the single place that decides whether an account may perform
 * a delivery operation, mirroring vendorStatus.service.ts so the two lifecycles
 * cannot drift apart.
 *
 * Deliberately NOT required here (see the Task 3 report for why):
 *  - KYC / NIN / selfie verification — the provider integration has unresolved
 *    questions and is not an enforced operational requirement today.
 *  - phone verification — no production SMS gateway exists yet.
 *  - vehicle approval — the RiderVehicleStatus review workflow exists but is
 *    read by nothing, so requiring it would be inventing a policy.
 * Imposing any of those is a separate, explicitly product-approved task.
 */

export const RIDER_STATUS_UNRESOLVED_MESSAGE =
  "We could not confirm your rider account status, so this action was not completed. Please try again or contact support.";

export const RIDER_NOT_ACTIVE_MESSAGE =
  "Your rider account is not approved for delivery operations yet.";

export const RIDER_EMAIL_UNVERIFIED_MESSAGE =
  "Verify your email address before performing delivery operations.";

export const RIDER_OFFLINE_MESSAGE = "Go online before performing this action.";

/** The minimum columns every eligibility decision reads. */
export const RIDER_ELIGIBILITY_SELECT = {
  id: true,
  status: true,
  isOnline: true,
  user: { select: { isEmailVerified: true } },
} satisfies Prisma.DeliveryPersonSelect;

export type RiderEligibility = {
  id: string;
  status: DeliveryPersonStatus | undefined;
  isOnline: boolean | undefined;
  isEmailVerified: boolean | undefined;
};

type EligibilityClient = Pick<typeof prisma, "deliveryPerson"> | Prisma.TransactionClient;

/**
 * Reads the authoritative eligibility row.
 *
 * Returns null when the profile does not exist. A read failure is NOT caught:
 * it propagates, so the caller fails closed with a 500 and performs no write.
 * Collapsing a failed lookup into "unknown but permitted" is exactly the bug
 * that isVendorStatusEstablishable was written to prevent on the vendor side.
 */
export async function loadRiderEligibility(
  userId: string,
  client: EligibilityClient = prisma,
): Promise<RiderEligibility | null> {
  const profile = await client.deliveryPerson.findUnique({
    where: { userId },
    select: RIDER_ELIGIBILITY_SELECT,
  });
  if (!profile) return null;
  return {
    id: profile.id,
    status: profile.status,
    isOnline: profile.isOnline,
    isEmailVerified: profile.user?.isEmailVerified,
  };
}

/**
 * True when a lifecycle status was actually read from storage.
 *
 * Mirrors isVendorStatusEstablishable. DeliveryPerson.status is a required
 * enum column, so a real value is always one of the three states; anything
 * else means the field was not read and we do not know what this rider is.
 */
export function isRiderStatusEstablishable(status: unknown): boolean {
  return Object.values(DeliveryPersonStatus).includes(status as DeliveryPersonStatus);
}

/**
 * The weakest gate: the rider profile exists at all.
 *
 * Used on the one path that must stay available to a non-approved rider —
 * going OFFLINE. It still refuses a caller with no profile, so the write can
 * never be aimed at a missing row.
 */
export function assertRiderProfileExists(
  profile: RiderEligibility | null,
): asserts profile is RiderEligibility {
  if (!profile) throw new NotFoundError("Rider profile");
}

/**
 * The approved/eloperational gate: an APPROVED rider.
 *
 * Requires the profile to exist, carry an established ACTIVE status, and have
 * a verified email. `isOnline` is deliberately NOT required here — it is a
 * separate dispatch condition, applied by assertRiderOperational only where
 * the action genuinely needs the rider on shift (offers, acceptance, location,
 * status changes). Bank details and proof submission use this weaker gate.
 */
export function assertRiderApproved(profile: RiderEligibility | null): asserts profile is RiderEligibility {
  if (!profile) throw new NotFoundError("Rider profile");
  if (!isRiderStatusEstablishable(profile.status)) {
    throw new ForbiddenError(RIDER_STATUS_UNRESOLVED_MESSAGE);
  }
  if (profile.status !== DeliveryPersonStatus.ACTIVE) {
    throw new ForbiddenError(RIDER_NOT_ACTIVE_MESSAGE);
  }
  if (profile.isEmailVerified !== true) {
    throw new ForbiddenError(RIDER_EMAIL_UNVERIFIED_MESSAGE);
  }
}

/**
 * The dispatch gate: an APPROVED rider who is currently on shift.
 *
 * This is exactly the predicate the dispatch code already used to select
 * candidates (isOnline + ACTIVE + isEmailVerified), promoted to a reusable
 * assertion so a route can no longer reach delivery work by holding the role
 * alone.
 */
export function assertRiderOperational(
  profile: RiderEligibility | null,
): asserts profile is RiderEligibility {
  assertRiderApproved(profile);
  if (profile.isOnline !== true) throw new ForbiddenError(RIDER_OFFLINE_MESSAGE);
}

/**
 * Convenience: load then assert. `requireOnline` selects the gate.
 *
 * Used at controller boundaries. `tx` lets a caller that already holds a
 * transaction read the row inside it rather than opening a second connection.
 */
export async function requireRiderEligibility(
  userId: string,
  opts: { requireOnline?: boolean; client?: EligibilityClient } = {},
): Promise<RiderEligibility> {
  const profile = await loadRiderEligibility(userId, opts.client ?? prisma);
  if (opts.requireOnline) assertRiderOperational(profile);
  else assertRiderApproved(profile);
  return profile;
}