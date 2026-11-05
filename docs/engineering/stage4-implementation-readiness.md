# Foodi Paddi — Stage 4 Implementation-Readiness Report
### Promotion and Group Buy System (Stage 4 — Design the Backend Architecture)

**Repository:** `/home/onyeka-ifeanyi/StudioProjects/update-of-paddi-main-backend`
**Date:** 2026-11-03
**Status:** Stage 4 planning deliverable. **Planning only — Stage 5 is not authorized.**
**Prerequisites satisfied:** independent Stage 3 acceptance audit returned **PASS WITH FINDINGS** (2026-11-03, no critical/high design defects); Decision A resolved (Option A — freeze allocation at qualification); Stage 3 formally closed (`docs/engineering/stage3-acceptance-closure.md`). Product decisions **T1–T14 all explicitly decided and recorded**: T1-A (reject `maxDiscount` on GROUP promotions), T2-A (delivery fee excluded from pool; additive per member), T3-A (no payment-mode switching after qualification), T4-A (per-member daily-cap unit), T5-A (strict payment deadline; late payments refunded, no group resurrection), T6-A (commission on discounted product price; delivery excluded), T7-A/B — VENDOR funding (snapshot-only settlement model deferred), T8-B (voluntary cancellation before `COOKING`; full refund; group re-evaluation), T9-B (partial refunds after completion; member stays `PAID`; order stays `COMPLETED`; usage released only on full refund), T10-A (receipt at payment success; best-effort; non-critical), T11-A (public groups discoverable; private invite-only; QUALIFIED groups not joinable), T12-A (codes optional; uniqueness per `vendorId + code`; purchasingType separates PERSONAL/GROUP), T13-A (creator selects max 2–5; min fixed at 2), T14-A (split reconciliation cadence; design-stated job categories and frequencies).
**Reference documents:** `promotion.md`, `docs/engineering/stage3-database-design.md` (accepted Stage 3 design), `docs/engineering/stage3-acceptance-closure.md`

---

## 1. Purpose and scope

This report prepares Stage 4 of the Promotion and Group Buy plan. It defines the work to be done to make the system implementation-ready **without implementing anything**. It does not:

- modify Prisma schema, migrations, source code, tests, database, Flutter files, or Git state;
- authorize implementation of any batch;
- silently settle product questions;
- begin Stage 5.

It delivers:

1. A dependency-ordered, independently testable Stage 5 batch plan (batches 1–10).
2. Outstanding product decisions requiring explicit product-owner sign-off, with consequences.
3. Security requirements, migration strategy, and Personal Buy regression-protection plan.
4. Explicit completion criteria and a dependency order.
5. Gates for Stage 5 authorization.

---

## 2. Approved Stage 3 design invariants carried forward

The following are fixed by the accepted Stage 3 design and must not be weakened:

| Invariant | Source |
|---|---|
| Personal Buy promotion eligibility, pricing, checkout, payment, refund, isolation | `stage3-database-design.md` §3.1, §8.8 item 10, §16.6 |
| Fail-closed promotion & checkout (unrelated absence must never leak a purchase) | existing architecture; must prevail over new queries |
| One product per group; one unit per member; min 2 / max 5 including creator | approved rules; `stage3-database-design.md` §3.1, §6.4 |
| One-hour formation window; early close at capacity | §3 |
| 30-minute payment window; one optional 15-minute creator extension | §3, §12.4 |
| Group-level usage: consumed at qualification; released only on group failure | AD-2; §10.2–10.3 |
| Per-user usage: consumed at order completion; released only on full completed refund | AD-3; §10.4–10.5 |
| Members pay for their own purchase by default; creator-pays-all explicit with full responsibility | §3.1, §8.3 |
| Failed-group automatic, asynchronous, idempotent full refunds | AD-1; §11.3 |
| Inventory reserved only after successful payment, atomic checks | AD-4; §8.4–8.6 |
| `purchasingType` discriminates Personal Buy (`PERSONAL`) and Group Buy (`GROUP`) | §6.2 |
| Fixed discount pool = one unit of promoted product price × percentage; baseAllocation by integer division; deterministic kobo remainders; members ordered by `joinedAt ASC, id ASC`; remainder to the first `memberCount % pool % memberCount`-sized slice | §6.7, §9.1–9.2 |
| Option A: pool and allocations finalized at qualification (`isFinal = true`, `finalizedAt = qualifiedAt`); no post-qualification redistribution | §4, §9.3, §12.3 |
| Group Buy payments never enter the Personal Buy finalizer; routing to `finalizeGroupBuyPaymentSuccess` is required | §8.4 |
| Normalized allocations and dedicated association (`GroupBuyPaymentAllocation`); no anchor-order model | §6.8, §6.14 |
| `GroupBuyPaymentProcessing` outbox; `FOR UPDATE SKIP LOCKED`; lease fencing | §6.11, §8.5 |
| `GroupBuyInventoryReservation` ledger; release only via `releasedAt IS NULL` transition | §6.12 |
| Partial unique index on unidentified `PROCESSING` refunds per `paymentRef` | §6.15, §7.4 |
| Personal Buy untouched by creator-pays-all; Group Buy refund accounting separated from whole-payment accounting | §6.15, §8.9, §11.5 |

---

## 3. Product decisions — all resolved (T1–T14)

All product decisions have been explicitly decided and recorded below. None remain unresolved. Stage 4 planning is now complete with respect to product decisions; Stage 5 remains not authorized pending independent review, product-owner sign-off, and batch-1 migration verification against disposable infrastructure.

Decisions **T1-A**, **T8-B**, and **T9-B** were previously approved. Decisions **T2–T7** and **T10–T14** are now recorded as resolved in this section.

### T1 — `Promotion.maxDiscount` interaction with the Group Buy pool

**Question:** When a Group Buy promotion carries a non-null `maxDiscount`, what happens to the fixed discount pool?

The approved formula computes the pool as `floor(unitPrice × promotionPercentage)`. `Promotion.maxDiscount` today caps Personal Buy percentage discounts. It is not part of the approved Group Buy formula.

**Options and consequences:**

| Option | Behavior | Consequences |
|---|---|---|
| **T1-A** | Group Buy ignores `maxDiscount`; configuration validation rejects `maxDiscount` set on a `purchasingType = GROUP` promotion | Simplest; keeps the approved formula unchanged; no silent formula change; consistent with "approved pool ≥ 0 and tied to percentage". **Does not honor an admin's explicit cap if they expect it to apply.** |
| **T1-B** | Cap the pool: `discountPoolKobo = min(floor(price × bps/10000), maxDiscount)` | Honors an existing admin setting that we now silently repurpose for Group Buy; can under-discount approved promotions without any visible flag; if the admin had set `maxDiscount` carelessly, every Group Buy group's promised discount shrinks silently. |
| **T1-C** | Cap each member's allocation only, not the pool | Invalidates the "pool = exactly the allocated amount, SUM(allocations) = pool" invariant that drives refund and accounting logic; creates three amounts to reconcile instead of one. |

**APPROVED — T1-A selected (product owner decision).** Group Buy ignores `maxDiscount`; configuration validation rejects `maxDiscount` set on a `purchasingType = GROUP` promotion. The field is inert for Group Buy. **Previously blocking batch 4 and batch 2 — now unblocked for T1.**

### T8 — Voluntary member cancellation or refund request after payment

**Question:** May a paid member request refund/cancellation before the group completes? If so, on what terms and with whose approval?

Approved rules cover failure (too few paid members) and inventory failure; they do not cover voluntary post-payment cancellation. Without an explicit decision:

- the design cannot know whether to release an allocation, cancel an order, refund money, release per-user/pool usage, or re-evaluate the group;
- allowing it silently would let a customer cancel after a vendor is already cooking;
- disallowing it silently would strand customers who change their minds.

**Options and consequences:**

| Option | Behavior | Consequences |
|---|---|---|
| **T8-A** | Not permitted by default. A full refund still follows Section 11 lifecycle if an authorized operator creates an authorized refund | No voluntary cancellation API; most predictable for MVP; must be enforced in validation and communicated in API contract; customer must contact support. |
| **T8-B** | Permitted before the member's order reaches `COOKING`; full refund; group re-evaluation (may drop below two fulfillable paid members → group fails → remaining paid members refunded) | Requires membership/eligibility re-evaluation and refund wiring at the order-status layer; riskiest to launch with; needs explicit API contract and acceptance criteria in the same batch as refund logic. |
| **T8-C** | Permitted only via admin approval (two-step: "request" → "decide") with a defined window | Keeps admin in the loop; adds two endpoints and two states not present in Stage 3 design; preserves finance safety. |

**APPROVED — T8-B selected (product owner decision).** Voluntary member cancellation permitted before order reaches `COOKING`; full refund of member's paid amount; group re-evaluated under `GroupBuyGroup` lock (may fail group if <2 paid confirmed members remain); other members' allocations untouched; inventory/daily-cap released via reservation ledgers. **Previously blocking batch 7 and batch 2 — now unblocked for T8.**

### T9 — Partial refunds after order completion — APPROVED (T9-B)

**Question:** May Group Buy orders be partially refunded after completion? Consequences for per-user usage and discount entitlement financial entitlement.

**APPROVED — T9-B selected (product owner decision).** Partial refunds are permitted after order completion: member stays `PAID`; order remains `COMPLETED`; per-user usage not released until cumulative completed refunds reach paid amount; `completedRefundAmountKobo` incremented; `refundStatus` derived; allocation snapshot unchanged. **Previously blocking batch 7 and batch 10 — now unblocked for T9.**

### T4 — Daily-cap unit for Group Buy — APPROVED (T4-A)

**Decision:** T4-A selected. One daily-cap unit per confirmed member order (`DailyCapReservation` per `orderId, productId, day`), matching Personal Buy. A five-member group consumes up to five units of a product's daily cap.

**Rationale:** Matches rule P (one unit per member); `reserveDailyCap` (`scheduling.service.ts`) is inherently per-order; per-member cap release under T8-B/T9-B is well-defined (a group-level unit would make per-member refund release undefined).

**Blocking:** Was blocking batch 6 — now unblocked for T4.

### T2 — Delivery fee / order-level charges in Group Buy — APPROVED (T2-A)

**Decision:** T2-A selected. Each member pays their own delivery fee separately. Delivery is **excluded** from the discount pool. `amountKobo = (productAmountKobo − discountKobo) + deliveryFeeKobo`. The discount pool remains `floor(unitPrice × promotionPercentage)` on product price only (rule L + Decision A).

**Rationale:** Keeps the approved discount formula unchanged; delivery is independent order-level charge, not part of the discount; no silent formula change; `SUM(allocatedDiscountKobo) = discountPoolKobo` invariant preserved; consistent with "approved pool ≥ 0 and tied to percentage".

**Blocking:** Was blocking batch 5 — now unblocked for T2.

### T3 — Payment-mode switching after failure — APPROVED (T3-A)

**Decision:** T3-A selected. Payment mode cannot be changed after qualification. Mode (`INDIVIDUAL` or `CREATOR_PAYS_ALL`) is frozen at qualification (§12.3 step 8 of stage3-database-design.md). A failed creator payment follows the group-failure/refund path (T8-B cascade); the creator may create a new individual-payment group.

**Rationale:** Preserves Decision A (frozen allocations, no post-payment redistribution); consistent with rule I (creator-pays-all requires explicit upfront acceptance) and rule K (only confirmed successful payments count toward min-2).

**Blocking:** Was blocking batch 5 — now unblocked for T3.

### T5 — Late-payment boundary — APPROVED (T5-A)

**Decision:** T5-A selected. Strict payment deadline. Paystack `paid_at` timestamp authoritative; local success time is fallback (§12.4 of stage3-database-design.md). No grace period. A payment confirmed after `paymentDeadlineAt` does not count toward the group; it is refunded to the payer and does not resurrect a failed group (§12.5 of stage3-database-design.md).

**Rationale:** Forced by rule H (30-minute payment window) + §12.5 (no group resurrection). Deterministic; no hidden grace constant; no ambiguity in group-failure accounting.

**Blocking:** Was blocking batch 5 and batch 9 — now unblocked for T5.

### T6 — Commission base on discounted Group Buy orders — APPROVED (T6-A)

**Decision:** T6-A selected. Commission is calculated on the discounted product price (`productAmountKobo − discountKobo`). Delivery fee is excluded from the commission base (`orderSnapshot.service.ts`: `basePriceKobo` is net of discount, delivery fee excluded). Vendor payout = gross − commission.

**Rationale:** Reuses existing `orderSnapshot.service.ts` logic unchanged; commission on actual discounted revenue; consistent with rule M (vendor funds discount — vendor should not pay commission on revenue never received) and T7=VENDOR.

**Blocking:** Was blocking batch 5 finance — now unblocked for T6.

### T7 — Funding settlement and reporting — APPROVED (T7-A — VENDOR funding)

**Decision:** T7-A selected. The vendor funds the Group Buy discount (`promotion.md` rule M). `GroupBuyDiscountPool.fundingSource` = `VENDOR` with `fundingVendorId` = promotion's vendor id, snapshotted at qualification (§6.6 of stage3-database-design.md). `GroupBuyDiscountPool.fundingSource` = `PLATFORM` with `fundingVendorId = NULL` for admin-created promotions.

**Settlement model (deferred):** The funding responsibility is snapshotted at qualification and stored on `GroupBuyDiscountPool`. No settlement ledger, payout adjustment, or automatic transfer is designed in Stage 4/5. Settlement happens through existing vendor payout / platform finance processes outside this feature, informed by the snapshot. A dedicated settlement ledger may be designed in a later stage with finance/ops input.

**Rationale:** Preserves rule M (funding source preserved, snapshot at qualification); zero new money-movement risk in Stage 5; funding visible for reporting via `fundingVendorId` index; deferred settlement is low-risk and appropriate for planning-only Stage 4.

**Blocking:** Was blocking batch 5 and reporting — now unblocked for T7 (settlement ledger itself remains deferred to a later stage).

### T10 — Receipt timing — APPROVED (T10-A)

**Decision:** T10-A selected. Receipt generation occurs at payment success (existing `generateReceipt(payment.id)` in `paymentFinalizer.service.ts`), best-effort/non-critical. Receipt generation does not imply order confirmation; order-confirmation notifications wait for the worker (§18.2 of stage3-database-design.md).

**Blocking:** Was blocking batch 5 and batch 10 — now unblocked for T10.

### T11 — Group discovery — APPROVED (T11-A)

**Decision:** T11-A selected. Public groups are discoverable via the existing index `[visibility, status, formationDeadlineAt]`; private groups are invite-only (`inviteCode @unique`). QUALIFIED groups cannot accept additional members (joining restricted to `FORMING` status within the formation window, §12.2 of stage3-database-design.md).

**Blocking:** Was not a blocker — resolved for completeness.

### T12 — Promotion-code semantics — APPROVED (T12-A)

**Decision:** T12-A selected. Codes are optional for Group Buy (automatic `code == null` or code-gated `code != null`, same pattern as Personal Buy `promotionPricing.service.ts`). Code uniqueness is per `(vendorId, code)` (`@@unique([vendorId, code])` preserved). `purchasingType` separates PERSONAL and GROUP campaigns (S3/S15 isolation). A code created for a Group Buy promotion cannot be redeemed in a Personal Buy context and vice versa.

**Blocking:** Was not a blocker — resolved for completeness.

### T13 — Group-size configuration — APPROVED (T13-A)

**Decision:** T13-A selected. Creator selects `maxMembers` within fixed range [2, 5] (default 5). `minMembers` fixed at 2. Both enforced by database check constraints (`maxMembers BETWEEN 2 AND 5`, `minMembers = 2`).

**Blocking:** Was not a blocker — resolved for completeness.

### T14 — Reconciliation cadence — APPROVED (T14-A — SPLIT)

**Decision:** T14-A selected. Split reconciliation cadence following the existing design's stated job categories and frequencies (§15.1 of stage3-database-design.md):

| Cadence category | Jobs |
|---|---|
| Every minute | `groupBuyFormationDeadlineJob`, `groupBuyPaymentDeadlineJob`, `groupBuyDraftExpiryJob` |
| On formation close / retry | `groupBuyQualificationJob` |
| Continuous processing | `groupBuyPaymentProcessingWorker`, `groupBuyRefundWorker` |
| Every few minutes | `groupBuyRefundReconciliationJob`, `groupBuyInventoryReleaseJob`, `groupBuyOutboxRepairJob` |
| Hourly or daily | `groupBuyUsageReconciliationJob` |

**No cron enabled by default.** Stage 5 must obtain separate explicit authorization before enabling any scheduled job (§15.2 of stage3-database-design.md; Stage 4 gate item 5). Exact minute tuning is a Stage 5 operations decision.

**Blocking:** Was not a blocker — resolved for completeness.

**T1–T14 all resolved.** No product decisions remain unresolved for Stage 4.

---

## 4. Security requirements (all batches)

| # | Requirement | Applying batch |
|---|---|---|
| S1 | All Group Buy mutation endpoints require `authenticate`; vendor/admin endpoints require the matching role check and ownership/scope validation (`authenticate` + role middleware pattern used today by `productRoutes.ts`, `promoRoutes.ts`) | 2, 3, 4, 5, 7 |
| S2 | Vendor promotions cannot target another vendor's products; `CATEGORY` is admin-only (`product.vendorId = promotion.vendorId` re-checked at eligibility) | 2 |
| S3 | Personal Buy promotions must never satisfy a Group Buy condition; Group Buy promotions must never satisfy a Personal Buy condition (`purchasingType` filter at every eligibility/discovery query) | all promotion-touching batches |
| S4 | No financial value is trusted from the client (no `amount`, `discount`, `allocation`, `usageCount` from request bodies) | 4, 5, 7 |
| S5 | Every mutation endpoint enforcing capacity/limits is idempotent or guarded by a transaction + conditional check (row lock or `updateMany … where { … }`); double-tap must not double-create a group, double-join, or double-reserve stock | 3, 4, 5, 6 |
| S6 | Refund endpoints validate that the request concerns the actor's own order (or admin) before creating a `RefundRequest`; never trust client `orderId`/`paymentRef` alone | 7 |
| S7 | Webhook endpoints: signature validation, rate limit, replay claim, no raw secrets in logs | 8 |
| S8 | Workers must never re-confirm a settled order twice; all state changes are conditional compare-and-set transitions | 8, 9 |
| S9 | Group operations validate visibility (`PUBLIC`/`PRIVATE`) and membership/ownership before any state transition; private groups never leak capacity/count publicly | 3 |
| S10 | Group Buy features flag-gated until rollout; defaults disabled | all |
| S11 | No PII in logs or metrics; redact references | 8, 10 |
| S12 | Step-up or admin gate for destructive operations (fail a group, manual refund) | 7, 8 |
| S13 | Rate limiting on formation/join/payment endpoints | 3, 4, 5 |
| S14 | Input validation with the existing zod schema pattern (`src/validations/`) | 2, 3, 4, 5, 7 |
| S15 | Re-exports from Personal Buy paths must not widen authorization (e.g. customer promo eligibility stays `purchasingType = PERSONAL`) | all |

---

## 5. Migration strategy (batch 1 detail, summarized here)

Steps must be additive-only; no existing column is removed or renamed; existing Personal Buy rows remain valid:

1. Add new enums; add `CATEGORY` to `PromotionScope`.
2. Create new tables (`GroupBuyGroup`, `GroupBuyMember`, `GroupBuyDiscountPool`, `GroupBuyDiscountAllocation`, `GroupBuyPaymentAllocation`, `GroupBuyGroupUsage`, `GroupBuyUserUsage`, `GroupBuyPaymentProcessing`, `GroupBuyInventoryReservation`), and raw-SQL check constraints + partial unique index on `RefundRequest`.
3. Additive nullable columns: `Order.groupBuyGroupId`, `Order.groupBuyMemberId`, `Payment.groupBuyGroupId`, `Payment.groupBuyMemberId`, `RefundRequest.groupBuy*`.
4. Partial indexes for Group Buy nullable columns; see `stage3-database-design.md` §16.2.
5. Backfill checks: every existing promotion is `PERSONAL`; all Group Buy columns null on existing rows; `_PromotionCategories` empty.
6. Tests: `npx prisma migrate deploy` against disposable PG; schema drift check; migration chain integrity test; enum alteration migration order.
7. Authorization: normal reviewed migration only — **never** `prisma db push`.

---

## 6. Personal Buy regression-protection plan

| Path | Guard | Batch |
|---|---|---|
| Customer promo discovery / eligibility / checkout | `purchasingType = PERSONAL` filter | 2, 10 |
| Product-detail promotion resolution (`promotionPricing.service.ts`) | `purchasingType = PERSONAL` only; Group Buy never attached as ordinary discount | 2, 10 |
| Apply-promo / promo-code redemption | `purchasingType = PERSONAL` | 2, 10 |
| Finalization `finalizePaymentSuccess` | unchanged for Personal Buy; Group Buy routed away | 5, 10 |
| Inventory restore `restoreStockForOrders` | skip Group Buy orders (`groupBuyMemberId != null`) | 6, 10 |
| `expireAwaitingPaymentJob` | skip Group Buy orders | 6, 10 |
| Release daily caps | skip Group Buy orders | 6, 10 |
| Refund processing | member-level only for Group Buy; Personal Buy path unchanged | 7, 10 |
| `Promotion` uniqueness `@@unique([vendorId, code])` | preserved | 1 |
| Rollback safety | rollback plan in `stage3-database-design.md` §16.5; no data destruction of financial history | 1 |

Acceptance evidence for batch 10 must include a full Personal Buy regression suite result recorded against disposable infrastructure, not just claims.

---

## 7. Stage 5 — independently testable implementation batches

**Notation:** each entry lists: Existing affected → New → Database moves → Security → Unit/Integration/Concurrency tests → Dependencies → Completion criteria.

### Batch 1 — Database schema and migration (Blocking: everything)

- **Existing:** `prisma/schema.prisma` (read-only baseline), `prisma/migrations/` (incremental authority), `migration_lock.toml` provider `postgresql`.
- **New:** migration directory `prisma/migrations/<timestamp>_group_buy/`; raw SQL constraint/index file; migration test(s) for chain integrity and zero unexpected drift.
- **DB moves:** new enums (`PurchasingType`, `GroupBuyGroupStatus`, `MemberStatus`, …); new tables; additive nullable columns on `Promotion`, `Order`, `Payment`, `RefundRequest`; partial indexes; check constraints; raw-SQL partial unique index.
  - **Data backfill check:** all existing promotions → `purchasingType = PERSONAL` (schema default); all existing Group Buy columns null.
- **Security:** migration only via reviewed path; never `db push` on shared/prod DB; backups preserved.
- **Tests:** migration applies cleanly on disposable PG 18; `migrate status` clean; `migrate diff` reports no schema object outside expectations; enum alteration order respected; all FK/check constraints asserted by migration tests; Personal Buy migration tests unchanged (existing `prisma/migrations` chain must apply cleanly top to bottom).
- **Completion criteria:** migration applies from empty state; `prisma migrate status` up to date; zero drift; Personal Buy untouched (`SELECT` checks return 0 unexpected rows); chain integrity test passes.

### Batch 2 — Promotion targeting, ownership and eligibility

- **Existing:** `promoController.ts` (vendor CRUD), `admin.controller.ts` (platform promo creation at `POST /admin/promotions` — vendorId null only), `promotionPricing.service.ts`, `promoService.ts`, `customerPromotions.routes.ts`, `product.service.ts`, `homeFeed.service.ts`, `catalogController.ts`, `productController.ts`, `vendorOrderVisibility`.
- **New:** `GroupBuyPromotionAdminValidation` (validation layer), `promotionEligibility.service.ts` extension or new `groupBuyEligibility.service.ts`, admin Group Buy promotion endpoints, vendor Group Buy promotion endpoints (`purchasingType` required), tests.
- **DB moves:** `Promotion.purchasingType`, `Promotion.groupLevelUsageLimit`, `Promotion.groupLevelUsedCount`, `Promotion.perUserGroupLimit`; `categories` implicit m2m for `CATEGORY`.
- **Security:** S1, S2, S3, S4, S15; admin-only `CATEGORY`; reject invalid combinations; fail-closed eligibility.
- **Unit:** eligibility for `SINGLE_PRODUCT`, `SELECTED_PRODUCTS`, `VENDOR_WIDE`, `CATEGORY`; vendor cannot target another vendor; `purchasingType = GROUP` requires `PERCENTAGE`; no stacking with promo codes; inactive/out-of-window promotions rejected; `maxDiscount` rejected on `purchasingType = GROUP` promotions per approved T1-A (validation error at creation/update; field inert for Group Buy).
- **Integration:** real HTTP: admin creates Group Buy promotion; vendor creates Group Buy promotion (own products only); customer discovers only Personal Buy for Personal Buy and Group Buy only via Group Buy surfaces; Personal Buy eligibility unaffected.
- **Dependencies:** batch 1.
- **Completion criteria:** eligibility matrix passes; no Personal Buy promotion attaches to a Group Buy purchase; no Group Buy promotion reachable through count/eligibility queries expecting `PERSONAL`; endpoints fail closed; 400 on invalid `purchasingType`.

### Batch 3 — Group creation, invitations and membership

- **Existing:** `cartController.ts` (auth check pattern), `orderController.ts`, routes setup in `server.ts` (`/api/groups`, `/api/promosGroupBuy/*` to be added), `vendorOrderVisibility.ts`, `src/validations/`.
- **New:** `groupBuy.routes.ts`, `groupBuyFormation.service.ts` (create group), `groupMembership.service.ts` (join/leave), `groupBuyInvite.service.ts` (private invite code), `groupBuyMembershipGuard.ts`, zod schemas, unit tests, integration tests.
- **DB moves:** none beyond batch 1.
- **Security:** S1, S4, S5, S9, S10, S13, S14; private invite code unguessable and unique; no membership without explicit consent; creator is first member; capacity enforced transactionally (2–5; selected capacity); joining does **not** reserve stock/payment/usage.
- **Unit:** formation window; early close at capacity; capacity bounds; duplicate join rejection; private group access control; expiry.
- **Concurrency tests:** two concurrent joins for the last capacity slot → exactly one wins; concurrent create/cancel.
- **Dependencies:** batches 1, 2.
- **Completion criteria:** create/join/cancel/expire all work under concurrency; private groups never enumerate; Personal Buy flow unchanged.

### Batch 4 — Qualification and frozen discount allocation

- **Existing:** `promotionPricing.service.ts`, `cartSummary.service.ts`, order snapshot helpers (`orderSnapshot.service.ts`), `promotionPricing.service.ts`, `updateOrderStatus` completion path.
- **New:** `qualification.service.ts`, `groupBuyDiscountAllocation.ts` (pure function: basis points, floor division, deterministic remainder), `groupQualifiedEventHandler`, int-kobo unit tests with examples from `promotion.md` (₦20,000 product; 5/4/3/2 members; three-member exact-kobo example preserved).
- **Design requirement:** qualification query and writes run under `GroupBuyGroup` row lock, then `Promotion` lock; allocation written once at qualification with `isFinal = true`, `finalizedAt = qualifiedAt`; **no post-qualification redistribution** (Option A).
- **DB moves:** none beyond batch 1.
- **Security:** S1, S4, S5, S14; read-only from eligible membership set determined by committed state.
- **Unit (pure):** `floor(price × bps / 10000)`; remainder distribution by `(joinedAt ASC, id ASC)`; sums exactly equal pool; non-negative allocations; funding source snapshot; `isFinal` behaviour per Option A.
- **Unit (transaction):** qualification under lock; fewer than two eligible → `EXPIRED`; per-user hold creation; group-level usage consumption/release inside the Promotion lock; rollback leaves no partial state.
- **Integration:** real HTTP: select promotion → qualification path simulated; group-level usage consumed once; duplicate qualification attempt is a no-op.
- **Concurrency:** two qualifications racing on same group; two qualifications racing on a shared promotion limit; crash mid-transaction recovers.
- **Dependencies:** batches 2 and 3.
- **Completion criteria:** Option A fully deterministic; frozen set matches paid members at window end; undistributed shares remain undistributed (`SUM(allocations) = pool − unallocated remainder` measurable and correct); all races resolved by the lock or the conditional update; rollback safety proven.

### Batch 5 — Payment allocation and Group Buy finalization

- **Existing:** `paymentFinalizer.service.ts` (`finalizePaymentSuccess`, `runFinalizer`, `getOrdersForPayment`, `claimPaymentStatus`), `paymentService.ts` (`initializePayment`, `verifyPayment`), `verifyPaymentBeforeFulfillment`, `verifyPendingPayments`, `admin.controller.ts` (admin flow), `orderController.ts` (status updates).
- **New:** `finalizeGroupBuyPaymentSuccess` service (full rewrite — NOT a branch of `finalizePaymentSuccess`), `groupBuyPaymentAllocation.service.ts`, Group Buy routes for payment initiation, Group Buy checkout integration, unit tests, integration tests, concurrency tests.
- **Design requirement:** one creator `Payment` covers N allocations; `idemKey` shared; `GroupBuyPaymentAllocation` authoritative; `Payment.orderId` = FK satisfier only (any one covered member order — the design explicitly rejects the anchor model); stock is NOT reserved at checkout; payment success inserts `GroupBuyPaymentProcessing` only.
- **Security:** S1, S3–S6, S10, S13–S15; creator-pays-all requires explicit acceptance of the amount; no charge without verified Paystack success; finalization idempotent.
- **Unit:** payment initiation for individual and creator modes; allocations sum to `Payment.amount`; `getOrdersForPayment` Group Buy path returns correct set (the ordinary `finalizePaymentSuccess` must NOT be invoked for Group Buy payments); verification callbacks.
- **Integration:** real Paystack sandbox flow; route from webhook to new service; verify allocations; receipt generation does not imply order confirmation; confirm order only after stock+cap reservation.
- **Concurrency:** concurrent confirmation of same payment; expired-payment replay; allocation sum verification under parallel attempts.
- **Dependencies:** batches 1, 2, 3, 4.
- **Completion criteria:** the new service exists and is used; ordinary finalizer unchanged for Personal Buy; creator-pays-all covers only its paid members; allocations reconcile to the kobo; webhook entry never confirms a Group Buy order.

### Batch 6 — Inventory and daily-cap reservations

- **Existing:** `inventory.service.ts` (`reserveStockForItems`, `restoreStockForOrders`), `scheduling.service.ts` (`reserveDailyCap`, `releaseDailyCap`, `releaseOrderDailyCaps`), `cartController.ts` (checkout), `expireAwaitingPaymentJob.ts`, `orderController.ts` (cancellation), `cartController.ts` (expiry via `verifyPendingPayments`).
- **New:** `groupBuyInventory.service.ts` (worker reservation), `expireAwaitingPaymentJob` Group Buy guard (`groupBuyMemberId != null` filter), `groupBuyDraftExpiryJob`, `groupBuyInventoryReleaseJob` (or reuse `expireAwaitingPaymentJob` with discriminator), unit tests, integration/concurrency tests.
- **Design requirement:** draft orders never reserve stock/cap; worker confirms → reserves stock then cap in ONE transaction; release via `GroupBuyInventoryReservation.releasedAt IS NULL`; Personal Buy paths skip Group Buy.
- **Security:** S5, S8, S10.
- **Unit:** reservation idempotent per `orderId`; cap reservation idempotent per `(orderId, productId, day)`; zero-cap and stock-contention paths; rollback leaves clean state.
- **Integration:** real API order placed; payment captured; worker executed; stock decremented exactly once; cap consumed exactly once; expiry path does not touch Group Buy; cancellation path releases correctly.
- **Concurrency:** two workers for the same member; two members racing on one stock unit; cap race; crash after commit vs before — all must not double-release or leak.
- **Dependencies:** batches 1, 3, 4, 5.
- **Completion criteria:** reservation round-trip proven on real disposable infra; rollback clean; nothing double-released; Group Buy does not leak into ordinary paths.

### Batch 7 — Refund processing and recovery (AD-1)

- **Existing:** `refundFinalizer.service.ts` (`completeRefund`, `failRefund`, `matchRefundRequest`), `admin.controller.ts` (refund reservation under `Payment` lock), `verifyPendingRefunds` (reconciliation), `paymentController.ts` (customer refund request), `refundObligation.service.ts`.
- **New:** `groupBuyRefundWorker.ts`, member-level refund wiring inside `completeRefund` (Group Buy branch), `groupBuyPaymentAllocation.reservedRefundAmountKobo` decrement path in `failRefund`, usage release wiring on full member refund, reconciliation extension in `verifyPendingRefunds`, unit tests, integration tests, concurrency tests.
- **Design requirement:** lock order `Payment` → `RefundRequest` (NOT current order — requires explicit reorder); cumulative completed refunds only; no `isFullRefund` boolean; never cancel unrelated member orders in creator-pays-all; refund worker submits automatically; partial unique index active.
- **Security:** S1, S4, S6, S8, S10, S12.
- **Unit:** member-level full refund detection; usage release only on full completed refund; partial refunds don't release; creator-pays-all single allocation refund leaves other members untouched; reservation never over-commits balance; reconciliation matches unidentified refund rows; idempotency of retry.
- **Integration:** real DB: full member refund cancels only this member's order; creator-pays-all partial refund leaves the rest of the order live; group re-evaluation on below-two-threshold.
- **Concurrency:** two simultaneous refund claims; admin refund vs failed-group refund on same payment; stale-webhook replay.
- **Dependencies:** batches 1, 2, 4, 5.
- **Completion criteria:** every refund path is idempotent and safe under concurrency; `completeRefund` and `failRefund` lock order matches Section 14; no unrelated order is ever cancelled; outstanding reservation reaches zero after completion.

### Batch 8 — Webhook and outbox workers

- **Existing:** `webhook.ts` (charge.success → `finalizePaymentSuccess`), `verifyPendingPayments.ts`, `webhookReplayClaim.service.ts`, queue/workers infrastructure in `src/jobs/`, `orderController.ts`, `expireAwaitingPaymentJob.ts`.
- **New:** Group Buy path inside webhook (`if (payment.groupBuyGroupId != null)` → `finalizeGroupBuyPaymentSuccess`), `groupBuyPaymentProcessingClaim.ts`, `groupBuyPaymentProcessingWorker.ts`, `groupBuyRefundWorker.ts` (or shared pattern), metrics/logging structured redaction, integration tests.
- **Design requirement:** same `Payment=SUCCESS` transaction inserts outbox; worker claims with SKIP LOCKED + lease fencing; stale workers fence out; dead-letter on stock/cap failure; outbox repair path exists; completed tickets terminal; no Group Buy code in Personal Buy path.
- **Security:** S7, S8, S10, S11, S12.
- **Unit:** worker claim exactly-once semantics under contention; lease expiry reclaims; duplicate claim rejected; outbox fan-out; repair job idempotent; DEAD_LETTER path; specific partial-failure handling per allocation.
- **Integration:** real HTTP webhook replay tests; duplicate webhook never re-confirms; missing-outbox repair job repairs; crash scenarios covered by documented behavior.
- **Concurrency:** duplicate webhooks; concurrent workers; redelivery storms.
- **Dependencies:** batches 1, 5, 7.
- **Completion criteria:** integration tests prove: webhook → allocation processing on live infra → duplicate delivery is a no-op → outbox repair covers historical gap → dead-letter handles stock failure.

### Batch 9 — Background jobs and reconciliation

- **Existing:** `src/jobs/workers jobs/`, `verifyPendingPayments.ts`, reconciliation helpers, `expireAwaitingPaymentJob.ts`, cron/scheduler wiring in `src/server.ts` or `src/jobs/scheduler.ts`, existing reconciliation in `verifyPendingRefunds`.
- **New:** `groupBuyFormationDeadlineJob`, `groupBuyQualificationJob`, `groupBuyPaymentDeadlineJob`, `groupBuyRefundReconciliationJob`, `groupBuyInventoryReleaseJob`, `groupBuyUsageReconciliationJob`, `groupBuyOutboxRepairJob`, `groupBuyDraftExpiryJob` (implemented in batch 6; scheduling wired here), metrics/alert wiring, docs for scheduling in ops runbook.
- **Security:** S5, S8, S10; no new cron enabled without separate explicit authorization.
- **Unit:** deadline/qualification/failure transitions; idempotency per row; deferred evaluation while non-terminal processing jobs exist; reconciliation drift detection (sum vs stored counter).
- **Integration:** deadline job transitions late group only after processing jobs are terminal; failure refunds created; usage/gate releases happen; alerts formulated on drift.
- **Dependencies:** batches 1, 5, 6, 7, 8.
- **Completion criteria:** all listed jobs implemented and idempotent; none enabled by default until explicitly authorized; reconciliation runs clean on seeded data set; failure lifecycle proven on real disposable infra.

### Batch 10 — Security hardening and Personal Buy regression testing

- **Existing:** every Personal Buy module touched by earlier batches, `src/middlewares/auth.middleware.ts` (`authenticate`/`authorizeVendor`), `vendorStatus.middleware.ts`, `rateLimit` middlewares, zod validation utilities, Personal Buy route/test suites.
- **New:** integration security suite, authorization negative tests, full Personal Buy regression suite, rollout config flag, rollback drill documentation, structured redaction of payment refs, explicit rollout plan (non-prod → flag-gated sample → canary vendors).
- **DB moves:** none.
- **Security:** S1–S15 re-tested as a whole; fuzz inputs; authorization on every route; verify no Group Buy reference leaks into Personal Buy response bodies.
- **Unit/Integration:** full Personal Buy unit suite + integration suite pass unchanged (must match pre-change counts where feasible); glidated comparison of queries against expected Personal Buy behavior; fuzz test eligibility endpoints; payoff attempt tests for creator-pays-all; negative tests for promotion misuse (apply GROUP code in Personal Buy).
- **Completion criteria:** Personal Buy regression green; authorization matrix exhaustive; rollout flag off by default; rollback path documented and tested; report produced and signed.

---

## 8. Dependency order

```
Batch 1 (Schema & migration)
  ├─> Batch 2 (Promotion targeting & eligibility)
  │     ├─> Batch 3 (Groups) ──> Batch 4 (Qualification & allocation)
  │     ├─> Batch 5 (Payment allocation & Group Buy finalization)*<──┐
  └────┴─────────────────────────────────────────────────────────────┘
                                                                      ├─> Batch 6 (Inventory & caps)
                                                                      ├─> Batch 7 (Refunds)
                                                                      ├─> Batch 8 (Webhook & workers)
                                                                      └─> Batch 9 (Jobs & reconciliation)
                                                                                └─> Batch 10 (Hardening & regression)
```

`*` Batch 5 depends on 1, 2, 3, 4; Batch 6 may start once 3 and 4 are stable; Batch 7 after 5; Batch 8 after 5 and 7; Batch 9 after 6, 7, 8; Batch 10 last.

---

## 9. Cross-batch gates — Stage 4 approval required

Before any batch merges or enables:

1. Stage 4 report reviewed and approved by the product owner and an independent reviewer.
2. Product decisions T1–T14 explicitly decided and recorded in `stage4-implementation-readiness.md` §3 and `promotion.md`: T1-A, T2-A, T3-A, T4-A, T5-A, T6-A, T7-A (VENDOR funding), T8-B, T9-B, T10-A, T11-A, T12-A, T13-A, T14-A (split cadence). No product decisions remain unresolved for Stage 4.
3. Personal Buy regression baseline captured (test counts recorded, e.g. unit 179/179 suites / 3040 tests; integration 40/40 / 425 tests as of 2026-10-22 —**re-verify live before implementing**).
4. Migration applied against a fresh disposable PostgreSQL/Redis in non-prod with zero drift verified; never `main_food_paddi`, never a shared production database.
5. Local dev only until explicitly authorized otherwise; no push/deploy until separate release gate.

---

## 10. Tracking and limitations

- This report re-reads the *design* and maps it to *implementation*. It does not re-audit Stage 3 (explicitly out of scope unless a genuine design defect is discovered).
- Stage 5 begins with one scoped batch at a time, per AGENTS.md; no batch may begin until the previous batch is reviewed.
- `CATEGORY` vs. `SELECTED_PRODUCTS` semantics for Group Buy are already decided by the accepted Stage 3 design (§13): both `PromotionScope` values are supported; `CATEGORY` is admin-only; vendor-created Group Buy promotions may not use `CATEGORY`. No new product-owner decision is required.
- Completion of batch 10 is the end of the Promotion & Group Buy track; Flutter integration (Stage 6) is separate and remains blocked pending Stage 5 acceptance.

---

## 11. Vendor Discount Settlement Design (closing the T7 design gap)

T7 is resolved as **VENDOR funding**: the vendor is responsible for funding the Group Buy discount (`promotion.md` rule M). `GroupBuyDiscountPool.fundingSource` = `VENDOR` with `fundingVendorId` = promotion's vendor id, snapshotted at qualification (§6.6 of stage3-database-design.md). For admin-created promotions, `fundingSource` = `PLATFORM` with `fundingVendorId = NULL`.

**What IS designed in Stage 4/5:**
- Funding responsibility snapshot at qualification (`fundingSource`, `fundingVendorId` frozen alongside `isFinal = true` / `finalizedAt = qualifiedAt`).
- Vendor-level financial attribution via `fundingVendorId` index.
- Group failure and late-payment refund treatment (existing `completeRefund`/`failRefund` paths handle Group Buy allocations per T8-B/T9-B/T5-A).
- Reconciliation, idempotency, and recovery for the funding snapshot itself (cross-row invariant `SUM(GroupBuyDiscountAllocation.allocatedDiscountKobo) = GroupBuyDiscountPool.discountPoolKobo`; partial unique index on unidentified `PROCESSING` refunds).
- Payout eligibility blocks orders with refund activity (`payoutEligibility.service.ts` `partitionPayoutBlockedOrders`): any `RefundRequest` in PENDING/APPROVED/PROCESSING/COMPLETED, `Payment.refundedAmount > 0`, or `Payment.status = REFUNDED` blocks payout for that order.

**What is DEFERRED to a later stage (design gap — NOT closed):**
- Ledger representation of discount funding liability and reversal entries (no settlement ledger table designed).
- Vendor payout adjustment mechanism (no separate discount-funding deduction line item in payouts).
- Full and partial refund accounting against the funding record (refunds return money to customers, but the funding party's exposure reversal is not designed).
- Settlement reporting and dispute investigation (no settlement reports or dispute audit trails designed).
- Clawback of vendor payout after completed refund (a payout marked `PAID` has no reversal mechanism).

The funding responsibility snapshot alone does **not** constitute a complete vendor discount settlement design. Stage 5 can safely implement Group Buy with vendor-funded discounts **without** a settlement ledger or payout adjustment mechanism, because:
- The discount is already reflected in the discounted product price (T6-A commission base).
- Vendor payout snapshots already use `basePriceKobo − discountKobo` (delivery excluded).
- Refunds return money to customers via existing paths; the funding party's exposure reversal is deferred.
- Funding visibility for reporting is available via `fundingVendorId`.
- Payout eligibility blocks orders with refund activity (`payoutEligibility.service.ts`), preventing payouts to orders with unresolved refunds.

**Financial and operational risks if Stage 5 proceeds without a settlement ledger:**
- Vendor payouts do not explicitly line-item the discount funding amount (implicit only via discounted base).
- No mechanism to reverse discount funding on completed refunds (could result in vendor being double-charged for discount on refunded orders).
- No dispute/audit trail for vendor funding disagreements beyond the `fundingVendorId` snapshot.
- Refunds after a payout is marked `PAID`: vendor keeps the payout, customer receives the refund, and the platform absorbs the difference. No clawback of vendor payout exists.

### A. Financial ownership

- **Who bears the discount cost?** The vendor (for vendor-created promotions) or the platform (for admin-created promotions), as recorded in `fundingSource`/`fundingVendorId` on `GroupBuyDiscountPool`.
- **How is the discount attributed to the vendor?** Via `fundingVendorId`, which snapshots `Promotion.vendorId` at qualification. The index `GroupBuyDiscountPool @@index([fundingVendorId])` supports funding reconciliation queries by vendor.
- **How is vendor-funded distinguished from other funding?** `GroupBuyFundingSource` enum (`VENDOR` / `PLATFORM`) on `GroupBuyDiscountPool`. A check constraint ensures `VENDOR` requires non-null `fundingVendorId` and `PLATFORM` requires null `fundingVendorId` (§7.4 raw SQL).
- **How is funding frozen at qualification?** `fundingSource`/`fundingVendorId` are written once at qualification (step 8 of §12.3), alongside `isFinal = true` and `finalizedAt = qualifiedAt`. The `version` field defaults to 1 and is not incremented.

### B. Ledger representation (proposed, not yet implemented)

The following is a **design requirement for a future stage**, not an existing implementation:

| Event | When recorded | Ledger entry | Associated entities |
|-------|--------------|--------------|-------------------|
| Discount funding liability created | At qualification | `GroupBuyDiscountPool` row with `fundingSource = VENDOR`, `fundingVendorId` | Group, promotion, vendor |
| Discount applied to member order | At qualification (allocation frozen) | `GroupBuyDiscountAllocation.allocatedDiscountKobo` | Group, member, allocation |
| Discount reflected in vendor payout | At payout run (future stage) | Commission on `basePriceKobo − discountKobo`; vendor payout reduced accordingly | Order, payment, vendor |
| Refund reverses discount funding | On completed refund (future settlement) | Reversal of discount funding entry | Refund, allocation, vendor |

**Duplicate prevention:** `@@unique([groupId])` on `GroupBuyDiscountPool` ensures one pool per group. `@@unique([paymentId, memberId])` on `GroupBuyPaymentAllocation` prevents duplicate allocations.

**Reversals/corrections:** Not yet designed. A future settlement stage must define how funding corrections are represented without violating the immutability of frozen allocations (Decision A).

**Auditability:** `fundingVendorId` index + `GroupBuyDiscountPool` immutability (isFinal) provide the audit trail. No `PromotionUsage` writes for Group Buy (that ledger remains Personal Buy only).

### C. Vendor payout adjustments (proposed, not yet implemented)

The following is a **design requirement for a future stage**:

- **Vendor gross product value:** `SUM(Order.basePrice)` for the vendor's completed Group Buy orders (base price net of discount, delivery excluded).
- **Commission:** `round(basePriceKobo × commissionRate)` per `orderSnapshot.service.ts`, on the discounted base.
- **Vendor-funded discount effect:** The vendor's payout is already reduced because commission is on the discounted base. The discount itself is not a separate line item in payout under the current snapshot model — it is implicitly reflected in the lower base.
- **Delivery fees:** Excluded from commission base; paid by the customer; not part of vendor discount funding.
- **Refund behavior:** On a completed refund, `Order.commissionKobo`/`vendorPayoutKobo` snapshots are **not** unwound (existing Personal Buy behavior preserved). A future settlement stage must decide whether payout adjustments are needed for refunded Group Buy orders.
- **Creator-pays-all:** Per-allocation financial attribution via `GroupBuyPaymentAllocation`. The creator's single `Payment` covers N allocations; each allocation has its own `amountKobo`, `discountKobo`, and refund accounting. Vendor payout is per-order (per member), not per-creator-payment.

**Ambiguity in existing model:** The current snapshot model does not have a separate "vendor discount funding" line item on payouts. A future settlement stage must define whether commission-on-discounted-base is sufficient or whether an explicit discount-funding deduction is needed.

### D. Refund treatment

| Refund scenario | Discount funding treatment |
|---|---|
| Full refund before cooking (T8-B) | Member `paymentStatus = REFUNDED`; order cancelled (if cancellable); per-user usage released; vendor discount funding not reversed in Stage 5 (deferred settlement) |
| Partial refund after completion (T9-B) | Member stays `PAID`; order stays `COMPLETED`; per-user usage not released until cumulative completed ≥ paid amount; `completedRefundAmountKobo` incremented |
| Cumulative partial → full refund | At the `COMPLETED` transition where cumulative ≥ paid amount: member `paymentStatus = REFUNDED`; per-user usage released; order remains `COMPLETED` |
| Group failure | Full refunds for all paid members; group-level usage released; per-user holds released for non-completed members |
| Late payment refund | Late payment refunded; does not resurrect group; no discount funding impact |
| Failed refund / retry | `failRefund` decrements `Payment.refundedAmount` and `GroupBuyPaymentAllocation.reservedRefundAmountKobo`; no discount funding impact |
| Refund after payout PAID | Vendor keeps the payout (no clawback mechanism); customer receives refund via Paystack; platform absorbs the difference |

**Critical invariant:** A refund request in `APPROVED`/`PROCESSING` is **not** money moved. Only `COMPLETED` counts. The vendor discount funding record must not be treated as settled when a refund is merely requested or processing.

### E. Reporting and disputes (proposed, not yet implemented)

- **Vendor settlement reports:** Query `GroupBuyDiscountPool` by `fundingVendorId` to determine discount funding responsibility per vendor.
- **Vendor discount deductions:** Not yet implemented; deferred to settlement stage.
- **Group-level financial reconciliation:** `SUM(GroupBuyDiscountAllocation.allocatedDiscountKobo) = GroupBuyDiscountPool.discountPoolKobo` (cross-row invariant).
- **Member-level allocation reconciliation:** `GroupBuyPaymentAllocation.completedRefundAmountKobo <= amountKobo`; `refundStatus` derived from completed refunds.
- **Refund reconciliation:** `groupBuyRefundReconciliationJob` resolves unidentified `PROCESSING` refunds; `verifyPendingRefunds` extended for Group Buy.
- **Dispute investigation:** `fundingVendorId` + `GroupBuyDiscountPool.isFinal` + `finalizedAt` provide the audit trail for what was frozen and who is responsible.

### F. Design recommendation

**Adopt the snapshot-only model (T7-A) with explicit Stage 5 operational restrictions:**

1. `fundingSource`/`fundingVendorId` frozen at qualification on `GroupBuyDiscountPool` (already designed).
2. No settlement ledger, payout adjustment, or automatic transfer in Stage 4/5. The settlement ledger itself is a future-stage requirement with finance/operations input.
3. Funding visible for reporting via `fundingVendorId` index.
4. **Stage 5 can safely implement Group Buy with vendor-funded discounts using the snapshot-only model**, subject to operational restrictions:
   - Vendor payouts are blocked for orders with any refund activity (`Payment.refundedAmount > 0`, `Payment.status = REFUNDED`, or any `RefundRequest` in PENDING/APPROVED/PROCESSING/COMPLETED) via `payoutEligibility.partitionPayoutBlockedOrders`.
   - A payout marked `PAID` has no clawback mechanism; refunds after payout PAID result in the vendor keeping the payout and the platform absorbing the difference.
   - Payout/refund concurrency is **not** fully serialized: `lockPaymentsCoveringOrders` locks Payment rows only during eligibility check, not during payout transfer initiation. A refund can be created between eligibility check and payout initiation. This is a documented Stage 5 concurrency restriction.
5. If admin-created Group Buy promotions are added later (outside current vendor-scoped scope), T7 must be re-reviewed.

**Stage 5 requirements:** None new beyond what is already in batches 4–7 (funding source snapshot at qualification, refund accounting per allocation). Stage 5 implements vendor-funded discounts using the existing `orderSnapshot.service.ts` commission-on-discounted-base logic (T6-A), which already reduces vendor payout by the discount amount. No separate settlement ledger or payout adjustment mechanism is required for Stage 5 to operate safely, provided the payout eligibility restrictions in `payoutEligibility.service.ts` are enforced.

### A. Financial ownership

- **Who bears the discount cost?** The vendor (for vendor-created promotions) or the platform (for admin-created promotions), as recorded in `fundingSource`/`fundingVendorId` on `GroupBuyDiscountPool`.
- **How is the discount attributed to the vendor?** Via `fundingVendorId`, which snapshots `Promotion.vendorId` at qualification. The index `GroupBuyDiscountPool @@index([fundingVendorId])` supports funding reconciliation queries by vendor.
- **How is vendor-funded distinguished from other funding?** `GroupBuyFundingSource` enum (`VENDOR` / `PLATFORM`) on `GroupBuyDiscountPool`. A check constraint ensures `VENDOR` requires non-null `fundingVendorId` and `PLATFORM` requires null `fundingVendorId` (§7.4 raw SQL).
- **How is funding frozen at qualification?** `fundingSource`/`fundingVendorId` are written once at qualification (step 8 of §12.3), alongside `isFinal = true` and `finalizedAt = qualifiedAt`. The `version` field defaults to 1 and is not incremented.

### B. Ledger representation (proposed, not yet implemented)

The following is a **design requirement for a future stage**, not an existing implementation:

| Event | When recorded | Ledger entry | Associated entities |
|-------|--------------|--------------|-------------------|
| Discount funding liability created | At qualification | `GroupBuyDiscountPool` row with `fundingSource = VENDOR`, `fundingVendorId` | Group, promotion, vendor |
| Discount applied to member order | At qualification (allocation frozen) | `GroupBuyDiscountAllocation.allocatedDiscountKobo` | Group, member, allocation |
| Discount reflected in vendor payout | At payout run (future stage) | Commission on `basePriceKobo − discountKobo`; vendor payout reduced accordingly | Order, payment, vendor |
| Refund reverses discount funding | On completed refund (future settlement) | Reversal of discount funding entry | Refund, allocation, vendor |

**Duplicate prevention:** `@@unique([groupId])` on `GroupBuyDiscountPool` ensures one pool per group. `@@unique([paymentId, memberId])` on `GroupBuyPaymentAllocation` prevents duplicate allocations.

**Reversals/corrections:** Not yet designed. A future settlement stage must define how funding corrections are represented without violating the immutability of frozen allocations (Decision A).

**Auditability:** `fundingVendorId` index + `GroupBuyDiscountPool` immutability (isFinal) provide the audit trail. No `PromotionUsage` writes for Group Buy (that ledger remains Personal Buy only).

### C. Vendor payout adjustments (proposed, not yet implemented)

The following is a **design requirement for a future stage**:

- **Vendor gross product value:** `SUM(Order.basePrice)` for the vendor's completed Group Buy orders (base price net of discount, delivery excluded).
- **Commission:** `round(basePriceKobo × commissionRate)` per `orderSnapshot.service.ts`, on the discounted base.
- **Vendor-funded discount effect:** The vendor's payout is already reduced because commission is on the discounted base. The discount itself is not a separate line item in payout under the current snapshot model — it is implicitly reflected in the lower base.
- **Delivery fees:** Excluded from commission base; paid by the customer; not part of vendor discount funding.
- **Refund behavior:** On a completed refund, `Order.commissionKobo`/`vendorPayoutKobo` snapshots are **not** unwound (existing Personal Buy behavior preserved). A future settlement stage must decide whether payout adjustments are needed for refunded Group Buy orders.
- **Creator-pays-all:** Per-allocation financial attribution via `GroupBuyPaymentAllocation`. The creator's single `Payment` covers N allocations; each allocation has its own `amountKobo`, `discountKobo`, and refund accounting. Vendor payout is per-order (per member), not per-creator-payment.

**Ambiguity in existing model:** The current snapshot model does not have a separate "vendor discount funding" line item on payouts. A future settlement stage must define whether commission-on-discounted-base is sufficient or whether an explicit discount-funding deduction is needed.

### D. Refund treatment

| Refund scenario | Discount funding treatment |
|---|---|
| Full refund before cooking (T8-B) | Member `paymentStatus = REFUNDED`; order cancelled (if cancellable); per-user usage released; vendor discount funding not reversed in Stage 5 (deferred settlement) |
| Partial refund after completion (T9-B) | Member stays `PAID`; order stays `COMPLETED`; per-user usage not released until cumulative completed ≥ paid amount; `completedRefundAmountKobo` incremented |
| Cumulative partial → full refund | At the `COMPLETED` transition where cumulative ≥ paid amount: member `paymentStatus = REFUNDED`; per-user usage released; order remains `COMPLETED` |
| Group failure | Full refunds for all paid members; group-level usage released; per-user holds released for non-completed members |
| Late payment refund | Late payment refunded; does not resurrect group; no discount funding impact |
| Failed refund / retry | `failRefund` decrements `Payment.refundedAmount` and `GroupBuyPaymentAllocation.reservedRefundAmountKobo`; no discount funding impact |

**Critical invariant:** A refund request in `APPROVED`/`PROCESSING` is **not** money moved. Only `COMPLETED` counts. The vendor discount funding record must not be treated as settled when a refund is merely requested or processing.

### E. Reporting and disputes (proposed, not yet implemented)

- **Vendor settlement reports:** Query `GroupBuyDiscountPool` by `fundingVendorId` to determine discount funding responsibility per vendor.
- **Vendor discount deductions:** Not yet implemented; deferred to settlement stage.
- **Group-level financial reconciliation:** `SUM(GroupBuyDiscountAllocation.allocatedDiscountKobo) = GroupBuyDiscountPool.discountPoolKobo` (cross-row invariant).
- **Member-level allocation reconciliation:** `GroupBuyPaymentAllocation.completedRefundAmountKobo <= amountKobo`; `refundStatus` derived from completed refunds.
- **Refund reconciliation:** `groupBuyRefundReconciliationJob` resolves unidentified `PROCESSING` refunds; `verifyPendingRefunds` extended for Group Buy.
- **Dispute investigation:** `fundingVendorId` + `GroupBuyDiscountPool.isFinal` + `finalizedAt` provide the audit trail for what was frozen and who is responsible.

### F. Design recommendation

**Adopt the snapshot-only model (T7-A) with explicit Stage 5 operational restrictions:**

1. `fundingSource`/`fundingVendorId` frozen at qualification on `GroupBuyDiscountPool` (already designed).
2. No settlement ledger, payout adjustment, or automatic transfer in Stage 4/5. The settlement ledger itself is a future-stage requirement with finance/operations input.
3. Funding visible for reporting via `fundingVendorId` index.
4. **Stage 5 can safely implement Group Buy with vendor-funded discounts using the snapshot-only model**, subject to the operational safeguards in §14 (Risks and Dependencies).
5. If admin-created Group Buy promotions are added later (outside current vendor-scoped scope), T7 must be re-reviewed.

**Stage 5 requirements:** None new beyond what is already in batches 4–7 (funding source snapshot at qualification, refund accounting per allocation). Stage 5 implements vendor-funded discounts using the existing `orderSnapshot.service.ts` commission-on-discounted-base logic (T6-A), which already reduces vendor payout by the discount amount. No separate settlement ledger or payout adjustment mechanism is required for Stage 5 to operate safely.

---

## 12. Stage 4 Design Consistency Audit (T1–T14 verification)

Each decision below is verified against the existing design documents and source code. Findings are classified as:

- **Verified in existing implementation** — source code or schema already reflects the decision.
- **Specified in existing design** — the design document states the decision explicitly.
- **Proposed requirement not yet designed** — a future-stage requirement, not yet implemented.
- **Stage 5 implementation requirement** — must be implemented/tested in Stage 5.
- **Unresolved issue** — genuinely open, requires further clarification.

| ID | Decision | Evidence (file:section) | Classification | Stage 5 requirement |
|----|----------|------------------------|----------------|---------------------|
| T1 | Reject `maxDiscount` on GROUP promotions | `stage3-database-design.md` §9.5 (maxDiscount not part of Group Buy formula); `promotionPricing.service.ts` (maxDiscount caps Personal Buy only); `stage4-implementation-readiness.md` §3 (validation rejects maxDiscount on GROUP) | Verified in existing design; specified in source | Batch 2: validation rejects `maxDiscount` on `purchasingType = GROUP`; unit test for 400 on invalid |
| T2 | Delivery fee excluded from pool; additive per member | `promotion.md` §L (pool = product price × percentage); `stage3-database-design.md` §9.1 (pool formula); `orderSnapshot.service.ts` (delivery excluded from commission base); `deliveryFee.service.ts` (per-vendor delivery computation) | Specified in existing design; verified in source | Batch 5: `amountKobo = (productAmountKobo − discountKobo) + deliveryFeeKobo` per member; refund covers `amountKobo` including delivery |
| T3 | No payment-mode switching after qualification | `stage3-database-design.md` §12.3 step 8 (payment mode frozen at qualification); `promotion.md` rule I (explicit upfront acceptance); rule K (only confirmed payments count) | Specified in existing design | Batch 3: mode set at creation/qualification; guard rejects switch after qualification (400) |
| T4 | Per-member daily-cap unit | `promotion.md` §P (one unit per member); `scheduling.service.ts` `reserveDailyCap` (per `orderId, productId, day`); `stage3-database-design.md` §8.5 step 8 (daily cap per member order) | Verified in existing design; specified in source | Batch 6: `DailyCapReservation` per confirmed member order; cap exhaustion fails member only |
| T5 | Strict payment deadline; no grace | `promotion.md` §H (30-minute window); `stage3-database-design.md` §12.4 (paid_at authoritative; local fallback); §12.5 (late payment refunded, no resurrection) | Specified in existing design | Batch 5: payment deadline validation; Batch 9: `groupBuyPaymentDeadlineJob` |
| T6 | Commission on discounted product price; delivery excluded | `orderSnapshot.service.ts` `buildOrderMoneySnapshot` (basePriceKobo net of discount, delivery excluded); `stage3-database-design.md` §18.2 T6 (reuse existing snapshots) | Verified in existing implementation | Batch 5: `commissionKobo = round((productPrice − discount) × rate)`; delivery excluded from base |
| T7 | VENDOR funding; snapshot-only settlement | `promotion.md` §M (vendor funds discount); `stage3-database-design.md` §6.6 (`fundingSource`/`fundingVendorId` on `GroupBuyDiscountPool`); check constraint `GroupBuyDiscountPool_funding_check` | Specified in existing design | Batch 4: snapshot `fundingSource`/`fundingVendorId` at qualification; settlement ledger deferred |
| T8 | Cancel before COOKING; full refund; group re-evaluation | `stage3-database-design.md` §11.9 (cancellation requires product-owner decision — now resolved as T8-B); §8.9 (member-level refund); §12.7 (no reallocation after payment) | Specified in existing design; now resolved | Batch 7: member-level refund; group re-evaluation under `GroupBuyGroup` lock |
| T9 | Partial refunds after completion; member stays PAID | `stage3-database-design.md` §8.9 (partial refund: member stays PAID, order not cancelled, usage not released); §10.5 (full-refund derived from completed refunds); §11.8 (partial refund edge cases) | Specified in existing design; now resolved | Batch 7: `completedRefundAmountKobo` incremented; `refundStatus` derived; usage released only on full |
| T10 | Receipt at payment success; best-effort | `paymentFinalizer.service.ts` lines 860–872 (`generateReceipt` at payment success, best-effort); `stage3-database-design.md` §18.2 T10 | Verified in existing implementation | Batch 5: receipt generated after payment success; receipt does not imply confirmation |
| T11 | Public groups discoverable; private invite-only; QUALIFIED not joinable | `promotion.md` §E (public/private groups); `stage3-database-design.md` §12.2 (join only when FORMING + within deadline + under capacity); existing index `[visibility, status, formationDeadlineAt]` | Specified in existing design | Batch 3: discovery endpoint lists PUBLIC groups only; private join via invite code |
| T12 | Codes optional; unique per vendor+code; purchasingType separates | `@@unique([vendorId, code])` on `Promotion`; `promotionPricing.service.ts` (code==null automatic / code!=null gated); `stage3-database-design.md` §9.5 (GROUP requires PERCENTAGE) | Verified in existing design | Batch 2: GROUP code rejected in Personal Buy eligibility; no stacking (rule O) |
| T13 | Creator selects max 2–5; min fixed at 2 | `promotion.md` §F (max 5 including creator; min 2); `stage3-database-design.md` §7.4 (check constraints `maxMembers BETWEEN 2 AND 5`, `minMembers = 2`) | Specified in existing design; verified in schema constraints | Batch 3: creation validates maxMembers 2–5; concurrent join at capacity → exactly one wins |
| T14 | Split cadence; no cron by default | `stage3-database-design.md` §15.1 (job inventory with cadence categories); §15.2 (no cron enabled by default); Stage 4 gate item 5 | Specified in existing design | Batch 9: jobs implemented idempotently; none enabled by default; separate auth to enable cron |

**Cross-decision consistency:** No contradictions found among T1–T14. All are mutually consistent with Decision A, T1-A, T8-B, T9-B, T7=VENDOR, T14=SPLIT, and the approved Stage 3 invariants. Key alignments:
- T2-A + T6-A: delivery excluded from both pool and commission base.
- T3-A + T8-B: no mode switching preserves frozen allocations; creator failure follows group-failure path.
- T5-A + §12.5: strict boundary + no group resurrection.
- T4-A + T8-B/T9-B: per-member cap release under member refund/cancellation is well-defined.

---

## 13. Stage 5 Implementation Requirements

The following must be implemented/tested in Stage 5 batches 1–10:

**Batch 1 — Schema & migration:**
- New enums (`PurchasingType`, `GroupBuyGroupStatus`, `MemberStatus`, `MemberPaymentStatus`, `GroupBuyPaymentMode`, `GroupBuyFailureReason`, `GroupBuyUsageReleaseReason`, `GroupBuyProcessingStatus`, `GroupBuyProcessingFailure`, `RefundAllocationStatus`, `GroupBuyFundingSource`).
- New tables (`GroupBuyGroup`, `GroupBuyMember`, `GroupBuyDiscountPool`, `GroupBuyDiscountAllocation`, `GroupBuyPaymentAllocation`, `GroupBuyGroupUsage`, `GroupBuyUserUsage`, `GroupBuyPaymentProcessing`, `GroupBuyInventoryReservation`).
- Additive nullable columns on `Promotion` (`purchasingType`, `groupLevelUsageLimit`, `groupLevelUsedCount`, `perUserGroupLimit`), `Order` (`groupBuyGroupId`, `groupBuyMemberId`), `Payment` (`groupBuyGroupId`, `groupBuyMemberId`), `RefundRequest` (`groupBuy*`).
- Raw-SQL check constraints and partial unique index on `RefundRequest`.
- Raw-SQL check constraints on `GroupBuyGroup` (`maxMembers BETWEEN 2 AND 5`, `minMembers = 2`).
- Migration tests: applies cleanly on disposable PG 18; zero drift; chain integrity.

**Batch 2 — Promotion targeting & eligibility:**
- `GroupBuyPromotionAdminValidation` validation layer; reject `maxDiscount` on `purchasingType = GROUP` (T1-A).
- `groupBuyEligibility.service.ts` extension; `purchasingType = GROUP` requires `PERCENTAGE`; no stacking with promo codes.
- Admin/vendor Group Buy promotion endpoints; `purchasingType` required.
- Personal Buy eligibility unaffected (`purchasingType = PERSONAL` filter).

**Batch 3 — Group creation, invitations, membership:**
- `groupBuy.routes.ts`, `groupBuyFormation.service.ts`, `groupMembership.service.ts`, `groupBuyInvite.service.ts`, `groupBuyMembershipGuard.ts`.
- Capacity enforced transactionally (2–5; selected capacity); joining does not reserve stock/payment/usage.
- Private invite code unguessable and unique; no membership without explicit consent.
- Concurrency: two concurrent joins for last capacity slot → exactly one wins.

**Batch 4 — Qualification & frozen discount allocation:**
- `qualification.service.ts`, `groupBuyDiscountAllocation.ts` (pure function).
- Qualification under `GroupBuyGroup` row lock, then `Promotion` lock; `isFinal = true`, `finalizedAt = qualifiedAt`.
- No post-qualification redistribution (Decision A).
- Funding source snapshot at qualification (T7).

**Batch 5 — Payment allocation & Group Buy finalization:**
- `finalizeGroupBuyPaymentSuccess` (full rewrite, not a branch of `finalizePaymentSuccess`).
- `groupBuyPaymentAllocation.service.ts`; Group Buy routes for payment initiation.
- `amountKobo = (productAmountKobo − discountKobo) + deliveryFeeKobo` (T2-A).
- Commission on discounted base; delivery excluded (T6-A).
- Creator-pays-all covers only paid members; allocations reconcile to kobo.
- Webhook entry never confirms a Group Buy order.
- Receipt generation at payment success; best-effort; non-critical (T10-A).
- Personal Buy finalizer unchanged.

**Batch 6 — Inventory & daily-cap reservations:**
- `groupBuyInventory.service.ts` (worker reservation).
- `expireAwaitingPaymentJob` Group Buy guard (`groupBuyMemberId != null` filter).
- `groupBuyDraftExpiryJob`, `groupBuyInventoryReleaseJob`.
- Draft orders never reserve stock/cap; worker confirms → reserves stock then cap in ONE transaction.
- Release via `GroupBuyInventoryReservation.releasedAt IS NULL`; Personal Buy paths skip Group Buy.

**Batch 7 — Refund processing & recovery:**
- `groupBuyRefundWorker.ts`; member-level refund wiring inside `completeRefund`.
- `groupBuyPaymentAllocation.reservedRefundAmountKobo` decrement path in `failRefund`.
- Usage release wiring on full member refund; reconciliation extension in `verifyPendingRefunds`.
- Lock order `Payment → RefundRequest`; cumulative completed refunds only; no `isFullRefund` boolean.
- Never cancel unrelated member orders in creator-pays-all.

**Batch 8 — Webhook & outbox workers:**
- Group Buy path inside webhook (`payment.groupBuyGroupId != null` → `finalizeGroupBuyPaymentSuccess`).
- `groupBuyPaymentProcessingClaim.ts`, `groupBuyPaymentProcessingWorker.ts`.
- Worker claims with SKIP LOCKED + lease fencing; stale workers fence out; dead-letter on stock/cap failure.
- Outbox repair path; completed tickets terminal.

**Batch 9 — Background jobs & reconciliation:**
- `groupBuyFormationDeadlineJob`, `groupBuyQualificationJob`, `groupBuyPaymentDeadlineJob`, `groupBuyRefundReconciliationJob`, `groupBuyInventoryReleaseJob`, `groupBuyUsageReconciliationJob`, `groupBuyOutboxRepairJob`.
- `groupBuyDraftExpiryJob` (implemented in batch 6; scheduling wired here).
- No new cron enabled without separate explicit authorization.
- Idempotency per row; deferred evaluation while non-terminal processing jobs exist.

**Batch 10 — Security hardening & Personal Buy regression:**
- Integration security suite; authorization negative tests; full Personal Buy regression suite.
- Rollout config flag; rollback drill documentation; structured redaction of payment refs.
- Verify no Group Buy reference leaks into Personal Buy response bodies.
- Full Personal Buy unit + integration suite pass unchanged.

---

## 14. Risks and Dependencies

### Critical

| Risk | Impact | Mitigation |
|------|--------|------------|
| Payout/refund concurrency gap | Refund can be created between payout eligibility check and payout transfer initiation; payout marked `PAID` has no clawback; vendor keeps payout and platform absorbs refund difference | Payout eligibility blocks orders with refund activity (`payoutEligibility.service.ts`); refunds after payout `PAID` are a documented Stage 5 risk with no clawback mechanism. A settlement ledger or payout reversal mechanism is deferred to a later stage. |
| Settlement ledger deferred (T7) | Vendor discount funding not auto-settled in Stage 5 | Explicitly documented as deferred; snapshot-only model provides reporting visibility |
| `CATEGORY` vs `SELECTED_PRODUCTS` semantics open | Could affect Group Buy promotion targeting | Documented as open in Stage 4; not a blocker for T1–T14 |

### High

| Risk | Impact | Mitigation |
|------|--------|------------|
| `completeRefund`/`failRefund` lock order reorder | Deadlock risk with group-failure transactions if not reordered | Documented in §8.8 item 12; Stage 5 batch 7 |
| `finalizeGroupBuyPaymentSuccess` as full rewrite | Personal Buy regression if branched incorrectly | Documented as full rewrite; Batch 5 completion criteria require ordinary finalizer unchanged |

### Medium

| Risk | Impact | Mitigation |
|------|--------|------------|
| T2 delivery fee excluded from pool | Delivery excluded from discount pool and commission base; per-member additive mechanism approved (T2-A) | Approved decision; no business choice remains |
| T14 exact minute tuning | Operations decision, not product decision | Design-stated cadence categories; exact tuning deferred to Stage 5 ops |

### Low

| Risk | Impact | Mitigation |
|------|--------|------------|
| `groupBuyDraftExpiryJob` releasing `GroupBuyInventoryReservation` normally none | Defensive no-op for unpaid drafts | Documented; no functional risk |

### Dependencies

- All T1–T14 decisions resolved; no product decision blocks Stage 5 batches.
- T7 settlement ledger deferred to a later finance/operations stage (not a Stage 5 blocker; snapshot-only model is safe for Stage 5 per §11.F with payout eligibility restrictions).
- Batch 1 migration verification against disposable infrastructure required before Stage 5 begins.
- Stage 4 independent review and product-owner approval required before Stage 5.
- Personal Buy regression baseline captured and re-verified live before implementing.

---

## 15. Acceptance Criteria

Before Stage 5 batch 1 may begin:

1. Stage 4 report reviewed and approved by product owner and independent reviewer (§9 gate item 1).
2. All T1–T14 decisions explicitly decided and recorded (§9 gate item 2) — **complete**.
3. Personal Buy regression baseline captured; re-verify live before implementing (§9 gate item 3).
4. Migration applied against fresh disposable PostgreSQL/Redis in non-prod with zero drift verified (§9 gate item 4).
5. Local dev only until explicitly authorized; no push/deploy until separate release gate (§9 gate item 5).

Before any Stage 5 batch merges:

- Batch completion criteria as listed in §13 for each batch.
- Personal Buy regression suite passes unchanged (batch 10).
- No Group Buy reference leaks into Personal Buy response bodies (batch 10).
- Migration chain integrity test passes (batch 1).

---

## 16. Remaining Unresolved Matters

The following are genuinely open and require further product or technical clarification (not product decisions already resolved):

1. **Settlement ledger and payout adjustment mechanism** — Deferred to a later stage with finance/operations input. T7=VENDOR is fixed; the settlement ledger itself is not designed in Stage 4/5. Stage 5 can safely proceed without it (snapshot-only model is safe; see §11.F), but vendor discount funding reversal on completed refunds and explicit payout deduction line items require a later stage.
2. **Exact T14 cron intervals** — Stage 5 operations decision; design-stated cadence categories are the starting point; separate authorization required to enable any cron.
3. **Admin-created Group Buy promotions** — Outside current vendor-scoped scope; if added later, T7 must be re-reviewed (PLATFORM funding path exists in schema).

---

## 17. Stage 4 Readiness Conclusion

**Status: READY WITH EXPLICIT STAGE 5 RESTRICTIONS**

All product decisions T1–T14 are explicitly decided and recorded. The vendor discount funding responsibility snapshot (T7-A) is designed, but the settlement design gap is **NOT closed** — settlement ledger, payout adjustment, refund-funding reversal, settlement reporting, and dispute investigation are all deferred to a later stage with finance/operations input. Stage 5 can safely proceed with vendor-funded discounts using the snapshot-only model, subject to the following explicit restrictions:

1. **No automatic vendor payout settlement** in Stage 5 — vendor payouts proceed via existing `orderSnapshot.service.ts` snapshots (commission on discounted base, delivery excluded), but no discount-funding reversal or explicit payout deduction line item is implemented.
2. **Refunds proceed without settlement reconciliation** — completed refunds return money to customers via existing paths; the funding party's exposure reversal is deferred.
3. **Payout eligibility blocks refund activity** — `payoutEligibility.partitionPayoutBlockedOrders` (`payoutEligibility.service.ts`) blocks payouts for any order with a `RefundRequest` in PENDING/APPROVED/PROCESSING/COMPLETED status, `Payment.refundedAmount > 0`, or `Payment.status = REFUNDED`. This is enforced at eligibility check time; refunds created after payout initiation but before payout transfer are not blocked.
4. **Payout/refund concurrency gap** — `lockPaymentsCoveringOrders` (`payoutEligibility.service.ts`) locks `Payment` rows only during eligibility check, not during payout transfer initiation (`payoutService.initiateTransfer`). A `RefundRequest` can be created between eligibility check and payout initiation. If a payout is already `PAID` when a refund occurs, the vendor keeps the payout and the platform absorbs the difference. No clawback mechanism exists.
5. **No new cron enabled by default** — all Group Buy reconciliation jobs are implemented but disabled; separate explicit authorization required to enable any scheduled job.
6. **Funding visibility via `fundingVendorId`** — available for reporting but no settlement reports or dispute audit trails beyond the snapshot.

The design consistency audit confirms no contradictions among decisions and with approved Stage 3 invariants. Stage 5 implementation requirements are documented per batch. Risks and dependencies are identified with mitigations.

Stage 4 is **ACCEPTED AND CLOSED — PASS WITH FINDINGS** (independent closure audit). Stage 5 remains **NOT AUTHORIZED** awaiting separate explicit product-owner authorization.

**End of Stage 4 implementation-readiness report.**

