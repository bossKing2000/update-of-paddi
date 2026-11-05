# Foodi Paddi — Stage 3 Acceptance Closure Record

**Repository:** `/home/onyeka-ifeanyi/StudioProjects/update-of-paddi-main-backend`
**Date of closure:** 2026-11-03
**Record type:** Stage 3 acceptance (closure of the database-design review phase)
**Status of this record:** Final. Stage 3 is **ACCEPTED**, subject to the documented non-blocking findings and unverified assumptions recorded below.

---

## 1. Scope

This record closes Stage 3 of the Promotion and Group Buy development plan, defined in `promotion.md` as:

> Stage 3 – Design the Database Structure

The Stage 3 design is `docs/engineering/stage3-database-design.md`. Its findings matrix (Section 17), verification (Section 19), and acceptance criteria (Sections 19.2–19.5) are preserved unchanged in substance and are cross-referenced here, not rewritten.

**This record does not authorize implementation.** Stage 5 (implementation and test) remains unauthorized until Stage 4 is complete and explicitly approved, and until the product decisions listed in `docs/engineering/stage4-implementation-readiness.md` are resolved by the product owner.

---

## 2. The final independent audit verdict

The final independent Stage 3 acceptance audit (2026-11-03) returned:

**PASS WITH FINDINGS**

Findings statement, restated without altering its meaning:

- **No critical or high-severity design defects remain.**
- All approved business rules are represented consistently.
- **Decision A** is consistently specified (Option A: allocations frozen at qualification / payment-window start).
- Financial, authorization, inventory, concurrency and recovery requirements are **sufficiently precise for implementation**.
- Remaining implementation work and unverified integration assumptions are clearly recorded and are **non-blocking**.

The audit inspected: the design document, `promotion.md`, the Prisma schema, and the relevant payment, refund, inventory, scheduling, webhook, checkout and expiry code paths (`paymentFinalizer.service.ts`, `refundFinalizer.service.ts`, `inventory.service.ts`, `scheduling.service.ts`, `webhook.ts`, `cartController.ts`, `expireAwaitingPaymentJob.ts`, `verifyPendingPayments.ts`, `paymentController.ts`, `admin.controller.ts`).

No source code, migration, database, test, frontend, or Git state was modified by the audit.

---

## 3. What "accepted" means — and what it does not mean

### It means

1. The design is **approved as the basis for Stage 4 planning and Stage 5 implementation design**.
2. Stage 4 (Design the Backend Architecture) is authorized to produce its deliverable: an architecture and implementation-readiness plan.
3. The design's transaction boundaries, lock order, idempotency mechanisms, recovery paths and financial invariants are correct at the level required for a design phase.
4. Findings classified as **IMPLEMENTATION REQUIRED** are correctly identified and are expected to be satisfied in Stage 5 with the tests stated in the design (Sections 8.5, 10.2–10.3, 11.4–11.7, 14, and the 17.2 matrix).

### It does not mean

1. Stage 5 is approved or authorized to begin.
2. Any code, schema, migration, test, or job may be implemented yet.
3. The Category-relation real merged Prisma schema validation has passed (it remains **UNVERIFIED** — see Section 6).
4. Any product decision unresolved at the time this record was written is silently decided.
5. The design may be treated as runtime-verified; it was verified by documentation review and static source inspection only.

---

## 4. Findings disposition at closure

| ID | Severity/Category at final audit | Disposition |
|---|---|---|
| **B3** | Implementation required | Rewrite of `completeRefund`/`failRefund` (lock order `Payment` → `RefundRequest`; member-level completion for creator-pays-all). Design verified precise: Sections 8.9, 11.5, 6.8, 6.15. **Stage 5 batch 7.** |
| **B4** | Design defect corrected in documentation | Qualification limit check and counter increment are inside the `Promotion` row lock (B4 corrected 2026-11-01; verified present and consistent in Sections 10.2, 12.3, and 14.3). **Not open.** |
| **B5** | Implementation required | Full-refund derivation from cumulative `COMPLETED` refunds; no `isFullRefund` boolean. Design precise: Sections 10.5, 11.5. **Stage 5 batch 7.** |
| **B6** | Implementation required — new service | `finalizeGroupBuyPaymentSuccess` (full rewrite; not a branch) for Group Buy payment success + outbox rows only. Design precise: Sections 1.1, 6.11, 8.4, 8.8 item 1. **Stage 5 batches 5 and 8.** |
| **B7** | Implementation required | `GroupBuyPaymentProcessing` worker: `FOR UPDATE SKIP LOCKED`, lease fencing, retry/backoff, dead-letter. Design precise: Sections 6.11, 8.5, 8.7, 14.4, 15.1. **Stage 5 batch 8.** |
| **C5** | UNVERIFIED | Category targeting uses a valid implicit many-to-many Prisma relation; follows the `PromotionProducts` pattern. **UNVERIFIED against the real merged schema;** real merge + drift + relation validation required in Stage 5 batch 1. Not a design defect. |
| **C6** | Design defect corrected in documentation | `PromotionScope.CATEGORY` is admin-only; vendor creation/update rejects it; eligibility re-checks `product.vendorId = promotion.vendorId`. **Not open.** |
| **D1** | Implementation required | `DailyCapReservation` handling for Group Buy: drafts never reserve at checkout; worker creates reservations per confirmed order; existing expiry/release paths exclude Group Buy orders. Design precise: Sections 6.12, 8.1, 8.5, 8.8 items 3, 13. **Stage 5 batch 6.** |
| **D2** | Implementation required | Webhook `charge.success` must route Group Buy payments to `finalizeGroupBuyPaymentSuccess`. Design precise: Section 8.4. **Stage 5 batch 8.** |
| **D3** | Implementation required | `verifyPendingPayments` must detect Group Buy payments missing `GroupBuyPaymentProcessing` rows and trigger `groupBuyOutboxRepairJob`. Design precise: Sections 8.4, 8.8 item 13. **Stage 5 batch 9.** |

**No blocking finding remains open for acceptance. Acceptance was explicitly authorized by the product owner on 2026-11-03.**

---

## 5. Approved decisions that carry forward unchanged

The following decisions remain in force and may not be re-opened without new evidence or a product-owner instruction (`promotion.md`, Decision terminology):

- Minimum 2, maximum 5 members, including creator. Creator is a customer, not an admin or vendor.
- One-hour formation window; early close at selected capacity.
- Joining does not pay, does not reserve inventory, does not create a payment.
- Group-level usage consumed at qualification; released only on group failure.
- Per-user usage consumed at order completion; released only on a fully *completed* refund.
- Fixed discount pool = one unit of promoted product price × promotion percentage; equal division among final eligible paid members; integer kobo; deterministic remainder; never exceeds the pool.
- Individual payment is the default; creator-pays-all requires explicit acceptance of the full amount.
- Only confirmed successful payments count.
- Inventory reserved only after successful payment, with atomic checks.
- Stock unavailable → full refund of the affected member only; re-evaluate group viability; fail group below two fulfillable paid members; refund all remaining paid members.
- No product substitution; no partial fulfilment.
- Failed-group refunds are automatic, asynchronous, idempotent, retryable.
- No stacking with other promotions or promo codes.
- Vendor promotions may only target their own products.

**Decision A (Option A – Freeze allocation at payment-window start): RESOLVED 2026-11-01.** Pool and per-member allocations are finalized at qualification. Unpaid shares remain undistributed. See `docs/engineering/stage3-database-design.md` Section 4, `promotion.md` Decision A.

---

## 6. Unverified assumptions preserved at closure

These remain open and are **not** hidden by acceptance. Stage 5 must verify or escalate them.

| # | Assumption / open item | Required verification | Target |
|---|---|---|---|
| U1 | Merged Category many-to-many relation validates against the real schema (drift, join table, relation names, `CATEGORY` enum alteration, migration runner transaction behavior) | `npx prisma validate` on the **real** merged schema; migration diff; `migrate status`; drift check | Stage 5, batch 1 |
| U2 | `reserveDailyCap` genuinely operates within the caller's Prisma transaction for the Group Buy path | Integration test on real PostgreSQL proving atomic rollback of stock decrement when the cap is exhausted (and vice versa) | Stage 5, batch 6 |
| U3 | Webhook routing implementation for Group Buy payments works end to end (including duplicate webhook and replay claim) | Integration test: `charge.success` → `finalizeGroupBuyPaymentSuccess` | Stage 5, batch 8 |
| U4 | `verifyPendingPayments` handles Group Buy outbox gaps and triggers repair without duplicating jobs | Integration test | Stage 5, batch 9 |
| U5 | Real runtime behavior of lease expiry, reclaim and crash recovery | Integration/concurrency test | Stage 5, batch 8 |
| U6 | Frontend discovery of groups completed separately (Group Buy data never shown in ordinary Personal Buy surfaces) | Query review + regression tests | Stage 5, batch 10 |

---

## 7. Stage 4 authorization and Stage 5 gate

**Stage 4 (Design the Backend Architecture) is authorized for planning only.** Its deliverable, `docs/engineering/stage4-implementation-readiness.md`, is produced 2026-11-03 and requires independent review and product-owner approval before Stage 5 may begin.

**Stage 5 is not authorized.** It may not begin until:

1. Stage 4 is independently reviewed and approved.
2. The outstanding product decisions in `docs/engineering/stage4-implementation-readiness.md` (notably T1 – `Promotion.maxDiscount` interaction, and T8 – voluntary post-payment cancellation/refund) are explicitly decided by the product owner.
3. The Stage 5 migration is applied in a non-production environment and migration tests pass.
4. Personal Buy regression verification passes.

---

## 8. Documents changed as part of this closure

- `docs/engineering/stage3-database-design.md` — acceptance recorded in front matter, Sections 1.2, 18.4, 19.2, 19.3, 19.4, 19.5, Appendix C, end-note.
- `promotion.md` — Stage 3 and Stage 4 statuses, progress table, end-note.
- `progress.md` — brief acceptance entry.
- `docs/engineering/stage3-acceptance-closure.md` (this record) — created.
- `docs/engineering/stage4-implementation-readiness.md` — created (the authorized Stage 4 planning deliverable).

No source code, schema, migration, test, database, Flutter, or Git state was modified. `docs/engineering/remediation-status.md` was not read or modified.

---

*End of Stage 3 acceptance closure record. Stage 3 is accepted subject to the documented non-blocking findings and unverified assumptions. Stage 5 remains unauthorized.*
