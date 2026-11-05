# Foodi Paddi — Product and Technical Reference

**Purpose:** Describes what Foodi Paddi is, the technology stack, and what each area of the product
must achieve. **Progress, checklists, statuses and verification evidence are tracked exclusively in**
[`progress.md`](./progress.md)** — see §1. Read this file for requirements; read `progress.md` for status.

**Product:** A Nigerian food marketplace for home cooks, students, and small food vendors who cannot afford their own app or website. Customers order, vendors cook, and drivers deliver. Foodi Paddi is designed around small-vendor realities, not as a direct Glovo clone.

**Primary stack:** Node.js, TypeScript, Express, Prisma, PostgreSQL, Redis, Socket.IO, Paystack, Flutter mobile app, and React web frontend.

**Last content review:** 11 October 2026 · **Tracking split:** 15 October 2026 (Task 7.54)

> **How to use this file:** read it to understand the product and what each area requires, in phase order.
> For status, checklists, sequencing, evidence, outstanding work and the next authorized task, read
> [`progress.md`](./progress.md) — that file is the single authoritative progress tracker.

---

## 1. Current status at a glance

> **Status, milestone tracking, checklists and verification evidence have moved.**
> Phase and milestone statuses, task checklists and sequencing, implementation status, test and
> verification evidence, review and acceptance status, outstanding defects, deferred work, and the
> next authorized task are tracked **exclusively** in [`progress.md`](./progress.md).
>
> The milestone status table and the maintenance-work list that used to live here were relocated
> verbatim on 2026-10-15 (Task 7.54) and are preserved in that file.

This file documents **what the product is and what each area requires**. It does not record progress.
Read [`progress.md`](./progress.md) for anything of the form "is it done?".

## 2. Product definition and agreed decisions

### Product goal

Build a Nigerian marketplace where home cooks, students, and small vendors can sell meals without needing to create and maintain their own app or website. Customers discover food, pay, and receive orders through vendors and delivery partners.

### Roles and authentication

- `User.role` is the account's default role. It is not by itself the role in play for a request.
- `User.roles` contains all roles held by the account.
- `UserSession.activeRole` is the role a particular session is acting as, and is what authorization uses. A session with no active role falls back to `User.role`.
- Switching role is per-session: `POST /api/auth/switch-role` writes only the session, never the account-wide `User.role`.
- `ADMIN` is exclusive: it must be the only role an account holds, and it can never be self-assigned. The restriction is re-checked against the latest row when `POST /api/auth/become-vendor` writes, not only against an earlier read.
- `DELIVERY` may be combined with `CUSTOMER` only. It may never be combined with `VENDOR` or `ADMIN`. Holding `DELIVERY` is not by itself permission to operate — operational eligibility is a separate check.
- A user can hold both `CUSTOMER` and `VENDOR` roles.
- Email/password and Google login already exist; email OTP is implemented in Phase 1D.
- Email OTP login works even if the email address is not verified.
- Removing a login method must not leave an account with no usable login method.

### Vendor onboarding

- Lifecycle: `NEW → PENDING_REVIEW → ACTIVE → SUSPENDED`.
- Auto-approval after profile and KYC completion is controlled by configuration.
- Trust tiers and limits should reduce risk for new vendors rather than require manual review for every vendor.

### Checkout and money

- Checkout requires the `Idempotency-Key` header. The Flutter client already sends it, according to the existing plan.
- Phase 3 moves monetary values to integer kobo; avoid mixing naira floats and kobo integers.
- Payment, order creation, refunds, commission, discount funding, and vendor payouts must be auditable and concurrency-safe.

### Catalog

- Three layers: **Category** (admin-managed, approximately 12), **DishType** (admin-curated, approximately 60–80; vendors may suggest), and **Tag** (admin-managed, approximately 20).
- Vendors do not create categories. They may suggest new DishTypes for admin approval.
- Customers can browse by category, DishType, tag, or search.

### Promotions

- One promotion engine with `PLATFORM` and `VENDOR` scopes.
- Discounts without a code are automatic; code-based campaigns are gated.
- `fundedBy` must flow into order and payout calculations so the right party funds the discount.

### Orders and delivery

- Vendors have a confirmation window; expired unconfirmed orders are cancelled and routed through refund handling.
- Support preorder/scheduled orders, order cutoffs, daily vendor caps, and special requests.
- Pay on delivery is optional per vendor, subject to a configurable cap and no-show tracking.
- Group buy is rebuilt only after the wallet ledger exists (Phase 7b); start with admin-created campaigns.

### Pricing timers

- Use live price resolution at request time; do not replace it with fragile `setTimeout`-based promotion timers.

### Migrations

- A clean one-file migration baseline was reported as generated locally.
- Every subsequent schema change must use a normal, reviewed Prisma migration. Do not substitute `prisma db push` for production migration deployment.

---

## 3. How we work

| Step | Responsibility |
|---|---|
| 1 | ChatGPT writes a specific, scoped specification for the next task. |
| 2 | The local coding agent inspects and implements that task. |
| 3 | The agent reports changed files, reasoning, tests, and limitations. |
| 4 | ChatGPT reviews the report and either approves it or requests corrections. |
| 5 | Only after the task passes review do we move to the next task. |

### Working rules

1. **Local-first:** do not push to GitHub, deploy to Render, or change remote services unless explicitly approved later.
2. **One task at a time:** no starting the next task while the current task is awaiting review or correction.
3. **Read `AGENTS.md` first** before every coding-agent task.
4. **Inspect before changing:** audit existing code, tests, migrations, and contracts before implementing something that may already exist.
5. **Small changes:** fix demonstrated defects; avoid unrelated refactoring and redesign.
6. **Validation:** run focused tests, `npx tsc --noEmit`, and the full unit suite after each task when feasible.
7. **Evidence-based reporting:** report exact commands and actual results. Do not claim unexecuted tests passed.
8. **Mocks are not integration tests:** state clearly when Redis, PostgreSQL, provider, or concurrency behavior was only mocked.
9. **Protect secrets:** never read or print `.env` content, tokens, credentials, or other secret values in reports.
10. **External services:** no unapproved connections to Redis, PostgreSQL, Paystack, Render, or other services.
11. **Database safety:** no migrations, seeds, resets, `db push`, or destructive database actions without explicit task-specific authorization.
12. **Migration discipline:** schema changes require a migration and review; do not hide schema changes in an unrelated task.
13. **Documentation conflict:** do not modify `docs/engineering/remediation-status.md` until the conflict noted in `AGENTS.md` §10 has been resolved.
14. **Release gates are separate:** local implementation and tests do not automatically authorize a commit, push, database reset, or deployment.
15. **No invented progress:** a batch number or prior completion label is not proof. Verify actual code and test evidence.

### Definition of done for a task

A task is ready for review only when:


---

## 4. Track A — Product roadmap (requirements)

> The phase sections below state **what each phase must achieve**. They intentionally carry no status
> markers. Phase status, subtask checklists and verification evidence live in
> [`progress.md`](./progress.md) §9, populated from this file verbatim on 2026-10-15 (Task 7.54).

# Phase 1 — Authentication foundation *(in progress)*

## 1A — Read current code


## 1B — Multi-role accounts


## 1B.3 — Clean migration baseline


## 1C — Vendor onboarding status


### 1C evidence note — tracked in [`progress.md`](./progress.md) §9

> Evidence note relocated verbatim on 2026-10-15 (Task 7.54).

## 1D — Phone number and OTP login

**Goal:** Users can safely sign in with a verified email address as well as existing login methods.

### Requirements from the original plan

- Normalize email addresss to E.164, using Nigeria (`NG`) as the default region.
- `User.verifiedPhone` is unique and is set only after successful OTP verification.
- OTP is six digits, HMAC-hashed in Redis, and expires after five minutes.
- Maximum of five incorrect verification attempts.
- Resend cooldown: 60 seconds.
- Request limits: five OTP requests per email address per 24 hours and 20 per IP per 24 hours.
- Email provider abstraction with development driver that logs the code only in development and never sends email in dev.
- Endpoints: request OTP, verify OTP (returns the complete login session), manage email.
- Email OTP login works even when email is unverified.
- Removing the only usable login method is rejected.

### Subtasks

> The 1D.1–1D.7 subtask checklists and their current tick states are tracked in
> [`progress.md`](./progress.md) §9 (relocated verbatim, Task 7.54).

### 1D evidence note — tracked in [`progress.md`](./progress.md) §9

> Evidence note relocated verbatim on 2026-10-15 (Task 7.54).

## 1E — Session hardening and change password

**Goal:** Strengthen authentication after email OTP login is ready.


### 1E evidence note — tracked in [`progress.md`](./progress.md) §9

> Evidence note relocated verbatim on 2026-10-15 (Task 7.54).

## 1F — Final authentication verification and release review


### 1F.1 — Socket.IO handshake hardening — tracked in [`progress.md`](./progress.md) §9

> Evidence note relocated verbatim on 2026-10-15 (Task 7.54).

## 2A — Schema and seed data


## 2B — Product model improvements


## 2C — Vendor product API


## 2D — Customer browse API


## 2E — Tests and review


---

# Phase 3 — Orders, money, and refunds

**Goal:** An order reaches delivery without losing or misallocating a kobo.

## 3A — Money migration


## 3B — Order model hardening


## 3C — Vendor confirmation and timeout


## 3D — Preorder and scheduled orders


## 3E — Refund hardening


## 3F — Tests and review


---

# Phase 4 — Promotions engine

**Goal:** Platform and vendor promotions work with correct funding and payout math.

## 4A — Promotion model


## 4B — Promotion calculation service


## 4C — Vendor promotion tools


## 4D — Admin tools


## 4E — Tests and review


---

# Phase 5 — Vendor realities

**Goal:** The app works for home cooks and small vendors, not only established restaurants.

## 5A — Trust tiers


## 5B — Pay on delivery


## 5C — Group orders


## 5D — Tests and review


---

# Phase 6 — Delivery zones and drivers

**Goal:** A driver can be assigned, accept a delivery, and complete it safely.

## 6A — Zones


## 6B — Driver assignment


## 6C — Delivery flow


## 6D — Tests and review


---

# Phase 7 — Wallet and payouts

**Goal:** Vendor funds are traceable and every kobo reconciles.

## 7A — Wallet ledger


## 7B — Vendor payouts


## 7C — Tests and review


---

# Phase 7b — Group buy rebuild

**Dependency:** Phase 7A wallet ledger must be complete and reviewed before this phase begins.

**Goal:** Customers pool orders for discounts without putting funds at risk.


---

# Phase 8 — Growth and communication

**Goal:** Give vendors tools to attract customers and encourage repeat orders.

## 8A — Vendor storefront


## 8B — Notifications


## 8C — Referral rewards


## 8D — Student features


## 8E — Tests and review


---

# Phase 9 — Hardening and launch

**Goal:** Make Foodi Paddi operationally ready for a controlled real-world pilot.

## 9A — Security finish


## 9B — Operations


## 9C — Pilot


## 9D — Launch gate checklist


---

## 5. Track B — Backend reliability and security backlog

> **This backlog's statuses have moved.** The Track B item table — including the real-Redis and
> PostgreSQL deferrals, the cache-invalidation and checkout-idempotency records, and the
> cache-clearing safety work from Tasks 7.45–7.51 — is maintained **exclusively** in
> [`progress.md`](./progress.md). Relocated verbatim on 2026-10-15 (Task 7.54).

Track B remains a cross-cutting track. It must never replace or silently renumber a product milestone.

## 6. Next action

> **The next-task record has moved.** The previous "Next action — Phase 1D.1 audit" instruction
> block was relocated verbatim on 2026-10-15 (Task 7.54). The current next authorized task is
> recorded in [`progress.md`](./progress.md) §8 and, since Task 7.53, is subject to the still-open
> Phase 1D.1 acceptance decision.

## 7. How to keep this documentation current

After each reviewed task, update **`progress.md`** — not this file — recording:

- Date reviewed.
- Files changed (if any).
- Focused test result.
- TypeScript result.
- Full suite result or reason it was not run.
- Remaining limitations and approvals needed.

Do not mark a phase complete just because the latest batch passed. Mark it complete only when its
acceptance criteria and required review are evidenced.

**Source-of-truth rule (updated Task 7.54):** progress status, checklists and verification evidence
live only in [`progress.md`](./progress.md). This file owns product and technical documentation.
If the two disagree on *status*, inspect the source and test evidence and correct `progress.md`;
do not resolve a status conflict by editing this file.
