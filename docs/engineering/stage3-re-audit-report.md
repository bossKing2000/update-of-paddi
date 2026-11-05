# Foodi Paddi — Independent Stage 3 Database Design Re-Audit Report

**Date:** 2026-11-01  
**Auditor:** Independent re-audit (this report)  
**Documents audited:** `docs/engineering/stage3-database-design.md`, `promotion.md`  
**Code inspected:** `prisma/schema.prisma`, `src/services/refundFinalizer.service.ts`, `src/services/inventory.service.ts`, `src/services/paymentFinalizer.service.ts`, `src/controllers/webhook.ts`, `src/controllers/admin.controller.ts`, `src/controllers/cartController.ts`, `src/jobs/workers jobs/expireAwaitingPaymentJob.ts`, `src/services/scheduling.service.ts`

---

## 1. Audit Verdict

**PASS WITH FINDINGS** — The Stage 3 database design is substantially sound and addresses the prior re-audit findings (B3–B7, C5–C6). However, **six findings** ranging from **BLOCKER** to **MEDIUM** require resolution before Stage 3 can be accepted. The blocking discount allocation timing decision (Decision A) remains correctly unresolved.

---

## 2. Scope and Files Inspected

### Documents
- `docs/engineering/stage3-database-design.md` (full, 2,740 lines)
- `promotion.md` (full, 682 lines)

### Source Code (read-only inspection)
| File | Relevance |
|------|-----------|
| `prisma/schema.prisma` | Current Promotion, Order, Payment, RefundRequest, Product, Category, DailyCapReservation models |
| `src/services/refundFinalizer.service.ts` | `completeRefund`, `failRefund`, `matchRefundRequest` — refund lifecycle |
| `src/services/inventory.service.ts` | `reserveStockForItems`, `restoreStockForOrders` — stock mechanics |
| `src/services/paymentFinalizer.service.ts` | `finalizePaymentSuccess` — payment capture, order confirmation, stock reservation |
| `src/controllers/webhook.ts` | Paystack webhook handling, signature validation, replay protection |
| `src/controllers/admin.controller.ts` | Admin refund submission, payment lock, reservation |
| `src/controllers/cartController.ts` | Checkout flow, draft order creation, stock reservation inside transaction |
| `src/jobs/workers jobs/expireAwaitingPaymentJob.ts` | Expiry job calling `restoreStockForOrders` |
| `src/services/scheduling.service.ts` | `DailyCapReservation` reservation/release mechanics |

No files were modified. No database operations, migrations, or Git commands were executed.

---

## 3. Critical Findings

### Finding 1: Payment-to-Order Cardinality — Creator-Pays-All Flow Has Unresolved Implementation Gap
**Severity: BLOCKER**

**Document sections:** 6.13 (Extended Order), 6.14 (Extended Payment), 8.1 (Draft orders before payment), 8.3 (Creator-pays-all flow)

**Issue:** The design proposes that a single creator `Payment` (with `groupBuyMemberId = null`) covers multiple member orders via `GroupBuyPaymentAllocation` and a shared `idempotencyKey`. However, the existing architecture has **no code path that creates a Payment without a concrete `orderId` pointing to a single order**.

**Evidence from code:**
- `Payment.orderId` is required (non-nullable) in Prisma schema: `orderId String` (line 846)
- `Payment` → `Order` relation is mandatory: `order Order @relation("OrderPayments", fields: [orderId], references: [id])` (line 883)
- `finalizePaymentSuccess` calls `getOrdersForPayment` which **requires** `payment.orderId` to exist and finds orders via `idempotencyKey` (line 202-216)
- `cartController.checkoutCart` creates one `Order` per vendor, then one `Payment` per order batch — always 1:N `Payment`→`Order` via `idempotencyKey`, never 1:1 `Payment`→anchor-order with N `Order`s sharing it

**Concrete failure scenario:**
1. Creator pays for 3 members → 1 `Payment` with `orderId = anchorOrder.id`, `groupBuyMemberId = null`
2. Paystack webhook arrives → `finalizePaymentSuccess` loads orders via `getOrdersForPayment`
3. `getOrdersForPayment` returns `[anchorOrder]` only (looks up by `idempotencyKey`, but other member orders have the same `idempotencyKey`? — untested)
4. Even if it finds all 3 orders, the finalizer **confirms ALL orders** in the same transaction (lines 796-836), but the design says "defer order confirmation to worker"
5. The design assumes the finalizer can mark `Payment=SUCCESS` + insert outbox **without confirming orders** — but `finalizePaymentSuccess` currently **always confirms orders** (lines 796-836)

**Required resolution:** The design must specify exactly how `finalizePaymentSuccess` branches for Group Buy:
- Does it skip order confirmation entirely? (Requires code change)
- Does it create a minimal "anchor" order that is never fulfilled? (Not in design)
- How does the worker know which orders to confirm? (`GroupBuyPaymentProcessing.memberId` → `GroupBuyMember.order` is one path, but the design doesn't show the query)

**This is not merely a documentation gap — the existing finalizer cannot implement the proposed flow without significant changes that are not acknowledged.**

---

### Finding 2: Outbox Insertion Timing — Payment Success and Order Confirmation Are Not Separated in Current Code
**Severity: HIGH**

**Document sections:** 8.4 (Payment success durable handoff), 8.5 (Worker: stock reservation and order confirmation), 8.8 (Integration points item 1)

**Issue:** The design claims the finalizer will "branch for Group Buy; insert outbox; defer Group Buy order confirmation and stock reservation." However, `finalizePaymentSuccess` **unconditionally confirms orders and reserves stock** in the same transaction that marks `Payment=SUCCESS` (lines 762-837).

**Evidence from code:**
- Lines 762-837: Single `$transaction` does `Payment.status=SUCCESS` + order confirmations + `reserveStockForItems` (called implicitly via order confirmation logic) + receipt generation
- No conditional branch on `payment.groupBuyGroupId` or `payment.groupBuyMemberId` exists
- The `isProcessing` lock (line 159-168) is per-payment, not per-member

**Concrete failure scenario:**
1. Group Buy individual payment succeeds
2. `finalizePaymentSuccess` runs, confirms the order, reserves stock, generates receipt — **all in one transaction**
3. If stock reservation fails, the payment is marked `LATE_PAYMENT`/`AMOUNT_MISMATCH`/`FAILED` (lines 566-723), not left as `SUCCESS` with a pending outbox job
4. The proposed `GroupBuyPaymentProcessing` outbox is never inserted

**Required resolution:** The design must either:
- Acknowledge that `finalizePaymentSuccess` requires a **significant refactor** to support deferred confirmation for Group Buy, or
- Redesign the flow to use a separate Group Buy payment finalization path that is invoked instead of `finalizePaymentSuccess`

The current document (Section 8.8 item 1) treats this as a simple "branch" — it is not.

---

### Finding 3: Inventory Reservation — `restoreStockForOrders` Blindly Increments Stock, Group Buy Exclusion Not Implemented
**Severity: HIGH**

**Document sections:** 6.12 (`GroupBuyInventoryReservation`), 8.1 (Draft-order expiry), 8.8 (Integration points items 2, 3), 15.1 (Job inventory)

**Issue:** The design correctly proposes a dedicated `GroupBuyInventoryReservation` ledger and states that `restoreStockForOrders` must skip Group Buy orders. However:
1. `restoreStockForOrders` has **no parameter or logic to distinguish Group Buy orders** — it iterates `Order.items` and increments stock for all tracked products (lines 99-127)
2. `expireAwaitingPaymentJob` calls `restoreStockForOrders` for **all** `AWAITING_PAYMENT` orders (lines 90-111) — no filter for `groupBuyMemberId`
3. The design proposes a new `groupBuyDraftExpiryJob` but does not specify how it coexists with the existing job

**Evidence from code:**
```typescript
// inventory.service.ts lines 99-127
export async function restoreStockForOrders(
  prisma: Pick<Tx, "order" | "product">,
  orderIds: string[],
): Promise<string[]> {
  // No Group Buy check — increments stock for ALL supplied orders
  const orders = await prisma.order.findMany({ where: { id: { in: orderIds } }, select: { items: { select: { productId: true, quantity: true } } } });
  // ... increments stock for each product
}
```

```typescript
// expireAwaitingPaymentJob.ts lines 32-44
const batch = await prisma.order.findMany({
  where: { status: OrderStatus.AWAITING_PAYMENT, protectedUntil: { lt: now } },
  include: { payments: { select: { id: true, status: true, isProcessing: true, expiresAt: true } } },
  // No filter for groupBuyMemberId
});
```

**Required resolution:** The design must specify:
- Exactly how `restoreStockForOrders` identifies Group Buy orders (check `groupBuyMemberId != null`?)
- Whether `expireAwaitingPaymentJob` is modified to filter, or a separate job fully replaces it for Group Buy
- The migration must add `groupBuyMemberId` to `Order` **before** the expiry job can filter on it

---

### Finding 4: Refund Accounting — Creator-Pays-All Member-Level Refund Requires `completeRefund` Rewrite
**Severity: HIGH**

**Document sections:** 8.9 (Refund completion integration), 11.5 (Completion), 11.4 (Refund worker)

**Issue:** The design specifies that `completeRefund` must determine `memberFullyRefunded` separately from `paymentFullyRefunded` and cancel only the affected order. However, the current `completeRefund`:
1. Claims the `RefundRequest` row first (line 74-80), then reads the `Payment` (line 97) — **lock order is RefundRequest → Payment**
2. Cancels orders via `idempotencyKey` fan-out when payment is fully refunded (lines 128-146)
3. Has **no concept of `GroupBuyPaymentAllocation` or member-level refund completion**

**Evidence from code:**
```typescript
// refundFinalizer.service.ts lines 74-95
const claim = await tx.refundRequest.updateMany({
  where: { id: refundRequestId, status: RefundStatus.PROCESSING },
  data: { status: RefundStatus.COMPLETED, ... },
});
// ... then reads payment
const payment = await tx.payment.findUnique({ where: { reference: refundRequest.paymentRef } });
```

```typescript
// refundFinalizer.service.ts lines 128-146
const affectedOrders = refundRequest.orderId
  ? await tx.order.findMany({ where: { id: refundRequest.orderId } })
  : payment.idempotencyKey
    ? await tx.order.findMany({ where: { idempotencyKey: payment.idempotencyKey } })
    : [{ id: payment.orderId }];
```

**Lock order violation:** Section 14.1 specifies global lock order: `GroupBuyGroup` → `Promotion` → `Payment` → `RefundRequest`. The current code locks `RefundRequest` first, then `Payment` — opposite of the design.

**Required resolution:** The design correctly identifies this in Section 8.8 item 12 and 11.5 rule 1, but the scope of the change is understated. `completeRefund` must be **restructured** to:
1. Accept `groupBuyPaymentAllocationId` parameter
2. Lock `Payment` (and `GroupBuyGroup` if linked) **before** claiming `RefundRequest`
3. Update `GroupBuyPaymentAllocation.completedRefundAmountKobo`
4. Determine member-level vs payment-level full refund separately
5. Cancel only `RefundRequest.orderId` for member-level full refund

This is a **significant rewrite**, not a minor adjustment.

---

### Finding 5: Group-Level Usage Release — Conditional Transition Logic Is Sound But Requires Promotion Row Lock During Qualification
**Severity: MEDIUM**

**Document sections:** 6.9 (`GroupBuyGroupUsage`), 10.2 (Group-level consumption), 10.3 (Group-level release), 14.3 (Operation lock matrix)

**Issue:** The design correctly uses `releasedAt IS NULL` conditional update with `groupLevelUsedCount` decrement under `Promotion` row lock. However, the qualification flow (Section 12.3) shows:
1. Lock `GroupBuyGroup` row (line 2042)
2. Load members, check limits
3. Lock `Promotion` row (line 2047)
4. Create `GroupBuyGroupUsage` and increment `groupLevelUsedCount` (line 2057-2058)

**But:** The `Promotion` row lock is acquired **after** checking `groupLevelUsageLimit` (line 2047-2048). Under `READ COMMITTED`, another concurrent qualification could:
- Read `groupLevelUsedCount` (stale)
- Both pass the limit check
- Both acquire `Promotion` lock sequentially
- Both increment `groupLevelUsedCount` → counter exceeds limit

**Required resolution:** Move the limit check **inside** the `Promotion` row lock, or use a conditional increment with `WHERE groupLevelUsedCount < groupLevelUsageLimit` (similar to `reserveStockForItems` pattern).

---

### Finding 6: Category Targeting — Implicit Many-to-Many Relation Name Must Match Exactly
**Severity: MEDIUM**

**Document sections:** 6.2 (Extended Promotion), 6.3 (Extended Category), 13.2 (Relation)

**Issue:** The design proposes:
```prisma
model Promotion {
  categories Category[] @relation("PromotionCategories")
}
model Category {
  promotions Promotion[] @relation("PromotionCategories")
}
```

**Evidence from existing schema:** The existing `PromotionProducts` relation uses:
```prisma
model Promotion {
  products Product[] @relation("PromotionProducts")
}
model Product {
  promotions Promotion[] @relation("PromotionProducts")
}
```

**Verification:** The relation name `"PromotionCategories"` is valid and follows the same pattern. Prisma will create a join table `_PromotionCategories` with FKs to both tables. This is **correct**.

**However:** The design should verify that no existing migration or code references a `categoryIds` scalar field on `Promotion` (the document confirms it was removed). The temporary Prisma validation (Section 19.1) used stubs, not the real schema — **the real merged schema must be validated in Stage 5**.

**Status:** Design is correct, but **unverified against real schema** — marked UNVERIFIED until Stage 5 migration test.

---

## 4. Payment/Order Cardinality Assessment (Critical Area A)

### Current Architecture (Verified)
| Aspect | Current Behavior |
|--------|------------------|
| `Payment.orderId` | Required, non-nullable, FK to `Order` |
| `Payment` → `Order` | One-to-many via `idempotencyKey` (batch payment) |
| `Order.payments` | One-to-many (multiple payment attempts) |
| `Payment.isProcessing` | Per-payment lock for finalization |
| `finalizePaymentSuccess` | Confirms **all** orders sharing `idempotencyKey` |

### Proposed Group Buy Design
| Scenario | `Payment.orderId` | `Payment.groupBuyMemberId` | `GroupBuyPaymentAllocation` |
|----------|-------------------|---------------------------|----------------------------|
| Individual | Member's draft order | Member ID | None |
| Creator-pays-all | Anchor order (first member) | `null` | One per covered member |

### Gap Analysis
| Gap | Impact |
|-----|--------|
| `finalizePaymentSuccess` always confirms orders | Cannot defer confirmation to worker without refactor |
| `getOrdersForPayment` uses `idempotencyKey` to find batch orders | Creator-pays-all shares `idempotencyKey` — may work, but untested |
| `Payment.groupBuyMemberId = null` discriminator | No code currently handles null `groupBuyMemberId` |
| `GroupBuyPaymentAllocation` refund accounting | Requires `completeRefund` rewrite (Finding 4) |

**Conclusion:** The cardinality model is **theoretically workable** but requires **significant code changes** in `finalizePaymentSuccess`, `completeRefund`, `failRefund`, and webhook handling that are not fully acknowledged in the design.

---

## 5. Outbox and Crash-Recovery Assessment (Critical Area B)

### Design Claims vs. Code Reality

| Design Claim (Section 8.4-8.5) | Code Reality |
|--------------------------------|--------------|
| "Same local transaction: `Payment=SUCCESS` + insert outbox" | `finalizePaymentSuccess` does `Payment=SUCCESS` + order confirm + stock reserve in ONE transaction |
| "Worker claims job, reserves stock, confirms order" | No worker exists; stock reserved inside finalizer transaction |
| "Duplicate webhook safe via `isProcessing` lock + outbox unique" | `isProcessing` lock exists; outbox table doesn't exist yet |
| "Crash after commit → job remains PENDING" | If finalizer commits, order is already confirmed — no outbox job |

### Crash Scenarios (Section 8.7) — Partially Addressed

| Scenario | Design Handling | Actual Gap |
|----------|-----------------|------------|
| Crash before `Payment=SUCCESS` commit | Webhook retries | ✅ Covered by existing `isProcessing` lock |
| Crash after commit, before worker | Job `PENDING`, worker claims | ❌ No worker exists; order already confirmed |
| Worker crashes mid-transaction | Rolls back, lease expires | ❌ No worker transaction design |
| Worker crashes after commit | Order/reservation unique prevent duplicate | ❌ No worker; confirmation already happened |
| Duplicate webhook | `isProcessing` + outbox unique | ✅ `isProcessing` lock works; outbox not implemented |

**Conclusion:** The outbox pattern is **correct in theory** but **incompatible with current `finalizePaymentSuccess` implementation**. The design must explicitly acknowledge the refactor scope.

---

## 6. Inventory Reservation/Restoration Assessment (Critical Area C)

### Current Flow (Verified)
1. `checkoutCart` (cartController) → `reserveStockForItems` inside transaction (line 1105)
2. `reserveStockForItems` → conditional `UPDATE Product SET stock = stock - qty WHERE stock >= qty` (lines 57-65)
3. `expireAwaitingPaymentJob` → `restoreStockForOrders` blindly increments (lines 109-111, 119-122)
4. `restoreStockForOrders` has **no reservation check** — increments for all items

### Proposed Group Buy Flow
1. Draft order created (`AWAITING_PAYMENT`) — **no stock reservation**
2. Payment succeeds → `GroupBuyPaymentProcessing` inserted
3. Worker → conditional stock decrement + `GroupBuyInventoryReservation` creation
4. Release → conditional `UPDATE GroupBuyInventoryReservation SET releasedAt=now() WHERE releasedAt IS NULL` + stock increment only if transitioned

### Gaps
| Gap | Severity |
|-----|----------|
| `restoreStockForOrders` called for Group Buy drafts → increments never-decremented stock | **HIGH** (Finding 3) |
| `expireAwaitingPaymentJob` has no `groupBuyMemberId` filter | **HIGH** (Finding 3) |
| `DailyCapReservation` created at checkout (line 1147-1148) — Group Buy drafts must not create it | **MEDIUM** |
| `GroupBuyInventoryReservation.quantity` check constraint = 1 — what if product has `dailyCap` and member buys >1? (Rule P says one unit per member) | **LOW** (consistent with rules) |

**Conclusion:** Inventory design is **correct in isolation** but the integration with existing expiry/restoration paths is **not implemented** and requires explicit code changes documented in Section 8.8 items 2-3.

---

## 7. Refund Accounting Assessment (Critical Area D)

### Current Refund Flow (Verified)
1. `RefundRequest` created with `status=PENDING` → admin approves → `APPROVED`
2. Admin submits → `Payment` row lock (`FOR UPDATE`) → increment `refundedAmount` → CAS `APPROVED→PROCESSING` (admin.controller.ts lines 988-1070)
3. Paystack webhook → `matchRefundRequest` → `completeRefund` or `failRefund`
4. `completeRefund` → CAS `PROCESSING→COMPLETED` → sum `COMPLETED` refunds by `paymentRef` → if `>= payment.amount`, set `Payment=REFUNDED` + cancel orders via `idempotencyKey` fan-out

### Proposed Group Buy Changes
| Change | Status |
|--------|--------|
| `RefundRequest` adds `groupBuyGroupId`, `groupBuyMemberId`, `groupBuyPaymentAllocationId` | ✅ Schema design |
| `groupBuyPaymentAllocationId` required for creator-pays-all | ✅ Schema design |
| `completeRefund` determines `memberFullyRefunded` from `GroupBuyPaymentAllocation.completedRefundAmountKobo` | ❌ **Not implemented** (Finding 4) |
| `failRefund` decrements `GroupBuyPaymentAllocation.reservedRefundAmountKobo` | ❌ **Not implemented** |
| Partial unique index on unidentified `PROCESSING` refunds per `paymentRef` | ✅ Raw SQL in Section 7.4 |
| Refund worker serializes per payment, claims `APPROVED→PROCESSING` under `Payment` lock | ✅ Design (Section 11.4) |

### Critical Gap: Lock Order
- **Design (Section 14.1):** `Payment` → `RefundRequest`
- **Current code (refundFinalizer.ts lines 74-97):** `RefundRequest` → `Payment`
- **Admin submission (admin.controller.ts lines 988-1070):** `Payment` (FOR UPDATE) → `RefundRequest` (CAS) — **correct**

The refund worker (Section 11.4) follows the correct order (`Payment` lock first), but `completeRefund`/`failRefund` **must be reordered** to match. Section 8.8 item 12 and 11.5 rule 1 acknowledge this.

---

## 8. Group-Level and Per-User Promotion Usage Assessment (Critical Area E)

### Group-Level Usage (`GroupBuyGroupUsage`)
| Aspect | Design | Assessment |
|--------|--------|------------|
| One row per group (`groupId @unique`) | ✅ Prevents duplicate consumption |
| Created at qualification under `Promotion` lock | ✅ Section 10.2, 12.3 |
| `consumedAt` set at qualification | ✅ |
| Release only on group failure (`GROUP_FAILED`) | ✅ Section 10.3, 12.5 step 7 |
| Conditional `releasedAt IS NULL` transition | ✅ Section 10.3 code |
| Counter decrement only for transitioned rows | ✅ Section 10.3 code |

**Issue (Finding 5):** Limit check at qualification (Section 12.3 line 2047-2048) occurs **before** `Promotion` row lock. Race condition possible.

### Per-User Usage (`GroupBuyUserUsage`)
| Aspect | Design | Assessment |
|--------|--------|------------|
| One row per member (`groupBuyMemberId @unique`) | ✅ |
| Hold at qualification (`reservedAt`, no `consumedAt`) | ✅ Section 10.4 |
| `consumedAt` set at order `COMPLETED` | ✅ Section 10.4, 8.8 item 4 |
| Release on full refund only (derived from completed refunds) | ✅ Section 10.4, 10.5 |
| Partial/pending/failed refunds do not release | ✅ Section 10.5 |

**Assessment:** Per-user design is **sound**. Group-level has a **race condition in qualification** (Finding 5).

---

## 9. Inventory-Shortage Policy Assessment (Critical Area F)

### Policy (promotion.md Section R)
1. Payment captured, stock unavailable → fully refund affected customer
2. Re-evaluate group viability (≥2 paid confirmed members)
3. If <2 remain → fail group, refund all remaining paid members
4. No substitution, no partial fulfillment

### Design Coverage (Section 8.5-8.6)
| Scenario | Coverage |
|----------|----------|
| Individual payment, stock unavailable | ✅ Section 8.5: job `DEAD_LETTER` + affected-member refund + re-evaluation |
| Creator-pays-all, one allocation stock fails | ✅ Section 8.3: refund only that allocation, re-evaluate |
| Group re-evaluation under `GroupBuyGroup` lock | ✅ Section 8.6: counts `paymentStatus=PAID` + confirmed order |
| Creator-pays-all, never refunds whole payment for one failure | ✅ Section 8.3 rule 5 |

**Assessment:** Policy is **correctly implemented in design**. The worker flow (Section 8.5) correctly handles `STOCK_UNAVAILABLE` as terminal for that member only, triggers refund, and re-evaluates under group lock.

---

## 10. Prisma Relation and Constraint Assessment (Critical Area G)

### Category Targeting (C5, C6)
| Check | Result |
|-------|--------|
| Implicit many-to-many `Promotion.categories` ↔ `Category.promotions` | ✅ Valid Prisma syntax, follows `PromotionProducts` pattern |
| Relation name `"PromotionCategories"` matches on both sides | ✅ |
| No `categoryIds String[]` scalar | ✅ Removed per design |
| `PromotionScope.CATEGORY` admin-only | ✅ Section 13.1, 13.4 |
| Vendor ownership enforced at eligibility | ✅ Section 13.3 rule 4 |

**Limitation:** Temporary Prisma validation used stubs. **Real merged schema must be validated in Stage 5.**

### Key Constraints
| Constraint | Design | Valid? |
|------------|--------|--------|
| `GroupBuyGroupUsage.groupId @unique` | ✅ One usage per group | ✅ |
| `GroupBuyUserUsage.groupBuyMemberId @unique` | ✅ One hold per membership | ✅ |
| `GroupBuyPaymentProcessing @@unique([paymentId, memberId])` | ✅ One job per member per payment | ✅ |
| `GroupBuyInventoryReservation.orderId @unique` | ✅ One reservation per order | ✅ |
| `RefundRequest` partial unique index on `paymentRef` WHERE `status=PROCESSING AND paystackRefundId IS NULL` | ✅ Prevents ambiguous webhook matching | ✅ PostgreSQL syntax correct |
| `Order_groupbuy_pair_check` CHECK constraint | ✅ Both FKs null or both not null | ✅ |
| `Payment_groupbuy_pair_check` CHECK constraint | ✅ `groupBuyGroupId` not null → Group Buy payment | ✅ |

**Assessment:** Constraints are **well-designed and correct**. The partial unique index on `RefundRequest` is a critical safeguard for creator-pays-all refund serialization.

---

## 11. Approved Business-Rule Compliance Table

| Rule (promotion.md) | Design Compliance | Notes |
|---------------------|-------------------|-------|
| A. Admins/vendors create promotions; customers create groups | ✅ | `Promotion.purchasingType` distinguishes; `GroupBuyGroup.creatorId` |
| B. Admin targeting: marketplace, categories, products | ✅ | `PromotionScope.CATEGORY` + implicit m2m |
| C. Vendor targeting: own products only | ✅ | `CATEGORY` rejected for vendor; eligibility checks `vendorId` |
| D. Personal Buy preserved; Group Buy distinct | ✅ | `purchasingType=PERSONAL` default; separate usage models |
| E. Groups public/private; customer-created | ✅ | `GroupVisibility`, `GroupBuyGroup.creatorId` |
| F. Max 5, min 2; 1-hour formation | ✅ | Check constraints; `formationDeadlineAt` |
| G. Fixed pool = unit price × %; equal division, integer kobo | ✅ | Section 9.1-9.2 |
| H. 30-min payment window; 15-min extension | ✅ | `paymentDeadlineAt`, `paymentExtensionUsed` |
| I. Individual default; creator-pays-all explicit | ✅ | `GroupBuyPaymentMode` enum |
| J. Membership ≠ payment | ✅ | Separate `MemberStatus`/`MemberPaymentStatus` |
| K. Unpaid don't cancel paid; <2 paid → fail + full refund | ✅ | Section 12.5, 11.3 |
| L. Fixed pool; recalculation on unpaid removal = unresolved | ⚠️ | Decision A blocks this |
| M. Vendor-funded vs platform-funded | ✅ | `GroupBuyFundingSource` on pool |
| N. Failed group → immediate async refunds | ✅ | Section 11.3 creates `APPROVED` refunds; worker submits |
| O. No discount stacking | ✅ | Validation rule Section 9.5 |
| P. One unit per member | ✅ | `GroupBuyInventoryReservation.quantity=1` check |
| Q. Same product per group | ✅ | `GroupBuyGroup.productId` single |
| R. Inventory after payment; atomic; refund on stock fail | ✅ | Section 8.4-8.6, conditional stock update |
| S. Group-level usage at qualification; release on fail | ✅ | Section 10.2-10.3 |
| S. Per-user usage at order completion; release on full refund | ✅ | Section 10.4-10.5 |

**All approved rules are addressed in design.** Decision L (allocation recalculation on unpaid removal) is correctly blocked by Decision A.

---

## 12. Unresolved Discount Allocation Decision (Decision A)

**Status: Correctly unresolved — no option silently chosen.**

The design (Section 4) presents three options with consequences:
- **Option A:** Freeze at payment-window start; unpaid shares unallocated
- **Option B:** Finalize after payment closes; requires settlement mechanism
- **Option C:** Commitment/finalization step; additional state transitions

The design stores `isFinal`/`finalizedAt` on pool/allocations but **does not set them**. Section 9.3 explicitly states "This design does not implement Option A, B, or C." Section 9.4 prohibits post-payment redistribution without explicit approval.

**Assessment:** Correctly handled. Stage 3 cannot be accepted until product owner decides.

---

## 13. Exact Documentation Corrections Required

| # | Document | Section | Correction |
|---|----------|---------|------------|
| 1 | stage3-database-design.md | 8.1, 8.3, 8.8 item 1 | Explicitly state that `finalizePaymentSuccess` requires **significant refactor** to support deferred order confirmation for Group Buy. Current code confirms orders in same transaction. |
| 2 | stage3-database-design.md | 8.8 items 2-3 | Specify exact mechanism for `restoreStockForOrders` Group Buy exclusion: add `groupBuyMemberId` filter to both the function and `expireAwaitingPaymentJob`. |
| 3 | stage3-database-design.md | 11.5, 8.8 item 12 | Clarify that `completeRefund`/`failRefund` rewrite is **required**, not optional — lock order must change from RefundRequest→Payment to Payment→RefundRequest. |
| 4 | stage3-database-design.md | 12.3 (Qualification) | Move `groupLevelUsageLimit` check **inside** `Promotion` row lock to prevent race condition (Finding 5). |
| 5 | stage3-database-design.md | 6.14 (Payment mapping table) | Add note: `Payment.orderId` for creator-pays-all points to anchor order; all covered orders share `idempotencyKey`. Verify `getOrdersForPayment` returns all covered orders. |
| 6 | stage3-database-design.md | 19.1 (Verification) | Remove claim that Prisma relation syntax was validated — the temporary schema used stubs. State: "Real merged schema validation pending Stage 5." |
| 7 | promotion.md | Stage 3 status | Current status correctly states "blocked by decision A" — no change needed. |

---

## 14. No Modifications Confirmation

**I confirm that during this audit:**
- No source files, Prisma schema, migrations, tests, configuration, or database files were modified
- No Git commands were executed
- No database operations, migrations, seeds, or destructive commands were run
- No production or remote services were contacted
- No `.env` files, credentials, secrets, API keys, or tokens were inspected or printed
- `docs/engineering/remediation-status.md` was not read or accessed

---

## 15. Stage 3 Status

**Awaiting user review; not accepted.**

The design addresses the prior findings (B3–B7, C5–C6) in principle, but the implementation gaps in Findings 1–4 must be acknowledged and scoped before Stage 3 can be considered complete for implementation purposes.

---

## 16. Stage 4 Status

**Not authorized.**

Stage 4 cannot begin until:
1. Product owner selects Decision A (discount allocation timing)
2. Independent reviewer (this audit) confirms findings are resolved
3. Stage 3 is explicitly accepted by authorized reviewer

---

## 17. Summary of Findings by Severity

| Severity | Count | Findings |
|----------|-------|----------|
| BLOCKER | 1 | Payment-to-order cardinality / finalizer refactor for creator-pays-all |
| HIGH | 3 | Outbox/finalizer separation; Inventory restoration exclusion; Refund accounting rewrite |
| MEDIUM | 2 | Group-level usage qualification race; Category relation unverified on real schema |
| LOW | 0 | — |
| PASS | 6 | B3, B4, B5, B6, B7, C5, C6 addressed in design (implementation pending) |

---

*End of independent re-audit report. This report is evidence-based and distinguishes verified code behavior from proposed design behavior. No implementation has been performed.*