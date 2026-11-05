/**
 * Phase 1B multi-role — flow tests with mocked persistence.
 *
 * Covers:
 * - become-vendor rules (CUSTOMER-only, verified, ADMIN/DELIVERY refused)
 * - switch-role (held-role only, fresh access token, JWT single active role)
 * - token gating: vendor routes work / customer routes 403 after switch (and reverse)
 * - dual-role discoverability in CUSTOMER mode (listings + follow)
 * - self-dealing guards (cart, special orders, reviews, promos, follow, referral)
 */
import jwt from "jsonwebtoken";

import { Role } from "@prisma/client";
import { ForbiddenError, ValidationError } from "../../src/errors/AppError";

jest.mock("../../src/lib/prisma", () => ({
  __esModule: true,
  default: {
    user: { findUnique: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
    // Phase 1E: a role switch now writes the SESSION's active role.
    userSession: {
      updateMany: jest.fn(async () => ({ count: 1 })),
      upsert: jest.fn(async () => ({})),
      findUnique: jest.fn(async () => null),
      deleteMany: jest.fn(async () => ({ count: 0 })),
    },
    product: { findUnique: jest.fn() },
    productReview: { findFirst: jest.fn() },
    vendorReview: { findFirst: jest.fn(), groupBy: jest.fn(async () => []) },
    vendorFollower: { findUnique: jest.fn(), create: jest.fn() },
    specialOrderRequest: { findUnique: jest.fn(), create: jest.fn() },
    specialOrderOffer: { findUnique: jest.fn(), create: jest.fn() },
    promotion: { findFirst: jest.fn(), findUnique: jest.fn() },
    promotionUsage: { count: jest.fn() },
    cart: { findFirst: jest.fn() },
    order: { findMany: jest.fn() },
    // Phase 1: checkout writes an ORDER_CREATED audit row instead of the old
    // vendor "New Order Received" activity bundle.
    auditLog: { create: jest.fn(async () => ({})) },
    address: { findFirst: jest.fn() },
    cartSummarySnapshot: { findUnique: jest.fn() },
  },
}));

jest.mock("../../src/lib/redis", () => {
  const asyncFn = () => jest.fn(async () => null);
  return {
    __esModule: true,
    ShopCartRedis: { get: asyncFn(), set: asyncFn(), del: asyncFn() },
    redisProducts: { get: asyncFn(), set: asyncFn(), del: asyncFn() },
    redisPayments: { get: asyncFn(), set: asyncFn(), del: asyncFn() },
    redisUsersSessions: {
      get: asyncFn(), set: asyncFn(), del: asyncFn(),
      sAdd: asyncFn(), sRem: asyncFn(), sMembers: jest.fn(async () => []),
      expire: asyncFn(),
    },
    redisSearch: { get: asyncFn(), set: asyncFn(), del: asyncFn() },
    redisTotalViews: { get: asyncFn(), set: asyncFn(), del: asyncFn(), incr: asyncFn(), expire: asyncFn() },
  };
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
  getUserSession: jest.fn(async () => ({})),
  // Phase 1E: a role switch writes the session's own active role.
  setSessionActiveRole: jest.fn(async () => {}),
  resolveSessionRole: jest.fn((session: any, accountRole: any) => {
    const sessionRole = session?.activeRole;
    return typeof sessionRole === "string" && sessionRole.length > 0 ? sessionRole : accountRole ?? null;
  }),
}));

jest.mock("../../src/jobs/workers jobs/vendorFollowWorker", () => ({
  __esModule: true,
  vendorFollowQueue: { add: jest.fn(async () => {}) },
}));

import prisma from "../../src/lib/prisma";
import { becomeVendor, switchRole } from "../../src/controllers/auth.controller";
import { authorizeVendor, authorizeCustomer } from "../../src/middlewares/auth.middleware";
import { findNearbyVendors } from "../../src/controllers/vendorControllerMapping";
import { followVendor } from "../../src/controllers/vendorFollowController";
import { addToCart, checkoutCart } from "../../src/controllers/cartController";
import {
  createSpecialRequest,
  createSpecialOffer,
  acceptSpecialOffer,
} from "../../src/controllers/orderController";
import { reviewProduct, reviewVendor } from "../../src/controllers/reviewController";
import { applyPromoService } from "../../src/services/promoService";
import { applyReferralCode } from "../../src/controllers/referralController";

const db = prisma as unknown as Record<string, Record<string, jest.Mock>>;

const UUID = "11111111-1111-4111-8111-111111111111";
const UUID2 = "22222222-2222-4222-8222-222222222222";

const res = (): any => {
  const r: any = {};
  r.status = jest.fn().mockReturnValue(r);
  r.json = jest.fn().mockReturnValue(r);
  r.cookie = jest.fn().mockReturnValue(r);
  return r;
};

const authed = (id: string, role: string) =>
  ({ user: { id, role, sessionId: "sess-1" } }) as any;

beforeEach(() => jest.clearAllMocks());

describe("become-vendor", () => {
  const customer = {
    id: "cust-1",
    role: "CUSTOMER",
    roles: ["CUSTOMER"],
    isBlocked: false,
    isEmailVerified: true,
  };

  it("adds VENDOR to held roles without changing the active role", async () => {
    db.user.findUnique
      .mockResolvedValueOnce({ ...customer })
      .mockResolvedValueOnce({ id: "cust-1", role: "CUSTOMER", roles: ["CUSTOMER", "VENDOR"] });
    db.user.updateMany.mockResolvedValue({ count: 1 });

    const r = res();
    await becomeVendor(
      { ...authed("cust-1", "CUSTOMER"), body: { brandName: "Dual Foods", phoneNumber: "08012345678" } } as any,
      r,
    );

    expect(r.status).toHaveBeenCalledWith(200);
    // Conditional atomic update: only wins when VENDOR not already held.
    expect(db.user.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "cust-1" }),
        data: expect.objectContaining({ brandName: "Dual Foods" }),
      }),
    );
    const cond = db.user.updateMany.mock.calls[0][0].where;
    expect(JSON.stringify(cond)).toContain("VENDOR");
    expect(r.json).toHaveBeenCalledWith(
      expect.objectContaining({ role: "CUSTOMER", roles: ["CUSTOMER", "VENDOR"] }),
    );
  });

  it("never writes `role` or any session state — only appends to `roles`", async () => {
    // The proof that the ACTIVE role is untouched must come from the write
    // itself. A fabricated `findUnique` return value only describes what the
    // mock was told to say; it cannot show that `role` was absent from the
    // UPDATE, which is the property that actually matters.
    db.user.findUnique
      .mockResolvedValueOnce({ ...customer })
      .mockResolvedValueOnce({ id: "cust-1", role: "CUSTOMER", roles: ["CUSTOMER", "VENDOR"] });
    db.user.updateMany.mockResolvedValue({ count: 1 });

    await becomeVendor(
      { ...authed("cust-1", "CUSTOMER"), body: { brandName: "Dual Foods" } } as any,
      res(),
    );

    // `ensureVendorStatusNew` / `evaluateVendorStatus` legitimately issue their
    // OWN user.updateMany for the Phase 1C lifecycle, so the role write is
    // selected by its shape rather than by call order or total count.
    const writes = db.user.updateMany.mock.calls.map((c: any[]) => c[0].data);
    const roleWrites = writes.filter((w: any) => w && "roles" in w);
    expect(roleWrites).toHaveLength(1);

    const write = roleWrites[0];
    // `role` is the account-wide active role: a become-vendor must never set it.
    expect(write).not.toHaveProperty("role");
    // `roles` is appended to, never replaced with a client-influenced array.
    expect(write.roles).toEqual({ push: Role.VENDOR });
    // And no write in this flow — vendor onboarding included — may touch `role`.
    expect(writes.some((w: any) => w && "role" in w)).toBe(false);
    // No session-scoped role write either — becoming a vendor does not switch
    // this session; that stays the exclusive job of POST /switch-role.
    expect(db.userSession.updateMany).not.toHaveBeenCalled();
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it("rejects accounts that already hold VENDOR", async () => {
    db.user.findUnique.mockResolvedValue({ ...customer, roles: ["CUSTOMER", "VENDOR"] });
    const r = res();
    await becomeVendor(
      { ...authed("cust-1", "CUSTOMER"), body: { brandName: "X Foods" } } as any,
      r,
    );
    expect(r.status).toHaveBeenCalledWith(400);
    expect(db.user.updateMany).not.toHaveBeenCalled();
  });

  it("loses a concurrent VENDOR-add race cleanly (conditional update claims nothing)", async () => {
    db.user.findUnique
      .mockResolvedValueOnce({ ...customer })
      .mockResolvedValueOnce({ id: "cust-1", roles: ["CUSTOMER", "VENDOR"] });
    db.user.updateMany.mockResolvedValue({ count: 0 });

    const r = res();
    await becomeVendor(
      { ...authed("cust-1", "CUSTOMER"), body: { brandName: "X Foods" } } as any,
      r,
    );

    expect(r.status).toHaveBeenCalledWith(409);
  });

  it("rejects ADMIN / DELIVERY / non-CUSTOMER / unverified / blocked", async () => {
    // Each case asserts the SPECIFIC status the endpoint is documented to
    // return. `not.toHaveBeenCalledWith(200)` would also pass on an unrelated
    // 500 and so could not distinguish a deliberate refusal from a crash.
    const cases: Array<{ user: Record<string, unknown>; status: number; message: RegExp }> = [
      {
        user: { ...customer, id: "a", roles: ["ADMIN"], role: "ADMIN" },
        status: 403,
        message: /ADMIN and DELIVERY accounts cannot become vendors/,
      },
      {
        user: { ...customer, id: "d", roles: ["DELIVERY"], role: "DELIVERY" },
        status: 403,
        message: /ADMIN and DELIVERY accounts cannot become vendors/,
      },
      {
        user: { ...customer, id: "n", roles: [], role: null },
        status: 403,
        message: /Only CUSTOMER accounts can become vendors/,
      },
      {
        user: { ...customer, id: "u", isEmailVerified: false },
        status: 403,
        message: /verify your email/i,
      },
      {
        user: { ...customer, id: "b", isBlocked: true },
        status: 403,
        message: /blocked/i,
      },
    ];

    for (const { user, status, message } of cases) {
      db.user.findUnique.mockResolvedValue(user);
      const r = res();
      await becomeVendor(
        { user: { id: user.id as string, role: user.role as string, sessionId: "s" }, body: { brandName: "X Foods" } } as any,
        r,
      );
      expect(r.status).toHaveBeenCalledWith(status);
      expect(r.json.mock.calls[0][0].message).toMatch(message);
    }
    // No eligibility failure may reach the write.
    expect(db.user.updateMany).not.toHaveBeenCalled();
  });

  it("refuses a malformed payload before any account read", async () => {
    const r = res();
    await becomeVendor(
      { ...authed("cust-1", "CUSTOMER"), body: { brandName: "x" } } as any,
      r,
    );
    expect(r.status).toHaveBeenCalledWith(422);
    expect(db.user.findUnique).not.toHaveBeenCalled();
    expect(db.user.updateMany).not.toHaveBeenCalled();
  });

  // The security property under test: the role-combination invariant must be
  // enforced by the WRITE against the latest row, not by the earlier read.
  // A read-then-write check is stale the moment an admin role change lands in
  // between, and would let the push build [ADMIN, VENDOR] / [DELIVERY, VENDOR].
  describe("race predicate enforces the combination against the latest row", () => {
    const readAsPlainCustomer = () => {
      db.user.findUnique
        .mockResolvedValueOnce({ ...customer })
        .mockResolvedValueOnce({ id: "cust-1", role: "CUSTOMER", roles: ["CUSTOMER", "VENDOR"] });
    };

    it("excludes rows that already hold VENDOR", async () => {
      readAsPlainCustomer();
      db.user.updateMany.mockResolvedValue({ count: 1 });

      await becomeVendor(
        { ...authed("cust-1", "CUSTOMER"), body: { brandName: "Dual Foods" } } as any,
        res(),
      );

      const conditions = db.user.updateMany.mock.calls[0][0].where.AND;
      expect(conditions).toEqual(
        expect.arrayContaining([{ NOT: { roles: { has: Role.VENDOR } } }]),
      );
    });

    it("excludes rows that hold ADMIN, which is what closes the race", async () => {
      readAsPlainCustomer();
      db.user.updateMany.mockResolvedValue({ count: 1 });

      await becomeVendor(
        { ...authed("cust-1", "CUSTOMER"), body: { brandName: "Dual Foods" } } as any,
        res(),
      );

      const conditions = db.user.updateMany.mock.calls[0][0].where.AND;
      expect(conditions).toEqual(
        expect.arrayContaining([
          { NOT: { roles: { hasSome: [Role.ADMIN, Role.DELIVERY] } } },
        ]),
      );
      // Guard against a future edit silently narrowing this back to VENDOR.
      const serialized = JSON.stringify(conditions);
      expect(serialized).toContain(Role.ADMIN);
      expect(serialized).toContain(Role.DELIVERY);
    });

    it("still scopes the write to this one account", async () => {
      readAsPlainCustomer();
      db.user.updateMany.mockResolvedValue({ count: 1 });

      await becomeVendor(
        { ...authed("cust-1", "CUSTOMER"), body: { brandName: "Dual Foods" } } as any,
        res(),
      );

      const where = db.user.updateMany.mock.calls[0][0].where;
      expect(where.id).toBe("cust-1");
      expect(where.AND).toHaveLength(2);
    });

    it("reports 403, not a misleading 409, when the row became ADMIN mid-flight", async () => {
      // The read above saw a plain CUSTOMER, so every pre-flight check passed.
      // The write then matched nothing because an admin role change had already
      // made this account an ADMIN. The client must be told the real reason.
      db.user.findUnique
        .mockResolvedValueOnce({ ...customer })
        .mockResolvedValueOnce({ id: "cust-1", roles: ["ADMIN"] });
      db.user.updateMany.mockResolvedValue({ count: 0 });

      const r = res();
      await becomeVendor(
        { ...authed("cust-1", "CUSTOMER"), body: { brandName: "Dual Foods" } } as any,
        r,
      );

      expect(r.status).toHaveBeenCalledWith(403);
      expect(r.json.mock.calls[0][0].message).toMatch(
        /ADMIN and DELIVERY accounts cannot become vendors/,
      );
    });

    it("still reports 409 when another become-vendor genuinely won the race", async () => {
      db.user.findUnique
        .mockResolvedValueOnce({ ...customer })
        .mockResolvedValueOnce({ id: "cust-1", roles: ["CUSTOMER", "VENDOR"] });
      db.user.updateMany.mockResolvedValue({ count: 0 });

      const r = res();
      await becomeVendor(
        { ...authed("cust-1", "CUSTOMER"), body: { brandName: "X Foods" } } as any,
        r,
      );

      expect(r.status).toHaveBeenCalledWith(409);
      expect(r.json.mock.calls[0][0].message).toMatch(/already holds VENDOR/);
    });
  });
});

describe("switch-role", () => {
  const dual = {
    id: "dual-1",
    role: "CUSTOMER",
    roles: ["CUSTOMER", "VENDOR"],
    isBlocked: false,
  };

  it("writes the SESSION's active role, never the account-wide role", async () => {
    // Phase 1E. This used to write `User.role`, which is account-wide, so
    // switching on one device silently re-roled every other one.
    const { setSessionActiveRole, getUserSession } = require("../../src/lib/session") as {
      setSessionActiveRole: jest.Mock;
      getUserSession: jest.Mock;
    };
    db.user.findUnique.mockResolvedValue({ ...dual });
    getUserSession.mockResolvedValue({ ip: "1.2.3.4", activeRole: "CUSTOMER" });

    const r = res();
    await switchRole({ ...authed("dual-1", "CUSTOMER"), body: { role: "VENDOR" } } as any, r);

    expect(r.status).toHaveBeenCalledWith(200);
    expect(setSessionActiveRole).toHaveBeenCalledWith("dual-1", "sess-1", "VENDOR");
    // The account row is untouched.
    expect(db.user.update).not.toHaveBeenCalled();
    expect(db.user.updateMany).not.toHaveBeenCalled();
    expect((r.json.mock.calls[0][0] as any).role).toBe("VENDOR");
  });

  it("does not let one device's switch touch another session of the same account", async () => {
    const { setSessionActiveRole } = require("../../src/lib/session") as { setSessionActiveRole: jest.Mock };
    db.user.findUnique.mockResolvedValue({ ...dual });

    await switchRole({ ...authed("dual-1", "CUSTOMER"), body: { role: "VENDOR" } } as any, res());

    // Exactly one (caller, target) — no "revoke the others", no global write.
    expect(setSessionActiveRole).toHaveBeenCalledTimes(1);
    expect(setSessionActiveRole).toHaveBeenCalledWith("dual-1", "sess-1", "VENDOR");
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it("refuses to record a role the account does not hold", async () => {
    const { setSessionActiveRole } = require("../../src/lib/session") as { setSessionActiveRole: jest.Mock };
    db.user.findUnique.mockResolvedValue({ id: "c-1", role: "CUSTOMER", roles: ["CUSTOMER"], isBlocked: false });

    const r = res();
    await switchRole({ ...authed("c-1", "CUSTOMER"), body: { role: "VENDOR" } } as any, r);

    expect(r.status).toHaveBeenCalledWith(403);
    expect(setSessionActiveRole).not.toHaveBeenCalled();
  });

  it("still rejects a revoked session", async () => {
    const { setSessionActiveRole, getUserSession } = require("../../src/lib/session") as {
      setSessionActiveRole: jest.Mock;
      getUserSession: jest.Mock;
    };
    db.user.findUnique.mockResolvedValue({ ...dual });
    getUserSession.mockResolvedValueOnce(null);

    const r = res();
    await switchRole({ ...authed("dual-1", "CUSTOMER"), body: { role: "VENDOR" } } as any, r);

    expect(r.status).toHaveBeenCalledWith(401);
    expect(setSessionActiveRole).not.toHaveBeenCalled();
  });

  it("switches CUSTOMER -> VENDOR and mints an access token with the new active role", async () => {
    db.user.findUnique.mockResolvedValue({ ...dual });

    const r = res();
    await switchRole({ ...authed("dual-1", "CUSTOMER"), body: { role: "VENDOR" } } as any, r);

    expect(r.status).toHaveBeenCalledWith(200);
    const payload = r.json.mock.calls[0][0];
    expect(payload.role).toBe("VENDOR");
    expect(payload.roles).toEqual(["CUSTOMER", "VENDOR"]);
    const decoded = jwt.decode(payload.accessToken) as any;
    expect(decoded.role).toBe("VENDOR");
    expect(decoded.sessionId).toBe("sess-1");
  });

  it("switches back VENDOR -> CUSTOMER", async () => {
    db.user.findUnique.mockResolvedValue({ ...dual, role: "VENDOR" });

    const r = res();
    await switchRole({ ...authed("dual-1", "VENDOR"), body: { role: "CUSTOMER" } } as any, r);

    expect(r.status).toHaveBeenCalledWith(200);
    expect((jwt.decode(r.json.mock.calls[0][0].accessToken) as any).role).toBe("CUSTOMER");
  });

  it("rejects a role the account does not hold", async () => {
    db.user.findUnique.mockResolvedValue({ id: "c-1", role: "CUSTOMER", roles: ["CUSTOMER"], isBlocked: false });
    const r = res();
    await switchRole({ ...authed("c-1", "CUSTOMER"), body: { role: "VENDOR" } } as any, r);
    expect(r.status).toHaveBeenCalledWith(403);
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it("rejects blocked accounts", async () => {
    db.user.findUnique.mockResolvedValue({ ...dual, isBlocked: true });
    const r = res();
    await switchRole({ ...authed("dual-1", "CUSTOMER"), body: { role: "VENDOR" } } as any, r);
    expect(r.status).toHaveBeenCalledWith(403);
    expect(r.json.mock.calls[0][0].message).toMatch(/blocked/i);
  });

  // `switchRoleSchema` admits CUSTOMER, VENDOR, DELIVERY, and ADMIN.
  // Out-of-enum values are rejected by validation (422) before any account read.
  // Valid roles the account doesn't hold (ADMIN, DELIVERY for a CUSTOMER-only
  // account) are rejected by the authorization check (403).
  it("rejects an out-of-enum target role with 422 and touches nothing", async () => {
    for (const requested of ["SUPERUSER", "", "customer"]) {
      const r = res();
      await switchRole({ ...authed("dual-1", "CUSTOMER"), body: { role: requested } } as any, r);
      expect(r.status).toHaveBeenCalledWith(422);
      expect(r.json.mock.calls[0][0].errors).toHaveProperty("role");
      expect(db.user.findUnique).not.toHaveBeenCalled();
    }

    const { setSessionActiveRole } = require("../../src/lib/session") as {
      setSessionActiveRole: jest.Mock;
    };
    expect(setSessionActiveRole).not.toHaveBeenCalled();
  });

  it("rejects a valid role the account does not hold with 403 and touches nothing", async () => {
    // Ensure the user is not blocked
    db.user.findUnique.mockResolvedValue({ ...dual, isBlocked: false });

    for (const requested of ["ADMIN", "DELIVERY"]) {
      const r = res();
      await switchRole({ ...authed("dual-1", "CUSTOMER"), body: { role: requested } } as any, r);
      expect(r.status).toHaveBeenCalledWith(403);
      expect(r.json.mock.calls[0][0].message).toBe("Account does not hold the requested role");
      expect(db.user.findUnique).toHaveBeenCalled();
    }

    const { setSessionActiveRole } = require("../../src/lib/session") as {
      setSessionActiveRole: jest.Mock;
    };
    expect(setSessionActiveRole).not.toHaveBeenCalled();
  });

  it("rejects a missing or non-string role with 422", async () => {
    for (const body of [{}, { role: null }, { role: 42 }]) {
      const r = res();
      await switchRole({ ...authed("dual-1", "CUSTOMER"), body } as any, r);
      expect(r.status).toHaveBeenCalledWith(422);
    }
    expect(db.user.findUnique).not.toHaveBeenCalled();
  });

  it("fails closed with a generic 500 when the session write throws", async () => {
    // The DB write inside setSessionActiveRole is the authoritative one. If it
    // fails, no token may be handed back, because the client would then hold a
    // token for a role the session was never actually switched to.
    const { setSessionActiveRole } = require("../../src/lib/session") as {
      setSessionActiveRole: jest.Mock;
    };
    db.user.findUnique.mockResolvedValue({ ...dual });
    setSessionActiveRole.mockRejectedValueOnce(
      new Error("connection to postgres://user:secret@host/db failed"),
    );

    const r = res();
    await switchRole({ ...authed("dual-1", "CUSTOMER"), body: { role: "VENDOR" } } as any, r);

    expect(r.status).toHaveBeenCalledWith(500);
    // The failure message must not reach the client — it can carry a DSN.
    expect(JSON.stringify(r.json.mock.calls[0][0])).not.toMatch(/postgres:\/\//);
    expect(r.json.mock.calls[0][0].message).not.toMatch(/connection/i);
  });

  it("requires an authenticated session before switching", async () => {
    const r = res();
    await switchRole({ user: { id: "dual-1", role: "CUSTOMER" }, body: { role: "VENDOR" } } as any, r);
    expect(r.status).toHaveBeenCalledWith(401);
    expect(db.user.findUnique).not.toHaveBeenCalled();
  });
});

describe("token gating after switch (JWT single active role, middleware untouched)", () => {
  const next = () => jest.fn();

  it("VENDOR token opens vendor routes and is refused customer routes", () => {
    const vendorReq = { user: { id: "x", role: "VENDOR", sessionId: "s" } } as any;
    expect(() => authorizeVendor(vendorReq, {} as any, next())).not.toThrow();
    expect(() => authorizeCustomer(vendorReq, {} as any, next())).toThrow(ForbiddenError);
  });

  it("CUSTOMER token opens customer routes and is refused vendor routes", () => {
    const custReq = { user: { id: "x", role: "CUSTOMER", sessionId: "s" } } as any;
    expect(() => authorizeCustomer(custReq, {} as any, next())).not.toThrow();
    expect(() => authorizeVendor(custReq, {} as any, next())).toThrow(ForbiddenError);
  });
});

describe("dual-role discoverability in CUSTOMER mode", () => {
  it("vendor listings query held roles and include a vendor whose active role is CUSTOMER", async () => {
    db.user.findMany.mockImplementation(async (args: any) => {
      expect(args.where).toEqual({ roles: { has: Role.VENDOR } });
      return [
        {
          id: "dual-1",
          name: "Dual",
          brandName: "Dual Foods",
          brandLogo: null,
          avatarUrl: null,
          isLive: true, vendorStatus: "ACTIVE",
          deliveryPreferences: { acceptingOrders: true },
          addresses: [{ isDefault: true, latitude: 6.5, longitude: 3.3 }],
        },
      ];
    });

    const nearby = await findNearbyVendors(6.51, 3.31, 5);
    expect(nearby).toHaveLength(1);
    expect(nearby[0].id).toBe("dual-1");
  });

  it("another customer can follow a dual-role store even while it is in CUSTOMER mode", async () => {
    db.user.findUnique.mockResolvedValue({ id: UUID, role: "CUSTOMER", roles: ["CUSTOMER", "VENDOR"] });
    db.vendorFollower.findUnique.mockResolvedValue(null);
    db.vendorFollower.create.mockResolvedValue({ id: "f-1", vendorId: UUID, customerId: "other-1" });

    const r = res();
    await followVendor(
      { user: { id: "other-1", role: "CUSTOMER", sessionId: "s" }, body: { vendorId: UUID } } as any,
      r,
    );
    expect(r.status).toHaveBeenCalledWith(201);
  });
});

describe("self-dealing guards", () => {
  const ME = "me-user";

  it("addToCart rejects your own product", async () => {
    db.product.findUnique.mockResolvedValue({ id: UUID, vendorId: ME, archived: false, options: [] });
    await expect(
      addToCart(
        { user: { id: ME, role: "CUSTOMER", sessionId: "s" }, body: { productId: UUID } } as any,
        res(),
      ),
    ).rejects.toThrow(ForbiddenError);
  });

  it("checkout rejects a cart containing your own product", async () => {
    db.order.findMany.mockResolvedValue([]);
    db.address.findFirst.mockResolvedValue({ id: "a-1" });
    db.cartSummarySnapshot.findUnique.mockResolvedValue({
      id: "s-1",
      userId: ME,
      createdAt: new Date(),
      snapshot: { vendorBreakdown: [{ vendorId: "v-9", subtotal: 100 }] },
    });
    db.user.findUnique.mockResolvedValue({ email: "me@example.com" });
    db.cart.findFirst.mockResolvedValue({
      id: "c-1",
      items: [
        {
          id: "i-1", productId: "p-1", quantity: 1, unitPrice: 100, subtotal: 100,
          options: [], product: { id: "p-1", vendorId: ME },
        },
      ],
    });

    await expect(
      checkoutCart(
        {
          user: { id: ME, role: "CUSTOMER", sessionId: "s" },
          headers: { "idempotency-key": "k-1" },
          body: { summaryId: "s-1", addressId: "a-1" },
        } as any,
        res(),
      ),
    ).rejects.toThrow(ForbiddenError);
  });

  it("createSpecialRequest rejects your own product", async () => {
    db.product.findUnique.mockResolvedValue({ id: UUID, vendorId: ME });
    await expect(
      createSpecialRequest(
        {
          user: { id: ME, role: "CUSTOMER", sessionId: "s" },
          body: { productId: UUID, quantity: 2, details: "bulk rice" },
        } as any,
        res(),
      ),
    ).rejects.toThrow(ForbiddenError);
  });

  it("createSpecialOffer rejects bidding on your own request", async () => {
    db.specialOrderRequest.findUnique.mockResolvedValue({ id: "r-1", customerId: ME, status: "PENDING" });
    await expect(
      createSpecialOffer(
        {
          user: { id: ME, role: "VENDOR", sessionId: "s" },
          params: { requestId: "r-1" },
          body: { price: 500 },
        } as any,
        res(),
      ),
    ).rejects.toThrow(ForbiddenError);
  });

  it("acceptSpecialOffer rejects ordering from your own offer", async () => {
    db.specialOrderOffer.findUnique.mockResolvedValue({
      id: "o-1", vendorId: ME, requestId: "r-1", price: 500,
      request: { id: "r-1", customerId: ME, status: "OFFER_MADE", productId: "p-1", quantity: 2 },
    });
    await expect(
      acceptSpecialOffer(
        {
          user: { id: ME, role: "CUSTOMER", sessionId: "s" },
          params: { offerId: "o-1" },
          body: { addressId: "a-1" },
        } as any,
        res(),
      ),
    ).rejects.toThrow(ForbiddenError);
  });

  it("reviewProduct rejects your own product", async () => {
    db.productReview.findFirst.mockResolvedValue(null);
    db.product.findUnique.mockResolvedValue({ vendorId: ME });
    await expect(
      reviewProduct(
        {
          user: { id: ME, role: "CUSTOMER", sessionId: "s" },
          body: { productId: UUID, rating: 5 },
        } as any,
        res(),
      ),
    ).rejects.toThrow(ForbiddenError);
  });

  it("reviewVendor rejects your own store", async () => {
    db.vendorReview.findFirst.mockResolvedValue(null);
    await expect(
      reviewVendor(
        {
          user: { id: UUID2, role: "CUSTOMER", sessionId: "s" },
          params: { vendorId: UUID2 },
          body: { rating: 5 },
        } as any,
        res(),
      ),
    ).rejects.toThrow(ForbiddenError);
  });

  it("applyPromoService rejects your own vendor promotion", async () => {
    db.promotion.findFirst.mockResolvedValue({
      id: "promo-1", code: "OWN10", vendorId: ME, isActive: true,
      type: "PERCENTAGE", value: 10, scope: "VENDOR_WIDE", products: [],
    });
    const result = await applyPromoService({
      userId: ME,
      promoCode: "own10",
      vendorGroups: [{ vendorId: ME, subtotal: 1000, deliveryFee: 200 }],
    });
    expect(result.applied).toBe(false);
    expect(result.reason).toMatch(/own/i);
  });

  it("followVendor still rejects following yourself", async () => {
    await expect(
      followVendor(
        { user: { id: UUID, role: "CUSTOMER", sessionId: "s" }, body: { vendorId: UUID } } as any,
        res(),
      ),
    ).rejects.toThrow(ValidationError);
  });

  it("referral: a user cannot use their own referral code (already enforced)", async () => {
    db.user.findUnique.mockResolvedValue({ referredByUserId: null, referralCode: "MYCODE1" });
    await expect(
      applyReferralCode(
        { user: { id: "u-9", role: "CUSTOMER", sessionId: "s" }, body: { code: "mycode1" } } as any,
        res(),
      ),
    ).rejects.toThrow(ValidationError);
  });
});
