/**
 * Phase 1B — session-scoped active role against REAL PostgreSQL AND REAL Redis.
 *
 * `setSessionActiveRole` (src/lib/session.ts) is the dual-layer write behind
 * POST /api/auth/switch-role: it updates the `UserSession.activeRole` column
 * and refreshes the read-through Redis session cache. `getUserSession` then
 * reads CACHE FIRST, so the two layers are only equivalent if both are actually
 * written — a defect in either would be invisible to a purely mocked test.
 *
 * Covered here, against a disposable PostgreSQL and a disposable Redis:
 *   1. a role switch persists to the `UserSession` row (the authoritative copy);
 *   2. it is visible through the real `getUserSession` cache read path;
 *   3. it is scoped to ONE session — a sibling session of the same account is
 *      unaffected, and the account's own `role` column never moves;
 *   4. `resolveSessionRole` over the real cached payload prefers the switched
 *      role, which is exactly what `authenticate` consumes;
 *   5. switching back to null clears the role on the row.
 *
 * These suites register no mock for src/lib/session, so the production Redis
 * client is used. Under jest.integration.config.js there is no Redis pin, so
 * REDIS_URL must point at the disposable instance for the run.
 */
import prisma from "../../src/lib/prisma";
import {
  getUserSession,
  setSessionActiveRole,
  deleteUserSession,
  resolveSessionRole,
} from "../../src/lib/session";

const UID = "u_1b_session";
const FUTURE = new Date(Date.now() + 60 * 60 * 1000);

async function seedDualRoleAccount() {
  await prisma.user.deleteMany({ where: { id: UID } });
  await prisma.user.create({
    data: {
      id: UID,
      name: "Phase 1B Session",
      email: "p1b-session@persist.test",
      password: "x",
      role: "CUSTOMER",
      roles: ["CUSTOMER", "VENDOR"],
      tokenVersion: 1,
      isEmailVerified: true,
    } as any,
  });
  for (const sessionId of ["s_one", "s_two"]) {
    await prisma.userSession.create({
      data: {
        userId: UID,
        sessionId,
        activeRole: "CUSTOMER",
        expiresAt: FUTURE,
      },
    });
  }
}

const activeRoleInDb = async (sessionId: string) =>
  (
    await prisma.userSession.findUnique({
      where: { sessionId },
      select: { activeRole: true },
    })
  )?.activeRole ?? null;

beforeEach(async () => {
  // Start from a clean cache so each test observes its own writes.
  await deleteUserSession(UID, "s_one").catch(() => undefined);
  await deleteUserSession(UID, "s_two").catch(() => undefined);
  await prisma.userSession.deleteMany({ where: { userId: UID } });
  await prisma.user.deleteMany({ where: { id: UID } });
  await seedDualRoleAccount();
});

afterAll(async () => {
  await deleteUserSession(UID, "s_one").catch(() => undefined);
  await deleteUserSession(UID, "s_two").catch(() => undefined);
  await prisma.userSession.deleteMany({ where: { userId: UID } });
  await prisma.user.deleteMany({ where: { id: UID } });
});

describe("Phase 1B — setSessionActiveRole against real PostgreSQL + Redis", () => {
  it("persists the switch to the UserSession row", async () => {
    await setSessionActiveRole(UID, "s_one", "VENDOR");
    expect(await activeRoleInDb("s_one")).toBe("VENDOR");
  });

  it("is visible through the real getUserSession cache read path", async () => {
    // First read populates the cache from the database.
    const before = await getUserSession(UID, "s_one");
    expect(resolveSessionRole(before, "CUSTOMER")).toBe("CUSTOMER");

    await setSessionActiveRole(UID, "s_one", "VENDOR");

    // getUserSession is read-through and cache-first, so this assertion is only
    // satisfiable if the Redis layer was refreshed alongside the row.
    const after = await getUserSession(UID, "s_one");
    expect(after?.activeRole).toBe("VENDOR");
    expect(resolveSessionRole(after, "CUSTOMER")).toBe("VENDOR");
  });

  it("scopes the switch to one session and leaves the account role alone", async () => {
    await setSessionActiveRole(UID, "s_one", "VENDOR");

    expect(await activeRoleInDb("s_one")).toBe("VENDOR");
    // Sibling session of the SAME account is untouched.
    expect(await activeRoleInDb("s_two")).toBe("CUSTOMER");

    const sibling = await getUserSession(UID, "s_two");
    expect(resolveSessionRole(sibling, "CUSTOMER")).toBe("CUSTOMER");

    // The account-wide default role never moves — that is the Phase 1E fix.
    const account = await prisma.user.findUnique({
      where: { id: UID },
      select: { role: true },
    });
    expect(account?.role).toBe("CUSTOMER");
  });

  it("lets two sessions of one account act as different roles at once", async () => {
    await setSessionActiveRole(UID, "s_one", "VENDOR");

    const roles = {
      s_one: resolveSessionRole(await getUserSession(UID, "s_one"), "CUSTOMER"),
      s_two: resolveSessionRole(await getUserSession(UID, "s_two"), "CUSTOMER"),
    };
    expect(roles).toEqual({ s_one: "VENDOR", s_two: "CUSTOMER" });
  });

  it("clears the role on the row when switched back to null", async () => {
    await setSessionActiveRole(UID, "s_one", "VENDOR");
    expect(await activeRoleInDb("s_one")).toBe("VENDOR");

    await setSessionActiveRole(UID, "s_one", null);
    expect(await activeRoleInDb("s_one")).toBeNull();

    // A null session role resolves against the account role again.
    const session = await getUserSession(UID, "s_one");
    expect(resolveSessionRole(session, "CUSTOMER")).toBe("CUSTOMER");
  });
});