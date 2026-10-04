import { Role, VendorStatus } from "@prisma/client";
import prisma from "../lib/prisma";
import { createAuditLog } from "../utils/auditLog.service";
import { sendNotification } from "../utils/activityUtils/notify";
import { NotFoundError, ValidationError } from "../errors/AppError";

// Phase 1C vendor onboarding lifecycle.
//
// - null        : not a vendor (or vendor role gained before this system)
// - NEW         : holds VENDOR, requirements not yet met
// - ACTIVE      : requirements met; may go live (isLive stays the switch)
// - PENDING_REVIEW: requirements met, manual approval needed
//                 (only when VENDOR_AUTO_APPROVE=false, default true)
// - SUSPENDED   : admin-set, cannot sell
//
// Requirements for ACTIVE: brandName + phoneNumber + kycStatus VERIFIED.
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

export function requirementsMet(user: {
  brandName: string | null;
  phoneNumber: string | null;
  kycStatus: string;
}): boolean {
  return !!user.brandName && !!user.phoneNumber && user.kycStatus === "VERIFIED";
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
    select: { roles: true, vendorStatus: true, kycStatus: true, brandName: true, phoneNumber: true },
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
