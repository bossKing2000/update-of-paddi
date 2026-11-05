/**
 * Phase 1B — real PostgreSQL verification of `becomeVendor`'s conditional
 * role-assignment write.
 *
 * The policy under test is the existing one in
 * `src/controllers/auth.controller.ts::becomeVendor`:
 *   - an account holding ADMIN or DELIVERY must not gain VENDOR;
 *   - an account already holding VENDOR must not receive a duplicate;
 *   - an eligible CUSTOMER gains VENDOR by APPENDING (push), preserving the
 *     rest of the array;
 *   - the write is a single conditional `updateMany`, so the whole question is
 *     whether PostgreSQL re-evaluates its WHERE clause against the latest row
 *     when a competing writer commits in between.
 *
 * NOTE: the `roles` column carries NO database CHECK constraint (verified on
 * the live schema), so this invariant is enforced entirely by that predicate.
 *
 * The real controller is executed; nothing here re-implements the operation.
 */
import prisma from "../../src/lib/prisma";
import type { Role } from "@prisma/client";
import { becomeVendor } from "../../src/controllers/auth.controller";

const UID = "u_bv";
const BYSTANDER = "u_bv_bystander";

function req(id: string, body: Record<string, unknown> = { brandName: "Race Foods" }) {
  return { user: { id, role: "CUSTOMER", sessionId: "sess-bv" }, body } as any;
}
function res() {
  const r: any = { status: jest.fn(), json: jest.fn() };
  r.status.mockReturnValue(r);
  r.json.mockReturnValue(r);
  return r;
}
const statusOf = (r: any) => r.status.mock.calls[0]?.[0];
const bodyOf = (r: any) => r.json.mock.calls[0]?.[0];

async function makeUser(id: string, roles: Role[], extra: Record<string, unknown> = {}) {
  await prisma.user.create({
    data: {
      id,
      name: `User ${id}`,
      email: `${id}@bv.test`,
      password: "x",
      role: roles[0] ?? null,
      roles,
      tokenVersion: 1,
      isEmailVerified: true,
      ...extra,
    } as any,
  });
}

async function reset() {
  await prisma.deliveryPerson.deleteMany({ where: { userId: { in: [UID, BYSTANDER] } } });
  await prisma.userSession.deleteMany({ where: { userId: { in: [UID, BYSTANDER] } } });
  await prisma.user.deleteMany({ where: { id: { in: [UID, BYSTANDER] } } });
  await makeUser(UID, ["CUSTOMER"]);
  await makeUser(BYSTANDER, ["CUSTOMER"]);
}

const rolesOf = async (id: string) =>
  (await prisma.user.findUnique({ where: { id }, select: { roles: true } }))?.roles ?? [];

const countVendor = (roles: Role[]) => roles.filter((r) => r === "VENDOR").length;

/** Backends currently blocked on a row/transaction lock held by another. */
async function waitingBackends(): Promise<number> {
  const rows = await prisma.$queryRaw<{ n: bigint }[]>`
    SELECT count(*)::bigint AS n FROM pg_locks
     WHERE NOT granted
       AND locktype IN ('tuple', 'transactionid')
       AND pid <> pg_backend_pid()`;
  return Number(rows[0].n);
}
async function waitForWaiters(min: number, tries = 200): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    if ((await waitingBackends()) >= min) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

/**
 * Polls until a contending transaction reports that it has ACQUIRED its row
 * lock.
 *
 * Why this exists: `waitForWaiters()` only proves that SOME backend is blocked
 * on SOME lock. That is not enough to prove `becomeVendor` is the blocked
 * party — if the contender had not taken its lock yet, the contender itself
 * would be the waiter and the race would run the other way round, so the test
 * would measure a different ordering than the one it names. An UPDATE returns
 * only after its row lock is granted, and an open transaction holds that lock
 * until it commits, so a flag raised immediately after the UPDATE is an exact
 * readiness signal. Ordering then becomes deterministic on a cold database as
 * well as a warm one, without adding sleeps or relaxing an assertion.
 */
async function waitForLockHeld(isHeld: () => boolean, tries = 200): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    if (isHeld()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return isHeld();
}

beforeEach(async () => {
  await reset();
});

// ── Scenarios 1–5: the policy itself, against real PostgreSQL ────────────────

it("1. an account already holding VENDOR gets no duplicate", async () => {
  await prisma.user.update({
    where: { id: UID },
    data: { roles: ["CUSTOMER", "VENDOR"] as Role[] },
  });
  const r = res();
  await becomeVendor(req(UID), r);

  expect(statusOf(r)).toBe(400);
  expect(await rolesOf(UID)).toEqual(["CUSTOMER", "VENDOR"]);
  expect(countVendor(await rolesOf(UID))).toBe(1);
});

it("2a. an ADMIN account does not acquire VENDOR", async () => {
  await prisma.user.update({ where: { id: UID }, data: { roles: ["ADMIN"] as Role[] } });
  const r = res();
  await becomeVendor(req(UID), r);

  expect(statusOf(r)).toBe(403);
  expect(await rolesOf(UID)).toEqual(["ADMIN"]);
});

it("2b. a DELIVERY account does not acquire VENDOR", async () => {
  await prisma.user.update({ where: { id: UID }, data: { roles: ["DELIVERY"] as Role[] } });
  const r = res();
  await becomeVendor(req(UID), r);

  expect(statusOf(r)).toBe(403);
  expect(await rolesOf(UID)).toEqual(["DELIVERY"]);
});

it("3. an eligible CUSTOMER acquires VENDOR", async () => {
  const r = res();
  await becomeVendor(req(UID), r);

  expect(statusOf(r)).toBe(200);
  expect(bodyOf(r).roles).toEqual(["CUSTOMER", "VENDOR"]);
  expect(await rolesOf(UID)).toEqual(["CUSTOMER", "VENDOR"]);
});

it("4. the operation never touches another account", async () => {
  await prisma.user.update({ where: { id: UID }, data: { roles: ["CUSTOMER", "VENDOR"] as Role[] } });
  await becomeVendor(req(UID), res());

  expect(await rolesOf(BYSTANDER)).toEqual(["CUSTOMER"]);
});

it("5. existing array contents are preserved (append, not replace)", async () => {
  const r = res();
  await becomeVendor(req(UID, { brandName: "Kept Foods" }), r);

  expect(statusOf(r)).toBe(200);
  const roles = await rolesOf(UID);
  expect(roles).toContain("CUSTOMER");
  expect(roles).toContain("VENDOR");
  // brandName was written, and the pre-existing CUSTOMER entry survived.
  const row = await prisma.user.findUnique({
    where: { id: UID },
    select: { brandName: true },
  });
  expect(row?.brandName).toBe("Kept Foods");
});

// ── Scenario 6/7: race against setUserRole, both orderings ──────────────────

it("6. revocation that commits first: the conditional write refuses it", async () => {
  // Deterministic contention: a transaction performs the admin role change and
  // HOLDS the row lock uncommitted. becomeVendor's UPDATE must block on that
  // row, and when it finally runs it must re-evaluate its predicate against
  // the post-revocation row.
  let lockHeld = false;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));

  const revoker = prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: UID },
      data: { role: "ADMIN" as Role, roles: ["ADMIN"] as Role[] },
    });
    lockHeld = true;
    await gate; // keep the row lock held
  });

  const r = res();

  // Rendezvous on the lock actually being GRANTED, so becomeVendor is
  // provably the blocked party rather than the revoker queueing behind it.
  expect(await waitForLockHeld(() => lockHeld)).toBe(true);

  const attempt = becomeVendor(req(UID), r);

  const blocked = await waitForWaiters(1);
  expect(blocked).toBe(true); // genuine contention, not a launch-and-hope race

  release();
  await revoker;
  await attempt;

  // The predicate re-evaluated the LATEST row and refused to append VENDOR.
  expect(statusOf(r)).toBe(403);
  expect(await rolesOf(UID)).toEqual(["ADMIN"]);
  expect(await rolesOf(UID)).not.toContain("VENDOR");
}, 60_000);

it("7. becomeVendor that commits first: the later revocation still wins cleanly", async () => {
  // The inverse ordering. setUserRole performs a FULL array set, so even when
  // becomeVendor commits first the durable result is a single valid role.
  const r = res();
  await becomeVendor(req(UID), r);
  expect(statusOf(r)).toBe(200);
  expect(await rolesOf(UID)).toEqual(["CUSTOMER", "VENDOR"]);

  await prisma.user.update({
    where: { id: UID },
    data: { role: "ADMIN" as Role, roles: ["ADMIN"] as Role[] },
  });

  const after = await rolesOf(UID);
  expect(after).toEqual(["ADMIN"]);
  expect(countVendor(after)).toBe(0);
});

// ── Scenario 8: two concurrent becomeVendor for one account ─────────────────

it("8. two concurrent becomeVendor requests produce exactly one VENDOR", async () => {
  // Same deterministic rendezvous: an external transaction holds the row so
  // BOTH requests are provably queued behind it, then released together.
  let lockHeld = false;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));

  const holder = prisma.$transaction(async (tx) => {
    // A no-op write, used purely to take the row lock.
    await tx.user.update({ where: { id: UID }, data: { brandName: "Race Foods" } });
    lockHeld = true;
    await gate;
  });

  const r1 = res();
  const r2 = res();

  // Same rendezvous as scenario 6: both requests below are queued behind a
  // lock that is provably already held, never behind a contender that has not
  // taken its lock yet.
  expect(await waitForLockHeld(() => lockHeld)).toBe(true);

  const a1 = becomeVendor(req(UID), r1);
  const a2 = becomeVendor(req(UID), r2);

  const bothQueued = await waitForWaiters(2);
  expect(bothQueued).toBe(true); // both genuinely contended on the row

  release();
  await holder;
  await Promise.all([a1, a2]);

  const roles = await rolesOf(UID);
  expect(countVendor(roles)).toBe(1); // no duplicate pushed
  // Exactly one request won; the other was refused by the predicate.
  const statuses = [statusOf(r1), statusOf(r2)].sort();
  expect(statuses).toEqual([200, 409]);
}, 60_000);

afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: { in: [UID, BYSTANDER] } } });
});