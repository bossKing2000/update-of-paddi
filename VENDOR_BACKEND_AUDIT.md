# VENDOR BACKEND API AUDIT — COMPLETE INVENTORY

## 1. ROUTE MOUNTING (server.ts)

All vendor routes are mounted at:
- `/api/vendor` → `vendorDashboardRoutes`
- `/api/vendor/settings` → `vendorSettingsRoutes`
- `/api/vendor/support` → `vendorSupportRoutes`
- `/api/vendor/upload` → `vendorUploadRoutes`
- `/api/vendor-follow` → `vendorFollowRoutes`
- `/api/product` → `productRoutes` (vendor-only write endpoints)
- `/api/product` → `productScheduleRoutes` (vendor scheduling)
- `/api/order` → `orderRouter` (vendor-specific endpoints)
- `/api/promotions` → `promoRoutes` (vendor-only)
- `/api/review` → `reviewRoutes` (vendor-specific endpoints)

---

## 2. ALL VENDOR ENDPOINTS

### 2.1 VENDOR DASHBOARD ROUTES (`/api/vendor/*`)

**File:** `src/routes/vendorDashboard.routes.ts`
**Middleware:** `authenticate`, `authorizeVendor`

| Method | Path | Handler | Auth | Description |
|--------|------|---------|------|-------------|
| GET | `/api/vendor/dashboard` | `getDashboardData` | Vendor | Main dashboard summary |
| GET | `/api/vendor/analytics` | `getAnalytics` | Vendor | Peak hours, return rate, order stats |
| GET | `/api/vendor/revenue-overview` | `getRevenueOverview` | Vendor | Revenue chart data (query: `period`) |
| GET | `/api/vendor/product-performance` | `getProductPerformance` | Vendor | Top 5 products by revenue |
| GET | `/api/vendor/recent-activity` | `getRecentActivity` | Vendor | Paginated activity feed (query: `page`, `limit`) |
| GET | `/api/vendor/product-live-control` | `getProductLiveControl` | Vendor | Top 3 products live status |
| GET | `/api/vendor/products/all` | `getAllVendorProducts` | Vendor | Paginated vendor products (query: `page`, `limit`) |
| DELETE | `/api/vendor/cache/clear` | `clearVendorCache` | Vendor | Clear all vendor Redis caches |
| GET | `/api/vendor/payouts` | `getPayoutSummary` | Vendor | Payout summary + history |
| GET | `/api/vendor/payouts/banks` | `getBankList` | Vendor | List Paystack banks |
| GET | `/api/vendor/payouts/bank-details` | `getBankDetails` | Vendor | Get vendor's bank details (masked) |
| PUT | `/api/vendor/payouts/bank-details` | `setBankDetails` | Vendor | Set + verify bank details with Paystack |
| GET | `/api/vendor/summary` | `getSummary` | Vendor | **DEPRECATED** dashboard summary |
| GET | `/api/vendor/products/live` | `getLiveProducts` | Vendor | **DEPRECATED** |
| GET | `/api/vendor/products/total` | `getTotalProducts` | Vendor | **DEPRECATED** |
| GET | `/api/vendor/orders/recent` | `getRecentOrders` | Vendor | **DEPRECATED** |
| GET | `/api/vendor/revenue` | `getRevenueChart` | Vendor | **DEPRECATED** |
| GET | `/api/vendor/orders/average-value` | `getAverageOrderValue` | Vendor | **DEPRECATED** |
| GET | `/api/vendor/customers/return-rate` | `getCustomerReturnRate` | Vendor | **DEPRECATED** |
| GET | `/api/vendor/orders/peak-hours` | `getPeakHours` | Vendor | **DEPRECATED** |

**Query Parameters:**
- `period`: `"thisWeek"` | `"lastWeek"` | `"lastMonth"` (revenue overview)
- `page`, `limit`: pagination

**Payout Body (`PUT /payouts/bank-details`):**
```json
{ "bankName": "string", "bankCode": "string", "bankAccountNumber": "10-digit string" }
```

---

### 2.2 VENDOR SETTINGS ROUTES (`/api/vendor/settings/*`)

**File:** `src/routes/vendorSettings.routes.ts`
**Middleware:** `authenticate`, `authorizeVendor`

| Method | Path | Handler | Auth | Description |
|--------|------|---------|------|-------------|
| GET | `/api/vendor/settings/` | `getVendorSettings` | Vendor | Get all settings |
| PATCH | `/api/vendor/settings/live` | `updateVendorLive` | Vendor | Toggle vendor live status (KYC required) |
| PATCH | `/api/vendor/settings/operating-hours` | `updateOperatingHours` | Vendor | Update weekly operating hours |
| PATCH | `/api/vendor/settings/delivery-preferences` | `updateDeliveryPreferences` | Vendor | Update delivery config |
| PUT | `/api/vendor/settings/service-areas` | `updateServiceAreas` | Vendor | Replace service areas |

**Settings Body Schemas (Zod):**

`operatingHoursSchema`:
```typescript
{
  timezone: string,  // default "Africa/Lagos"
  monday: { enabled: boolean, open: "HH:mm"|null, close: "HH:mm"|null },
  tuesday: ...,
  // ... all 7 days
}
```

`deliveryPreferencesSchema`:
```typescript
{
  acceptingOrders: boolean,
  deliveryEnabled: boolean,
  deliveryRadiusKm: number | null,
  baseDeliveryFee: number | null,
  preparationTimeMinutes: number | null
}
```

`serviceAreasSchema`:
```typescript
{
  areas: [{ id, label, city, state, radiusKm, enabled }]
}
```

`vendorLiveSchema`: `{ isLive: boolean }` — requires `kycStatus === "VERIFIED"` to go live.

**Models Touched:** `User` (operatingHours, deliveryPreferences, serviceAreas, isLive, order_openAT, order_closeAT)

---

### 2.3 VENDOR SUPPORT ROUTES (`/api/vendor/support/*`)

**File:** `src/routes/vendorSupport.routes.ts`
**Middleware:** `authenticate`, `authorizeVendor`

| Method | Path | Handler | Auth | Description |
|--------|------|---------|------|-------------|
| POST | `/api/vendor/support/tickets` | `createVendorSupportTicket` | Vendor | Create support ticket |
| GET | `/api/vendor/support/tickets` | `getVendorSupportTickets` | Vendor | List vendor's tickets (query: `page`, `limit`) |

**Ticket Body:**
```typescript
{
  category: "ACCOUNT" | "ORDER" | "PAYOUT" | "MENU" | "TECHNICAL" | "OTHER",
  subject: string (4-120 chars),
  description: string (12-2000 chars)
}
```

**Models Touched:** `VendorSupportTicket`

---

### 2.4 VENDOR UPLOAD ROUTES (`/api/vendor/upload/*`)

**File:** `src/routes/vendorUpload.routes.ts`
**Middleware:** `authenticate`, `authorizeVendor`, `upload.single("logo")`

| Method | Path | Handler | Auth | Description |
|--------|------|---------|------|-------------|
| POST | `/api/vendor/upload/logo` | `uploadVendorLogo` | Vendor | Upload brand logo to Cloudinary |

**Request:** Multipart form-data with field `logo` (image file)
**Response:** `{ url: "cloudinary_url" }`

---

### 2.5 VENDOR FOLLOW ROUTES (`/api/vendor-follow/*`)

**File:** `src/routes/vendorFollowRoutes.ts`
**Middleware:** `authenticate` (any role)

| Method | Path | Handler | Auth | Description |
|--------|------|---------|------|-------------|
| POST | `/api/vendor-follow/follow` | `followVendor` | Any | Follow a vendor |
| POST | `/api/vendor-follow/unfollow` | `unfollowVendor` | Any | Unfollow a vendor |
| GET | `/api/vendor-follow/status/:vendorId` | `isFollowingVendor` | Any | Check follow status |
| GET | `/api/vendor-follow/vendor/:vendorId/followers` | `getVendorFollowers` | Any | List followers (paginated) |
| GET | `/api/vendor-follow/vendor/:vendorId/follower-count` | `getVendorFollowerCount` | Any | Get follower count |
| GET | `/api/vendor-follow/following` | `getFollowedVendors` | Any | List vendors the user follows |

**Follow Body:** `{ vendorId: uuid }`
**Models Touched:** `VendorFollower`, `User`

---

### 2.6 PRODUCT ROUTES (Vendor Write Endpoints) (`/api/product/*`)

**File:** `src/routes/productRoutes.ts`

| Method | Path | Handler | Auth | Description |
|--------|------|---------|------|-------------|
| GET | `/api/product/` | `getAllProducts` | Public | Browse products (paginated, filterable) |
| GET | `/api/product/categories` | `getCategories` | Public | List product categories |
| GET | `/api/product/p/suggestions` | `getSearchSuggestions` | Public | Search suggestions (query: `q`) |
| GET | `/api/product/p/search` | `searchProducts` | Public | Full-text search |
| GET | `/api/product/p/most` | `getMostPopularProducts` | Public | Most popular products |
| GET | `/api/product/:id` | `getProductById` | Public | Product detail |
| POST | `/api/product/` | `createProduct` | Vendor | Create product (multipart: images, video) |
| PATCH | `/api/product/:id` | `updateProduct` | Vendor | Update product |
| PATCH | `/api/product/:id/archive` | `archiveProduct` | Vendor | Archive/unarchive product |
| DELETE | `/api/product/:id` | `deleteProduct` | Vendor | Delete product (no order history only) |

**Create Product Body (multipart):**
```typescript
{
  name: string (min 3),
  description: string (min 5),
  price: number,
  category: Category enum,
  archived: boolean,
  options: [{ name, price }],
  images: File[] (1-6),
  video: File[] (max 3)
}
```

**Product Detail Response includes:** vendor fields (id, username, email, name, avatarUrl, role, bio, brandName, brandLogo, isLive, deliveryPreferences, timezone, operatingHours), review stats, computed `orderable` flag.

**Models Touched:** `Product`, `ProductOption`, `ProductSchedule`, `OrderItem`, `Cart`, `VendorFollower`

---

### 2.7 PRODUCT SCHEDULE ROUTES (`/api/product/*`)

**File:** `src/routes/productScheduleRoutes.ts`

| Method | Path | Handler | Auth | Description |
|--------|------|---------|------|-------------|
| POST | `/api/product/:id/schedule/go-live` | `goLive` | Authenticated | Schedule/immediate go-live |
| POST | `/api/product/:id/schedule/take-down` | `takeDown` | Authenticated | Take product down |
| POST | `/api/product/:id/schedule/extend-grace` | `extendGrace` | Authenticated | Extend grace period |
| GET | `/api/product/:id/schedule` | `getWeeklySchedule` | Authenticated | Get product schedule |
| PUT | `/api/product/:id/schedule/weekly` | `putWeeklySchedule` | Authenticated | Create/replace weekly schedule |
| DELETE | `/api/product/:id/schedule/weekly` | `disableWeeklySchedule` | Authenticated | Disable weekly schedule |
| GET | `/api/product/fix-live-statuses` | `fixLiveStatuses` | Admin | Manual live-status fixer |

**Go Live Body:**
```typescript
{ goLiveAt: ISOdatetime, takeDownAt: ISOdatetime, graceMinutes: number (default 15) }
```

**Weekly Schedule Body:**
```typescript
{
  enabled: boolean,
  startDate?: ISOdatetime,
  endDate?: ISOdatetime,
  windows: [{ dayOfWeek: 0-6, startTime: "HH:mm", endTime: "HH:mm" }] (max 28)
}
```

**Extend Grace Body:** `{ extraMinutes: number }`

**Models Touched:** `Product`, `ProductSchedule`, `ProductScheduleWindow`, `Payment`, `Order`, `OrderItem`

---

### 2.8 ORDER ROUTES (Vendor-Specific) (`/api/order/*`)

**File:** `src/routes/orderRouter.ts`
**Middleware:** `authenticate` (some require `authorizeVendor`)

| Method | Path | Handler | Auth | Description |
|--------|------|---------|------|-------------|
| GET | `/api/order/` | `getMyOrders` | Any | List user's orders (as customer or vendor) |
| GET | `/api/order/batch/:idempotencyKey` | `getOrderBatch` | Any | Get orders by idempotency key |
| GET | `/api/order/:orderId` | `getSingleOrder` | Any | Order detail |
| PATCH | `/api/order/vendor/order/:orderId/update-status` | `updateOrderStatus` | Vendor/Customer | Update order status |
| POST | `/api/order/special-requests` | `createSpecialRequest` | Customer | Create special order request |
| POST | `/api/order/special-requests/:requestId/offers` | `createSpecialOffer` | Vendor | Vendor bids on special request |
| PATCH | `/api/order/special-offers/:offerId/accept` | `acceptSpecialOffer` | Customer | Accept a special offer |
| PATCH | `/api/order/special-offers/:offerId/reject` | `rejectSpecialOffer` | Customer | Reject a special offer |
| PATCH | `/api/order/special-requests/:requestId/reject` | `rejectSpecialRequest` | Customer | Reject all offers |
| GET | `/api/order/special-requests` | `getMySpecialRequests` | Customer | List special requests |
| GET | `/api/order/vendor/stats` | `getVendorOrderStats` | Vendor | Vendor order statistics |
| GET | `/api/order/customer/stats` | `getCustomerOrderStats` | Customer | Customer order statistics |
| GET | `/api/order/vendor/report` | `getVendorReport` | Vendor | Comprehensive vendor report |

**Status Transition Body:** `{ status: OrderStatus }`
- Vendor can set: `COOKING`, `READY_FOR_PICKUP`, `OUT_FOR_DELIVERY`, `FAILED_DELIVERY`, `CANCELLED`
- Customer can set: `COMPLETED`, `CANCELLED`

**Special Offer Body:** `{ price: number, message?: string }`
**Special Request Body:** `{ productId: uuid, quantity: number, details: string }`
**Accept Offer Body:** `{ addressId: string }`

**Vendor Stats Response:**
```typescript
{
  summary: {
    totalOrders, completedOrders, pendingOrders, inProgressOrders,
    awaitingApprovalOrders, totalRevenue
  }
}
```

**Vendor Report Response:**
```typescript
{
  summary: { totalRevenue, totalOrders, completedOrders, totalItemsSold, averageOrderValue },
  timeline: { today, week, month, year },
  daily: [{ date, count, revenue }],
  topProducts: [{ productId, name, sold, revenue }]
}
```

**Models Touched:** `Order`, `OrderItem`, `Product`, `SpecialOrderRequest`, `SpecialOrderOffer`

---

### 2.9 PROMOTION ROUTES (`/api/promotions/*`)

**File:** `src/routes/promoRoutes.ts`
**Middleware:** `authenticate`, `authorizeVendor`

| Method | Path | Handler | Auth | Description |
|--------|------|---------|------|-------------|
| POST | `/api/promotions/` | `createPromo` | Vendor | Create promotion |
| GET | `/api/promotions/mine` | `getMyPromos` | Vendor | List vendor's promotions |
| PATCH | `/api/promotions/:id` | `updatePromo` | Vendor | Update promotion |
| PATCH | `/api/promotions/:id/deactivate` | `deactivatePromo` | Vendor | Deactivate promotion |
| PATCH | `/api/promotions/:id/reactivate` | `reactivatePromo` | Vendor | Reactivate promotion |

**Create Promo Body:**
```typescript
{
  code: string (3-20 alphanumeric),
  name: string (1-100),
  description?: string,
  type: DiscountType (PERCENTAGE | FIXED | DELIVERY),
  value: number,
  maxDiscount?: number,
  startsAt?: datetime,
  expiresAt?: datetime,
  usageLimit?: number,
  maxUsesPerUser: number (default 1),
  minOrderAmount: number (default 0)
}
```

**Models Touched:** `Promotion`

---

### 2.10 REVIEW ROUTES (Vendor-Specific) (`/api/review/*`)

**File:** `src/routes/reviewRoutes.ts`

| Method | Path | Handler | Auth | Description |
|--------|------|---------|------|-------------|
| GET | `/api/review/:productId/reviews/summary` | `getProductReviewSummary` | Public | Product review summary |
| GET | `/api/review/:productId/reviews` | `getProductReviews` | Public | List product reviews |
| POST | `/api/review/:productId/reviews` | `reviewProduct` | Customer | Create product review (multipart) |
| PATCH | `/api/review/:productId/reviews/:id` | `updateReview` | Customer | Update review |
| DELETE | `/api/review/:productId/reviews/:id` | `deleteReview` | Customer | Delete review |
| POST | `/api/review/reviews/:id/vote` | `voteReview` | Any | Vote helpful/not |
| POST | `/api/review/reviews/:id/report` | `reportReview` | Any | Report review |
| POST | `/api/review/reviews/:id/reply` | `replyToReview` | **Vendor** | Reply to a review |
| DELETE | `/api/review/reviews/:id/reply` | `deleteReplyToReview` | **Vendor** | Delete reply |
| GET | `/api/review/vendor/:vendorId/reviews/summary` | `getVendorReviewSummary` | Public | Vendor review summary |
| GET | `/api/review/vendor/:vendorId/reviews` | `getVendorReviews` | Public | List vendor reviews |
| POST | `/api/review/vendor/:vendorId/reviews` | `reviewVendor` | Customer | Review a vendor |
| GET | `/api/review/vendor/reviews/single/:reviewId` | `getVendorReviewById` | Public | Single vendor review |

**Vendor Reply Body:** `{ message: string (min 2 chars) }`
**Vendor Review Body:** `{ vendorId, rating: 1-5, comment?: string }` (requires completed order)

**Models Touched:** `ProductReview`, `VendorReview`, `VendorReply`, `ReviewVote`, `ReviewReport`

---

## 3. VENDOR CONTROLLERS — DETAILED BREAKDOWN

### 3.1 `vendorDashboard.controller.ts`
- **Class:** `DashboardController` (exported as `dashboardController` singleton)
- **Methods:** `getDashboardData`, `getAnalytics`, `getRevenueOverview`, `getProductPerformance`, `getRecentActivity`, `getProductLiveControl`, `getAllVendorProducts`, `clearVendorCache`, `getSummary` (deprecated), `getLiveProducts` (deprecated), `getTotalProducts` (deprecated), `getRecentOrders` (deprecated), `getRevenueChart` (deprecated), `getAverageOrderValue` (deprecated), `getCustomerReturnRate` (deprecated), `getPeakHours` (deprecated)
- **Service used:** `VendorDashboardService`
- **Cache:** Redis key `vendor:{vendorId}:dashboardSummary` (5 min TTL)

### 3.2 `vendorDashboard.service.ts`
- **Class:** `VendorDashboardService`
- **Key methods:** `getDashboardSummary()`, `getAnalytics()`, `getRevenueOverview(period)`, `getProductPerformance()`, `getAllVendorProducts(skip, limit)`, `getRecentActivity()`, `getDetailedRecentActivity({page, limit})`, `getProductLiveControl()`, `getPayoutSummary()`, `invalidateCache()`
- **Cache keys used:** `vendor:{vendorId}:dashboardSummary`, `vendor:{vendorId}:products:page:{page}:limit:{limit}` (5 min)
- **`calculatePayoutAmounts()`:** Exported pure function for payout math
  - Formula: `grossRevenue = Σ(totalPrice - deliveryFee)`, `commission = grossRevenue × commissionRate`, `netAvailable = grossRevenue - commission`
- **Models touched:** `Order`, `Product`, `ProductReview`, `VendorReview`, `VendorPayout`, `User`

### 3.3 `vendorSettingsController.ts`
- **Functions:** `getVendorSettings`, `updateOperatingHours`, `updateDeliveryPreferences`, `updateServiceAreas`, `updateVendorLive`
- **Audit logs:** `VENDOR_OPERATING_HOURS_UPDATED`, `VENDOR_DELIVERY_PREFERENCES_UPDATED`, `VENDOR_SERVICE_AREAS_UPDATED`, `VENDOR_WENT_LIVE`, `VENDOR_WENT_OFFLINE`
- **KYC gate:** `updateVendorLive` checks `kycStatus === "VERIFIED"` before allowing isLive=true
- **Cache invalidation:** `invalidateMarketplaceDiscoveryCaches()` on live toggle
- **Models touched:** `User`

### 3.4 `payoutController.ts`
- **Functions:** `getPayoutSummary`, `getBankDetails`, `getBankList`, `setBankDetails`
- **Bank schema:** `{ bankName, bankCode, bankAccountNumber (10 digits) }`
- **Paystack integration:** `resolveBankAccount()` verifies before saving
- **Models touched:** `User` (bankName, bankCode, bankAccountNumber, bankAccountName, paystackRecipientCode)

### 3.5 `productController.ts`
- **Key exported function:** `computeIsLive(schedule, defaultIsLive)` — used throughout
- **Methods:** `createProduct`, `getAllProducts`, `getProductById`, `updateProduct`, `archiveProduct`, `deleteProduct`, `getSearchSuggestions`, `searchProducts`, `getMostPopularProducts`, `getCategories`
- **Search:** Full-text with Postgres tsvector + trigram fallback + AI typo correction
- **Dual-format image/video handling:** Legacy array format vs. new `{keep, delete}` format
- **Deletion guard:** Products with order history cannot be archived (ConflictError)
- **Queue:** `productIndexQueue` for search indexing
- **Cloudinary cleanup:** Background deletion of removed assets
- **Models touched:** `Product`, `ProductOption`, `ProductSchedule`, `OrderItem`, `Cart`, `VendorFollower`

### 3.6 `orderController.ts`
- **Vendor methods:** `updateOrderStatus`, `getVendorOrderStats`, `getVendorReport`, `createSpecialOffer`
- **State machine:** Enforces role-based transitions with payment gate
- **Special orders:** Full bid/accept/reject flow with delivery fee calculation
- **Models touched:** `Order`, `OrderItem`, `Product`, `SpecialOrderRequest`, `SpecialOrderOffer`, `Address`, `Promotion`

### 3.7 `promoController.ts`
- **Methods:** `createPromo`, `getMyPromos`, `updatePromo`, `deactivatePromo`, `reactivatePromo`, `getActivePromotions`
- **Validation:** Percentage ≤ 100, expiresAt > startsAt, duplicate code check
- **Models touched:** `Promotion`

### 3.8 `reviewController.ts`
- **Vendor methods:** `replyToReview`, `deleteReplyToReview` (ownership verified)
- **Notification:** Vendors notified on product reviews; customers notified on vendor replies
- **Verified purchase requirement:** Both product and vendor reviews require completed order
- **Models touched:** `ProductReview`, `VendorReview`, `VendorReply`, `ReviewVote`, `ReviewReport`, `OrderItem`, `Order`

### 3.9 `vendorFollowController.ts`
- **Methods:** `followVendor`, `unfollowVendor`, `isFollowingVendor`, `getVendorFollowers`, `getVendorFollowerCount`, `getFollowedVendors`
- **Validation:** Target must have role `VENDOR`; cannot follow self
- **Queue:** `vendorFollowQueue.add("notifyVendorFollow", ...)` — async notification
- **Models touched:** `VendorFollower`, `User`

### 3.10 `vendorSupportController.ts`
- **Methods:** `createVendorSupportTicket`, `getVendorSupportTickets`
- **Categories:** ACCOUNT, ORDER, PAYOUT, MENU, TECHNICAL, OTHER
- **Models touched:** `VendorSupportTicket`

### 3.11 `vendorUpload.controller.ts`
- **Methods:** `uploadVendorLogo` — multer with CloudinaryStorage
- **Returns:** `{ url: cloudinary_path }`

### 3.12 `vendorControllerMapping.ts`
- **Exported:** `computeVendorIsOpen(operatingHours, deliveryPreferences)` — determines if vendor is open now
- **`getNearbyVendors`:** Geospatial query with Haversine distance, batch review aggregation
- **`findNearbyVendors(lat, lng, radiusKm)`:** Helper for finding nearby vendors
- **Models touched:** `User`, `Address`, `VendorReview`

### 3.13 `productScheduleController.ts`
- **Methods:** `goLive`, `takeDown`, `extendGrace`, `fixLiveStatuses`, `getWeeklySchedule`, `putWeeklySchedule`, `disableWeeklySchedule`
- **Queue usage:** `productLiveQueue` (delayed), `productDeactivateQueue` (delayed)
- **Live status computation:** WEEKLY windows evaluated in vendor's timezone; ONE_TIME uses absolute window
- **Models touched:** `Product`, `ProductSchedule`, `ProductScheduleWindow`, `Payment`, `Order`, `OrderItem`

---

## 4. VENDOR SERVICES

### 4.1 `vendorAvailability.service.ts`
- **Key exports:** `isVendorOperating()`, `isVendorAcceptingOrders()`, `isProductCurrentlyAvailable()`, `isProductMarketplaceAvailable()`, `loadVendorOperatingState()`, `assertVendorAvailableForOrdering()`, `resolveVendorTimezone()`
- **Vendor operating rule:** `isLive === true AND deliveryPreferences.acceptingOrders !== false`
- **Timezone resolution:** explicit column → legacy operatingHours.timezone → UTC

### 4.2 `payoutService.ts`
- **Functions:** `createTransferRecipient`, `initiateTransfer`, `resolveBankAccount`, `listBanks`
- **Paystack integration:** Full transfer recipient creation + bank resolution

### 4.3 `product.service.ts`
- **Catalog sort values:** `popularity`, `priceAsc`, `priceDesc`, `newest`
- **SQL fragments:** `VENDOR_OPERATING_SQL`, `WEEKLY_SCHEDULE_ACTIVE_SQL`, `LOCAL_CALENDAR_SQL`
- **Key functions:** `fetchProductPage`, `fetchAvailableOnlyProducts`, `fetchMostPopularProducts`, `fetchLiveProducts`, `fetchNewProducts`, `clearProductFromCarts`, `trackProductView`

### 4.4 `scheduleRules.service.ts`
- **Pure functions only (no Prisma/Redis)**
- **Key exports:** `evaluateProductSchedule()`, `evaluateWeeklyWindows()`, `isWindowActiveAt()`, `localCalendar()`, `isWithinScheduleRange()`
- **Schedule types:** `ONE_TIME` (absolute window), `WEEKLY` (recurring windows with overnight handling)

### 4.5 `promoService.ts`
- **Functions:** `applyPromoService` (read-only preview), `redeemPromo` (atomic checkout), `getActivePromotionsForCustomer`, `calculateDiscountAllocation`
- **Discount allocation:** Proportional across vendors in multi-vendor cart

### 4.6 `clearCaches.ts`
- **Functions:** `clearProductCache(productId?, vendorId?)`, `invalidateMarketplaceDiscoveryCaches()`
- **Vendor cache keys:** `vendor:{vendorId}:products`, `vendor:{vendorId}:products:available`, `vendor:{vendorId}:dashboardSummary`, `vendor:{vendorId}:orders`, `vendor:{vendorId}:orders:today`, `vendor:{vendorId}:orders:week`, `vendor:{vendorId}:analytics`, `vendor:{vendorId}:recentActivity`

### 4.7 `paymentService.ts`
- **Functions:** `initializePayment`, `verifyPayment`, `cancelOrdersForOfflineProduct`
- **Channels:** card, bank, usd, bank_transfer (Paystack)

---

## 5. MIDDLEWARE

### 5.1 `auth.middleware.ts`
- **`authenticate`:** JWT verification + Redis session check. Sets `req.user = { id, role, sessionId }`
- **`optionalAuth`:** Same as authenticate but silently continues as guest on failure
- **`requireRole(...roles)`:** Factory for role-gate middleware
- **`authorizeVendor`:** `requireRole('VENDOR')`
- **`authorizeCustomer`:** `requireRole('CUSTOMER')`
- **`authorizeDeliveryPerson`:** `requireRole('DELIVERY')`
- **`authorizeAdmin`:** `requireRole('ADMIN')`

---

## 6. SOCKET.IO (`src/socket.ts`)

**Authentication:** JWT verified on connection, stored as `socket.data.userId`

**Events:**
| Event | Direction | Handler |
|-------|-----------|---------|
| `updateLocation` | Client → Server | Updates `DeliveryPerson` lat/lng, broadcasts via `DeliveryAssignmentService` |
| `orderAccepted` | Client → Server | **Placeholder** (empty handler) |
| `orderPickedUp` | Client → Server | **Placeholder** (empty handler) |
| `orderDelivered` | Client → Server | **Placeholder** (empty handler) |

**Socket notification events emitted by backend (via `recordActivityBundle`):**
- `ORDER` — order status updates
- `REVIEW` — new reviews/replies
- `GENERAL` — vendor follow, product live, grace extended, etc.

**Note:** Vendor-specific real-time events are delivered through the `relation: "vendor"` field in `recordActivityBundle` actions.

---

## 7. BACKGROUND JOBS

### 7.1 Vendor-Facing Cron Jobs (`src/jobs/node-cron/runJob.ts`)

| Job | Schedule | Description |
|-----|----------|-------------|
| Order Cleanup | Every 3 min | Cancels AWAITING_PAYMENT orders when product/vendor offline or payment expired |
| Expire Awaiting Payment | Every 5 min | Expires abandoned unpaid orders |
| Verify Pending Payments | Every 1 min | Auto-verifies stuck Paystack transactions |
| Verify Pending Refunds | Every 10 min | Reconciles PROCESSING refunds |
| Fix Live Status | Every 5 min | Syncs Product.isLive with schedule |
| Expire Delivery Broadcasts | Every 1 min | Retries unassigned delivery broadcasts |

### 7.2 BullMQ Workers

| Worker | Queue | Description |
|--------|-------|-------------|
| `vendorFollowWorker` | `vendorFollowNotifications` | Notifies vendor of new follower |
| `productLiveWorker` | `productLiveNotifications` | Marks product live + notifies followers/cart users |
| `productDeactivateWorker` | `productDeactivateJob` | Deactivates expired product schedules + cancels orders |

### 7.3 Other Jobs
- `updatePopularityScore.ts` — Batched popularity score computation with percentile ranking (affected by vendor product views/orders)
- `orderCleanupJob.ts` — Handles vendor-offline + product-offline + payment-expired order cleanup
- `expireAwaitingPaymentJob.ts` — Expires abandoned AWAITING_PAYMENT orders

---

## 8. VALIDATION SCHEMAS

### 8.1 `vendorSettingsSchema.ts`
- `operatingHoursSchema`: 7 day objects with `enabled`, `open`, `close` (HH:mm format)
- `deliveryPreferencesSchema`: `acceptingOrders`, `deliveryEnabled`, `deliveryRadiusKm`, `baseDeliveryFee`, `preparationTimeMinutes`
- `serviceAreasSchema`: Array of `{id, label, city, state, radiusKm, enabled}` (max 50)

### 8.2 `vendorFollowSchema.ts`
- `followVendorSchema`: `{ vendorId: uuid }`
- `unfollowVendorSchema`: `{ vendorId: uuid }`

### 8.3 `ProductCRUDSchema.ts`
- `createProductSchema`, `updateProductSchema`, `archiveProductSchema`
- `reviewProductSchema`, `replyToReviewSchema`, `reviewVoteSchema`, `reportReviewSchema`
- `createVendorReviewSchema`: `{ vendorId, rating (1-5), comment? }`

### 8.4 `orderSchema.ts`
- `updateOrderStatusSchema`: `{ status: OrderStatus }`
- `createSpecialRequestSchema`: `{ productId, quantity, details }`
- `createSpecialOfferSchema`: `{ price, message? }`

### 8.5 `productScheduleSchema.ts`
- `goLiveSchema`: `{ goLiveAt, takeDownAt, graceMinutes? }`
- `extendGraceSchema`: `{ extraMinutes }`
- `weeklyScheduleSchema`: `{ enabled?, startDate?, endDate?, windows: [{dayOfWeek, startTime, endTime}] }` with overlap/duplicate detection

---

## 9. DATABASE MODELS TOUCHED BY VENDOR OPERATIONS

| Model | Operations |
|-------|-----------|
| `User` | Settings (operatingHours, deliveryPreferences, serviceAreas, isLive, bank fields, kycStatus, commissionRate) |
| `Product` | CRUD, archive, live status, popularity scores |
| `ProductOption` | CRUD on product options |
| `ProductSchedule` | Go-live, take-down, weekly schedules |
| `ProductScheduleWindow` | Weekly recurring windows |
| `Order` | Status updates, stats, reports, special orders |
| `OrderItem` | Order line items |
| `SpecialOrderRequest` | Custom order requests |
| `SpecialOrderOffer` | Vendor bids on special requests |
| `Promotion` | Vendor promo CRUD |
| `VendorFollower` | Follow/unfollow |
| `VendorSupportTicket` | Support ticket CRUD |
| `ProductReview` | Product reviews (vendor receives) |
| `VendorReview` | Vendor profile reviews |
| `VendorReply` | Vendor replies to product reviews |
| `ReviewVote` | Helpful votes |
| `ReviewReport` | Review reports |
| `VendorPayout` | Payout history |
| `Payment` | Payment records |
| `Address` | Vendor addresses (for geospatial) |
| `DeliveryPerson` | Driver location |
| `Cart` / `CartItem` | Cart cache clearing |

---

## 10. KEY BUSINESS RULES

1. **KYC Gate:** Vendor cannot go live (`isLive: true`) unless `kycStatus === "VERIFIED"`
2. **Vendor Operating =** `isLive === true AND deliveryPreferences.acceptingOrders !== false`
3. **Product Orderable =** `NOT archived AND vendor operating AND schedule active`
4. **Payout Math:** `gross = Σ(totalPrice - deliveryFee)`, `commission = gross × rate`, `net = gross - commission`
5. **Order State Machine:** Vendor drives COOKING→READY→OUT_FOR_DELIVERY; Customer confirms COMPLETED
6. **Product Deletion:** Only allowed if zero order history; otherwise must archive
7. **Review Requirements:** Verified purchase (completed order) required for both product and vendor reviews
8. **Weekly Schedules:** Evaluated in vendor's effective timezone; overnight windows split across midnight
9. **Cache Invalidation:** Vendor live toggle sweeps all marketplace discovery caches
10. **Special Orders:** Customer creates request → multiple vendors bid → customer accepts one → order created with AWAITING_PAYMENT status
