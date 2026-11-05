/**
 * Phase 1C — real PostgreSQL verification of the vendorStatus compare-and-swap.
 *
 * The operation under test is the REAL `evaluateVendorStatus` conditional write
 * in `src/services/vendorStatus.service.ts`:
 *
 *   updateMany({ where: { id: userId, vendorStatus: user.vendorStatus },
 *                data:  { vendorStatus: target, vendorStatusChangedAt } })
 *
 * plus the REAL `changeVendorStatus` administrative write and the REAL
 * `becomeVendor` onboarding entry point.
 *
 * Policy under test comes from the existing source, not from this test:
 *   TRANSITIONS: null->NEW, NEW->[ACTIVE,PENDING_REVIEW], PENDING_REVIEW->[ACTIVE,NEW],
 *                ACTIVE->[SUSPENDED], SUSPENDED->[ACTIVE]
 *   `evaluateVendorStatus` additionally EARLY-RETURNS for SUSPENDED and
 *   PENDING_REVIEW, so it can never un-suspend or auto-approve on its own.
 *
 * The `vendorStatus` column carries NO database CHECK constraint (verified on
 * the live schema), so the transition invariant is enforced entirely by this
 * application logic — which is exactly what is exercised here.
 */
import prisma from "../../src/lib/prisma";
import type { Role, VendorStatus } from "@prisma/client";
import { VendorStatus as Status } from "@prisma/client";
import {
  evaluateVendorStatus,
  changeVendorStatus,
} from "../../src/services/vendorStatus.service";
import { becomeVendor } from "../../src/controllers/auth.controller";

const UID = "u_vs";
const OTHER = "u_vs_other";
const ADMIN = "u_vs_admin";
/** Distinct E.164 values; the column is @unique. */
const PHONES: Record<string, string> = {
  [UID]: "+23480000001",
  [OTHER]: "+23480000002",
};

/** A vendor whose profile + KYC requirements are all satisfied. */
async function makeVendor(id: string, overrides: Record<string, unknown> = {}) {
  await prisma.user.create({
    data: {
      id,
      name: `Vendor ${id}`,
      email: `${id}@vs.test`,
      password: "x",
      role: "VENDOR" as Role,
      roles: ["VENDOR"] as Role[],
      tokenVersion: 1,
      isEmailVerified: true,
      brandName: `${id} Foods`,
      // phoneNumberE164 is @unique, so each fixture carries its own number.
      phoneNumberE164: PHONES[id] ?? "+23480000001",
      isPhoneVerified: true,
      kycStatus: "VERIFIED",
      ...overrides,
    } as any,
  });
}

async function reset() {
  await prisma.notification.deleteMany({ where: { userId: { in: [UID, OTHER] } } });
  await prisma.auditLog.deleteMany({ where: { userId: { in: [UID, OTHER, ADMIN] } } });
  await prisma.userSession.deleteMany({ where: { userId: { in: [UID, OTHER] } } });
  await prisma.user.deleteMany({ where: { id: { in: [UID, OTHER, ADMIN] } } });

  await makeVendor(UID);
  await makeVendor(OTHER);
  await prisma.user.create({
    data: {
      id: ADMIN,
      name: "Admin",
      email: "admin@vs.test",
      password: "x",
      role: "ADMIN" as Role,
      roles: ["ADMIN"] as Role[],
      tokenVersion: 1,
      isEmailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any,
  });
}

const statusOf = async (id: string) =>
  (await prisma.user.findUnique({ where: { id }, select: { vendorStatus: true } }))?.vendorStatus ?? null;

/** Backends currently blocked on a row/transaction lock held by another. */
async function waitingBackends(): Promise<number> {
  const rows = await prisma.$queryRaw<{ n: bigint }[]>`
    SELECT count(*)::bigint AS n FROM pg_locks
     WHERE NOT granted AND locktype IN ('tuple','transactionid') AND pid <> pg_backend_pid()`;
  return Number(rows[0].n);
}
async function waitForWaiters(min: number, tries = 200): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    if ((await waitingBackends()) >= min) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

function req(id: string, body: Record<string, unknown> = { brandName: "Race Foods" }) {
  return { user: { id, role: "CUSTOMER", sessionId: "sess-vs" }, body } as any;
}
function res() {
  const r: any = { status: jest.fn(), json: jest.fn() };
  r.status.mockReturnValue(r);
  r.json.mockReturnValue(r);
  return r;
}
const statusCode = (r: any) => r.status.mock.calls[0]?.[0];

beforeEach(async () => {
  await reset();
});

// ── 1. Valid onboarding request performs the intended transition ────────────

it("1a. becomeVendor admits a customer into the lifecycle as NEW (real path)", async () => {
  // Strip the profile/KYC requirements so `requirementsMet` is false: the
  // account still holds a brandName, but has no verified phone and no KYC.
  await prisma.user.update({
    where: { id: UID },
    data: {
      roles: ["CUSTOMER"] as Role[],
      role: "CUSTOMER" as Role,
      phoneNumberE164: null,
      isPhoneVerified: false,
      kycStatus: "PENDING",
    },
  });
  const r = res();
  await becomeVendor(req(UID), r);

  expect(statusCode(r)).toBe(200);
  // Unmet requirements => evaluateVendorStatus early-returns before the CAS,
  // so onboarding stops at NEW.
  expect(await statusOf(UID)).toBe(Status.NEW);
});

it("1b. a requirements-satisfied NEW vendor is promoted to ACTIVE", async () => {
  await prisma.user.update({ where: { id: UID }, data: { vendorStatus: Status.NEW } });

  const result = await evaluateVendorStatus(UID);

  expect(result).toBe(Status.ACTIVE);
  expect(await statusOf(UID)).toBe(Status.ACTIVE);
});

// ── 2. Ineligible current status is rejected without mutation ────────────────

it("2a. a SUSPENDED vendor is never auto-reactivated by evaluation", async () => {
  await prisma.user.update({ where: { id: UID }, data: { vendorStatus: Status.SUSPENDED } });

  const result = await evaluateVendorStatus(UID);

  expect(result).toBe(Status.SUSPENDED);
  expect(await statusOf(UID)).toBe(Status.SUSPENDED);
});

it("2b. PENDING_REVIEW is never auto-approved by evaluation", async () => {
  await prisma.user.update({ where: { id: UID }, data: { vendorStatus: Status.PENDING_REVIEW } });

  const result = await evaluateVendorStatus(UID);

  expect(result).toBe(Status.PENDING_REVIEW);
  expect(await statusOf(UID)).toBe(Status.PENDING_REVIEW);
});

it("2c. an account without the VENDOR role is left alone", async () => {
  await prisma.user.update({
    where: { id: UID },
    data: { role: "CUSTOMER" as Role, roles: ["CUSTOMER"] as Role[], vendorStatus: Status.ACTIVE },
  });

  const result = await evaluateVendorStatus(UID);

  expect(result).toBe(Status.ACTIVE); // returned as-is, no CAS attempted
  expect(await statusOf(UID)).toBe(Status.ACTIVE);
});

it("2d. the administrative write rejects a transition the table forbids", async () => {
  await prisma.user.update({ where: { id: UID }, data: { vendorStatus: Status.SUSPENDED } });

  // SUSPENDED -> NEW is not in TRANSITIONS.
  await expect(
    changeVendorStatus(UID, Status.NEW, "attempt", ADMIN),
  ).rejects.toThrow(/Cannot move vendor status/);
  expect(await statusOf(UID)).toBe(Status.SUSPENDED);
});

// ── 3/9/10. Two concurrent evaluations of the same transition ───────────────

it("3. two concurrent evaluations converge on one valid state", async () => {
  await prisma.user.update({ where: { id: UID }, data: { vendorStatus: Status.NEW } });

  // Both read NEW and both attempt NEW->ACTIVE. The CAS lets one win; the
  // loser sees count 0 and re-reads. The result must be a single valid status.
  const [a, b] = await Promise.all([evaluateVendorStatus(UID), evaluateVendorStatus(UID)]);

  expect([a, b].sort()).toEqual([Status.ACTIVE, Status.ACTIVE]);
  expect(await statusOf(UID)).toBe(Status.ACTIVE);
});

// ── 4/5/6/8/10. Onboarding raced against an administrative suspension ─────────

it("4. a suspension that commits mid-flight wins; the stale CAS does not overwrite it", async () => {
  await prisma.user.update({ where: { id: UID }, data: { vendorStatus: Status.NEW } });

  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let lockReadyResolver!: () => void;
  const lockReady = new Promise<void>((resolve) => {
    lockReadyResolver = resolve;
  });

  // Hold the User row lock with an explicit FOR UPDATE, uncommitted — the
  // same lock `changeVendorStatus` will take when it writes. Acquire it
  // BEFORE calling `evaluateVendorStatus` so that call is guaranteed to
  // block on this lock, giving deterministic concurrency.
  const suspender = prisma.$transaction(async (tx) => {
    await tx.$queryRawUnsafe(`SELECT id FROM "User" WHERE id = '${UID}' FOR UPDATE`);
    lockReadyResolver(); // Signal that the FOR UPDATE lock is held
    await gate;
    await tx.user.update({
      where: { id: UID },
      data: {
        vendorStatus: Status.SUSPENDED,
        vendorStatusReason: "racing",
        vendorStatusChangedAt: new Date(),
      },
    });
  });

  // Wait for suspender to acquire the row lock before starting
  // evaluateVendorStatus, so its conditional updateMany is guaranteed to
  // block on this lock.
  await lockReady;

  // Run evaluateVendorStatus while suspender holds the row lock. Its
  // conditional `updateMany({ vendorStatus: NEW })` blocks on suspender's
  // lock until suspender commits SUSPENDED.
  const evaluation = evaluateVendorStatus(UID);

  const blocked = await waitForWaiters(1);
  expect(blocked).toBe(true); // genuine contention

  release(); // suspender commits SUSPENDED, releases the lock
  const result = await evaluation;

  // The stale CAS could not overwrite SUSPENDED: predicate NEW no longer
  // matches, so evaluateVendorStatus re-reads and returns SUSPENDED.
  expect(result).toBe(Status.SUSPENDED);
  const final = await statusOf(UID);
  expect(final).toBe(Status.SUSPENDED);
  expect(final).not.toBe(Status.ACTIVE);
}, 60_000);

it("5. the inverse ordering: evaluation commits first, the suspension still applies", async () => {
  await prisma.user.update({ where: { id: UID }, data: { vendorStatus: Status.NEW } });

  const result = await evaluateVendorStatus(UID);
  expect(result).toBe(Status.ACTIVE);
  expect(await statusOf(UID)).toBe(Status.ACTIVE);

  // Real administrative path, serialised after the CAS.
  await changeVendorStatus(UID, Status.SUSPENDED, "post-approval suspension", ADMIN);

  expect(await statusOf(UID)).toBe(Status.SUSPENDED);
});

// ── 7. Cross-account isolation ──────────────────────────────────────────────

it("7. evaluating one vendor never changes another", async () => {
  await prisma.user.update({ where: { id: UID }, data: { vendorStatus: Status.NEW } });
  await prisma.user.update({ where: { id: OTHER }, data: { vendorStatus: Status.NEW } });

  await evaluateVendorStatus(UID);

  expect(await statusOf(UID)).toBe(Status.ACTIVE);
  expect(await statusOf(OTHER)).toBe(Status.NEW);
});

afterAll(async () => {
  await prisma.notification.deleteMany({ where: { userId: { in: [UID, OTHER] } } });
  await prisma.auditLog.deleteMany({ where: { userId: { in: [UID, OTHER, ADMIN] } } });
  await prisma.user.deleteMany({ where: { id: { in: [UID, OTHER, ADMIN] } } });
});