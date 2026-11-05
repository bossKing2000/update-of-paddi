import { Role, VendorStatus } from "@prisma/client";
import prisma from "../lib/prisma";
import { createAuditLog } from "../utils/auditLog.service";
import { sendNotification } from "../utils/activityUtils/notify";
import { ForbiddenError, NotFoundError, ValidationError } from "../errors/AppError";

// Phase 1C vendor onboarding lifecycle.
//
// - null        : not a vendor (or vendor role gained before this system)
// - NEW         : holds VENDOR, requirements not yet met
// - ACTIVE      : requirements met; may go live (isLive stays the switch)
// - PENDING_REVIEW: requirements met, manual approval needed
//                 (only when VENDOR_AUTO_APPROVE=false, default true)
// - SUSPENDED   : admin-set, cannot sell
//
// Requirements for ACTIVE (Phase 1D.4): brandName + verified canonical
// phone (phoneNumberE164 present AND isPhoneVerified) + kycStatus VERIFIED.
// The raw phoneNumber display field is never proof of verification.
// Bank details are NOT required to go live.

export function isVendorAutoApprove(): boolean {
  return process.env.VENDOR_AUTO_APPROVE !== "false";
}

type NullableStatus = VendorStatus | null;

const TRANSITIONS: Record<string, VendorStatus[]> = {
  null: [VendorStatus.NEW],
  [VendorStatus.NEW]: [VendorStatus.ACTIVE, VendorStatus.PENDING_REVIEW],
  [VendorStatus.PENDING_REVIEW]: [VendorStatus.ACTIVE, VendorStatus.NEW],
  [VendorStatus.ACTIVE]: [VendorStatus.SUSPENDED],
  [VendorStatus.SUSPENDED]: [VendorStatus.ACTIVE],
};

export function allowedVendorTransitions(from: NullableStatus): VendorStatus[] {
  return TRANSITIONS[String(from)] ?? [];
}

// ─────────────────────────────────────────────────────────────────────────────
// Suspension policy — the ONE definition, enforced on every vendor write path.
//
// Batch 1D.41. Before this, `SUSPENDED` was enforced on some write surfaces
// (products, promos, uploads, settings) but not on two money/fulfilment
// surfaces: rewriting the payout bank account, and driving an order they
// already hold. `authorizeVendor` cannot cover either — it reads only the
// signed `role` claim, never `vendorStatus`, so a vendor suspended by an
// admin keeps passing it until their 15-minute access token expires.
//
// NEW / PENDING_REVIEW deliberately pass: they may prepare menus and payout
// details while onboarding. Orderability is gated separately by
// `vendorStatus === ACTIVE` in vendorAvailability.service.ts. Only
// SUSPENDED — an admin decision to stop this account — is refused here.
// ─────────────────────────────────────────────────────────────────────────────

export const VENDOR_SUSPENDED_MESSAGE =
  "Your vendor account is suspended and cannot make changes right now. Contact support.";

export function isVendorSuspended(status: NullableStatus | undefined): boolean {
  return status === VendorStatus.SUSPENDED;
}

/**
 * Throw if the acting vendor is SUSPENDED. Callers must invoke this BEFORE
 * any write and BEFORE any external call (Paystack, notifications), so a
 * rejected request leaves no partial state and no provider side effect.
 */
export function assertVendorNotSuspended(status: NullableStatus | undefined): void {
  if (isVendorSuspended(status)) throw new ForbiddenError(VENDOR_SUSPENDED_MESSAGE);
}

export const VENDOR_STATUS_UNRESOLVED_MESSAGE =
  "We could not confirm your vendor account status, so this action was not completed. Please try again or contact support.";

/**
 * True when a lifecycle status was actually read from storage.
 *
 * `null` counts as established: the schema models it deliberately as "holds
 * VENDOR, status system has not run yet" (see the lifecycle table above), so
 * every other enforcement site in this codebase treats it as a real value.
 * `undefined` means the row or the field simply was not read, which is
 * different — that is a gap in what we know, not a status.
 *
 * Batch 1D.42: an order transition must not read a missing vendor relation
 * as "not suspended".
 */
export function isVendorStatusEstablishable(status: unknown): boolean {
  return status === null || Object.values(VendorStatus).includes(status as VendorStatus);
}

export function requirementsMet(user: {
  brandName: string | null;
  phoneNumberE164: string | null;
  isPhoneVerified: boolean;
  kycStatus: string;
}): boolean {
  return (
    !!user.brandName &&
    !!user.phoneNumberE164 &&
    user.isPhoneVerified === true &&
    user.kycStatus === "VERIFIED"
  );
}

/**
 * Marks a VENDOR holder NEW when they have no status yet (e.g. right after
 * gaining the VENDOR role). Conditional + idempotent.
 */
export async function ensureVendorStatusNew(userId: string): Promise<void> {
  await prisma.user.updateMany({
    where: { id: userId, vendorStatus: null, roles: { has: Role.VENDOR } },
    data: { vendorStatus: VendorStatus.NEW, vendorStatusChangedAt: new Date() },
  });
}

/**
 * System promotion NEW (or pre-lifecycle null) -> ACTIVE / PENDING_REVIEW
 * once requirements are met. Idempotent and race-safe: the write only
 * succeeds when the row still carries the status we read, so two
 * concurrent evaluations cannot double-transition. Never overrides
 * SUSPENDED or PENDING_REVIEW (those are admin-owned states).
 */
export async function evaluateVendorStatus(userId: string): Promise<NullableStatus> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      roles: true,
      vendorStatus: true,
      kycStatus: true,
      brandName: true,
      phoneNumberE164: true,
      isPhoneVerified: true,
    },
  });
  if (!user || !user.roles.includes(Role.VENDOR)) return user?.vendorStatus ?? null;
  if (user.vendorStatus === VendorStatus.SUSPENDED || user.vendorStatus === VendorStatus.PENDING_REVIEW) {
    return user.vendorStatus;
  }
  if (!requirementsMet(user)) return user.vendorStatus;

  const target = isVendorAutoApprove() ? VendorStatus.ACTIVE : VendorStatus.PENDING_REVIEW;
  const claimed = await prisma.user.updateMany({
    where: { id: userId, vendorStatus: user.vendorStatus },
    data: { vendorStatus: target, vendorStatusChangedAt: new Date() },
  });
  if (claimed.count === 0) {
    const fresh = await prisma.user.findUnique({ where: { id: userId }, select: { vendorStatus: true } });
    return fresh?.vendorStatus ?? target;
  }
  return target;
}

/**
 * Admin-driven transition with the full lifecycle guardrails: validates
 * against the transition table, requires a reason for SUSPENDED and NEW,
 * writes an audit row and notifies the vendor.
 */
export async function changeVendorStatus(
  userId: string,
  to: VendorStatus,
  reason: string | undefined,
  actorAdminId: string,
) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, vendorStatus: true, roles: true },
  });
  if (!user) throw new NotFoundError("User");

  const from: NullableStatus = user.vendorStatus ?? null;
  if (!allowedVendorTransitions(from).includes(to)) {
    throw new ValidationError(
      `Cannot move vendor status from ${from ?? "null"} to ${to}`,
      { from, to, allowed: allowedVendorTransitions(from) },
    );
  }
  if ((to === VendorStatus.SUSPENDED || to === VendorStatus.NEW) && !reason?.trim()) {
    throw new ValidationError("A reason is required for this status change", { to });
  }

  const updated = await prisma.user.update({
    where: { id: userId },
    data: {
      vendorStatus: to,
      vendorStatusReason: reason?.trim() || null,
      vendorStatusChangedAt: new Date(),
    },
  });

  await createAuditLog({
    userId: actorAdminId,
    action: "ADMIN_VENDOR_STATUS_CHANGE",
    metadata: { targetUserId: userId, from, to, reason: reason?.trim() || null },
  });

  await sendNotification({
    userId,
    title: `Vendor account ${to.toLowerCase().replace("_", " ")}`,
    message:
      to === VendorStatus.SUSPENDED
        ? `Your vendor account was suspended${reason ? `: ${reason}` : "."} Your listings are paused but your data is intact.`
        : `Your vendor account status is now ${to.toLowerCase().replace("_", " ")}${reason ? `: ${reason}` : "."}`,
    type: "GENERAL",
    metadata: { from, to },
  });

  return updated;
}
