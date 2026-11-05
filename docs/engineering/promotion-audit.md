# Foodi Paddi – Stage 1: Existing Promotion System Audit Report

**Repository:** `/home/onyeka-ifeanyi/StudioProjects/update-of-paddi-main-backend` (backend)  
**Flutter Frontend:** `/home/onyeka-ifeanyi/StudioProjects/frontend-page`  
**Audit Date:** 2026-10-31  
**Reference Document:** `promotion.md` (Development Plan)  
**Audit Type:** Strictly read-only investigation

---

## 1. Executive Summary

The Foodi Paddi backend has a **mature, production-grade promotion system** for **Personal Buy (automatic and code-gated promotions)** with robust vendor-scoped and platform-wide capabilities. The system correctly uses integer kobo for all financial calculations, enforces vendor ownership at the backend, and integrates with cart/checkout via a canonical promotion resolver.

**Group Buy functionality does not exist** — no backend models, no API endpoints, no Flutter screens, and no business logic for customer-created groups, group membership, or group-based discounts.

**Key Findings:**
- ✅ Promotion data model is well-structured for current Personal Buy use cases
- ✅ Admin and vendor promotion creation with proper scope validation
- ✅ Canonical promotion resolver (`promotionPricing.service.ts`) ensures consistent pricing across all surfaces
- ✅ Cart/checkout integration with single-best-discount rule (auto OR code, never both)
- ✅ Row-level locking on promotion usage during checkout prevents race conditions
- ❌ **No Group Buy infrastructure whatsoever** — this is entirely net-new functionality
- ⚠️ `Promotion.value` is a polymorphic `Float` (percentage 0–100 or fixed naira) converted at calculation boundary — works but requires careful handling
- ⚠️ Automatic (codeless) promotions bypass per-user caps at claim time (deliberate design)
- ⚠️ Product-specific promotion conflict check excludes vendor-wide promotions (interim rule)

---

## 2. Existing Promotion Data Model

### 2.1 Prisma `Promotion` Model (backend/prisma/schema.prisma:1011–1063)

```prisma
model Promotion {
  id          String  @id @default(uuid())
  code        String? // null = automatic; non-null = code-gated
  vendorId    String? // null = platform-wide
  vendor      User?   @relation("VendorPromotions", fields: [vendorId], references: [id], onDelete: Cascade)

  name        String
  description String?

  type        DiscountType        // PERCENTAGE | FIXED | DELIVERY
  value       Float               // POLYMORPHIC: percentage (0-100) OR fixed naira
  maxDiscount Int?                // cap for PERCENTAGE, stored as integer kobo

  scope       PromotionScope @default(VENDOR_WIDE) // SINGLE_PRODUCT | SELECTED_PRODUCTS | VENDOR_WIDE

  isActive    Boolean   @default(true)
  startsAt    DateTime?
  expiresAt   DateTime?

  usageLimit      Int? // global redemptions
  usedCount       Int  @default(0)
  maxUsesPerUser  Int  @default(1)
  minOrderAmount  Int  @default(0) // integer kobo

  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  usages   PromotionUsage[]
  products Product[]  @relation("PromotionProducts")

  @@unique([vendorId, code])
  @@index([code])
  @@index([isActive])
  @@index([expiresAt])
}
```

### 2.2 Related Models

| Model | Purpose | Key Fields |
|-------|---------|------------|
| `PromotionUsage` (1065–1082) | Redemption tracking | `promotionId`, `userId`, `orderIds[]`, `promoCode`, `discount` (int kobo) |
| `Product` → `promotions` (334) | M-N relation | Via implicit `_PromotionProducts` table |

### 2.3 Enums (schema.prisma:955–965)

```prisma
enum DiscountType { PERCENTAGE, FIXED, DELIVERY }
enum PromotionScope { SINGLE_PRODUCT, SELECTED_PRODUCTS, VENDOR_WIDE }
```

### 2.4 `Promotion.value` Analysis — Polymorphic Float

**Location:** `schema.prisma:1025–1031`, `promotionPricing.service.ts:115–119`

```typescript
// promotionPricing.service.ts:115-119
const valueKobo = type === DiscountType.PERCENTAGE ? value : Math.round(value * 100);
```

| DiscountType | `value` Interpretation | Conversion |
|--------------|------------------------|------------|
| `PERCENTAGE` | 0–100 (e.g., 10 = 10%) | Used directly |
| `FIXED` | Naira amount (e.g., 500 = ₦500) | `Math.round(value * 100)` → kobo |
| `DELIVERY` | Naira amount | Same as FIXED |

**Findings:**
- **Confidence: High** — Verified in `computeDiscountedPrice` (promotionPricing.service.ts:108–131) and `calculateDiscountAllocation` (promoService.ts:80–84)
- The field works correctly because **every calculation site explicitly checks `type` before using `value`**
- Risk: If a new code path forgets to check `type`, it would misinterpret the value
- No validation in schema prevents negative values or values >100 for PERCENTAGE (enforced in controller: `promoController.ts:38–41`)
- **Integer kobo is used consistently** after the conversion boundary — no floating-point financial math

### 2.5 Order Snapshots

**Location:** `schema.prisma:589–601`, `cartController.ts:1269–1314`

```prisma
commissionKobo   BigInt?
vendorPayoutKobo BigInt?
discountKobo     BigInt?
commissionRateSnapshot Float?
```

- `discountKobo` snapshots the total discount applied to the order
- `PromotionUsage.discount` (int kobo) records per-redemption discount
- **Backward compatibility:** Nullable with no backfill — historical rows predate Phase 3.2b

---

## 3. Promotion Creation and Management

### 3.1 Vendor Promotion Creation (`promoController.ts:170–213`)

**Endpoint:** `POST /api/promotions` (vendor role required)

```typescript
// Validation flow (validateScopeProducts):
// 1. DELIVERY type → requires code, VENDOR_WIDE scope, no productIds
// 2. Automatic (code == null) → minOrderAmount MUST be 0, usageLimit forbidden
// 3. SINGLE_PRODUCT → exactly 1 productId
// 4. SELECTED_PRODUCTS → 1–50 productIds
// 5. VENDOR_WIDE → no productIds (dynamic resolution)
// 6. All products MUST belong to vendor (line 121–124)
// 7. Products MUST NOT be archived (line 125–128)
// 8. Product-specific conflict check: one product cannot have >1 active
//    SINGLE_PRODUCT/SELECTED_PRODUCTS promotion (lines 130–155)
```

**Vendor ownership enforcement:** Line 121–124 — throws `ValidationError("Promotions can only cover your own products.")`

### 3.2 Vendor Promotion Updates (`promoController.ts:239–293`)

- Validates scope/products against merged state
- Excludes current promotion from conflict check (`excludePromoId`)
- Same ownership checks

### 3.3 Vendor Deactivate/Reactivate (`promoController.ts:228–304`)

- Ownership verified: `promo.vendorId !== req.user!.id` → 404
- Reactivation blocked if expired

### 3.4 Admin Promotion Management (`admin.controller.ts:1894–2206`)

| Endpoint | Scope | Notes |
|----------|-------|-------|
| `GET /admin/promotions` | Both | Filter by `scope=platform|vendor` |
| `POST /admin/promotions` | Platform-only | `vendorId: null` enforced; unique code check for null vendorId |
| `PATCH /admin/promotions/:id` | Platform-only | Validates `promo.vendorId === null` |
| `PATCH /admin/promotions/:id/deactivate` | Any | Can deactivate vendor promos too |
| `PATCH /admin/promotions/:id/reactivate` | Any | Expired guard applies |
| `POST /admin/promotions/deactivate-all` | All | Bulk deactivate |

**Admin platform-wide creation:** No product/category targeting in current implementation — only code-gated, VENDOR_WIDE (effectively platform-wide) with global usage limits.

### 3.5 Request Validation (Zod schemas: `promoController.ts:17–36`)

```typescript
const createPromoSchema = z.object({
  code: z.string().min(3).max(20).regex(/^[A-Za-z0-9]+$/).optional(),
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  type: z.nativeEnum(DiscountType),
  value: z.number().positive(),
  maxDiscount: z.number().positive().optional(),
  scope: z.nativeEnum(PromotionScope).default(PromotionScope.VENDOR_WIDE),
  productIds: z.array(z.string()).max(50).optional().default([]),
  startsAt: z.coerce.date().optional(),
  expiresAt: z.coerce.date().optional(),
  usageLimit: z.number().int().positive().optional(),
  maxUsesPerUser: z.number().int().positive().default(1),
  minOrderAmount: z.number().min(0).default(0),
});
```

---

## 4. Promotion Eligibility and Discount Calculation

### 4.1 Canonical Resolver: `promotionPricing.service.ts`

**Purpose:** Single authoritative mechanism for determining effective promotion for a product.

**Two promotion concepts (lines 14–19):**
1. **Automatic product/vendor discount** (`code == null`) — applies automatically
2. **Code-gated campaign** (`code != null`) — redeemed via `applyPromoService`

**Eligibility checks (`isPromoInWindow`, lines 134–147):**
- `isActive: true`
- Within `startsAt` / `expiresAt`
- Global `usageLimit` not exhausted
- **Per-user caps NOT checked here** (display-time cannot know viewer)

**Scope matching (`scopeMatches`, lines 149–165):**
- `SINGLE_PRODUCT` / `SELECTED_PRODUCTS` → product must be in `promo.products`
- `VENDOR_WIDE` → matches vendor's products OR all vendors if `vendorId == null`

**Conflict resolution (`resolveEffectivePromotionForProduct`, lines 172–232):**
1. Filter eligible: type PERCENTAGE/FIXED, in window, scope matches, product not archived
2. Compute `discountedPrice` for each via `computeDiscountedPrice`
3. Rank by: product-specific beats vendor-wide → larger discount → earlier expiry → earlier created
4. Return winner as `EffectivePromotion`

**`computeDiscountedPrice` (lines 108–131):**
```typescript
// originalPrice is integer kobo
const valueKobo = type === DiscountType.PERCENTAGE ? value : Math.round(value * 100);
if (type === DiscountType.PERCENTAGE) {
  const raw = (originalPrice * valueKobo) / 100;
  const capped = maxDiscount != null ? Math.min(raw, maxDiscount) : raw;
  return round(Math.max(originalPrice - capped, 0));
}
if (type === DiscountType.FIXED) {
  return round(Math.max(originalPrice - valueKobo, 0));
}
return round(originalPrice); // DELIVERY never discounts product price
```

### 4.2 Code-Gated Discount Calculation: `promoService.ts`

**`applyPromoService` (lines 124–289):**
1. Lookup promo by code (vendor-specific preferred over platform-wide)
2. Self-dealing guard: vendor cannot use own promo (line 152–153)
3. Date window, global usage, per-user usage checks
4. Scope filtering → `eligibleGroups` (VendorGroup[])
5. Minimum order amount check (kobo vs kobo)
6. `calculateDiscountAllocation` (lines 66–122):
   - `PERCENTAGE`: `eligibleSubtotal * value / 100`, capped by `maxDiscount` (kobo)
   - `FIXED`: `min(value * 100, eligibleSubtotal)`
   - `DELIVERY`: per-vendor fee discount, capped at vendor's own fee
7. Proportional allocation across vendors by subtotal share
8. Returns `PromoResult` with per-vendor discounts

### 4.3 Cart Summary Integration: `cartSummary.service.ts`

**Key design: Single best discount source (lines 278–322)**
```
1. Automatic discounts computed on effective prices
2. Code discount computed on ORIGINAL prices (pre-auto) for fair comparison
3. autoWins = globalAutoDiscount >= globalCodeDiscount
4. Winner's pricing used everywhere downstream
5. Delivery discount only applies if code discount wins
```

**Auto vs Code discount separation preserved in vendor breakdown** (lines 372–378)

---

## 5. Checkout and Order Integration

### 5.1 Cart Summary → Checkout Flow (`cartController.ts:613–1390`)

**Snapshot pattern:** `GET /cart/summary` → returns `summaryId` + priced preview → `POST /cart/checkout` with `summaryId` + `addressId`

**Checkout phases:**
1. Idempotency key claim (Redis, 5-min TTL)
2. Revalidate pricing against live cart with **same promo code** (line 1029–1030)
3. Price-match check: snapshot vs fresh summary components (lines 1036–1058)
4. **Transaction:** promo claim → stock reservation → daily-cap reservation → order creation → promo usage → cart cleanup

### 5.2 Promo Claim Inside Transaction (lines 1105–1196)

**Code promo claim:**
```typescript
await tx.$queryRaw`SELECT id FROM "Promotion" WHERE id = ${promoId} FOR UPDATE`;
const promo = await tx.promotion.findUnique({...});
// Check global cap, per-user cap
const claimed = await tx.promotion.updateMany({
  where: { id: promoId, OR: [{usageLimit: null}, {usedCount: {lt: promo.usageLimit}}] },
  data: { usedCount: {increment: 1} }
});
if (claimed.count === 0) throw PROMO_EXHAUSTED;
promoClaimed = true;
```

**Auto promo claim (Batch E, lines 1133–1196):**
- Collects winning auto promo IDs from revalidated summary
- Same row-lock + global cap check
- **Per-user caps deliberately NOT rejected** (lines 1175–1182) — auto discounts granted without personal history check
- Creates `PromotionUsage` with `promoCode: "AUTO"`

### 5.3 Order Snapshots (lines 1267–1314)

```typescript
const moneySnapshot = buildOrderMoneySnapshot({
  basePriceKobo: basePrice,
  discountKobo,
  commissionRate: resolveCommissionRate(rateByVendor.get(vendorId)),
});
// Creates Order with: basePrice, deliveryFee, totalPrice, commissionKobo, vendorPayoutKobo, discountKobo, commissionRateSnapshot
```

### 5.4 Promotion Usage Recording (lines 1343–1374)

```typescript
// Code promo
await tx.promotionUsage.create({
  data: { promotionId, userId, orderIds: orders.map(o => o.id), promoCode: code, discount: freshSummary.discount }
});

// Auto promos (shared PromotionUsage table)
for (const promoId of autoPromoIds) {
  await tx.promotionUsage.create({
    data: { promotionId: promoId, userId, orderIds: orders.map(o => o.id), promoCode: "AUTO", discount: autoDiscountByPromo.get(promoId) }
  });
}
```

---

## 6. Existing Group Buy Functionality

### 6.1 Backend Search Results

| Search Area | Result |
|-------------|--------|
| Prisma schema | No Group, GroupMembership, GroupBuy, GroupPurchase models |
| Backend controllers | No group-related endpoints |
| Backend services | No group-related logic |
| Migrations | No group-related tables |
| Tests | No group-related tests |
| Routes | No group-related routes |

### 6.2 Flutter Frontend Search Results

| Search Area | Result |
|-------------|--------|
| Models (`common.dart`, `product.dart`) | No Group/GroupBuy models |
| Screens | No group screens |
| API services | No group endpoints |
| Repositories | No group methods |
| State management | No group providers |

### 6.3 Conclusion

**Group Buy is NOT IMPLEMENTED** in any form:
- ❌ No database models
- ❌ No backend API
- ❌ No business logic
- ❌ No Flutter UI
- ❌ No tests

This is **entirely net-new functionality** requiring Stage 3–6 of the roadmap.

---

## 7. Flutter Frontend Integration

### 7.1 Models (`lib/models/common.dart`)

| Model | Purpose | Backend Mapping |
|-------|---------|-----------------|
| `PromotionProduct` (135–178) | Product entry within a promotion | `getActivePromotionsForCustomer` products array |
| `CustomerPromotion` (180–260) | Full promotion for customer discovery | `getActivePromotionsForCustomer` return items |
| `CartSummary` (315–370) | Cart preview with auto/code discount breakdown | `cartSummaryService` return |
| `CartVendorBreakdown` (265–310) | Per-vendor pricing | `vendorBreakdown` array |
| `Promo` (497–543) | Vendor-facing promotion model | `vendorRepository.getMyPromos()` |

**Key design:** Flutter **never calculates discounts** — `displayPrice` uses backend-resolved `effectiveUnitPrice` (product.dart:369). `hasPromotion` checks `promotion.discountedPrice < price`.

### 7.2 API Endpoints (Flutter ↔ Backend)

| Flutter Method | Backend Endpoint | Role |
|----------------|------------------|------|
| `vendorRepository.getMyPromos()` | `GET /api/promotions/mine` | Vendor |
| `vendorRepository.createPromo()` | `POST /api/promotions` | Vendor |
| `vendorRepository.updatePromo()` | `PATCH /api/promotions/:id` | Vendor |
| `vendorRepository.deactivatePromo()` | `PATCH /api/promotions/:id/deactivate` | Vendor |
| `vendorRepository.reactivatePromo()` | `PATCH /api/promotions/:id/reactivate` | Vendor |
| `customerRepository.getActivePromotions()` | `GET /api/customer/promotions/active` | Customer |
| `cartSummaryService` | `GET /api/cart/summary?promoCode=` | Customer |

### 7.3 Vendor Promotion UI (`vendor_promos_screen.dart`)

- **List screen:** Shows promos with AUTO/code badge, scope label, discount value, active switch
- **Creation form (`_PromoFormSheet`):** Covers all 3 scopes (VENDOR_WIDE, SINGLE_PRODUCT, SELECTED_PRODUCTS), both types (PERCENTAGE, FIXED), optional code
- **Validation:** Client-side mirrors backend rules (percentage ≤100, product selection per scope)

### 7.4 Customer Discovery

- **Home feed** (`home_feed_section.dart`): `HomeFeedPromoSection` from `GET /api/home/feed`
- **Smart badge** (`home_smart_badge.dart`): Shows "DEAL" when `CustomerPromotion` applies
- **Product detail:** `Product.promotion` → `displayPrice` (product.dart:369)
- **Cart:** Uses `CartSummary.autoDiscount`/`codeDiscount` from backend

### 7.5 API Contract Consistency

**Backend `getActivePromotionsForCustomer` (promoService.ts:339–535) → Flutter `CustomerPromotion`**

| Backend Field | Flutter Field | Notes |
|---------------|---------------|-------|
| `id` | `id` | |
| `code` | `code` | null for automatic |
| `name` | `name` | |
| `description` | `description` | |
| `type` | `type` | |
| `value` | `value` | polymorphic (backend) |
| `maxDiscount` | `maxDiscount` | |
| `minOrderAmount` | `minOrderAmount` | |
| `startsAt` | `startsAt` | |
| `expiresAt` | `expiresAt` | |
| `scope` | `scope` | |
| `vendor` | `vendorId/Name/Logo` | nested |
| `products[]` | `products[]` | `PromotionProduct` with `discountedPrice`, `discountAmount` |
| `code != null` | `requiresCode` | computed in Flutter |

**Consistency: High** — Flutter models match backend response shape; no local discount calculation.

---

## 8. Existing Tests and API Contracts

### 8.1 Unit Tests

| Test File | Coverage | Status |
|-----------|----------|--------|
| `promoCalculation.test.ts` | `calculateDiscountAllocation` — all 3 types, multi-vendor, caps, rounding | ✅ Covered |
| `multiroleFlows.test.ts:727–739` | `applyPromoService` rejects own vendor promo | ✅ Covered |
| `securityVerification.test.ts:51–56` | Checkout promo race → `SELECT FOR UPDATE` present | ✅ Static check |
| `koboConversionRegression.test.ts` | Integer kobo conversions in promotion paths | ✅ Covered |
| `checkoutRevalidation.test.ts` | Cart summary snapshot, promo revalidation, price-match | ✅ Covered (mocked) |
| `searchProductCard.test.ts:310–355` | Promotion mapping on search results | ✅ Covered |

### 8.2 Integration Tests

| Test File | Coverage |
|-----------|----------|
| `dailyCapFixVerification.test.ts` | Checkout idempotency + promo cache |
| `vendorLifecycleHttp.test.ts` | Vendor promotion lifecycle (via bak file) |

### 8.3 Test Coverage Classification

| Behavior | Coverage |
|----------|----------|
| Promotion CRUD (vendor) | Unit (mocked) |
| Promotion CRUD (admin) | Unit (mocked) |
| Automatic promotion resolution | Unit (mocked) + search integration |
| Code promo application | Unit (mocked) |
| Cart summary with auto/code discount | Unit (mocked) |
| Checkout promo claim (code) | Unit (mocked) |
| Checkout promo claim (auto) | Unit (mocked) |
| Promotion usage recording | Unit (mocked) |
| Per-user cap enforcement (code) | Unit (mocked) |
| Per-user cap enforcement (auto) | **NOT covered** — deliberately skipped |
| Vendor ownership validation | Unit (mocked) |
| Product-specific conflict check | Unit (mocked) |
| Group Buy | **NOT APPLICABLE** — does not exist |
| Real DB concurrency (promo claim) | **Runtime verification required** |
| Real DB promotion expiry race | **Runtime verification required** |

### 8.4 OpenAPI Documentation

**Location:** `src/docs/openapi.ts:69–72, 192, 240–242, 501`

- Vendor: `POST /promotions`, `GET /promotions/mine`, `PATCH /promotions/:id`, deactivate/reactivate
- Customer: `GET /customer/promotions/active`
- Admin: `GET /admin/promotions`, `POST /admin/promotions`, `PATCH /admin/promotions/:id`, deactivate/reactivate, deactivate-all
- Cart: `promoCode` query param accepted on `/cart/summary` (not yet applied)

---

## 9. Security, Financial and Concurrency Findings

### 9.1 Critical Findings

| # | Finding | Evidence | Severity |
|---|---------|----------|----------|
| 1 | **No Group Buy infrastructure** — entire feature missing | Schema, controllers, services, Flutter — no references | Critical (missing feature) |
| 2 | **Admin cannot target specific products/categories** — platform-wide promos only VENDOR_WIDE (effectively all products) | `admin.controller.ts:1965–1980` — no `scope`, `productIds`, `categoryIds` fields | High (business rule gap) |
| 3 | **Vendor-wide auto-promotions bypass per-user caps at claim time** — deliberate but undocumented | `cartController.ts:1175–1182` comment: "Per-user caps are deliberately NOT rejected here" | High (financial risk) |

### 9.2 High Findings

| # | Finding | Evidence | Severity |
|---|---------|----------|----------|
| 4 | **Polymorphic `Promotion.value` (Float)** — percentage vs naira distinguished only by `type` field | `schema.prisma:1025–1031`, `promotionPricing.service.ts:115–119` | High (potential misuse) |
| 5 | **Automatic promotions cannot have `minOrderAmount` or `usageLimit`** — enforced at creation | `promoController.ts:90–96` — throws if code==null and these set | Medium (by design) |
| 6 | **Product-specific promotion conflict excludes vendor-wide** — interim rule documented | `promoController.ts:130–155`, `promotionPricing.service.ts:42–47` | Medium (business ambiguity) |
| 7 | **Admin platform promo unique code check** — manual because PostgreSQL unique index doesn't cover `vendorId: null` | `admin.controller.ts:1953–1963` | Medium (implementation gap) |

### 9.3 Medium Findings

| # | Finding | Evidence | Severity |
|---|---------|----------|----------|
| 8 | **No category-targeted promotions** — `scope` only supports product-level or vendor-wide | `PromotionScope` enum lacks `CATEGORY` | Medium (roadmap gap) |
| 9 | **Auto-promotion discovery doesn't check per-user caps** — shows deals customer can't redeem | `promoService.ts:382–397` — guests skip; users filtered but display ≠ redemption | Medium (UX/consistency) |
| 10 | **Cache invalidation is best-effort** — TTL-bounded staleness (60s product promos, 90s home feed) | `promotionPricing.service.ts:240–301`, `clearCaches.ts` | Medium (by design) |

### 9.4 Low / Informational

| # | Finding | Evidence | Severity |
|---|---------|----------|----------|
| 11 | `round(v) => Number(v.toFixed(2))` used for kobo — redundant since kobo is integer | `promoService.ts:9`, `promotionPricing.service.ts:53` | Low (harmless) |
| 12 | `PromotionUsage.promoCode` uses `"AUTO"` sentinel for automatic redemptions | `cartController.ts:1367` | Informational |

### 9.5 Concurrency Protection Status

| Operation | Protection | Verified |
|-----------|------------|----------|
| Promo global usage limit | `SELECT FOR UPDATE` + conditional `updateMany` | Unit test checks source contains FOR UPDATE |
| Promo per-user limit (code) | Checked inside transaction before claim | Unit test mocks |
| Promo per-user limit (auto) | **NOT enforced at claim** — deliberate | Comment in code |
| Cart checkout idempotency | Redis claim + DB transaction | Unit + integration tests |
| Stock reservation | Row-level lock on Product | Integration tests |
| Daily cap reservation | `ProductDailyCounter` row lock | Integration tests |

---

## 10. Business-Rule Compliance Matrix

| Requirement (from `promotion.md`) | Expected | Current Status | Evidence |
|-----------------------------------|----------|----------------|----------|
| **A. Two purchasing models** | Personal Buy + Group Buy | ⚠️ Personal Buy only | No Group Buy models/logic |
| **B. Promotion creators: Admin + Vendor** | Both can create | ✅ Implemented | `promoController.ts`, `admin.controller.ts` |
| **C. Group creators: Customers** | Customers create groups | ❌ Not implemented | No group models |
| **D. Max group membership: 5** | Enforced | ❌ Not implemented | N/A |
| **E. Group Buy discounts** | Configurable %/fixed | ❌ Not implemented | N/A |
| **F. Admin scope: all / category / product** | All three | ⚠️ Only marketplace-wide (VENDOR_WIDE with vendorId=null) | `admin.controller.ts:1965–1980` lacks productIds/categoryIds |
| **G. Vendor scope: own products only** | Enforced backend | ✅ Implemented | `promoController.ts:121–124` validates ownership |
| **H. Promotion → group creation flow** | Customer selects promo → creates group | ❌ Not implemented | No group creation API |
| **I. Personal Buy coexists** | Separate option | ✅ Implemented | Current system is Personal Buy |

**Legend:** ✅ Implemented | ⚠️ Partially implemented | ❌ Not implemented

---

## 11. Reusable Existing Components

The following can be **reused/extended** for Group Buy:

| Component | Reusability | Notes |
|-----------|-------------|-------|
| `Promotion` model | **High** | Add `purchasingType` field (PERSONAL/GROUP); existing fields support discount config |
| `PromotionScope` enum | **High** | Works for Group Buy promotion targeting |
| `DiscountType` enum | **High** | PERCENTAGE/FIXED/DELIVERY all applicable |
| `promotionPricing.service.ts` | **High** | Canonical resolver works for Group Buy discount display |
| `promoService.applyPromoService` | **Medium** | Code-gated path reusable; auto path needs group context |
| `cartSummary.service.ts` | **Medium** | Single-best-discount logic extensible |
| `cartController.ts` checkout | **Medium** | Transaction structure reusable; needs group-order handling |
| `PromotionUsage` model | **High** | Track group promo redemptions |
| Admin/Vendor promo CRUD | **High** | Extend with `purchasingType` field |
| Flutter `CustomerPromotion`/`PromotionProduct` | **High** | Add `purchasingType`, `groupEligible` flags |
| Flutter vendor promo form | **High** | Add Group Buy toggle, max members field |

---

## 12. Missing Functionality (Gap Analysis)

### 12.1 Database (Stage 3)

| Missing | Required For |
|---------|--------------|
| `Promotion.purchasingType` field (PERSONAL \| GROUP) | Distinguish promo types |
| `GroupBuyCampaign` model (or extend Promotion) | Campaign-level config |
| `CustomerGroup` model | Customer-created groups |
| `GroupMembership` model | Members (max 5), status, joinedAt |
| `GroupPurchase` / `GroupOrder` model | Collective purchase linking |
| Group-level usage tracking | Enforce group completion rules |

### 12.2 Backend API (Stage 4)

| Missing Endpoint | Purpose |
|------------------|---------|
| `POST /api/groups` | Customer creates group from promotion |
| `POST /api/groups/:id/join` | Customer joins group |
| `DELETE /api/groups/:id/leave` | Customer leaves group |
| `GET /api/groups/:id` | Group details + members |
| `POST /api/groups/:id/checkout` | Group purchase initiation |
| `GET /api/customer/promotions/group-buy` | Discover Group Buy promotions |

### 12.3 Business Logic (Stage 2–4)

| Missing Logic | Notes |
|---------------|-------|
| Group completion rules (min/max members, time limits) | Open business decisions |
| Group payment model (individual vs shared) | Open |
| Discount funding (vendor/platform) | Open |
| Group expiry/cancellation | Open |
| Multi-group participation rules | Open |
| Group-specific promotion eligibility | Extend resolver |

### 12.4 Flutter Frontend (Stage 6)

| Missing UI | Notes |
|------------|-------|
| Group Buy promotion discovery (filter) | Distinguish from Personal Buy |
| Group creation screen | Select promo → create group |
| Group detail screen | Members, status, timer |
| Invite/share functionality | Deep links, codes |
| Group checkout flow | Collective payment |

---

## 13. Identified Risks and Prioritized Findings

### Priority 1 — Critical (Blockers for Group Buy)

1. **No Group Buy data model** — Must design in Stage 3
2. **Admin cannot target categories/products** — Need `CATEGORY` scope or productIds on platform promos
3. **Auto-promotion per-user cap bypass** — Design decision needed: enforce at display or only at redemption?

### Priority 2 — High (Design Decisions Required)

4. **Polymorphic `value` field** — Consider splitting to `percentageValue` (int) + `fixedAmountKobo` (int) for type safety
5. **Group payment model** — Individual payments vs shared wallet vs split — affects order/payment design
6. **Discount funding for Group Buy** — Who absorbs the discount? Vendor? Platform? Split?

### Priority 3 — Medium (Implementation Complexity)

7. **Concurrency on group joins** — Must enforce max 5 transactionally (row lock on group)
8. **Group expiry and cleanup** — Background jobs, notifications
9. **Promotion usage per-group vs per-user** — New tracking dimension

### Priority 4 — Low (Enhancements)

10. **Category-targeted promotions** — Add `CATEGORY` to `PromotionScope`
11. **Promotion stacking rules** — Currently single-best; Group Buy may need stacking

---

## 14. Recommended Direction for Stage 2

Based on this audit, Stage 2 (Finalize Business Rules) should resolve:

1. **Group Buy discount model:** Fixed % per promotion? Tiered by group size? (promotion.md says "not established")
2. **Group completion:** Min members? Time limit? Auto-checkout on full?
3. **Payment model:** Each member pays individually → separate orders linked to group? Or shared payment?
4. **Discount funding:** Vendor-funded (reduces vendor payout)? Platform-funded? Split?
5. **Multi-group participation:** Can a customer be in multiple groups simultaneously?
6. **Group expiry:** What happens to partial groups? Refunds? Re-promotion?
7. **Admin promotion targeting:** Add `CATEGORY` scope? Or reuse `SELECTED_PRODUCTS` with category expansion?
8. **Auto-promotion per-user caps:** Enforce at display time (hide from user) or only at redemption (current)?

**Recommended approach for database (Stage 3):**
- Extend `Promotion` with `purchasingType: "PERSONAL" | "GROUP"` (default PERSONAL for backward compat)
- Add `Group` model with `promotionId`, `creatorId`, `status`, `expiresAt`, `maxMembers=5`
- Add `GroupMember` with `groupId`, `userId`, `status`, `joinedAt`
- Link `Order` to `Group` via nullable `groupId` (Personal Buy orders have null)
- Reuse `PromotionUsage` with new `groupId` field for group redemptions

---

## 15. Unresolved Questions

| Question | Blocking Stage | Notes |
|----------|----------------|-------|
| Minimum group size? | 2 | promotion.md: "open business decision" |
| Does discount scale with group size? | 2 | promotion.md: "not established" |
| Individual vs shared payment? | 2, 4 | Affects order/payment architecture |
| Who funds Group Buy discount? | 2, 4 | Vendor? Platform? Affects payout math |
| Can customer join multiple groups? | 2 | Affects membership model |
| Group expiry behavior? | 2 | Refunds? Re-promotion? |
| Admin category targeting? | 3 | Requires `CATEGORY` scope or new relation |
| Per-user cap for auto-promos: enforce at display? | 3 | Current: only at redemption (code) |

---

## 16. Audit Limitations

| Limitation | Impact |
|------------|--------|
| No runtime database verification | Concurrency, migration, and integration behavior not confirmed against live PostgreSQL/Redis |
| No payment provider testing | Paystack webhook/payment flows with promotions not verified |
| Flutter UI not exercised | Visual/UX flows inferred from code only |
| No load testing | Promotion cache performance under load unknown |
| Test mocks only | Real infrastructure behavior (Redis, DB locks) not verified |

---

## 17. Final Verification Checklist

- ✅ `promotion.md` was not modified
- ✅ No source code was modified
- ✅ No Prisma schema or migration was modified
- ✅ No test was modified
- ✅ No environment file was accessed or modified
- ✅ Only created file: `docs/engineering/promotion-audit.md`
- ✅ Restricted `docs/engineering/remediation-status.md` was not accessed
- ✅ No Git commands used
- ✅ No database writes or external payment operations performed

---

**Report Location:** `docs/engineering/promotion-audit.md`  
**Repositories Inspected:** Backend (complete), Flutter frontend (read-only)  
**Main Finding:** Mature Personal Buy promotion system exists; Group Buy is entirely absent — requires full implementation per roadmap Stages 2–6  
**Critical Risks:** Missing Group Buy infrastructure; Admin targeting gaps; Auto-promo per-user cap bypass  
**Unresolved Questions:** 8 business decisions blocking Stage 2 completion  
**Checks Not Performed:** Runtime DB/Redis concurrency, payment integration, load testing

---

**Stop after completing the audit. Do not begin Stage 2, change the roadmap, modify application code, or implement recommendations. Wait for review and explicit approval.**