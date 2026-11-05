# Foodi Paddi – Promotion & Group Buy Development Plan

This document defines the business rules, architecture investigation, database design, backend implementation, testing, and Flutter integration roadmap for the Foodi Paddi Promotion and Group Buy system.

**Important process commitments:**

- This is a **phased development plan**. We must complete and review each phase before proceeding to the next.
- **Auditing and design must happen before implementation.**
- Existing functionality should be reused where appropriate.
- We must not introduce duplicate systems unnecessarily.
- **No schema or implementation changes should happen before the relevant design and approval stages.**
- This document is the **reference point for tracking this work** across all stages.

---

## Confirmed Business Rules

Record the following decisions accurately. These rules have been agreed upon and form the foundation for all subsequent design and implementation work.

### A. Promotion Ownership and Creation

Foodi Paddi has two promotion creators:

- **Admin/Platform** — platform-wide promotions.
- **Vendors** — promotions scoped to the vendor's own products.

**Customers cannot create promotions.**

**A promotion is separate from a Group Buy group.**

The admin or vendor creates and publishes a promotion. Customers discover an available Group Buy promotion, select it, and create their own group using that promotion.

One promotion can be used by multiple independent customer-created groups, subject to its eligibility and limits.

**Important distinction: A promotion is not a group.** A single promotion may be used by multiple customers to create separate groups. For example, several customers can independently select the same available promotion and create different groups.

### B. Admin Promotion Targeting

Admin-created promotions can target:

- The entire marketplace.
- Specific product categories.
- Specific products.

The platform must enforce the targeting rules when calculating discounts and validating purchases.

### C. Vendor Promotion Targeting

Vendor-created promotions can target only products belonging to that vendor.

A vendor must never be able to discount another vendor's products.

Vendor ownership must be enforced on the backend, not merely hidden or restricted in the Flutter interface.

### D. Personal Buy and Group Buy

Foodi Paddi has two purchase models:

**Personal Buy**
- A customer purchases individually.
- Existing Personal Buy promotion functionality should be preserved.
- Group Buy rules must not unintentionally change ordinary Personal Buy behavior.

**Group Buy**
- Customers participate in a group purchase using an eligible promotion.
- Group Buy is a distinct purchase model, not simply another name for Personal Buy.
- A promotion can support multiple independent groups.

### E. Group Creation and Visibility

- A customer creates a Group Buy group.
- The creator is a customer, not an admin or vendor.
- Groups can be **public** or **private**.
- Public groups can be discovered and joined by eligible customers.
- Private groups are not publicly discoverable. Eligible customers can join through an invitation link or code.
- A customer may create a group and wait for other members.
- **Customers may join multiple different groups.**

### F. Group Formation and Size

- **Maximum group size: 5 members**, including the creator.
- **Minimum group size: 2 members**, including the creator.
- A group does not have to reach five members before it can proceed.
- A group may proceed with 2, 3, 4, or 5 eligible paid members, provided the minimum is satisfied.

**Group Formation Window (Confirmed):**
- A customer creates a Group Buy group.
- The group has a **1-hour formation window starting from its creation time**.
- Other eligible customers can join during this period.
- The creator is included as a group member.
- Groups may be public or private.
- Public groups are discoverable and joinable by eligible customers.
- Private groups are not publicly discoverable and require an invitation link or code.
- Joining a group does not require payment.
- Joining a group does not reserve or deduct inventory.
- The group closes to new members when its one-hour formation window expires.
- If the group reaches its selected member count before the one-hour deadline, it may close early. Preserve the distinction between selected group capacity and the absolute maximum of five.

### G. Discount Calculation After Group Formation

After the group closes:

1. Determine the final number of eligible members.
2. If fewer than two members joined, the group fails without collecting payment.
3. If at least two members joined, calculate the fixed discount pool.
4. Divide the fixed discount pool equally among the final eligible group members.
5. Use integer kobo and deterministic remainder allocation.

The approved formula remains:

```
Discount Pool = One Unit of Promoted Product Price × Promotion Percentage

Discount Per Member = Discount Pool ÷ Final Eligible Member Count
```

Example:

- Product price: ₦20,000.
- Promotion: 10%.
- Fixed discount pool: ₦2,000.

| Members | Discount per member | Amount payable per member |
|---|---:|---:|
| 5 | ₦400 | ₦19,600 |
| 4 | ₦500 | ₦19,500 |
| 3 | ₦666.67, with a deterministic one-kobo remainder allocation | ₦19,333.33 or ₦19,333.34 |
| 2 | ₦1,000 | ₦19,000 |

The total allocated discount must never exceed the fixed discount pool.

Do not change this into a discount based on the combined value of all members' purchases or a tiered group-size discount.

### H. Payment Window After Group Closure

- Members receive their exact amount due after the group closes and the discount allocation is calculated.
- Each member gets **30 minutes to complete payment**.
- The creator may extend the group payment deadline once by an additional **15 minutes**.
- This extension is a one-time allowance.
- The extension must be enforced by the backend.
- Unpaid members lose their reserved membership places when the applicable payment deadline expires.
- Only successfully confirmed payments count toward the minimum group size and completion.
- Membership and payment remain separate concepts.
- A member joining a group does not mean that member has paid.

**Important:** The previous rule that each member's 30-minute payment window begins immediately after joining is replaced. The 30-minute payment window now starts after group formation closes and the discount is finalized.

### I. Payment Arrangements

There are two payment arrangements:

**Option 1: Individual payment (default)**
- Each member pays for their own purchase.
- A member's successful payment is tracked independently.
- Merely joining a group does not mean the member has paid.

**Option 2: Creator pays for everyone**
- The creator can explicitly choose to pay for all eligible group members.
- This option is available for both public and private groups.
- The creator must see the complete amount before confirming.
- The creator is not automatically responsible for other members' payments merely because they created the group.
- The creator must explicitly accept the responsibility and successfully pay the full amount.
- Once payment is confirmed, the system must correctly record the payment status of the covered members.

### J. Membership versus Payment

The system must distinguish between:

1. **Joining a group.**
2. **Successfully paying.**
3. **Group completion.**

A customer joining a group must not automatically count as a paid member.

Only confirmed successful payments count toward the minimum group size and group completion.

### K. Unpaid Members and Payment Outcomes

- If at least two members successfully pay, the group may proceed with those paid members.
- Unpaid members must not cause already-paid members to be cancelled merely because they failed to pay.
- If fewer than two members successfully pay, the group fails.
- All successful payments for a failed group must receive a full automatic refund to their original payment methods.
- Refund processing must be idempotent, retryable, and independently trackable.
- Joining without payment does not create a refund obligation.

### L. Shared Discount Pool and Redistribution

The Group Buy discount is a **fixed shared discount pool**.

**Formula (Approved):**

```
Discount Pool = One Unit of Promoted Product Price × Promotion Percentage

Discount Per Eligible Paid Member = Discount Pool ÷ Number of Eligible Paid Members
```

**Illustrative Example:**

- Product price: ₦20,000.
- Promotion percentage: 10%.
- Discount pool: ₦2,000.

| Eligible paid members | Discount per member | Each member pays |
|---|---:|---:|
| 5 | ₦400 | ₦19,600 |
| 4 | ₦500 | ₦19,500 |
| 3 | ₦666.67 approximately | ₦19,333.33 approximately |
| 2 | ₦1,000 | ₦19,000 |

The discount pool stays fixed at ₦2,000 in this example. The number of eligible paid members determines how it is divided.

When an unpaid member is removed, recalculate the equal discount allocation among the remaining eligible paid members.

**Important constraints:**

- Do not calculate the pool from the combined purchase value of every member.
- Do not multiply the discount pool by the number of group members.
- Do not apply the full promotion percentage independently to every member.
- The example assumes each member buys one unit of the same promoted product.
- If multiple quantities or products are supported, do not invent a calculation rule. Record the additional scope as requiring an explicit future business decision.
- Use **integer kobo** for all monetary calculations.
- Handle indivisible kobo remainders **deterministically and fairly**.
- The total discount must **never exceed the approved pool**.
- Do not silently charge members extra if a discount allocation changes after payment. Any adjustment must use a clearly disclosed and approved refund, credit, or additional-payment process.

**Three-member exact kobo allocation (preserved):**
- ₦666.67 discount (66,667 kobo)
- ₦666.67 discount (66,667 kobo)
- ₦666.66 discount (66,666 kobo)

The three allocations must total exactly ₦2,000 (200,000 kobo).

### M. Promotion Funding Responsibility

The creator of the promotion funds its discount.

- **Vendor-created promotion**: the responsible vendor funds the discount.
- **Admin-created promotion**: the platform/admin funds the discount.

The implementation must preserve the funding source and support financial reconciliation.

Do not silently transfer a vendor-funded discount to the platform or a platform-funded discount to a vendor.

### N. Failed Group Refunds

When a group fails because fewer than two eligible paid members remain after the payment deadline and any permitted extension:

- Automatically initiate a full refund for every successfully paid member.
- Refund each payment to its original payment method.
- Unpaid members receive no refund because they were never charged.
- **Initiate refunds immediately and asynchronously when the group fails.**
- Refund processing must be idempotent.
- Track refund states, including pending, successful, and failed.
- Provide retry handling and administrative visibility for failed refunds.
- A refund request being submitted must not be treated as proof that the refund has completed.

### O. No Discount Stacking

- Group Buy discounts cannot be combined with other promotions.
- Group Buy discounts cannot be combined with promo codes.
- Preserve existing Personal Buy promotion behavior separately.
- The final Group Buy price is the product price minus the member's allocated share of the fixed Group Buy discount pool.

### P. One Unit Per Member

- Each eligible member purchases exactly one unit of the promoted product in a group.
- Do not allow multiple units per member within the same group.

### Q. Same Product Per Group

- Every member of a group purchases the same promoted product.
- Different products cannot be combined in one group.
- Each group is associated with one promoted product and its applicable promotion.

### R. Inventory Reservation After Successful Payment

- Joining a group does not reserve inventory.
- Unpaid members do not hold stock.
- Inventory is reserved or deducted only after successful payment.
- Inventory updates must use atomic stock checks and appropriate concurrency protection.
- If payment is captured but stock is unavailable when the backend attempts to confirm the purchase, **the system must fully refund the affected customer automatically to their original payment method.**
- Do not silently substitute another product.
- Do not silently partially fulfil an affected customer's one-unit purchase.
- Inventory reservation and external payment confirmation must remain separate operations.
- Never treat an already captured payment as failed just because a later database or inventory operation fails.
- Re-evaluate whether at least two eligible paid members can still be fulfilled after affected members are refunded.
- If fewer than two eligible paid members remain, fail the group and fully refund all remaining paid members.
- Preserve idempotency, recovery, refund retries and auditability.

### S. Promotion Usage Limits

Group Buy promotions must support both:

**Group-level usage limit**
- Controls how many groups or successful group purchases the promotion can support.
- **The limit is consumed when the group qualifies for payment (i.e., when the group has at least two eligible members after the formation window closes).**
- If the group subsequently fails, the consumed group-level usage is released.
- If the group successfully completes, the consumed usage is retained.
- Concurrent group qualification attempts must not cause the limit to be exceeded.

**Per-user participation limit**
- Controls how many successful participations an individual customer can make under the same promotion.
- **The limit is consumed only when that member's order is successfully completed.**
- Joining a group does not consume the user's allowance.
- Qualifying a group does not consume the user's allowance.
- Paying does not, by itself, consume the completed-order allowance.
- A full refund releases the consumed per-user usage.
- Partial refunds must be handled explicitly; do not silently treat partial refunds as full refunds.

Promotion creators should be able to configure both limits, with sensible defaults and an unlimited option where appropriate.

Do not confuse group membership, joining, payment attempts, successful payments, and successful participation. The technical design must define exactly when a limit is consumed and released.

---

## Unresolved Business Decisions

**Decision A remains resolved (Option A — freeze allocation at payment-window start).** Product decisions **T1–T14** are all explicitly resolved below and recorded in `docs/engineering/stage4-implementation-readiness.md` §3. Decisions B–F are retained for traceability and marked resolved because the confirmed business rules in this document already answer them. No product decisions remain unresolved for Stage 4.

### A. Discount Allocation Timing — RESOLVED (Option A Selected)

**Product decision made: Option A — Freeze allocation at payment-window start.**

The approved rule says the fixed pool is divided equally among final eligible paid members. The payment window opens before it is known which members will actually pay.

**Selected Option A:**
Calculate the discount per member using all eligible members at the start of the payment window. Members who fail to pay do not have their shares redistributed. The unused portion of the pool remains unallocated.

| Dimension | Consequence |
|---|---|
| Financial | Each paying member pays the amount quoted at window start. The platform/vendor funds only the allocated portion; the unused pool is not spent. |
| Payment/refund | No post-payment adjustment. Unpaid members simply expire. Refunds remain full-refund-on-failure. |
| Database | Pool and allocations are finalized at qualification. `isFinal` becomes true at qualification; `finalizedAt` = `qualifiedAt`. |
| Concurrency | Qualification must be serialized per group; no later allocation writes. |
| Customer experience | Clear quoted price; some members may receive a smaller discount than a later paid-member count would have produced. |
| Compatibility | Compatible with "do not silently charge extra" and "total discount never exceeds pool." It does not redistribute unpaid shares. |

**Rejected alternatives:**

- **Option B (Finalize after payment closes):** Rejected — requires settlement mechanism; approved rules prohibit silently changing paid amounts.
- **Option C (Commitment/finalization step):** Rejected — adds unnecessary complexity; payment window serves as commitment window.

**Status: RESOLVED — Option A selected. Stage 3 is no longer blocked by this decision.** Do not re-open without new evidence or product-owner instruction.

### B. Exact Refund Timing and Operational Handling — DESIGN REQUIREMENT DOCUMENTED

**Confirmed rule:** refund initiation is immediate and asynchronous when a group fails. The database design records durable refund obligations in the same transaction as the group-failure transition and lets an asynchronous worker submit them. Retry counts, backoff, and escalation thresholds are implementation details for Stage 4/5, not unresolved business rules. **Requires rewrite of `completeRefund`/`failRefund` with lock order Payment → RefundRequest and member-level completion for creator-pays-all. New function signatures required accepting `groupBuyPaymentAllocationId`.** See `docs/engineering/stage3-database-design.md`, Sections 8.8 items 5–6, 11, and 18.3. **Status: DESIGN REQUIREMENT DOCUMENTED — implementation required.**

### C. Exact Group-Level Usage-Limit Counting and Consumption — DESIGN DEFECT CORRECTED IN DOCUMENTATION

**Confirmed rule:** group-level usage is consumed when the group qualifies and released only if the group subsequently fails. Joining a group does not consume it. A completed group does not release it. The database design enforces this with one `GroupBuyGroupUsage` row per group and a conditional release under the promotion lock. **Limit check and counter increment now occur inside the Promotion row lock to prevent race conditions.** See Stage 3 design, Sections 6.9, 10.2–10.3, and 12.3. **Status: DESIGN DEFECT CORRECTED IN DOCUMENTATION.**

### D. Exact Per-User Limit Consumption and Release — DESIGN REQUIREMENT DOCUMENTED

**Confirmed rule:** per-user usage is consumed only when that member's order is successfully completed. Joining, qualifying, and paying do not consume it. A full refund releases it; partial, pending, and failed refunds do not. The database design uses a non-consuming hold from qualification until completion, and derives full-refund status from completed refunds rather than a boolean. See Stage 3 design, Sections 6.10, 10.4–10.5, and 11.5. **Status: DESIGN REQUIREMENT DOCUMENTED — implementation required.**

### E. Inventory Reservation/Decrement and Compensation — DESIGN REQUIREMENT DOCUMENTED

**Confirmed rule:** inventory is reserved or deducted only after successful payment, with atomic stock checks. If payment is captured but stock is unavailable, the affected customer is fully refunded automatically and group viability is re-evaluated. The database design uses a durable payment-success outbox, conditional stock decrement, and a `GroupBuyInventoryReservation` ledger for idempotent release. **Requires refactor of `finalizePaymentSuccess` to defer order confirmation/stock to worker (new service `finalizeGroupBuyPaymentSuccess`), and `restoreStockForOrders`/`expireAwaitingPaymentJob` to skip Group Buy orders. Daily-cap handling: Group Buy drafts do not create `DailyCapReservation`; worker creates it per confirmed order; new `groupBuyDraftExpiryJob` releases only `GroupBuyInventoryReservation`.** See Stage 3 design, Sections 6.11–6.12, 8.4–8.6, and 8.8 items 1–3, 13. **Status: DESIGN REQUIREMENT DOCUMENTED — implementation required.**

### F. Other Policy Details — NOT A SEPARATE UNRESOLVED DECISION

Remaining technical and product details are listed explicitly in Stage 3 design, Section 18.2 (for example, delivery charges, daily-cap unit, late-payment boundary). They are **not approved business rules** merely because they are documented. Each must pass the normal review/approval gate before implementation. Do not turn a recommendation into an approved decision.

---

### T1 — `Promotion.maxDiscount` interaction with the Group Buy pool — RESOLVED (T1-A)

**Product decision: T1-A selected.** Group Buy ignores `Promotion.maxDiscount`. Configuration validation rejects `maxDiscount` set on a `purchasingType = GROUP` promotion at creation/update time; the field is inert for Group Buy.

**Rationale:** Keeps the approved discount formula unchanged (`floor(unitPrice × promotionPercentage)`, frozen at qualification under Decision A). No silent formula change; `SUM(allocatedDiscountKobo) = discountPoolKobo` invariant preserved; no silent customer-facing discount reduction.

**Consequences:**
- The `maxDiscount` cap that applies to Personal Buy percentage discounts does **not** apply to Group Buy.
- Admin-configured `maxDiscount` on a GROUP promotion is rejected with a validation error; it is not silently honored.
- Personal Buy behavior is completely unchanged.

**Blocking:** Was blocking batch 4 and batch 2 — now unblocked for T1.

---

### T8 — Voluntary member cancellation / refund after payment — RESOLVED (T8-B)

**Product decision: T8-B selected.** A paid member may voluntarily cancel their order before it reaches `COOKING`. Full refund of the member's paid amount (`GroupBuyPaymentAllocation.amountKobo`). Group is re-evaluated under `GroupBuyGroup` lock immediately after cancellation; if fewer than two paid confirmed members remain, the group fails and all remaining paid members are fully refunded. Other members' frozen discount allocations are untouched. Inventory and daily-cap reservations for the cancelled order are released via reservation ledgers.

**Consequences:**
- Creator-pays-all: refund is per-member only; the creator's payment is not fully refunded unless cumulative completed refunds across all allocations reach `Payment.amount`.
- Per-user usage released only on full member refund; order cancelled if in a cancellable status (never `COMPLETED`).
- Group qualification re-evaluated; group failure cascade possible.

**Blocking:** Was blocking batch 7 and batch 2 — now unblocked for T8.

---

### T9 — Partial refunds after order completion — RESOLVED (T9-B)

**Product decision: T9-B selected.** Partial refunds are permitted after an order has reached `COMPLETED`. Member stays `PAID`; order remains `COMPLETED` (never rewritten to `CANCELLED`); per-user usage is **not** released until cumulative completed refunds reach the member's paid amount; `completedRefundAmountKobo` incremented per completed partial refund; `refundStatus` derived (`PARTIAL` until cumulative completed ≥ paid amount, then `FULL`). Allocation snapshot unchanged.

**Consequences:**
- Creator-pays-all: each member's allocation is independent; partial refund of one member leaves that member `PAID`; other members untouched.
- `Payment.refundedAmount` incremented per completed partial refund; `Payment.status = REFUNDED` only when cumulative completed reaches `Payment.amount`.
- No inventory impact (order already fulfilled).

**Blocking:** Was blocking batch 7 and batch 10 — now unblocked for T9.

**T1–T14 all resolved.** No product decisions remain unresolved for Stage 4.

---

### T2 — Delivery fee / order-level charges in Group Buy — RESOLVED (T2-A)

**Product decision: T2-A selected.** Each member pays their own delivery fee separately. Delivery is **excluded** from the discount pool. `amountKobo = (productAmountKobo − discountKobo) + deliveryFeeKobo`. The discount pool remains `floor(unitPrice × promotionPercentage)` on product price only (rule L + Decision A).

**Consequences:**
- Delivery fees are independent order-level charges, not part of the fixed discount pool.
- Refund under T8-B/T9-B covers `amountKobo` including delivery.
- `SUM(allocatedDiscountKobo) = discountPoolKobo` invariant preserved.
- Personal Buy delivery-fee behavior completely unchanged.

**Blocking:** Was blocking batch 5 — now unblocked for T2.

---

### T3 — Payment-mode switching after failure — RESOLVED (T3-A)

**Product decision: T3-A selected.** Payment mode cannot be changed after qualification. Mode (`INDIVIDUAL` or `CREATOR_PAYS_ALL`) is frozen at qualification (§12.3 step 8 of stage3-database-design.md). A failed creator payment follows the group-failure/refund path (T8-B cascade); the creator may create a new individual-payment group.

**Consequences:**
- Preserves Decision A (frozen allocations, no post-payment redistribution).
- Consistent with rule I (creator-pays-all requires explicit upfront acceptance) and rule K (only confirmed successful payments count toward min-2).
- Creator who cannot pay under creator-pays-all must create a new individual-payment group.

**Blocking:** Was blocking batch 5 — now unblocked for T3.

---

### T4 — Daily-cap unit for Group Buy — RESOLVED (T4-A)

**Product decision: T4-A selected.** One daily-cap unit per confirmed member order (`DailyCapReservation` per `orderId, productId, day`), matching Personal Buy. A five-member group consumes up to five units of a product's daily cap.

**Consequences:**
- Matches rule P (one unit per member).
- `reserveDailyCap` is inherently per-order; per-member cap release under T8-B/T9-B is well-defined.
- Group Buy drafts never create `DailyCapReservation`; worker creates it per confirmed order.

**Blocking:** Was blocking batch 6 — now unblocked for T4.

---

### T5 — Late-payment boundary — RESOLVED (T5-A)

**Product decision: T5-A selected.** Strict payment deadline. Paystack `paid_at` timestamp authoritative; local success time is fallback (§12.4 of stage3-database-design.md). No grace period. A payment confirmed after `paymentDeadlineAt` does not count toward the group; it is refunded to the payer and does not resurrect a failed group (§12.5 of stage3-database-design.md).

**Consequences:**
- Deterministic cutoff; no hidden grace constant.
- Late payments refunded to original payment method.
- Group failure cascade preserved (§12.5 non-resurrection).
- Personal Buy payment window/tolerance unchanged.

**Blocking:** Was blocking batch 5 and batch 9 — now unblocked for T5.

---

### T6 — Commission base on discounted Group Buy orders — RESOLVED (T6-A)

**Product decision: T6-A selected.** Commission is calculated on the discounted product price (`productAmountKobo − discountKobo`). Delivery fee is excluded from the commission base (`orderSnapshot.service.ts`: `basePriceKobo` is net of discount, delivery fee excluded). Vendor payout = gross − commission.

**Consequences:**
- Reuses existing `orderSnapshot.service.ts` logic unchanged.
- Commission on actual discounted revenue; vendor does not pay commission on revenue never received (consistent with T7=VENDOR).
- Personal Buy commission/payout snapshots completely unchanged.

**Blocking:** Was blocking batch 5 finance — now unblocked for T6.

---

### T7 — Funding settlement and reporting — RESOLVED (T7-A — VENDOR funding)

**Product decision: T7-A selected.** The vendor funds the Group Buy discount (`promotion.md` rule M). `GroupBuyDiscountPool.fundingSource` = `VENDOR` with `fundingVendorId` = promotion's vendor id, snapshotted at qualification (§6.6 of stage3-database-design.md). For admin-created promotions, `fundingSource` = `PLATFORM` with `fundingVendorId = NULL`.

**Settlement model (deferred):** The funding responsibility is snapshotted at qualification and stored on `GroupBuyDiscountPool`. No settlement ledger, payout adjustment, or automatic transfer is designed in Stage 4/5. Settlement happens through existing vendor payout / platform finance processes outside this feature, informed by the snapshot. A dedicated settlement ledger may be designed in a later stage with finance/operations input.

**Consequences:**
- Funding responsibility snapshotted at qualification; never derived from a mutable promotion row.
- Funding visible for reporting via `fundingVendorId` index.
- Commission on discounted base (T6-A) means vendor payout already reflects the discount.
- Personal Buy has no Group Buy funding concept; untouched.

**Blocking:** Was blocking batch 5 and reporting — now unblocked for T7 (settlement ledger itself remains deferred to a later stage).

---

### T10 — Receipt timing — RESOLVED (T10-A)

**Product decision: T10-A selected.** Receipt generation occurs at payment success (existing `generateReceipt(payment.id)` in `paymentFinalizer.service.ts`), best-effort/non-critical. Receipt generation does not imply order confirmation; order-confirmation notifications wait for the worker (§18.2 of stage3-database-design.md).

**Consequences:**
- Customer gets a receipt immediately after paying — expected behavior.
- Receipt does not claim fulfilment; order-confirmation notifications wait for the worker.
- Personal Buy receipt timing completely unchanged.

**Blocking:** Was blocking batch 5 and batch 10 — now unblocked for T10.

---

### T11 — Group discovery — RESOLVED (T11-A)

**Product decision: T11-A selected.** Public groups are discoverable via the existing index `[visibility, status, formationDeadlineAt]`; private groups are invite-only (`inviteCode @unique`). QUALIFIED groups cannot accept additional members (joining restricted to `FORMING` status within the formation window, §12.2 of stage3-database-design.md).

**Consequences:**
- Public groups listed in discovery endpoint; private groups excluded.
- Private group join requires a valid, unique `inviteCode`.
- Capacity not leaked for private groups.
- Personal Buy promotion discovery unchanged (S3/S15).

**Blocking:** Was not a blocker — resolved for completeness.

---

### T12 — Promotion-code semantics — RESOLVED (T12-A)

**Product decision: T12-A selected.** Codes are optional for Group Buy (automatic `code == null` or code-gated `code != null`, same pattern as Personal Buy `promotionPricing.service.ts`). Code uniqueness is per `(vendorId, code)` (`@@unique([vendorId, code])` preserved). `purchasingType` separates PERSONAL and GROUP campaigns (S3/S15 isolation). A code created for a Group Buy promotion cannot be redeemed in a Personal Buy context and vice versa.

**Consequences:**
- Automatic Group Buy discount requires no code (matches "product embodies the promotion" model).
- Code-gated Group Buy campaigns require code entry — consistent with Personal Buy.
- Same code string cannot be used for both Personal Buy and Group Buy without schema change (`@@unique([vendorId, code])` does not include `purchasingType`).
- No stacking with other codes/promos (rule O).
- Personal Buy promotion code behavior completely unchanged.

**Blocking:** Was not a blocker — resolved for completeness.

---

### T13 — Group-size configuration — RESOLVED (T13-A)

**Product decision: T13-A selected.** Creator selects `maxMembers` within fixed range [2, 5] (default 5). `minMembers` fixed at 2. Both enforced by database check constraints (`maxMembers BETWEEN 2 AND 5`, `minMembers = 2`).

**Consequences:**
- Creator chooses group intimacy (2–5); members know the max at creation.
- Group may proceed with 2, 3, 4, or 5 eligible paid members, provided minimum satisfied.
- DB check constraints prevent invalid sizes; no new config surface.
- Group failure threshold min-2 consistent with T8-B group failure cascade.
- Personal Buy unaffected (no group-size concept).

**Blocking:** Was not a blocker — resolved for completeness.

---

### T14 — Reconciliation cadence — RESOLVED (T14-A — SPLIT)

**Product decision: T14-A selected.** Split reconciliation cadence following the existing design's stated job categories and frequencies (§15.1 of stage3-database-design.md):

| Cadence category | Jobs |
|---|---|
| Every minute | `groupBuyFormationDeadlineJob`, `groupBuyPaymentDeadlineJob`, `groupBuyDraftExpiryJob` |
| On formation close / retry | `groupBuyQualificationJob` |
| Continuous processing | `groupBuyPaymentProcessingWorker`, `groupBuyRefundWorker` |
| Every few minutes | `groupBuyRefundReconciliationJob`, `groupBuyInventoryReleaseJob`, `groupBuyOutboxRepairJob` |
| Hourly or daily | `groupBuyUsageReconciliationJob` |

**No cron enabled by default.** Stage 5 must obtain separate explicit authorization before enabling any scheduled job (§15.2 of stage3-database-design.md; Stage 4 gate item 5). Exact minute tuning is a Stage 5 operations decision.

**Consequences:**
- Split cadence matches each job's business SLA; no single uniform schedule.
- Jobs idempotent and bounded; no job holds transaction open across Paystack call.
- No cron enabled in Stage 5 initial rollout; separate explicit authorization required.

**Blocking:** Was not a blocker — resolved for completeness.

**T1–T14 all resolved.** No product decisions remain unresolved for Stage 4.

---

## Group Buy Lifecycle and Payment Safety (Conceptual)

Document the conceptual distinction between group states and payment states.

At minimum, explain that:

- A group can be **open** while waiting for members during its formation window.
- A group can have **joined members who have not paid**.
- A group can be **full** without all members having paid.
- A group can **qualify** after the formation window closes if it has the minimum number of eligible members.
- A group can **fail** if it does not reach the minimum paid-member count after the payment window closes.
- A group can be **cancelled or expire** according to finalized policies.

These are **conceptual requirements**, not authorization to implement a particular state machine or database structure.

Do not finalize technical statuses, schema fields, or transitions at this documentation stage.

---

# Development Roadmap

The following six stages must appear in this exact order. Each stage has defined deliverables and must be reviewed and approved before the next stage begins.

---

### Stage 1 – Audit the Existing Promotion System

<badge>Investigation first</badge>

Inspect the existing backend implementation and relevant Flutter frontend integration.

**Investigate:**

- Prisma `Promotion` model and related models.
- Promotion creation and management.
- Admin permissions.
- Vendor permissions and ownership restrictions.
- Request validation and DTOs.
- Controllers and routes.
- Services and business logic.
- Promotion eligibility.
- Discount calculation.
- Checkout integration.
- Order snapshots and financial records.
- Personal Buy promotion support.
- Existing Group Buy functionality, if any.
- Existing tests and API contracts.
- Flutter promotion-related models, screens, services, and API integration.

**Specifically investigate whether `Promotion.value`, currently identified in the schema audit as a polymorphic `Float`, safely supports percentage and fixed-amount discounts.**

**Determine:**

- What already works.
- What is partially implemented.
- What is missing.
- What should be reused.
- What requires modification.
- Potential financial, security, concurrency, and data-integrity risks.

**Deliverable:** A detailed audit report with evidence, file paths, findings, and recommendations.

**No implementation during this stage.**

---

### Stage 2 – Finalize Promotion Business Rules

Document and finalize:

- Personal Buy promotion rules.
- Group Buy promotion rules.
- Admin promotion permissions.
- Vendor promotion permissions.
- Product and category eligibility.
- Promotion activation and expiration.
- Discount types and calculation rules.
- Minimum and maximum purchase conditions, if required.
- Group membership and joining rules.
- Group completion requirements.
- Group expiration and cancellation.
- Whether a customer can participate in multiple groups.
- Whether a customer pays individually or through a shared payment.
- Discount funding responsibility.
- Promotion usage limits.
- Promotion stacking and coupon compatibility.
- Order cancellation, refunds, and promotion restoration.

**Newly approved decisions reflected in this document:**
- Failed group refunds (automatic full refund to original payment method).
- No discount stacking for Group Buy.
- One unit per member.
- Same product per group.
- Inventory reservation after successful payment only.
- Both group-level and per-user promotion limits.
- One-hour group formation window starting at creation.
- Discount calculation after formation closes.
- 30-minute payment window starting after formation closes.
- Creator one-time 15-minute payment deadline extension.
- Failed group automatic refunds.
- **Immediate asynchronous refund initiation when group fails.**
- **Group-level usage limit consumed at qualification; released on failure.**
- **Per-user usage limit consumed at order completion; released on full refund.**
- **Full automatic refund if inventory unavailable after payment; re-evaluate group viability.**
- **Category targeting reuses existing promotion targeting architecture.**
- **T1-A: Group Buy ignores `Promotion.maxDiscount`; `maxDiscount` rejected on `purchasingType = GROUP` promotions at creation/validation time.**
- **T2-A: Each member pays their own delivery fee separately; delivery excluded from the discount pool.**
- **T3-A: Payment mode cannot be changed after qualification.**
- **T4-A: Daily cap reserved per member order.**
- **T5-A: Strict payment deadline; no grace period; late payments refunded and cannot resurrect a group.**
- **T6-A: Commission calculated on discounted product price; delivery excluded.**
- **T7-A: Vendor funds the Group Buy discount (`fundingSource = VENDOR` snapshotted at qualification).**
- **T8-B: Voluntary member cancellation permitted before order reaches `COOKING`; full refund of member's paid amount; group re-evaluated under `GroupBuyGroup` lock; other members' allocations untouched; inventory/daily-cap released via reservation ledgers.**
- **T9-B: Partial refunds permitted after order completion; member stays `PAID`; order remains `COMPLETED`; per-user usage not released until cumulative completed refunds reach paid amount; `completedRefundAmountKobo` incremented; `refundStatus` derived.**
- **T10-A: Receipt generation occurs at payment success; best-effort/non-critical; does not imply order confirmation.**
- **T11-A: Public groups discoverable; private groups invite-only; QUALIFIED groups cannot accept additional members.**
- **T12-A: Codes optional; uniqueness per `(vendorId, code)`; purchasingType separates PERSONAL and GROUP campaigns.**
- **T13-A: Creator selects max 2–5; minimum group size fixed at 2.**
- **T14-A: Split reconciliation cadence following design-stated job categories and frequencies; no cron enabled by default.**

**Separate confirmed decisions from unresolved questions.**

**Deliverable:** An agreed business rules specification.

---

### Stage 3 – Design the Database Structure

Evaluate whether the existing Prisma `Promotion` model can support both Personal Buy and Group Buy.

**Investigate whether additional models or relations are necessary for:**

- Promotion purchasing type.
- Group Buy campaigns.
- Customer-created groups.
- Group membership.
- Group participation.
- Group purchase/order relationships.
- Promotion usage and redemption tracking.

**Evaluate:**

- Referential integrity.
- Uniqueness constraints.
- Transaction boundaries.
- Concurrency protection.
- Indexing.
- Financial precision using integer kobo.
- Migration safety and backward compatibility.
- Existing records and compatibility with Personal Buy.

**Do not create duplicate models or structures without justification.**

**Deliverable:** An approved database design, including a Prisma schema proposal and migration strategy.

**Current status:** `docs/engineering/stage3-database-design.md` is the accepted Stage 3 design (frozen allocation decision A selected; independent audit PASS WITH FINDINGS, no critical/high design defects; Stage 3 accepted 2026-11-03 subject to documented non-blocking findings — see `docs/engineering/stage3-acceptance-closure.md`). The design identifies **required implementation work** in Stage 5 (finalizer rewrite as new service, refund functions with new lock order and member-level completion, inventory restoration filter, webhook routing, pending-payment verification, DailyCapReservation integration, refund recovery for failed allocations, promotion-usage limit checks inside the Promotion row lock). Stage 4 is **ACCEPTED AND CLOSED — PASS WITH FINDINGS** (independent closure audit). Deliverable `docs/engineering/stage4-implementation-readiness.md` produced 2026-11-03. **Stage 5 is not authorized.**

---

### Stage 4 – Design the Backend Architecture

Define the backend architecture before implementation.

**Cover:**

- API endpoints.
- Request and response contracts.
- Admin promotion management.
- Vendor promotion management.
- Customer promotion discovery.
- Customer group creation.
- Group joining and leaving.
- Group membership validation.
- Promotion eligibility.
- Discount calculation.
- Checkout integration.
- Payment handling.
- Order snapshots.
- Group lifecycle.
- Transaction management.
- Idempotency.
- Concurrency protection.
- Authorization and ownership validation.
- Notifications and relevant events.

**Deliverable:** Backend architecture and API specification.

**Current status:** Planning deliverable produced 2026-11-03 — `docs/engineering/stage4-implementation-readiness.md`. It defines the 10-batch implementation plan, security requirements S1–S15, migration strategy, Personal Buy regression plan, and dependency order. Product decisions T1–T14 explicitly decided and recorded: T1-A, T2-A, T3-A, T4-A, T5-A, T6-A, T7-A (VENDOR funding), T8-B, T9-B, T10-A, T11-A, T12-A, T13-A, T14-A (split cadence). **Accepted 2026-11-03 — PASS WITH FINDINGS. Stage 5 is not authorized.**

---

### Stage 5 – Implement and Test

Implement the approved design in controlled, reviewable phases.

**Requirements:**

- Preserve existing Personal Buy functionality.
- Avoid regressions in checkout and payments.
- Enforce admin and vendor permissions on the backend.
- Enforce vendor product ownership.
- Enforce the five-member group maximum transactionally.
- Prevent duplicate membership and race-condition problems.
- Use integer kobo for monetary calculations.
- Preserve order and promotion snapshots.
- Add unit tests and integration tests.
- Test failure cases, concurrent requests, and payment edge cases.
- Run applicable type checks and regression suites.

**Do not claim tests passed without actual execution evidence.**

**Deliverable:** Implemented functionality and verification report.

**Current status:** Not started — **not authorized**. Blocked on Stage 4 approval and batch-1 migration verification against disposable infrastructure. T1–T14 all resolved. See `docs/engineering/stage4-implementation-readiness.md`.

---

### Stage 6 – Integrate the Flutter Frontend

Integrate the completed backend functionality into the Flutter frontend.

**Cover:**

**Admin interface**
- Create and manage promotions.
- Select promotion purchasing model.
- Configure discount.
- Select eligible product scope.

**Vendor interface**
- Create and manage vendor-owned promotions.
- Select eligible products from the vendor's catalogue.
- Enforce vendor ownership restrictions.

**Customer interface**
- Discover available promotions.
- Distinguish Personal Buy and Group Buy promotions.
- View promotion details and eligibility.
- Select a Group Buy promotion.
- Create a group.
- Share or invite others to join.
- View group membership and status.
- Participate in the purchase flow.

**Preserve existing frontend architecture and state-management conventions.**

**Deliverable:** Integrated Flutter experience with backend-connected testing.

---

## Financial and Security Principles

The following principles are mandatory for all implementation work:

1. **All monetary values used in financial calculations must follow the project's integer-kobo convention.**
2. **Percentage discounts and fixed-amount discounts must be explicitly distinguishable.**
3. **The backend is authoritative for discount calculations.**
4. **Never trust a discount amount supplied by the Flutter client.**
5. **A discount must never exceed the eligible purchase amount.**
6. **Vendor promotions must be restricted to the vendor's own products.**
7. **Customers must not be able to modify promotion terms.**
8. **Promotion changes must not retroactively alter already-created order snapshots.**
9. **Concurrent group joins must never exceed the five-member maximum.**
10. **Payment and order creation must be protected against duplicate processing.**
11. **Refunds and cancellations must correctly handle promotion usage and financial responsibility.**
12. **Preserve existing authentication, authorization, idempotency, and financial invariants.**

---

## Development Rules and Approval Gates

Record these rules:

- **Follow the roadmap sequentially.**
- **Do not skip the audit and business-rule stages.**
- **Do not start schema changes before database design has been reviewed and approved.**
- **Do not begin implementation before the relevant design has been approved.**
- **Do not remove existing functionality merely because it appears unused.**
- **Do not break backward compatibility without an explicit decision.**
- **Every implementation stage must include a verification report.**
- **Clearly distinguish observed code evidence from assumptions and recommendations.**
- **Identify unresolved questions rather than inventing answers.**
- **Do not update project-wide acceptance or release records unless explicitly authorized.**
- **Local development only unless explicitly authorized otherwise.**
- **No Git push, commit, deployment, or release as part of this plan.**

**The roadmap is not authorization to automatically implement every stage.** Each stage must be reviewed and approved before the next stage begins.

---

## Progress Tracking

| Stage | Status |
|-------|--------|
| Stage 1 – Audit the Existing Promotion System | Awaiting review |
| Stage 2 – Finalize Promotion Business Rules | Ready for final review/closure |
| Stage 3 – Design the Database Structure | **Accepted 2026-11-03** — subject to documented non-blocking findings (see `docs/engineering/stage3-acceptance-closure.md`); independent audit PASS WITH FINDINGS; Decision A resolved (Option A); B3, B5, B6, B7, D1, D2, D3 = IMPLEMENTATION REQUIRED; B4, C6 = corrected; C5 = UNVERIFIED (merged-schema validation deferred to Stage 5 batch 1) |
| Stage 4 – Design the Backend Architecture | **Accepted 2026-11-03 — PASS WITH FINDINGS** — `docs/engineering/stage4-implementation-readiness.md` produced 2026-11-03; product decisions T1–T14 all explicitly decided and recorded (T1-A, T2-A, T3-A, T4-A, T5-A, T6-A, T7-A VENDOR funding, T8-B, T9-B, T10-A, T11-A, T12-A, T13-A, T14-A split cadence). Payout/refund concurrency gap documented in §14; payout eligibility blocks refund activity per `payoutEligibility.service.ts`; payout marked `PAID` has no clawback mechanism. Stage 5 is **not authorized**; separate explicit product-owner authorization required. |
| Stage 5 – Implement and Test | Not started — **not authorized**. Blocked on Stage 4 approval and batch-1 migration verification against disposable infrastructure. T1–T14 all resolved. |
| Stage 6 – Integrate the Flutter Frontend | Not started |

**Status Legend:**

- **Not started** — Work has not begun.
- **In progress** — Work is actively underway.
- **Awaiting review** — Work is complete; awaiting review and approval.
- **Ready for final review/closure** — Business rules finalized; awaiting formal sign-off.
- **Approved** — Review complete; authorized to proceed to next stage.
- **Completed** — Stage fully done and accepted.
- **Blocked** — Cannot proceed due to an unresolved dependency or decision.

> **Do not mark any stage completed simply because this documentation file has been created.** Stages advance only through actual work, review, and approval.

---

*End of document. Stage 3 is accepted subject to documented non-blocking findings (see `docs/engineering/stage3-acceptance-closure.md`). Stage 4 is **ACCEPTED AND CLOSED — PASS WITH FINDINGS** (independent closure audit). Deliverable `docs/engineering/stage4-implementation-readiness.md` produced 2026-11-03. Stage 5 remains **NOT AUTHORIZED** — separate explicit product-owner authorization required. Do not implement schema, migrations, services, workers, or source changes under this document until Stage 5 is separately authorized. Stage 5 remains not authorized.*