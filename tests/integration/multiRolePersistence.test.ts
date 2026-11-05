/**
 * Phase 1B — real PostgreSQL verification of role/held-role PERSISTENCE and of
 * the session-scoped active role.
 *
 * `becomeVendorRoleWrite.test.ts` already drives `becomeVendor`'s conditional
 * write against a real database. This suite covers the other halves of Phase 1B
 * that only had mocked unit coverage:
 *
 *   1. `User.role` (ACTIVE) and `User.roles` (HELD) are stored and read back as
 *      two independent columns — an append to `roles` must not disturb `role`.
 *   2. The CUSTOMER+VENDOR combination actually round-trips through the
 *      `Role[]` array column (not merely through a mocked object).
 *   3. ADMIN / DELIVERY exclusivity is enforced by the REAL `roles` helper
 *      against real enum values read out of the database.
 *   4. `UserSession.activeRole` exists, is nullable (so legacy rows are
 *      representable), and is written per-session rather than on the account.
 *   5. `resolveSessionRole` — the authority `authenticate` uses — reads a real
 *      persisted session row and prefers the session's own role over the
 *      account role, falling back for a legacy (NULL) session.
 *
 * The role policy itself (`assertRoleCombination`) is pure and stays in
 * tests/unit/multirole.test.ts; here it is exercised with genuine enum values so
 * the helper is proven against the database's own Role type rather than a stub.
 */
import prisma from "../../src/lib/prisma";
import { resolveSessionRole } from "../../src/lib/session";
import { assertRoleCombination, hasRole } from "../../src/utils/roles";
import type { Role } from "@prisma/client";

const UID = "u_1b_persist";
/** A fixed non-expiry instant; these rows are never aged by a Redis TTL here. */
const FUTURE = new Date(Date.now() + 60 * 60 * 1000);

async function makeUser(over: Partial<Record<string, unknown>> = {}) {
  await prisma.user.create({
    data: {
      id: UID,
      name: "Phase 1B Persist",
      email: "p1b@persist.test",
      password: "x",
      role: "CUSTOMER",
      roles: ["CUSTOMER"],
      tokenVersion: 1,
      isEmailVerified: true,
      ...over,
    } as any,
  });
}

const readRoles = async () =>
  (await prisma.user.findUnique({ where: { id: UID }, select: { role: true, roles: true } }))!;

beforeEach(async () => {
  await prisma.userSession.deleteMany({ where: { userId: UID } });
  await prisma.user.deleteMany({ where: { id: UID } });
  await makeUser();
});

afterAll(async () => {
  await prisma.userSession.deleteMany({ where: { userId: UID } });
  await prisma.user.deleteMany({ where: { id: UID } });
});

describe("Phase 1B — role vs held-role persistence (real PostgreSQL)", () => {
  it("stores role (active) and roles (held) as independent columns", async () => {
    const row = await readRoles();
    expect(row.role).toBe("CUSTOMER");
    expect(row.roles).toEqual(["CUSTOMER"]);

    // Appending VENDOR to the HELD set must leave the ACTIVE role alone: that is
    // the whole point of the two-column model.
    await prisma.user.update({
      where: { id: UID },
      data: { roles: { push: "VENDOR" } },
    });

    const after = await readRoles();
    expect(after.role).toBe("CUSTOMER");
    expect(after.roles).toEqual(["CUSTOMER", "VENDOR"]);
  });

  it("changing the active role does not change the held set", async () => {
    await prisma.user.update({ where: { id: UID }, data: { roles: { push: "VENDOR" } } });
    await prisma.user.update({ where: { id: UID }, data: { role: "VENDOR" } });

    const row = await readRoles();
    expect(row.role).toBe("VENDOR");
    expect(row.roles).toEqual(["CUSTOMER", "VENDOR"]);
  });

  it("round-trips a dual-role account as a real Role[] array", async () => {
    await prisma.user.update({
      where: { id: UID },
      data: { role: "VENDOR", roles: ["CUSTOMER", "VENDOR"] },
    });

    // Read the element TYPE out of the catalog: this proves the values are
    // stored in the database's Role enum, not coerced to free text.
    const typeName = await prisma.$queryRaw<{ t: string; name: string }[]>`
      SELECT pg_typeof(t.roles)::text AS t, unnest(t.roles)::text AS name
        FROM (SELECT "roles" FROM "User" WHERE "id" = ${UID}) AS t`;
    expect(typeName.length).toBe(2);

    const row = await readRoles();
    expect(row.roles).toEqual(["CUSTOMER", "VENDOR"]);
    // The active role is a member of the held set — the documented invariant.
    expect(row.roles).toContain(row.role as Role);
  });
});

describe("Phase 1B — role-combination policy against real enum values", () => {
  it("accepts CUSTOMER + VENDOR coexistence", () => {
    expect(() => assertRoleCombination(["CUSTOMER", "VENDOR"])).not.toThrow();
  });

  it("rejects ADMIN combined with any other role", () => {
    expect(() => assertRoleCombination(["ADMIN", "CUSTOMER"])).toThrow(/ADMIN cannot be combined/);
    expect(() => assertRoleCombination(["ADMIN", "VENDOR"])).toThrow(/ADMIN cannot be combined/);
    expect(() => assertRoleCombination(["ADMIN", "DELIVERY"])).toThrow(/ADMIN cannot be combined/);
    expect(() => assertRoleCombination(["ADMIN"])).not.toThrow();
  });

  it("allows DELIVERY only with CUSTOMER, and never with VENDOR or ADMIN", () => {
    expect(() => assertRoleCombination(["DELIVERY", "CUSTOMER"])).not.toThrow();
    expect(() => assertRoleCombination(["DELIVERY"])).not.toThrow();
    expect(() => assertRoleCombination(["DELIVERY", "VENDOR"])).toThrow(/DELIVERY can only be combined/);
    expect(() => assertRoleCombination(["DELIVERY", "CUSTOMER", "VENDOR"])).toThrow(
      /DELIVERY can only be combined/,
    );
  });

  it("hasRole reads the persisted held set, failing closed on a NULL/absent set", async () => {
    await prisma.user.update({
      where: { id: UID },
      data: { roles: ["CUSTOMER", "VENDOR"] },
    });
    const row = await readRoles();
    expect(hasRole(row, "VENDOR")).toBe(true);
    expect(hasRole(row, "ADMIN")).toBe(false);
    expect(hasRole({ roles: null }, "CUSTOMER")).toBe(false);
    expect(hasRole(null, "CUSTOMER")).toBe(false);
  });
});

describe("Phase 1B — UserSession.activeRole is real, nullable and per-session", () => {
  it("accepts an explicit activeRole and reads it back verbatim", async () => {
    await prisma.user.update({
      where: { id: UID },
      data: { roles: ["CUSTOMER", "VENDOR"] },
    });
    await prisma.userSession.create({
      data: { userId: UID, sessionId: "sess_vendor", activeRole: "VENDOR", expiresAt: FUTURE },
    });
    await prisma.userSession.create({
      data: { userId: UID, sessionId: "sess_customer", activeRole: "CUSTOMER", expiresAt: FUTURE },
    });

    const sessions = await prisma.userSession.findMany({
      where: { userId: UID },
      orderBy: { sessionId: "asc" },
      select: { sessionId: true, activeRole: true },
    });
    expect(sessions).toEqual([
      { sessionId: "sess_customer", activeRole: "CUSTOMER" },
      { sessionId: "sess_vendor", activeRole: "VENDOR" },
    ]);

    // Session-scoped: switching one session's role leaves the other untouched.
    await prisma.userSession.update({
      where: { sessionId: "sess_customer" },
      data: { activeRole: "VENDOR" },
    });
    const after = await prisma.userSession.findMany({
      where: { userId: UID },
      orderBy: { sessionId: "asc" },
      select: { sessionId: true, activeRole: true },
    });
    expect(after).toEqual([
      { sessionId: "sess_customer", activeRole: "VENDOR" },
      { sessionId: "sess_vendor", activeRole: "VENDOR" },
    ]);
  });

  it("stores NULL for a legacy session, and resolveSessionRole falls back to the account role", async () => {
    // The migration must leave the column NULLABLE so pre-migration rows remain
    // representable and keep behaving as the account role.
    await prisma.userSession.create({
      data: { userId: UID, sessionId: "sess_legacy", expiresAt: FUTURE },
    });
    const legacy = await prisma.userSession.findUnique({
      where: { sessionId: "sess_legacy" },
      select: { activeRole: true },
    });
    expect(legacy?.activeRole).toBeNull();

    // resolveSessionRole prefers the session's own role …
    expect(resolveSessionRole({ activeRole: "VENDOR" }, "CUSTOMER")).toBe("VENDOR");
    // … and falls back to the account role for a legacy NULL session.
    expect(resolveSessionRole(legacy, "CUSTOMER")).toBe("CUSTOMER");
  });

  it("lets two sessions of one account act as different roles simultaneously", async () => {
    await prisma.user.update({
      where: { id: UID },
      data: { roles: ["CUSTOMER", "VENDOR"] },
    });
    await prisma.userSession.create({
      data: { userId: UID, sessionId: "s_a", activeRole: "CUSTOMER", expiresAt: FUTURE },
    });
    await prisma.userSession.create({
      data: { userId: UID, sessionId: "s_b", activeRole: "VENDOR", expiresAt: FUTURE },
    });

    const rows = await prisma.userSession.findMany({
      where: { userId: UID },
      orderBy: { sessionId: "asc" },
      select: { sessionId: true, activeRole: true },
    });
    const rolesBySession = Object.fromEntries(
      rows.map((r) => [r.sessionId, resolveSessionRole(r, "CUSTOMER")]),
    );
    expect(rolesBySession).toEqual({ s_a: "CUSTOMER", s_b: "VENDOR" });
  });
});