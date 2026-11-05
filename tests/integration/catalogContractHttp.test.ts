/**
 * Catalog contract hardening — real-HTTP integration coverage (B-1 … B-5, B-7).
 *
 * WHAT THIS FILE PROVES
 * ---------------------
 * Over REAL HTTP, against a REAL PostgreSQL database and a REAL Redis
 * instance:
 *
 *   B-1  The anonymous catalog responses do not expose the vendor's internal
 *        moderation state (`vendorStatus`, `vendorStatusReason`) or its
 *        internal delivery settings (`deliveryPreferences` ->
 *        `baseDeliveryFee`, `deliveryRadiusKm`, `preparationTimeMinutes`),
 *        while the approved public identity fields remain.
 *   B-2  GET /api/vendors/:vendorId is public, read-only, returns the
 *        documented profile, and 404s / 400s the way it should.
 *   B-3  A search result carries the canonical product-card fields, and the
 *        envelope + nested pagination shape are unchanged.
 *   B-4  Every catalog route rejects a malformed page/limit with HTTP 400
 *        and code VALIDATION_ERROR.
 *   B-5  A review write drops the cached copies of the product's rating.
 *   B-7  GET /api/auth/nearby answers a validation failure with the standard
 *        error envelope.
 *
 * EXTERNAL BOUNDARIES MOCKED (and only these)
 * --------------------------------------------
 *   1. The rate limiters — Redis-backed abuse budgets, not catalog
 *      behaviour. Every existing integration suite mocks them the same way.
 *   2. The `productIndex` BullMQ queue — it has NO worker anywhere in src/,
 *      so the enqueue is a no-op producer call.
 *   3. The Cloudinary-backed multer storage — Cloudinary is an external
 *      service and a disposable environment has no credentials for it. Only
 *      the storage backend changes.
 *
 * NOTHING the suite asserts on is mocked: no route, no controller, no
 * service, no Prisma call, no Redis behaviour.
 *
 * SAFETY
 * ------
 * Fails closed unless REDIS_URL names an authorized loopback target, exactly
 * like tests/integration/catalogHttp.test.ts. The PostgreSQL side is
 * validated by tests/setup/integrationPreflight.ts (identity + schema) and
 * pinned to the validated target by tests/setup/pinTestDatabaseUrl.apply.ts.
 *
 * Every row this file creates carries a run-unique identifier and is removed
 * in `afterAll`, in dependency-safe order, and ONLY for this file's own rows.
 * No shared or seeded row is deleted, and no broad cleanup (FLUSHDB /
 * truncate / reset) is used.
 */
import express from "express";
import request from "supertest";
import { randomUUID } from "crypto";
import bcrypt from "bcryptjs";
import type { Role } from "@prisma/client";

jest.mock("../../src/middlewares/rateLimiter.middleware", () => {
  const passthrough = (_req: unknown, _res: unknown, next: () => void) => next();
  return {
    authRateLimiter: passthrough,
    paymentRateLimiter: passthrough,
    checkoutRateLimiter: passthrough,
    otpRateLimiter: passthrough,
    phoneOtpRateLimiter: passthrough,
    passwordChangeRateLimiter: passthrough,
    secureResetRateLimiter: passthrough,
    cartSummaryRateLimiter: passthrough,
    aiRateLimiter: passthrough,
    emailOtpRateLimiter: passthrough,
  };
});

// The `productIndex` queue has no worker anywhere in src/, so these jobs are
// never processed. Mocked to keep the suite from writing BullMQ keys.
jest.mock("../../src/jobs/workers jobs/redis-baseQueue", () => ({
  __esModule: true,
  productIndexQueue: { add: jest.fn(async () => {}) },
}));

// Cloudinary-backed storage replaced with in-memory storage. Only the storage
// backend changes: real multipart parsing, real field names, and a `path` on
// every accepted file.
jest.mock("../../src/utils/multer", () => {
  const multer = require("multer");
  const memory = multer({ storage: multer.memoryStorage(), limits: { files: 9 } });
  const withPath = (handler: any) => (req: any, res: any, next: any) =>
    handler(req, res, (err: any) => {
      if (err) return next(err);
      const files = req.files as Record<string, any[]> | undefined;
      if (files) {
        for (const list of Object.values(files)) {
          for (const file of list as any[]) {
            if (!file.path) {
              file.path = `https://catalog-contract.test/${file.fieldname}/${file.originalname}`;
            }
          }
        }
      }
      next();
    });
  return {
    __esModule: true,
    upload: {
      fields: (names: any) => withPath(memory.fields(names)),
      array: (name: any, maxCount?: number) => withPath(memory.array(name, maxCount)),
      single: (name: any) => withPath(memory.single(name)),
      none: () => withPath(memory.none()),
    },
  };
});

import prisma from "../../src/lib/prisma";
import {
  connectRedis,
  redisNotifications,
  redisProducts,
  redisSearch,
  redisTotalViews,
  redisUsersSessions,
  ShopCartRedis,
} from "../../src/lib/redis";
import { createUserSession, deleteUserSession } from "../../src/lib/session";
import { generateAccessToken } from "../../src/utils/generateToken";
import productRoutes from "../../src/routes/productRoutes";
import vendorPublicRoutes from "../../src/routes/vendorPublic.routes";
import reviewRoutes from "../../src/routes/reviewRoutes";
import homeFeedRoutes from "../../src/routes/homeFeed.routes";
import authRoutes from "../../src/routes/auth.routes";
import { errorHandler, notFoundHandler } from "../../src/middlewares/error.middleware";
import { CACHE_KEYS } from "../../src/services/redisCacheTiming";

const REDIS_URL = process.env.REDIS_URL ?? "";
if (!/^redis:\/\/127\.0\.0\.1:\d+/.test(REDIS_URL)) {
  throw new Error(
    "[catalogContractHttp] BLOCKED: REDIS_URL must name the authorized disposable loopback target.",
  );
}

const app = express();
app.use(express.json());
app.use("/api/product", productRoutes);
app.use("/api/vendors", vendorPublicRoutes);
app.use("/api/review", reviewRoutes);
app.use("/api/home", homeFeedRoutes);
app.use("/api/auth", authRoutes);
// The real server mounts notFoundHandler before errorHandler
// (src/server.ts:360-363); the test app mirrors that so an unmatched route
// produces the same envelope it does in production.
app.use(notFoundHandler);
app.use(errorHandler);

// ---------------------------------------------------------------------------
// Run-unique identifiers and fixtures.
// ---------------------------------------------------------------------------
const RUN = randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase();

const CATEGORY_ID = `CATCONTRACT_CAT_${RUN}`;
const CATEGORY_SLUG = `catcontract-cat-${RUN.toLowerCase()}`;
const DISH_TYPE_ID = `CATCONTRACT_DT_${RUN}`;
const TAG_ID = `CATCONTRACT_TAG_${RUN}`;

const PASSWORD = "Str0ngPass!";
const createdUserIds: string[] = [];
const createdSessionIds: Array<{ userId: string; sessionId: string }> = [];
const createdProductIds: string[] = [];
const createdOrderIds: string[] = [];
const createdReviewIds: string[] = [];

let vendorId = "";
let customerId = "";
let productId = "";
let customerToken = "";

/** The internal delivery settings that must never reach a public response. */
const INTERNAL_DELIVERY_PREFERENCES = {
  acceptingOrders: true,
  deliveryEnabled: true,
  baseDeliveryFee: 750,
  deliveryRadiusKm: 18,
  preparationTimeMinutes: 45,
};

/** The vendor fields that must never appear in an anonymous response. */
const PROHIBITED_VENDOR_KEYS = [
  "vendorStatus",
  "vendorStatusReason",
  "vendorStatusChangedAt",
  "deliveryPreferences",
  "baseDeliveryFee",
  "deliveryRadiusKm",
  "preparationTimeMinutes",
  "kycStatus",
  "nin",
  "ninData",
  "isBlocked",
  "blockedReason",
  "email",
  "phoneNumber",
  "bankAccountNumber",
  "commissionRate",
  "isLive",
];

function assertNoProhibitedVendorKeys(vendor: unknown, label: string) {
  expect(vendor).toBeDefined();
  const record = vendor as Record<string, unknown>;
  for (const key of PROHIBITED_VENDOR_KEYS) {
    expect({ label, key, present: key in record }).toEqual({
      label,
      key,
      present: false,
    });
  }
  const serialised = JSON.stringify(vendor);
  expect(serialised).not.toContain("baseDeliveryFee");
  expect(serialised).not.toContain("deliveryRadiusKm");
  expect(serialised).not.toContain("preparationTimeMinutes");
}

async function makeUser(
  role: Role,
  label: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const user = await prisma.user.create({
    data: {
      name: `CatContract ${label} ${RUN}`,
      email: `catcontract-${label}-${RUN}-${randomUUID()}@catcontract.test`,
      password: bcrypt.hashSync(PASSWORD, 10),
      role,
      roles: [role],
      tokenVersion: 1,
      isEmailVerified: true,
      isBlocked: false,
      vendorStatus: role === "VENDOR" ? "ACTIVE" : null,
      isLive: role === "VENDOR",
      ...overrides,
    },
    select: { id: true },
  });
  createdUserIds.push(user.id);
  return user.id;
}

async function makeSession(userId: string, activeRole: Role): Promise<string> {
  const sessionId = randomUUID();
  await createUserSession(userId, sessionId, {
    activeRole,
    ip: "127.0.0.1",
    userAgent: "catalog-contract-integration",
  });
  createdSessionIds.push({ userId, sessionId });
  return generateAccessToken(userId, activeRole, sessionId, 1);
}

beforeAll(async () => {
  await connectRedis(redisUsersSessions, "UserSessions");
  await connectRedis(redisProducts, "Products");
  await connectRedis(redisSearch, "Search");
  await connectRedis(redisTotalViews, "TotalViews");
  await connectRedis(redisNotifications, "Notifications");
  await connectRedis(ShopCartRedis, "ShopCart");

  await prisma.category.create({
    data: {
      id: CATEGORY_ID,
      name: `CatContract Category ${RUN}`,
      slug: CATEGORY_SLUG,
      sortOrder: 30,
    },
  });
  await prisma.dishType.create({
    data: {
      id: DISH_TYPE_ID,
      name: `CatContract Dish ${RUN}`,
      categoryId: CATEGORY_ID,
    },
  });
  await prisma.tag.create({
    data: { id: TAG_ID, name: `CatContract Tag ${RUN}`, type: "CUISINE" },
  });

  // The active dish-type vocabulary is served from a 60-minute Redis cache,
  // so the fixture must not be hidden by a previous run's list.
  await redisProducts.del([
    CACHE_KEYS.CATEGORIES_ALL,
    CACHE_KEYS.TAGS_ALL,
    CACHE_KEYS.DISH_TYPES_ALL,
  ]);

  vendorId = await makeUser("VENDOR", "vendor", {
    brandName: `CatContract Kitchen ${RUN}`,
    brandLogo: `https://catcontract.test/logo-${RUN}.png`,
    avatarUrl: `https://catcontract.test/avatar-${RUN}.png`,
    bio: `CatContract bio ${RUN}`,
    deliveryPreferences: INTERNAL_DELIVERY_PREFERENCES,
  });

  customerId = await makeUser("CUSTOMER", "customer");
  customerToken = await makeSession(customerId, "CUSTOMER");

  const product = await prisma.product.create({
    data: {
      name: `CatContract Jollof ${RUN}`,
      description: "Catalog contract integration fixture.",
      price: 2500,
      dishTypeId: DISH_TYPE_ID,
      categoryId: CATEGORY_ID,
      vendorId,
      images: [`https://catcontract.test/jollof-${RUN}.png`],
      thumbnail: `https://catcontract.test/jollof-${RUN}.png`,
      video: [],
      archived: false,
      portionLabel: "Family Pack",
      trackInventory: true,
      stock: 5,
    },
  });
  productId = product.id;
  createdProductIds.push(productId);
});

afterAll(async () => {
  await prisma.productReview.deleteMany({
    where: { id: { in: createdReviewIds } },
  });
  await prisma.orderItem.deleteMany({ where: { orderId: { in: createdOrderIds } } });
  await prisma.order.deleteMany({ where: { id: { in: createdOrderIds } } });
  await prisma.product.deleteMany({ where: { id: { in: createdProductIds } } });
  await prisma.dishType.deleteMany({ where: { id: DISH_TYPE_ID } });
  await prisma.tag.deleteMany({ where: { id: TAG_ID } });
  await prisma.category.deleteMany({ where: { id: CATEGORY_ID } });

  for (const { userId, sessionId } of createdSessionIds) {
    await deleteUserSession(userId, sessionId).catch(() => undefined);
  }
  for (const userId of createdUserIds) {
    await prisma.userSession.deleteMany({ where: { userId } }).catch(() => undefined);
    await prisma.auditLog.deleteMany({ where: { userId } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: userId } }).catch(() => undefined);
  }

  await redisProducts.del([
    CACHE_KEYS.CATEGORIES_ALL,
    CACHE_KEYS.TAGS_ALL,
    CACHE_KEYS.DISH_TYPES_ALL,
  ]);
  await redisUsersSessions.quit().catch(() => undefined);
  await redisProducts.quit().catch(() => undefined);
  await redisSearch.quit().catch(() => undefined);
  await redisTotalViews.quit().catch(() => undefined);
  await redisNotifications.quit().catch(() => undefined);
  await ShopCartRedis.quit().catch(() => undefined);
});

describe("B-1 — public catalog responses do not expose internal vendor fields", () => {
  it("GET /api/product returns the public vendor projection only", async () => {
    const res = await request(app).get("/api/product");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);

    const ours = res.body.data.find((p: any) => p.id === productId);
    expect(ours).toBeDefined();
    assertNoProhibitedVendorKeys(ours.vendor, "GET /api/product");

    // The approved public identity fields remain available.
    expect(ours.vendor).toMatchObject({
      id: vendorId,
      name: `CatContract vendor ${RUN}`,
      brandName: `CatContract Kitchen ${RUN}`,
      brandLogo: `https://catcontract.test/logo-${RUN}.png`,
      avatarUrl: `https://catcontract.test/avatar-${RUN}.png`,
    });
    // The customer-safe operating state is exposed on the PRODUCT, not as a
    // raw vendor flag.
    expect(ours.vendorOperating).toBe(true);
    expect(ours.orderable).toBe(true);
  });

  it("GET /api/product/categories/:slug/products returns the public vendor projection only", async () => {
    const res = await request(app).get(
      `/api/product/categories/${CATEGORY_SLUG}/products`,
    );

    expect(res.status).toBe(200);
    const ours = res.body.data.find((p: any) => p.id === productId);
    expect(ours).toBeDefined();
    assertNoProhibitedVendorKeys(ours.vendor, "category browse");
  });

  it("GET /api/home/feed returns the public vendor projection only in its catalog section", async () => {
    const res = await request(app).get("/api/home/feed");

    expect(res.status).toBe(200);
    const items = res.body.data?.catalog?.items;
    expect(Array.isArray(items)).toBe(true);
    for (const item of items) {
      assertNoProhibitedVendorKeys(item.vendor, "home feed catalog");
    }
  });

  it("GET /api/product/:id returns the public vendor projection only", async () => {
    const res = await request(app).get(`/api/product/${productId}`);

    expect(res.status).toBe(200);
    assertNoProhibitedVendorKeys(res.body.data.vendor, "product detail");
    expect(res.body.data.vendor).toMatchObject({
      id: vendorId,
      brandName: `CatContract Kitchen ${RUN}`,
      brandLogo: `https://catcontract.test/logo-${RUN}.png`,
    });
    expect(res.body.data.vendorOperating).toBe(true);
    expect(res.body.data.orderable).toBe(true);
  });

  it("the product detail response never contains the internal settings anywhere", async () => {
    const res = await request(app).get(`/api/product/${productId}`);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain("baseDeliveryFee");
    expect(body).not.toContain("deliveryRadiusKm");
    expect(body).not.toContain("preparationTimeMinutes");
    expect(body).not.toContain("vendorStatus");
  });
});

describe("B-2 — public vendor profile", () => {
  it("GET /api/vendors/:vendorId returns the documented profile without authentication", async () => {
    const res = await request(app).get(`/api/vendors/${vendorId}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.vendor).toMatchObject({
      id: vendorId,
      name: `CatContract vendor ${RUN}`,
      brandName: `CatContract Kitchen ${RUN}`,
      brandLogo: `https://catcontract.test/logo-${RUN}.png`,
      avatarUrl: `https://catcontract.test/avatar-${RUN}.png`,
      bio: `CatContract bio ${RUN}`,
      isOpen: true,
      reviewCount: 0,
      followerCount: 0,
      productCount: 1,
    });
    assertNoProhibitedVendorKeys(res.body.data.vendor, "vendor profile");
  });

  it("rejects a malformed vendor id with 400 / VALIDATION_ERROR", async () => {
    const res = await request(app).get("/api/vendors/not-a-uuid");

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.code).toBe("VALIDATION_ERROR");
  });

  it("404s an unknown vendor", async () => {
    const res = await request(app).get(
      `/api/vendors/${randomUUID()}`,
    );

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.code).toBe("NOT_FOUND");
  });

  it("404s an account that is not a vendor", async () => {
    const res = await request(app).get(`/api/vendors/${customerId}`);

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("NOT_FOUND");
  });

  it("404s a suspended vendor", async () => {
    const suspendedId = await makeUser("VENDOR", "suspended", {
      vendorStatus: "SUSPENDED",
      isLive: false,
    });

    const res = await request(app).get(`/api/vendors/${suspendedId}`);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("NOT_FOUND");
  });

  it("404s a blocked vendor", async () => {
    const blockedId = await makeUser("VENDOR", "blocked", {
      isBlocked: true,
      vendorStatus: "SUSPENDED",
    });

    const res = await request(app).get(`/api/vendors/${blockedId}`);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("NOT_FOUND");
  });

  it("reports an offline vendor as discoverable but not open", async () => {
    const offlineId = await makeUser("VENDOR", "offline", {
      isLive: false,
      vendorStatus: "ACTIVE",
    });

    const res = await request(app).get(`/api/vendors/${offlineId}`);
    expect(res.status).toBe(200);
    expect(res.body.data.vendor.isOpen).toBe(false);
  });

  it("does not weaken the authenticated vendor dashboard", async () => {
    // The public router is mounted at /api/vendors; the dashboard lives at
    // /api/vendor and is a different, authenticated surface.
    const res = await request(app).get("/api/vendors");
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("ROUTE_NOT_FOUND");
  });
});

describe("B-3 — search results carry the canonical product-card shape", () => {
  it("returns the canonical card fields and the unchanged envelope", async () => {
    const res = await request(app).get(
      `/api/product/p/search?q=CatContract&page=1&limit=10`,
    );

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data.results)).toBe(true);

    const ours = res.body.data.results.find((p: any) => p.id === productId);
    expect(ours).toBeDefined();
    expect(ours).toMatchObject({
      id: productId,
      name: `CatContract Jollof ${RUN}`,
      price: 2500,
      dishType: { id: DISH_TYPE_ID, name: `CatContract Dish ${RUN}` },
      portionLabel: "Family Pack",
      trackInventory: true,
      stock: 5,
      soldOut: false,
      vendorOperating: true,
      orderable: true,
      averageRating: 0,
      reviewCount: 0,
    });
    expect(Array.isArray(ours.images)).toBe(true);
    expect(ours.images.length).toBeGreaterThan(0);
    expect(typeof ours.popularityPercent).toBe("number");

    // The vendor is the public projection.
    assertNoProhibitedVendorKeys(ours.vendor, "search result");
    expect(ours.vendor).toMatchObject({ id: vendorId });

    // The search-specific fields the endpoint always returned are preserved.
    expect(ours.description).toBe("Catalog contract integration fixture.");
    expect(ours.vendorId).toBe(vendorId);
    expect(ours.archived).toBe(false);
    expect(ours.dishTypeId).toBe(DISH_TYPE_ID);

    // The envelope and the nested pagination shape are unchanged.
    expect(res.body.data.pagination).toEqual(
      expect.objectContaining({
        total: expect.any(Number),
        page: 1,
        limit: 10,
        totalPages: expect.any(Number),
      }),
    );
    expect(typeof res.body.data.corrected).toBe("string");
  });

  it("paginates the search results", async () => {
    const page1 = await request(app).get(
      `/api/product/p/search?q=CatContract&page=1&limit=1`,
    );
    expect(page1.status).toBe(200);
    expect(page1.body.data.pagination.page).toBe(1);
    expect(page1.body.data.pagination.limit).toBe(1);
    expect(page1.body.data.results.length).toBeLessThanOrEqual(1);
  });
});

describe("B-4 — pagination validation on every catalog route", () => {
  const routes = [
    "/api/product",
    `/api/product/categories/${CATEGORY_SLUG}/products`,
    "/api/product/p/search?q=CatContract",
    "/api/product/p/most",
    "/api/product/p/new",
  ];

  it.each(routes)("%s rejects page=abc with 400 / VALIDATION_ERROR", async (route) => {
    const res = await request(app).get(`${route}${route.includes("?") ? "&" : "?"}page=abc`);
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.code).toBe("VALIDATION_ERROR");
  });

  it.each(routes)("%s rejects page=0 with 400 / VALIDATION_ERROR", async (route) => {
    const res = await request(app).get(`${route}${route.includes("?") ? "&" : "?"}page=0`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
  });

  it.each(routes)("%s rejects limit=-1 with 400 / VALIDATION_ERROR", async (route) => {
    const res = await request(app).get(`${route}${route.includes("?") ? "&" : "?"}limit=-1`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
  });

  it.each(routes)("%s rejects limit=abc with 400 / VALIDATION_ERROR", async (route) => {
    const res = await request(app).get(`${route}${route.includes("?") ? "&" : "?"}limit=abc`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
  });

  it("clamps a limit above the maximum instead of rejecting it", async () => {
    const browse = await request(app).get("/api/product?limit=500");
    expect(browse.status).toBe(200);
    expect(browse.body.meta.limit).toBe(20);

    const most = await request(app).get("/api/product/p/most?limit=500");
    expect(most.status).toBe(200);
    expect(most.body.meta.limit).toBe(50);

    const fresh = await request(app).get("/api/product/p/new?limit=500");
    expect(fresh.status).toBe(200);
    expect(fresh.body.meta.limit).toBe(50);
  });

  it("keeps the documented defaults", async () => {
    const browse = await request(app).get("/api/product");
    expect(browse.status).toBe(200);
    expect(browse.body.meta).toMatchObject({ page: 1, limit: 20 });

    const most = await request(app).get("/api/product/p/most");
    expect(most.body.meta).toMatchObject({ page: 1, limit: 50 });
  });
});

describe("GET /api/product/dish-types", () => {
  it("returns the active dish-type vocabulary", async () => {
    const res = await request(app).get("/api/product/dish-types");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data.dishTypes)).toBe(true);
    const ours = res.body.data.dishTypes.find((d: any) => d.id === DISH_TYPE_ID);
    expect(ours).toBeDefined();
    expect(ours.name).toBe(`CatContract Dish ${RUN}`);
  });
});

describe("B-5 — a review write invalidates the cached rating", () => {
  it("drops the cached rating copies and serves the new rating", async () => {
    // Warm the caches: the detail entry and a browse page.
    const detail = await request(app).get(`/api/product/${productId}`);
    expect(detail.status).toBe(200);
    expect(detail.body.data.averageRating).toBe(0);

    await request(app).get("/api/product");
    const detailKey = CACHE_KEYS.PRODUCT_DETAIL(productId);
    expect(await redisProducts.get(detailKey)).not.toBeNull();

    // A completed order is required before a customer may review.
    const order = await prisma.order.create({
      data: {
        customerId,
        vendorId,
        basePrice: 2500,
        totalPrice: 2500,
        status: "COMPLETED",
        items: {
          create: {
            productId,
            productName: `CatContract Jollof ${RUN}`,
            quantity: 1,
            unitPrice: 2500,
            subtotal: 2500,
          },
        },
      },
      select: { id: true },
    });
    createdOrderIds.push(order.id);

    const created = await request(app)
      .post(`/api/review/${productId}/reviews`)
      .set("Authorization", `Bearer ${customerToken}`)
      .send({ productId, rating: 5, comment: "CatContract review" });

    expect(created.status).toBe(201);
    const reviewId = created.body.data.review.id as string;
    createdReviewIds.push(reviewId);

    // The cached copies of the rating are gone.
    expect(await redisProducts.get(detailKey)).toBeNull();

    // The stored stats were recomputed.
    const stored = await prisma.product.findUnique({ where: { id: productId } });
    expect(stored?.averageRating).toBe(5);
    expect(stored?.reviewCount).toBe(1);

    // The detail response now shows the new rating.
    const after = await request(app).get(`/api/product/${productId}`);
    expect(after.body.data.averageRating).toBe(5);
    expect(after.body.data.reviewCount).toBe(1);
  });
});

describe("B-7 — the nearby endpoint uses the standard error envelope", () => {
  it("answers a missing coordinate with 400 / VALIDATION_ERROR", async () => {
    const res = await request(app).get("/api/auth/nearby");

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.code).toBe("VALIDATION_ERROR");
    expect(typeof res.body.message).toBe("string");
    expect(res.body.message.length).toBeGreaterThan(0);
    expect(res.body).not.toHaveProperty("error");
  });

  it("answers a non-numeric coordinate with 400 / VALIDATION_ERROR", async () => {
    const res = await request(app).get("/api/auth/nearby?lat=abc&lng=3.4");

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
  });

  it("keeps the success envelope for a valid request", async () => {
    const res = await request(app).get("/api/auth/nearby?lat=6.5&lng=3.4");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
  });
});
