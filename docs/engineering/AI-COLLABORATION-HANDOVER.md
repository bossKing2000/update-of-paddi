# Foodi Paddi — AI Collaboration Handover

**Repository:** `/home/onyeka-ifeanyi/StudioProjects/update-of-paddi-main-backend`  
**Purpose:** Transfer the product-design and technical-planning collaboration from ChatGPT to Claude AI  
**Document type:** Documentation only — no implementation  
**Last updated:** 2026-11-05  
**Authorization:** Documentation work only. No source code, schema, migration, test, database, or Git changes authorized by this document.

---

## 1. Collaboration Relationship

Claude is taking over as the user's **senior developer and product-design partner** for Foodi Paddi.

### What this collaboration is NOT

- Claude is **not** being hired merely to execute coding tasks.
- Claude should **not** assume every user idea is an implementation instruction.
- Claude should **not** automatically start coding, create migrations, change the database, or reopen accepted decisions without explicit discussion and agreement.

### How the collaboration works

The user and Claude collaborate as follows:

1. **The user shares** product ideas, questions, and goals.
2. **Claude helps understand** the intended outcome — asking clarifying questions, surfacing assumptions, and identifying risks.
3. **Claude challenges assumptions** and identifies business and technical risks.
4. **Claude proposes alternatives** and explains trade-offs.
5. **Claude and the user discuss** and settle decisions together.
6. **Claude helps translate** accepted decisions into technical designs.
7. **Claude prepares detailed prompts** for a separate coding agent when implementation is agreed upon.
8. **Claude reviews implementation reports** and helps determine the next steps.

Claude and the user reach decisions together; neither side unilaterally imposes a direction.

---

## 2. Promotion-System Vision

### 2.1 Why Foodi Paddi Has a Promotion System

Foodi Paddi is a Nigerian food marketplace connecting customers with home cooks, students, and small food vendors. Promotions serve two core business purposes:

| Purpose | Description |
|---------|-------------|
| **Demand generation** | Discounts lower the effective price, encouraging customers to place orders they might otherwise defer. |
| **Inventory movement** | Vendors can promote specific products to clear stock or drive volume during slow periods. |
| **Group purchasing** | Group Buy leverages social purchasing — customers form groups to unlock a shared discount pool, increasing average order value and vendor sales volume. |
| **Platform engagement** | Group creation and joining create repeat touchpoints within the app, increasing customer retention. |

Promotions are **discount mechanisms**, not payment instruments. They reduce the effective price a customer pays but do not create credit, store value, or transferable currency.

### 2.2 What the User Wants to Accomplish

The user wants Foodi Paddi to support two purchase models:

1. **Personal Buy** — the existing, production-grade individual purchase flow with promotions (automatic and code-gated). This is already implemented.
2. **Group Buy** — a new, customer-initiated group purchase where a customer creates a group from an available promotion, members join, pay individually (or the creator pays for everyone), and the discount is shared among paying members.

Group Buy is **entirely not implemented**. No database models, API endpoints, Flutter screens, or business logic exist for it. It requires full implementation across Stages 3–6 of the roadmap.

### 2.3 Personal Buy and Group Buy

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

### 2.4 How Promotion Codes and Purchasing Types Work

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

## 3. The Complete Group Buy Customer Journey

### 3.1 Discovery

1. Customer browses available Group Buy promotions (filtered by `purchasingType = GROUP`).
2. Public groups are discoverable; private groups require an invitation link or code.
3. Customer selects a promotion and creates a group.

### 3.2 Group Creation

1. Customer selects a promotion and clicks "Create Group."
2. Customer chooses group visibility (`PUBLIC` or `PRIVATE`) and maximum group size (2–5, default 5).
3. System creates a `GroupBuyGroup` record with:
   - `status = FORMING`
   - `formationDeadlineAt = now() + 1 hour`
   - `creatorId` = customer
   - `maxMembers` = selected (2–5)
   - `minMembers = 2`
4. Creator is automatically added as the first member (`GroupBuyMember` with `status = JOINED`).

### 3.3 Joining a Group

1. Customer discovers a public group or receives an invitation for a private group.
2. Customer clicks "Join."
3. System validates:
   - Group is `FORMING` (within formation window)
   - Group has not reached `maxMembers`
   - Customer is not already a member
   - Customer is eligible for the promotion (per-user limit not exhausted)
4. System creates a `GroupBuyMember` record with `status = JOINED`.
5. **Joining does not pay, does not reserve inventory, and does not consume any promotion usage limit.**

### 3.4 Group Closure and Qualification

1. The formation window closes (1 hour after creation, or early if capacity is reached).
2. The system qualifies the group:
   - If fewer than 2 members joined → group fails → `EXPIRED`, no payment collected.
   - If 2+ members joined → group qualifies → `QUALIFIED`, discount pool frozen, allocations computed.

### 3.5 Payment Window

1. After qualification, each member receives their exact amount due (product price minus allocated discount).
2. Each member has **30 minutes** to complete payment.
3. The creator may extend the payment deadline **once** by 15 minutes.
4. Payments are made individually (or via creator-pays-all).
5. Unpaid members expire at the deadline; their membership is released but does not cancel paid members.

### 3.6 Payment and Group Completion

1. Customer pays via Paystack (one unit of the promoted product).
2. System confirms payment via Paystack webhook (`charge.success`) or reconciliation.
3. If at least 2 members pay successfully → group proceeds → `QUALIFIED` orders confirmed.
4. If fewer than 2 members pay → group fails → all paid members receive full automatic refunds.

### 3.7 Fulfillment

1. After successful payment, inventory is reserved atomically.
2. Order is confirmed.
3. Vendor fulfills the order.

---

## 4. Discount Calculation and Allocation

### 4.1 Formula

```
Discount Pool = One Unit of Promoted Product Price × Promotion Percentage

Discount Per Eligible Paid Member = Discount Pool ÷ Final Eligible Paid Member Count
```

### 4.2 Example (₦20,000 product, 10% promotion)

| Eligible Paid Members | Discount Pool | Discount Per Member | Each Member Pays |
|----------------------|---------------|---------------------|------------------|
| 5 | ₦2,000 | ₦400 | ₦19,600 |
| 4 | ₦2,000 | ₦500 | ₦19,500 |
| 3 | ₦2,000 | ₦666.67 (66,667 kobo) | ₦19,333.33 (66,666 kobo for one member) |
| 2 | ₦2,000 | ₦1,000 | ₦19,000 |

### 4.3 Allocation Rules

| Rule | Description |
|------|-------------|
| **Fixed pool** | Pool is based on one unit price only — not multiplied by member count |
| **Equal division** | Pool divided equally among eligible paid members |
| **Integer kobo** | All monetary values in integer kobo (no floating-point) |
| **Deterministic remainder** | Indivisible kobo remainders allocated by `(joinedAt ASC, id ASC)` order |
| **Pool never exceeded** | `SUM(allocations) ≤ pool` always |
| **Freeze at qualification** | Allocations computed once at qualification; unpaid members' shares remain unallocated |
| **No redistribution** | If a member fails to pay, their share is **not** redistributed to paying members |

### 4.4 Delivery Fee

Delivery fees are **excluded** from the discount pool. Each member pays their own delivery fee separately:
`amountKobo = (productAmountKobo − discountKobo) + deliveryFeeKobo`

### 4.5 Commission

Commission is calculated on the discounted product price (`productAmountKobo − discountKobo`). Delivery fee is excluded from the commission base. Vendor payout = gross − commission.

---

## 5. Vendor Funding and Commission Implications

### 5.1 Who Funds the Discount?

| Promotion Creator | Funding Source | `fundingVendorId` |
|-------------------|---------------|-------------------|
| Vendor | `VENDOR` | The vendor who created the promotion |
| Admin/Platform | `PLATFORM` | `NULL` |

The funding source is **snapshotted at qualification** and stored on `GroupBuyDiscountPool`. It never changes after qualification.

### 5.2 Vendor Payout Implications

- Vendor payout snapshots already use `basePriceKobo − discountKobo` (delivery excluded).
- Commission is on the discounted base price.
- Vendor payout is already reduced because commission is on a lower base.
- The discount itself is **not** a separate line item in payouts under the current snapshot model — it is implicitly reflected in the lower base price.
- **No settlement ledger exists** for discount funding reversal (deferred to a future stage).

### 5.3 Refunds After Payout

If a vendor payout is marked `PAID` and a completed refund occurs later:
- Vendor keeps the payout.
- Platform absorbs the difference.
- No clawback mechanism exists in Stage 5.

---

## 6. Group Failure, Cancellations and Refunds

### 6.1 Group Failure

A group **fails** when fewer than 2 members successfully pay by the payment deadline.

**Handling:**
- All successfully paid members receive a **full automatic refund** to their original payment method.
- Unpaid members receive **no refund** (they were never charged).
- Refunds are initiated **immediately and asynchronously** when the group fails.
- Refund processing is **idempotent**, **retryable**, and **independently trackable**.
- Submitting a refund request is **not** proof that the refund completed.

### 6.2 Voluntary Cancellation (T8-B — Approved)

A member may voluntarily cancel before their order reaches `COOKING`:

- Full refund of the member's paid amount.
- Group is re-evaluated under the group lock.
- If the group drops below 2 fulfillable paid members → group fails → remaining paid members refunded.
- Other members' allocations are **untouched**.
- Inventory/daily-cap released via reservation ledgers.

### 6.3 Partial Refunds After Completion (T9-B — Approved)

Partial refunds are permitted after order completion:
- Member stays `PAID`; order stays `COMPLETED`.
- Per-user usage is **not** released until cumulative completed refunds reach the paid amount.
- `completedRefundAmountKobo` is incremented; `refundStatus` is derived.
- Allocation snapshot is unchanged.

---

## 7. Inventory, Daily-Cap and Promotion-Usage Rules

### 7.1 Inventory

| Stage | Rule |
|-------|------|
| Joining group | No inventory reserved |
| Unpaid members | No inventory held |
| After successful payment | Inventory reserved atomically |
| Stock unavailable after payment | Affected customer fully refunded; group re-evaluated |
| Multiple stock units | `ProductDailyCounter` per product per day |
| Group Buy draft orders | Do **not** create `DailyCapReservation` at checkout |

### 7.2 Daily-Cap

| Stage | Rule |
|-------|------|
| Group Buy drafts | Do **not** create `DailyCapReservation` |
| Confirmed member order | Worker creates `DailyCapReservation` per order |
| Group failure | `GroupBuyInventoryReservation` released (not `DailyCapReservation`) |
| Personal Buy orders | Unaffected by Group Buy logic |

### 7.3 Promotion Usage Limits

| Limit Type | Consumed When | Released When |
|------------|--------------|---------------|
| **Group-level** | Group qualifies (≥2 members) | Group subsequently fails |
| **Per-user** | Member's order successfully completes | Full refund (cumulative completed refunds reach paid amount) |

Joining a group does **not** consume either limit. Qualifying a group does **not** consume per-user allowance. Paying does **not**, by itself, consume per-user allowance — only order completion does.

---

## 8. Settled Business Rules (T1–T14)

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

**Do not reopen these decisions without new evidence or explicit product-owner authorization.**

---

## 9. Unresolved Decisions

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

## 10. Business-Rule Compliance Matrix

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

## 11. Current Stopping Point

### 11.1 What Has Been Implemented (Stage 5 Batch 1)

The following work has been **implemented and type-checked** (TypeScript compiles with zero errors). PostgreSQL DDL has **not** been executed due to missing database credentials.

#### Files Created (new source):

| File | Purpose |
|------|---------|
| `src/services/financialOperationClaim.service.ts` | Claim acquisition, state transitions, lease fencing, submission, settlement, reconciliation |
| `src/services/financialSubmissionFreeze.service.ts` | Service-layer freeze guard with DB-backed flag, fail-closed, stale-cache protection |

#### Files Created (new migration files — not executed):

| File | Purpose |
|------|---------|
| `prisma/migrations/20261105000001_stage5_enums_part1/migration.sql` | Step 1a: Create 6 new enum types |
| `prisma/migrations/20261105000002_stage5_payout_status_reversal_pending/migration.sql` | Step 1b: Add `REVERSAL_PENDING` to `PayoutStatus` |
| `prisma/migrations/20261105000003_stage5_payout_status_reversed/migration.sql` | Step 1c: Add `REVERSED` to `PayoutStatus` |
| `prisma/migrations/20261105000004_stage5_vendor_payout_order/migration.sql` | Step 2: Create `VendorPayoutOrder` table |
| `prisma/migrations/20261105000005_stage5_financial_operation_claim/migration.sql` | Step 3: Create `FinancialOperationClaim` + `FinancialOperationClaimLease` tables |
| `prisma/migrations/20261105000006_stage5_reversal_event_and_receipts/migration.sql` | Step 4: Create `ReversalEvent`, `ReversalEventLease`, `FinancialWebhookReceipt`, `FinancialWebhookReceiptConflict` |
| `prisma/migrations/20261105000007_stage5_backfill_and_indexes/migration.sql` | Steps 5-7: Backfill + partial unique indexes |

#### Files Modified (existing source):

| File | Changes |
|------|---------|
| `prisma/schema.prisma` | Added `REVERSAL_PENDING`/`REVERSED` to `PayoutStatus`; added 6 new enums and 8 new models; added inverse relations to `Payment`, `VendorPayout`, `RefundRequest`, `Order`; added `SystemConfig` model |
| `src/controllers/admin.controller.ts` | Deterministic Order locking (`FOR UPDATE ... ORDER BY id ASC`); claim acquisition integration; freeze check at `processPayout` entry; claim idempotency key as Paystack reference in `initiateVendorPayoutTransfer` |

### 4.2 Prisma Validation Result

| Item | Value |
|------|-------|
| Command | `DATABASE_URL="..." npx prisma validate` |
| Schema | `prisma/schema.prisma` (actual project schema) |
| Prisma CLI version | 6.19.2 |
| Result | **PASS** — "The schema at prisma/schema.prisma is valid 🚀" |
| Scope | Full project schema (not a temporary extract) |

### 4.3 Migration Execution — BLOCKED

| Item | Status | Details |
|------|--------|---------|
| Migration files created | 7 files | All under `prisma/migrations/2026110500000{1-7}_*` |
| Migration execution | **NOT EXECUTED** | Cannot authenticate to PostgreSQL |
| PostgreSQL version | 18.6 | Installed; cluster `18/main` online on port 5432 |
| Authentication | **BLOCKED** | Peer auth requires OS user `postgres`; TCP requires password; `.env` not accessible; no `.pgpass` |
| Database used | N/A | No database accessed or modified |

### 4.4 Tests Executed

| Test File | Tests | Result |
|-----------|-------|--------|
| `tests/unit/quantityBounds.test.ts` | 10 | ✅ Passed |
| `tests/unit/refundReservation.test.ts` | 15 | ✅ Passed |
| `tests/unit/paymentIdempotency.test.ts` | 13 | ✅ Passed |
| `tests/unit/orderBatch.test.ts` | 10 | ✅ Passed |
| **Total** | **48** | **✅ All passed** |

**Note:** These are pre-existing unit tests. No new tests were written for the new claim service, freeze service, or migration logic. No database-dependent or concurrency tests were executed.

---

## 12. Outstanding Work

### 12.1 High Priority

| Item | Status | Required |
|------|--------|----------|
| PostgreSQL DDL execution | BLOCKED | Obtain credentials; execute 7 migration files in order against disposable PostgreSQL 18 |
| `completeRefund`/`failRefund` claim acquisition | Not implemented | Must acquire `FinancialOperationClaim` with `Payment` → `RefundRequest` lock order |
| `transfer.reversed` webhook handler | Not implemented | Implement handler per design §8.4.2 |
| Reversal confirmation worker | Not implemented | Implement `processPendingReversals()` per design |
| Freeze guard integration into all entry points | Partially implemented | Only `processPayout` has the check; needs `POST /refund`, `completeRefund`/`failRefund`, workers, webhooks, Socket.IO, scheduled jobs |

### 12.2 Medium Priority

| Item | Status | Required |
|------|--------|----------|
| New tests for claim service | Not written | Unit tests for claim acquisition, state transitions, lease fencing |
| New tests for freeze service | Not written | Unit tests for freeze check, fail-closed behavior |
| New tests for reconciliation | Not written | Unit tests for `reconcileFinancialOperation` |
| Concurrency tests | Not written | Tests for deterministic Order locking, multi-payment claim acquisition, lease takeover |

### 12.3 Remaining Technical Risks

| Risk | Severity | Impact |
|------|----------|--------|
| PostgreSQL DDL not validated against live database | High | Cannot confirm DDL executes without errors |
| `settleVendorPayoutPaid`/`Failed` not updated with Order-first locking | Medium | Existing webhook settlement lacks mandatory Order locking |
| `verifyPendingVendorPayouts` not updated with Order locking | Medium | Reconciler lacks mandatory Order locking |
| `completeRefund`/`failRefund` not claim-integrated | Medium | Refund finalizer bypasses claim-based serialization |
| Reversal webhook not wired to Express routes | Medium | `transfer.reversed` events not processed |
| Freeze guard not integrated into all entry points | Medium | Only `processPayout` has the check |

---

## 13. Intended Direction

### 13.1 Immediate Next Activity

The immediate next activity is to **review the current Stage 5 Batch 1 implementation status**, understand its incomplete areas, and help the user decide the next appropriate steps. The implementation status document (`docs/engineering/stage5-batch1-implementation-status.md`) contains the full details.

### 13.2 Broader Objective

The broader objective is to continue developing Foodi Paddi's promotion system according to the established product vision, without losing earlier business decisions or unnecessarily redesigning accepted features.

### 13.3 What Is NOT Authorized

- **Do not** create a roadmap beyond what existing documents establish. Mark future activities as proposed when they have not been approved.
- **Do not** interpret planning approval as implementation authorization.
- **Do not** reopen accepted decisions (T1–T14, D-1 through D-12) without new evidence and explicit product-owner authorization.
- **Do not** silently change accepted business rules.
- **Do not** interpret a feature flag, design document, or planning document as authorization to implement.

---

## 14. User Working Preferences and Restrictions

### 14.1 Read First

- Read `AGENTS.md` first before every task.
- Read `README.md` for product requirements, roadmap information, and task dependencies.
- Read `progress.md` for current phase status, task sequencing, evidence, and the next authorized task.

### 14.2 Local Development Only

- Work locally by default.
- **Do not** push code to GitHub or other remote repositories unless explicitly requested.
- **Do not** create commits, rewrite Git history, or perform other Git operations that change repository state unless authorized. Read-only Git commands may be used to inspect project history and working-tree status.
- **Do not** deploy to Render or any other hosting provider unless explicitly authorized.
- **Do not** contact production services or perform production operations unless explicitly authorized.

### 14.3 No Secrets

- **Never** access `.env`, credentials, passwords, API keys, access tokens, refresh tokens, OTP secrets, or database credentials.
- **Never** print, disclose, or copy secret values in reports or user-visible output.
- **Never** access `docs/engineering/remediation-status.md` without explicit authorization — it is under a temporary documentation restriction per `AGENTS.md` §10.

### 14.3 No Production or Remote Database Access

- Local PostgreSQL databases (PostgreSQL 18, port 5432) are permitted for local development and testing **when authorized**.
- The version and port alone do **not** determine whether a database is safe to use.
- Inspect the project's database configuration and verify the target database before performing operations that could modify or delete data.
- Never run destructive tests or unintended schema changes against production databases or databases shared with other users or applications.

### 14.4 Discuss and Agree Before Implementation

- Discuss and agree on important design decisions before implementation.
- Do not silently change accepted business rules.
- Distinguish verified evidence from assumptions.
- Prepare detailed coding-agent prompts when implementation is agreed upon.
- Do not interpret planning approval as implementation authorization.

---

## 15. Continuity Instructions for Claude

### 15.1 First Actions

Claude should first read this handover and the referenced documents:

1. `docs/engineering/AI-COLLABORATION-HANDOVER.md` (this document)
2. `docs/engineering/promotions-product-design.md` — the product vision and business rules
3. `docs/engineering/stage5-financial-operation-design.md` — the Stage 5 financial-operation design
4. `docs/engineering/stage5-batch1-implementation-status.md` — the current implementation status
5. `docs/engineering/stage4-implementation-readiness.md` — the Stage 4 planning document with T1–T14 decisions
6. `docs/engineering/stage3-database-design.md` — the Stage 3 database design
7. `promotion.md` — the Promotion & Group Buy development plan
8. `docs/engineering/promotion-audit.md` — the existing promotion system audit
9. `AGENTS.md` — permanent agent instructions
10. `README.md` — product and technical reference
11. `progress.md` — the single authoritative progress tracker

### 15.2 Acknowledge Understanding

Claude should acknowledge its understanding of:

1. **The user's product vision** — Foodi Paddi is a Nigerian food marketplace; promotions enable discounted group purchases through Personal Buy and Group Buy models.
2. **The promotion-system goals** — demand generation, inventory movement, group purchasing, platform engagement; two creator types (admin/platform and vendor); customers create groups, not promotions.
3. **The decisions already made** — T1–T14 (all resolved), D-1 through D-12 (all resolved), the six Stage 5 Batch 1 owner decisions (worker lease placement, payout statuses, ReversalEvent scope, backfill execution, manual re-payout approval, unknown legacy discounts).
4. **The current technical implementation state** — Prisma schema updated and validated; 7 migration files created but not executed; claim service and freeze service implemented; `processPayout` updated with deterministic Order locking and freeze check; PostgreSQL authentication blocked.
5. **The outstanding work** — PostgreSQL DDL execution, `completeRefund`/`failRefund` claim integration, `transfer.reversed` webhook handler, reversal confirmation worker, freeze guard integration into all entry points, new tests, Personal Buy regression suite.
6. **The direction** — continue developing the promotion system according to the established product vision, without losing earlier business decisions or unnecessarily redesigning accepted features.

### 15.3 What Claude Should NOT Do

- **Do not** automatically start coding.
- **Do not** create migrations.
- **Do not** change the database.
- **Do not** reopen accepted decisions (T1–T14, D-1 through D-12).
- **Do not** interpret planning approval as implementation authorization.
- **Do not** invent a roadmap beyond what existing documents establish. Mark future activities as proposed when they have not been approved.

---

## 14. Accuracy Requirements

### 14.1 Use Existing Documentation and Verified Repository Evidence

All statements in this document are based on:
- `docs/engineering/promotions-product-design.md`
- `docs/engineering/stage5-financial-operation-design.md`
- `docs/engineering/stage5-batch1-implementation-status.md`
- `docs/engineering/stage4-implementation-readiness.md`
- `docs/engineering/stage3-database-design.md`
- `docs/engineering/stage3-acceptance-closure.md`
- `promotion.md`
- `docs/engineering/promotion-audit.md`
- `AGENTS.md`
- `README.md`
- `progress.md`
- Direct inspection of `prisma/schema.prisma`, `src/controllers/admin.controller.ts`, `src/services/payoutService.ts`, `src/services/payoutEligibility.service.ts`, `src/services/refundFinalizer.service.ts`, `src/controllers/webhook.ts`

### 14.2 Handle Disagreements

If the source documents disagree, **identify the disagreement rather than choosing whichever version looks convenient**. Report the conflict and do not silently override it.

### 14.3 Do Not Fabricate

Do not fabricate discussions, motivations, approvals, or future plans that cannot be established from the available documentation.

### 14.4 Detail Level

Keep the document detailed enough that Claude can continue the work without access to the previous ChatGPT conversation.

---

## 15. Final Report

| Item | Status |
|------|--------|
| Handover document created | `docs/engineering/AI-COLLABORATION-HANDOVER.md` |
| Source documents consulted | `AGENTS.md`, `README.md`, `promotions-product-design.md`, `stage5-financial-operation-design.md`, `stage5-batch1-implementation-status.md`, `stage4-implementation-readiness.md`, `stage3-database-design.md`, `stage3-acceptance-closure.md`, `promotion.md`, `promotion-audit.md` |
| Missing historical context | None identified — all key documents were located and read |
| Contradictions found | None — all documents are consistent on approved business decisions |
| Application code modified | No |
| Schema/migrations modified | No (beyond the implementation files already created as part of the authorized Stage 5 Batch 1 work) |
| Tests modified | No |
| Database accessed | No |
| Git history changed | No |

---

**End of AI Collaboration Handover Document.**

**This document is documentation only. It authorizes no implementation, no schema changes, no migrations, no database access, no Git operations, and no deployment.**