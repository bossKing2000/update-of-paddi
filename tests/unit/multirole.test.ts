/**
 * Phase 1B multi-role — core unit tests.
 *
 * Covers:
 * - roles helper (hasRole / assertRoleCombination)
 * - onboarding derived from HELD roles (not just active role)
 * - migration backfill SQL + schema field presence
 * - register / selectRole write roles=[role]
 */
import fs from "fs";
import path from "path";

import { Role } from "@prisma/client";
import { hasRole, assertRoleCombination } from "../../src/utils/roles";
import {
  resolveOnboardingState,
  OnboardingUser,
} from "../../src/controllers/auth.controller";

jest.mock("../../src/lib/prisma", () => {
  // `register` and `selectRole` wrap the account write and the rider-profile
  // write in one prisma.$transaction so the pair cannot half-apply. The mock
  // hands the callback the SAME object, so assertions on db.user.create etc.
  // still observe writes made through the transaction client.
  const client: any = {
    user: { findUnique: jest.fn(), create: jest.fn(), update: jest.fn(), updateMany: jest.fn(async () => ({ count: 0 })) },
    deliveryPerson: { create: jest.fn(), upsert: jest.fn() },
  };
  client.$transaction = jest.fn(async (fn: (tx: any) => unknown) => fn(client));
  return { __esModule: true, default: client };
});

jest.mock("../../src/lib/session", () => ({
  __esModule: true,
  createUserSession: jest.fn(async () => {}),
  setRefreshJti: jest.fn(async () => {}),
  getRefreshJti: jest.fn(async () => null),
  rotateRefreshJti: jest.fn(async () => {}),
  isRefreshJtiReplay: jest.fn(async () => false),
  deleteRefreshJti: jest.fn(async () => {}),
  deleteUserSession: jest.fn(async () => {}),
  deleteAllUserSessions: jest.fn(async () => {}),
  listUserSessions: jest.fn(async () => []),
  getUserSession: jest.fn(async () => null),
}));

import prisma from "../../src/lib/prisma";
import { register, selectRole } from "../../src/controllers/auth.controller";

const db = prisma as unknown as Record<string, Record<string, jest.Mock>>;

const res = (): any => {
  const r: any = {};
  r.status = jest.fn().mockReturnValue(r);
  r.json = jest.fn().mockReturnValue(r);
  r.cookie = jest.fn().mockReturnValue(r);
  r.clearCookie = jest.fn().mockReturnValue(r);
  return r;
};

const PASSWORD = "Strong1!pass";

describe("roles helper", () => {
  it("hasRole is true only for held roles", () => {
    expect(hasRole({ roles: [Role.CUSTOMER, Role.VENDOR] }, Role.VENDOR)).toBe(true);
    expect(hasRole({ roles: [Role.CUSTOMER, Role.VENDOR] }, Role.ADMIN)).toBe(false);
    expect(hasRole({ roles: [] }, Role.CUSTOMER)).toBe(false);
    expect(hasRole(null, Role.CUSTOMER)).toBe(false);
    expect(hasRole(undefined, Role.CUSTOMER)).toBe(false);
  });

  it("assertRoleCombination allows solo roles, CUSTOMER+VENDOR, and CUSTOMER+DELIVERY", () => {
    expect(() => assertRoleCombination([Role.ADMIN])).not.toThrow();
    expect(() => assertRoleCombination([Role.VENDOR])).not.toThrow();
    expect(() => assertRoleCombination([Role.CUSTOMER])).not.toThrow();
    expect(() => assertRoleCombination([Role.DELIVERY])).not.toThrow();
    expect(() => assertRoleCombination([])).not.toThrow();
    // Pre-existing Phase 1B case.
    expect(() => assertRoleCombination([Role.CUSTOMER, Role.VENDOR])).not.toThrow();
    // The approved rider case: a customer may also be a delivery rider.
    expect(() => assertRoleCombination([Role.CUSTOMER, Role.DELIVERY])).not.toThrow();
    // The rule reads the Set, so argument order cannot change the outcome.
    expect(() => assertRoleCombination([Role.DELIVERY, Role.CUSTOMER])).not.toThrow();
    // A repeated entry is still a solo role, not a combination.
    expect(() => assertRoleCombination([Role.DELIVERY, Role.DELIVERY])).not.toThrow();
  });

  it("assertRoleCombination rejects ADMIN combined with any other role", () => {
    expect(() => assertRoleCombination([Role.ADMIN, Role.CUSTOMER])).toThrow(
      /ADMIN cannot be combined/,
    );
    expect(() => assertRoleCombination([Role.ADMIN, Role.VENDOR])).toThrow(
      /ADMIN cannot be combined/,
    );
    expect(() => assertRoleCombination([Role.ADMIN, Role.DELIVERY])).toThrow(
      /ADMIN cannot be combined/,
    );
  });

  it("assertRoleCombination rejects DELIVERY combined with anything but CUSTOMER", () => {
    // The message is asserted, not just "it throws": simply deleting the
    // DELIVERY restriction would satisfy a bare toThrow() while silently
    // admitting VENDOR+DELIVERY and ADMIN+DELIVERY. Naming the rule pins it.
    expect(() => assertRoleCombination([Role.DELIVERY, Role.VENDOR])).toThrow(
      /DELIVERY can only be combined with CUSTOMER/,
    );
  });

  // Exhaustive over every subset of the Role enum. The approved policy admits
  // exactly seven combinations; anything else must be refused. Failures report
  // the offending combination by name rather than an index.
  it("assertRoleCombination admits no combination outside the approved policy", () => {
    // One normaliser used for BOTH the allowlist and the scan, so the empty
    // combination is labelled identically on both sides of the comparison.
    const nameOf = (combo: Role[]): string =>
      combo.length === 0 ? "(none)" : combo.slice().sort().join("+");

    const allowed = new Set<string>(
      (
        [
          [],
          [Role.CUSTOMER],
          [Role.VENDOR],
          [Role.ADMIN],
          [Role.DELIVERY],
          [Role.CUSTOMER, Role.VENDOR],
          [Role.CUSTOMER, Role.DELIVERY],
        ] as Role[][]
      ).map(nameOf),
    );

    const all = Object.values(Role) as Role[];
    const wronglyAccepted: string[] = [];
    const wronglyRejected: string[] = [];

    for (let mask = 0; mask < 1 << all.length; mask++) {
      const combo = all.filter((_, i) => mask & (1 << i));
      const name = nameOf(combo);
      let threw = false;
      try {
        assertRoleCombination(combo);
      } catch {
        threw = true;
      }
      if (allowed.has(name) && threw) wronglyRejected.push(name);
      if (!allowed.has(name) && !threw) wronglyAccepted.push(name);
    }

    expect(wronglyRejected).toEqual([]);
    expect(wronglyAccepted).toEqual([]);
  });
});

describe("onboarding derived from held roles", () => {
  const base: OnboardingUser = {
    role: "CUSTOMER",
    roles: [Role.CUSTOMER, Role.VENDOR],
    kycStatus: "PENDING",
    phoneNumber: "08012345678",
    brandName: "Dual Foods",
    brandLogo: "https://example.com/logo.png",
  };

  it("dual-role user in CUSTOMER mode still requires KYC (held VENDOR)", () => {
    const state = resolveOnboardingState(base);
    const kyc = state.steps.find((s) => s.key === "KYC")!;
    expect(kyc.done).toBe(false);
    expect(state.nextStep).toBe("KYC");
  });

  it("dual-role user passes KYC step once VERIFIED", () => {
    const state = resolveOnboardingState({ ...base, kycStatus: "VERIFIED" });
    expect(state.steps.find((s) => s.key === "KYC")!.done).toBe(true);
    expect(state.isComplete).toBe(true);
  });

  it("single CUSTOMER still skips KYC (backwards compatible, no roles passed)", () => {
    const state = resolveOnboardingState({
      role: "CUSTOMER",
      kycStatus: "PENDING",
      phoneNumber: null,
      brandName: null,
      brandLogo: null,
    });
    expect(state.steps.find((s) => s.key === "KYC")!.done).toBe(true);
    expect(state.isComplete).toBe(true);
  });
});

describe("migration backfill + schema", () => {
  it("initial migration creates the roles column with an empty-array default", () => {
    const dir = path.join(__dirname, "../../prisma/migrations");
    const initial = fs
      .readdirSync(dir)
      .filter((d) => d.endsWith("_init"))
      .sort()
      .pop();
    expect(initial).toBeTruthy();
    const sql = fs.readFileSync(path.join(dir, initial!, "migration.sql"), "utf8");
    expect(sql).toMatch(/"roles" "Role"\[\] DEFAULT ARRAY\[\]::"Role"\[\]/);
  });

  it("User model has roles Role[] with default", () => {
    const schema = fs.readFileSync(
      path.join(__dirname, "../../prisma/schema.prisma"),
      "utf8",
    );
    expect(schema).toMatch(/roles\s+Role\[\]\s+@default\(\[\]\)/);
    // existing active-role column untouched
    expect(schema).toMatch(/role\s+Role\?/);
  });
});

describe("register writes roles", () => {
  beforeEach(() => jest.clearAllMocks());

  it("sets role AND roles=[role] when role provided", async () => {
    db.user.findUnique.mockResolvedValue(null);
    db.user.create.mockImplementation(async (args: any) => ({
      id: "u-1",
      tokenVersion: 0,
      kycStatus: "PENDING",
      phoneNumber: null,
      brandName: null,
      brandLogo: null,
      ...args.data,
    }));

    const r = res();
    await register(
      {
        body: { name: "Test User", email: "t1@example.com", password: PASSWORD, role: "CUSTOMER" },
        headers: {},
      } as any,
      r,
    );

    expect(r.status).toHaveBeenCalledWith(201);
    expect(db.user.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ role: "CUSTOMER", roles: ["CUSTOMER"] }),
      }),
    );
  });

  it("still rejects ADMIN registration outright", async () => {
    const r = res();
    await register(
      { body: { name: "Root", email: "root@example.com", password: PASSWORD, role: "ADMIN" } } as any,
      r,
    );
    expect(r.status).toHaveBeenCalledWith(403);
    expect(db.user.create).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Security regression (Task 2): selecting or registering for DELIVERY must
// never, by itself, create an operationally ACTIVE rider.
//
// Before this change both paths wrote `status: "ACTIVE"`, so one public
// POST /api/auth/register produced a dispatch-eligible courier. Approval is an
// administrator action (PATCH /api/admin/delivery/:userId/status); the applicant
// profile must start non-operational.
// ─────────────────────────────────────────────────────────────────────────────
describe("register: rider profile is never self-activated", () => {
  beforeEach(() => jest.clearAllMocks());

  const stubUserCreate = () => {
    db.user.findUnique.mockResolvedValue(null);
    db.user.create.mockImplementation(async (args: any) => ({
      id: "u-delivery",
      tokenVersion: 0,
      kycStatus: "PENDING",
      phoneNumber: null,
      brandName: null,
      brandLogo: null,
      ...args.data,
    }));
  };

  const registerAs = async (role: string) => {
    const r = res();
    await register(
      {
        body: { name: "Rider Applicant", email: "rider@example.com", password: PASSWORD, role },
        headers: {},
      } as any,
      r,
    );
    return r;
  };

  it("creates the DeliveryPerson profile as INACTIVE, never ACTIVE", async () => {
    stubUserCreate();

    const r = await registerAs("DELIVERY");

    expect(r.status).toHaveBeenCalledWith(201);
    expect(db.deliveryPerson.create).toHaveBeenCalledTimes(1);
    const arg = db.deliveryPerson.create.mock.calls[0][0];
    expect(arg.data.status).toBe("INACTIVE");
    // Explicitly pin the property under test so a future revert to ACTIVE is a
    // failure with an obvious cause rather than a silently weakened assertion.
    expect(arg.data.status).not.toBe("ACTIVE");
    expect(arg.data.isOnline).toBe(false);
    expect(arg.data.userId).toBe("u-delivery");
  });

  it("wraps the account write and the profile write in one transaction", async () => {
    stubUserCreate();

    await registerAs("DELIVERY");

    expect(db.$transaction).toHaveBeenCalledTimes(1);
    // Both writes must go through the transaction client, not the bare client,
    // or they would commit independently and defeat the atomicity.
    expect(db.user.create).toHaveBeenCalledTimes(1);
    expect(db.deliveryPerson.create).toHaveBeenCalledTimes(1);
  });

  it("creates no rider profile for CUSTOMER or VENDOR signups", async () => {
    stubUserCreate();
    await registerAs("CUSTOMER");
    expect(db.deliveryPerson.create).not.toHaveBeenCalled();

    jest.clearAllMocks();
    stubUserCreate();
    await registerAs("VENDOR");
    expect(db.deliveryPerson.create).not.toHaveBeenCalled();
    expect(r0Status(await registerAs("VENDOR"))).toBe(201);
  });

  it("does not report success when the rider-profile write fails", async () => {
    stubUserCreate();
    db.deliveryPerson.create.mockRejectedValueOnce(new Error("profile write failed"));

    const r = await registerAs("DELIVERY");

    // The whole operation aborts: no 201 is handed back describing an account
    // that does not exist. Atomicity itself is enforced by PostgreSQL — this
    // mock only proves the failure is not swallowed into a success response.
    expect(r.status).not.toHaveBeenCalledWith(201);
  });
});

function r0Status(r: any): number | undefined {
  return r.status.mock.calls[0]?.[0];
}

describe("selectRole: policy validated before the write, profile never self-activated", () => {
  beforeEach(() => jest.clearAllMocks());

  const freshUser = { id: "u-sel", role: null as any, roles: [] as any[] };
  // selectRole now claims the role write with a CONDITIONAL updateMany, so the
  // stub mirrors the real call order:
  //   1. findUnique  -> the role-less guard read
  //   2. updateMany  -> the conditional claim (sets `role` AND `roles`)
  //   3. findUnique  -> the read-back of the claimed row (inside the tx)
  // Only the claim is captured: ensureVendorStatusNew also calls updateMany on
  // the same mocked client but writes `vendorStatus` only, so keying off
  // "last updateMany call" would hand back a row with no `roles` at all.
  const stubUpdate = () => {
    let claimed: any = null;
    db.user.findUnique.mockImplementation(
      async () => ({
        id: "u-sel",
        kycStatus: "PENDING",
        phoneNumber: null,
        brandName: null,
        brandLogo: null,
        ...(claimed ?? freshUser),
      }),
    );
    db.user.updateMany.mockImplementation(async (args: any) => {
      if (args?.data && "roles" in args.data) claimed = args.data;
      return { count: 1 };
    });
  };

  const select = async (role: string) => {
    const r = res();
    await selectRole(
      { user: { id: "u-sel", role: "", sessionId: "s" }, body: { role } } as any,
      r,
    );
    return r;
  };

  it("creates the DeliveryPerson profile as INACTIVE, never ACTIVE", async () => {
    stubUpdate();

    const r = await select("DELIVERY");

    expect(r.status).toHaveBeenCalledWith(200);
    expect(db.deliveryPerson.upsert).toHaveBeenCalledTimes(1);
    const arg = db.deliveryPerson.upsert.mock.calls[0][0];
    expect(arg.create.status).toBe("INACTIVE");
    expect(arg.create.status).not.toBe("ACTIVE");
    expect(arg.create.isOnline).toBe(false);
  });

  it("never demotes an existing rider through the upsert's update branch", async () => {
    stubUpdate();

    await select("DELIVERY");

    // `update: {}` means re-selecting a role leaves an administrator-approved
    // ACTIVE rider untouched. A blanket `status` write here would silently
    // de-activate a live courier.
    expect(db.deliveryPerson.upsert.mock.calls[0][0].update).toEqual({});
  });

  it("keeps VENDOR selection free of any rider-profile write", async () => {
    stubUpdate();

    const r = await select("VENDOR");

    expect(r.status).toHaveBeenCalledWith(200);
    expect(db.deliveryPerson.upsert).not.toHaveBeenCalled();
  });

  it("rejects a policy-invalid combination before any role or profile write", async () => {
    stubUpdate();
    const spy = jest
      .spyOn(require("../../src/utils/roles"), "assertRoleCombination")
      .mockImplementation(() => {
        throw new Error("DELIVERY can only be combined with CUSTOMER");
      });

    try {
      const r = await select("DELIVERY");

      expect(r.status).toHaveBeenCalledWith(403);
      // The ordering is the point: validation must run BEFORE the write, or a
      // tightened policy would still leave a forbidden combination persisted.
      expect(db.user.update).not.toHaveBeenCalled();
      expect(db.deliveryPerson.upsert).not.toHaveBeenCalled();
      expect(db.$transaction).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("consults the shared role policy on every selection", async () => {
    stubUpdate();
    const spy = jest.spyOn(require("../../src/utils/roles"), "assertRoleCombination");

    try {
      await select("DELIVERY");
      expect(spy).toHaveBeenCalledWith([Role.DELIVERY]);

      jest.clearAllMocks();
      stubUpdate();
      await select("VENDOR");
      expect(spy).toHaveBeenCalledWith([Role.VENDOR]);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("selectRole writes roles and honours held roles", () => {
  beforeEach(() => jest.clearAllMocks());

  it("sets role and roles=[role] for a fresh user", async () => {
    let claimed: any = null;
    db.user.findUnique.mockImplementation(
      async () => ({
        id: "u-2",
        kycStatus: "PENDING",
        phoneNumber: null,
        brandName: null,
        brandLogo: null,
        ...(claimed ?? { role: null, roles: [] }),
      }),
    );
    db.user.updateMany.mockImplementation(async (args: any) => {
      if (args?.data && "roles" in args.data) claimed = args.data;
      return { count: 1 };
    });

    const r = res();
    await selectRole(
      { user: { id: "u-2", role: "", sessionId: "s" }, body: { role: "VENDOR" } } as any,
      r,
    );

    expect(r.status).toHaveBeenCalledWith(200);
    expect(db.user.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { role: "VENDOR", roles: ["VENDOR"] } }),
    );
  });

  it("rejects when the account already holds a role (roles non-empty)", async () => {
    db.user.findUnique.mockResolvedValue({ id: "u-3", role: "CUSTOMER", roles: ["CUSTOMER"] });

    const r = res();
    await selectRole(
      { user: { id: "u-3", role: "CUSTOMER", sessionId: "s" }, body: { role: "VENDOR" } } as any,
      r,
    );

    expect(r.status).toHaveBeenCalledWith(400);
    expect(db.user.updateMany).not.toHaveBeenCalled();
    expect(db.user.update).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Task 2.1 — the role-less precondition must be enforced by the WRITE.
//
// The controller guards with a plain `findUnique` at :1219. That read is a
// normal statement, so it is stale the moment any other role-write lands in
// between. The conditional `updateMany` claim is what makes the refusal
// authoritative; these tests pin that shape so a future refactor back to a
// bare `update` fails here.
// ─────────────────────────────────────────────────────────────────────────────
describe("selectRole: the role-less precondition is enforced at the write", () => {
  beforeEach(() => jest.clearAllMocks());

  const selectAs = async (id: string, role: string) => {
    const r = res();
    await selectRole({ user: { id, role: "", sessionId: "s" }, body: { role } } as any, r);
    return r;
  };

  it("claims the row with a conditional updateMany, not an unconditional update", async () => {
    db.user.findUnique.mockResolvedValue({ id: "u-4", role: null, roles: [] });
    db.user.updateMany.mockResolvedValue({ count: 1 });

    await selectAs("u-4", "DELIVERY");

    expect(db.user.updateMany).toHaveBeenCalledTimes(1);
    // An unconditional `update` would be the vulnerability: it would overwrite
    // whatever role the account held at commit time.
    expect(db.user.update).not.toHaveBeenCalled();

    const where = db.user.updateMany.mock.calls[0][0].where;
    expect(where.id).toBe("u-4");
    expect(where.role).toBeNull();
    expect(where.AND).toEqual([
      {
        NOT: {
          roles: {
            hasSome: [Role.CUSTOMER, Role.VENDOR, Role.ADMIN, Role.DELIVERY],
          },
        },
      },
    ]);
  });

  it("writes nothing and refuses when the account gained a role after the guard read", async () => {
    // The guard read (outside the transaction) saw a role-less account...
    db.user.findUnique.mockResolvedValue({ id: "u-5", role: null, roles: [] });
    // ...but by commit time the row no longer matches the claim, so the
    // conditional update matches zero rows — the VENDOR landed in between.
    db.user.updateMany.mockResolvedValue({ count: 0 });

    const r = await selectAs("u-5", "DELIVERY");

    expect(r.status).toHaveBeenCalledWith(400);
    expect(r.json).toHaveBeenCalledWith({ message: "Role already selected" });
    // Zero downstream writes: no role persisted, no rider profile created.
    expect(db.deliveryPerson.upsert).not.toHaveBeenCalled();
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it.each([
    ["VENDOR", { role: "VENDOR", roles: ["VENDOR"] }],
    ["ADMIN", { role: "ADMIN", roles: ["ADMIN"] }],
    ["CUSTOMER", { role: "CUSTOMER", roles: ["CUSTOMER"] }],
  ])(
    "refuses %s-holding accounts without any write",
    async (_label, held) => {
      db.user.findUnique.mockResolvedValue({ id: "u-6", ...held });

      const r = await selectAs("u-6", "DELIVERY");

      expect(r.status).toHaveBeenCalledWith(400);
      expect(db.user.updateMany).not.toHaveBeenCalled();
      expect(db.deliveryPerson.upsert).not.toHaveBeenCalled();
    },
  );

  it("cannot turn an account that holds VENDOR into a delivery rider", async () => {
    // Belt-and-braces on the policy itself: even if the guard were removed
    // entirely, the resulting set this path can produce is a solo role, so no
    // forbidden VENDOR+DELIVERY combination is reachable through select-role.
    expect(() =>
      assertRoleCombination([Role.VENDOR, Role.DELIVERY]),
    ).toThrow(/DELIVERY can only be combined with CUSTOMER/);
    expect(() =>
      assertRoleCombination([Role.ADMIN, Role.DELIVERY]),
    ).toThrow(/ADMIN cannot be combined/);
    expect(() => assertRoleCombination([Role.CUSTOMER, Role.DELIVERY])).not.toThrow();
  });

  it("keeps User.role and User.roles consistent with each other", async () => {
    db.user.findUnique.mockResolvedValue({ id: "u-7", role: null, roles: [] });
    db.user.updateMany.mockResolvedValue({ count: 1 });

    const r = await selectAs("u-7", "DELIVERY");

    expect(r.status).toHaveBeenCalledWith(200);
    const { role, roles } = db.user.updateMany.mock.calls[0][0].data;
    // The invariant in src/utils/roles.ts: role != null implies roles contains
    // role. A write that set one without the other would break authenticate's
    // held-role check (auth.middleware.ts:118).
    expect(roles).toContain(role);
    expect(roles).toEqual([role]);
  });
});
