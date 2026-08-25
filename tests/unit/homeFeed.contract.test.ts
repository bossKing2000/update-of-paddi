import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const read = (...parts: string[]) =>
  fs.readFileSync(path.join(__dirname, "..", "..", ...parts), "utf8");

describe("home feed contract surface", () => {
  const server = read("src", "server.ts");
  const routerFile = read("src", "routes", "homeFeed.routes.ts");
  const controller = read("src", "controllers", "homeFeed.controller.ts");
  const service = read("src", "services", "homeFeed.service.ts");
  const auth = read("src", "middlewares", "auth.middleware.ts");
  const cacheTiming = read("src", "services", "redisCacheTiming.ts");

  it("mounts the feed under /api/home with a GET /feed route", () => {
    assert.match(server, /app\.use\("\/api\/home", homeFeedRoutes\)/);
    assert.match(routerFile, /router\.get\("\/feed", optionalAuth, getHomeFeedController\)/);
  });

  it("authenticates optionally — guests are never rejected at the door", () => {
    assert.match(auth, /export const optionalAuth/);
    const optionalBlock = auth
      .split("export const optionalAuth")[1]
      .split("export const requireRole")[0];
    assert.doesNotMatch(optionalBlock, /UnauthorizedError/);
    // viewer identity comes from the verified token only — never the query
    assert.doesNotMatch(controller, /req\.query\.userId/);
  });

  it("isolates section failures instead of failing the whole feed", () => {
    assert.match(service, /safeSection/);
    assert.match(service, /Promise\.all\(/);
    assert.match(service, /logger\.warn/);
    assert.doesNotMatch(service, /err\.stack/);
  });

  it("caches under an isolated short-TTL namespace using the central registry", () => {
    assert.match(cacheTiming, /HOME_FEED: \(/);
    assert.match(cacheTiming, /HOME_FEED: 90/);
    assert.match(service, /CACHE_KEYS\.HOME_FEED/);
    assert.match(service, /CACHE_TTLS\.HOME_FEED/);
  });

  it("reuses existing query logic rather than duplicating it", () => {
    assert.match(service, /fetchMostPopularProducts/);
    assert.match(service, /fetchLiveProducts/); // schedule-aware LIVE section
    assert.match(service, /fetchNewProducts/);
    assert.match(service, /fetchProductPage/);
    assert.match(service, /findNearbyVendors/);
    assert.match(service, /getActivePromotionsForCustomer/);

    // the original endpoints delegate to the same implementations
    const productController = read("src", "controllers", "productController.ts");
    assert.match(productController, /fetchProductPage\(/);
    assert.match(productController, /fetchMostPopularProducts\(/);
    // ...and the original p/most endpoint must NOT switch to the
    // schedule-aware listing — its contract stays stored-flag based
    assert.doesNotMatch(productController, /fetchLiveProducts/);
    const promoController = read("src", "controllers", "promoController.ts");
    assert.match(promoController, /getActivePromotionsForCustomer\(userId\)/);
  });

  it("keeps popularProducts on p/most semantics while liveProducts is schedule-aware", () => {
    // live section: window predicate (source of truth)
    const productService = read("src", "services", "product.service.ts");
    assert.match(productService, /export async function fetchLiveProducts/);
    assert.match(
      productService,
      /s\."takeDownAt" \+ \(COALESCE\(s\."graceMinutes", 0\) \* INTERVAL '1 minute'\) >= NOW\(\)/,
    );
    // feed cache key/TTL untouched by the robustness patch
    assert.match(cacheTiming, /HOME_FEED: 90/);
    assert.doesNotMatch(service, /home:feed:v2|home:live/);
  });

  it("keeps guest feeds free of authenticated-only data", () => {
    assert.match(service, /viewer!\.role === "CUSTOMER"/);
    assert.match(service, /isAuthenticated\s*\?\s*safeSection\(/);
    assert.match(service, /Promise\.resolve\(0\)/); // guest unread count
    assert.match(service, /Promise\.resolve\(\[\]\)/); // guest promotions/vendors
  });

  it("validates coordinates and clamps limits defensively", () => {
    assert.match(service, /HOME_FEED_MAX_LIMIT = 50/);
    assert.match(service, /lat >= -90/);
    assert.match(service, /lng >= -180/);
    assert.match(controller, /parseHomeFeedQuery/);
  });

  it("does not touch payment, checkout or redemption logic (Phase 3A scope)", () => {
    assert.doesNotMatch(service, /redeemPromo|applyPromoService|paystack|checkout/i);
  });

  it("Vendor Live migration: one authoritative availability definition is wired everywhere", () => {
    // schema: vendor-level flag exists and migration backfills vendors
    const prismaSchema = read("prisma", "schema.prisma");
    assert.match(prismaSchema, /isLive Boolean @default\(false\)/);
    const fs2 = require("node:fs");
    const path2 = require("node:path");
    const migrationsDir = path2.join(__dirname, "..", "..", "prisma", "migrations");
    const vendorMigration = fs2
      .readdirSync(migrationsDir)
      .filter((d: string) => d.includes("vendor_live"))
      .map((d: string) => fs2.readFileSync(path2.join(migrationsDir, d, "migration.sql"), "utf8"))
      .join("\n");
    assert.match(vendorMigration, /ADD COLUMN "isLive"/);
    assert.match(vendorMigration, /SET "isLive" = true WHERE "role" = 'VENDOR'/);

    // availability service exists and exposes the single rule
    const availability = read("src", "services", "vendorAvailability.service.ts");
    assert.match(availability, /export function isVendorOperating/);
    assert.match(availability, /export function isProductMarketplaceAvailable/);
    assert.match(availability, /export function assertVendorAvailableForOrdering/);

    // feed discovery surfaces are vendor-gated; plain browse is not forced to be
    assert.match(service, /vendorMustBeOperating: true/);
    const productService = read("src", "services", "product.service.ts");
    assert.match(productService, /VENDOR_OPERATING_SQL/);
    assert.match(productService, /v\."isLive" = true/);
    assert.match(productService, /acceptingOrders', 'true'\) <> 'false'/);
    const productController = read("src", "controllers", "productController.ts");
    assert.doesNotMatch(productController, /vendorMustBeOperating/); // GET /product unchanged

    // cart add + checkout + pricing preview all gate on the same service
    const cartController = read("src", "controllers", "cartController.ts");
    for (const fn of ["loadVendorOperatingState", "assertVendorAvailableForOrdering", "isProductCurrentlyAvailable", "isVendorOperating"]) {
      assert.match(cartController, new RegExp(fn));
    }
    const cartSummary = read("src", "services", "cartSummary.service.ts");
    assert.match(cartSummary, /isVendorOperating/);
    assert.match(cartSummary, /isProductCurrentlyAvailable/);

    // payment start/retry refuses offline vendors
    const paymentController = read("src", "controllers", "paymentController.ts");
    assert.match(paymentController, /assertVendorsStillOperating/);
    assert.equal((paymentController.match(/await assertVendorsStillOperating\(orders\);/g) || []).length, 2);

    // cleanup job treats vendor-offline like product-offline (unpaid only)
    const cleanupJob = read("src", "jobs", "workers jobs", "orderCleanupJob.ts");
    assert.match(cleanupJob, /VENDOR_WENT_OFFLINE_BEFORE_PAYMENT/);
    assert.match(cleanupJob, /vendorOffline/);

    // vendors control their own state via settings; going live requires KYC
    const settingsRoutes = read("src", "routes", "vendorSettings.routes.ts");
    assert.match(settingsRoutes, /router\.patch\("\/live", updateVendorLive\)/);
    const settingsController = read("src", "controllers", "vendorSettingsController.ts");
    assert.match(settingsController, /KYC verification is required before going live/);
    // toggle invalidates discovery caches via the shared helper
    assert.match(settingsController, /invalidateMarketplaceDiscoveryCaches/);
    const clearCaches = read("src", "services", "clearCaches.ts");
    assert.match(clearCaches, /home:feed:\*/);
    assert.match(clearCaches, /invalidateMarketplaceDiscoveryCaches/);
  });
});
