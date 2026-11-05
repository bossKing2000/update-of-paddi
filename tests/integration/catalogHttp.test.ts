/**
 * Phase 2 — catalog browse and vendor product management over REAL HTTP.
 *
 * WHAT THIS FILE IS
 * -----------------
 * The Phase 2 catalog surfaces (2A–2D) had unit coverage only: every
 * assertion about categories, tags, category-scoped browsing, search, and the
 * vendor product lifecycle ran against a MOCKED Prisma and a MOCKED Redis. This
 * suite closes that gap by mounting the REAL routers and driving them with
 * supertest, so the real Express app, the real auth middleware, the real
 * controllers/services, a REAL PostgreSQL database and a REAL Redis instance
 * are all exercised end to end.
 *
 * Covered
 *   - GET  /api/product/categories                 (status, shape, count semantics)
 *   - GET  /api/product/categories/:slug/products  (scoping, filters, sort, pagination, validation)
 *   - GET  /api/product/tags                       (status, shape, cache behaviour)
 *   - GET  /api/product/p/search                   (the registered search route, verified in source)
 *   - POST   /api/product                          (vendor create, incl. option groups + tags)
 *   - PATCH  /api/product/:id                      (vendor update)
 *   - PATCH  /api/product/:id/archive              (vendor archive)
 *   - POST   /api/vendor/suggestions               (vendor dish-type suggestion)
 *   - PATCH  /api/admin/suggestions/:id/approve    (admin approval -> canonical DishType)
 *   - PATCH  /api/admin/suggestions/:id/reject     (admin rejection)
 *
 * The route paths above are the ones actually registered in source
 * (src/routes/productRoutes.ts:38-71, src/routes/vendorDashboard.routes.ts:46-51,
 * src/routes/admin.routes.ts:105-108, mounted in src/server.ts:205/219/224).
 * The search route is `/api/product/p/search` — the router path is `/p/search`
 * under the `/api/product` mount. Nothing here is guessed.
 *
 * EXTERNAL BOUNDARIES MOCKED (and only these)
 * --------------------------------------------
 * 1. The rate limiters (src/middlewares/rateLimiter.middleware). They are
 *    Redis-backed abuse budgets, not catalog behaviour, and every existing
 *    integration suite in this repository mocks them the same way.
 * 2. The `productIndex` BullMQ queue (src/jobs/workers jobs/redis-baseQueue).
 *    It has NO worker anywhere in src/ (verified), so the enqueue is a no-op
 *    producer call; mocking it keeps the suite from writing queue keys. The
 *    request path is unaffected: the enqueue is already `.catch()`-guarded.
 * 3. The Cloudinary-backed multer storage (src/utils/multer). Cloudinary is an
 *    external service and a disposable environment has no credentials for it.
 *    The mock replaces ONLY the storage backend: the real multipart parser
 *    still runs, and each accepted file still gets the `path` field that the
 *    controller reads (extractImagePaths -> file.path). Product create REQUIRES
 *    1-6 images, so this boundary is unavoidable for the create path.
 *
 * NOTHING that the suite asserts on is mocked: no route, no controller, no
 * service, no Prisma call, no Redis behaviour.
 *
 * SAFETY
 * ------
 * Fails closed unless REDIS_URL names an authorized loopback target, exactly
 * like tests/integration/restrictDeleteRaceHttp.test.ts and
 * tests/integration/vendorLifecycleHttp.test.ts. The PostgreSQL side is
 * validated by tests/setup/integrationPreflight.ts (identity + schema) and
 * pinned to the validated target by tests/setup/pinTestDatabaseUrl.apply.ts.
 *
 * Every row this file creates is created with a run-unique identifier and
 * removed in `afterAll`, in dependency-safe order, and ONLY for this file's
 * own rows. No shared or seeded row is deleted, and no broad cleanup
 * (FLUSHDB / truncate / reset) is used.
 *
 * SCOPE LIMITS (deliberately NOT asserted, because they are open product
 * decisions or are owned by later phases):
 *   - there is no scheduled-status filter, and none is added here;
 *   - there is no literal GET /api/product/dish-types/:id/products route — the
 *     browse endpoint filters by dish type instead;
 *   - the search index is not asserted to be index-backed for category,
 *     dish-type or tag matching;
 *   - the legacy ProductOption / options[] compatibility surface is left
 *     untouched (the create path still refuses legacy add-on writes).
 */
import express from "express";
import request from "supertest";
import { randomUUID } from "crypto";
import bcrypt from "bcryptjs";
import type { Role, VendorStatus } from "@prisma/client";

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
// every accepted file (the field the controller reads).
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
              file.path = `https://catalog-http.test/${file.fieldname}/${file.originalname}`;
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
import vendorDashboardRoutes from "../../src/routes/vendorDashboard.routes";
import adminRoutes from "../../src/routes/admin.routes";
import { errorHandler } from "../../src/middlewares/error.middleware";
import { CACHE_KEYS } from "../../src/services/redisCacheTiming";
import { findProhibitedPublicVendorKeys } from "../../src/services/publicVendor.service";
import { productDetailCacheKeys } from "../../src/services/clearCaches";

const REDIS_URL = process.env.REDIS_URL ?? "";
if (!/^redis:\/\/127\.0\.0\.1:\d+/.test(REDIS_URL)) {
  throw new Error(
    "[catalogHttp] BLOCKED: REDIS_URL must name the authorized disposable loopback target.",
  );
}

const app = express();
app.use(express.json());
app.use("/api/product", productRoutes);
app.use("/api/vendor", vendorDashboardRoutes);
app.use("/api/admin", adminRoutes);
app.use(errorHandler);

// ---------------------------------------------------------------------------
// Run-unique identifiers. Every id/name/email below carries RUN so two
// concurrent runs can never collide, and cleanup can never match a row that
// belongs to another run or to seeded data.
// ---------------------------------------------------------------------------
const RUN = randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase();

const CATEGORY_ID = `CATALOG_TEST_CAT_${RUN}`;
const CATEGORY_NAME = `Catalog Test Category ${RUN}`;
const CATEGORY_SLUG = `catalog-test-cat-${RUN.toLowerCase()}`;

const EMPTY_CATEGORY_ID = `CATALOG_TEST_EMPTY_CAT_${RUN}`;
const EMPTY_CATEGORY_NAME = `Catalog Test Empty Category ${RUN}`;
const EMPTY_CATEGORY_SLUG = `catalog-test-empty-cat-${RUN.toLowerCase()}`;

const DISH_TYPE_ID = `CATALOG_TEST_DT_${RUN}`;
const DISH_TYPE_NAME = `Catalog Test Dish ${RUN}`;

const TAG_ID = `CATALOG_TEST_TAG_${RUN}`;
const TAG_NAME = `Catalog Test Tag ${RUN}`;

/** A 1x1 PNG — the smallest valid image the multipart parser will accept. */
const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const PASSWORD = "Str0ngPass!";
const createdUserIds: string[] = [];
const createdSessionIds: Array<{ userId: string; sessionId: string }> = [];
const createdProductIds: string[] = [];
const createdSuggestionIds: string[] = [];
const createdDishTypeIds: string[] = [];

let vendorId = "";
let otherVendorId = "";
let adminId = "";
let vendorToken = "";
let otherVendorToken = "";
let adminToken = "";

// Browse fixtures (created directly, so the browse assertions never depend on
// the vendor-write endpoints passing first).
const BROWSE_ACTIVE_PRODUCT_ID = `catalog-browse-active-${RUN}`;
const BROWSE_ARCHIVED_PRODUCT_ID = `catalog-browse-archived-${RUN}`;
const BROWSE_PRICE = 1500;

/**
 * Vendor-lifecycle state for a fixture user.
 *
 * The default fixture is an ACTIVE, live vendor. A SUSPENDED vendor is a
 * different account state (src/services/vendorStatus.service.ts), so it is
 * requested AT CREATION rather than by mutating the row afterwards: the
 * suspended-vendor regression reads the vendor row through the same
 * availability and projection paths a real suspended account would.
 */
interface VendorStateOverrides {
  vendorStatus?: VendorStatus;
  isLive?: boolean;
}

async function makeUser(
  role: Role,
  label: string,
  vendorState?: VendorStateOverrides,
): Promise<string> {
  const user = await prisma.user.create({
    data: {
      name: `Catalog Http ${label} ${RUN}`,
      email: `catalog-http-${label}-${RUN}-${randomUUID()}@catalog-http.test`,
      password: bcrypt.hashSync(PASSWORD, 10),
      role,
      roles: [role],
      tokenVersion: 1,
      isEmailVerified: true,
      isBlocked: false,
      vendorStatus: role === "VENDOR" ? "ACTIVE" : null,
      isLive: role === "VENDOR",
      // Explicit state overrides win over the defaults above.
      ...(vendorState ?? {}),
    },
    select: { id: true },
  });
  createdUserIds.push(user.id);
  return user.id;
}

/** Real DB session row + real Redis session document + a real access token. */
async function makeSession(userId: string, activeRole: Role): Promise<string> {
  const sessionId = randomUUID();
  await createUserSession(userId, sessionId, {
    activeRole,
    ip: "127.0.0.1",
    userAgent: "catalog-http-integration",
  });
  createdSessionIds.push({ userId, sessionId });
  return generateAccessToken(userId, activeRole, sessionId, 1);
}

function authed(
  method: "get" | "post" | "patch",
  path: string,
  token: string,
): request.Test {
  return request(app)[method](path).set("Authorization", `Bearer ${token}`);
}

/**
 * Drops the taxonomy caches so a read reflects the database rather than a
 * previously cached page.
 *
 * `categories:all` and `tags:all` are TTL-only by design
 * (src/services/redisCacheTiming.ts:28-31) and are NOT swept by a product
 * mutation, so without this the count assertion would depend on cache state.
 *
 * `dishtypes:all` MUST be dropped too, and this is a harness requirement
 * rather than a convenience: `assertActiveDishType` validates against
 * `getActiveDishTypes()` (src/services/product.service.ts:295-324), which
 * serves a 60-minute Redis cache of the active vocabulary. A DishType
 * inserted directly into the database is therefore invisible to the
 * validator until that key expires — the admin API path invalidates it, a
 * direct insert does not.
 */
async function resetTaxonomyCaches(): Promise<void> {
  await redisProducts.del([
    CACHE_KEYS.CATEGORIES_ALL,
    CACHE_KEYS.TAGS_ALL,
    CACHE_KEYS.DISH_TYPES_ALL,
  ]);
}

beforeAll(async () => {
  await connectRedis(redisUsersSessions, "UserSessions");
  await connectRedis(redisProducts, "Products");
  await connectRedis(redisSearch, "Search");
  await connectRedis(redisTotalViews, "TotalViews");
  await connectRedis(redisNotifications, "Notifications");
  await connectRedis(ShopCartRedis, "ShopCart");

  // Taxonomy fixtures: one populated category, one empty category (used to
  // prove category scoping), one active dish type, one active tag.
  await prisma.category.create({
    data: { id: CATEGORY_ID, name: CATEGORY_NAME, slug: CATEGORY_SLUG, sortOrder: 10 },
  });
  await prisma.category.create({
    data: {
      id: EMPTY_CATEGORY_ID,
      name: EMPTY_CATEGORY_NAME,
      slug: EMPTY_CATEGORY_SLUG,
      sortOrder: 20,
    },
  });
  await prisma.dishType.create({
    data: { id: DISH_TYPE_ID, name: DISH_TYPE_NAME, categoryId: CATEGORY_ID },
  });
  await prisma.tag.create({
    data: { id: TAG_ID, name: TAG_NAME, type: "CUISINE" },
  });

  // The vocabulary caches must not carry a previous run's list: the active
  // dish-type list is what `assertActiveDishType` validates against, and the
  // category/tag lists are what the browse endpoints serve.
  await resetTaxonomyCaches();

  // Two browse products in the populated category: one live, one archived.
  await prisma.product.create({
    data: {
      id: BROWSE_ACTIVE_PRODUCT_ID,
      name: `Catalog Zobo Active ${RUN}`,
      description: "Live browse fixture for the catalog HTTP integration suite.",
      price: BROWSE_PRICE,
      dishTypeId: DISH_TYPE_ID,
      categoryId: CATEGORY_ID,
      vendorId: (await makeUser("VENDOR", "fixture")),
      images: ["https://catalog-http.test/fixture/active.png"],
      video: [],
      archived: false,
    },
  });
  createdProductIds.push(BROWSE_ACTIVE_PRODUCT_ID);
  await prisma.product.create({
    data: {
      id: BROWSE_ARCHIVED_PRODUCT_ID,
      name: `Catalog Zobo Archived ${RUN}`,
      description: "Archived browse fixture for the catalog HTTP integration suite.",
      price: BROWSE_PRICE + 250,
      dishTypeId: DISH_TYPE_ID,
      categoryId: CATEGORY_ID,
      vendorId: (await makeUser("VENDOR", "archivedfixture")),
      images: ["https://catalog-http.test/fixture/archived.png"],
      video: [],
      archived: true,
    },
  });
  createdProductIds.push(BROWSE_ARCHIVED_PRODUCT_ID);

  vendorId = await makeUser("VENDOR", "vendor");
  otherVendorId = await makeUser("VENDOR", "othervendor");
  adminId = await makeUser("ADMIN", "admin");

  vendorToken = await makeSession(vendorId, "VENDOR");
  otherVendorToken = await makeSession(otherVendorId, "VENDOR");
  adminToken = await makeSession(adminId, "ADMIN");
});

afterAll(async () => {
  // Dependency-safe order, this file's rows only.
  await prisma.product.deleteMany({ where: { id: { in: createdProductIds } } });
  await prisma.categorySuggestion.deleteMany({
    where: { id: { in: createdSuggestionIds } },
  });
  await prisma.dishType.deleteMany({ where: { id: { in: createdDishTypeIds } } });
  await prisma.dishType.deleteMany({ where: { id: DISH_TYPE_ID } });
  await prisma.tag.deleteMany({ where: { id: TAG_ID } });
  await prisma.category.deleteMany({
    where: { id: { in: [CATEGORY_ID, EMPTY_CATEGORY_ID] } },
  });

  for (const { userId, sessionId } of createdSessionIds) {
    await deleteUserSession(userId, sessionId).catch(() => undefined);
  }
  for (const userId of createdUserIds) {
    await prisma.userSession.deleteMany({ where: { userId } }).catch(() => undefined);
    await prisma.auditLog.deleteMany({ where: { userId } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: userId } }).catch(() => undefined);
  }

  await resetTaxonomyCaches();
  await redisUsersSessions.quit().catch(() => undefined);
  await redisProducts.quit().catch(() => undefined);
  await redisSearch.quit().catch(() => undefined);
  await redisTotalViews.quit().catch(() => undefined);
  await redisNotifications.quit().catch(() => undefined);
  await ShopCartRedis.quit().catch(() => undefined);
});

describe("Phase 2 — public catalog browse over real HTTP", () => {
  it("GET /api/product/categories returns the active taxonomy with per-category product counts", async () => {
    await resetTaxonomyCaches();

    const res = await request(app).get("/api/product/categories");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data.categories)).toBe(true);

    const mine = res.body.data.categories.find(
      (c: { id: string }) => c.id === CATEGORY_ID,
    );
    expect(mine).toBeDefined();
    expect(mine.name).toBe(CATEGORY_NAME);
    expect(mine.slug).toBe(CATEGORY_SLUG);

    // Count semantic: products with archived = false are counted, archived
    // ones are not. The fixture category holds exactly one live product.
    expect(mine.productCount).toBe(1);

    // Scoping: the sum of the per-category counts equals the number of
    // non-archived products in the database, so no product is counted twice
    // and none is counted in the wrong category.
    const liveProducts = await prisma.product.count({ where: { archived: false } });
    const summed = res.body.data.categories.reduce(
      (acc: number, c: { productCount: number }) => acc + c.productCount,
      0,
    );
    expect(summed).toBe(liveProducts);

    // The empty category is present with a zero count.
    const empty = res.body.data.categories.find(
      (c: { id: string }) => c.id === EMPTY_CATEGORY_ID,
    );
    expect(empty).toBeDefined();
    expect(empty.productCount).toBe(0);
  });

  it("GET /api/product/categories caches the taxonomy response (MISS then HIT)", async () => {
    await resetTaxonomyCaches();

    const first = await request(app).get("/api/product/categories");
    const second = await request(app).get("/api/product/categories");

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.headers["x-cache"]).toBe("MISS");
    expect(second.headers["x-cache"]).toBe("HIT");
    expect(second.body.data.categories).toEqual(first.body.data.categories);
  });

  it("GET /api/product/categories/:slug/products returns only that category's live products", async () => {
    const res = await request(app).get(`/api/product/categories/${CATEGORY_SLUG}/products`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);

    const ids = res.body.data.map((p: { id: string }) => p.id);
    expect(ids).toContain(BROWSE_ACTIVE_PRODUCT_ID);
    // The archived product is not browseable.
    expect(ids).not.toContain(BROWSE_ARCHIVED_PRODUCT_ID);

    // Pagination meta is the standard envelope's `meta` object.
    expect(res.body.meta).toEqual(
      expect.objectContaining({
        page: 1,
        limit: expect.any(Number),
        total: expect.any(Number),
        totalPages: expect.any(Number),
      }),
    );
  });

  it("GET /api/product/categories/:slug/products is scoped to the requested category", async () => {
    const res = await request(app).get(
      `/api/product/categories/${EMPTY_CATEGORY_SLUG}/products`,
    );

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.meta.total).toBe(0);
  });

  it("GET /api/product/categories/:slug/products 404s an unknown slug", async () => {
    const res = await request(app).get(
      `/api/product/categories/no-such-category-${RUN.toLowerCase()}/products`,
    );

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.code).toBe("NOT_FOUND");
  });

  it("GET /api/product/categories/:slug/products applies the price and tag filters", async () => {
    const tooExpensive = await request(app).get(
      `/api/product/categories/${CATEGORY_SLUG}/products?minPrice=${BROWSE_PRICE + 1}`,
    );
    expect(tooExpensive.status).toBe(200);
    expect(tooExpensive.body.data).toEqual([]);

    const tooCheap = await request(app).get(
      `/api/product/categories/${CATEGORY_SLUG}/products?maxPrice=${BROWSE_PRICE - 1}`,
    );
    expect(tooCheap.status).toBe(200);
    expect(tooCheap.body.data).toEqual([]);

    const inRange = await request(app).get(
      `/api/product/categories/${CATEGORY_SLUG}/products?minPrice=${BROWSE_PRICE}&maxPrice=${BROWSE_PRICE}`,
    );
    expect(inRange.status).toBe(200);
    expect(inRange.body.data.map((p: { id: string }) => p.id)).toEqual([
      BROWSE_ACTIVE_PRODUCT_ID,
    ]);

    const byTag = await request(app).get(
      `/api/product/categories/${CATEGORY_SLUG}/products?tags=${TAG_ID}`,
    );
    expect(byTag.status).toBe(200);
    // The fixture product carries no tag, so the tag filter excludes it.
    expect(byTag.body.data).toEqual([]);
  });

  it("GET /api/product/categories/:slug/products rejects an invalid sortBy and an inverted price range", async () => {
    const badSort = await request(app).get(
      `/api/product/categories/${CATEGORY_SLUG}/products?sortBy=bogus`,
    );
    expect(badSort.status).toBe(400);
    expect(badSort.body.success).toBe(false);
    expect(badSort.body.code).toBe("VALIDATION_ERROR");

    const inverted = await request(app).get(
      `/api/product/categories/${CATEGORY_SLUG}/products?minPrice=900&maxPrice=100`,
    );
    expect(inverted.status).toBe(400);
    expect(inverted.body.code).toBe("VALIDATION_ERROR");
  });

  it("GET /api/product/categories/:slug/products paginates and clamps the page size", async () => {
    const page1 = await request(app).get(
      `/api/product/categories/${CATEGORY_SLUG}/products?page=1&limit=1`,
    );
    expect(page1.status).toBe(200);
    expect(page1.body.meta.page).toBe(1);
    expect(page1.body.meta.limit).toBe(1);
    expect(page1.body.data).toHaveLength(1);

    const page2 = await request(app).get(
      `/api/product/categories/${CATEGORY_SLUG}/products?page=2&limit=1`,
    );
    expect(page2.status).toBe(200);
    expect(page2.body.meta.page).toBe(2);
    // Page 2 of a one-live-product category is empty: the archived product is
    // filtered out, so the category holds exactly one browseable product.
    expect(page2.body.data).toEqual([]);

    const clamped = await request(app).get(
      `/api/product/categories/${CATEGORY_SLUG}/products?limit=500`,
    );
    expect(clamped.status).toBe(200);
    expect(clamped.body.meta.limit).toBe(20);
  });

  it("GET /api/product/tags returns the active tag vocabulary", async () => {
    await resetTaxonomyCaches();

    const res = await request(app).get("/api/product/tags");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data.tags)).toBe(true);

    const mine = res.body.data.tags.find((t: { id: string }) => t.id === TAG_ID);
    expect(mine).toBeDefined();
    expect(mine.name).toBe(TAG_NAME);
    expect(mine.type).toBe("CUISINE");
  });

  it("GET /api/product/tags caches the tag list (MISS then HIT)", async () => {
    await resetTaxonomyCaches();

    const first = await request(app).get("/api/product/tags");
    const second = await request(app).get("/api/product/tags");

    expect(first.headers["x-cache"]).toBe("MISS");
    expect(second.headers["x-cache"]).toBe("HIT");
  });

  it("GET /api/product/p/search finds the live product and hides the archived one", async () => {
    const res = await request(app).get("/api/product/p/search?q=Zobo");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data.results)).toBe(true);

    const ids = res.body.data.results.map((p: { id: string }) => p.id);
    expect(ids).toContain(BROWSE_ACTIVE_PRODUCT_ID);
    expect(ids).not.toContain(BROWSE_ARCHIVED_PRODUCT_ID);
  });

  it("GET /api/product/p/search rejects a missing query and a malformed page", async () => {
    const missing = await request(app).get("/api/product/p/search");
    expect(missing.status).toBe(400);
    expect(missing.body.code).toBe("VALIDATION_ERROR");

    const badPage = await request(app).get("/api/product/p/search?q=Zobo&page=abc");
    expect(badPage.status).toBe(400);
    expect(badPage.body.code).toBe("VALIDATION_ERROR");
  });
});

describe("Phase 2 — vendor product management over real HTTP", () => {
  const productPayload = () => ({
    name: `Catalog Zobo Vendor Bowl ${RUN}`,
    description: "Vendor lifecycle fixture for the catalog HTTP integration suite.",
    price: "2400",
    dishTypeId: DISH_TYPE_ID,
  });

  it("POST /api/product creates a product with an option group and a tag", async () => {
    const res = await authed("post", "/api/product", vendorToken)
      .field("name", productPayload().name)
      .field("description", productPayload().description)
      .field("price", productPayload().price)
      .field("dishTypeId", productPayload().dishTypeId)
      .field(
        "optionGroups",
        JSON.stringify([
          {
            name: "Extras",
            required: false,
            minSelections: 0,
            maxSelections: 1,
            items: [{ name: "Extra Chilli", priceAdd: 150 }],
          },
        ]),
      )
      .field("tagIds", JSON.stringify([TAG_ID]))
      .attach("images", PNG_1x1, {
        filename: `catalog-${RUN}.png`,
        contentType: "image/png",
      });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.product.name).toBe(productPayload().name);
    expect(res.body.data.product.price).toBe(2400);
    expect(res.body.data.product.images).toHaveLength(1);

    const productId = res.body.data.product.id as string;
    createdProductIds.push(productId);

    const stored = await prisma.product.findUnique({
      where: { id: productId },
      include: { optionGroups: { include: { items: true } }, tags: true },
    });
    expect(stored).not.toBeNull();
    expect(stored?.vendorId).toBe(vendorId);
    // categoryId is server-derived from the dish type, never client-supplied.
    expect(stored?.categoryId).toBe(CATEGORY_ID);
    expect(stored?.dishTypeId).toBe(DISH_TYPE_ID);
    expect(stored?.optionGroups).toHaveLength(1);
    expect(stored?.optionGroups[0].items).toHaveLength(1);
    expect(stored?.tags.map((t) => t.tagId)).toEqual([TAG_ID]);
  });

  it("POST /api/product refuses a create without an image", async () => {
    const res = await authed("post", "/api/product", vendorToken)
      .field("name", `Catalog Zobo No Image ${RUN}`)
      .field("description", "Create without an image is refused by the controller.")
      .field("price", "1000")
      .field("dishTypeId", DISH_TYPE_ID);

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toMatch(/between 1 and 6 images/i);
  });

  it("POST /api/product refuses an unknown tag id", async () => {
    const res = await authed("post", "/api/product", vendorToken)
      .field("name", `Catalog Zobo Bad Tag ${RUN}`)
      .field("description", "Create with an unknown tag id is refused.")
      .field("price", "1000")
      .field("dishTypeId", DISH_TYPE_ID)
      .field("tagIds", JSON.stringify([`NO_SUCH_TAG_${RUN}`]))
      .attach("images", PNG_1x1, {
        filename: `catalog-bad-tag-${RUN}.png`,
        contentType: "image/png",
      });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toMatch(/invalid tag/i);
  });

  it("POST /api/product refuses a non-vendor caller", async () => {
    const res = await authed("post", "/api/product", adminToken)
      .field("name", `Catalog Zobo Admin Attempt ${RUN}`)
      .field("description", "Admins are not vendors and cannot create products.")
      .field("price", "1000")
      .field("dishTypeId", DISH_TYPE_ID)
      .attach("images", PNG_1x1, {
        filename: `catalog-admin-${RUN}.png`,
        contentType: "image/png",
      });

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
  });

  it("PATCH /api/product/:id updates the caller's own product", async () => {
    const created = await authed("post", "/api/product", vendorToken)
      .field("name", `Catalog Zobo To Update ${RUN}`)
      .field("description", "Product created for the update assertion.")
      .field("price", "1000")
      .field("dishTypeId", DISH_TYPE_ID)
      .attach("images", PNG_1x1, {
        filename: `catalog-update-${RUN}.png`,
        contentType: "image/png",
      });
    expect(created.status).toBe(201);
    const productId = created.body.data.product.id as string;
    createdProductIds.push(productId);

    const updated = await authed("patch", `/api/product/${productId}`, vendorToken)
      .field("name", `Catalog Zobo Updated ${RUN}`)
      .field("price", "1800");

    expect(updated.status).toBe(200);
    expect(updated.body.success).toBe(true);
    // The update endpoint returns the product fields at the top level of
    // `data` (create nests them under `data.product`). Recorded as observed.
    expect(updated.body.data.name).toBe(`Catalog Zobo Updated ${RUN}`);
    expect(updated.body.data.price).toBe(1800);

    const stored = await prisma.product.findUnique({ where: { id: productId } });
    expect(stored?.name).toBe(`Catalog Zobo Updated ${RUN}`);
    expect(stored?.price).toBe(1800);
    // An update that sends no image field keeps the existing images.
    expect(stored?.images).toHaveLength(1);
  });

  it("PATCH /api/product/:id does not pre-warm a partial detail cache (HIGH-1)", async () => {
    const created = await authed("post", "/api/product", vendorToken)
      .field("name", `Catalog Zobo Cache ${RUN}`)
      .field("description", "Product created for the detail-cache regression.")
      .field("price", "2100")
      .field("dishTypeId", DISH_TYPE_ID)
      .field(
        "optionGroups",
        JSON.stringify([
          {
            name: "Cache Extras",
            required: false,
            minSelections: 0,
            maxSelections: 1,
            items: [
              { name: "Active Add-on", priceAdd: 200, isActive: true },
              { name: "Disabled Add-on", priceAdd: 300, isActive: false },
            ],
          },
        ]),
      )
      .attach("images", PNG_1x1, {
        filename: `catalog-cache-${RUN}.png`,
        contentType: "image/png",
      });
    expect(created.status).toBe(201);
    const productId = created.body.data.product.id as string;
    createdProductIds.push(productId);

    // Legacy `options[]` compatibility fixture. The update endpoint may not
    // edit these rows, but the detail read must still serve the active-only
    // projection.
    await prisma.productOption.createMany({
      data: [
        { productId, name: `Active Legacy ${RUN}`, price: 100, isActive: true },
        { productId, name: `Disabled Legacy ${RUN}`, price: 200, isActive: false },
      ],
    });

    // Warm the detail cache through the authoritative read path, so the update
    // starts from the same complete entry the defect used to replace.
    const before = await request(app).get(`/api/product/${productId}`);
    expect(before.status).toBe(200);
    expect(before.headers["x-cache"]).toBe("MISS");
    expect(before.body.data.vendor).toMatchObject({
      id: vendorId,
      name: `Catalog Http vendor ${RUN}`,
    });
    expect(before.body.data.vendorOperating).toBe(true);
    expect(before.body.data.orderable).toBe(true);

    const updated = await authed("patch", `/api/product/${productId}`, vendorToken)
      .field("name", `Catalog Zobo Cache Updated ${RUN}`)
      .field("price", "2300");
    expect(updated.status).toBe(200);

    // The write path must not leave ANY product-detail alias behind.
    // `productDetailCacheKeys` returns every alias the writers use, so the
    // update must drop all of them — not just the canonical `product:*:detail`
    // key. Before HIGH-1 these keys existed immediately after the update,
    // carrying no vendor relation and no `__vendorAvailability` snapshot.
    const detailAliases = productDetailCacheKeys(productId);
    for (const alias of detailAliases) {
      expect(await redisProducts.get(alias)).toBeNull();
    }

    // The next read goes through the complete MISS path and must produce a
    // real vendor identity plus authoritative availability.
    const after = await request(app).get(`/api/product/${productId}`);
    expect(after.status).toBe(200);
    expect(after.headers["x-cache"]).toBe("MISS");
    expect(after.body.data.name).toBe(`Catalog Zobo Cache Updated ${RUN}`);
    expect(after.body.data.vendor).toEqual({
      id: vendorId,
      name: `Catalog Http vendor ${RUN}`,
      brandName: null,
      brandLogo: null,
      avatarUrl: null,
    });
    expect(after.body.data.vendorOperating).toBe(true);
    expect(after.body.data.orderable).toBe(true);
    expect(findProhibitedPublicVendorKeys(after.body.data.vendor)).toEqual([]);
    expect(JSON.stringify(after.body)).not.toContain("__vendorAvailability");

    // Legacy `options[]` and structured groups survive the update, with
    // inactive entries hidden by the same rules the MISS path always applied.
    expect(after.body.data.options).toEqual([
      expect.objectContaining({ name: `Active Legacy ${RUN}`, price: 100 }),
    ]);
    expect(after.body.data.options[0]).not.toHaveProperty("isActive");
    const group = after.body.data.optionGroups.find(
      (g: { name: string }) => g.name === "Cache Extras",
    );
    expect(group.items.map((i: { name: string }) => i.name)).toEqual([
      "Active Add-on",
    ]);

    // A second read must serve the same complete payload from the cache.
    const hit = await request(app).get(`/api/product/${productId}`);
    expect(hit.status).toBe(200);
    expect(hit.headers["x-cache"]).toBe("HIT");
    expect(hit.body.data.vendor).toEqual(after.body.data.vendor);
    expect(hit.body.data.vendorOperating).toBe(true);
    expect(hit.body.data.orderable).toBe(true);
    expect(hit.body.data.options).toEqual(after.body.data.options);
    expect(hit.body.data.optionGroups).toEqual(after.body.data.optionGroups);
    expect(JSON.stringify(hit.body)).not.toContain("__vendorAvailability");

    // The raw HIT cache entry carries the internal availability snapshot so
    // the reader can recompute `vendorOperating` / `orderable` on a cache hit,
    // but that snapshot is cache-private state and must never appear in the
    // public HTTP response.
    const rawHit = await redisProducts.get(CACHE_KEYS.PRODUCT_DETAIL(productId));
    expect(rawHit).not.toBeNull();
    const parsedHit = JSON.parse(rawHit!);
    expect(parsedHit.__vendorAvailability).toEqual({
      isLive: true,
      vendorStatus: "ACTIVE",
      acceptingOrders: true,
    });
    expect(JSON.stringify(parsedHit.__vendorAvailability)).toBeDefined();
    expect(JSON.stringify(hit.body)).not.toContain("__vendorAvailability");
  });

  it("a suspended vendor's product stays fail-closed on read after an admin update (HIGH-1)", async () => {
    // A suspended vendor is a distinct fixture with its own user, product and
    // session — no shared state with the ACTIVE-vendor test above.
    const suspendedVendorId = await makeUser("VENDOR", "suspendedVendor", {
      vendorStatus: "SUSPENDED",
      isLive: false,
    });
    const suspendedVendorToken = await makeSession(
      suspendedVendorId,
      "VENDOR",
    );

    // The product fixture is created DIRECTLY, exactly like the browse
    // fixtures above, because `requireVendorNotSuspended`
    // (src/routes/productRoutes.ts:52-53) refuses a SUSPENDED vendor's
    // product writes with 403: the vendor write path is not available to this
    // fixture at all. That refusal is asserted below rather than assumed, and
    // the update that exercises the cache invalidation is performed by the
    // admin — the actor the suspension policy allows to write this product.
    const suspendedProductId = `catalog-suspended-${RUN}`;
    await prisma.product.create({
      data: {
        id: suspendedProductId,
        name: `Catalog Zobo Suspended ${RUN}`,
        description: "Suspended-vendor cache regression fixture.",
        price: 1500,
        dishTypeId: DISH_TYPE_ID,
        categoryId: CATEGORY_ID,
        vendorId: suspendedVendorId,
        images: ["https://catalog-http.test/suspended/suspended.png"],
        video: [],
        archived: false,
      },
    });
    createdProductIds.push(suspendedProductId);

    // The suspended vendor's own writes are refused with 403. This is the
    // documented policy, asserted rather than assumed: a SUSPENDED vendor
    // cannot create or update products.
    const refusedCreate = await authed("post", "/api/product", suspendedVendorToken)
      .field("name", `Catalog Zobo Suspended Write ${RUN}`)
      .field("description", "Suspended-vendor write attempt.")
      .field("price", "1500")
      .field("dishTypeId", DISH_TYPE_ID)
      .attach("images", PNG_1x1, {
        filename: `catalog-suspended-write-${RUN}.png`,
        contentType: "image/png",
      });
    expect(refusedCreate.status).toBe(403);

    const refusedUpdate = await authed("patch", `/api/product/${suspendedProductId}`, suspendedVendorToken)
      .field("name", `Catalog Zobo Suspended Update ${RUN}`);
    expect(refusedUpdate.status).toBe(403);

    // A refused write must leave the product exactly as it was.
    const untouched = await prisma.product.findUnique({
      where: { id: suspendedProductId },
    });
    expect(untouched?.name).toBe(`Catalog Zobo Suspended ${RUN}`);

    // Warm the cache through the authoritative read path. The suspended
    // vendor must read as closed and un-orderable, and only through the public
    // projection.
    const before = await request(app).get(`/api/product/${suspendedProductId}`);
    expect(before.status).toBe(200);
    expect(before.headers["x-cache"]).toBe("MISS");
    expect(before.body.data.vendorOperating).toBe(false);
    expect(before.body.data.orderable).toBe(false);
    expect(before.body.data.vendor).toEqual({
      id: suspendedVendorId,
      name: `Catalog Http suspendedVendor ${RUN}`,
      brandName: null,
      brandLogo: null,
      avatarUrl: null,
    });
    expect(findProhibitedPublicVendorKeys(before.body.data.vendor)).toEqual([]);
    expect(JSON.stringify(before.body)).not.toContain("__vendorAvailability");

    // The detail entry is now cached, so the invalidation assertions below
    // have something real to remove.
    const detailAliases = productDetailCacheKeys(suspendedProductId);
    expect(await redisProducts.get(CACHE_KEYS.PRODUCT_DETAIL(suspendedProductId))).not.toBeNull();

    // The update is performed by the admin, the actor allowed to write this
    // product. HIGH-1: the write path must leave NO product-detail alias
    // behind — not just the canonical `product:*:detail` key — and must not
    // pre-warm a partial entry.
    const updated = await authed("patch", `/api/admin/products/${suspendedProductId}`, adminToken)
      .send({ name: `Catalog Zobo Suspended Updated ${RUN}` });
    expect(updated.status).toBe(200);

    for (const alias of detailAliases) {
      expect(await redisProducts.get(alias)).toBeNull();
    }

    // The next read goes through the complete MISS path: it must recompute
    // the availability from the live vendor row and stay fail-closed.
    const after = await request(app).get(`/api/product/${suspendedProductId}`);
    expect(after.status).toBe(200);
    expect(after.headers["x-cache"]).toBe("MISS");
    expect(after.body.data.name).toBe(`Catalog Zobo Suspended Updated ${RUN}`);
    expect(after.body.data.vendorOperating).toBe(false);
    expect(after.body.data.orderable).toBe(false);
    expect(after.body.data.vendor).toEqual({
      id: suspendedVendorId,
      name: `Catalog Http suspendedVendor ${RUN}`,
      brandName: null,
      brandLogo: null,
      avatarUrl: null,
    });
    expect(findProhibitedPublicVendorKeys(after.body.data.vendor)).toEqual([]);
    expect(JSON.stringify(after.body)).not.toContain("__vendorAvailability");

    // A second read serves the same complete fail-closed payload from cache.
    const hit = await request(app).get(`/api/product/${suspendedProductId}`);
    expect(hit.status).toBe(200);
    expect(hit.headers["x-cache"]).toBe("HIT");
    expect(hit.body.data.vendorOperating).toBe(false);
    expect(hit.body.data.orderable).toBe(false);

    // The cache-private snapshot records the suspended state so that a HIT can
    // recompute the availability. It is cache-internal state and must never
    // reach the public response.
    const rawHit = await redisProducts.get(CACHE_KEYS.PRODUCT_DETAIL(suspendedProductId));
    expect(rawHit).not.toBeNull();
    expect(JSON.parse(rawHit!).__vendorAvailability).toEqual({
      isLive: false,
      vendorStatus: "SUSPENDED",
      acceptingOrders: true,
    });
    expect(JSON.stringify(hit.body)).not.toContain("__vendorAvailability");
  });

  it("PATCH /api/product/:id refuses another vendor's product", async () => {
    const created = await authed("post", "/api/product", vendorToken)
      .field("name", `Catalog Zobo Protected ${RUN}`)
      .field("description", "Product created for the ownership assertion.")
      .field("price", "1000")
      .field("dishTypeId", DISH_TYPE_ID)
      .attach("images", PNG_1x1, {
        filename: `catalog-protected-${RUN}.png`,
        contentType: "image/png",
      });
    expect(created.status).toBe(201);
    const productId = created.body.data.product.id as string;
    createdProductIds.push(productId);

    const res = await authed("patch", `/api/product/${productId}`, otherVendorToken)
      .field("name", `Hijacked ${RUN}`)
      .field("price", "1");

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);

    const stored = await prisma.product.findUnique({ where: { id: productId } });
    expect(stored?.name).toBe(`Catalog Zobo Protected ${RUN}`);
    expect(stored?.price).toBe(1000);
  });

  it("PATCH /api/product/:id/archive archives the product", async () => {
    const created = await authed("post", "/api/product", vendorToken)
      .field("name", `Catalog Zobo To Archive ${RUN}`)
      .field("description", "Product created for the archive assertion.")
      .field("price", "1000")
      .field("dishTypeId", DISH_TYPE_ID)
      .attach("images", PNG_1x1, {
        filename: `catalog-archive-${RUN}.png`,
        contentType: "image/png",
      });
    expect(created.status).toBe(201);
    const productId = created.body.data.product.id as string;
    createdProductIds.push(productId);

    const res = await authed("patch", `/api/product/${productId}/archive`, vendorToken).send({
      archived: true,
    });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const stored = await prisma.product.findUnique({ where: { id: productId } });
    expect(stored?.archived).toBe(true);
  });
});

describe("Phase 2 — dish-type suggestion workflow over real HTTP", () => {
  const suggestionName = `Catalog Suggested Dish ${RUN}`;

  it("POST /api/vendor/suggestions records a pending suggestion", async () => {
    const res = await authed("post", "/api/vendor/suggestions", vendorToken).send({
      suggestedName: suggestionName,
      suggestedCategoryId: CATEGORY_ID,
    });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.suggestion.status).toBe("PENDING");

    const suggestionId = res.body.data.suggestion.id as string;
    createdSuggestionIds.push(suggestionId);

    const stored = await prisma.categorySuggestion.findUnique({
      where: { id: suggestionId },
    });
    expect(stored?.vendorId).toBe(vendorId);
    expect(stored?.suggestedName).toBe(suggestionName);
    expect(stored?.status).toBe("PENDING");
  });

  it("POST /api/vendor/suggestions refuses a duplicate pending suggestion", async () => {
    // Self-contained: this test creates its OWN pending suggestion first, so
    // it never depends on another test having run before it.
    const duplicateName = `Catalog Suggested Duplicate ${RUN}`;
    const first = await authed("post", "/api/vendor/suggestions", vendorToken).send({
      suggestedName: duplicateName,
      suggestedCategoryId: CATEGORY_ID,
    });
    expect(first.status).toBe(201);
    createdSuggestionIds.push(first.body.data.suggestion.id as string);

    const res = await authed("post", "/api/vendor/suggestions", vendorToken).send({
      suggestedName: duplicateName,
      suggestedCategoryId: CATEGORY_ID,
    });

    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
    expect(res.body.code).toBe("CONFLICT");
  });

  it("POST /api/vendor/suggestions refuses an unknown category", async () => {
    const res = await authed("post", "/api/vendor/suggestions", vendorToken).send({
      suggestedName: `Catalog Suggested Unknown ${RUN}`,
      suggestedCategoryId: `NO_SUCH_CATEGORY_${RUN}`,
    });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toMatch(/category/i);
  });

  it("PATCH /api/admin/suggestions/:id/approve creates the canonical dish type", async () => {
    // A distinct name per test: the endpoint refuses a second PENDING
    // suggestion for the same vendor/name/category (409), so reusing a name
    // would make this test depend on another test's leftovers.
    const approveName = `Catalog Suggested Approved ${RUN}`;
    const created = await authed("post", "/api/vendor/suggestions", vendorToken).send({
      suggestedName: approveName,
      suggestedCategoryId: CATEGORY_ID,
    });
    expect(created.status).toBe(201);
    const suggestionId = created.body.data.suggestion.id as string;
    createdSuggestionIds.push(suggestionId);

    const res = await authed(
      "patch",
      `/api/admin/suggestions/${suggestionId}/approve`,
      adminToken,
    ).send({ adminNote: "Approved by the catalog integration suite." });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.suggestion.status).toBe("APPROVED");
    expect(res.body.data.dishType.name).toBe(approveName);

    const approvedDishTypeId = res.body.data.dishType.id as string;
    createdDishTypeIds.push(approvedDishTypeId);

    const stored = await prisma.categorySuggestion.findUnique({
      where: { id: suggestionId },
    });
    expect(stored?.status).toBe("APPROVED");
    expect(stored?.approvedDishTypeId).toBe(approvedDishTypeId);
    expect(stored?.reviewedByAdminId).toBe(adminId);
    expect(stored?.adminNote).toBe("Approved by the catalog integration suite.");

    const dishType = await prisma.dishType.findUnique({
      where: { id: approvedDishTypeId },
    });
    expect(dishType?.name).toBe(approveName);
    expect(dishType?.categoryId).toBe(CATEGORY_ID);
    expect(dishType?.isActive).toBe(true);
  });

  it("PATCH /api/admin/suggestions/:id/reject keeps the suggestion without creating a dish type", async () => {
    const rejectName = `Catalog Suggested Rejected ${RUN}`;
    const created = await authed("post", "/api/vendor/suggestions", vendorToken).send({
      suggestedName: rejectName,
      suggestedCategoryId: CATEGORY_ID,
    });
    expect(created.status).toBe(201);
    const suggestionId = created.body.data.suggestion.id as string;
    createdSuggestionIds.push(suggestionId);

    const res = await authed(
      "patch",
      `/api/admin/suggestions/${suggestionId}/reject`,
      adminToken,
    ).send({ adminNote: "Rejected by the catalog integration suite." });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const stored = await prisma.categorySuggestion.findUnique({
      where: { id: suggestionId },
    });
    expect(stored?.status).toBe("REJECTED");
    expect(stored?.approvedDishTypeId).toBeNull();
    expect(stored?.adminNote).toBe("Rejected by the catalog integration suite.");

    const dishType = await prisma.dishType.findFirst({ where: { name: rejectName } });
    expect(dishType).toBeNull();
  });

  it("PATCH /api/admin/suggestions/:id/approve refuses a non-admin caller", async () => {
    const created = await authed("post", "/api/vendor/suggestions", vendorToken).send({
      suggestedName: `Catalog Suggested Unauthorised ${RUN}`,
      suggestedCategoryId: CATEGORY_ID,
    });
    expect(created.status).toBe(201);
    const suggestionId = created.body.data.suggestion.id as string;
    createdSuggestionIds.push(suggestionId);

    const res = await authed(
      "patch",
      `/api/admin/suggestions/${suggestionId}/approve`,
      vendorToken,
    ).send({ adminNote: "A vendor may not approve." });

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);

    const stored = await prisma.categorySuggestion.findUnique({
      where: { id: suggestionId },
    });
    expect(stored?.status).toBe("PENDING");
  });
});

describe("Phase 2 — a vendor suspension invalidates that vendor's cached product detail", () => {
  /**
   * A product-detail cache entry carries a CACHE-PRIVATE availability snapshot
   * (`__vendorAvailability`), and `getProductById` recomputes
   * `vendorOperating` / `orderable` from that snapshot on a cache HIT
   * (src/controllers/productController.ts:605-619, 651-669). The snapshot is
   * captured when the entry is written, so an entry written while the vendor
   * was ACTIVE keeps reporting the vendor as operating after the account is
   * suspended — unless the status change invalidates it.
   *
   * This exercises the ADMINISTRATIVE suspension path
   * (`PATCH /api/admin/vendors/:id/status`) against a real cache, and reads
   * the product detail again WITHOUT deleting the cache entry by hand.
   */
  it("stops presenting a suspended vendor's cached product as orderable", async () => {
    // The vendor under suspension: ACTIVE and live, so the product is
    // orderable and the detail cache is populated with an ACTIVE snapshot.
    const vendorId = await makeUser("VENDOR", "suspensioncache", {
      vendorStatus: "ACTIVE",
      isLive: true,
    });
    const vendorToken = await makeSession(vendorId, "VENDOR");

    // An unrelated vendor, to prove the invalidation is BOUNDED: this
    // vendor's cached detail entry must survive the other vendor's
    // suspension untouched.
    const otherVendorId = await makeUser("VENDOR", "suspensionbystander", {
      vendorStatus: "ACTIVE",
      isLive: true,
    });
    const bystanderProductId = `catalog-suspension-bystander-${RUN}`;
    await prisma.product.create({
      data: {
        id: bystanderProductId,
        name: `Catalog Zobo Bystander ${RUN}`,
        description: "Unrelated vendor product, used to prove the invalidation is bounded.",
        price: 1600,
        dishTypeId: DISH_TYPE_ID,
        categoryId: CATEGORY_ID,
        vendorId: otherVendorId,
        images: ["https://catalog-http.test/suspension/bystander.png"],
        video: [],
        archived: false,
      },
    });
    createdProductIds.push(bystanderProductId);

    const productId = `catalog-suspension-${RUN}`;
    await prisma.product.create({
      data: {
        id: productId,
        name: `Catalog Zobo Suspension ${RUN}`,
        description: "Vendor-suspension cache regression fixture.",
        price: 1500,
        dishTypeId: DISH_TYPE_ID,
        categoryId: CATEGORY_ID,
        vendorId,
        images: ["https://catalog-http.test/suspension/active.png"],
        video: [],
        archived: false,
      },
    });
    createdProductIds.push(productId);

    // Warm both detail caches through the authoritative read path.
    const warm = await request(app).get(`/api/product/${productId}`);
    expect(warm.status).toBe(200);
    expect(warm.headers["x-cache"]).toBe("MISS");
    expect(warm.body.data.vendorOperating).toBe(true);
    expect(warm.body.data.orderable).toBe(true);

    const warmBystander = await request(app).get(`/api/product/${bystanderProductId}`);
    expect(warmBystander.status).toBe(200);
    expect(warmBystander.headers["x-cache"]).toBe("MISS");
    expect(warmBystander.body.data.orderable).toBe(true);

    // Both entries are now cached with an ACTIVE availability snapshot.
    expect(await redisProducts.get(CACHE_KEYS.PRODUCT_DETAIL(productId))).not.toBeNull();
    expect(
      await redisProducts.get(CACHE_KEYS.PRODUCT_DETAIL(bystanderProductId)),
    ).not.toBeNull();

    // The administrative suspension — the supported endpoint, no direct row
    // write, no manual cache deletion.
    const suspended = await authed(
      "patch",
      `/api/admin/vendors/${vendorId}/status`,
      adminToken,
    ).send({ status: "SUSPENDED", reason: "Suspension cache regression fixture." });
    expect(suspended.status).toBe(200);
    expect(suspended.body.data.vendorStatus).toBe("SUSPENDED");

    // The suspended vendor's own product write is still refused: the
    // suspension rules remain enforced.
    const refusedWrite = await authed("patch", `/api/product/${productId}`, vendorToken).field(
      "name",
      `Catalog Zobo Suspension Write ${RUN}`,
    );
    expect(refusedWrite.status).toBe(403);

    // Read the product detail again WITHOUT deleting its cache entry. The
    // response must no longer present the product as orderable, and it must
    // not be served from the pre-suspension entry.
    const after = await request(app).get(`/api/product/${productId}`);
    expect(after.status).toBe(200);
    expect(after.body.data.vendorOperating).toBe(false);
    expect(after.body.data.orderable).toBe(false);
    expect(after.headers["x-cache"]).toBe("MISS");
    expect(after.body.data.vendor).toEqual({
      id: vendorId,
      name: `Catalog Http suspensioncache ${RUN}`,
      brandName: null,
      brandLogo: null,
      avatarUrl: null,
    });
    expect(findProhibitedPublicVendorKeys(after.body.data.vendor)).toEqual([]);
    expect(JSON.stringify(after.body)).not.toContain("__vendorAvailability");

    // The recomputed entry carries the SUSPENDED state, so the read is
    // authoritative rather than a recycled pre-suspension snapshot.
    const raw = await redisProducts.get(CACHE_KEYS.PRODUCT_DETAIL(productId));
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!).__vendorAvailability).toEqual({
      isLive: false,
      vendorStatus: "SUSPENDED",
      acceptingOrders: true,
    });

    // The invalidation is BOUNDED: the unrelated vendor's cached detail entry
    // is untouched and still reports its own vendor as operating.
    const bystanderRaw = await redisProducts.get(CACHE_KEYS.PRODUCT_DETAIL(bystanderProductId));
    expect(bystanderRaw).not.toBeNull();
    const bystanderAfter = await request(app).get(`/api/product/${bystanderProductId}`);
    expect(bystanderAfter.status).toBe(200);
    expect(bystanderAfter.headers["x-cache"]).toBe("HIT");
    expect(bystanderAfter.body.data.vendorOperating).toBe(true);
    expect(bystanderAfter.body.data.orderable).toBe(true);
  });
});
