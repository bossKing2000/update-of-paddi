/**
 * OpenAPI 3.0 document, hand-maintained and grown domain-by-domain as we
 * rewrite each part of the API. Served at /api/docs via swagger-ui-express
 * (see src/server.ts). This isn't meant to be exhaustive on day one — it's
 * seeded with the auth + KYC endpoints from this pass, and each future
 * domain (cart, orders, payments, ...) adds its own `paths` entries here.
 */
export const openApiDocument = {
  openapi: "3.0.3",
  info: {
    title: "update-of-paddi API",
    version: "1.0.0",
    description:
      "Vendor/customer/delivery marketplace backend. Auth, KYC, cart, orders, payments, delivery, products, reviews, vendor dashboard, admin.",
  },
  servers: [{ url: "/api", description: "API root" }],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "JWT",
      },
    },
    schemas: {
      ErrorResponse: {
        type: "object",
        properties: {
          success: { type: "boolean", example: false },
          message: { type: "string" },
          code: { type: "string" },
          errors: { type: "object", nullable: true },
        },
      },
      OnboardingState: {
        type: "object",
        properties: {
          isComplete: { type: "boolean" },
          nextStep: { type: "string", nullable: true, enum: ["ROLE", "KYC", "PROFILE", null] },
          steps: {
            type: "array",
            items: {
              type: "object",
              properties: {
                key: { type: "string", enum: ["ROLE", "KYC", "PROFILE"] },
                done: { type: "boolean" },
                missingFields: { type: "array", items: { type: "string" } },
              },
            },
          },
        },
      },
    },
  },
  security: [{ bearerAuth: [] }],
  paths: {
    "/auth/sessions": {
      get: { tags: ["Auth", "Sessions"], summary: "List every active session (device) for the current user", responses: { "200": { description: "Sessions" } } },
    },
    "/auth/sessions/{sessionId}": {
      delete: { tags: ["Auth", "Sessions"], summary: "Revoke one specific device's session", parameters: [{ name: "sessionId", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "Revoked" } } },
    },
    "/auth/logout-all-devices": {
      post: { tags: ["Auth", "Sessions"], summary: "Revoke every active session and invalidate every outstanding refresh token", responses: { "200": { description: "Logged out everywhere" } } },
    },
    "/auth/login-history": {
      get: { tags: ["Auth", "Sessions"], summary: "Recent logins (device/location/time) for spotting unrecognized activity", responses: { "200": { description: "History" } } },
    },
    "/promotions": {
      post: { tags: ["Promotions"], summary: "Vendor creates a promo code scoped to their own store", responses: { "201": { description: "Created" } } },
    },
    "/promotions/mine": { get: { tags: ["Promotions"], summary: "Vendor's own promo codes", responses: { "200": { description: "Promotions" } } } },
    "/referrals/my-code": { get: { tags: ["Referrals"], summary: "Get (or lazily generate) your shareable referral code", responses: { "200": { description: "Code" } } } },
    "/referrals/apply": { post: { tags: ["Referrals"], summary: "Apply someone else's referral code to your account (once only)", requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["code"], properties: { code: { type: "string" } } } } } }, responses: { "200": { description: "Applied" } } } },
    "/referrals/my-rewards": { get: { tags: ["Referrals"], summary: "Rewards earned from people you've referred", responses: { "200": { description: "Rewards" } } } },
    "/admin/dashboard": { get: { tags: ["Admin"], summary: "Platform-wide KPIs and pending-action counts", responses: { "200": { description: "Overview" } } } },
    "/admin/users": { get: { tags: ["Admin"], summary: "List users (filterable by role, searchable)", parameters: [{ name: "role", in: "query", schema: { type: "string" } }, { name: "search", in: "query", schema: { type: "string" } }], responses: { "200": { description: "Users" } } } },
    "/admin/users/{id}/block": { patch: { tags: ["Admin"], summary: "Block a user — immediately revokes their session", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }], responses: { "200": { description: "Blocked" } } } },
    "/admin/users/{id}/kyc-status": { patch: { tags: ["Admin"], summary: "Approve or reject a vendor/driver's KYC", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }], requestBody: { content: { "application/json": { schema: { type: "object", properties: { kycStatus: { type: "string", enum: ["PENDING", "VERIFIED", "REJECTED"] } } } } } }, responses: { "200": { description: "Updated" } } } },
    "/admin/refund-requests/{id}": {
      patch: {
        tags: ["Admin"],
        summary: "Approve/reject a refund request, or complete it (actually refunds via Paystack)",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: { content: { "application/json": { schema: { type: "object", properties: { status: { type: "string", enum: ["APPROVED", "REJECTED", "COMPLETED"] }, adminNote: { type: "string" }, amount: { type: "number", description: "Optional partial refund amount" } } } } } },
        responses: { "200": { description: "Updated" }, "502": { description: "Paystack refund failed, no records changed — retry safely" } },
      },
    },
    "/admin/payouts/pending": { get: { tags: ["Admin", "Payouts"], summary: "Vendors with an available balance ready to pay out", responses: { "200": { description: "Pending payouts" } } } },
    "/admin/payouts/process": {
      post: {
        tags: ["Admin", "Payouts"],
        summary: "Trigger a payout for a vendor (Paystack transfer if bank details on file, else recorded for manual settlement)",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["vendorId"], properties: { vendorId: { type: "string", format: "uuid" } } } } } },
        responses: { "200": { description: "Payout sent or recorded" }, "502": { description: "Transfer failed — payout recorded, retry after fixing bank details" } },
      },
    },
    "/admin/review-reports/{id}": {
      patch: {
        tags: ["Admin"],
        summary: "Resolve a reported review — dismiss the report or remove the review",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: { content: { "application/json": { schema: { type: "object", properties: { action: { type: "string", enum: ["dismiss", "remove"] } } } } } },
        responses: { "200": { description: "Resolved" } },
      },
    },
    "/vendor-follow/follow": { post: { tags: ["Vendor Follow"], summary: "Follow a vendor", requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["vendorId"], properties: { vendorId: { type: "string", format: "uuid" } } } } } }, responses: { "201": { description: "Followed" }, "404": { description: "Not a vendor" } } } },
    "/vendor-follow/vendor/{vendorId}/follower-count": { get: { tags: ["Vendor Follow"], summary: "Lightweight follower count for a vendor profile header", parameters: [{ name: "vendorId", in: "path", required: true, schema: { type: "string", format: "uuid" } }], responses: { "200": { description: "Count" } } } },
    "/vendor/payouts": {
      get: { tags: ["Vendor", "Payouts"], summary: "Vendor's payout summary (available balance + history)", responses: { "200": { description: "Summary" } } },
    },
    "/vendor/payouts/bank-details": {
      get: { tags: ["Vendor", "Payouts"], summary: "Get the vendor's saved bank details", responses: { "200": { description: "Bank details" } } },
      put: {
        tags: ["Vendor", "Payouts"],
        summary: "Set bank details — verified with Paystack before saving",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { type: "object", required: ["bankName", "bankCode", "bankAccountNumber"], properties: { bankName: { type: "string" }, bankCode: { type: "string" }, bankAccountNumber: { type: "string", minLength: 10, maxLength: 10 } } } } },
        },
        responses: { "200": { description: "Verified and saved" }, "502": { description: "Could not verify with Paystack" } },
      },
    },
    "/vendor/payouts/banks": { get: { tags: ["Vendor", "Payouts"], summary: "List supported banks (for a bank picker)", responses: { "200": { description: "Banks" } } } },
    "/review/{productId}/reviews": {
      get: { tags: ["Reviews"], summary: "List reviews for a product", parameters: [{ name: "productId", in: "path", required: true, schema: { type: "string", format: "uuid" } }], responses: { "200": { description: "Reviews" } } },
      post: { tags: ["Reviews"], summary: "Submit a product review (requires a completed order for that product)", parameters: [{ name: "productId", in: "path", required: true, schema: { type: "string", format: "uuid" } }], responses: { "201": { description: "Created" }, "403": { description: "No completed order for this product" } } },
    },
    "/review/{productId}/reviews/summary": { get: { tags: ["Reviews"], summary: "Rating breakdown + average for a product", parameters: [{ name: "productId", in: "path", required: true, schema: { type: "string", format: "uuid" } }], responses: { "200": { description: "Summary" } } } },
    "/review/reviews/{id}/vote": { post: { tags: ["Reviews"], summary: "Vote a review helpful/unhelpful", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }], responses: { "200": { description: "Voted" } } } },
    "/review/reviews/{id}/reply": { post: { tags: ["Reviews"], summary: "Vendor replies to a review on their product", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }], responses: { "200": { description: "Reply added" } } } },
    "/review/vendor/{vendorId}/reviews": {
      get: { tags: ["Reviews"], summary: "List reviews for a vendor", parameters: [{ name: "vendorId", in: "path", required: true, schema: { type: "string", format: "uuid" } }], responses: { "200": { description: "Reviews" } } },
      post: { tags: ["Reviews"], summary: "Review a vendor (requires a completed order from them)", parameters: [{ name: "vendorId", in: "path", required: true, schema: { type: "string", format: "uuid" } }], responses: { "201": { description: "Created" } } },
    },
    "/product": {
      get: { tags: ["Products"], summary: "List products (paginated, optional category filter)", parameters: [{ name: "page", in: "query", schema: { type: "integer" } }, { name: "limit", in: "query", schema: { type: "integer" } }, { name: "category", in: "query", schema: { type: "string" } }], responses: { "200": { description: "Products" } } },
      post: { tags: ["Products"], summary: "Create a product (vendor only, multipart/form-data)", responses: { "201": { description: "Created" } } },
    },
    "/product/categories": { get: { tags: ["Products"], summary: "List valid product categories", responses: { "200": { description: "Categories" } } } },
    "/product/{id}": {
      get: { tags: ["Products"], summary: "Get a product by id", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }], responses: { "200": { description: "Product" } } },
      patch: { tags: ["Products"], summary: "Update a product (vendor, owner only)", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }], responses: { "200": { description: "Updated" } } },
      delete: {
        tags: ["Products"],
        summary: "Delete a product (only if it has never been ordered — otherwise archive it instead)",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: { "200": { description: "Deleted" }, "409": { description: "Has order history — archive instead", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } } } },
      },
    },
    "/product/{id}/archive": { patch: { tags: ["Products"], summary: "Archive or unarchive a product", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }], responses: { "200": { description: "Updated" } } } },
    "/product/{id}/schedule/go-live": { post: { tags: ["Products", "Schedule"], summary: "Schedule (or immediately start) a product's live window", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }], responses: { "200": { description: "Scheduled/live" } } } },
    "/product/{id}/schedule/take-down": { post: { tags: ["Products", "Schedule"], summary: "Take a product down immediately (owner only)", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }], responses: { "200": { description: "Taken down" } } } },
    "/product/p/search": { get: { tags: ["Products"], summary: "Full-text + fuzzy product search with typo correction", parameters: [{ name: "q", in: "query", required: true, schema: { type: "string" } }, { name: "page", in: "query", schema: { type: "integer" } }, { name: "sortBy", in: "query", schema: { type: "string", enum: ["relevance", "priceAsc", "priceDesc", "popularity", "newest"] } }], responses: { "200": { description: "Results" } } } },
    "/product/p/suggestions": { get: { tags: ["Products"], summary: "Search-box autocomplete suggestions", parameters: [{ name: "q", in: "query", required: true, schema: { type: "string" } }], responses: { "200": { description: "Suggestions" } } } },
    "/product/p/most": { get: { tags: ["Products"], summary: "Most popular live products", parameters: [{ name: "page", in: "query", schema: { type: "integer" } }], responses: { "200": { description: "Products" } } } },
    "/delivery/assign": {
      post: {
        tags: ["Delivery"],
        summary: "Assign a driver to an order (vendor of that order, or admin, only)",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { type: "object", required: ["orderId"], properties: { orderId: { type: "string", format: "uuid" }, driverId: { type: "string", format: "uuid", description: "Omit for auto-broadcast to nearby drivers" } } } } },
        },
        responses: { "200": { description: "Assignment or broadcast created", content: { "application/json": { schema: { type: "object" } } } } },
      },
    },
    "/delivery/{assignmentId}/accept": {
      patch: { tags: ["Delivery"], summary: "Driver accepts their own assignment", parameters: [{ name: "assignmentId", in: "path", required: true, schema: { type: "string", format: "uuid" } }], responses: { "200": { description: "Accepted" } } },
    },
    "/delivery/{assignmentId}/status": {
      patch: {
        tags: ["Delivery"],
        summary: "Driver updates delivery status (PICKED_UP, EN_ROUTE, DELIVERED, FAILED, RETURNED, CANCELLED)",
        parameters: [{ name: "assignmentId", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["status"], properties: { status: { type: "string" } } } } } },
        responses: { "200": { description: "Updated" }, "409": { description: "Invalid transition for current state" } },
      },
    },
    "/delivery/location": {
      patch: {
        tags: ["Delivery"],
        summary: "Driver updates their live GPS position",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["latitude", "longitude"], properties: { latitude: { type: "number" }, longitude: { type: "number" } } } } } },
        responses: { "200": { description: "Location updated" } },
      },
    },
    "/delivery/online-status": {
      patch: {
        tags: ["Delivery"],
        summary: "Driver toggles online/offline (whether they receive new assignments)",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["isOnline"], properties: { isOnline: { type: "boolean" } } } } } },
        responses: { "200": { description: "Status updated" } },
      },
    },
    "/delivery/driver/available": {
      get: {
        tags: ["Delivery"],
        summary: "Find nearby available drivers",
        parameters: [{ name: "latitude", in: "query", required: true, schema: { type: "number" } }, { name: "longitude", in: "query", required: true, schema: { type: "number" } }],
        responses: { "200": { description: "Drivers" } },
      },
    },
    "/payments/start": {
      post: {
        tags: ["Payments"],
        summary: "Initiate payment for a checkout batch (one or more orders sharing an idempotencyKey)",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { type: "object", required: ["idempotencyKey"], properties: { idempotencyKey: { type: "string" }, mobileSdk: { type: "boolean" } } },
            },
          },
        },
        responses: { "201": { description: "Payment initialized", content: { "application/json": { schema: { type: "object" } } } } },
      },
    },
    "/payments/confirm/{reference}": {
      get: {
        tags: ["Payments"],
        summary: "Post-redirect fallback confirmation — verifies with Paystack directly and finalizes if successful",
        parameters: [{ name: "reference", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Confirmed", content: { "application/json": { schema: { type: "object" } } } } },
      },
    },
    "/payments/cards/charge": {
      post: {
        tags: ["Payments"],
        summary: "Charge a saved card for a checkout batch",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { type: "object", required: ["idempotencyKey", "cardId"], properties: { idempotencyKey: { type: "string" }, cardId: { type: "string", format: "uuid" } } } } },
        },
        responses: { "200": { description: "Charged (or OTP required)", content: { "application/json": { schema: { type: "object" } } } } },
      },
    },
    "/payments/refund": {
      post: {
        tags: ["Payments"],
        summary: "Request a refund for a successful payment",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { type: "object", required: ["reference", "reason"], properties: { reference: { type: "string" }, reason: { type: "string" } } } } },
        },
        responses: { "200": { description: "Refund requested", content: { "application/json": { schema: { type: "object" } } } } },
      },
    },
    "/payments/webhook": {
      post: {
        tags: ["Payments"],
        summary: "Paystack webhook (signature-verified, not for direct client use)",
        security: [],
        responses: { "200": { description: "Acknowledged" } },
      },
    },
    "/order": {
      get: {
        tags: ["Orders"],
        summary: "List the current user's orders (as customer or vendor)",
        parameters: [
          { name: "page", in: "query", schema: { type: "integer" } },
          { name: "limit", in: "query", schema: { type: "integer" } },
          { name: "status", in: "query", schema: { type: "string" } },
        ],
        responses: { "200": { description: "Orders", content: { "application/json": { schema: { type: "object" } } } } },
      },
    },
    "/order/batch/{idempotencyKey}": {
      get: {
        tags: ["Orders"],
        summary: "Retrieve the complete checkout batch by idempotencyKey",
        parameters: [
          { name: "idempotencyKey", in: "path", required: true, schema: { type: "string" }, description: "The idempotency key shared by all orders in the checkout batch" },
        ],
        responses: {
          "200": { description: "Order batch retrieved", content: { "application/json": { schema: { type: "object" } } } },
          "401": { description: "Unauthorized", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } } },
          "403": { description: "Forbidden - not the batch owner", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } } },
          "404": { description: "No batch found for this idempotencyKey", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } } },
        },
      },
    },
    "/order/{orderId}": {
      get: {
        tags: ["Orders"],
        summary: "Get a single order",
        parameters: [{ name: "orderId", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: { "200": { description: "Order", content: { "application/json": { schema: { type: "object" } } } } },
      },
    },
    "/order/vendor/order/{orderId}/update-status": {
      patch: {
        tags: ["Orders"],
        summary: "Transition an order's status (vendor drives cooking/pickup/delivery, customer confirms completion, either can cancel)",
        parameters: [{ name: "orderId", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { type: "object", required: ["status"], properties: { status: { type: "string", enum: ["COOKING", "READY_FOR_PICKUP", "OUT_FOR_DELIVERY", "COMPLETED", "CANCELLED", "FAILED_DELIVERY"] } } },
            },
          },
        },
        responses: {
          "200": { description: "Updated", content: { "application/json": { schema: { type: "object" } } } },
          "409": { description: "Invalid transition / unpaid / expired order", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } } },
        },
      },
    },
    "/order/special-requests": {
      post: {
        tags: ["Orders", "Special Orders"],
        summary: "Customer creates a special order request for a custom quantity/version of a product",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { type: "object", required: ["productId", "quantity", "details"], properties: { productId: { type: "string", format: "uuid" }, quantity: { type: "integer", minimum: 1 }, details: { type: "string" } } },
            },
          },
        },
        responses: { "201": { description: "Request created", content: { "application/json": { schema: { type: "object" } } } } },
      },
    },
    "/order/special-requests/{requestId}/offers": {
      post: {
        tags: ["Orders", "Special Orders"],
        summary: "Vendor bids on a special order request",
        parameters: [{ name: "requestId", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: {
          required: true,
          content: { "application/json": { schema: { type: "object", required: ["price"], properties: { price: { type: "number" }, message: { type: "string" } } } } },
        },
        responses: { "201": { description: "Offer created", content: { "application/json": { schema: { type: "object" } } } } },
      },
    },
    "/order/special-offers/{offerId}/accept": {
      patch: {
        tags: ["Orders", "Special Orders"],
        summary: "Customer accepts a special-order offer, creating a real order",
        parameters: [{ name: "offerId", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: {
          required: true,
          content: { "application/json": { schema: { type: "object", required: ["addressId"], properties: { addressId: { type: "string", format: "uuid" } } } } },
        },
        responses: { "201": { description: "Order created", content: { "application/json": { schema: { type: "object" } } } } },
      },
    },
    "/notifications": {
      get: {
        tags: ["Notifications"],
        summary: "List the current user's notifications",
        parameters: [
          { name: "page", in: "query", schema: { type: "integer" } },
          { name: "limit", in: "query", schema: { type: "integer" } },
        ],
        responses: { "200": { description: "Notifications", content: { "application/json": { schema: { type: "object" } } } } },
      },
    },
    "/notifications/{notificationId}/read": {
      patch: {
        tags: ["Notifications"],
        summary: "Mark one notification as read",
        parameters: [{ name: "notificationId", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: { "200": { description: "Marked read", content: { "application/json": { schema: { type: "object" } } } } },
      },
    },
    "/notifications/read-all": {
      patch: {
        tags: ["Notifications"],
        summary: "Mark all notifications as read",
        responses: { "200": { description: "Marked read", content: { "application/json": { schema: { type: "object" } } } } },
      },
    },
    "/cart": {
      get: {
        tags: ["Cart"],
        summary: "Get the current user's cart",
        responses: { "200": { description: "Cart", content: { "application/json": { schema: { type: "object" } } } } },
      },
      delete: {
        tags: ["Cart"],
        summary: "Clear the entire cart",
        responses: { "200": { description: "Cart cleared", content: { "application/json": { schema: { type: "object" } } } } },
      },
    },
    "/cart/add": {
      post: {
        tags: ["Cart"],
        summary: "Add an item to the cart",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["productId"],
                properties: {
                  productId: { type: "string", format: "uuid" },
                  quantity: { type: "integer", minimum: 1 },
                  selectedOptions: { type: "array", items: { type: "string", format: "uuid" } },
                  specialRequest: { type: "string", maxLength: 500 },
                },
              },
            },
          },
        },
        responses: { "201": { description: "Item added", content: { "application/json": { schema: { type: "object" } } } } },
      },
    },
    "/cart/items/{itemId}": {
      patch: {
        tags: ["Cart"],
        summary: "Update a cart item (quantity, options, or note)",
        parameters: [{ name: "itemId", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: { "200": { description: "Updated", content: { "application/json": { schema: { type: "object" } } } } },
      },
      delete: {
        tags: ["Cart"],
        summary: "Remove a cart item",
        parameters: [{ name: "itemId", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: { "200": { description: "Removed", content: { "application/json": { schema: { type: "object" } } } } },
      },
    },
    "/cart/summary": {
      get: {
        tags: ["Cart"],
        summary: "Priced, vendor-grouped cart preview with delivery fee — call before checkout",
        parameters: [
          { name: "addressId", in: "query", schema: { type: "string", format: "uuid" }, description: "Needed to compute delivery fee/range" },
          { name: "promoCode", in: "query", schema: { type: "string" }, description: "Accepted but not yet applied — see Promotions phase" },
        ],
        responses: {
          "200": {
            description: "Summary, includes a summaryId to pass to /cart/checkout",
            content: { "application/json": { schema: { type: "object" } } },
          },
        },
      },
    },
    "/cart/checkout": {
      post: {
        tags: ["Cart"],
        summary: "Convert cart to order(s), one order per vendor",
        parameters: [
          {
            name: "Idempotency-Key",
            in: "header",
            required: false,
            schema: { type: "string" },
            description: "Stable client-generated key so retries don't create duplicate orders. Strongly recommended.",
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["summaryId", "addressId"],
                properties: {
                  summaryId: { type: "string", format: "uuid", description: "From GET /cart/summary" },
                  addressId: { type: "string", format: "uuid" },
                },
              },
            },
          },
        },
        responses: {
          "201": { description: "Order(s) created", content: { "application/json": { schema: { type: "object" } } } },
          "409": {
            description: "Cart locked / summary expired / pricing changed",
            content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } },
          },
        },
      },
    },
    "/auth/register": {
      post: {
        tags: ["Auth"],
        summary: "Register a new account",
        security: [],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["name", "email", "password"],
                properties: {
                  name: { type: "string" },
                  email: { type: "string", format: "email" },
                  password: { type: "string", minLength: 8 },
                  username: { type: "string" },
                  phoneNumber: { type: "string" },
                  role: { type: "string", enum: ["CUSTOMER", "VENDOR", "DELIVERY"] },
                  brandName: { type: "string" },
                },
              },
            },
          },
        },
        responses: {
          "201": { description: "Registered", content: { "application/json": { schema: { type: "object" } } } },
          "409": { description: "Email/username already exists", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } } },
          "422": { description: "Validation failed", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } } },
        },
      },
    },
    "/auth/login": {
      post: {
        tags: ["Auth"],
        summary: "Log in",
        security: [],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["email", "password"],
                properties: {
                  email: { type: "string", format: "email" },
                  password: { type: "string" },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "Logged in", content: { "application/json": { schema: { type: "object" } } } },
          "401": { description: "Invalid credentials", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } } },
        },
      },
    },
    "/auth/select-role": {
      post: {
        tags: ["Auth"],
        summary: "Select account role (CUSTOMER / VENDOR / DELIVERY)",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { type: "object", required: ["role"], properties: { role: { type: "string", enum: ["CUSTOMER", "VENDOR", "DELIVERY"] } } },
            },
          },
        },
        responses: {
          "200": {
            description: "Role updated",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { message: { type: "string" }, role: { type: "string" }, onboarding: { $ref: "#/components/schemas/OnboardingState" } },
                },
              },
            },
          },
        },
      },
    },
    "/auth/profile": {
      get: {
        tags: ["Auth"],
        summary: "Get the authenticated user's profile (includes onboarding state)",
        responses: { "200": { description: "Profile", content: { "application/json": { schema: { type: "object" } } } } },
      },
      patch: {
        tags: ["Auth"],
        summary: "Update profile (multipart/form-data, supports avatar upload)",
        requestBody: { content: { "multipart/form-data": { schema: { type: "object" } } } },
        responses: { "200": { description: "Updated", content: { "application/json": { schema: { type: "object" } } } } },
      },
    },
    "/auth/kyc/verify-nin": {
      post: {
        tags: ["Auth", "KYC"],
        summary: "Verify NIN via Dojah (VENDOR and DELIVERY only)",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { type: "object", required: ["nin"], properties: { nin: { type: "string", pattern: "^\\d{11}$", example: "12345678901" } } },
            },
          },
        },
        responses: {
          "200": {
            description: "NIN verified",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    message: { type: "string" },
                    kycStatus: { type: "string", enum: ["PENDING", "VERIFIED", "REJECTED"] },
                    onboarding: { $ref: "#/components/schemas/OnboardingState" },
                  },
                },
              },
            },
          },
          "400": { description: "Invalid NIN or verification failed", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } } },
          "403": { description: "Role doesn't require KYC", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } } },
          "409": { description: "Already verified, or NIN linked to another account", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } } },
        },
      },
    },
  },
};
