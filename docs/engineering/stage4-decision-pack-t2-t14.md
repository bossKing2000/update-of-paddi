# Foodi Paddi — Stage 4 Consolidated Product Decision Pack (T2–T7, T10–T14)

**Repository:** `/home/onyeka-ifeanyi/StudioProjects/update-of-paddi-main-backend`
**Date:** 2026-11-03
**Status:** DECISION ANALYSIS ONLY — no decisions are approved by this document.
**Stage:** Stage 4 (Design the Backend Architecture) is authorized for planning only; Stage 5 is **not** authorized.

## Purpose

This pack prepares one comprehensive decision review covering all eleven remaining unresolved Stage 4 Group Buy product decisions (T2–T7 and T10–T14) so the product owner can resolve them together, avoid repeated individual decision cycles, and identify cross-decision conflicts before the final Stage 4 readiness review.

**Scope boundary:** This is a documentation/decision-analysis task only. Nothing is implemented, nothing is approved, no code/schema/migration/test/database/Flutter/Git state is modified, and no decision register or acceptance record is updated. T1-A, T8-B and T9-B are treated as immutable approved decisions and are not re-opened.

## Source of truth (verified)

- `docs/engineering/stage4-implementation-readiness.md` — Stage 4 planning deliverable (planning only), §3 decision register, §7 batch plan, §8 dependency order, §9 cross-batch gates, §4 security requirements S1–S15.
- `promotion.md` — confirmed business rules (§A–§S), Unresolved Business Decisions (§317–§407), Stage 4/5 status and roadmap table.
- `docs/engineering/stage3-database-design.md` — accepted Stage 3 design, especially §18.2 "Stage 4 decisions" safe-positions table, §6–§15 design details, migration raw SQL (§26+), state machine (§12–§13).
- `docs/engineering/stage3-acceptance-closure.md` — Stage 3 accepted; Stage 5 not authorized until Stage 4 approved and product decisions resolved.
- Existing source (read-only inspection only): `src/services/promotionPricing.service.ts`, `src/services/scheduling.service.ts`, `src/services/deliveryFee.service.ts`, `src/services/orderSnapshot.service.ts`, `src/services/paymentFinalizer.service.ts`, `src/controllers/orderController.ts`, `src/controllers/cartController.ts`, `src/controllers/webhook.ts`, `src/controllers/receceipt.ts`.

**Already approved (immutable — do not re-open):**
- Decision A — Option A: pool/allocations frozen at qualification (`isFinal = true`, `finalizedAt = qualifiedAt`); no post-qualification redistribution.
- T1-A — Group Buy ignores `Promotion.maxDiscount`; `maxDiscount` rejected on `purchasingType = GROUP` promotions.
- T8-B — Voluntary member cancellation permitted before order reaches `COOKING`; full refund; group re-evaluated under `GroupBuyGroup` lock; other members' frozen allocations untouched; inventory/daily-cap released via reservation ledgers.
- T9-B — Partial refunds permitted after order completion; member stays `PAID`; order stays `COMPLETED`; per-user usage released only when cumulative completed refunds reach paid amount; `completedRefundAmountKobo` incremented; `refundStatus` derived.

---

## Decision T2 — Delivery fee / order-level charges in Group Buy

### A. Problem

The approved Group Buy rules describe **one unit of the promoted product per member** with a fixed discount pool (`floor(unitPrice × promotionPercentage)` divided among eligible paid members). The design does not state whether delivery fees or other order-level charges are part of what each member pays, nor whether the discount applies to them. `GroupBuyPaymentAllocation.amountKobo` exists and can hold order-level charges, but no product decision records how they are derived or who funds them.

### B. Existing behaviour and architecture

**Verified code behaviour:**
- `src/services/deliveryFee.service.ts` — `calculateDeliveryFee(vendorId, addressId, vendorSubtotalKobo)` computes a per-vendor delivery fee (base ₦300 + ₦100/km, free above ₦1,500,000 subtotal, max 20 km). This is existing Personal Buy infrastructure, env-tunable.
- `src/controllers/cartController.ts` checkout snapshot (lines ~1257–1314): `basePrice = rawSubtotal − discountKobo`; `deliveryFeeKobo` added separately; `totalPrice = basePrice + deliveryFeeKobo`; `commissionKobo`/`vendorPayoutKobo`/`discountKobo` snapshotted on the `Order`.
- `src/controllers/orderController.ts` (lines ~1346–1438): same delivery-fee + snapshot pattern for scheduled/special orders.
- Design (`stage3-database-design.md` §18.2 row T2): `amountKobo` is the actual payable total; `productAmountKobo − discountKobo` is the product portion; **no delivery policy assumed**.
- Design invariant (§2): `GroupBuyPaymentAllocation.amountKobo` sum = `Payment.amount` (reconciliation invariant).

**Design constraint that must remain unchanged:** The fixed discount pool is `floor(unitPrice × promotionPercentage)` on the **product price only** (Decision A / rule L). Delivery fees are outside the pool.

### C. Available options

**Option T2-A — Delivery fee excluded from the Group Buy pool; each member pays their own delivery on top of their discounted product price (recommended safe position).**
- How it works: `productAmountKobo − discountKobo` is the member's product portion. Delivery fee is computed per vendor/address exactly as Personal Buy and added on top per member. `amountKobo = (productPriceKobo − allocatedDiscountKobo) + memberDeliveryFeeKobo`. Discount pool applies to product price only.
- Customer impact: Each member sees product discount + their own delivery fee. Predictable; matches Personal Buy expectation.
- Vendor impact: Vendor receives product revenue (net of their funded discount share) plus delivery fee; delivery economics unchanged from Personal Buy.
- Platform/business impact: No change to funding responsibility (rule M: vendor/platform funds product discount only). Delivery fee is not discounted, so no funding leakage.
- Payment/refund implications: Refund under T8-B/T9-B covers `amountKobo` (product + delivery). T9-B partial refunds derive from cumulative completed against `amountKobo`. Consistent.
- Edge cases: Free-delivery threshold per vendor subtotal — in a group, each member's subtotal is one product; threshold may rarely be hit per member. Multi-address groups: each member's delivery computed independently (already supported per-vendor).
- Advantages: Reuses existing Personal Buy delivery fee path; no new pricing rule; discount invariant (`pool = product price × percentage`) preserved exactly; simplest.
- Disadvantages: A member in a far location pays more delivery than a neighbour in the same group — but this is already true in Personal Buy, so not a new inconsistency.

**Option T2-B — Delivery fee included in the amount subject to the fixed discount pool.**
- How it works: pool computed on `(productPrice + deliveryFee) × percentage`; discount spread across product+delivery.
- Customer impact: Larger nominal discount but delivery fee partially discounted — contradicts rule L ("one unit of the promoted product price").
- Vendor impact: Vendor/platform could end up funding a discount on delivery they did not intend to subsidize.
- Payment/refund implications: Breaks the approved `Discount Pool = unitPrice × percentage` formula; reconciliation invariant (`SUM(allocations) = pool`) still holds but pool no longer equals rule L.
- Edge cases: Delivery fee varies per member (address), so pool would differ per member unless a single representative fee is chosen — arbitrary and unfair.
- Advantages: None relative to approved rules.
- Disadvantages: Directly conflicts with rule L and Decision A; requires arbitrary choice of which member's delivery fee defines the pool; silent subsidy of delivery.

**Recommendation:** T2-A. It preserves the approved discount formula exactly, reuses existing Personal Buy delivery-fee infrastructure, and introduces no new pricing policy.

### D. Recommendation

**T2-A** — delivery fee excluded from the pool; each member pays product (discounted) + own delivery. Rationale: preserves rule L and Decision A invariant; reuses existing `calculateDeliveryFee`; no new pricing decision needed beyond confirming delivery is additive.

### E. Implementation impact

- Affected Stage 5 batches: Batch 5 (Payment allocation & Group Buy finalization — `amountKobo` derivation), Batch 6 (inventory/cap per member order), Batch 7 (refunds cover `amountKobo`).
- Relevant services/workflows: `groupBuyPaymentAllocation.service.ts`, `finalizeGroupBuyPaymentSuccess`, `groupBuyRefundWorker`, `calculateDeliveryFee` (unchanged, reused).
- Database/schema implications: None beyond batch 1 (`amountKobo` column already additive on `GroupBuyPaymentAllocation`). No new column needed.
- Payment/refund/inventory/daily-cap/commission implications: Refunds (T8-B/T9-B) cover full `amountKobo` including delivery; daily cap per member order unchanged; commission base unaffected (see T6).
- Personal Buy regression risks: None — `calculateDeliveryFee` and checkout snapshot untouched; Group Buy path is additive and separate.
- Required tests: unit test that `amountKobo = (productPrice − discount) + deliveryFee`; integration test that Group Buy checkout computes delivery per member address; refund test covering `amountKobo` including delivery.

### F. Dependencies

- Depends on T6 (commission base) only insofar as `amountKobo` includes delivery but commission base excludes it (existing snapshot behaviour). No hard dependency on other T-decisions.
- Blocking batch: Batch 5.

### G. Acceptance criteria

- Group Buy checkout computes `amountKobo = (productPriceKobo − allocatedDiscountKobo) + deliveryFeeKobo` per member.
- Discount pool remains `floor(unitPrice × percentage)` on product price only (rule L).
- Refund amount for a member equals their `amountKobo` including delivery (T8-B/T9-B consistency).
- `SUM(GroupBuyPaymentAllocation.amountKobo) = Payment.amount` invariant holds.
- Personal Buy delivery-fee behaviour unchanged (regression).

---

## Decision T3 — Payment-mode switching after failure

### A. Problem

The design supports two payment arrangements (rule I): **individual payment (default)** and **creator pays for everyone**. It does not define whether, after a creator's payment fails (or after qualification), the group can switch mode — e.g., creator failure falling back to individual payments so the group can still proceed, or a member switching from individual to creator-pays-all mid-window.

### B. Existing behaviour and architecture

**Verified code behaviour:**
- `stage3-database-design.md` schema: `GroupBuyGroup.paymentMode GroupBuyPaymentMode @default(INDIVIDUAL)` (line 456), `paymentExtensionUsed`, `paymentExtendedAt`.
- `promotion.md` rule I: creator-pays-all requires **explicit acceptance of the full amount** before confirming; creator is not automatically responsible merely for creating the group.
- Design §18.2 row T3: "No switching after qualification. A failed creator payment is a Stage 4 API/UX decision."
- Design §13 state machine: payment mode is fixed at qualification; group failure (<2 paid) triggers refunds.
- T8-B (approved) allows a paid member to cancel before `COOKING` with full refund — interacts with mode (creator-pays-all refund is per-member).

**Design constraint that must remain unchanged:** Mode is frozen at qualification (no post-qualification switching per design safe position); creator-pays-all requires explicit upfront acceptance; only confirmed successful payments count toward min-2 (rule K).

### C. Available options

**Option T3-A — No payment-mode switching at any point after group creation; mode fixed at creation/qualification (recommended safe position).**
- How it works: The group is created with a payment mode (individual default, or creator-pays-all with explicit creator acceptance). Once set, it cannot change. If the creator's payment fails under creator-pays-all, the allocation for members covered by the creator fails; if fewer than 2 paid confirmed members remain, the group fails and all paid members are refunded (rule K, N).
- Customer impact: Predictable — the mode quoted at creation is the mode that applies. Creator who cannot pay sees the group fail (with refunds), not a silent switch.
- Vendor impact: No partial-creator-payment complexity; vendor knows exactly who paid.
- Platform/business impact: Simplest refund/reconciliation; no mode-transition bookkeeping.
- Payment/refund implications: Creator-pays-all failure → per-allocation refunds; group-failure cascade if <2 paid remain. Fully consistent with T8-B, T9-B, rule N.
- Edge cases: Creator pays for everyone but one member's separate payment attempt also exists — must be rejected (mode already set). Already handled by mode guard.
- Advantages: Zero new state transitions; no API surface for mode switching; fully consistent with frozen-allocation (Decision A) and creator-pays-all explicit acceptance.
- Disadvantages: A creator whose payment fails cannot "retry as individual" without recreating the group; minor UX friction (creator must create a new individual-payment group).

**Option T3-B — Allow fallback from creator-pays-all to individual payment if creator payment fails, before qualification closes.**
- How it works: On creator payment failure, the group reverts to individual mode and members get their own payment windows.
- Customer impact: Group survives a creator failure — positive UX — but members face an unexpected mode change and individual payment obligation.
- Vendor impact: Payment attribution shifts from one creator payment to N member payments mid-flow.
- Platform/business impact: Requires mode-transition logic, re-qualification, re-allocation, and new payment windows — conflicts with Decision A (allocations frozen at qualification).
- Payment/refund implications: Creator's failed payment refunded; members now pay individually; allocation math must be re-derived — directly contradicts "no post-qualification redistribution."
- Edge cases: Race between creator failure and member joins; partial state where some members already paid individually under creator mode.
- Advantages: Higher group survival rate after creator payment failure.
- Disadvantages: Conflicts with Decision A (frozen allocations), rule I (explicit upfront acceptance), and rule K (only confirmed payments count). High implementation complexity and reconciliation risk.

**Recommendation:** T3-A. It is the documented safe position, requires no mode-transition machinery, and preserves all approved invariants.

### D. Recommendation

**T3-A** — no switching after qualification; failed creator payment is a group-failure/refund scenario (creator may create a new individual group). Rationale: preserves Decision A, rule I, rule K; minimal implementation surface; no new API surface.

### E. Implementation impact

- Affected Stage 5 batches: Batch 3 (group creation/membership — mode set at creation), Batch 5 (payment finalization — creator failure path), Batch 7 (refunds on creator failure).
- Relevant services/workflows: `groupBuyFormation.service.ts`, `finalizeGroupBuyPaymentSuccess`, `groupBuyRefundWorker`, group-failure path (§13 state machine).
- Database/schema implications: None beyond batch 1 (`paymentMode` column already additive).
- Payment/refund/inventory/daily-cap/commission implications: Creator failure → refunds per allocation; group re-evaluated under T8-B-like logic; no inventory/cap impact (reserved only after successful payment).
- Personal Buy regression risks: None — Group Buy payment path is separate from `finalizePaymentSuccess`.
- Required tests: creator-payment failure → group fails → all paid members refunded; mode cannot be changed after creation (400 on switch attempt); creator cannot pay under individual mode.

### F. Dependencies

- Depends on T8-B (group re-evaluation on below-two threshold) for the creator-failure cascade.
- Blocking batch: Batch 5.

### G. Acceptance criteria

- Group payment mode is immutable after creation/qualification (any switch attempt → 400).
- Creator-pays-all requires explicit creator acceptance of full amount before payment (rule I).
- Creator payment failure → allocations for covered members fail; if <2 paid confirmed members remain → group fails + all paid members refunded (rule K, N).
- Personal Buy payment flow unaffected.

---

## Decision T4 — Daily-cap unit for Group Buy

### A. Problem

Does a five-member Group Buy group consume up to five daily-cap units (one per confirmed member order), or one group-level daily-cap unit? The existing `DailyCapReservation` is per order (`orderId, productId, day`). A group could consume up to five units of a product's daily cap. The design has not recorded which unit applies.

### B. Existing behaviour and architecture

**Verified code behaviour:**
- `src/services/scheduling.service.ts` — `reserveDailyCap(tx, orderId, productId, dayStart, dailyCap)` is idempotent per `(orderId, productId, day)`; increments `ProductDailyCounter` per day; creates `DailyCapReservation` per order. `releaseOrderDailyCaps` releases caps for an order. `expireAwaitingPaymentJob` and `releaseOrderDailyCaps` must skip Group Buy orders (`groupBuyMemberId != null`).
- Design §18.2 row T4: "Each confirmed member order uses the existing per-order daily-cap mechanism. No group-level aggregation is assumed."
- Design §6.12 / §8.1 / finding D1: worker creates `DailyCapReservation` per confirmed member order; drafts never reserve cap; Group Buy `DailyCapReservation` released via `GroupBuyInventoryReservation.releasedAt IS NULL` transition.
- Personal Buy: one order = one daily-cap unit per product per day.

**Design constraint that must remain unchanged:** Draft orders never reserve cap; cap reserved only after successful payment; existing `reserveDailyCap`/`releaseDailyCap` reused; Personal Buy paths skip Group Buy.

### C. Available options

**Option T4-A — Per-member order daily-cap unit (recommended safe position).**
- How it works: Each confirmed member order consumes one daily-cap unit (`DailyCapReservation` per `orderId, productId, day`), exactly like Personal Buy. A five-member group consumes up to five units of that product's daily cap.
- Customer impact: Member's ability to buy depends on remaining daily cap for that product/day — same as buying individually. Predictable.
- Vendor impact: Vendor's daily cap is consumed per fulfilled member order; no group-level abstraction to manage.
- Platform/business impact: Reuses existing `reserveDailyCap` with no changes; no new group-level counter logic.
- Payment/refund implications: On member refund/cancellation (T8-B/T9-B) or stock failure (rule R), the member's `DailyCapReservation` is released via `GroupBuyInventoryReservation`/`releaseDailyCap` — existing idempotent release.
- Edge cases: A popular product's daily cap may be exhausted by a large group before all members can be fulfilled — but that is already true for N individual buyers; group gets no special advantage or penalty.
- Advantages: Simplest; reuses existing mechanism exactly; no new schema; consistent with "one unit per member" (rule P).
- Disadvantages: A group consumes more cap units than a single order — but that reflects N real fulfilled orders, which is correct.

**Option T4-B — One group-level daily-cap unit per product per day.**
- How it works: The whole group consumes one daily-cap unit regardless of member count.
- Customer impact: A five-member group pays the price of one order toward the daily cap — effectively a bulk discount on capacity; unfair vs. individual buyers.
- Vendor impact: Vendor fulfills five orders but records one cap unit — inventory/cap accounting diverges from fulfilment reality.
- Platform/business impact: Requires a new group-level counter, new reservation/release logic, and reconciliation between cap units and order count — new surface area.
- Payment/refund implications: Refund of one member would need to "un-consume" a fraction of a group cap unit — undefined behaviour.
- Edge cases: Partially-filled group (2 of 5 members) still consumes one full unit — cap wasted relative to actual fulfilment.
- Advantages: None relative to actual fulfilment.
- Disadvantages: Cap accounting no longer matches fulfilled orders; refund/cap-release undefined; new schema logic; unfair to individual buyers.

**Recommendation:** T4-A. It matches actual fulfilled orders, reuses existing `reserveDailyCap` unchanged, and requires no new schema or release logic.

### D. Recommendation

**T4-A** — per-member order daily-cap unit, matching Personal Buy. Rationale: cap accounting = fulfilled orders; no new schema; idempotent release via existing mechanisms.

### E. Implementation impact

- Affected Stage 5 batches: Batch 6 (Inventory & daily-cap reservations — `groupBuyInventory.service.ts`, `expireAwaitingPaymentJob` Group Buy guard).
- Relevant services/workflows: `reserveDailyCap` (unchanged, reused), `groupBuyInventory.service.ts`, `groupBuyDraftExpiryJob`, `releaseOrderDailyCaps` (skip Group Buy).
- Database/schema implications: None beyond batch 1 (`DailyCapReservation` already exists; Group Buy uses it per order).
- Payment/refund/inventory/daily-cap/commission implications: Daily cap reserved per confirmed member order; released on cancellation/refund/failure via existing ledger transitions; no commission impact.
- Personal Buy regression risks: None — `reserveDailyCap`/`releaseDailyCap`/`releaseOrderDailyCaps` unchanged; Group Buy guarded by `groupBuyMemberId != null` filter (already documented).
- Required tests: per-member cap reservation idempotent; cap exhausted → member allocation fails + refund + group re-evaluated; Group Buy drafts never create `DailyCapReservation`; Personal Buy paths skip Group Buy orders.

### F. Dependencies

- Depends on T5 (late-payment boundary) only indirectly (payment success triggers cap reservation). No hard T-dependency.
- Blocking batch: Batch 6.

### G. Acceptance criteria

- Each confirmed member order creates exactly one `DailyCapReservation` per `(orderId, productId, day)`.
- Group Buy drafts never create `DailyCapReservation`.
- `reserveDailyCap`/`releaseDailyCap` unchanged for Personal Buy; Group Buy guarded by `groupBuyMemberId != null`.
- Cap exhaustion for one member fails that member only (refund + group re-evaluation), not the whole group.
- `ProductDailyCounter.count` reconciliation matches active non-released reservations.

---

## Decision T5 — Late-payment boundary

### A. Problem

Paystack's `paid_at` timestamp and the local success timestamp can differ under clock skew or network delay. A member's payment may arrive shortly after the 30-minute payment window closes. The design does not define the exact tolerance for treating a late payment as valid or late.

### B. Existing behaviour and architecture

**Verified code behaviour:**
- `promotion.md` rule H: each member gets 30 minutes to complete payment; creator one-time 15-minute extension; unpaid members lose reserved places when deadline expires; only confirmed successful payments count.
- `stage3-database-design.md` §18.2 row T5: "Use Paystack's paid-at timestamp when available; local success time is the fallback. The exact tolerance is Stage 5."
- `src/services/paymentService.ts` / `paymentFinalizer.service.ts` / `webhook.ts` — existing Personal Buy payment verification and webhook `charge.success` handling (Group Buy routed to `finalizeGroupBuyPaymentSuccess`, batch 8).
- No existing "late payment tolerance" constant or logic found in source (it is a Stage 5 detail per §18.3).

**Design constraint that must remain unchanged:** 30-minute window is the rule; only confirmed successful payments count (rule K); late payments after group failure are refunded and do not resurrect the group (§12.5 "Group failure vs. payment success"); payment finalizer does not need the group lock.

### C. Available options

**Option T5-A — Strict boundary: payment valid only if paid_at ≤ paymentDeadlineAt; otherwise late → refund, no group resurrection (recommended safe position).**
- How it works: Compare Paystack `paid_at` (fallback: local success time) against `paymentDeadlineAt`. If within deadline → payment counts. If after → payment is late; refund automatically; group status unchanged (failed groups stay failed per §12.5).
- Customer impact: Clear, deterministic cutoff. A payment arriving a minute late is refunded — may disappoint a customer but is predictable.
- Vendor impact: Vendor knows exactly which payments counted; no surprise late additions to a group already cooking or failed.
- Platform/business impact: Simplest reconciliation; no tolerance constants to tune; no ambiguity in group-failure accounting.
- Payment/refund implications: Late payment → automatic full refund to original method (rule N pattern); group failure cascade if already failed (no resurrection per §12.5).
- Edge cases: Clock skew between Paystack and local server — using Paystack `paid_at` as authoritative (per design safe position) removes local-clock bias; still need a small grace for network propagation (documented as "zero tolerance" or a configurable few seconds — product decision).
- Advantages: Deterministic; no hidden grace; aligns with "only confirmed successful payments count" and §12.5 non-resurrection.
- Disadvantages: Payments just after the deadline are refunded even if the group could still proceed — minor UX friction.

**Option T5-B — Configurable grace window (e.g., +5 minutes) after paymentDeadlineAt.**
- How it works: Payments arriving within `paymentDeadlineAt + grace` are accepted as valid; beyond that → late/refund.
- Customer impact: More lenient; near-deadline payments count.
- Vendor impact: A member may join the paid set after the vendor has begun preparation — potential disruption under T8-B cancellation/group re-evaluation.
- Platform/business impact: Requires a grace constant, clock-skew handling, and clear disclosure; more reconciliation states (paid but "late").
- Payment/refund implications: Late-but-in-grace payments count toward min-2; out-of-grace refunded. Group may transition from failing to qualifying late — race with group-failure deadline job.
- Edge cases: Deadline job and late payment racing; group already failed then a late-in-grace payment arrives (§12.5 says no resurrection — need explicit rule).
- Advantages: Better customer experience for borderline late payments.
- Disadvantages: Introduces ambiguity, grace-constant tuning, race with failure job, and potential conflict with "group fails → no resurrection" (§12.5).

**Recommendation:** T5-A. Strict boundary is the documented safe position, deterministic, and avoids resurrecting failed groups. If the product owner wants leniency, it can be added later as a configurable grace with explicit rules — but that is a separate decision.

### D. Recommendation

**T5-A** — strict boundary; Paystack `paid_at` authoritative, local fallback; late → refund, no group resurrection. Rationale: deterministic, preserves §12.5 non-resurrection, minimal new state.

### E. Implementation impact

- Affected Stage 5 batches: Batch 5 (payment deadline validation), Batch 9 (payment deadline job `groupBuyPaymentDeadlineJob`), Batch 8 (webhook routing).
- Relevant services/workflows: `finalizeGroupBuyPaymentSuccess`, `groupBuyPaymentDeadlineJob`, webhook `charge.success` → Group Buy path, refund worker for late payments.
- Database/schema implications: None beyond batch 1 (`paymentDeadlineAt`, `paymentExtensionUsed` already additive).
- Payment/refund/inventory/daily-cap/commission implications: Late payments refunded (T8-B/T9-B-adjacent); no inventory/cap reserved for late payments (reserved only after successful payment within window).
- Personal Buy regression risks: None — Personal Buy payment window/tolerance unchanged.
- Required tests: payment within deadline counts; payment after deadline → refund, no group resurrection; creator extension applies once; Paystack paid-at vs local fallback; clock-skew insensitivity.

### F. Dependencies

- Depends on T8-B (group failure/re-evaluation) for the cascade when late payments arrive after failure.
- Blocking batch: Batch 5 and Batch 9 (per §18.2: "Stage 5 payment tests").

### G. Acceptance criteria

- `paid_at` (Paystack) ≤ `paymentDeadlineAt` → payment counts; otherwise late → automatic refund.
- Local success time used only when `paid_at` unavailable.
- Late payment after group failure is refunded and does not resurrect the group (§12.5).
- Creator 15-minute extension applies at most once.
- Personal Buy payment window/tolerance unchanged.

---

## Decision T6 — Commission base on discounted Group Buy orders

### A. Problem

Does the platform commission and vendor payout on a Group Buy order use the **discounted** product price (what the member actually paid for the product) or the **undiscounted** list price? Group Buy changes the discount source (fixed pool vs. Personal Buy promo), so the commission base must be explicit.

### B. Existing behaviour and architecture

**Verified code behaviour:**
- `src/services/orderSnapshot.service.ts` — commission computed as `Math.round(basePriceKobo × commissionRate)` where `basePriceKobo` is **net of discount, delivery fee excluded from commission base** (line 24 comment, line 110–121). `vendorPayoutKobo = grossKobo − commissionKobo`; `discountKobo` snapshotted.
- `src/controllers/cartController.ts` checkout (lines ~1263–1314): `basePrice = rawSubtotal − discountKobo`; `totalPrice = basePrice + deliveryFeeKobo`; commission/payout/discount snapshotted.
- Design §18.2 row T6: "Group Buy orders use the existing order financial snapshots; the commission base is not redefined here."
- Design invariant (§2): order snapshots preserved; commission base not redefined.

**Design constraint that must remain unchanged:** Commission base = `basePriceKobo` (net of product discount, delivery excluded) per existing snapshot; Group Buy orders use existing snapshots; `Promotion.value` remains Float percentage (Personal Buy polymorphism preserved).

### C. Available options

**Option T6-A — Commission base = discounted product price (member's actual product payable); delivery fee excluded (recommended safe position).**
- How it works: Group Buy order snapshot uses `basePriceKobo = productPriceKobo − allocatedDiscountKobo` (the member's discounted product portion); commission = base × rate; delivery fee excluded from base (matches Personal Buy). `vendorPayoutKobo = gross − commission`.
- Customer impact: None visible — customer pays what was quoted; commission is platform/vendor backend only.
- Vendor impact: Vendor payout reflects discounted product revenue — consistent with the discount the vendor/platform funded (rule M).
- Platform/business impact: Platform commission is on discounted revenue (lower than list price) — correct, since the discount was funded by vendor/platform and shouldn't earn commission on the discounted-away amount.
- Payment/refund implications: Refund (T8-B/T9-B) is per-member `amountKobo`; commission/payout snapshots already taken at order creation; refund does not unwind commission (existing Personal Buy behaviour preserved).
- Edge cases: Creator-pays-all — commission still per-member allocation base; creator's single Payment covers N allocations but each Order has its own snapshot.
- Advantages: Reuses existing `orderSnapshot.service.ts` unchanged; commission on actual (discounted) revenue; no double-counting of funded discounts.
- Disadvantages: Vendor earns less commission base when their own promotion discounts heavily — but that is the intended effect of funding the discount (rule M).

**Option T6-B — Commission base = undiscounted list price.**
- How it works: commission = `productPriceKobo × rate` regardless of Group Buy discount.
- Customer impact: None visible.
- Vendor impact: Vendor pays commission on the full list price even though the discount came out of their (or platform's) funds — effectively paying commission on revenue they never received.
- Platform/business impact: Incentivizes discount funding to be "commission-neutral" incorrectly; complicates funding reconciliation (rule M).
- Payment/refund implications: Commission snapshot doesn't match actual product revenue; refunds don't adjust commission — mismatch between payout and collected revenue.
- Edge cases: 100% discount product → commission on full price but zero revenue — clearly wrong.
- Advantages: None financially defensible.
- Disadvantages: Commission on revenue not collected; contradicts rule M funding logic; requires modifying `orderSnapshot.service.ts` for Group Buy (regression risk).

**Recommendation:** T6-A. It reuses the existing snapshot machinery unchanged and charges commission only on actual discounted product revenue.

### D. Recommendation

**T6-A** — commission base = discounted product price (`productPrice − allocatedDiscount`), delivery excluded; reuse existing `orderSnapshot.service.ts`. Rationale: no code change to snapshot logic; commission on actual revenue; consistent with rule M.

### E. Implementation impact

- Affected Stage 5 batches: Batch 5 (payment allocation — order snapshot for each member allocation), Batch 7 (refund — commission/payout not unwound on refund, matching Personal Buy).
- Relevant services/workflows: `orderSnapshot.service.ts` (unchanged, reused), `finalizeGroupBuyPaymentSuccess`, `groupBuyPaymentAllocation.service.ts`.
- Database/schema implications: None beyond batch 1 (`commissionKobo`, `vendorPayoutKobo`, `discountKobo` already additive on `Order`).
- Payment/refund/inventory/daily-cap/commission implications: Commission/payout snapshotted per member order at creation; refunds do not unwind commission (existing behaviour); delivery excluded from base.
- Personal Buy regression risks: None — `orderSnapshot.service.ts` unchanged; Group Buy is a separate call path with the same snapshot function.
- Required tests: Group Buy order snapshot commission = discounted base × rate; delivery excluded; creator-pays-all each allocation snapshots independently; Personal Buy snapshots unchanged (regression).

### F. Dependencies

- Depends on T2 (delivery fee excluded from commission base) — consistent with T6-A.
- Blocking batch: Batch 5 finance.

### G. Acceptance criteria

- Group Buy `Order.commissionKobo = round((productPriceKobo − allocatedDiscountKobo) × commissionRate)`.
- `Order.vendorPayoutKobo = grossKobo − commissionKobo` where gross excludes delivery.
- `Order.discountKobo` = allocated discount kobo.
- Delivery fee excluded from commission base (matches Personal Buy).
- Personal Buy commission/payout snapshots unchanged (regression).

---

## Decision T7 — Funding settlement and reporting

### A. Problem

`GroupBuyFundingSource` records who is responsible for the discount (VENDOR with vendorId, or PLATFORM) and is snapshotted at qualification (rule M). But there is no settlement ledger or payout adjustment defined: how do vendor/platform actually settle the funded discount, and how is it reported? The product decision is whether to build a settlement/reporting mechanism now or leave funding as a snapshot for later reconciliation.

### B. Existing behaviour and architecture

**Verified code behaviour:**
- `stage3-database-design.md` §6: `GroupBuyDiscountPool.fundingSource` (`GroupBuyFundingSource` enum VENDOR/PLATFORM) + `fundingVendorId`, frozen at qualification (`finalizedAt`), supporting "later reconciliation without deriving funding from a mutable promotion row" (§6, note at line 601).
- `promotion.md` rule M: vendor-created promotion → responsible vendor funds; admin-created → platform funds; funding source preserved; no silent transfer between vendor and platform.
- Design §18.2 row T7: "Snapshot VENDOR/PLATFORM and the funding vendor at qualification. Do not derive funding from a mutable promotion row."
- No settlement ledger, payout adjustment, or funding report exists in source for Group Buy (batch 1 creates the tables; settlement is Stage 4/5 design).

**Design constraint that must remain unchanged:** Funding source snapshotted at qualification; never derived from mutable promotion row; vendor/platform funding responsibility preserved per rule M.

### C. Available options

**Option T7-A — Snapshot-only funding with deferred settlement ledger (recommended safe position).**
- How it works: `fundingSource`/`fundingVendorId` are recorded at qualification and used only for reporting/reconciliation. No settlement ledger, no payout adjustment, no automatic transfer is built in Stage 5. Settlement happens through existing vendor payout / platform finance processes outside this feature, informed by the snapshot.
- Customer impact: None visible — customer pays the quoted amount regardless of who funds the discount.
- Vendor impact: Vendor sees their funded discount in reports; settlement occurs through existing payout process (commission/payout already net of discount via T6-A).
- Platform/business impact: Minimal Stage 5 surface; funding visibility via `GroupBuyDiscountPool.fundingVendorId`; no new financial movement logic (reduces risk).
- Payment/refund implications: Refunds (T8-B/T9-B) return money to the customer; the funding party's exposure is already reflected in the discounted price they funded. No refund-to-funding-party adjustment needed at this stage.
- Edge cases: Vendor-created promotion where vendor later disputes funding — reportable via `fundingVendorId`, but no automated adjudication in Stage 5.
- Advantages: Lowest risk; no new money-movement code; reporting available immediately; settlement can be added in a later stage with real operational requirements.
- Disadvantages: No automated settlement ledger in Stage 5 — funding responsibility is visible but not auto-settled (acceptable for MVP; documented as deferred).

**Option T7-B — Automatic settlement ledger with payout adjustment in Stage 5.**
- How it works: A settlement ledger records discount funding per vendor/platform; payout runs adjust vendor payouts by funded-discount amounts; platform funds admin promotions from platform account.
- Customer impact: None visible.
- Vendor impact: Vendor payout automatically reduced by their funded discount — requires ledger, payout adjustment, reconciliation, dispute handling.
- Platform/business impact: Significant new financial surface (ledger, adjustments, reconciliation, audit) — high risk for Stage 5; requires finance/ops sign-off.
- Payment/refund implications: Refunds would need to reverse settlement entries — complex, interacts with T8-B/T9-B partial refunds.
- Edge cases: Partial refunds, failed groups, creator-pays-all — settlement entries must track per-allocation funding; high complexity.
- Advantages: Automated, complete funding picture at launch.
- Disadvantages: High complexity/risk; new financial ledger not in accepted Stage 3 design; delays Stage 5; requires separate finance approval.

**Recommendation:** T7-A. It satisfies rule M (funding source preserved, snapshot at qualification), provides reporting data, and defers the complex settlement ledger to a later stage with proper finance review — appropriate for a planning-only Stage 4.

### D. Recommendation

**T7-A** — snapshot-only funding with deferred settlement ledger. Rationale: preserves rule M with zero new money-movement risk; funding visible for reporting; settlement can be designed in a later stage with finance/ops input.

### E. Implementation impact

- Affected Stage 5 batches: Batch 4 (qualification — snapshot `fundingSource`/`fundingVendorId`), Batch 7 (refund — funding not adjusted, reporting only), Batch 10 (reporting/reconciliation metrics).
- Relevant services/workflows: `qualification.service.ts` (snapshot funding), `GroupBuyDiscountPool` table, reporting queries on `fundingVendorId`.
- Database/schema implications: None beyond batch 1 (`fundingSource`, `fundingVendorId` already additive on `GroupBuyDiscountPool`).
- Payment/refund/inventory/daily-cap/commission implications: Commission/payout already net of discount (T6-A); refunds return customer money without funding-party settlement entries in Stage 5.
- Personal Buy regression risks: None — Personal Buy has no Group Buy funding concept; untouched.
- Required tests: `fundingSource`/`fundingVendorId` set correctly at qualification (VENDOR+vendorId, or PLATFORM+null); immutable after `isFinal`; reporting query returns funding party per promotion; Personal Buy rows have no Group Buy funding columns (null).

### F. Dependencies

- Depends on T6 (commission base net of discount) — funding responsibility aligns with who bears the discounted revenue.
- Blocking batch: Batch 4 (snapshot), Batch 10 (reporting).

### G. Acceptance criteria

- `GroupBuyDiscountPool.fundingSource` = VENDOR (with `fundingVendorId` = promotion vendor) for vendor promos; PLATFORM (null vendorId) for admin promos, set at qualification.
- Funding source immutable after `isFinal = true`.
- No automatic settlement/payout adjustment entries created for Group Buy funding in Stage 5 (deferred).
- Reporting query can list discount funding by party (vendor/platform).
- Personal Buy promotions have null Group Buy funding columns.

---

## Decision T10 — Receipt timing

### A. Problem

When is a Group Buy receipt generated relative to payment success and order confirmation? Payment success and order confirmation are separate events (worker confirms orders after stock+cap reservation). A receipt must not imply the order was confirmed (design §18.2 row T10).

### B. Existing behaviour and architecture

**Verified code behaviour:**
- `src/services/paymentFinalizer.service.ts` lines ~860–872: `generateReceipt(payment.id)` is called **at payment success** (after `Payment = SUCCESS`), best-effort, non-critical (a receipt failure doesn't undo a confirmed payment).
- `src/utils/generateReceipt/generateReceipt.ts` — generates PDF receipt per payment.
- `src/controllers/receceipt.ts` — authenticated receipt retrieval by payment ID; ownership check (`receipt.payment.userId === req.user.id`).
- Design §18.2 row T10: "Payment receipt may be generated at payment success; order-confirmation notifications wait for the worker."
- Design §8.4: Group Buy payments route to `finalizeGroupBuyPaymentSuccess` (not `finalizePaymentSuccess`); receipt generation does not imply order confirmation.
- Stage 3 design §12.3 / §8.4: `Payment.orderId` is an FK satisfier only for Group Buy; receipt shows one member's order ID (acceptable, §18.1 finding 9).

**Design constraint that must remain unchanged:** Receipt generated at payment success (best-effort, non-critical); receipt must not imply order confirmation; order confirmation notifications wait for the worker; Group Buy receipt tied to a member payment.

### C. Available options

**Option T10-A — Receipt at payment success, per member payment (recommended safe position).**
- How it works: Each member's successful payment generates a receipt (via `generateReceipt`) at payment finalization, exactly as Personal Buy. The receipt references that member's `Payment`. Order-confirmation notifications (and the receipt's "order confirmed" implication) are deliberately NOT tied to receipt generation; they wait for the worker's stock+cap confirmation.
- Customer impact: Customer gets a receipt immediately after paying — expected behaviour. Receipt does not claim fulfilment.
- Vendor impact: Vendor sees receipts per member order; no change to existing receipt flow.
- Platform/business impact: Reuses `generateReceipt` unchanged; no new receipt template or timing logic.
- Payment/refund implications: Refund (T8-B/T9-B) references the same payment/receipt; no receipt regeneration on refund (existing behaviour).
- Edge cases: Creator-pays-all — one Payment covers N allocations but `generateReceipt` is per payment; each member order still has its own receipt path via its own Payment? Under creator-pays-all there is one creator Payment. Design note: receipt may show one member's order ID (acceptable per finding 9). Stage 4 may enhance to list all covered members (deferred).
- Advantages: Reuses existing receipt generation; best-effort/non-critical matches Personal Buy; no timing ambiguity.
- Disadvantages: Under creator-pays-all, a single receipt for one payment may not itemize all members — documented as acceptable for MVP, enhancement deferred.

**Option T10-B — Receipt only after order confirmation (worker confirms stock+cap).**
- How it works: Receipt generation deferred until the worker confirms the order (stock + cap reserved), so the receipt can truthfully say "order confirmed."
- Customer impact: Delayed receipt — customer pays but waits longer for receipt; poorer UX.
- Vendor impact: Receipt lags fulfilment confirmation; vendor-facing reports delayed.
- Platform/business impact: Requires coupling receipt generation to the worker/outbox flow; new failure modes (worker confirms but receipt fails).
- Payment/refund implications: Refund before confirmation → no receipt exists — awkward but handleable; adds coupling between payment and fulfilment for a non-critical document.
- Edge cases: Stock failure after payment but before confirmation → payment succeeded, no receipt yet, refund issued — receipt never generated (inconsistent).
- Advantages: Receipt never implies an unconfirmed order.
- Disadvantages: Delayed receipt; coupling to worker; inconsistent when refunded pre-confirmation; worse UX than T10-A.

**Recommendation:** T10-A. Receipt at payment success is existing behaviour, best-effort and non-critical, and the design explicitly permits it; order confirmation remains a separate worker event.

### D. Recommendation

**T10-A** — receipt generated at payment success (best-effort, non-critical), per existing `generateReceipt`; order confirmation notifications wait for the worker; receipt must not imply confirmation. Rationale: reuses existing infrastructure, matches design safe position, best customer experience.

### E. Implementation impact

- Affected Stage 5 batches: Batch 5 (payment finalization calls `generateReceipt`), Batch 8 (webhook → Group Buy finalization path), Batch 10 (notification timing).
- Relevant services/workflows: `generateReceipt` (unchanged), `finalizeGroupBuyPaymentSuccess`, order-confirmation notifications (worker).
- Database/schema implications: None beyond batch 1 (`Receipt` table already exists; `paymentId` FK).
- Payment/refund/inventory/daily-cap/commission implications: Receipt at payment success; refunds don't regenerate receipts; no inventory/cap coupling.
- Personal Buy regression risks: None — `generateReceipt` and receipt route unchanged.
- Required tests: receipt generated after payment success (best-effort); receipt failure doesn't roll back payment; receipt ownership check; receipt does not claim order confirmed; Personal Buy receipt flow unchanged.

### F. Dependencies

- No hard dependency on other T-decisions.
- Blocking batch: Batch 5 (receipt in finalization), Batch 10 (notification timing reviewed).

### G. Acceptance criteria

- Receipt generated via `generateReceipt(payment.id)` at Group Buy payment success (best-effort, non-critical).
- Receipt retrieval authenticated; ownership enforced (`payment.userId`).
- Receipt does not state/imply order confirmed; order-confirmation notifications separate (worker).
- Personal Buy receipt timing unchanged (regression).

---

## Decision T11 — Group discovery

### A. Problem

How do customers discover Group Buy groups (public vs. private)? The design provides indexes (`[visibility, status, formationDeadlineAt]`) but no API shape, search engine, or ranking. The decision is what discovery surface to expose and how privacy is enforced.

### B. Existing behaviour and architecture

**Verified code behaviour:**
- `stage3-database-design.md` schema: `GroupBuyGroup.visibility GroupVisibility @default(PUBLIC)`, `inviteCode String? @unique`, index `[visibility, status, formationDeadlineAt]` (§10.9 / §11).
- `promotion.md` rule E: groups can be public or private; public groups discoverable and joinable; private groups not publicly discoverable, join via invitation link/code; customers may join multiple groups.
- Design §18.2 row T11: "Index [visibility, status, formationDeadlineAt]. No search engine or ranking is assumed."
- Design §9 security S9: group operations validate visibility/membership/ownership; private groups never leak capacity/count publicly.
- `GroupBuyGroup` table does not yet exist in source (batch 1 schema); discovery API not yet built.

**Design constraint that must remain unchanged:** Private groups never publicly discoverable; public groups discoverable/joinable; private join via invite code; visibility enforced on backend (not just UI); no search-engine assumption.

### C. Available options

**Option T11-A — Simple list/filter discovery for public groups only (recommended safe position).**
- How it works: A Group Buy discovery endpoint lists public groups with `status = FORMING` (or `QUALIFIED` before payment window), filterable by product/promotion, ordered by `formationDeadlineAt`. No search engine, no ranking beyond deadline. Private groups excluded entirely; accessible only via invite code.
- Customer impact: Customers see joinable public groups; private groups require an invite — matches rule E.
- Vendor impact: Vendor's product promotion can surface public groups; no discovery burden for private groups.
- Platform/business impact: Simple endpoint using existing index; no search infra; privacy enforced by `visibility` filter in the query.
- Payment/refund implications: Discovery is pre-payment; no financial impact.
- Edge cases: A public group that fills (reaches `maxMembers`) closes formation — query must exclude `status != FORMING`/full groups (capacity enforced transactionally per S5).
- Advantages: Simplest; uses existing index; privacy guaranteed by query filter; no new infra.
- Disadvantages: No search/ranking beyond deadline; no "recommended groups" — acceptable for MVP.

**Option T11-B — Search-engine-backed discovery with ranking and combined public/private hinting.**
- How it works: Integrate a search engine (e.g., the existing full-text vector / pg_trgm) to search groups by product, rank by popularity, and possibly hint that private groups exist (without leaking details).
- Customer impact: Richer discovery but private-group hints could leak existence (privacy risk under S9).
- Vendor impact: Vendor groups more discoverable but ranking complexity.
- Platform/business impact: New search infra/ranking to maintain; privacy leakage risk if private-group existence is hinted.
- Payment/refund implications: None.
- Edge cases: Ranking stale vs. real-time capacity; a top-ranked group may already be full.
- Advantages: Better discovery UX.
- Disadvantages: New infra; privacy risk under S9; over-engineered for MVP.

**Recommendation:** T11-A. Simple list/filter for public groups using the existing index; private groups via invite code only. Privacy is guaranteed by the query; no new infra.

### D. Recommendation

**T11-A** — public-group list/filter discovery using existing `[visibility, status, formationDeadlineAt]` index; private groups not discoverable, join via invite code. Rationale: simplest, privacy-guaranteed, no new infrastructure.

### E. Implementation impact

- Affected Stage 5 batches: Batch 3 (group creation/membership — visibility, invite code), Batch 10 (authorization negative tests — private groups never leak).
- Relevant services/workflows: `groupBuyFormation.service.ts`, `groupMembership.service.ts`, `groupBuyMembershipGuard.ts`, discovery endpoint (batch 3/10).
- Database/schema implications: None beyond batch 1 (`visibility`, `inviteCode @unique`, index already additive).
- Payment/refund/inventory/daily-cap/commission implications: None — discovery is pre-payment.
- Personal Buy regression risks: None — Group Buy discovery is separate from Personal Buy promo discovery (S3/S15).
- Required tests: public groups listed; private groups excluded from list; private join only via valid invite code; invite code unique/unguessable; capacity not leaked for private groups; Personal Buy discovery unaffected.

### F. Dependencies

- Depends on T12 (invite code semantics) for private join.
- Blocking batch: Batch 3.

### G. Acceptance criteria

- Discovery endpoint returns only `visibility = PUBLIC` groups.
- Private groups never appear in discovery results (no capacity/count leakage).
- Private group join requires a valid, unique `inviteCode`.
- `inviteCode` is unique and unguessable.
- Full groups (at `maxMembers`) not offered for joining.
- Personal Buy promotion discovery unchanged (S3/S15).

---

## Decision T12 — Promotion-code semantics for Group Buy

### A. Problem

Do Group Buy promotions require a promo code, can a code work for both Personal Buy and Group Buy, and how is code uniqueness scoped? Existing `@@unique([vendorId, code])` is preserved; the design does not claim one code works for both purchasing types.

### B. Existing behaviour and architecture

**Verified code behaviour:**
- `src/controllers/promoController.ts` (lines ~56–79): DELIVERY promos require a code; code-gated campaigns exist; `applyPromoService` in `promoService.ts` redeems codes explicitly.
- `src/services/promotionPricing.service.ts` header: automatic product/vendor discount (`code == null`) applies by itself; code-gated campaign (`code != null`) redeemed via `applyPromoService`.
- Schema: `@@unique([vendorId, code])` preserved (design §6 regression plan).
- `Promotion.purchasingType` discriminates PERSONAL vs GROUP (design §6.2).
- Design §18.2 row T12: "Group Buy promotion codes follow existing uniqueness. Whether a code is required is a Stage 4 validation decision."
- T1-A (approved): `maxDiscount` rejected on GROUP promotions — codes follow the same validation pattern.

**Design constraint that must remain unchanged:** `@@unique([vendorId, code])` preserved; `purchasingType` discriminates; no stacking with promo codes (rule O); code-gated redemption via `applyPromoService` unchanged for Personal Buy.

### C. Available options

**Option T12-A — Code optional for Group Buy; code scoped to one purchasingType (recommended safe position).**
- How it works: A Group Buy promotion may have a code or be automatic (code == null), exactly like Personal Buy. A code is unique per `(vendorId, code)` and is tied to that promotion's `purchasingType`; a code created for a Group Buy promotion cannot be redeemed in a Personal Buy context (S3 filter) and vice versa. No stacking with other codes/promos (rule O).
- Customer impact: Automatic Group Buy discount requires no code (matches Group Buy "product embodies the promotion" model); code-gated Group Buy campaigns require code entry — consistent with Personal Buy.
- Vendor impact: Vendor can create automatic or code-gated Group Buy promos on their own products; code uniqueness per vendor.
- Platform/business impact: Reuses existing code uniqueness and `applyPromoService` pattern; no new code logic.
- Payment/refund implications: Code redemption is pre-payment; no refund impact.
- Edge cases: A customer tries to apply a Group Buy code in Personal Buy checkout — rejected by `purchasingType = PERSONAL` filter (S3/S15).
- Advantages: Reuses existing code infrastructure; `purchasingType` separation prevents cross-contamination; no new uniqueness scope.
- Disadvantages: None beyond confirming code-optional is acceptable (it matches the automatic-discount model).

**Option T12-B — Code required for all Group Buy promotions; one code shared across purchasing types.**
- How it works: Every Group Buy promotion must have a code; the same code string could be used for a Personal Buy and a Group Buy promotion.
- Customer impact: Forces code entry for every Group Buy — friction for the automatic-discount model.
- Vendor impact: Must manage codes for all Group Buy promos.
- Platform/business impact: Sharing a code across purchasing types breaks `@@unique([vendorId, code])` semantics or requires a composite unique including `purchasingType` — schema change and cross-type redemption risk.
- Payment/refund implications: Code redemption must gate on `purchasingType`; shared code could confuse customers.
- Edge cases: Code collision between a Personal Buy and Group Buy promo for the same vendor.
- Advantages: None.
- Disadvantages: Requires schema change (`@@unique([vendorId, purchasingType, code])`); cross-type confusion; friction for automatic model; contradicts existing `@@unique([vendorId, code])` preservation.

**Recommendation:** T12-A. Code optional, scoped to one purchasingType, reuses existing uniqueness — no schema change, no cross-type risk.

### D. Recommendation

**T12-A** — code optional for Group Buy; code unique per `(vendorId, code)` and tied to `purchasingType`; no cross-type redemption; no stacking (rule O). Rationale: reuses existing code infra; no schema change; `purchasingType` separation prevents cross-contamination.

### E. Implementation impact

- Affected Stage 5 batches: Batch 2 (promotion targeting/eligibility — `purchasingType` required, code validation), Batch 10 (negative tests — GROUP code not reachable in Personal Buy).
- Relevant services/workflows: `promoController.ts`, `promoService.ts`/`applyPromoService` (unchanged), `groupBuyEligibility.service.ts`, `GroupBuyPromotionAdminValidation`.
- Database/schema implications: None beyond batch 1 (`code`, `purchasingType`, `@@unique([vendorId, code])` already preserved).
- Payment/refund/inventory/daily-cap/commission implications: Code redemption pre-payment; no financial impact.
- Personal Buy regression risks: None — `applyPromoService` and `@@unique([vendorId, code])` unchanged; S3/S15 filters keep types separate.
- Required tests: Group Buy promo creation with/without code; code unique per vendor; GROUP code rejected in Personal Buy eligibility; PERSONAL code rejected in Group Buy; no stacking; Personal Buy code flow unchanged.

### F. Dependencies

- Depends on T1-A (validation pattern for rejecting fields on GROUP promotions — same validation layer rejects invalid code/purchasingType combos).
- Blocking batch: Batch 2.

### G. Acceptance criteria

- Group Buy promotion may be created with or without a code.
- `@@unique([vendorId, code])` preserved; no composite unique with purchasingType added.
- `purchasingType = GROUP` promotions are not returned by Personal Buy eligibility queries (S3).
- Code-gated Group Buy promotion requires code redemption via `applyPromoService`; automatic (code == null) applies by itself.
- No stacking with other codes/promos (rule O).
- Personal Buy promotion code behaviour unchanged.

---

## Decision T13 — Group-size configuration

### A. Problem

Can the group size be configured beyond the approved minimum of 2 and maximum of 5? Does the creator select any capacity in that range, or is it fixed? The approved rules fix min 2 / max 5; the creator selects capacity within that range.

### B. Existing behaviour and architecture

**Verified code behaviour:**
- `stage3-database-design.md` schema: `maxMembers Int @default(5)`, `minMembers Int @default(2)` (lines 452–453); check constraints `maxMembers BETWEEN 2 AND 5` and minMembers check (lines 1156–1157); `maxMembers` is creator-selected capacity including creator (line 498); `minMembers` fixed at 2 by approved rules.
- `promotion.md` rule F: max 5 including creator; min 2 including creator; group may proceed with 2, 3, 4, or 5 provided minimum satisfied; creator selects capacity within range; distinction between selected capacity and absolute max of 5 preserved.
- Design §18.2 row T13: "`minMembers = 2`; `maxMembers` 2–5 with check constraints."
- Existing `GroupBuyGroup` table not yet in source (batch 1).

**Design constraint that must remain unchanged:** minMembers fixed at 2; maxMembers creator-selectable 2–5 with DB check constraints; creator included in count; absolute max 5 never exceeded (transactional capacity enforcement S5).

### C. Available options

**Option T13-A — Creator selects capacity within fixed [2, 5]; min fixed at 2, max fixed at 5 (recommended safe position).**
- How it works: Group creation accepts a `maxMembers` (selected capacity) between 2 and 5 (default 5); `minMembers` is fixed at 2. Formation closes early when selected capacity reached. DB check constraints enforce both bounds; transactional join prevents exceeding selected capacity.
- Customer impact: Creator chooses group intimacy (2–5); members know the max at creation; predictable.
- Vendor impact: Vendor's promotion supports groups of any approved size; no special handling.
- Platform/business impact: Simple; uses existing schema defaults and constraints; no new config surface.
- Payment/refund implications: Refund/re-evaluation thresholds keyed to min 2 (T8-B group failure cascade) — consistent.
- Edge cases: Creator selects 2; one member joins; group has 2 (creator + 1) = min satisfied → can qualify. Creator selects 5; only 2 join and pay → group qualifies with 2 (allowed per rule F).
- Advantages: Matches approved rules exactly; DB constraints prevent invalid sizes; no new logic.
- Disadvantages: None — this is the documented rule.

**Option T13-B — Configurable group-size range via admin/platform setting (e.g., min 2–10, max 5–20).**
- How it works: Platform sets a configurable min/max range; creators select within it.
- Customer impact: Larger groups possible — but contradicts approved max of 5.
- Vendor impact: Vendor must support larger fulfilment groups — not in approved rules.
- Platform/business impact: New admin setting, validation, and DB constraint management; contradicts "max 5 including creator."
- Payment/refund implications: Group failure threshold (<2) still applies; larger groups increase refund cascade scope.
- Edge cases: Config change mid-formation affects in-flight groups — versioning complexity.
- Advantages: Flexibility for future.
- Disadvantages: Directly contradicts approved rule F (max 5); new config surface; contradicts DB check constraints; scope creep for Stage 4.

**Recommendation:** T13-A. It matches the approved rules exactly and requires no new config or constraint changes beyond batch 1 defaults.

### D. Recommendation

**T13-A** — creator selects capacity within fixed [2, 5]; min fixed at 2; max fixed at 5 with DB check constraints. Rationale: matches approved rule F exactly; no new config surface; DB constraints enforce bounds.

### E. Implementation impact

- Affected Stage 5 batches: Batch 3 (group creation — capacity validation 2–5, transactional join), Batch 4 (qualification — min-2 check).
- Relevant services/workflows: `groupBuyFormation.service.ts`, `groupMembership.service.ts`, `groupBuyMembershipGuard.ts`, `qualification.service.ts`.
- Database/schema implications: None beyond batch 1 (`maxMembers` default 5, `minMembers` default 2, check constraints already additive).
- Payment/refund/inventory/daily-cap/commission implications: Group failure threshold min-2 consistent with T8-B; no financial impact.
- Personal Buy regression risks: None — Personal Buy has no group-size concept.
- Required tests: creation rejects maxMembers <2 or >5; join rejects when at capacity; concurrent joins for last slot → exactly one wins; qualification requires ≥2; creator included in count; Personal Buy unaffected.

### F. Dependencies

- Depends on T8-B (group failure below 2 paid members) for the cascade logic.
- Blocking batch: Batch 3.

### G. Acceptance criteria

- Group creation `maxMembers` validated 2–5 (default 5); `minMembers` fixed at 2.
- Creator included in member count.
- Join rejected when group at selected capacity; concurrent last-slot join → exactly one winner.
- Qualification requires ≥2 paid confirmed members; group fails otherwise (T8-B cascade).
- DB check constraints enforce `maxMembers BETWEEN 2 AND 5`.
- Personal Buy unaffected.

---

## Decision T14 — Reconciliation cadence

### A. Problem

How often do reconciliation jobs run (payment, refund, inventory/daily-cap, usage, outbox repair) and what alert thresholds trigger? The design defines jobs and metrics but not schedules or paging thresholds (design §18.3 / §18.2 row T14).

### B. Existing behaviour and architecture

**Verified code behaviour:**
- `stage3-database-design.md` §15: jobs defined — `groupBuyFormationDeadlineJob`, `groupBuyQualificationJob`, `groupBuyPaymentDeadlineJob`, `groupBuyRefundReconciliationJob`, `groupBuyInventoryReleaseJob`, `groupBuyUsageReconciliationJob`, `groupBuyOutboxRepairJob`, `groupBuyDraftExpiryJob`.
- Design §18.2 row T14: "Jobs are bounded and idempotent; no schedule is enabled by this document."
- Design §18.3: exact retry count, backoff, lease duration, batch sizes, and reconciliation cadence/alert thresholds are implementation details, not design gaps.
- `src/jobs/` workers infrastructure exists; `verifyPendingPayments`, `verifyPendingRefunds` existing Personal Buy reconciliation.
- Security S5/S8/S10: idempotent/conditional transitions; no new cron enabled without separate authorization.
- Stage 4 gate (section 9, item 5): local dev only until explicitly authorized; no push/deploy until separate release gate — implies no cron schedules enabled in Stage 4 planning.

**Design constraint that must remain unchanged:** No schedule enabled by the design document; jobs idempotent and bounded; no new cron enabled without explicit authorization; reconciliation drift triggers alerts not automatic correction (§16.3).

### C. Available options

**Option T14-A — Defer all cadence/threshold decisions to Stage 5 operations (recommended safe position).**
- How it works: All jobs are implemented idempotent and bounded (as designed) but **no schedule is enabled** in Stage 5 initial rollout. Cadence and alert thresholds are defined in Stage 5 operations design and enabled only with separate explicit authorization (per gate item 5 and S10).
- Customer impact: None visible — reconciliation is backend ops.
- Vendor impact: None visible.
- Platform/business impact: Lowest risk; ops team defines cadence based on observed volume; no risk of an ill-tuned cron causing load or missed windows at launch.
- Payment/refund implications: Reconciliation jobs exist but are not scheduled; manual or on-demand reconciliation until cadence is approved. Late-payment refunds (T5) and failed-group refunds (rule N) still triggered by events/deadline jobs — but those jobs also need scheduling authorization.
- Edge cases: Without scheduled reconciliation, drift (stock/cap counter mismatch, unidentified PROCESSING refunds) is not auto-detected until ops enables the job — documented risk, acceptable for MVP.
- Advantages: Zero scheduling risk at launch; cadence tuned to real volume; complies with "no new cron without authorization."
- Disadvantages: Reconciliation not running automatically until ops configures it — requires explicit ops decision before relying on drift detection.

**Option T14-B — Define default schedules and thresholds now (e.g., payment deadline every 2 min, refund reconciliation every 15 min, alert on >0 drift).**
- How it works: Stage 5 ships with preset cron schedules and alert thresholds.
- Customer impact: None visible.
- Vendor impact: None visible.
- Platform/business impact: Preset cadence may be too frequent (load) or too sparse (stale drift) for actual volume; thresholds may false-alarm or miss issues; requires tuning after launch.
- Payment/refund implications: Deadline jobs enforce T5 boundaries automatically; refund reconciliation catches unidentified PROCESSING rows.
- Edge cases: Mis-tuned payment-deadline job could mark payments late prematurely or delay refunds; alert threshold too noisy → alert fatigue.
- Advantages: Reconciliation active from launch.
- Disadvantages: Preset values are guesses without volume data; contradicts "no schedule enabled by this document" and gate item 5 (local dev only until authorized); higher launch risk.

**Recommendation:** T14-A. It complies with the design document ("no schedule enabled") and the Stage 4 gate ("local dev only until explicitly authorized"). Cadence and thresholds are Stage 5 operations decisions made with real volume data.

### D. Recommendation

**T14-A** — defer cadence and alert thresholds to Stage 5 operations; no schedule enabled in Stage 5 initial rollout; jobs idempotent and bounded; separate explicit authorization to enable cron. Rationale: complies with design §18.2/§18.3 and gate item 5; avoids mis-tuned cron at launch.

### E. Implementation impact

- Affected Stage 5 batches: Batch 9 (jobs & reconciliation — all jobs implemented but not scheduled), Batch 8 (webhook/outbox — outbox repair job), Batch 7 (refunds — reconciliation extension).
- Relevant services/workflows: all groupBuy* jobs, `verifyPendingPayments`, `verifyPendingRefunds`, scheduler wiring (`src/server.ts` or `src/jobs/scheduler.ts`).
- Database/schema implications: None beyond batch 1.
- Payment/refund/inventory/daily-cap/commission implications: Jobs exist but unscheduled; event-driven triggers (deadline, payment success) still need scheduler authorization; drift detection via `groupBuyUsageReconciliationJob`/`groupBuyInventoryReleaseJob` when enabled.
- Personal Buy regression risks: None — Personal Buy jobs/schedules unchanged; Group Buy jobs separate.
- Required tests: each job idempotent and bounded (unit); reconciliation drift detection (sum vs stored counter); no schedule enabled by default (config check); Personal Buy jobs unchanged.

### F. Dependencies

- Depends on T5 (payment deadline job needs cadence) and T8-B/T9-B (refund reconciliation) only for what events the jobs respond to; cadence itself independent.
- Blocking batch: Batch 9 (per §18.2: "Stage 5 operations design").

### G. Acceptance criteria

- All reconciliation/refund/inventory/usage/outbox jobs implemented, idempotent, and bounded.
- **No cron schedule enabled by default** (verify scheduler config has Group Buy jobs paused/disabled).
- Enabling any schedule requires separate explicit authorization (gate item 5, S10).
- Drift detection compares sums vs stored counters and alerts (no auto-correction).
- Personal Buy job schedules unchanged (regression).

---

## Cross-decision consistency review

| Check | Finding | Resolution |
|-------|---------|------------|
| Delivery charges vs. per-member allocation | T2-A excludes delivery from the pool; `amountKobo` includes delivery. Pool remains `floor(unitPrice × percentage)` (rule L). | Consistent with Decision A and rule L. T2-A + T6-A align (delivery excluded from commission base too). |
| Payment-mode switching vs. creator-pays-all allocations | T3-A fixes mode at qualification; no switching. Creator-pays-all refund is per-member (T8-B). | Consistent — no mode-transition conflicts with frozen allocations (Decision A). |
| Late payments altering frozen allocations | T5-A strict boundary: late payments refunded, no group resurrection (§12.5); allocations frozen at qualification (Decision A). | Consistent — late payments never touch frozen allocations. |
| Daily-cap vs. inventory reservation rules | T4-A per-member cap; cap reserved after payment in same transaction as stock (design §13 step 6–8); rollback on cap exhaustion restores stock automatically. | Consistent — cap and stock roll back together; release via existing ledger. |
| Commission on discounted vs. undiscounted amount | T6-A uses discounted base (`productPrice − discount`), delivery excluded — matches `orderSnapshot.service.ts`. | Consistent with rule M (funding party shouldn't earn commission on discounted-away revenue). |
| Vendor/platform funding vs. refunds/settlements | T7-A snapshots funding at qualification; no settlement ledger in Stage 5; refunds return customer money. | Consistent with rule M; commission/payout already net of discount (T6-A); deferred settlement is low-risk. |
| Receipt timing vs. payment success / order finalization | T10-A receipt at payment success (best-effort); order confirmation waits for worker; receipt must not imply confirmation. | Consistent with design §18.2 T10 and existing `generateReceipt` behaviour. |
| Public/private discovery vs. privacy rules | T11-A public list only; private groups excluded by `visibility` query filter; invite code for private. | Consistent with rule E and S9 (private groups never leak capacity/count). |
| Group codes vs. invite links / group identifiers | T12-A code scoped to `purchasingType`; invite code (`GroupBuyGroup.inviteCode @unique`) is separate. No conflict — different namespaces. | Consistent — promotion code ≠ group invite code. |
| Configurable group sizes vs. approved min/max | T13-A keeps min 2 / max 5 fixed; creator selects within. No violation. | Consistent with rule F and DB check constraints. |
| Reconciliation cadence vs. delayed payments/refunds/failed workers | T14-A no schedule enabled; jobs idempotent/bounded; drift alerts (no auto-correct). Event-driven deadline/refund jobs need separate scheduling auth. | Consistent with gate item 5 and S10; avoids mis-tuned cron at launch. |
| Partial refunds / member cancellation vs. T8-B and T9-B | T8-B cancellation before `COOKING` full refund; T9-B partial refund after `COMPLETED` keeps member `PAID`, usage not released until full. Both covered by T2/T5/T6 analysis. | Consistent — refund amounts derive from `amountKobo` (T2-A) and commission not unwound (T6-A). |
| Any decision changing Personal Buy behaviour | None of T2–T7, T10–T14 recommended options modify Personal Buy code paths; all Group Buy logic is additive/separate; S3/S15 enforce isolation. | Consistent — Personal Buy regression plan (§6) preserved. |

**No conflicts found** among the recommended options. All are mutually consistent with Decision A, T1-A, T8-B, T9-B, and the approved Stage 3 invariants.

---

## Consolidated decision table

| Decision | Recommended option | Why | Blocking batches | Dependencies | Status |
|----------|-------------------|-----|------------------|--------------|--------|
| T2 | T2-A — delivery fee excluded from pool; additive per member | Preserves rule L + Decision A invariant; reuses existing `calculateDeliveryFee` | Batch 5 | T6 (aligned) | Unresolved |
| T3 | T3-A — no mode switching after qualification; failed creator payment = refund/group failure | Preserves Decision A, rule I, rule K; no mode-transition machinery | Batch 5 | T8-B (cascade) | Unresolved |
| T4 | T4-A — per-member order daily-cap unit | Cap accounting = fulfilled orders; reuses `reserveDailyCap` unchanged | Batch 6 | T5 (indirect) | Unresolved |
| T5 | T5-A — strict boundary; `paid_at` authoritative; late → refund, no resurrection | Deterministic; preserves §12.5 non-resurrection | Batch 5, Batch 9 | T8-B (cascade) | Unresolved |
| T6 | T6-A — commission base = discounted product price, delivery excluded | Reuses `orderSnapshot.service.ts`; commission on actual revenue; rule M | Batch 5 | T2 (aligned) | Unresolved |
| T7 | T7-A — snapshot-only funding; deferred settlement ledger | Preserves rule M; zero new money-movement risk; reporting available | Batch 4, Batch 10 | T6 (aligned) | Unresolved |
| T10 | T10-A — receipt at payment success (best-effort); confirmation waits for worker | Reuses existing `generateReceipt`; matches design safe position | Batch 5, Batch 10 | None | Unresolved |
| T11 | T11-A — public-group list/filter via existing index; private via invite code | Simplest; privacy guaranteed by query; no new infra | Batch 3 | T12 (invite code) | Unresolved |
| T12 | T12-A — code optional; unique per `(vendorId, code)`; scoped to purchasingType | Reuses existing code infra; no schema change; S3/S15 isolation | Batch 2 | T1-A (validation pattern) | Unresolved |
| T13 | T13-A — creator selects capacity in fixed [2,5]; min 2 / max 5 via DB constraints | Matches rule F exactly; no new config surface | Batch 3 | T8-B (min-2 cascade) | Unresolved |
| T14 | T14-A — defer cadence/thresholds to Stage 5 ops; no schedule enabled | Complies with design §18.2/§18.3 + gate item 5; no mis-tuned cron risk | Batch 9 | T5/T8/T9 (events) | Unresolved |

---

## Final report

### 1. All 11 decision briefs

Provided above, each with Problem / Existing behaviour / Options / Recommendation / Implementation impact / Dependencies / Acceptance criteria.

### 2. Recommendations

Recommended options: **T2-A, T3-A, T4-A, T5-A, T6-A, T7-A, T10-A, T11-A, T12-A, T13-A, T14-A** — all are the documented "safe positions" from `stage3-database-design.md` §18.2, extended with rationale. None changes Personal Buy behaviour, none re-opens T1-A/T8-B/T9-B/Decision A.

### 3. Cross-decision conflicts and proposed resolutions

No conflicts were identified among the recommended options. The cross-decision review table above documents each consistency check and its resolution. The one area requiring care is **T2 + T6 alignment** (delivery excluded from both pool and commission base) and **T5 + T8-B** (late payments after group failure must not resurrect the group) — both are resolved by the recommended options.

### 4. Consolidated recommendation set

Approve all 11 recommended options (T2-A through T14-A as listed). They are mutually consistent and collectively unblock Stage 5 batches 2–10 for the decision-dependent portions. T2–T7 unblock batch 5; T4 unblocks batch 6; T5/T7/T14 unblock batch 9; T10 unblocks batch 5/10; T11/T12/T13 unblock batch 2/3.

### 5. Dependency-ordered decision sequence

1. **T12** (batch 2 — promotion validation pattern; also informs T1-A-style field rejection)
2. **T11** (batch 3 — discovery; depends on T12 for invite code)
3. **T13** (batch 3 — group size; depends on T8-B for min-2 cascade)
4. **T2** (batch 5 — delivery fee; depends on T6 alignment)
5. **T6** (batch 5 — commission base; depends on T2 alignment)
6. **T3** (batch 5 — payment mode; depends on T8-B)
7. **T5** (batch 5/9 — late payment; depends on T8-B)
8. **T4** (batch 6 — daily-cap unit)
9. **T7** (batch 4 funding snapshot / batch 10 reporting; depends on T6)
10. **T10** (batch 5/10 — receipt timing)
11. **T14** (batch 9 — reconciliation cadence; ops decision)

Batches 2, 3, 4, 5, 6, 9, 10 all have decision dependencies that clear once the above are approved.

### 6. Decisions that can be approved together

All 11 can be approved together as a single Stage 4 product-decision resolution — they are mutually consistent with no conflicts. If the product owner prefers to stage them, the dependency-ordered sequence above shows the logical grouping (batch 2 decisions first, then batch 3, then batch 5/6, then batch 9/10).

### 7. Decisions requiring separate consideration

- **T14** — cadence/thresholds are explicitly an operations decision requiring separate authorization to enable any cron (gate item 5, S10). Approving T14-A means deferring the actual schedules to Stage 5 ops with explicit authorization.
- **T7-B** (automatic settlement ledger) was considered and rejected in favor of T7-A; if the product owner wants automated settlement, that requires a separate finance/ops decision and is out of scope for Stage 4 planning.
- Any change to the approved min 2 / max 5 group size (T13-B) would require re-opening rule F and the DB check constraints — not recommended.

### 8. Remaining questions requiring explicit product-owner input

- Confirm approval of all 11 recommended options (or per-decision selection).
- Confirm whether deferred settlement (T7-A) is acceptable for MVP or whether a settlement ledger is required before Stage 5 (would be a scope change).
- Confirm that no cron schedules are enabled in Stage 5 initial rollout (T14-A) — ops to define cadence later with explicit authorization.
- Confirm T5-A strict boundary is acceptable customer experience, or whether a configurable grace (T5-B) is desired (would require additional rules for group resurrection).

---

**End of decision pack.** Stage 4 remains planning only; Stage 5 is not authorized; no decision in this pack is approved until the product owner explicitly selects an option for each decision. No files were modified by this analysis (this document is a new deliverable only; `stage3-acceptance-closure.md`, `stage3-database-design.md`, `promotion.md`, `progress.md`, and all source/schema/migration/test/Flutter/Git state are unchanged).