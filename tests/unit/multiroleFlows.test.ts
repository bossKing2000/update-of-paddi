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
    user: { findUnique: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn() },
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
  getUserSession: jest.fn(async () => null),
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
    db.user.findUnique.mockResolvedValue({ ...customer });
    db.user.update.mockImplementation(async (args: any) => ({
      id: "cust-1",
      role: "CUSTOMER",
      roles: ["CUSTOMER", "VENDOR"],
    }));

    const r = res();
    await becomeVendor(
      { ...authed("cust-1", "CUSTOMER"), body: { brandName: "Dual Foods", phoneNumber: "08012345678" } } as any,
      r,
    );

    expect(r.status).toHaveBeenCalledWith(200);
    const updateArgs = db.user.update.mock.calls[0][0];
    expect(updateArgs.data.roles).toEqual(["CUSTOMER", "VENDOR"]);
    expect(updateArgs.data.role).toBeUndefined(); // active role untouched
    expect(updateArgs.data.brandName).toBe("Dual Foods");
    expect(r.json).toHaveBeenCalledWith(
      expect.objectContaining({ role: "CUSTOMER", roles: ["CUSTOMER", "VENDOR"] }),
    );
  });

  it("rejects accounts that already hold VENDOR", async () => {
    db.user.findUnique.mockResolvedValue({ ...customer, roles: ["CUSTOMER", "VENDOR"] });
    const r = res();
    await becomeVendor(
      { ...authed("cust-1", "CUSTOMER"), body: { brandName: "X Foods" } } as any,
      r,
    );
    expect(r.status).toHaveBeenCalledWith(400);
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it("rejects ADMIN / DELIVERY / non-CUSTOMER / unverified / blocked", async () => {
    const cases = [
      { ...customer, id: "a", roles: ["ADMIN"], role: "ADMIN" },
      { ...customer, id: "d", roles: ["DELIVERY"], role: "DELIVERY" },
      { ...customer, id: "n", roles: [], role: null },
      { ...customer, id: "u", isEmailVerified: false },
      { ...customer, id: "b", isBlocked: true },
    ];
    for (const u of cases) {
      db.user.findUnique.mockResolvedValue(u);
      const r = res();
      await becomeVendor(
        { user: { id: u.id, role: u.role, sessionId: "s" }, body: { brandName: "X Foods" } } as any,
        r,
      );
      expect(r.status).not.toHaveBeenCalledWith(200);
    }
    expect(db.user.update).not.toHaveBeenCalled();
  });
});

describe("switch-role", () => {
  const dual = {
    id: "dual-1",
    role: "CUSTOMER",
    roles: ["CUSTOMER", "VENDOR"],
    isBlocked: false,
  };

  it("switches CUSTOMER -> VENDOR and mints an access token with the new active role", async () => {
    db.user.findUnique.mockResolvedValue({ ...dual });
    db.user.update.mockImplementation(async (args: any) => ({
      id: "dual-1",
      role: args.data.role,
      roles: ["CUSTOMER", "VENDOR"],
    }));

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
    db.user.update.mockImplementation(async (args: any) => ({
      id: "dual-1",
      role: args.data.role,
      roles: ["CUSTOMER", "VENDOR"],
    }));

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
          isLive: true,
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
