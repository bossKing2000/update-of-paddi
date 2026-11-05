# Foodi Paddi — Promotions Product Design

**Repository:** `/home/onyeka-ifeanyi/StudioProjects/update-of-paddi-main-backend`  
**Product Area:** Promotion & Group Buy  
**Status:** Design specification (implementation-ready; Stage 5 not authorized)  
**Reference Documents:** `promotion.md`, `docs/engineering/promotion-audit.md`, `docs/engineering/stage3-database-design.md`, `docs/engineering/stage3-acceptance-closure.md`, `docs/engineering/stage4-implementation-readiness.md`

---

## 1. Executive Summary

Foodi Paddi is a Nigerian food marketplace connecting customers with home cooks, students, and small food vendors. The Promotion & Group Buy system enables **discounted group purchases** where multiple customers collectively buy the same promoted product at a reduced per-member price.

The system supports two purchase models:

1. **Personal Buy** — existing, production-grade individual purchase flow with promotions (automatic and code-gated).
2. **Group Buy** — new, customer-initiated group purchases where a customer creates a group from an available promotion, members join, pay individually (or the creator pays for everyone), and the discount is shared among paying members.

This document captures the **product vision**, **business rules**, **approved decisions**, and **unresolved questions** for the promotion system so that future implementers can understand the intended behavior without relying on prior conversations.

---

## 2. Why Foodi Paddi Has a Promotion System

Promotions serve two core business purposes:

1. **Customer acquisition and retention** — Discounts encourage customers to try new vendors and return for repeat purchases.
2. **Vendor sales growth** — Vendors can run promotions to move inventory, attract new customers, or compete during peak demand periods.

The platform supports two creator types:
- **Admin/Platform** — platform-wide promotions (entire marketplace, categories, or specific products).
- **Vendors** — promotions scoped to the vendor's own products only.

Customers cannot create promotions. They can only create **groups** from existing promotions in Group Buy mode.

---

## 3. The Intended Business Purpose of Promotions

Promotions in Foodi Paddi exist to:

| Purpose | Description |
|---------|-------------|
| **Demand generation** | Discounts lower the effective price, encouraging customers to place orders they might otherwise defer. |
| **Inventory movement** | Vendors can promote specific products to clear stock or drive volume during slow periods. |
| **Group purchasing** | Group Buy leverages social purchasing — customers form groups to unlock a shared discount pool, increasing average order value and vendor sales volume. |
| **Platform engagement** | Group creation and joining create repeat touchpoints within the app, increasing customer retention. |

Promotions are **discount mechanisms**, not payment instruments. They reduce the effective price a customer pays but do not create credit, store value, or transferable currency.

---

## 4. Relationship Between Personal Buy and Group Buy

| Aspect | Personal Buy | Group Buy |
|--------|-------------|-----------|
| **Purchase model** | Individual customer purchase | Customer-created group purchase |
| **Promotion code** | Optional code-gated or automatic | Optional code-gated or automatic |
| **Purchasing type** | `PERSONAL` | `GROUP` |
| **Who creates** | Admin or vendor | Customer (from an existing promotion) |
| **Minimum participants** | 1 (single customer) | 2 (creator + at least 1 member) |
| **Maximum participants** | N/A | 5 |
| **Payment model** | Individual pays for own order | Individual pays for own order, or creator pays for everyone |
| **Discount** | Per-promotion discount rules | Fixed pool divided among eligible paid members |
| **Inventory reserved** | At checkout (after payment) | Only after successful payment |
| **Can join multiple groups** | N/A | Yes |

**Critical distinction:** A promotion is **not** a group. One promotion can be used by multiple independent customer-created groups. A promotion is created by an admin or vendor; a group is created by a customer who selects an available promotion.

**One product per group.** Every member of a group purchases the same promoted product. Different products cannot be combined in one group.

**No discount stacking.** Group Buy discounts cannot be combined with other promotions or promo codes. Personal Buy behavior is preserved separately.

---

## 5. How Promotion Codes and Purchasing Types Work

### 5.1 Promotion Codes

Promotions may be **automatic** (no code, applies automatically when eligible) or **code-gated** (customer must enter a code at checkout).

| Property | Rule |
|----------|------|
| Code format | Alphanumeric, 3–20 characters, `[A-Za-z0-9]+` |
| Uniqueness | Unique per `(vendorId, code)` |
| Automatic promotion | `code` is `null` |
| Code-gated promotion | `code` is non-null |
| Group Buy | Codes optional — `code == null` (automatic) or `code != null` (code-gated) |

### 5.2 Purchasing Types

| Type | Meaning | Created by | Scope |
|------|---------|-----------|-------|
| `PERSONAL` | Individual purchase | Admin or vendor | Vendor's own products (vendor-created) or marketplace-wide (admin-created) |
| `GROUP` | Group Buy purchase | Admin or vendor | Same targeting rules as Personal Buy |

The `purchasingType` field on `Promotion` discriminates between the two models at the database level. `purchasingType = PERSONAL` promotions must never satisfy a Group Buy condition, and `purchasingType = GROUP` promotions must never satisfy a Personal Buy condition. This is enforced at every eligibility/discovery query.

### 5.3 Admin vs Vendor Targeting

| Creator | Targeting Scope | Enforcement |
|---------|----------------|-------------|
| **Admin** | Entire marketplace, categories, or specific products | Admin-only; `CATEGORY` scope is admin-only; vendor creation rejects `CATEGORY` |
| **Vendor** | Vendor's own products only | Backend-enforced: `promo.vendorId === product.vendorId` |

Vendor ownership is enforced **on the backend**, not merely hidden in the Flutter interface. A vendor must never be able to discount another vendor's products.

---

## 6. The Complete Group Buy Customer Journey

### 6.1 Discovery

1. Customer browses available Group Buy promotions (filtered by `purchasingType = GROUP`).
2. Public groups are discoverable; private groups require an invitation link or code.
3. Customer selects a promotion and creates a group.

### 6.2 Group Creation

1. Customer selects a promotion and clicks "Create Group."
2. Customer chooses group visibility (`PUBLIC` or `PRIVATE`) and maximum group size (2–5, default 5).
3. System creates a `GroupBuyGroup` record with:
   - `status = FORMING`
   - `formationDeadlineAt = now() + 1 hour`
   - `creatorId` = customer
   - `maxMembers` = selected (2–5)
   - `minMembers = 2`
4. Creator is automatically added as the first member (`GroupBuyMember` with `status = JOINED`).

### 6.3 Joining a Group

1. Customer discovers a public group or receives an invitation for a private group.
2. Customer clicks "Join."
3. System validates:
   - Group is `FORMING` (within formation window)
   - Group has not reached `maxMembers`
   - Customer is not already a member
   - Customer is eligible for the promotion (per-user limit not exhausted)
4. System creates a `GroupBuyMember` record with `status = JOINED`.
5. **Joining does not pay, does not reserve inventory, and does not consume any promotion usage limit.**

### 6.4 Group Closure and Qualification

1. The formation window closes (1 hour after creation, or early if capacity is reached).
2. The system qualifies the group:
   - If fewer than 2 members joined → group fails → `EXPIRED`, no payment collected.
   - If 2+ members joined → group qualifies → `QUALIFIED`, discount pool frozen, allocations computed.

### 6.5 Payment Window

1. After qualification, each member receives their exact amount due (product price minus allocated discount).
2. Each member has **30 minutes** to complete payment.
3. The creator may extend the payment deadline **once** by 15 minutes.
4. Payments are made individually (or via creator-pays-all).
5. Unpaid members expire at the deadline; their membership is released but does not cancel paid members.

### 6.6 Payment and Group Completion

1. Customer pays via Paystack (one unit of the promoted product).
2. System confirms payment via Paystack webhook (`charge.success`) or reconciliation.
3. If at least 2 members pay successfully → group proceeds → `QUALIFIED` orders confirmed.
4. If fewer than 2 members pay → group fails → all paid members receive full automatic refunds.

### 6.7 Fulfillment

1. After successful payment, inventory is reserved atomically.
2. Order is confirmed.
3. Vendor fulfills the order.

---

## 7. Public and Private Groups

| Aspect | Public Group | Private Group |
|--------|-------------|---------------|
| **Discoverability** | Listed in public group discovery | Not discoverable publicly |
| **Joining** | Any eligible customer can join | Requires invitation link or `inviteCode` |
| **Visibility** | Group details visible to all | Details hidden from non-members |
| **Capacity enforcement** | Same (2–5) | Same (2–5) |
| **Creation** | Customer selects promotion → creates public group | Customer selects promotion → creates private group with invite code |

Private groups never leak capacity, count, or membership information publicly.

---

## 8. Membership Limits and Formation Deadlines

| Rule | Value | Source |
|------|-------|--------|
| Minimum group size | 2 members (including creator) | Approved rule F |
| Maximum group size | 5 members (including creator) | Approved rule F |
| Formation window | 1 hour from creation | Approved rule F |
| Early close | At selected capacity (2–5) | Approved rule F |
| Payment window | 30 minutes after qualification | Approved rule H |
| Creator payment deadline extension | One optional 15-minute extension | Approved rule H |
| Max members per group | 5 | Stage 4 decision T13-A |
| Min members per group | 2 | Stage 4 decision T13-A |
| Group-level usage limit | Configurable, consumed at qualification | Approved rule S |
| Per-user participation limit | Configurable, consumed at order completion | Approved rule S |

Joining a group does **not** pay, does **not** reserve inventory, and does **not** consume any promotion usage limit.

---

## 9. Qualification and Payment Windows

### 9.1 Qualification

A group qualifies when at least 2 members have joined within the 1-hour formation window. At qualification:

- The discount pool is frozen: `Discount Pool = One Unit of Promoted Product Price × Promotion Percentage`.
- Per-member allocations are computed: `Discount Pool ÷ Eligible Paid Members`.
- Allocations are finalized (Option A — see Section 10 below).
- Group-level usage limit is consumed (consumed at qualification, released only if group fails).

### 9.2 Payment Window

- Opens at qualification.
- Each member has 30 minutes to pay.
- Creator may extend once by 15 minutes.
- Payment deadline is enforced by `paymentDeadlineAt` (Paystack `paid_at` is authoritative).
- Payments confirmed after the deadline do not count and are refunded.
- Groups cannot be resurrected after failure.

---

## 10. Individual Payment vs Creator-Pays-Everyone

| Aspect | Individual Payment (Default) | Creator-Pays-Everyone |
|--------|-----------------------------|----------------------|
| **Who pays** | Each member pays for their own purchase | Creator pays for all eligible members |
| **Explicit acceptance required?** | No (default) | Yes — creator must explicitly accept full amount |
| **Creator's responsibility** | Own purchase only | All members' purchases |
| **Payment reference** | Individual payment per member | One creator payment covering all allocations |
| **Refund on failure** | Individual refund per member | Creator payment refunded per allocation |
| **Can switch after qualification?** | No | No — payment mode frozen at qualification |

**T3-A (Approved):** Payment mode cannot be changed after qualification. Mode (`INDIVIDUAL` or `CREATOR_PAYS_ALL`) is frozen at qualification. A failed creator payment follows the group-failure/refund path; the creator may create a new individual-payment group.

---

## 11. Discount-Pool Calculation and Distribution

### 11.1 Formula

```
Discount Pool = One Unit of Promoted Product Price × Promotion Percentage

Discount Per Eligible Paid Member = Discount Pool ÷ Final Eligible Paid Member Count
```

### 11.2 Example (₦20,000 product, 10% promotion)

| Eligible Paid Members | Discount Pool | Discount Per Member | Each Member Pays |
|----------------------|---------------|---------------------|------------------|
| 5 | ₦2,000 | ₦400 | ₦19,600 |
| 4 | ₦2,000 | ₦500 | ₦19,500 |
| 3 | ₦2,000 | ₦666.67 (66,667 kobo) | ₦19,333.33 (66,666 kobo for one member) |
| 2 | ₦2,000 | ₦1,000 | ₦19,000 |

### 11.3 Allocation Rules

| Rule | Description |
|------|-------------|
| **Fixed pool** | Pool is based on one unit price only — not multiplied by member count |
| **Equal division** | Pool divided equally among eligible paid members |
| **Integer kobo** | All monetary values in integer kobo (no floating-point) |
| **Deterministic remainder** | Indivisible kobo remainders allocated by `(joinedAt ASC, id ASC)` order |
| **Pool never exceeded** | `SUM(allocations) ≤ pool` always |
| **Freeze at qualification** | Allocations computed once at qualification; unpaid members' shares remain unallocated |
| **No redistribution** | If a member fails to pay, their share is **not** redistributed to paying members |

### 11.4 Delivery Fee

Delivery fees are **excluded** from the discount pool. Each member pays their own delivery fee separately:
`amountKobo = (productAmountKobo − discountKobo) + deliveryFeeKobo`

### 11.5 Commission

Commission is calculated on the discounted product price (`productAmountKobo − discountKobo`). Delivery fee is excluded from the commission base. Vendor payout = gross − commission.

---

## 12. Vendor Funding and Commission Implications

### 12.1 Who Funds the Discount?

| Promotion Creator | Funding Source | `fundingVendorId` |
|-------------------|---------------|-------------------|
| Vendor | `VENDOR` | The vendor who created the promotion |
| Admin/Platform | `PLATFORM` | `NULL` |

The funding source is **snapshotted at qualification** and stored on `GroupBuyDiscountPool`. It never changes after qualification.

### 12.2 Vendor Payout Implications

- Vendor payout snapshots already use `basePriceKobo − discountKobo` (delivery excluded).
- Commission is on the discounted base price.
- Vendor payout is already reduced because commission is on a lower base.
- The discount itself is **not** a separate line item in payouts under the current snapshot model — it is implicitly reflected in the lower base price.
- **No settlement ledger exists** for discount funding reversal (deferred to a future stage).

### 12.3 Refunds After Payout

If a vendor payout is marked `PAID` and a completed refund occurs later:
- Vendor keeps the payout.
- Platform absorbs the difference.
- No clawback mechanism exists in Stage 5.

---

## 13. Group Failure, Cancellations and Refunds

### 13.1 Group Failure

A group **fails** when fewer than 2 members successfully pay by the payment deadline.

**Handling:**
- All successfully paid members receive a **full automatic refund** to their original payment method.
- Unpaid members receive **no refund** (they were never charged).
- Refunds are initiated **immediately and asynchronously** when the group fails.
- Refund processing is **idempotent**, **retryable**, and **independently trackable**.
- Submitting a refund request is **not** proof that the refund completed.

### 13.2 Voluntary Cancellation (T8-B — Approved)

A member may voluntarily cancel before their order reaches `COOKING`:

- Full refund of the member's paid amount.
- Group is re-evaluated under the group lock.
- If the group drops below 2 fulfillable paid members → group fails → remaining paid members refunded.
- Other members' allocations are **untouched**.
- Inventory/daily-cap released via reservation ledgers.

### 13.3 Partial Refunds After Completion (T9-B — Approved)

Partial refunds are permitted after order completion:
- Member stays `PAID`; order stays `COMPLETED`.
- Per-user usage is **not** released until cumulative completed refunds reach the paid amount.
- `completedRefundAmountKobo` is incremented; `refundStatus` is derived.
- Allocation snapshot is unchanged.

---

## 14. Inventory, Daily-Cap and Promotion-Usage Rules

### 14.1 Inventory

| Stage | Rule |
|-------|------|
| Joining group | No inventory reserved |
| Unpaid members | No inventory held |
| After successful payment | Inventory reserved atomically |
| Stock unavailable after payment | Affected customer fully refunded; group re-evaluated |
| Multiple stock units | `ProductDailyCounter` per product per day |
| Group Buy draft orders | Do **not** create `DailyCapReservation` at checkout |

### 14.2 Daily-Cap

| Stage | Rule |
|-------|------|
| Group Buy drafts | Do **not** create `DailyCapReservation` |
| Confirmed member order | Worker creates `DailyCapReservation` per order |
| Group failure | `GroupBuyInventoryReservation` released (not `DailyCapReservation`) |
| Personal Buy orders | Unaffected by Group Buy logic |

### 14.3 Promotion Usage Limits

| Limit Type | Consumed When | Released When |
|------------|--------------|---------------|
| **Group-level** | Group qualifies (≥2 members) | Group subsequently fails |
| **Per-user** | Member's order successfully completes | Full refund (cumulative completed refunds reach paid amount) |

Joining a group does **not** consume either limit. Qualifying a group does **not** consume per-user allowance. Paying does **not**, by itself, consume per-user allowance — only order completion does.

---

## 15. Approved Business Decisions (T1–T14)

All decisions below are **RESOLVED** and recorded in `docs/engineering/stage4-implementation-readiness.md` §3:

| ID | Decision | Summary |
|----|----------|---------|
| T1-A | `maxDiscount` on Group Buy | Ignored; validation rejects `maxDiscount` on GROUP promotions |
| T2-A | Delivery fee | Excluded from discount pool; each member pays own delivery |
| T3-A | Payment mode switching | Frozen at qualification; no switching |
| T4-A | Daily-cap unit | One unit per confirmed member order |
| T5-A | Payment deadline | Strict 30-minute deadline; no grace; late payments refunded |
| T6-A | Commission base | Discounted product price; delivery excluded |
| T7-A | Funding | Vendor funds vendor promos; platform funds admin promos |
| T8-B | Voluntary cancellation | Before `COOKING`; full refund; group re-evaluation |
| T9-B | Partial refunds after completion | Member stays `PAID`; order stays `COMPLETED` |
| T10-A | Receipt timing | At payment success; best-effort |
| T11-A | Group discovery | Public discoverable; private invite-only; QUALIFIED not joinable |
| T12-A | Promotion codes | Optional; uniqueness per `(vendorId, code)`; `purchasingType` separates PERSONAL/GROUP |
| T13-A | Group size | Creator selects max 2–5; min fixed at 2 |
| T14-A | Reconciliation cadence | Split cadence per stage3-database-design.md §15.1 |

---

## 16. Unresolved Decisions (Require Future Owner Approval)

The following decisions are **documented but not approved**. They must not be silently treated as settled:

| Decision | Description | Why Unresolved |
|----------|-------------|----------------|
| Settlement ledger | How vendor/platform discount funding is represented in payout ledgers | No settlement ledger table designed |
| Payout adjustment mechanism | How vendor payouts are adjusted for discount funding | No separate deduction line item |
| Refund reversal of funding | How funding exposure is reversed on completed refunds | Not designed |
| Settlement reporting | Dispute investigation and settlement reports | Not designed |
| Clawback of vendor payout | Reversing a `PAID` payout after completed refund | No mechanism exists |

**Stage 5 can implement Group Buy without a settlement ledger** because:
- The discount is already reflected in the discounted product price.
- Vendor payout snapshots already use `basePriceKobo − discountKobo`.
- Refunds return money to customers via existing paths.
- Funding visibility is available via `fundingVendorId`.
- Payout eligibility blocks orders with refund activity.

---

## 17. Business-Rule Compliance Matrix

| Rule (from promotion.md) | Status | Evidence |
|--------------------------|--------|----------|
| A. Two purchase models (Personal Buy + Group Buy) | ✅ Implemented | Personal Buy exists; Group Buy designed |
| B. Promotion creators: Admin + Vendor | ✅ Implemented | `promoController.ts`, `admin.controller.ts` |
| C. Group creators: Customers | ✅ Designed | Customer creates group from promotion |
| D. Max group membership: 5 | ✅ Decided (T13-A) | `maxMembers BETWEEN 2 AND 5` |
| E. Group Buy discounts: configurable %/fixed | ✅ Designed | `DiscountType.PERCENTAGE` / `FIXED` |
| F. Admin scope: all / category / product | ⚠️ Partially | Admin VENDOR_WIDE only; CATEGORY scope designed but not implemented |
| G. Vendor scope: own products only | ✅ Implemented | `promoController.ts:121–124` |
| H. Promotion → group creation flow | ❌ Not implemented | Customer selects promo → creates group |
| I. Personal Buy coexists | ✅ Implemented | Current system is Personal Buy |

**Legend:** ✅ Implemented | ⚠️ Partially implemented | ❌ Not implemented

---

## 18. Document Scope and Limitations

This document captures the **product vision and approved business rules** for the Promotion & Group Buy system. It does **not** authorize implementation. Implementation requires:

1. Stage 4 (`docs/engineering/stage4-implementation-readiness.md`) to be independently reviewed and approved.
2. Product-owner sign-off on all T1–T14 decisions.
3. Stage 5 migration applied and verified against disposable infrastructure.
4. Personal Buy regression verification to pass.

No source code, schema, migration, test, database, or Git state may be modified based on this document alone.

---

**End of Promotions Product Design Document.**