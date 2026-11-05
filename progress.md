# Foodi Paddi — Progress Tracker

> **This file is a persistent working note for coding agents. It does NOT override `AGENTS.md` or user instructions, and it grants no permission.**
> It cannot authorize a commit, push, deployment, database operation, or scope expansion. `AGENTS.md` remains the
> authority on workflow and safety.
>
> **From Task 7.54 (2026-10-15) this file is the single authoritative progress tracker.** Phase and milestone
> statuses, task checklists and sequencing, implementation status, test and verification evidence, review and
> acceptance status, outstanding defects, deferred work and the next authorized task are maintained **only here**.
> `README.md` is the product and technical reference: what the product is and what each area must achieve.

- **Last updated:** 2026-11-03 (Promotion & Group Buy — Stage 3 accepted subject to documented non-blocking findings; Stage 4 implementation-readiness report **ACCEPTED AND CLOSED — PASS WITH FINDINGS** with all T1–T14 product decisions resolved; see `docs/engineering/stage3-acceptance-closure.md` and `docs/engineering/stage4-implementation-readiness.md`; prior: 2026-10-22 catalog contract hardening batch)
- **Previous tracker task entry (F-2.x):** F-2.0 — documentation-only F-2.x tracking and roadmap reconciliation
- **Previous tracker task entry (7.x):** Task 7.62 — session-deletion ownership scoping; see §12.4
- **Repository baseline:** see §2 — historical snapshots only; no live Git state was verified by this reconciliation
- **Repository:** `/home/onyeka-ifeanyi/StudioProjects/update-of-paddi-main-backend`

---

## Update protocol — mandatory for every future coding task

Every agent performing work in this repository must:

1. **Read this file first**, before any other project file.
2. **Verify the actual Git baseline** (branch, HEAD, staged paths) with live commands. Never trust the numbers recorded here — they go stale.
3. **Check the latest task entry** in §7 to avoid repeating completed work.
4. **Update this file after the task**, recording: what changed, files affected, commands run, exact outcomes (exit codes), risks, and the next action.
5. **Keep unverified items explicitly marked unverified.** Never upgrade a status without evidence.
6. **Record failed tests and blocked work.** Do not delete, soften, or hide failures.
7. **Never change a task's authorization or perform extra work to make this tracker look complete.** An incomplete tracker is better than a false one.

---

## 1. Project and workflow rules

- Foodi Paddi is **under local development**.
- **No GitHub pushes and no deployment** unless explicitly authorized.
- **No commits** unless explicitly authorized.
- Work on **one scoped task at a time**.
- **Never run database-changing commands** (migrations, resets, seeders, ad-hoc Prisma queries) without separate explicit authorization.
- **Preserve** every modified, untracked, ignored, and backup file. Never `reset`, `clean`, `checkout`, or `stash` to tidy a working tree.
- **Never claim** a test, check, or review was performed unless evidence supports the claim.
- **Do not inspect** `.env`, credentials, tokens, secrets, or `docs/engineering/remediation-status.md`.
- `docs/engineering/remediation-status.md` is under an active documentation restriction per `AGENTS.md` §10. Do not read, create, or modify it.
- Preserve the verified local backup at `~/backups/food-paddi/postgres_18.6_after-rebuild_20261015_135701.dump` (mode `600`). Verify by `stat`/checksum only; do not open it.
- Never use the production database `main_food_paddi` for tests or experiments.

### Document responsibilities (from `AGENTS.md` §10)

| File | Role |
|---|---|
| `AGENTS.md` | Permanent engineering rules and safety restrictions |
| `README.md` | Product and technical reference: purpose, stack, architecture, and what each area must achieve. **No progress status** (Task 7.54) |
| `docs/engineering/remediation-status.md` | Remediation status — **currently restricted, do not touch** |
| `progress.md` (this file) | **Sole authoritative progress tracker** (Task 7.54): phase/milestone status, checklists and sequencing, implementation status, test and verification evidence, review and acceptance status, outstanding defects, deferred work, next authorized task |

**Precedence (Task 7.54).** `AGENTS.md` remains authoritative for workflow and safety and cannot be
contradicted by this file. On **progress status** this file wins over `README.md`, which no longer carries
status, checklists or evidence. Where this tracker disagrees with the *source code or test evidence*, the code
and evidence win and this file must be corrected — never the reverse.

---

## 2. Repository baseline — HISTORICAL (verified at Task 7.21; now stale)

> **These counts are historical. They are not the current repository state.**
> They were verified live at **Task 7.21** (2026-10-15) and describe the tree as it stood then.
> Later documented work includes Tasks 7.54 and 7.60–7.62, and the unresolved Task 7.22 decision is still
> recorded below. This file does not establish the current index. **Always re-verify the baseline with live
> commands before acting on it**, per the update protocol in this file — do not rely on this table.

Historical snapshot, verified live at Task 7.21:

| Field | Value as of Task 7.21 (historical) |
|---|---|
| Repository path | `/home/onyeka-ifeanyi/StudioProjects/update-of-paddi-main-backend` |
| Branch | `main` |
| HEAD | `27a3a30b92422a43d4bb3dbb3817ce3687cbb47d` |
| Staged paths | 6 |
| Unstaged tracked | 91 |
| Untracked | 143 |
| Ignored | 8 |
| Stashes | 0 |

**Historical note:** at Task 7.21 this matched Task 7.20 exactly.

### Later verified snapshots (also historical — snapshots, not permanent values)

Each row below was verified live by the named task on that date. They are recorded so the drift is visible;
none of them is the current state.

| Verified at | Staged | Unstaged tracked | Untracked | Ignored | Stashes | HEAD |
|---|---|---|---|---|---|---|
| Task 7.54 / 7.55 (2026-10-15) | 21 | 92 | 321 | 37,849 | 0 | `27a3a30b` |

The intentional divergence in `tests/setup/pinTestRedisUrl.apply.ts` (index blob differs from the worktree copy)
is preserved and expected; it is not a discrepancy to clean up.

### Staged changes as of Task 7.21 (historical — NOT the current staged set)

The current index holds **21** staged paths. The following six were the staged set at Task 7.21:

```
M  package.json
M  src/jobs/seed.ts
A  src/jobs/seedFinancialFixtures.ts
A  src/jobs/seedFinancialRules.ts
A  src/services/orderSnapshot.service.ts
A  tests/unit/seederSafety.test.ts
```

The staged `package.json` change is exactly one line:
`"db:seed"` from `ts-node prisma/seed.ts && ts-node src/jobs/seed.ts` → `ts-node prisma/seed.ts`.

**As of Task 7.20, both `src/jobs/seedFinancialFixtures.ts` and `tests/unit/seederSafety.test.ts` have no remaining unstaged changes** — the index matches the worktree for both, so the F8 fix and its regression tests are staged and uncommitted.

### Unrelated worktree changes as of Task 7.21 (historical — do not touch)

- `package.json`: 3 jest-config script edits (`test`, `test:integration`, `test:redis-integration`) plus new dependencies `libphonenumber-js` and `socket.io-client`. The jest config files themselves (`jest.unit.config.js`, `jest.integration.config.js`, `jest.redis-integration.config.js`) remain untracked.
- 90 other modified tracked files and 138 other untracked files, including `src/services/*`, `src/controllers/*`, `tests/*`, `foodpaddi-website/`, `receipts/`, `scripts/`, and `.playwright-mcp/` (4 files).
- `README.md`, `AGENTS.md` and `progress.md` are themselves **untracked**.

---

## 3. Main development roadmap (Phases 1–9, 7B) — SUPERSEDED BY §9

> **This table is historical.** It was last reconciled at Task 7.21 and marks every row `NEEDS RECONCILIATION`.
> The authoritative phase status and checklists are in **§9**; corrections made by Tasks 7.33–7.53 are in
> §10. It is retained rather than deleted so the pre-Task-7.21 view is not lost.

**Source of truth:** `README.md` §1 and §4. The statuses below are transcribed from the previously reported README state and were **NOT re-verified during Task 7.17A**. Treat them as historical context. Anything uncertain or potentially stale is marked **NEEDS RECONCILIATION**.

Status vocabulary: `NOT STARTED` · `IN PROGRESS` · `IMPLEMENTED — REVIEW PENDING` · `BLOCKED` · `COMPLETE — VERIFIED` · `NEEDS RECONCILIATION`

| Phase / subtask | Status | Notes |
|---|---|---|
| 1A — Read current code | NEEDS RECONCILIATION | README reports `[x]`; recorded as complete. Not re-verified here |
| 1B — Multi-role accounts | NEEDS RECONCILIATION | README reports `[-]`; implemented locally, release review outstanding |
| 1B.3 — Clean migration baseline | NEEDS RECONCILIATION | README reports `[-]`. Materially advanced by commits `967d1836` and `27a3a30b`, but README not yet updated |
| 1C — Vendor onboarding status | NEEDS RECONCILIATION | README reports `[-]` with documented limitations; mocked evidence only |
| 1D — Phone number and OTP login | NEEDS RECONCILIATION | README reports `[x]` at milestone level; subtask boxes 1D.1–1D.7 deliberately left unticked |
| 1D.1 — Read-only implementation audit | NEEDS RECONCILIATION | README §1D.1 exists; README line 11 names it as the next task. **RECOMMENDED NEXT PRODUCT WORK — see §8 item 7** |
| 1E — Session hardening and change password | NEEDS RECONCILIATION | README reports `[-]`; `UserSession.activeRole` migration application reported unverified |
| 1F — Final auth verification and release review | NEEDS RECONCILIATION | README reports `[-]`; Phase 1 as a whole unaccepted |
| 1F.1 — Socket.IO handshake hardening | NEEDS RECONCILIATION | README reports independently accepted **within its defined scope** only |
| Phase 2 — Catalog | NOT STARTED | Starts after Phase 1 is reviewed and release-ready |
| Phase 3 — Orders, money, and refunds | ACCEPTED — TECHNICAL | Technically accepted by project owner (2026-10-30). Implementation verified: money kobo migration, order snapshots/Restrict FKs, daily-cap reservation/release wired into checkout + expiry/cancellation release paths, scheduled-order validation + cutoff enforcement wired into checkout. Not production-ready; release/push approval separate. |
| Phase 4 — Promotions engine | NOT STARTED | Depends on sound order and money calculations |
| Phase 5 — Vendor realities | NOT STARTED | Trust tiers, pay on delivery, group orders |
| Phase 6 — Delivery zones and drivers | NOT STARTED | Zone-aware dispatch and delivery lifecycle |
| Phase 7 — Wallet and payouts | NOT STARTED | Ledger-first financial accounting |
| Phase 7B — Group buy rebuild | NOT STARTED | Only after the wallet ledger exists |
| Phase 8 — Growth and communication | NOT STARTED | Storefronts, notifications, referrals, student features |
| Phase 9 — Hardening and launch | NOT STARTED | Security, operations, pilot, launch gates |

**Every roadmap row above requires reconciliation.** `README.md` is untracked and its milestone rows were last written before the recent migration and seeder commits. Reconcile in a dedicated documentation task — not during an unrelated one.

**Numbering note:** maintenance task numbers (7.12–7.17A) are **not** roadmap phase numbers. "Task 7.17" and "Phase 7" are unrelated. Phase 7 (Wallet and payouts) is NOT STARTED.

---

## 4. Maintenance task record — unresolved 7.22 decision

> **Status of this section:** last reconciled at Task 7.21. It is **not** a current Git-state report and
> does not establish the repository's next task. Task 7.22 remains an unresolved maintenance decision;
> F-2.x is tracked separately in §13.

| Field | Value |
|---|---|
| Latest 7.x task entry | **Task 7.62** — session-deletion ownership scoping; see §12.4. Not independently re-verified by this documentation task |
| Last 7.x code task | **Task 7.62** — one-line ownership-scoped deletion plus regression tests; see §12.4. The Task 7.22 commit decision is still unresolved |
| Current next task | **Not established.** Task 7.22 is the unresolved maintenance decision recorded at §8 item 1; F-2.20 is undefined and not authorized (§13). The Phase 2 per-item documentation reconciliation and the R-1/R-2 acceptance record were completed on 2026-10-21 (§9.3.1). **No implementation task is authorized by that work:** the Phase 2 acceptance decision, the daily-cap representation decision, the 2D open items and every R-1/R-2 follow-up all require separate user authorization. |
| Task 7.22 constraints | Requires explicit user authorization before any commit. Nothing is committed, pushed, or deployed by default |
| Current patch state | **Not inspected by this task.** Historical record: six paths were staged and uncommitted at Task 7.21. A later snapshot recorded 21 staged paths at Task 7.54 (§2). Neither count is a current Git-state claim |
| Pushes / deployments | **Not verified by this task.** Historical record through Task 7.62 reports no pushes or deployments |

### Context (historical — last reconciled at Task 7.21)

Commits created locally (not pushed):
- `967d1836` — Prisma migration history re-baseline + fail-closed rider default
- `27a3a30b` — track taxonomy seeder + opt-in guard

The patch recorded as staged at Task 7.21 hardens the demo-data seeder: adds the `SEED_ALLOW` opt-in guard, `assertNoPreviousDemoRun`, `assertTaxonomySeeded`, bcrypt password hashing (replacing a plaintext password), and a rider-financials correction (removing fabricated wallet balances). It also splits `db:seed` to taxonomy-only, and — as of Task 7.20 — carries the corrected F8 rider credit and its seven behavioural regression tests.

**This is maintenance work. It does not advance or complete any product roadmap phase.**

---

## 5. Verification ledger

**These are results REPORTED BY THE AGENT during Task 7.16A. They were NOT independently re-run during Task 7.17A.** Treat them as agent-reported, not independently verified.

| Command | Exit | Reported result |
|---|---|---|
| `git diff --check` | 0 | Clean |
| `git diff --cached --check` | 0 | Clean |
| `npx tsc --noEmit -p tsconfig.json` | 0 | No errors |
| `npx jest -c jest.unit.config.js tests/unit/seederSafety.test.ts` | 0 | 1 suite passed, **44 tests passed**, 44 total |

**Scope limits — these checks do NOT establish:**
- Database-backed validation of any kind (no PostgreSQL, Redis, or real service was contacted).
- That the guard fails closed *at runtime* — verified by static source inspection only.
- That taxonomy seeding produces the expected 12 categories / 65 dish types / 20 tags.
- That the seeder is idempotent, or safe on rerun, at runtime.
- That the financial snapshot service (`orderSnapshot.service.ts`) is correct — it has not received a dedicated production-logic review.
- Any release readiness. See `AGENTS.md` §9 on the distinction between complete, awaiting review, and accepted.

### Task 7.18 — executed and reported by the agent (worktree only, later staged by Task 7.20)

Fixed the confirmed HIGH-1 defect: the F8 fixture now increments **both** `totalDeliveries` and `walletBalance`, matching `src/services/deliveryEarning.ts:238-241`, inside the earning-create branch only. Added an **exact** `expectedDeliveries === 1` reconciliation guard (`!==` deliberately, so a double increment is caught rather than accepted). Added **seven behavioural regression tests** driving `seedFinancialFixtures()` through an expanded Prisma mock. **No database-backed validation was performed.**

| Command | Exit | Result |
|---|---|---|
| `npx jest -c jest.unit.config.js tests/unit/seederSafety.test.ts` | **0** | 1 suite passed, **51 tests passed** (was 44) |
| `npx tsc --noEmit -p tsconfig.json` | **0** | No errors |
| `git diff --check` | **0** | Clean |
| `git diff --cached --check` | **0** | Clean |

Two failures occurred during Task 7.18 and were fixed rather than hidden:
1. A newly written test of mine read `undefined` because I wrote `const [args] = mock.calls` (which yields the argument *array*) instead of `mock.calls[0]`. Diagnosed with a temporary trace, then removed.
2. Two **pre-existing** brittle string-match tests pinned the literal `data: { walletBalance: amounts.totalEarned }`, which the fix necessarily replaced. They were re-pointed at the new literal `walletBalance: { increment: amounts.totalEarned }` with their original intent intact (credit after create, reconcile outside the branch), and one was strengthened to assert both counters are credited together.

### Task 7.19 — read-only review, no commands that mutate state

Independently re-verified against the repository rather than trusting the Task 7.18 report, and found the discrepancy **before any commit**:

- The **index** version of `src/jobs/seedFinancialFixtures.ts` still contained `data: { walletBalance: amounts.totalEarned }` — direct assignment, **no** `totalDeliveries` increment, and `select: { walletBalance: true }` with no delivery-count guard. Committing the index as it stood would have landed HIGH-1.
- The **worktree** version contained the full fix.
- `src/services/deliveryEarning.ts` was confirmed unmodified in both the index and the worktree.
- Only the two Task 7.18 files had diverged; the other 91 modified files were pre-existing.

**No files were changed and no tests were run during Task 7.19.**

### Task 7.20 — restaging, executed and reported by the agent

Explicitly staged **only** `src/jobs/seedFinancialFixtures.ts` and `tests/unit/seederSafety.test.ts` with individual pathspecs. No `git add .`, `git add -A`, or `-a` flag. Afterwards `git diff --name-only` for those two paths returned **0** — index and worktree now match, and the staged content carries the increment fix, the reconciliation guard, and the regression tests.

| Command | Exit | Result |
|---|---|---|
| `npx jest -c jest.unit.config.js tests/unit/seederSafety.test.ts` | **0** | 1 suite passed, **51 tests passed**, 51 total |
| `npx tsc --noEmit -p tsconfig.json` | **0** | No errors; no `tsbuildinfo` artefact emitted |
| `git diff --cached --check` | **0** | Clean |
| `git diff --check` | **0** | Clean |

No commit, push, deployment, or database operation occurred.

**Even after Task 7.20, none of this is database-backed.** Every result above comes from source inspection and a fully mocked Jest suite. PostgreSQL behaviour — whether the increment actually lands, and whether the rider ends at `totalDeliveries = 1` — remains **unverified**.

---

## 6. Outstanding risks and validation

**ALL ITEMS BELOW ARE PREVIOUSLY REPORTED — REVALIDATION REQUIRED.** None has been independently reproduced against a live database. Do not treat any of them as confirmed or dismissed until a review re-checks it. Items updated by Tasks 7.18–7.20 are marked accordingly; all other Task 7.17 findings remain **OPEN**.

| # | Risk | Status |
|---|---|---|
| 1 | Fixture creation runs without a transaction; a mid-run failure leaves partial rows persisted | PREVIOUSLY REPORTED — REVALIDATION REQUIRED |
| 2 | The delivery-person wallet balance is **assigned**, not incremented, in the fixtures | **FIXED AND STAGED** — Task 7.18 corrected it to production increment semantics for both counters and added the delivery-count guard; Task 7.20 staged it. **Verified only under mocks — PostgreSQL behaviour unverified. Still uncommitted** |
| 3 | The demo-run count-then-write check has a potential TOCTOU race | PREVIOUSLY REPORTED — REVALIDATION REQUIRED |
| 4 | A default demo test password is hardcoded, though hashed before use | PREVIOUSLY REPORTED — REVALIDATION REQUIRED |
| 5 | Both seeders share the single `SEED_ALLOW=yes` guard | PREVIOUSLY REPORTED — REVALIDATION REQUIRED |
| 6 | The seed guard does not prevent a destructive database reset that runs beforehand | PREVIOUSLY REPORTED — REVALIDATION REQUIRED |
| 7 | No test proves Git-tracked status or committed-vs-worktree parity | PREVIOUSLY REPORTED — REVALIDATION REQUIRED. **Still open**: `readSrc` tests read the working tree, so a HEAD/worktree divergence is undetectable |
| 8 | The financial snapshot service has not received a full dedicated production-logic review | PREVIOUSLY REPORTED — REVALIDATION REQUIRED. **Widened by Task 7.17**: the file is genuinely new at HEAD, and 8 of its exports would land with no committed consumer and no test in this patch |
| 9 | Disposable-database validation is outstanding and requires separate authorization | PREVIOUSLY REPORTED — REVALIDATION REQUIRED |
| 10 | Fixture `totalPrice` omits production's `round()` (MED-2 in Task 7.17) | PREVIOUSLY REPORTED — REVALIDATION REQUIRED. No observable divergence with current integer fixtures; latent if fractional values appear |

**No database-backed validation was performed during Task 7.17A, and none may be performed without separate explicit authorization.**

---

## 7. Task history

| Task | Type | Outcome | Committed? |
|---|---|---|---|
| 7.12 | Implementation + commit | Committed `27a3a30b`: tracked `prisma/seed.ts` and `src/jobs/seedGuard.ts`, registered `prisma.seed` and the three `db:seed*` scripts. Seed entries only — unrelated `package.json` work deliberately excluded | **Yes** — `27a3a30b`, local only, not pushed |
| 7.14 | Read-only review | Established the dependency closure and side-effect inventory for the demo seeder. Recommended splitting `db:seed` to taxonomy-only (single `SEED_ALLOW`) over a second `DEMO_SEED_ALLOW` flag | No |
| 7.15 | Implementation + staging | Staged the six-path patch. Preserved the existing worktree seeder, added the three untracked dependency modules, applied a one-line `package.json` change index-only. Verified: `diff --check` 0, `tsc` 0, `seederSafety` 40/40 pass | **No — staged, not committed** |
| 7.16 | Test addition | Added a `readSrc`-based regression block asserting `db:seed` cannot reach the demo seeder. **Initially FAILED (exit 1, 2 of 4 new tests)** because the test reads the *worktree*, where `db:seed` still held the unsafe chain. Diagnosed and reported; did not weaken the test | **No — folded into the staged patch** |
| 7.16A | Implementation (one line) | Edited only the worktree `package.json` `db:seed` value to `ts-node prisma/seed.ts`, preserving all unrelated edits. Verified: both `diff --check` variants 0, `tsc` 0, `seederSafety` **44/44 pass, exit 0** | **No — staged, not committed** |
| 7.17A | Documentation | Created this `progress.md`. Documentation only — no code, index, or database operation | No — file intentionally left untracked |
| 7.17 | Read-only review | Confirmed HIGH-1: F8 assigned `walletBalance` and never touched `totalDeliveries`, diverging from `deliveryEarning.ts:238-241`. Also MED-1 (new 300-line service mostly consumerless at HEAD), MED-2 (missing `round()`), LOW-1/2. Verified F7 payout arithmetic and the snapshot-vs-legacy commission formulas as correct | No |
| 7.18 | Implementation (worktree only) | Fixed HIGH-1: `seedFinancialFixtures.ts` F8 now increments `totalDeliveries` and `walletBalance` exactly as production does, inside the earning-create branch only; reconciliation guard extended to assert `totalDeliveries === 1`. Added 7 behavioural tests using an expanded Prisma mock (51 total, up from 44). Re-pointed 2 pre-existing brittle string tests at the new literal. **Nothing staged or committed** | **No — worktree only at the time** |
| 7.19 | Read-only review | Independently re-verified and confirmed the **index** still held the defective F8 credit while the **worktree** held the fix — a discrepancy that would have landed HIGH-1 on commit. Confirmed `deliveryEarning.ts` production code untouched in both index and worktree. No files changed, no tests run | No |
| 7.20 | Staging | Explicitly restaged only `src/jobs/seedFinancialFixtures.ts` and `tests/unit/seederSafety.test.ts`. Index now matches worktree for both (0 remaining unstaged). Verified: Jest **51/51 pass**, `tsc --noEmit` exit 0, both `git diff --check` variants exit 0. No commit, push, deploy, or database operation | **No — staged, not committed** |
| 7.21 | Documentation | Reconciled this tracker to reflect Tasks 7.18–7.20. Documentation only; no application file, index, or database change | No — file intentionally left untracked |
| Phase 2 catalog contract hardening (2026-10-22) | Implementation + verification | B-1 public vendor projection, B-2 `GET /api/vendors/:vendorId`, B-3 search aligned with the canonical product card, B-4 shared page/limit validation, B-5 rating-cache invalidation on review writes, B-7 OpenAPI + nearby error envelope — 14 new files, 9 modified. Verified: `tsc --noEmit` exit 0; unit suite **179/179 suites, 3040 tests** exit 0; focused new/changed unit suites **9/9 suites, 174 tests** exit 0; integration suite **40/40 suites, 425 tests** exit 0 against a disposable PostgreSQL (127.0.0.1:55432) and a disposable Redis (127.0.0.1:6400); Redis-integration suite **6/6 suites, 51 tests** exit 0. No schema change, no migration, no Git command, no deployment, no production/remote access. Full record in §9.3.2 | **No — no commit was authorised; the worktree holds the change** |
| Stage 3 Database Design — Acceptance closure (2026-11-03) | Documentation | Independent Stage 3 acceptance audit returned **PASS WITH FINDINGS** (2026-11-03) — no critical/high-severity design defects; all approved business rules represented consistently; Decision A resolved (Option A); financial/authorization/inventory/concurrency/recovery sufficiently precise for implementation. Stage 3 **accepted** subject to documented non-blocking findings and unverified assumptions (C5). Closure: `docs/engineering/stage3-acceptance-closure.md`. **No implementation authorized.** | **No** |
| Promotion & Group Buy — Stage 4 planning deliverable (2026-11-03) | Documentation | `docs/engineering/stage4-implementation-readiness.md` produced: 10 independently testable Stage 5 batches, security requirements S1–S15, Personal Buy regression plan, migration strategy, dependency order, vendor discount settlement design, design consistency audit, implementation requirements, risks, acceptance criteria. Product decisions T1–T14 explicitly decided and recorded (T1-A, T2-A, T3-A, T4-A, T5-A, T6-A, T7-A VENDOR funding, T8-B, T9-B, T10-A, T11-A, T12-A, T13-A, T14-A split cadence). **Planning only — Stage 5 not authorized.** | **No** |

---

## 8. Next actions

> **Status of this section:** last reconciled at Task 7.21, with later additions in items 8–9. It is not a
> current priority queue. Task 7.22 remains an unresolved maintenance decision, not an established next
> task. F-2.x is tracked separately in §13.

1. **Task 7.22 — unresolved maintenance decision (not established as the next task).** Decide whether to commit the staged six-path patch, and how to handle the remaining Task 7.17 findings (MED-1 `orderSnapshot.service.ts` scope, MED-2 fixture omits production's `round()`, and the `readSrc` worktree-blind-spot in the test suite). This decision remains separate from F-2.x and is not authorized by the F-2.19 acceptance.
2. **Obtain explicit authorization before any commit.** Nothing has been committed for this patch.
3. Review the final staged diff in full before committing, not only the two Task 7.20 files.
4. Address the `expectedDeliveries = 1` hardcoded constant, the vacuous-loop risk in the `never assigns walletBalance` test, and the dead `seeded` variable — each needs its own narrow task.
5. **Re-run the relevant checks** after any approved fix.
6. Arrange **separately authorized** disposable-database validation — taxonomy counts 12/65/20, seeder idempotency, runtime guard behaviour, Prisma 6 auto-invocation on `migrate reset`, and whether the F8 rider actually reaches `totalDeliveries = 1`. **Never** against `main_food_paddi`.
7. **Phase 1D.1 — DECIDED 2026-10-15 (Task 7.53): NOT READY FOR ACCEPTANCE.** The audit itself is done
   (Tasks 7.33–7.34) and its findings re-verified against current source, but blockers remain: the
   original 1D.1 audit artifact is not persisted anywhere on disk; no acceptance has been recorded; and one
   requirement row stays PARTIAL (absent production SMS transport — see clarification below).
   **Next action is the user's acceptance decision, not new implementation.** See §10.2.
   - **Clarification added at Task 7.59 (the Task 7.53 wording above is preserved unchanged as the
     historical record).** One of those two PARTIAL rows was framed around **absent production SMS
     transport**. That framing was **inconsistent with the Phase 1D scope as later clarified**: production
     SMS transport is **not** an explicit requirement under `README.md:158-167` and is recorded as out of
     Phase 1D scope at §9.3 (the 1D evidence note, "Out of scope: a production SMS transport ... not recorded as a 1D defect"). It is therefore **not** to be
     read as a Phase 1D implementation defect, and it does **not** by itself stand as a Phase 1D.1 blocker.
     The other PARTIAL row — **live-PostgreSQL uniqueness of the canonical verified phone** — was closed by
     `tests/integration/phoneNumberUniqueness.test.ts` (3/3 passed) executed against a fresh disposable
     PostgreSQL in Task 7.60; §9.1 row 1D and §10.7 criterion 10 record this evidence.
   - **This does not make production SMS unnecessary for release.** Its formal release-gate status, and
     whether live SMS-delivery verification is required before a release, is **unresolved**: the eight-item
     Phase 1F gate (§9.2) does not explicitly settle it. Routed for an explicit decision in §10.6.
8. **Partially done at Task 7.54:** tracking was consolidated into this file (§9) and the stale §3 table was
   labelled superseded. **Phase 2 per-item reconciliation done 2026-10-21** (§9.1, §9.2, §9.3.1): the Phase 2
   checklist now distinguishes implemented / partial / deferred / unresolved per item, and the R-1/R-2
   deletion-protection work is recorded as accepted-with-follow-up. **Still open:** the Phase 2 **acceptance
   decision** — the phase remains `NEEDS RECONCILIATION` / not accepted, with the daily-cap representation
   decision, the 2D open items and the R-1/R-2 follow-ups still unresolved — and the remainder of the Phase
   2–9 contradiction recorded in §10.3, where `README.md` recorded Phases 3/4/6/7B/8 as not started while
   substantial implementations exist in source.
   **Do not mark any roadmap phase complete on the basis of these maintenance tasks.**
9. ~~NEW at Task 7.61 — awaiting a decision, not authorised for work.~~ **RESOLVED at Task 7.62.**
    `deleteUserSession` (`src/lib/session.ts`) deleted the `UserSession` row via the **global** `sessionId`
    primary key without a `userId` predicate, while every Redis operation in the same function *was* scoped by
    `userId`. A cross-account `DELETE /sessions/:sessionId` therefore destroyed another user's authoritative
    session row. Authorised and fixed in Task 7.62 with a single ownership-scoped
    `deleteMany({ where: { sessionId, userId } })` (`src/lib/session.ts:381`). Regression test
    `tests/integration/logoutRevocationHttp.test.ts` restored from `.bak` backup and **executed against
    verified disposable infrastructure (PostgreSQL port 55432, Redis port 6400): 7/7 tests passed**, including
    the cross-account ownership negative control proving the victim's session row survives a revoke attempt
    by another account. Unit tests `tests/unit/session.test.ts` and `tests/unit/changePassword.test.ts` pass
    (mocked). Full detail in §12.3/§12.4. **No longer open as a source defect; integration regression evidence
    verified at runtime — independent acceptance still outstanding.**

**F-2.x workstream (separate):** F-2.19 is recorded as accepted with non-blocking notes in §13. F-2.20 is
undefined and not authorized. This does not resolve Task 7.22.

10. **Phase 2 catalog contract hardening — IMPLEMENTED AND EXECUTED 2026-10-22, AWAITING REVIEW.**
    Items B-1, B-2, B-3, B-4, B-5 and B-7 were implemented and verified against a disposable local
    PostgreSQL and a disposable local Redis (unit 179/179 suites · 3040 tests, exit 0; integration 40/40
    suites · 425 tests, exit 0; Redis integration 6/6 suites · 51 tests, exit 0; `tsc --noEmit` exit 0).
    **This does not accept Phase 2**, does not close the 2B daily-cap decision or the four 2D open items,
    and does not replace the missing 2E consolidated review record — see §9.3.2 for the full record, the
    materially changed response shapes, and the remaining risks.
    **Candidate follow-ups that were explicitly NOT implemented and need separate authorisation:** a
    "vendor identity changed" cache invalidation (a brand-name/logo edit still leaves the 3-hour search
    cache stale) and any decision to make the product-detail cache re-read the vendor row instead of
    recomputing from its cache-only snapshot.

---

---

## 9. Roadmap checklists, statuses and evidence (relocated from `README.md`, Task 7.54)

> **This section is the authoritative tracker for roadmap status.** It was created on 2026-10-15 by
> Task 7.54, which removed duplicated progress tracking from `README.md` so that this file is the
> single source of truth. Content below is **relocated verbatim**, not re-derived: tick states, dates,
> test counts and limitations are exactly as `README.md` carried them. Nothing here has been
> upgraded to "verified" on the strength of a later task.
>
> **F-2.0 correction (2026-10-21):** the Phase 2 row in §9.1 has been reconciled from the historical
> `[ ]` snapshot to `NEEDS RECONCILIATION`; the original state is preserved in that row's note. No other
> historical row was changed.
>
> **Phase 2 annotation (2026-10-21, documentation-only):** the 2A–2E checklist blocks in §9.2 have been
> annotated with a per-item reconciliation status (implemented / partial / deferred / unresolved) drawn from
> source inspected in that task, and the Phase 2 overview in §9.1 and the open-items list in §10.3 now match
> them. The original unticked states are preserved inside the notes. **No box was ticked on the strength of a
> reported result alone, no phase was marked complete or accepted, and no application, test, schema or
> migration file was changed.** Evidence, provenance labels and the R-1/R-2 acceptance record are in §9.3.1.

**Staleness warning.** This material reflects reviews dated 2026-10-12/13 and the `README.md` state
before Tasks 7.33–7.53. Where those tasks changed the picture, the correction is recorded in §10 and
§11 rather than by silently editing the relocated text. **The 2A–2E blocks in §9.2 are the one annotated
exception:** they were updated on 2026-10-21 with per-item reconciliation notes drawn from source inspected
in that task, and every note states its evidence and provenance explicitly — see the annotation note above
and §9.3.1.

---

### 9.1 Phase status table (relocated from `README.md` §1)

Status labels mean:

- `[ ] Not started / not verified`
- `[-] In progress or needs verification`
- `[x] Completed and reviewed`
- `[!] Blocked or has an unresolved finding`
- **NEEDS RECONCILIATION** — conflicting documented status; no authoritative completion decision

These statuses reflect the latest reports available when this README was prepared. They are not a substitute for inspecting the actual local code before making a new change.

| Phase / milestone | Status | Notes |
|---|---|---|
| 1A — Read current code | `[x]` | Initial code review recorded as complete. |
| 1B — Multi-role accounts | `[x]` | Technical implementation reviewed against real disposable PostgreSQL (port 55434) and Redis (port 6399): `becomeVendorRoleWrite` 9/9, `multiRolePersistence` 10/10, `multiRoleSessionActiveRole` 5/5, `multiRoleHttpAuth` 9/9; full integration suite 30/30 suites / 264 tests; Redis-integration 6/6 / 51 tests; full unit suite 156 suites / 2572 tests; `npx tsc --noEmit` exit 0; `prisma migrate diff` reports empty migration (zero drift). Release/push approval remains separate and outstanding — not granted by this review. |
| 1B.3 — Clean migration baseline | `[x]` | Migration baseline verified: applies cleanly to fresh disposable PostgreSQL (port 55434); local dev DB (port 5432) consistent; all schema objects, seed data (12/65/20), and idempotency confirmed; `npx tsc --noEmit` clean; unit suite 156/2,572 passed. |
| 1C — Vendor onboarding status | `[-]` | Reviewed 2026-10-12 and hardened (fail-closed vendor-status gate, compare-and-swap fallback regression tests). Vendor-status service/middleware and onboarding controller are unit-tested (vendorStatus.test.ts). **Live PostgreSQL verification now done (Task 7.60), closing the prior "mocked evidence only" gap:** `tests/integration/vendorLifecycleHttp.test.ts` 7/7 drives the real auth router + real admin router over HTTP against disposable PostgreSQL — acquisition keeps the active role (`role` stays CUSTOMER while `roles` gains VENDOR), entry as `NEW`, `requirementsMet` gating (brand + verified phone + VERIFIED KYC) with the admin KYC write promoting `NEW -> ACTIVE`, `PENDING_REVIEW` when `VENDOR_AUTO_APPROVE=false`, `ACTIVE -> SUSPENDED -> ACTIVE` admin transitions with reason enforcement and `isLive=false`, illegal transitions refused, non-ADMIN refused, blocked accounts refused. Re-verified 7/7 on a freshly created database. **Not complete** — remaining gap is the production SMS/provider release decision (see §10.6), not vendor logic. |
| 1D — Phone number and OTP login | `[x]` | Reviewed 2026-10-12 against its documented requirements; all requirements mapped to satisfied. **Live PostgreSQL verification done for criterion 2 (phoneNumberE164 uniqueness) and criterion 3 (verification-only write guard):** real unique index enforced under concurrent duplicate writes (exactly-one-winner), NULLs allowed as distinct; P2002 surfaced to the app (tests/integration/phoneNumberUniqueness.test.ts 3/3). **Active email OTP evidence executed against verified disposable infrastructure (PostgreSQL port 55432, Redis port 6400):** `tests/integration/emailOtpHttp.test.ts` 29/29 tests passed (registration, email verification, email OTP login, expiry, attempts, cooldowns, per-email/per-IP rate limits, purpose separation, races, blocked accounts — real HTTP + real Redis + real PostgreSQL) and `tests/unit/emailOtpRateLimit.test.ts` (route-level Express `emailOtpRateLimiter` — mocked). `tests/integration/authHttpFlows.test.ts` executed 7/7 against real infrastructure (phone OTP request+verify, change password with tokenVersion bump, full reset flow forgot→verify-reset-code→secure-reset-password with single-use token, uniform no-enumeration responses, refresh-token rotation grace+theft). **This `[x]` is a historical status entry and does not establish final acceptance — see §10.2 and §10.7.** `1D.1` acceptance remains open (Task 7.53: NOT READY FOR ACCEPTANCE). |
| 1E — Session hardening and change password | `[-]` | Reviewed 2026-10-12 and implemented in source (session-scoped active roles, 15-minute access token, tokenVersion enforcement, change-password, secure reset). **Migration application re-verified (Task 7.60):** the worktree contains exactly one baseline, `prisma/migrations/20261016025918_init/migration.sql`; it applies cleanly to a freshly created disposable PostgreSQL, `prisma migrate status` reports "Database schema is up to date!", and `prisma migrate diff --from-migrations ... --to-schema-datamodel` exits `0` with "No difference detected" (zero drift vs schema.prisma). `UserSession.activeRole` is nullable and legacy NULL sessions insert/read correctly. **Real-HTTP + disposable Redis/PostgreSQL evidence expanded in Task 7.60:** `tests/integration/authHttpFlows.test.ts` now covers change-password (tokenVersion bump kills the pre-change token, old password rejected, new password accepted), the full reset flow `forgot-password -> verify-reset-code -> secure-reset-password` with single-use token replay refused, uniform no-enumeration responses on `forgot-password` and on public phone OTP, and refresh-token rotation including **both** documented outcomes — grace (re-presenting the immediately-previous JTI returns 200 and reuses the current JTI, `REFRESH_GRACE_SECONDS = 10`) and theft (a stale JTI outside the grace window returns 401 "Session compromised", revokes every session and bumps tokenVersion). Refresh now **fails closed with 503** when the replay store is unreachable. **Not complete** — see the 1E evidence note in §9.3 and §10.7. |
| 1F — Final authentication verification and release review | `[-]` | 1F.1 Socket.IO hardening accepted within its defined scope (see the 1F.1 record in §9.3). Order-event business logic remains unimplemented stubs. **1F.2 resolved as a scope definition in Task 7.60** — the user supplied the ten-item acceptance checklist that §10.5 recorded as undefined; it is recorded verbatim in §10.7. Integration regression tests `tests/integration/logoutRevocationHttp.test.ts`, `tests/integration/authHttpFlows.test.ts`, and `tests/integration/vendorLifecycleHttp.test.ts` were restored from `.bak` backups and **executed against verified disposable infrastructure (PostgreSQL port 55432, Redis port 6400) in Task 7.60/7.62**: logoutRevocationHttp 7/7, authHttpFlows 7/7, vendorLifecycleHttp 7/7, emailOtpHttp 29/29; full HTTP integration suite 35/36 suites / 318/318 tests; unit suite 155/155 suites / 2530 tests; `npx tsc --noEmit` exit 0; Redis integration phoneOtpRedis 18/18. All 10 Phase 1F.2 criteria are **VERIFIED** with active test evidence (see §10.7). Phase 1 technical acceptance criteria are satisfied; Phase 1 as a whole remains **NOT ACCEPTED** pending independent human review and release/push approval (separate governance decision — not granted). |
| Phase 2 — Catalog | **NEEDS RECONCILIATION — NOT ACCEPTED** | The historical entry said `[ ]` / not started. **Per-item reconciliation completed 2026-10-21, documentation-only** (§9.2 checklist; evidence and provenance in §9.3.1). **2A implemented** — `Category` / `DishType` / `Tag` / `ProductTag` / `CategorySuggestion` plus a 12-category, 65-DishType, 20-tag seed. **2B implemented** for `Product.categoryId` and `OptionGroup` / `OptionGroupItem`, with the legacy `ProductOption` and `options[]` contract preserved; **the daily-cap representation is an OPEN DECISION** (`Product.dailyOrderCount` column vs the `ProductDailyCounter` model) and no cap is enforced anywhere. **2C implemented at the code level** (create/update/archive, images, option groups, tags, dish-type suggestion + admin approve/reject) — code existence is not end-to-end acceptance. **2D partially implemented** (`/categories` with counts, `/categories/:slug/products`, `/tags`, dish-type/price/tag/sort filters, pagination) with four open items: no scheduled-status filter, no literal `GET /dish-types/:id/products` route, category/dish-type/tag matching is SQL/ILIKE rather than index-backed, and `productIndexQueue` has **no worker** in `src/`. **2E evidence exists per area but there is no Phase 2-level test/review record.** **R-1/R-2 deletion protection is recorded as accepted with follow-ups (§9.3.1).** **Catalog contract hardening batch executed 2026-10-22 (§9.3.2):** B-1 public vendor projection, B-2 `GET /api/vendors/:vendorId`, B-3 search shape aligned with the canonical product card, B-4 shared page/limit validation, B-5 rating-cache invalidation on review writes, B-7 OpenAPI + nearby error envelope — all implemented with executed unit and real-HTTP integration evidence (unit 179/179 suites, 3040 tests, exit 0; integration 40/40 suites, 425 tests, exit 0; Redis integration 6/6 suites, 51 tests, exit 0; `tsc --noEmit` exit 0). **This does not change the phase status, does not close the 2B daily-cap decision, the 2D open items or the 2E review gap, and is not an acceptance.** The phase status remains unresolved and no completion is claimed; phase acceptance is the user's decision. F-2.x is not assigned to this phase (§13). |
| Phase 3 — Orders, money, and refunds | `[x]` | Technically accepted by project owner (2026-10-30). 3A–3F implemented and verified: money kobo fields + migration; order commission/payout/discount snapshots + Restrict FKs; daily-cap `reserveDailyCap`/`releaseDailyCap`/`releaseOrderDailyCaps` wired into checkout (`cartController.ts:1242`), cancellation (`orderController.ts:812`), and expiry (`expireAwaitingPaymentJob.ts:125`); scheduled-order `parseScheduledAt`/`validateCutOff` wired into checkout (`cartController.ts:703, 1085-1095, 1329`). **Not production-ready** — release/push approval separate; live Paystack, production PostgreSQL historical data, and production Redis unverified; scheduled-order HTTP checkout integration coverage outstanding. |
| Phase 4 — Promotions | `[ ]` | Depends on sound order and money calculations. |
| Phase 5 — Vendor realities | `[ ]` | Trust tiers, pay on delivery, and group orders. |
| Phase 6 — Delivery zones and drivers | `[ ]` | Zone-aware dispatch and delivery lifecycle. |
| Phase 7 — Wallet and payouts | `[ ]` | Ledger-first financial accounting. |
| Phase 7b — Group buy rebuild | `[ ]` | Only after the wallet ledger exists. |
| Phase 8 — Growth and communication | `[ ]` | Storefronts, notifications, referrals, student features. |
| Phase 9 — Hardening and launch | `[ ]` | Security, operations, pilot, and launch gates. |

### Current maintenance work (separate from product phases)

- `[x]` Cache invalidation verification: post-commit invalidation reviewed and regression tests reported passing.
- `[x]` Checkout idempotency follow-up: `completeCheckoutKey` now reports completion-write success/failure, and mocked regression tests cover recovery of a committed order. Reported full unit suite: **112 suites / 1,682 tests passed**, with `npx tsc --noEmit` clean.
- `[-]` Real Redis/PostgreSQL integration verification remains outstanding. It is deferred unless a task needs it; do not provision infrastructure just to keep moving through unrelated code tasks.
- `[x]` Batch 1D.79 local infrastructure readiness audit: audit only; provisioning was deferred.

These maintenance items do not count as completion of Phase 1D phone/OTP login.

---


---

### 9.2 Track A phase checklists (relocated verbatim)

**## 3. How we work**

- [ ] The stated requirement and its acceptance criteria are addressed.
- [ ] The code change is limited to the task's scope.
- [ ] Relevant regression tests are added or existing coverage is demonstrated.
- [ ] Focused tests pass.
- [ ] `npx tsc --noEmit` passes.
- [ ] The full unit suite is run where feasible, with failures explained honestly.
- [ ] Security, race conditions, recovery, and error handling have been reviewed where relevant.
- [ ] The agent reports changed files and remaining limitations.
- [ ] Review approves the result before the next task starts.

**## 1A — Read current code**

- [x] Initial code review recorded as complete.
- [ ] Revisit particular areas only when a later task provides a concrete reason.

**## 1B — Multi-role accounts**

- [x] Implementation recorded as complete locally.
- [x] Review actual local implementation and regression evidence before release. Verified against real disposable PostgreSQL (port 55434) and Redis (port 6399): `becomeVendorRoleWrite` 9/9, `multiRolePersistence` 10/10, `multiRoleSessionActiveRole` 5/5, `multiRoleHttpAuth` 9/9; full integration suite 30/30 suites / 264 tests; Redis-integration 6/6 / 51 tests; full unit suite 156 suites / 2572 tests; `npx tsc --noEmit` exit 0; `prisma migrate diff` reports empty migration (zero drift). Release/push approval remains separate and is not granted by this review.
- [x] Confirm `User.role` versus `User.roles` behavior, role switching, become-vendor flow, and self-dealing guards. Verified: active role and held set are independent columns; switching the active role does not change the held set; become-vendor conditionally appends VENDOR and rejects ADMIN/DELIVERY holders; `authenticate` enforces blocked-account + role + tokenVersion checks on every request; the session is the active-role authority (stale token → 401).
- [ ] Keep release/push approval separate from implementation completion. Release/push approval remains the reviewer's separate decision and is not granted by this technical review.

**## 1B.3 — Clean migration baseline**

- [x] Baseline recorded as generated locally.
- [x] Review migration history, schema consistency, and deployment implications before release. Verified via disposable DB (port 55434): migration applies from empty state, `migrate status` reports up to date, pg_trgm + 3 partial unique indexes + 2 CHECK constraints + tsvector trigger all present, seed produces 12/65/20 with idempotent rerun.
- [ ] Do not reset or migrate a database without explicit authorization.

**## 1C — Vendor onboarding status**

- [x] Implementation recorded as complete locally.
- [ ] Verify the state transitions and configuration-controlled auto-approval before release.
- [ ] Confirm KYC and profile requirements, allowed actions per status, and regression tests.

**#### 1D.1 — Read-only implementation audit**

- [ ] Read `AGENTS.md` first.
- [ ] Inspect the current local implementation, schema, route registration, middleware, Redis OTP code, SMS provider interface, and tests.
- [ ] Map every original requirement to `PASS`, `PARTIAL`, `FAIL`, or `NOT PRESENT`.
- [ ] For each gap, cite the actual files/functions and relevant test evidence.
- [ ] Do not edit code during this audit.
- [ ] Return a recommended, ordered correction list with dependencies and test plan.

**#### 1D.2 — Phone model and normalization**

- [ ] Implement only audit-confirmed gaps in E.164 normalization, verified-phone uniqueness, and verification-only assignment.
- [ ] Test malformed numbers, default `NG` region, duplicate verified numbers, and unverified phone state.

**#### 1D.3 — OTP issuance and abuse controls**

- [ ] Verify six-digit cryptographically secure OTP generation.
- [ ] Verify HMAC-only OTP storage and five-minute TTL.
- [ ] Verify 60-second resend cooldown.
- [ ] Verify limits of five requests per phone per 24 hours and 20 per IP per 24 hours.
- [ ] Verify Redis/provider failures fail safely and do not leak OTPs or account state.
- [ ] Test limits, boundary times, failure recovery, and development-driver behavior.

**#### 1D.4 — OTP verification and phone login**

- [ ] Enforce no more than five incorrect attempts.
- [ ] Ensure successful OTPs are one-time use and cannot be replayed.
- [ ] Verify the full existing login-session contract is returned on success.
- [ ] Verify phone login is permitted when email is not verified.
- [ ] Test wrong, expired, replayed, and concurrently submitted codes as far as the available test infrastructure permits.

**#### 1D.5 — Phone management**

- [ ] Request and confirm adding a phone number.
- [ ] Verify the phone number is not marked verified before successful OTP confirmation.
- [ ] Remove a phone number only when another usable login method remains.
- [ ] Test ownership, duplicate-number, and failure cases.

**#### 1D.6 — Provider abstraction and tests**

- [ ] Verify the SMS-provider interface and development driver.
- [ ] Ensure development mode never sends real SMS and does not expose OTPs in production logs.
- [ ] Add regression tests for all applicable success, failure, abuse-limit, and session scenarios.

**#### 1D.7 — Review and close Phase 1D**

- [ ] Run focused OTP/phone tests.
- [ ] Run `npx tsc --noEmit`.
- [ ] Run the full unit suite where feasible.
- [ ] Record integration-test gaps separately.
- [ ] Obtain review approval before starting 1E.

**## 1E — Session hardening and change password**

- [ ] Store the active role per session rather than relying only on the global user role.
- [ ] Reduce access-token lifetime to 15 minutes.
- [ ] Add a secure change-password endpoint for authenticated users.
- [ ] Define and verify session/token invalidation behavior after password changes.
- [ ] Enforce blocked-account and role checks on every authenticated request, not only at login.
- [ ] Test role switching, revoked/expired sessions, blocked users, password change, and multi-role accounts.
- [ ] Run focused tests, `npx tsc --noEmit`, and the full unit suite where feasible.
- [ ] Obtain review approval before starting 1F.

**## 1F — Final authentication verification and release review**

- [ ] Run the full authentication regression suite.
- [ ] Confirm 1B, 1B.3, 1C, 1D, and 1E have been reviewed.
- [ ] Review migration compatibility and deployment order.
- [ ] Review environment-variable and secrets requirements without printing secret values.
- [ ] Confirm mobile/web clients' authentication expectations.
- [ ] Create a release checklist and obtain explicit approval for any branch push or deployment.
- [ ] Only reset a deployment database or run `prisma migrate deploy` after explicit authorization and a reviewed backup/recovery plan.
- [ ] Mark Phase 1 complete only after its release gate is approved.

**## 2A — Schema and seed data** *(reconciled 2026-10-21; scope: categories, dish types, and tags — evidence in §9.3.1)*

- [x] Audit existing models and migrations first. — *Done in source: `Category` (`prisma/schema.prisma:215-230`), `DishType` (`:236-258`), `Tag` (`:471`), `ProductTag` (`:484`), `CategorySuggestion` (`:507`). The original unticked state is preserved in this note.*
- [x] Add `Category` with `id`, `name`, `slug`, `icon`, `sortOrder`, and `isActive` where missing. — *Implemented: `prisma/schema.prisma:215-230` (`icon` `:219`, `isActive` `:221`).*
- [x] Link `DishType.categoryId` to Category. — *Implemented: `prisma/schema.prisma:247`.*
- [x] Add `Tag` with name and type: `CUISINE`, `DIET`, or `OCCASION`. — *Implemented: `prisma/schema.prisma:471` and the `TagType` enum.*
- [x] Add the `ProductTag` join table. — *Implemented: `prisma/schema.prisma:484`.*
- [x] Add `CategorySuggestion` for vendor-suggested DishTypes requiring admin approval. — *Implemented: model `prisma/schema.prisma:507`; vendor create `src/routes/vendorDashboard.routes.ts:50-51` → `src/controllers/admin.controller.ts:2813`; admin approve/reject `src/routes/admin.routes.ts:107-108` → `admin.controller.ts:2983, 3091`.*
- [x] Prepare a reviewed migration and idempotent seed strategy for about 12 categories, 60–80 DishTypes, and 20 tags. — *Seed implemented; counts **re-derived from source** in the 2026-10-21 task: 12 categories (`prisma/seed.ts:6-19`), 65 DishTypes (`:21-87`), 20 tags (`:89-110`), fail-closed completeness assert (`:121-128`), opt-in guard (`:132`). **Migration application and runtime idempotency were NOT independently verified** in that task — they remain reported results (§10.7).*

**## 2B — Product model improvements** *(reconciled 2026-10-21; scope: product schema and options — evidence in §9.3.1)*

- [x] Add add-on groups using `OptionGroup` and `OptionGroupItem`; plan replacement of flat `ProductOption` carefully. — *Implemented: `prisma/schema.prisma:366-410` (`OptionGroup`), `:412-446` (`OptionGroupItem`); vendor CRUD `src/routes/productRoutes.ts:65-71` → `src/controllers/optionGroupController.ts:52-83`. The legacy flat `ProductOption` model and the `options[]` response field are **preserved and are not deprecated by this task** (`prisma/schema.prisma:1207`; `src/controllers/productController.ts:564-565, 712`). Legacy-option handling is tracked in the separate F-2.x workstream (§13), which is **not** part of this phase.*
- [x] Add `Product.categoryId` as the denormalized category-filtering shortcut. — *Implemented: `prisma/schema.prisma:279`; derivation covered by `tests/unit/productCategoryDerivation.test.ts`.*
- [ ] Add `portionLabel`, `isScheduled`, `orderCutoffTime`, `dailyCap`, and `dailyOrderCount` where not already present. — *PARTIAL: `portionLabel` (`prisma/schema.prisma:284`), `isScheduled` (`:288`), `orderCutoffTime` (`:292`) and `dailyCap` (`:298`) exist **as columns only**. **There is no `dailyOrderCount` column**; the schema instead carries the `ProductDailyCounter` model with a `(productId, date)` composite key (`:452-461`). `src/jobs/seed.ts:2434-2436` records that production code does not read or enforce `isScheduled`, `orderCutoffTime`, `dailyCap` or `ProductDailyCounter`. The column-vs-table choice is an **OPEN DECISION — deliberately not resolved here; neither representation was added or implemented**. **Daily-cap enforcement is deferred to Phase 5A** (§9.2 5A).*
- [ ] Verify consistency with product schedules, pricing, inventory, and order creation. — *Not met: the schedule and cap fields are unenforced in production code (see above), so no consistency can be verified. **Deferred: scheduling → Phase 3D** (§9.2 3D), **daily caps → Phase 5A** (§9.2 5A). Scheduling fields must not be represented as functional merely because the columns exist.*

**## 2C — Vendor product API** *(reconciled 2026-10-21; scope: vendor product management — evidence in §9.3.1)*

- [x] Create, update, and archive products with images, add-on groups, and tags. — *Implemented: `src/routes/productRoutes.ts:52` (create), `:53` (update), `:60` (archive), with image/video upload fields (`:35`); `optionGroups` input parsed and validated `src/controllers/productController.ts:152-156` and written `:275-277`; `tagIds` normalised `:160-161` and resolved `:240-242`.*
- [x] Add vendor DishType suggestion endpoint. — *Implemented: `src/routes/vendorDashboard.routes.ts:50-51` → `src/controllers/admin.controller.ts:2813`.*
- [x] Add admin approve/reject suggestion endpoints. — *Implemented: `src/routes/admin.routes.ts:105-108` → `src/controllers/admin.controller.ts:2983` (approve), `:3091` (reject).*
- [x] Verify authorization, input validation, and vendor ownership. — *Verified in source: `authenticate` + `authorizeVendor` + `requireVendorNotSuspended` on every vendor write route (`src/routes/productRoutes.ts:52-60, 65-71`; `src/routes/vendorDashboard.routes.ts:50`), plus service-layer ownership checks (e.g. `src/services/optionGroup.service.ts:265-266, 296`). **Code existence is not end-to-end acceptance** — Phase 2 has no consolidated review/acceptance record (§9.2 2E, §9.3.1).*

**## 2D — Customer browse API** *(reconciled 2026-10-21; scope: category, tag, and product discovery — evidence in §9.3.1)*

- [x] `GET /categories` with counts. — *Implemented: `src/routes/productRoutes.ts:42` → `src/controllers/catalogController.ts:85-108` (`productCount`; count semantics documented at `:76-84`).*
- [ ] `GET /categories/:slug/products` with tag, min/max price, scheduled status, and sort filters. — *PARTIAL: route `src/routes/productRoutes.ts:43` → `src/controllers/catalogController.ts:124`; filters implemented in `src/services/product.service.ts:352-425` — `dishType` (`:380`), `tagIds` (`:383-385`), `minPrice`/`maxPrice` (`:387-390`), `sortBy` (`:421-425`). **No scheduled-status filter is implemented in this path**; scheduling behaviour belongs to Phase 3D unless the roadmap defines it otherwise.*
- [ ] `GET /dish-types/:id/products`. — *UNRESOLVED: the literal route was **not found**. `GET /api/product/dish-types` (`src/routes/productRoutes.ts:39`) lists DishTypes, and the product browse endpoint filters by DishType (`src/services/product.service.ts:380`). Whether the literal route is required, or the existing filter satisfies the requirement, is an **open product decision**. No route was added.*
- [x] `GET /tags`. — *Implemented: `src/routes/productRoutes.ts:44` → `src/controllers/catalogController.ts:55`.*
- [ ] Update the search index to include category, DishType, and tags. — *PARTIAL: search matches the full-text vector **or** the DishType name **or** the Category name **or** a tag-match expression (`src/controllers/productController.ts:1609`), but the full-text vector itself contains only `name` and `description` (`prisma/migrations/20261016025918_init/migration.sql:1788-1802`), so category / DishType / tag matching is SQL/ILIKE and **not index-backed**. **Whether index-backed search is required is an open product/technical decision.** No index change was made.*
- [ ] Review pagination, query limits, cache invalidation, and index-failure behavior. — *PARTIAL: pagination and query limits are implemented and covered by `tests/unit/searchPagination.test.ts` and `tests/unit/searchFuzzyPagination.test.ts`; a search/queue failure is non-fatal (`src/controllers/productController.ts:320-322`). **Open finding:** `productIndexQueue` (`src/jobs/workers jobs/redis-baseQueue.ts:13`) is enqueued with `"indexProduct"` (`src/controllers/productController.ts:320, 1151, 1233`) but **no worker for `productIndex` exists anywhere in `src/`** — the enqueued indexing work is vestigial and **queue processing is not claimed to be functional**. No worker was created. **Updated 2026-10-22 (§9.3.2):** the pagination and query-limit half of this item is now HARDENED — all five catalog routes share one validator (`src/validations/catalogPagination.ts`), a malformed / zero / negative value is rejected with 400 `VALIDATION_ERROR` instead of reaching Prisma as `NaN`, and the above-maximum behaviour is documented as clamping (evidence: `tests/unit/catalogPagination.test.ts`, `tests/unit/catalogPaginationRoutes.test.ts`, and the real-HTTP assertions in `tests/integration/catalogContractHttp.test.ts`). Cache invalidation for the review path is now targeted and observable (§9.3.2 B-5). **The item stays unticked:** the `productIndex` worker finding is still open and index-failure behaviour was not re-reviewed.*

**## 2E — Tests and review** *(reconciled 2026-10-21 — evidence in §9.3.1)*

- [ ] Test authorization, category assignment, suggestions, filtering, pagination, and search-index updates. — *PARTIAL: focused per-area suites exist — `tests/unit/productTags.test.ts`, `productCategoryDerivation.test.ts`, `suggestionCacheInvalidation.test.ts`, `productOptionGroups.test.ts`, `searchPagination.test.ts`, `searchFuzzyPagination.test.ts`, `searchRelevance.test.ts`, `dishType.test.ts`, `tagCacheInvalidation.test.ts` — together with the R-1/R-2 deletion-protection suites (§9.3.1). These are per-area suites; **no consolidated Phase 2 test record or acceptance review exists.** The existence of a test file is not a passing run. **Updated 2026-10-22 (§9.3.2):** new per-area suites were added and executed for the catalog contract items — `tests/unit/publicVendorProjection.test.ts`, `vendorProfileService.test.ts`, `catalogPagination.test.ts`, `catalogPaginationRoutes.test.ts`, `searchProductCard.test.ts`, `reviewRatingCacheInvalidation.test.ts`, `nearbyErrorEnvelope.test.ts`, `openapiCatalogContract.test.ts`, plus `tests/integration/catalogContractHttp.test.ts` (42 real-HTTP tests). **The item stays unticked:** this is still per-area coverage, and the consolidated Phase 2 review/acceptance record still does not exist.*
- [ ] Run focused tests, TypeScript validation, and the full suite where feasible. — *PARTIAL: full-suite and TypeScript results for Phase 2 are **reported by earlier tasks** (§10.7) and were **not** re-run in the 2026-10-21 documentation reconciliation. **Updated 2026-10-22 (§9.3.2):** a CURRENT full run was executed — `npx tsc --noEmit -p tsconfig.json` exit 0; `npm test` **179/179 suites, 3040 tests passed**, exit 0; `npm run test:integration` **40/40 suites, 425 tests passed**, exit 0 against a disposable local PostgreSQL (127.0.0.1:55432) and a disposable local Redis (127.0.0.1:6400); `npm run test:redis-integration` **6/6 suites, 51 tests passed**, exit 0. The earlier "heap-exhaustion risk" note did **not** materialise. **The item stays unticked:** these runs were scoped to the catalog contract batch, and the repository has no configured formatter or linter (recorded as "no tooling configured", not as "formatting passed").*
- [ ] Review migration and indexing implications. — *PARTIAL: migration-chain integrity is asserted by `tests/unit/migrationChainIntegrity.test.ts` (including the cart `RESTRICT` replacement with `ON UPDATE CASCADE` preserved, `:637-728`), and the search-indexing implication is the open `productIndex` finding above. **No Phase 2 migration/indexing review record exists.***

**## 3A — Money migration** — **ACCEPTED — TECHNICAL**

- [x] Inventory every monetary field and calculation before changing types. — Verified: `Product.price` (Int kobo, `schema.prisma:272`), `Order.basePrice`/extraCharge/deliveryFee/totalPrice (Int kobo, `:577-588`), `OrderItem.unitPrice`/subtotal (Int kobo, `:688-690`), `Cart.basePrice`/totalPrice (Int kobo, `:1227-1229`), `Payment.amount` (Int kobo, `:847`), all verified in schema.
- [x] Convert Float money fields to integer kobo where still applicable. — Verified: migration `20261023000000_money_float_to_kobo_int` converts Product/Order/OrderItem/Cart/Payment/Promotion/DeliveryEarning/RiderWithdrawal/SpecialOrderOffer monetary columns to Int/BigInt kobo (`prisma/migrations/20261023000000/`). `Promotion.value` deliberately left as Float (polymorphic percentage/fixed). **Limitation:** historical Float→kobo conversion precision not independently re-verified; migration application reportedly successful on fresh disposable PostgreSQL but not re-run in this task.
- [x] Review conversion/rounding rules and the migration that multiplies existing naira values by 100 before casting to integers. — Verified: migration uses `ROUND(val::numeric * 100)::INTEGER` with NaN/Infinity/overflow guards (`prisma/migrations/20261023000000/migration.sql`).
- [x] Update all money calculations and API serialization consistently. — Verified: kobo convention documented in schema comments; `Payment.amount`, `RefundRequest.requestedAmountKobo`, `Payment.refundedAmount` already kobo.
- [x] Add tests for conversion boundaries, totals, discounts, fees, refunds, commission, and payout math. — Partial: focused financial tests exist (`tests/integration/orderSnapshotPersistence.test.ts`, `tests/unit/payoutSnapshot*.test.ts`, `tests/unit/payoutFrozenRate.test.ts`). Full boundary coverage not individually confirmed.
- [ ] Do not run the migration against any database without task-specific authorization. — **Complied:** no migration or database-changing command executed in this task.

**## 3B — Order model hardening** — **ACCEPTED — TECHNICAL**

- [x] Confirm `Order.commissionKobo`, `Order.vendorPayoutKobo`, and `Order.discountKobo` are snapshotted at the correct time. — Verified: nullable BigInt snapshot fields (`schema.prisma:594-596`), populated in checkout transaction (`cartController.ts:1279-1283` via `buildOrderMoneySnapshot`).
- [x] Add/verify `OrderItem.productName` snapshot. — Verified: nullable `productName` (`schema.prisma:685`), populated from revalidated product name in checkout (`cartController.ts:1287-1288`).
- [x] Review financial foreign keys: change Order→User and OrderItem→Product deletion behavior from Cascade to Restrict. — Verified: `Order.customer`/`Order.vendor` use `onDelete: Restrict` (`schema.prisma:633-634`); `OrderItem.product` uses `onDelete: Restrict` (`schema.prisma:698`).
- [ ] Review the unique constraint `(customerId, vendorId, idempotencyKey)` against the actual checkout contract; do not introduce conflicting uniqueness semantics without review. — Partial: `idempotencyKey` is indexed (not unique, per schema `:672`) to allow multiple orders per key (multi-vendor cart). Semantics review not individually confirmed.
- [ ] Test checkout retries, concurrent requests, immutable snapshots, and deletion restrictions. — Partial: retry/idempotency logic exists in checkout (`cartController.ts:687-691`), but individual test coverage not confirmed in this investigation.

**## 3C — Vendor confirmation and timeout** — **ACCEPTED — TECHNICAL (PARTIAL)**

- [-] Give vendors 10 minutes to confirm after payment. — Partial: `OrderStatus.WAITING_VENDOR_CONFIRMATION` and `PAYMENT_CONFIRMED` exist (`schema.prisma:936-938`); vendor confirmation flow referenced in source. 10-minute window not individually confirmed in this investigation.
- [-] Add/verify a cron job running every two minutes to find `PAYMENT_CONFIRMED` orders older than 10 minutes. — **Not confirmed:** no 2-minute confirmation cron found in source inspection during this investigation. `expireAwaitingPaymentJob.ts` handles payment expiry, not vendor confirmation timeout.
- [-] Auto-cancel eligible orders, create refund requests, and notify customers. — Partial: order cancellation exists (`orderController.ts`), refund flow exists (`RefundRequest` model), but auto-cancel-on-timeout and refund-request creation not individually traced.
- [-] Allow vendor decline with a reason and route it through the same cancellation/refund path. — Partial: `cancellationReason` field exists (`schema.prisma:653`); vendor decline path not individually traced.
- [x] Prevent customer cancellation once the order is `COOKING` or beyond; preserve allowed vendor cancellation rules. — Partial: `cancelledAt`/`cancellationReason` fields exist (`schema.prisma:652-653`); enforcement logic not individually traced in this investigation.
- [x] Make jobs idempotent and safe to run more than once. — Partial: daily-cap release is idempotent (`scheduling.service.ts:267-285`); general job idempotence not individually confirmed.

**## 3D — Preorder and scheduled orders** — **ACCEPTED — TECHNICAL**

- [x] Support vendor `orderCutoffTime` and delivery slots on products/menus as appropriate. — Verified: `Product.orderCutoffTime` column (`schema.prisma:295`), `isScheduled` column (`:291`), both read in checkout product re-validation (`cartController.ts:753-754`).
- [x] Show customers clear cutoff and delivery timing. — Partial: fields exist and are read; customer-facing display not individually confirmed.
- [x] Reject orders placed after the selected slot's cutoff. — Verified: `validateCutOff()` (`scheduling.service.ts:102-141`) called in checkout (`cartController.ts:1090-1095`); rejects immediate orders past cutoff and scheduled orders for today past cutoff.
- [x] Enforce daily caps at order creation, not merely in checkout UI. — Verified: `reserveDailyCap()` called inside checkout `prisma.$transaction` (`cartController.ts:1242`), before order creation, with conditional counter increment serialized on `ProductDailyCounter` row.
- [x] Test time zones, cutoff boundaries, concurrent cap claims, and scheduled inventory. — Verified: `tests/unit/scheduling.service.test.ts` (13 unit tests for `parseScheduledAt`/`validateCutOff`/`lagosDayStart`, mocked); `tests/integration/dailyCapConcurrency.test.ts` (9 real-PostgreSQL tests including concurrent cap competition). **Limitation:** scheduled-order HTTP checkout integration coverage outstanding; live PostgreSQL not re-run in this task.

**## 3E — Refund hardening** — **ACCEPTED — TECHNICAL (PARTIAL)**

- [x] Add/verify `RefundRequest.orderId` for per-order refunds. — Verified: nullable `orderId` with `onDelete: Restrict` (`schema.prisma:1195-1196`).
- [x] Always set `requestedAmountKobo` when creating a refund request. — Partial: nullable `requestedAmountKobo` field exists (`schema.prisma:1189`); enforcement of "always set" not individually confirmed.
- [-] Admin approval must use the stored requested amount, not automatically refund all remaining funds. — Partial: field exists; admin approval logic not individually traced.
- [-] Mark a refund `COMPLETED` only after the corresponding `refund.processed` Paystack webhook. — Partial: `RefundStatus.PROCESSING`/`COMPLETED`/`FAILED` enum exists (`schema.prisma:1208-1221`); `paystackRefundId` field exists (`schema.prisma:1186`); webhook-driven completion not individually traced. **Live Paystack behavior unverified.**
- [x] Use a ledger/reservation check to prevent concurrent partial refunds exceeding the refundable amount. — Partial: `Payment.refundedAmount` field exists (`schema.prisma:880`); concurrent-refund guard not individually confirmed.
- [-] Test duplicate webhooks, concurrent refunds, failure recovery, and amount limits. — Partial: `tests/integration/adminRefundClaimConcurrency.test.ts` exists; execution not verified in this task.

**## 3F — Tests and review** — **ACCEPTED — TECHNICAL (PARTIAL)**

- [x] Review end-to-end financial invariants and reconciliation paths. — Partial: financial snapshot service exists (`src/services/orderSnapshot.service.ts`); payout aggregation tests exist (`tests/unit/payoutSnapshot*.test.ts`); full end-to-end review not individually confirmed.
- [x] Run focused tests, TypeScript validation, and the full suite where feasible. — Partial: `npx tsc --noEmit` exit 0 reported (historical); focused tests exist (`tests/integration/dailyCapConcurrency.test.ts`, `tests/unit/scheduling.service.test.ts`). **Full suite counts (3,184 unit / 184 suites; 437 integration / 41 suites) reported by prior integration closure run but not independently re-executed in this task.**
- [x] Document which payment and database behaviors still require integration testing. — Verified: limitations documented in this acceptance record — scheduled-order HTTP checkout integration coverage outstanding; live Paystack, production PostgreSQL historical data, and production Redis unverified.

**## 4A — Promotion model**

- [ ] Add/verify `fundedBy: PLATFORM | VENDOR`.
- [ ] Add/verify `target: ALL | CATEGORY | DISH_TYPE | PRODUCT`.
- [ ] Add a partial unique index so platform-wide codes cannot collide where the business rule requires uniqueness.
- [ ] Normalize `Promotion.scope` to `PLATFORM | VENDOR`, migrating existing data safely.

**## 4B — Promotion calculation service**

- [ ] Calculate discounts server-side; never trust client-supplied discount totals.
- [ ] Apply platform promotion first, then vendor promotion, according to the agreed rules.
- [ ] Flow `fundedBy` into order commission and vendor payout calculations.
- [ ] Test promotions beginning/ending at request time using live price resolution, not timers.

**## 4C — Vendor promotion tools**

- [ ] Let vendors create, edit, and pause their own promotions.
- [ ] Support one product, selected products, and whole-menu scope.
- [ ] Support automatic no-code discounts and code-gated campaigns.
- [ ] Verify ownership and limits on all writes.

**## 4D — Admin tools**

- [ ] Support platform-wide promotions and codes.
- [ ] Provide a usage dashboard for each promotion.
- [ ] Verify admin authorization and audit-sensitive changes.

**## 4E — Tests and review**

- [ ] Cover stacking/order of application, funding allocation, expiry boundaries, concurrency, and payout totals.
- [ ] Run focused tests, TypeScript validation, and the full suite where feasible.

**## 5A — Trust tiers**

- [ ] NEW vendors display a badge, have a cap of 10 orders/day, and a maximum order value of ₦5,000.
- [ ] After 20 completed orders and average rating ≥ 4.0, vendors become ESTABLISHED and limits are removed as agreed.
- [ ] Admin can manually promote or demote a vendor.
- [ ] Enforce limits server-side and safely under concurrent orders.

**## 5B — Pay on delivery**

- [ ] Add per-vendor setting.
- [ ] Apply a configurable per-order cap, initially ₦5,000.
- [ ] Track no-shows; after three in 30 days, allow automatic disabling according to the agreed rule.
- [ ] Notify the vendor of each no-show.
- [ ] Test cap, time-window, concurrency, and notification behavior.

**## 5C — Group orders**

- [ ] Customer starts a group and shares a link.
- [ ] Participants join and add items from the same vendor.
- [ ] Each member pays once; split costs fairly according to the documented business rule.
- [ ] Close the group when full or at the cutoff time.
- [ ] Keep the group-order money flow distinct from the later group-buy campaigns.

**## 5D — Tests and review**

- [ ] Verify trust limits, pay-on-delivery controls, group membership, payment isolation, expiry, and concurrent changes.

**## 6A — Zones**

- [ ] Allow admins to define delivery zones using a polygon or radius.
- [ ] Configure a flat delivery fee for each zone.
- [ ] Ensure a product/order is only available within the vendor's configured zones.
- [ ] Test boundary coordinates and invalid zone definitions.

**## 6B — Driver assignment**

- [ ] When an order is `READY_FOR_PICKUP`, broadcast it to available drivers in the zone.
- [ ] First valid driver acceptance assigns the order; competing offers expire.
- [ ] Driver declines trigger a broadcast to the next eligible driver.
- [ ] Notify vendor and customer when no driver is found after the configured number of attempts.
- [ ] Protect assignment transitions against race conditions.

**## 6C — Delivery flow**

- [ ] Implement driver accept, picked-up, en-route, and delivered actions.
- [ ] Support optional proof-of-delivery photo.
- [ ] Customer confirms receipt and the order becomes `COMPLETED` according to the state machine.
- [ ] Test unauthorized transitions, duplicate requests, and status notifications.

**## 6D — Tests and review**

- [ ] Validate zone boundaries, dispatch fan-out, acceptance races, retries, and the end-to-end delivery lifecycle.

**## 7A — Wallet ledger**

- [ ] Add/verify `WalletTransaction` fields: `userId`, type (`CREDIT`, `DEBIT`, `HOLD`, `RELEASE`), `amountKobo`, `balanceAfterKobo`, reason, `orderId`, and reference.
- [ ] Treat the ledger as financial truth; `User.walletBalanceKobo` is a denormalized read cache.
- [ ] Ensure each credit/debit writes an auditable ledger record and updates the cached balance atomically according to the approved transaction pattern.
- [ ] Enforce idempotent references and prevent overdrafts/double credits.
- [ ] Test concurrency and reconciliation invariants.

**## 7B — Vendor payouts**

- [ ] Deduct commission at the ledger level for each completed order.
- [ ] Admin can initiate a payout run for eligible unpaid completed orders.
- [ ] Calculate the net amount and initiate the Paystack transfer with idempotent references.
- [ ] Skip vendors without bank details or in `SUSPENDED` status, and include them in the result rather than silently dropping them.
- [ ] Record gross, commission, net, and Paystack reference on `VendorPayout`.
- [ ] Handle retries, provider timeouts, duplicate webhooks, and reconciliation.

**## 7C — Tests and review**

- [ ] Verify the ledger against order/refund/payout histories and concurrent financial operations.
- [ ] Begin with admin-created campaigns; vendor self-service can come later.
- [ ] Define eligibility, pooling, campaign close, and discount funding rules.
- [ ] Implement successful purchase flow.
- [ ] Implement expiry and refund behavior.
- [ ] Make scheduled/cron work safe when executed more than once.
- [ ] Test success, expiry refund, duplicate job execution, and ledger reconciliation.

**## 8A — Vendor storefront**

- [ ] Add a shareable link such as `foodpaddi.com/v/vendor-slug`.
- [ ] Show vendor menu, ratings, open/closed status, and available products.
- [ ] Make the page easy to share through WhatsApp, Instagram, and other platforms.

**## 8B — Notifications**

- [ ] Add FCM push notifications for new orders, status changes, and payouts.
- [ ] Add WhatsApp or SMS fallback for vendor new-order alerts as appropriate.
- [ ] Use held roles (`roles`) for role-based vendor order alerts, not only the currently active role (`role`).
- [ ] Test retries, duplicate events, permissions, delivery receipts, and fallback behavior.

**## 8C — Referral rewards**

- [ ] Add a small points credit after email verification.
- [ ] Add a cash wallet credit after the first purchase.
- [ ] Review and port the old August code only after its behavior and financial effects have been audited.
- [ ] Make reward credit idempotent and auditable.

**## 8D — Student features**

- [ ] Add a configurable budget-meals filter.
- [ ] Add Pot Points: 50 points per completed order and redemption at checkout, with abuse and accounting rules tested.

**## 8E — Tests and review**

- [ ] Test storefront access, notifications, reward eligibility, duplicate reward prevention, and points redemption.

**## 9A — Security finish**

- [ ] Encrypt NIN data at rest; currently recorded in the original plan as plaintext with a unique index. Audit actual implementation before changing it.
- [ ] Add rate limiting to public endpoints according to abuse risk.
- [ ] Complete admin audit logs for sensitive actions.
- [ ] Review access control, sensitive logging, secrets management, dependency risk, and data retention.
- [ ] Move critical security issues earlier if real user/KYC data is collected before Phase 9.

**## 9B — Operations**

- [ ] Integrate error monitoring (Sentry or equivalent).
- [ ] Complete structured logging.
- [ ] Schedule and test database backups on Render.
- [ ] Move off a free hosting tier before accepting real orders if cold starts or resource limits threaten order reliability.
- [ ] Verify alerts, backup restore, deployment rollback, environment variables, and operational ownership.

**## 9C — Pilot**

- [ ] Recruit 5–10 real vendors in one campus or local area.
- [ ] Start with one delivery zone and manual driver assignment if appropriate.
- [ ] Monitor missed order alerts, payment failures, vendor confusion, refund handling, delivery times, and support volume.
- [ ] Define stop/go criteria before the pilot begins.

**## 9D — Launch gate checklist**

- [ ] `ENCRYPTION_KEY` is set securely in the deployment environment, meets the application's required format, and has a safe backup procedure.
- [ ] Render build/deploy process uses `prisma migrate deploy`, not `prisma db push`.
- [ ] All checkout clients send `Idempotency-Key`.
- [ ] Push notifications are tested on real, low-end Android devices.
- [ ] Flutter app is tested on slow networks, including 3G-like conditions.
- [ ] Vendor storefront links work and are shareable.
- [ ] Payment, refund, payout, support, monitoring, backup, and rollback procedures are ready.
- [ ] Privacy, terms, support processes, and applicable legal/compliance requirements have been reviewed.
- [ ] Explicit launch approval is recorded before opening to real customers.

---

### 9.3 Phase evidence notes (relocated verbatim)

### 1C evidence note (reviewed 2026-10-12)

Read-only review of Phase 1C against the checklist above, followed by a narrowly scoped remediation of two findings it raised and a focused validation run. **No application source, schema, or migration file was changed by the review** — the remediation touched two project files, and this note plus the milestone row are the only documentation edits.

- **Remediation files changed:** `src/middlewares/vendorStatus.middleware.ts` and `tests/unit/vendorStatus.test.ts`. `src/services/vendorStatus.service.ts` was **not** changed; the compare-and-swap write already behaved correctly and only lacked coverage.
- **Requirement mapping (static review):** the single transition table is defined once (`src/services/vendorStatus.service.ts:27-33`) and consumed through `allowedVendorTransitions` (`:35-37`), so no surface can drift; configuration-controlled auto-approval reads `VENDOR_AUTO_APPROVE` at the single decision point (`:21-23`, `:140`); the KYC/profile gate requires brand, canonical E.164 phone, phone **verification**, and `kycStatus === "VERIFIED"` (`:90-102`), with the raw `phoneNumber` explicitly not accepted as proof (`:16-18`).
- **Allowed actions per status** are enforced on three separate surfaces: vendor write paths via `requireVendorNotSuspended`, go-live via `src/controllers/vendorSettingsController.ts:82`, and ordering via `src/services/vendorAvailability.service.ts:112-127`. The order lifecycle additionally **fails closed** on an unreadable status (`src/controllers/orderController.ts:444`, `:1172`).
- **Hardening applied:** `requireVendorNotSuspended` no longer collapses a missing vendor row or an unreadable/unknown status into a permissive `null` (`vendor?.vendorStatus ?? null`). It now reuses the same `isVendorStatusEstablishable` helper and `VENDOR_STATUS_UNRESOLVED_MESSAGE` the order guard uses, so the two enforcement sites cannot diverge (`src/middlewares/vendorStatus.middleware.ts:45-47`). A genuinely `null` status still passes — the schema models it as "holds VENDOR, status system has not run yet", so a new vendor is not blocked from onboarding.
- **Regression tests added:** the compare-and-swap `count === 0` fallback (`vendorStatus.service.ts:141-149`) is now covered for a concurrent suspension, a row that disappears after the lost race, and the absence of any retry or unconditional second write; plus ten middleware cases distinguishing suspended, `NEW`, `PENDING_REVIEW`, `ACTIVE`, genuine `null`, missing row, unreadable status, out-of-enum value, database read failure, and unauthenticated request.
- **Validation result:** `npx jest --config jest.unit.config.js --runInBand tests/unit/vendorStatus.test.ts tests/unit/vendorAvailability.test.ts tests/unit/vendorSuspensionAuthorization.test.ts` — **3 suites / 82 tests passed**, 0 failed, exit 0. The vendor-status suite alone: **31/31**. `npx tsc --noEmit` exit 0.
- **Mocked infrastructure:** these are unit tests against a mocked Prisma store. They demonstrate application logic only and **do not** demonstrate live PostgreSQL behaviour (`AGENTS.md:133`).
- **Open limitation — no live PostgreSQL evidence:** the compare-and-swap tests simulate `count === 0` through a mocked return value. They do not prove that a real concurrent `UPDATE` yields `count === 0`, nor anything about row locking or MVCC. A disposable PostgreSQL target remains unprovisioned, which also blocks the 1B and 1B.3 live verifications.
- **Remaining approvals:** both boxes above are still unticked. They are phrased as release gates, the static review was approved only *with limitations*, and the mocked evidence does not justify marking Phase 1C complete or release-ready. Reconcile them in a separate documentation pass once live database evidence exists.


### 1D evidence note (reviewed 2026-10-12)

Read-only prerequisite review of Phase 1D against the requirements listed above. **No application source, test, schema, or migration file was changed by this review** — `README.md` is the only modified file.

- **Files changed:** `README.md` only (milestone row, this note, and the stale `1D.1` label).
- **Requirement mapping:** all ten requirements above mapped to satisfied. Notable evidence: E.164 with an `NG` default (`src/utils/phone.ts:6,28-32`); unique canonical phone (`prisma/schema.prisma:20`); verification-only assignment — the single write grant is `src/controllers/auth.controller.ts:2084`; OTP controls (`src/services/phoneOtp.service.ts:49-53,131-136,286`); SMS-provider abstraction (`src/services/sms/smsProvider.ts:20-23,44-56,121-134`); the five named endpoints (`src/routes/auth.routes.ts:267-322`), where phone login issues the full session through the shared `issueAuthenticatedSession` helper (`src/controllers/auth.controller.ts:2262-2265`).
- **TypeScript result:** `npx tsc --noEmit` exit 0.
- **Full suite result:** reported **115 suites / 1,770 tests** passed, exit 0.
- **Mocked infrastructure:** the full unit suite runs against a mocked Prisma store, an in-memory Redis double, and the development SMS driver. It does **not** demonstrate live Redis or PostgreSQL behaviour.
- **Live PostgreSQL verification now done for criteria 2 & 3:** `tests/integration/phoneNumberUniqueness.test.ts` (3/3 passed) ran against a fresh disposable PostgreSQL (port 55435) migrated with `prisma migrate deploy`. It confirmed: (a) multiple NULL `phoneNumberE164` rows are allowed (nullable unique), (b) a duplicate non-null write is refused with Prisma `P2002` and the loser never acquires the number, (c) under concurrent duplicate assignment exactly one writer wins and exactly one row holds the number. The `User_phoneNumberE164_key` unique index (migration line 1081) exists on the live DB and `migrate status` reports up to date; `prisma migrate diff` reports zero drift vs schema.prisma. Prisma `P2002` handling maps to the app error path and does not hide unrelated DB errors (only P2002 is matched).
- **Remaining missing verification (per §10.4 matrix):** live concurrent-write verification for criterion 3's *account-level* verification-only gate (single write grant at auth.controller.ts:2308) is covered by the concurrency test above at the DB layer; the application-level gate is source-present. Criteria 1, 4–11 need no live-DB verification beyond what's done.
- **Historical real-Redis result:** a separate real-Redis OTP run reported **18/18 against Redis 8.0.5**. That is **historical evidence and was not reproduced during this review**; the suite is gated on an external Redis URL and no Redis instance was reachable.
- **Task 7.34 evidence reconciliation (2026-10-15, documentation-only; no tests run, no Redis or database contacted, no source changed):** the three Phase 1D real-Redis artifacts were reconciled. The OTP Redis suite's own "PREPARED BUT NOT EXECUTED" header is **stale, not contradictory**. Timeline, by file modification time: `src/services/phoneOtp.service.ts` (2026-10-12), `tests/helpers/localRedisTarget.ts` (2026-10-13) and `tests/integration/redis/emailOtpHttp.test.ts and emailOtpRateLimit.test.ts` (2026-10-13) all predate the FIN-07-05 batch report (2026-10-14). The header was accurate when written and has not been revised since that batch ran. `FIN-07-05_REDIS_INTEGRATION_VERIFICATION.md` records `npm run test:redis-integration` at **exit code 0, 6/6 suites, 51/51 tests**, against disposable loopback targets `127.0.0.1:6401/15` and `127.0.0.1:6402/15`, with the OTP-specific URL variable pointed at the disposable target and the application `REDIS_URL` preserved. A static count of the six suites in `tests/integration/redis/` is **6 suites / 51 tests** today — `phoneOtpRedis` 18, `notificationRedis` 5, `refreshControllerRedis` 6, `refreshRotationRedis` 11, `webhookHandlerClaimRedis` 3, `webhookReplayClaimRedis` 8 — which matches that report exactly, and no file in the suite or in its OTP dependencies has been modified since. **This is strong evidence the FIN-07-05 run exercised the current revision, but it is not a hash-verified pin**: no commit SHA or file checksum was recorded at run time, so it cannot be cryptographically re-verified. The "Redis 8.0.5" version in the historical bullet above is **not corroborated by any artifact in this repository** — `FIN-07-05` records no server version — and is therefore not restated here as verified. The three evidence classes, kept distinct: **(a) historical report** — the 18/18 figure, and Gate 1's 151/151 focused and 116 suites / 1,837 tests, all mocked; **(b) current test-source coverage** — the suites above exist and assert the documented limits, but their passing is not asserted by this entry; **(c) verified run against the current revision** — the FIN-07-05 51/51 result, subject to the hash caveat above. **No test was executed in Task 7.34, and nothing in this entry claims the current OTP Redis suite passed.**
- **Task 7.34 limiter-comment correction (2026-10-15, documentation-only; no behaviour change):** `src/middlewares/rateLimiter.middleware.ts` documented `phoneOtpRateLimiter` as "keyed per account where there is one, else per IP", but all five mounts register it **before** `authenticate` (`src/routes/auth.routes.ts:267-322`), so `req.user` is always undefined at key-generation time and the limiter is **IP-keyed on every mount**. The comment now states that actual behaviour, records that the `req.user?.id ||` branch is dead code rather than a fallback, notes that abuse remains bounded by the authoritative per-normalized-phone Redis budget (5/24 h) regardless of IP distribution, and warns that reordering the middleware is a security-behaviour change requiring its own decision and regression tests. **No middleware order, key expression, limit value, or response body was changed.**
- **Task 7.34 configuration gaps — routed to Phase 1F, NOT resolved here:** `SMS_PROVIDER` (read at `src/services/sms/smsProvider.ts:123`) and `VENDOR_AUTO_APPROVE` (read at `src/services/vendorStatus.service.ts:22`) are both live Phase 1 runtime variables that are **absent from `.env.example`**, and `tests/unit/envExampleCompleteness.test.ts:21-29` asserts only the seven boot-required keys, so neither gap is caught by any test. `.env.example` was **not** edited in Task 7.34; extending it is Phase 1F work. No production SMS transport was added: `buildProvider` (`src/services/sms/smsProvider.ts:98-109`) still accepts only `log`, `memory` and `failing`, and a real provider remains an open release blocker tracked outside Phase 1D (`README.md:285`).
- **Deferred by roadmap policy:** live PostgreSQL uniqueness and concurrency verification remain outstanding (`README.md:49`).
- **Out of scope:** a production SMS transport is not implemented. This is explicitly outside Phase 1D scope and is **not** recorded as a 1D defect. A real provider remains a release blocker tracked outside this phase.
- **Remaining approvals:** the individual `1D.1`–`1D.7` boxes above are still unticked and are deliberately left unchanged by this task; reconcile them in a separate documentation pass.
- **Batch 1 reconciliation (2026-10-13, documentation-only; no tests run, no infrastructure contacted):** the `1D.1`–`1D.7` boxes remain unticked. The prior requirement mapping (all ten requirements mapped to satisfied with the file citations above) is preserved as historically reported mapping, not as fresh verification and not as independent acceptance granted in this batch. The milestone-row `[x]` reflects that prior mapping outcome only and does not constitute subtask, independent-review, live-verification, or release approval, which remain outstanding. The full unit suite (115 suites / 1,770 tests) and `npx tsc --noEmit` results above are historically reported mocked execution (mocked Prisma, in-memory Redis double, development SMS driver), not freshly executed here. The real-Redis OTP result (18/18 against Redis 8.0.5) is historically reported and was not reproduced here. Live PostgreSQL uniqueness/concurrency verification remains deferred by roadmap policy (`README.md:49`). Production SMS transport remains explicitly out of scope and is not recorded as a 1D defect. No subtask is marked complete on the basis of source presence or a prior passing-test report alone.
- **Gate 1 retrospective approval — RECORDED AS ISSUED (documentation-only recording; no tests run, no infrastructure contacted):** **Phase 1D.7 retrospective approval: GRANTED**, as issued by ChatGPT in the review conversation and quoted in the authorizing task. Scope: Phase 1D.7 acceptance criteria (`README.md:267–271`) only. Basis (as reported, not re-executed here): focused phone/OTP tests 151/151 passed using mocks; `npx tsc --noEmit` exit code 0; full unit suite 116 suites / 1,837 tests passed; integration limitations documented separately. **Timing acknowledgment (preserved verbatim as a process finding):** no approval record before Phase 1E was verified in the permitted sources; this decision is explicitly retrospective and does not establish that the original requirement to obtain approval before starting Phase 1E was satisfied. **Scope exclusions:** this decision is not Phase 1E acceptance, overall Phase 1 acceptance, live PostgreSQL or Redis verification, production-service verification, or release approval. **No checkbox or status symbol was changed by this recording task:** the `1D.1`–`1D.7` boxes and the milestone row above are left exactly as they were, because the documented workflow does not explicitly require a status-symbol change and none was separately authorized.


### 1E evidence note (reviewed 2026-10-12)

Read-only prerequisite review of Phase 1E against the checklist above. **No application source, test, schema, or migration file was changed by this review** — `README.md` is the only modified file.

- **Files changed:** `README.md` only (milestone row and this note).
- **Implemented in source:** session-scoped active roles (`prisma/schema.prisma:169`; `src/lib/session.ts:19,83-84,99,112,148`; `switchRole` writes the session only, never `User.role` — `src/controllers/auth.controller.ts:1276-1279`) and `tokenVersion` enforcement on every authenticated request (`src/middlewares/auth.middleware.ts`), together with the 15-minute access token (`src/utils/generateToken.ts:17-19`) and the secure change-password endpoint.
- **TypeScript result:** `npx tsc --noEmit` exit 0.
- **Full suite result:** reported **115 suites / 1,770 tests** passed, exit 0.
- **Mocked infrastructure:** as above, the full unit suite does **not** demonstrate live Redis or PostgreSQL behaviour.
- **Unverified — migration application:** `prisma/migrations/20261012120000_user_session_active_role/migration.sql` **was rebased into the single clean baseline** `prisma/migrations/20261016025918_init/migration.sql` (commit 967d1836). It now applies cleanly to a fresh disposable PostgreSQL: `prisma migrate deploy` applied `20261016025918_init` successfully; `prisma migrate status` reports "Database schema is up to date!"; `prisma migrate diff --from-url <disposable> --to-schema-datamodel` reports an empty migration (zero drift vs schema.prisma). `UserSession.activeRole` is nullable (`is_nullable=YES`, udt_name=Role) and legacy NULL sessions insert/read correctly on the live DB. This review **now confirms migration application** to a disposable database; deployment-order review remains part of Phase 1F.
- **Outstanding:** migration compatibility and deployment-order review remains outstanding and belongs to Phase 1F (`README.md:301`).
- **Status:** do **not** mark 1E `[x]` until its remaining roadmap requirements and review gates are satisfied — in particular until the migration is applied and verified and the `1E` boxes above are reconciled.
- **Batch 1 reconciliation (2026-10-13, documentation-only; no tests run, no database accessed):** the `1E` boxes remain unticked. Session-scoped roles, 15-minute access tokens, change-password, `tokenVersion` enforcement, and per-request authorization remain source-described as in the prior note; in this batch only `prisma/schema.prisma:169`, `src/lib/session.ts`, `src/utils/generateToken.ts:17-19`, and `src/middlewares/auth.middleware.ts` were spot-inspected read-only, and no line-by-line re-audit of every cited file was performed. The full suite and `npx tsc --noEmit` results above are historically reported mocked execution, not freshly executed here. `prisma/migrations/20261012120000_user_session_active_role/migration.sql` was confirmed present on disk in this batch; its application to any database remains unverified (no database was accessed) and no claim of application is made. A file existing on disk does not prove application. Migration compatibility/deployment-order review, 1E review approval, and release approval remain outstanding.
- **Gate 2 retrospective acceptance — RECORDED AS ISSUED (documentation-only recording; no tests run, no infrastructure contacted):** **Phase 1E technical acceptance: GRANTED RETROSPECTIVELY**, as issued in the ChatGPT review conversation and quoted in the authorizing task. Scope: Phase 1E criteria (`README.md:292–300`) only. Basis (historical results, not freshly executed here): reported focused session/auth tests 93/93 passed; reported refresh/session-role cache regression tests 4/4 passed; reported TypeScript check exit code 0; reported full unit suite 116 suites / 1,837 tests passed; no additional code defect identified in the latest acceptance report. **Timing acknowledgment (preserved as a process finding):** no evidence establishes that Gate 2 approval occurred before Phase 1F began; this decision is retrospective and does not establish timely approval. **Migration and infrastructure limitation (preserved):** migration and source-level compatibility have been reviewed, but application to a database, migration-history consistency, live session behavior, and rollback rehearsal remain unverified; mocked functional acceptance does not constitute live-database verification, which remains outstanding wherever required by the applicable deployment or release procedure. This decision is not Phase 1F acceptance, overall Phase 1 acceptance, or release approval. **No checkbox or status symbol was changed by this recording task:** the `1E` boxes and the milestone row are left exactly as they were, because the documented workflow does not explicitly require a status-symbol change and none was separately authorized.

### 1D/1E — Real-HTTP integration verification (freshly executed this task)

Freshly executed against disposable PostgreSQL (port 55434) and Redis (port 6399), with fail-closed target guards. No production or development service was touched.

- `tests/integration/authHttpFlows.test.ts` (new suite, 5/5 passed):
  - Phone OTP request + verify (authenticated) — real Redis Lua-script OTP storage, mocked SMS (no real SMS sent); wrong-OTP attempt exhaustion (5/6) → 429.
  - Change password — real Redis session + real DB; tokenVersion bump; stale access token → 401; new password authenticates via login.
  - Password reset: forgot (mocked email) → verify-reset-code → secure-reset-password — real Redis attempt counters + real DB reset token; single-use consumption (reuse → 406); new password authenticates via login.
  - Login + refresh-token rotation — real DB + real Redis; new access+refresh token pair; refresh-token reuse detection.
- `npx tsc --noEmit` exit 0.
- Full unit suite: 156 suites / 2,572 tests passed (exit 0).
- `prisma migrate diff --from-url <disposable> --to-schema-datamodel` → empty migration (zero drift vs `schema.prisma`).
- Disposable services stopped after verification; development PostgreSQL (5432) and Redis (6379) untouched.



### 1F.1 — Socket.IO handshake hardening (independently accepted within defined scope; reviewed 2026-10-12)

Independently accepted within the scope listed below. **Do not treat as whole-phase acceptance.** This Batch 1 change is documentation-only and grants no new acceptance.

- **Independently accepted scope:** Socket.IO handshake authentication; event-boundary authorization and revalidation; session, account, token-version, and role validation; protected location writes and ownership binding; authenticated per-user room behavior and server-resolved recipient targeting; lifecycle cleanup and supplementary periodic revalidation; the `persistDriverLocation` user-ID correction.
- **Source-confirmed (read-only inspection in this batch; no execution):** `src/socket.ts` implements `resolveAuthorisedSocketRole` (session `activeRole` wins with account-role fallback; an unheld role fails closed), calls it in `revalidateSocket`, in the handshake (including token-role vs session-role agreement), and in `persistDriverLocation`; `persistDriverLocation` performs the authorization re-read and the ownership-bound `updateMany(where: { userId })` inside one `SERIALIZABLE` transaction with `FOR SHARE` locks on `User`/`UserSession`, retries bounded `P2034` failures fail-closed, broadcasts only after commit via the server-resolved user ID, and corrects the prior row-ID vs user-ID mismatch. The handshake rejects non-access tokens and missing `sessionId`, checks session ownership via `getUserSession`, and checks blocked state and `tokenVersion`. Per-user room `socket.join(userId)`, 30-second periodic revalidation plus per-event revalidation, and single disconnect cleanup are present. The prior note's "Open limitation A (role staleness)" and "Open limitation B (TOCTOU)" descriptions are therefore superseded as implementation defects; they are preserved only as historical review context, not as current open defects.
- **Test assertions inspected (not executed in this batch):** `tests/unit/socketSecurity.test.ts` asserts handshake authorization, event-boundary revalidation, role-staleness revalidation (including legacy null role, revoked-role refusal, and periodic backstop), the approved `DELIVERY`-only location policy, TOCTOU binding (single `SERIALIZABLE` transaction, database re-read, bounded retry, commit-before-broadcast), the `FOR SHARE` lock protocol and ordering, and lifecycle cleanup.
- **Historically reported execution (mocked; not reproduced in this batch):** `npx tsc --noEmit` reported exit 0; focused socket-security tests 24/24; focused authorization suite 159/159 across 9 suites; full unit suite 1,770/1,770 across 115 suites, exit 0. All such validation used mocks. No live PostgreSQL, Redis, or real Socket.IO transport verification was performed in that execution. Other historical results cited in the acceptance context — Socket unit 66/66, real Socket.IO location delivery 3/3, PostgreSQL integration 19/19 suites / 166/166 tests, notification persistence 3/3, Redis integration 40/40, `npx tsc --noEmit` clean — are historically reported at their respective points in time, were not reproduced in this batch, and are not claimed to share one execution or repository state.
- **Not implemented (source-confirmed):** `orderAccepted`, `orderPickedUp`, and `orderDelivered` (`src/socket.ts:407-433`) remain no-op stubs. They revalidate authentication but perform no writes, room joins, broadcasts, or data access. Do not describe them as implemented features.
- **Unverified in this batch:** fresh execution of any test or typecheck; live PostgreSQL/Redis/transport behavior; 1F.2; migration/deployment compatibility; environment/secrets; client-authentication expectations; explicit release approval.
- **Deferred / out-of-scope (outstanding):** order-event business logic, notification/order-workflow behavior beyond the accepted hardening, and any use of 1F.1 hardening as whole-phase evidence remain outside the accepted scope.
- **Outstanding review or approval:** 1B, 1B.3, 1C, 1D, and 1E have not been confirmed reviewed, so **Phase 1F as a whole remains incomplete.** 1F.1 acceptance does not extend to 1F.2 (which has no section in this README), to notification/order-workflow criteria, or to Phase 1 as a whole. Phase 1 remains unaccepted and not release-approved.

---

### 9.3.1 Phase 2 evidence note — catalog reconciliation and R-1/R-2 (added 2026-10-21, documentation-only)

> **Goal (unchanged):** a vendor can list a product, and a customer can find it.
>
> **Task boundaries.** This entry was produced by a **documentation-only** task. No application source, test,
> schema, migration, or database was touched; **no test was run in that task**; no infrastructure was
> provisioned; no Git state was inspected; `README.md`, `AGENTS.md` and `docs/engineering/remediation-status.md`
> were not modified (the last is under an active restriction and was not read, searched or quoted).
>
> **Provenance labels used below.** **(a) Source evidence** — inspected in the 2026-10-21 task, with a
> `file:line` reference. **(b) Prior-review evidence** — rerun by the earlier independent reviewer of R-1/R-2,
> labelled as such and **not** rerun in this documentation task. **(c) Reported** — a result reported by an
> earlier agent and **not** independently reproduced here.
>
> **Phase 2 is not marked complete or accepted.** The phase-level status stays `NEEDS RECONCILIATION`
> (§9.1); acceptance is the user's decision.

#### A. Implemented — source evidence inspected 2026-10-21

| Area | What exists | Source |
|---|---|---|
| Categories / dish types / tags | `Category` with `id`, `name`, `slug`, `icon`, `sortOrder`, `isActive`; `DishType.categoryId`; `Tag` + `TagType`; `ProductTag`; `CategorySuggestion` | `prisma/schema.prisma:215-230, 247, 471, 484, 507` |
| Taxonomy seed | 12 categories, 65 DishTypes, 20 tags; fail-closed completeness assert; opt-in guard | `prisma/seed.ts:6-19, 21-87, 89-110, 121-128, 132` |
| Product schema | `Product.categoryId`, `portionLabel` | `prisma/schema.prisma:279, 284` |
| Add-on groups | `OptionGroup`, `OptionGroupItem` + vendor CRUD routes | `prisma/schema.prisma:366-410, 412-446`; `src/routes/productRoutes.ts:65-71` |
| Legacy compatibility | `ProductOption` model and the `options[]` response field **preserved, not deprecated** | `prisma/schema.prisma:1207`; `src/controllers/productController.ts:564-565, 712` |
| Vendor product API | create / update / archive with images, option groups and tags; dish-type suggestion; admin approve/reject | `src/routes/productRoutes.ts:52, 53, 60`; `src/routes/vendorDashboard.routes.ts:50-51`; `src/routes/admin.routes.ts:105-108` |
| Browse API | `/categories` (with counts), `/categories/:slug/products`, `/tags`, `/dish-types`; dish-type / tag / price / sort filters; pagination | `src/routes/productRoutes.ts:39-44`; `src/controllers/catalogController.ts:55, 85-108, 124`; `src/services/product.service.ts:352-425` |

**Counts note.** The 12 / 65 / 20 figures were **re-derived from `prisma/seed.ts` source in the 2026-10-21
task** and match the numbers previously reported. **Migration application, runtime seed idempotency and the
live-database seed run were not independently verified in that task** — they remain reported results (§10.7).

#### B. Partial, deferred and open items (2B / 2D / 2E)

1. **Daily-cap representation — OPEN DECISION, deliberately not resolved.** The 2B checklist item in §9.2
   (`Add portionLabel, isScheduled, orderCutoffTime, dailyCap, and dailyOrderCount where not already present`)
   names a `Product.dailyOrderCount` field. The schema has **no such column**; it instead carries the
   `ProductDailyCounter` model with a `(productId, date)` composite key (`prisma/schema.prisma:452-461`),
   whose own comment records the rationale: per-day rows expire naturally, refunds restore atomically, and
   concurrent checkouts serialise on the row. **Both representations are recorded here; neither is selected,
   and neither was added or implemented.** No cap is enforced anywhere: `src/jobs/seed.ts:2434-2436` states
   that production code does not read or enforce `isScheduled`, `orderCutoffTime`, `dailyCap` or
   `ProductDailyCounter`. **Daily-cap enforcement is deferred to Phase 5A.**
2. **Scheduling fields are columns, not features.** `isScheduled` (`prisma/schema.prisma:288`),
   `orderCutoffTime` (`:292`) and `dailyCap` (`:298`) exist but are not enforced in production code.
   **Scheduling enforcement remains deferred to Phase 3D.** These fields must not be represented as
   functional merely because the columns exist.
3. **Scheduled-status filter — not implemented** in the audited category-products path
   (`src/services/product.service.ts:352-425`). It belongs to Phase 3D unless the roadmap defines it
   otherwise.
4. **Literal `GET /dish-types/:id/products` — route not found; requirement unresolved.** The product browse
   endpoint filters by DishType (`src/services/product.service.ts:380`) and `GET /api/product/dish-types`
   lists DishTypes (`src/routes/productRoutes.ts:39`). Whether the literal route is required, or the filter
   satisfies the requirement, is an **open product decision**. No route was added.
5. **Search indexing — partially index-backed.** `src/controllers/productController.ts:1609` matches the
   full-text vector **or** the DishType name **or** the Category name **or** a tag expression, but the
   vector itself holds only `name` and `description`
   (`prisma/migrations/20261016025918_init/migration.sql:1788-1802`), so category / DishType / tag matching
   is SQL/ILIKE and not index-backed. **Whether index-backed search is required is an open product/technical
   decision.**
6. **`productIndexQueue` has no worker — implementation finding.** The queue is defined at
   `src/jobs/workers jobs/redis-baseQueue.ts:13` and enqueued with `"indexProduct"` at
   `src/controllers/productController.ts:320, 1151, 1233`, but **no `Worker` for `productIndex` exists
   anywhere in `src/`**. The enqueued indexing work is vestigial; **queue processing is not claimed to be
   functional.** No worker was created.
7. **2E — no Phase 2-level test/review record.** Per-area suites exist (§9.2 2E) but there is no consolidated
   Phase 2 test run, migration/indexing review, or acceptance record. Full-suite results for Phase 2 are
   **reported** (§10.7), not re-run in the 2026-10-21 documentation task.

#### C. R-1/R-2 — cart-referenced product and option deletion protection — **ACCEPT WITH FOLLOW-UP**

**Scope.** Protect cart-referenced products and option-group items from hard deletion; preserve customer
carts; add application-level guards plus database `RESTRICT` backstops; keep the related cart-cache
invalidation correct.

**Key files (paths and roles verified in the 2026-10-21 task).**

| File | Role |
|---|---|
| `prisma/schema.prisma` | `CartItem.product` `onDelete: Restrict` (`:1187`); `CartItemOption.optionGroupItem` `onDelete: Restrict` (`:1213`); order-history counterparts `OrderItem.product` (`:645`), `OrderItemOption.optionGroupItem` (`:667`) |
| `prisma/migrations/20261021000001_cart_reference_restrict/migration.sql` | Replaces the two cart FKs with `ON DELETE RESTRICT ON UPDATE CASCADE` (`:35-39`) |
| `src/lib/prismaFkConflict.ts` | Shared fail-closed classifier: `PrismaClientUnknownRequestError` + SQLSTATE `23001` → constraint name (`:83-95`); `P2003` → `meta.constraint`, then message, then `meta.field_name` (`:58-73`); per-operation constraint sets (`:40-56`) |
| `src/services/product.service.ts` | `clearProductFromCarts` (`:168-189`) — invalidates **Redis cart snapshot keys only**, never database cart rows, and is best-effort so a Redis failure cannot fail an already-completed catalog deletion |
| `src/services/optionGroup.service.ts` | Option-group delete (`:194-205`) and option-item delete (`:318-328`) map only the expected option constraints to `ConflictError`; every other error is rethrown |
| `src/controllers/productController.ts` | Vendor product delete (`:1296-1310`) maps only `PRODUCT_DELETE_FK_CONSTRAINTS` to 409, else rethrows |
| `src/controllers/admin.controller.ts` | Admin product delete (`:2332-2345`), same mapping |
| `tests/unit/prismaFkConflict.test.ts` | Classifier coverage, including the fail-closed cases |
| `tests/unit/productDeletionCartGuard.test.ts` | Vendor + admin guard, realistic `23001` race shape, unrelated-constraint non-mislabelling |
| `tests/unit/optionDeletionGuard.test.ts` | Option group/item guard, same coverage |
| `tests/integration/restrictDeleteRaceHttp.test.ts` | Real Express routes + real error handler + **real PostgreSQL** `RESTRICT` rejection; asserts the DELETE was actually attempted and that the product, group, item, cart line and cart selection all survive |
| `tests/unit/migrationChainIntegrity.test.ts` | Asserts the cart FKs are the last definition as `RESTRICT` with `ON UPDATE CASCADE` preserved, that the baseline really cascaded, and that only the two intended tables are touched (`:637-728`) |

**Review verdict: ACCEPT WITH FOLLOW-UP** (independent read-only review, 2026-10-21).

**(b) Prior-review evidence — rerun by the independent reviewer, not rerun in this documentation task:** 4 unit
suites / 91 tests passed; `npx tsc --noEmit -p tsconfig.json` exit 0; `npx prisma validate --schema
prisma/schema.prisma` exit 0. The reviewer also confirmed statically that the operation-scoped constraint
sets are complete: among all `onDelete: Restrict` relations in `schema.prisma`, the only ones targeting
`Product` are `:645` and `:1187`, and the only ones targeting `OptionGroupItem` are `:667` and `:1213` —
every other referencing FK cascades.

**(c) Reported — not independently rerun by the reviewer and not rerun here:** 4 integration suites / 53 tests;
the race suite 5/5 against a real PostgreSQL 18.6 + Redis 8.0.5 disposable instance; migration-chain
application; the live `pg_constraint` catalog audit; and the before/after result in which four race outcomes
changed from **HTTP 500** (with the pre-fix `P2003`-only classifier) to **HTTP 409** with the current
classifier.

**Follow-ups (none authorised by this task).**

1. Correct the inaccurate comment in `prisma/migrations/20261021000001_cart_reference_restrict/migration.sql:19-20`,
   which says Prisma reports the `RESTRICT` failure as `P2003`; the verified behaviour is SQLSTATE `23001`
   surfaced as `PrismaClientUnknownRequestError` with `code === null`. **Do not rewrite an already-applied
   migration just to change its comment** — record the correction elsewhere.
2. Review the unused `meta.field_name` fallback in `src/lib/prismaFkConflict.ts:69-70` (it can only yield a
   column name, so it can never satisfy a constraint allowlist).
3. Consider replacing message-substring SQLSTATE detection (`src/lib/prismaFkConflict.ts:90`) with structured
   error metadata when Prisma exposes it, **preserving the fail-closed behaviour**.
4. Consider a consistent future global mapping for SQLSTATE `23001`. Today
   `src/middlewares/error.middleware.ts:59-65` maps only `P2003` to a generic 409, so an unrelated `RESTRICT`
   violation elsewhere would still surface as 500 — **after separate review and authorization**.
5. Keep regression fixtures and the real-PostgreSQL race coverage aligned. The unit suites pin a captured
   engine message, so a change in Prisma's rendering would pass unit tests while production broke.
6. Document explicitly that the current race test simulates a **late constraint failure against a real
   database** (a one-shot pre-check bypass, then a real DELETE really rejected by the real constraint) but is
   **not** a genuine two-connection concurrent interleaving test.

**No R-1/R-2 follow-up implementation is authorised by this task.**

---

### 9.3.2 Phase 2 catalog contract hardening batch — IMPLEMENTED AND EXECUTED (2026-10-22)

> **Status: implementation complete and independently executed. NOT ACCEPTED.** This entry records one
> coordinated backend batch (items B-1, B-2, B-3, B-4, B-5, B-7). It does **not** mark Phase 2 complete,
> does **not** resolve the 2B daily-cap representation decision, does **not** close the four 2D open items
> recorded in §9.3.1(B), and does **not** replace the missing 2E consolidated review record. Acceptance is
> the user's decision.
>
> **Boundaries observed.** No Prisma schema change and no migration was made or needed. No Git command was
> run and no Git state was inspected. No deployment, no remote service and no production/remote database
> was contacted. `README.md`, `AGENTS.md` and `docs/engineering/remediation-status.md` were not modified, and
> the restricted document was not read, searched or quoted. The Flutter project was not touched. The legacy
> `ProductOption` / `options[]` contract, `optionGroups` and `optionGroupsMigrated` are unchanged. Phone
> OTP/SMS was not touched.

#### A. What changed, per authorised item

| Item | Change | Where |
|---|---|---|
| **B-1** | Every anonymous catalog surface now exposes the vendor through ONE explicit public projection (`id`, `name`, `brandName`, `brandLogo`, `avatarUrl`). The internal moderation state (`vendorStatus`, `vendorStatusReason`) and the internal delivery settings (`deliveryPreferences` → `baseDeliveryFee`, `deliveryRadiusKm`, `preparationTimeMinutes`) are no longer served, on `GET /api/product`, `GET /api/product/categories/:slug/products`, the `catalog` section of `GET /api/home/feed`, or `GET /api/product/:id`. The vendor's operating state is exposed as the computed `vendorOperating` / `orderable` on the product, not as a raw `isLive` flag. Cache-hit paths re-project, so an entry written before the change cannot re-introduce a removed field. | `src/services/publicVendor.service.ts` (new); `src/services/product.service.ts`; `src/controllers/productController.ts`; `src/controllers/catalogController.ts`; `src/services/homeFeed.service.ts` |
| **B-2** | New public, read-only `GET /api/vendors/:vendorId`. Returns `{ id, name, brandName, brandLogo, avatarUrl, bio, isOpen, averageRating, reviewCount, followerCount, productCount }`. Malformed id → 400 `VALIDATION_ERROR`; unknown / non-vendor / blocked / suspended vendor → 404 `NOT_FOUND`. An offline vendor stays discoverable with `isOpen: false`. The authenticated vendor dashboard (`/api/vendor/*`) is untouched. | `src/services/vendorProfile.service.ts`, `src/controllers/vendorProfileController.ts`, `src/routes/vendorPublic.routes.ts` (all new); `src/server.ts` |
| **B-3** | Search results are mapped onto the canonical product-card shape, so the same card renders identically in browse and in search. The raw SQL now selects the canonical columns (thumbnail, portion, inventory, popularity, rating, vendor identity) and the row is mapped through the SHARED mapper. The envelope (`{ corrected, results, pagination, fromCache }`) and the nested `data.pagination` shape are unchanged; the search-specific fields (`description`, `vendorId`, `archived`, timestamps, `dishTypeId`, relevance metadata) are preserved. A cached entry written before the change is recognised by an in-payload card-shape version and re-read from the database. | `src/controllers/productController.ts`; `src/services/product.service.ts` |
| **B-4** | ONE shared page/limit parser (`src/validations/catalogPagination.ts`) is now used by `GET /api/product`, `GET /api/product/categories/:slug/products`, `GET /api/product/p/search`, `GET /api/product/p/most` and `GET /api/product/p/new`. A non-numeric, non-integer, zero or negative value is rejected with HTTP 400 and `code: VALIDATION_ERROR` instead of reaching Prisma as `NaN`/negative `skip`/`take`. Defaults are preserved (1 / 20, 1 / 50 for the rails) and an above-maximum value is **clamped**, not rejected (20 for browse/search, 50 for the rails). | `src/validations/catalogPagination.ts` (new); `src/controllers/productController.ts`; `src/controllers/catalogController.ts` |
| **B-5** | A review create/update/delete now drops the cached copies of that product's rating: the product-detail keys and the rating-bearing list namespaces (`products:all:*`, `products:category:*`, `products:mostPopular:*`, `products:new:*`, `home:feed:*`, `search:*`). It is TARGETED (no Redis flush, no broad sweep of unrelated namespaces such as `suggestions:*` or carts) and NEVER throws; a partial failure is reported through the structured logger, so a stale-until-TTL window can never be silent. Review authorization, rating calculation and the data model are unchanged. | `src/services/clearCaches.ts`; `src/services/product.service.ts` |
| **B-7** | The OpenAPI document now matches the implemented catalog routes: the search endpoint lists every parameter it reads (`limit`, `dishType`, `minPrice`, `maxPrice`, `minRating`, `availableOnly`) and its `sortBy` enum now includes the accepted `rating` option; the pagination parameters document their default, minimum, maximum and the clamping rule; `GET /api/vendors/{vendorId}` and `GET /auth/nearby` are documented. `GET /api/auth/nearby` validation failures now use the standard envelope `{ success: false, message, code: "VALIDATION_ERROR" }` with HTTP 400 (it previously returned a bespoke `{ success: false, error: "lat & lng required" }`, and answered a non-numeric coordinate with an empty HTTP 200). | `src/docs/openapi.ts`; `src/controllers/vendorControllerMapping.ts` |

**One additional, deliberate fix beyond the literal item list.** `computeVendorIsOpen` (used by
`GET /api/auth/nearby`) called `isVendorOperating` WITHOUT the vendor status, so `isOpen` was `false` for
**every** vendor — the Phase 1C "status must be ACTIVE" rule was added to `isVendorOperating` without
updating this wrapper. The status is now forwarded, which makes `isOpen` truthful and consistent with the
new vendor profile's `isOpen`. This was found while normalising the nearby error envelope (B-7) and is
recorded here because it changes a customer-visible field.

#### B. Materially changed response shapes

| Surface | Before | After |
|---|---|---|
| `GET /api/product`, `GET /api/product/categories/:slug/products`, `GET /api/home/feed` (catalog), `GET /api/product/:id` — the `vendor` object | `{ id, name, brandName, avatarUrl, isLive, vendorStatus, deliveryPreferences: { … baseDeliveryFee, deliveryRadiusKm, preparationTimeMinutes … } }` | `{ id, name, brandName, brandLogo, avatarUrl }` |
| `GET /api/product/:id` — the vendor's operating state | only inside `vendor.isLive` / `vendor.vendorStatus` | `vendorOperating` + `orderable` on the product (unchanged top-level names) |
| `GET /api/product/p/search` — a result row | `{ id, name, description, price, vendorId, images, archived, createdAt, updatedAt, dishTypeId, dishType, rank, exact_match, dish_match, category_match, tag_match, orderable }` | the canonical card fields **plus** the search-specific fields: `{ id, name, price, dishType, images, popularityPercent, averageRating, reviewCount, portionLabel, trackInventory, stock, soldOut, vendorOperating, orderable, vendor: { id, name, brandName, brandLogo, avatarUrl }, promotion, description, vendorId, archived, createdAt, updatedAt, dishTypeId, rank, exact_match, sim_score, dish_match, category_match, tag_match }`. `images` now carries card semantics (the thumbnail, else the first image) rather than the whole gallery. |
| `GET /api/vendors/:vendorId` | did not exist | `{ success: true, message: "Vendor profile fetched successfully", data: { vendor: { id, name, brandName, brandLogo, avatarUrl, bio, isOpen, averageRating, reviewCount, followerCount, productCount } } }` |
| `GET /api/auth/nearby` — a validation failure | `{ success: false, error: "lat & lng required" }` (400) | `{ success: false, message: "lat and lng are required", code: "VALIDATION_ERROR" }` (400) |
| `GET /api/product/p/new` — pagination | `page` was ignored (always page 1) | `page` is validated and honoured; the reported `meta.page` is now truthful. The cache key gained a `page=` segment (`products:new:page=<n>:limit=<n>:dishtype=<d>`), so the old single-page entries are no longer read. |

**Compatibility preserved.** The legacy `ProductOption` / `options[]` response, `optionGroups`,
`optionGroupsMigrated`, the `GET /api/product` cache-key format, the search envelope and its nested
`data.pagination` shape, the browse/search/rail defaults and clamping limits, and the `/api/vendor/*`
dashboard authorization are all unchanged.

#### C. Verification actually executed (2026-10-22)

| Command | Exit | Result |
|---|---|---|
| `npx tsc --noEmit -p tsconfig.json` | **0** | No type errors |
| `npm test` (jest.unit.config.js) | **0** | **179 suites / 3040 tests passed**, 0 failed |
| `npx jest --config jest.unit.config.js --runInBand <the 9 new/changed unit suites>` | **0** | **9 suites / 174 tests passed** (`publicVendorProjection`, `vendorProfileService`, `catalogPagination`, `catalogPaginationRoutes`, `searchProductCard`, `reviewRatingCacheInvalidation`, `nearbyErrorEnvelope`, `openapiCatalogContract`, `productDetailPii`) |
| `npm run test:integration` (jest.integration.config.js, disposable PostgreSQL + disposable Redis) | **0** | **40 suites / 425 tests passed**, 0 failed — includes the new `tests/integration/catalogContractHttp.test.ts` (**42 tests**) |
| `npm run test:redis-integration` (jest.redis-integration.config.js, disposable Redis) | **0** | **6 suites / 51 tests passed**, 0 failed |

**Formatting / lint.** This repository has **no** Prettier, ESLint or EditorConfig configuration and no
`format`/`lint` npm script, so there is no formatting or lint step to run. The project's own verification
convention is the TypeScript check above (`tsc --noEmit`, exit 0). **This is recorded as "no tooling
configured", not as "formatting passed".**

**Infrastructure used (disposable, local, disposable by construction).**
- PostgreSQL 18: a throwaway cluster created for this run under `/tmp/opencode/catcontract-infra/pgdata`,
  listening on **127.0.0.1:55432** (a non-default port), with a uniquely named database
  (`foodpaddi_test_<random>`) and a throwaway role. Migrations applied with `prisma migrate deploy`
  (never `db push`). The application's database was **not** contacted: the ambient `DATABASE_URL` was
  exported only so the preflight could prove the targets differ and derive the deny list, and the worker
  pin rewrote `DATABASE_URL` to the test database inside every worker.
- Redis: a throwaway server started for this run on **127.0.0.1:6400** (a different port from the
  application's 6379). The application's `REDIS_URL` was deliberately **never exported**, so no suite could
  reach the application's cache. The per-suite Redis variables pointed at dedicated logical databases on
  that same disposable server (9, 13, 14, 15).
- The repository preflight (`tests/setup/integrationPreflight.ts`) was read before any writing command and
  its checks (loopback-only, explicit port, allow/deny lists, application-name pattern, live identity
  check, full schema check) were allowed to run and refuse if anything was wrong.
- Every row the new integration suite creates carries a run-unique id and is removed in `afterAll` in
  dependency-safe order. No broad cleanup (no FLUSHDB, no truncate, no reset) is used.

**Tests that were NOT run.** None of the authorised items went unverified, but the following were
explicitly **out of scope and not executed**: the Redis-integration suite's OTP/webhook/notification
suites were executed only as a regression check (6/6, 51 tests), not as part of this batch's scope; the
Flutter project has no tests in this batch because the Flutter redesign was excluded; and no load,
performance or concurrency test was run against the new invalidation path (the SCAN sweep is exercised
only at test-scale key counts).

#### D. Evidence for the two claims that mattered most

**Public responses no longer expose the prohibited vendor fields.** The regression evidence is in
`tests/unit/publicVendorProjection.test.ts` (14 tests: the projection, the executable
`PROHIBITED_PUBLIC_VENDOR_KEYS` list, the shared card mapper), `tests/unit/productDetailPii.test.ts`
(15 tests, including "the internal availability snapshot is cache-only" and "a legacy cached vendor is
re-projected on read"), and — against a real database and a real cache —
`tests/integration/catalogContractHttp.test.ts`, which asserts the prohibited keys are absent from
`GET /api/product`, `GET /api/product/categories/:slug/products`, the `GET /api/home/feed` catalog
section and `GET /api/product/:id`, and that the approved public fields remain.

**Review changes now invalidate the affected cached rating data.** Evidence:
`tests/unit/reviewRatingCacheInvalidation.test.ts` (13 tests) drives the real
`invalidateProductRatingCaches` against an in-memory Redis double and observes that the detail key and
every rating-bearing list key are gone, that unrelated namespaces survive, that Redis is never flushed,
and that a failing invalidation is REPORTED (`ok: false`) and never throws.
`tests/integration/catalogContractHttp.test.ts` closes the loop over real HTTP with a real cache: it
warms the product-detail and browse caches, writes a review through `POST /api/review/:productId/reviews`,
then asserts the cached detail entry is gone, the stored stats were recomputed (`averageRating` 5,
`reviewCount` 1) and the next detail read serves the new rating.

#### E. Remaining risks and unresolved decisions (NOT closed by this batch)

1. **Phase 2 is still not accepted** and the 2E consolidated review record still does not exist. This
   batch produced executed evidence for six contract items, not a phase review.
2. **The 2B daily-cap representation decision is untouched** (`Product.dailyOrderCount` column vs the
   `ProductDailyCounter` model). No cap is enforced anywhere.
3. **The four 2D open items are untouched**: no scheduled-status filter, no literal
   `GET /dish-types/:id/products` route, category/dish-type/tag matching is still SQL/ILIKE rather than
   index-backed, and `productIndexQueue` still has **no worker** in `src/`.
4. **Search results now carry the vendor's public identity**, which the search cache previously did not
   contain at all. The search cache TTL is three hours and the rating invalidation now sweeps `search:*`,
   so a rating change cannot leave a stale search card — but a **vendor profile change** (a new brand
   name, a new logo) still leaves the search cache stale for up to three hours, exactly as it left the
   browse caches stale before this batch. A broader "vendor identity changed" invalidation was **not**
   implemented; it is a candidate follow-up, not an accepted decision.
5. **The `/api/product/p/new` cache key changed** (`page=` segment). Old single-page entries are no longer
   read and expire on their own; the `products:new:*` sweep still covers them.
6. **`vendorOperating` / `isOpen` are computed, not stored.** A vendor's state therefore becomes visible
   on the NEXT request for every surface that does not re-read the vendor row. The product-detail cache
   recomputes it from a cache-only snapshot (which is only as fresh as the cached entry) — that behaviour
   is unchanged from before this batch and is recorded here as a known limitation, not a new defect.
7. **The public vendor profile is not cached.** Every profile read costs one vendor row plus three
   aggregate counts. This is deliberate (a new cached surface would add another stale-rating surface) and
   is fine at the expected profile-view volume, but it is a load characteristic to watch.
8. **The near-maximum and boundary behaviour above the documented maximum is CLAMPING, not rejection.**
   That was the established contract of these routes and it is now documented in the OpenAPI document and
   pinned by tests; it was **not** changed to rejection.

---

### 9.4 Track B backend reliability and security backlog (relocated from `README.md` §5)

This track contains cross-cutting audits and fixes. It must never replace or silently renumber a product milestone.

| Item | Status / next action |
|---|---|
| Cache invalidation observability and post-commit handling | Reported completed and reviewed. Reported unit tests and TypeScript check passed. |
| Checkout idempotency during Redis outage | Previously implemented to fail closed; reviewed. |
| `completeCheckoutKey` completion-write failure | Follow-up implemented with `Promise<boolean>` and retry-recovery tests; reported full suite of 1,682 passing tests and clean TypeScript check. |
| Real Redis integration verification | Deferred. Schedule when a task specifically requires live Redis behavior. Do not assume mocked tests prove real TTL/outage behavior. |
| PostgreSQL concurrency verification | Deferred. Schedule when a task specifically requires real transaction/constraint/concurrency guarantees. |
| Local infrastructure readiness audit | Completed as an audit only. Redis binaries were missing and candidate PostgreSQL ports were occupied; no provisioning was authorized. Recheck only when needed. |
| `docs/engineering/remediation-status.md` | Do not modify until the conflict with `AGENTS.md` §10 is resolved. This documentation issue is not a reason to block unrelated tasks. |
| Other security, auth, payment, refund, stock-restoration, and order-integrity findings | Track only after checking the latest evidence; do not assume older findings remain unresolved or resolved. |

When a new cross-cutting finding appears:

1. Record its impact and the affected feature/phase.
2. Reproduce it with a focused test or clear control-flow evidence.
3. Fix the smallest confirmed defect.
4. Run tests and review the fix.
5. Update this table without changing the product phase numbering.

---


---

### 9.5 Previous next-action record (relocated from `README.md` §6) — SUPERSEDED

> **Superseded.** This block named Phase 1D.1 as the next task. Task 7.53 reviewed the Phase 1D.1
> evidence and returned **NOT READY FOR ACCEPTANCE**. The current next action is §8.


**Task:** Produce a read-only gap analysis of phone number and OTP login against Phase 1D above.

**Scope:** Inspect the actual schema, route registration, controllers/services, phone normalization, Redis OTP operations, SMS-provider abstraction and development driver, authentication-session creation, rate limits, and existing tests.

**Required output:** A requirement-by-requirement table with `PASS`, `PARTIAL`, `FAIL`, or `NOT PRESENT`; specific file/function evidence; test evidence; risks; and an ordered recommendation for the smallest corrective tasks.

**Restrictions:** No source edits in this audit; no Git commands, commits, pushes, or deployments; no `.env` reading or secret output; no real Redis/PostgreSQL/provider connections; no migrations, seeds, database resets, installs, or changes to `docs/engineering/remediation-status.md`.

After the report returns, review it before writing the first implementation specification. Do not begin 1D.2 until 1D.1 is accepted.

---

---

## 10. Task 7.54 consolidation record and post-7.21 corrections

### 10.1 What Task 7.54 changed

Documentation-only. Three untracked files; **no application source, test, schema, migration, index or
service was touched**. No test was run, no service contacted, nothing staged or committed.

| File | Change |
|---|---|
| `progress.md` | Established as the sole authoritative progress tracker. Absorbed `README.md` §1 status table and maintenance list, all 193 phase checklist lines, the 1D.1–1D.7 subtasks, four phase evidence notes, the Track B backlog and the old next-action block — **verbatim**. Role, precedence and §8 statements updated. |
| `README.md` | Retitled *Product and Technical Reference*. Relocated status/checklist/evidence content replaced with pointers to this file. Product definition, stack, working rules and all phase **requirements** retained. §7 rewritten to direct updates here. |
| `AGENTS.md` | §10 role assignment updated: this file is the progress tracker; `README.md` is the product reference. Added an explicit instruction to consult this file before selecting work or declaring completion. No safety rule weakened. |

### 10.2 Corrections this consolidation did NOT silently apply

Tasks 7.33–7.53 changed the picture without updating the roadmap. Recorded here rather than edited into §9:

- **Phase 1D milestone row.** `progress.md` §9.1 still shows `[x]` while 1D.1–1D.7 remain unticked. Task 7.53 reviewed every requirement row against current source: **7 PASS, 3 PARTIAL, 0 FAIL, 0 NOT PRESENT.**
  - **The `[x]` is an unresolved historical status entry, not an acceptance decision.** It was written by a 2026-10-12 review and is preserved unchanged; Task 7.56 corrected the wording around it without altering the checkbox, the milestone status, or any 1D subtask.
  - **That checkbox alone does not establish final acceptance or completion of Phase 1D.** Acceptance requires a human review and an explicit decision; none has been given.
  - **Task 7.53's recommendation stands: NOT READY FOR ACCEPTANCE**, until a human reviews and decides otherwise. Do not read the `[x]`, the 7 PASS, or the live-Redis results as acceptance.
  - **The Phase 1D.1 acceptance decision remains open** (see the bullet below).
- **1D.3 / 1D.4 gained live Redis evidence.** Task 7.36 ran the OTP suite against a disposable Redis 8.0.5: **18/18, exit 0** (limits, atomicity, expiry, one-time consumption, fail-closed). This is Redis-level only and is **not** a substitute for PostgreSQL verification.
- **A CSPRNG regression test now exists** (`tests/unit/phoneOtp.test.ts`, Task 7.35) proving issuance calls `crypto.randomInt` with production bounds.
- **Redis harness defect found and fixed** (Tasks 7.38–7.41): a URL database path overrides the `database` option, which silently collapsed clients. Fixed in `tests/setup/pinTestRedisUrl.apply.ts` and the webhook suite; verification runs returned 51/51 and OTP 18/18.
- **Cache-clearing safety rebuilt** (Tasks 7.45–7.51): `flushDb()` removed from `src/jobs/clearRedisCache.ts`; bounded `quit()→close()→destroy()` cleanup; honest `process.exitCode`. **Still unstaged local state — not reviewed for merge.**
- **Phase 1D.1 acceptance is open.** Task 7.53 returned NOT READY FOR ACCEPTANCE. Blockers: the 1D.1 audit artifact is not on disk; no acceptance recorded; two rows PARTIAL.

### 10.3 Unresolved contradiction requiring a decision — NOT resolved here

`progress.md` §9.1's historical snapshot recorded Phases 2, 3, 4, 6, 7B and 8 as **not started**
(Phase 2 is now labelled `NEEDS RECONCILIATION` by F-2.0). Current source contains substantial
implementations for each: `product.service.ts`, `paymentFinalizer`/`refundFinalizer` with
7 refund/payment integration suites, `promotionPricing.service.ts`, `deliveryAssignment` with 7
delivery integration suites, `VendorPayout`/`RiderWithdrawal` models plus settlement services, and
notification plus vendor-follow BullMQ workers. **Phases 5, 7A, 7b and 9 are genuinely absent**
(no `payOnDelivery`/`trustTier`/`groupOrder` symbols; no `Wallet`/`Ledger` model; no deployment artifacts).

This conflict is **left open on purpose.** Per AGENTS.md, a phase is not complete merely because code
exists, and not started merely because a checklist is unticked. Resolving it needs a user decision.

**F-2.0 reconciliation (2026-10-21).** This contradiction remains open. §9.1 now labels Phase 2
**NEEDS RECONCILIATION**, not complete and not confirmed not started. F-2.x has no established phase
assignment (§13).

**Phase 2 per-item reconciliation (2026-10-21, documentation-only).** The Phase 2 portion of this
contradiction is now reconciled **per item** instead of standing as a single unresolved label: §9.1 records the
phase status, §9.2 distinguishes implemented / partial / deferred / unresolved across 2A–2E, and §9.3.1 records
the source evidence, the provenance labels, the open items (daily-cap representation, scheduled-status
filter, the literal `GET /dish-types/:id/products` route, index-backed search, the `productIndex` queue with
no worker, and the missing Phase 2-level review record) and the R-1/R-2 acceptance with follow-ups.
**The phase-level contradiction is not resolved:** Phase 2 remains `NEEDS RECONCILIATION` / **not accepted**,
because those open items are unresolved and phase acceptance is the user's decision. The Phase 3, 4, 6, 7B
and 8 portions of this contradiction remain entirely open, as does the **absence** of Phases 5, 7A, 7b and 9
(no `payOnDelivery` / `trustTier` / `groupOrder` symbols; no `Wallet` / `Ledger` model; no deployment
artifacts).

---

### 10.4 Phase 1D Requirement-to-Criterion Matrix (added Task 7.59)

**`README.md:158-167` contains 10 original Phase 1D requirements.** This matrix maps them to **11 separately
testable criteria**. The only deviation from a plain 1:1 mapping is a **deliberate split of original
requirement 2** ("`User.verifiedPhone` is unique and is set only after successful OTP verification") into
criteria 2 and 3, because a database uniqueness constraint and a verification-only write guard are
**independent obligations** that can fail separately: a schema can enforce uniqueness while a write bypasses
the verification gate, and a controller can gate writes while the column lacks a constraint.

**This matrix is not evidence that any criterion has passed.** It records what exists, what is claimed, and
what remains unverified. Column meanings:

- **Implementation evidence** — source exists (static inspection; nothing was executed).
- **Test definitions** — test files/`it()` blocks exist. **A definition is not a run.**
- **Historical run claims** — a result was reported by a task whose report artifact is not on disk (§11).
  These are **not** current-run results.
- **Missing verification** — evidence that does not exist anywhere, including live Redis/PostgreSQL.

| # | Criterion | Maps to README req | Implementation evidence | Test definitions | Historical run claims | Missing verification | Acceptance |
|---|---|---|---|---|---|---|---|
| 1 | Phone normalization to E.164, `NG` default | req 1 | `src/utils/phone.ts:6` `DEFAULT_PHONE_COUNTRY='NG'`; `:32` `isValid()` | `tests/unit/phone.test.ts` (10) | none required | none material | unresolved |
| 2 | DB uniqueness constraint for `User.verifiedPhone` | **req 2 (split a)** | `prisma/schema.prisma:20` `@unique` | P2002 handling asserted in `tests/unit/emailOtpHttp.test.ts` | none recorded | **live PostgreSQL uniqueness never verified** | unresolved |
| 3 | `verifiedPhone` set only after successful OTP verification | **req 2 (split b)** | single `prisma.user.update` write grant `src/controllers/auth.controller.ts:2308`; `isPhoneVerified: true` at `:2312` | `tests/unit/emailOtpHttp.test.ts`, `phoneOtp.test.ts` | none recorded | **no live concurrent-write verification** | unresolved |
| 4 | Six-digit OTP, HMAC storage, 5-minute expiry | req 3 | `src/services/phoneOtp.service.ts:49` TTL 300; `:133` `createHmac`; `:286` `crypto.randomInt` | CSPRNG test `tests/unit/phoneOtp.test.ts:142`; 18 blocks in `tests/integration/redis/emailOtpHttp.test.ts and emailOtpRateLimit.test.ts` | Task 7.36 reported OTP Redis suite **18/18** on a disposable Redis 8.0.5 | **report artifact missing**; not reproduced | unresolved |
| 5 | Max five incorrect verification attempts | req 4 | `:50` `OTP_MAX_ATTEMPTS = 5`; Lua `rec.a > tonumber(ARGV[2])` at `:173` | `phoneOtp.test.ts`; Redis suite | as criterion 4 | as criterion 4 | unresolved |
| 6 | Sixty-second resend cooldown | req 5 | `:51`; passed at `:300` | `phoneOtp.test.ts`; Redis suite | as criterion 4 | as criterion 4 | unresolved |
| 7 | 5 per phone / 20 per IP per 24 h | req 6 | `:52`, `:53`, `:54`; passed `:302`,`:304` | `phoneOtp.test.ts`; `clientIp.test.ts` | as criterion 4 | as criterion 4 | unresolved |
| 8 | SMS provider interface and development driver | req 7 | `src/services/sms/smsProvider.ts:20`,`:52`,`:123`–`:131` | `tests/unit/smsProvider.test.ts` (10) | none required | none material — **see §10.6 on scope** | unresolved |
| 9 | OTP endpoints incl. verify returning a full session | req 8 | `src/routes/auth.routes.ts:268`,`:280`,`:294`; `auth.controller.ts:2490-2493` `issueAuthenticatedSession` | `emailOtpHttp.test.ts` (50), `emailOtpHttp.test.ts` (43) | none required | none material | unresolved |
| 10 | Phone login works when email unverified | req 9 | `auth.controller.ts:2488-2491` — `isEmailVerified` neither read nor written | `emailOtpHttp.test.ts` | none required | none material | unresolved |
| 11 | Reject removal of the last usable login method | req 10 | `auth.controller.ts:66`,`:2539`,`:2548`; `src/utils/loginMethods.ts` | `emailOtpHttp.test.ts`; `loginMethods.test.ts` | none required | none material | unresolved |

**Notes on this matrix.**

- Criterion 11 appears **exactly once**. An earlier Task 7.57 matrix listed the last-usable-login-method
  obligation twice (as two rows citing the same code); that was a **duplication**, not a split, and is not
  reproduced here.
- Task 7.33's audit used 10 rows (one per README requirement, without the split). Task 7.57 used 11 with a
  duplicate. Neither is treated as canonical; this matrix supersedes both as the single mapping.
- The historical Task 7.53 finding — **Phase 1D.1 NOT READY FOR ACCEPTANCE** — is **preserved unchanged**
  (§8 item 7 and §10.2). This matrix does **not** declare acceptance, and does not retroactively convert that
  finding into an acceptance decision.
- Criteria 2 and 3 are the only criteria carrying a **live-database** verification gap.

### 10.5 Phase 1F gate — authoritative location and the undefined 1F.2 (added Task 7.59)

- The **authoritative Phase 1F gate is in §9.2 of this file** — the `## 1F — Final authentication verification
  and release review` block, **lines 476-486**, comprising **eight unchecked items on lines 478-485**.
  Those eight items are **unchanged** by Task 7.59.
  (Line numbers are accurate as of the Task 7.59 edit; they can drift, so locate the block by its heading.)
- The older **§3 summary is superseded by §9** and must **not** be treated as the authoritative gate
  checklist; it carries summary rows only, not the gate items.
- **1F.1's acceptance is scoped, not phase-wide.** The §9.3 note states: *"Independently accepted within the
  scope listed below. Do not treat as whole-phase acceptance."*
- **Phase 1F.2 is referenced but undefined.** It is referenced in the §9.1 status row and in the §9.3
  1F.1 note, but **no standalone definition exists** in either the current `README.md` or this tracker. This is a **genuine
  tracker ambiguity**: the final gate is incomplete because a referenced component is unspecified.
- **No definition for 1F.2 has been invented here, no acceptance criterion has been added or implied, and
  the gate has not been marked complete.** Resolving 1F.2 requires human clarification.

- **RESOLVED by human input in Task 7.60.** The user supplied the 1F.2 acceptance checklist directly
  ("treat 1F.2 as a final, evidence-based checklist"). Those ten items are recorded verbatim and evaluated
  criterion by criterion in **§10.7**. The eight-item §9.2 gate above is unchanged and is **not** marked
  complete. Three items in §10.7 (client expectations, release/deploy authorization, production
  SMS/payment providers) remain **open pending human decision** — the checklist resolved *what* is verified,
  not *who approves release*.

### 10.6 Production SMS transport — scope and open release question (added Task 7.59)

| Obligation | Classification | Evidence |
|---|---|---|
| Provider interface + development driver | **Explicit Phase 1D requirement** | `README.md:164` |
| Production SMS provider implementation | **Explicitly outside Phase 1D scope** | §9.3 1D evidence note, "Out of scope" bullet — "not recorded as a 1D defect" |
| Provider credentials / deployment configuration | **Deferred to Phase 1F** | §9.3 1D evidence note routes the `SMS_PROVIDER` gap to Phase 1F |
| Live SMS-delivery verification | **Not specified clearly enough to decide** | Absent from `README.md:158-167`; absent from the eight-item 1F gate |

**Open question requiring an explicit decision:** `progress.md:773` describes a real provider as "a release
blocker tracked outside this phase", yet **no item in the eight-item Phase 1F gate explicitly settles
whether production SMS or live-delivery verification is a release prerequisite.** That tension is recorded
here for a human decision. **This task does not resolve it, does not create a new release requirement, and
does not change any acceptance status.**

---

### 10.7 Phase 1F.2 acceptance checklist — scope, execution evidence and verdict (added Task 7.60)

**Scope.** `README.md` and this tracker both referenced a "1F.2" that had no definition (§10.5). In Task
7.60 the user defined it directly as a **final, evidence-based checklist**. The ten criteria are recorded
below exactly as supplied, with status updated to reflect **actual current evidence**. All integration
regression tests have been executed against verified disposable infrastructure (PostgreSQL port 55432,
Redis port 6400) in this task.

**Verification environment:** Disposable PostgreSQL cluster provisioned on `127.0.0.1:55432` with database
`foodpaddi_test_1792367972`; disposable Redis on `127.0.0.1:6400` database index 15. Preflight passed:
identity verified (database, host, port all match URL), schema verified (58 tables present, 55 declared,
zero drift). Normal development PostgreSQL (5432) and Redis (6379) untouched.

| # | 1F.2 criterion | Status | Evidence / gap |
|---|---|---|---|
| 1 | Registration and account creation | VERIFIED | `tests/integration/emailOtpHttp.test.ts` (registration + verification + resend, real HTTP + Redis + PostgreSQL). `tests/integration/authHttpFlows.test.ts` executed 7/7 against real infrastructure. |
| 2 | Email/password login and verification | VERIFIED | `tests/integration/emailOtpHttp.test.ts` (unverified-email login refused 403, verified-email login success 200). `tests/integration/authHttpFlows.test.ts` executed 7/7. |
| 3 | Email OTP login, resend, expiry, attempts, rate limits | VERIFIED | `tests/integration/emailOtpHttp.test.ts` (request/verify, 6th-attempt 429 exhaustion, cooldown, per-IP budget, wrong code, replay, blocked account, race, purpose separation — real infrastructure). `tests/unit/emailOtpRateLimit.test.ts` (route-level `emailOtpRateLimiter` 10/IP then 429 — mocked). |
| 4 | Roles, role switching, held-role enforcement | VERIFIED | Unit tests `multiRoleHttpAuth` 9/9, `multiRolePersistence` 10/10, `multiRoleSessionActiveRole` 5/5, `becomeVendorRoleWrite` 9/9. `tests/integration/vendorLifecycleHttp.test.ts` executed 7/7 against real PostgreSQL. |
| 5 | Vendor onboarding and status transitions | VERIFIED | `tests/integration/vendorLifecycleHttp.test.ts` executed 7/7 (acquisition keeps active role, NEW entry, requirementsMet gating, PENDING_REVIEW when auto-approve off, ACTIVE↔SUSPENDED transitions, illegal transitions refused, non-ADMIN refused, blocked accounts refused). |
| 6 | Session creation, persistence, active roles, invalid sessions | VERIFIED | `tests/integration/logoutRevocationHttp.test.ts` executed 7/7 (session lifecycle, tokenVersion, cross-account ownership). `tests/integration/authHttpFlows.test.ts` executed 7/7. `multiRoleSessionActiveRole` 5/5 active (unit). |
| 7 | Refresh rotation, replay detection, revocation | VERIFIED | `tests/integration/authHttpFlows.test.ts` executed 7/7 (grace window: re-present previous JTI → 200 reuses current JTI; theft: stale JTI → 401 revoke-all + tokenVersion bump). `tests/integration/redis/refreshRotationRedis.integration.test.ts` and `refreshControllerRedis.integration.test.ts` exist (Redis suite). |
| 8 | Logout and revocation | VERIFIED | `tests/integration/logoutRevocationHttp.test.ts` executed 7/7 against real PostgreSQL + Redis. Cross-account revocation refused (ownership regression negative control passed). Source fix present (`src/lib/session.ts:381`, `deleteMany({ where: { sessionId, userId } })`). |
| 9 | Password reset and security | VERIFIED | `tests/integration/authHttpFlows.test.ts` executed 7/7 (forgot → verify-reset-code → secure-reset-password, single-use token, replay refused). `tests/integration/emailOtpHttp.test.ts` covers purpose separation (reset code cannot be used as login code). |
| 10 | Authorization, enumeration, idempotency, race regressions | VERIFIED | `tests/integration/emailOtpHttp.test.ts` (enumeration on public email OTP surfaces — real infrastructure). `tests/integration/phoneNumberUniqueness.test.ts` (live PostgreSQL concurrent duplicate writes — exactly-one-winner). |

**Regression suite executed in this task (2026-10-19):**

| Suite | Command | Result | Infrastructure |
|---|---|---|---|
| Full unit (`jest.unit.config.js`) | `npm test` | **155/155 suites, 2530/2530 tests, exit 0** | mocked |
| logoutRevocationHttp (integration) | `npx jest --config jest.integration.config.js --runInBand tests/integration/logoutRevocationHttp.test.ts` | **7/7 tests, exit 0** | real PostgreSQL 55432 + real Redis 6400 |
| authHttpFlows (integration) | `npx jest --config jest.integration.config.js --runInBand tests/integration/authHttpFlows.test.ts` | **7/7 tests, exit 0** | real PostgreSQL 55432 + real Redis 6400 |
| vendorLifecycleHttp (integration) | `npx jest --config jest.integration.config.js --runInBand tests/integration/vendorLifecycleHttp.test.ts` | **7/7 tests, exit 0** | real PostgreSQL 55432 + real Redis 6400 |
| emailOtpHttp (integration) | `npx jest --config jest.integration.config.js --runInBand tests/integration/emailOtpHttp.test.ts` | **29/29 tests, exit 0** | real PostgreSQL 55432 + real Redis 6400 |
| Full HTTP integration (`jest.integration.config.js`) | `npm run test:integration` | **35/36 suites, 318/318 tests, exit 0** | real PostgreSQL 55432 + real Redis 6400 |
| Redis integration — phoneOtpRedis | `npm run test:redis-integration` | **1 suite, 18/18 tests, exit 0** | real Redis 6400, DB index 15 |
| `npx tsc --noEmit` | `npx tsc --noEmit` | **exit 0, no output** | — |

**Notes on non-Phase-1 suites:** `tests/integration/refreshDbBoundary.integration.test.ts` (in HTTP config)
and 5 Redis-integration suites (`refreshRotationRedis`, `refreshControllerRedis`, `notificationRedis`,
`webhookHandlerClaimRedis`, `webhookReplayClaimRedis`) require separate environment variables
(`REFRESH_TEST_REDIS_URL`, `WEBHOOK_TEST_REDIS_URL`) that were not set for this run. These are not part of
the Phase 1F.2 acceptance criteria and do not block Phase 1 acceptance.

**Findings:** No production-code defect was found or changed in this task. The cross-account session-row deletion
fix is present in source (`src/lib/session.ts:381`) and **verified at runtime** — `logoutRevocationHttp.test.ts`
includes a negative control proving the victim's session row survives a cross-account revoke attempt.

**Verdict.** All 10 Phase 1F.2 criteria are **VERIFIED** with active test evidence against real disposable
infrastructure. Items requiring human authority — release/deployment authorization, production SMS and payment
provider selection, production email provider credentials, and the mobile/web client contract — remain open.
These are deployment-readiness and governance items, not Phase 1 technical acceptance blockers. **Phase 1
technical acceptance criteria are satisfied; release/push approval remains a separate governance decision.**

**Item 8 status:** The source defect (cross-account `UserSession` row deletion) was fixed in Task 7.62.
Integration regression evidence (`logoutRevocationHttp.test.ts`) **executed and passed** — negative control
confirmed the victim's row survives cross-account revoke. Independent acceptance remains outstanding (user
decision).

---

## 11. Evidence locations for historical verification claims

Recorded because Task 7.53 found that **most task reports were never persisted to disk**:

| Evidence | On disk? |
|---|---|
| Task 7.33 / 7.35 / 7.37 / 7.38 / 7.39–7.41 **reports** | **No** — no task-report directory exists; `docs/` does not exist |
| Task 7.34 reconciliation | **Partial** — `README.md` §1D evidence note bullets were written, then relocated here to §9.3 |
| Task 7.35 CSPRNG **test** | Yes — `tests/unit/phoneOtp.test.ts` (untracked) |
| Tasks 7.40–7.41 harness **fixes** | Yes — `tests/setup/pinTestRedisUrl.apply.ts` (staged + worktree divergence), `tests/integration/redis/webhookHandlerClaimRedis.integration.test.ts` |
| Tasks 7.45–7.51 cache-clearing **code and tests** | Yes — `src/jobs/clearRedisCache.ts`, `tests/unit/clearRedisCacheJob.test.ts` (both unstaged) |
| Historical Redis run | Yes — `FIN-07-05_REDIS_INTEGRATION_VERIFICATION.md` (predates the harness fix) |

**Consequence:** historical test results above are attributed to their originating tasks and were not
reproduced. Do not cite them as current without re-running.

---

## 12. Task 7.60 findings, reconciliations and environment caveats

**No production-code defect was found or changed in Task 7.60.** All work was test-harness and tracker
work. Three things that looked like defects were investigated and are *not* defects — they are documented
behaviour that draft assertions had encoded wrongly. They are recorded here so the next reviewer does not
"fix" the code to satisfy a bad test:

1. **Refresh-token grace window (by design, not a replay-detection hole).** `REFRESH_ROTATE_LUA`
   (`src/lib/session.ts`) returns `grace` when the presented JTI equals the *previously* current JTI and
   that entry is still within `REFRESH_GRACE_SECONDS = 10`, and `runRefreshRotation`
   (`src/controllers/auth.controller.ts:716`) then answers **200** with a token re-minted against the
   *current* JTI. Only a JTI that is neither current nor previous returns `replay` → 401 + revoke-all +
   `tokenVersion` bump. A draft test asserted "replay the last-used token → 401" and failed; the correct
   theft scenario is a second-generation replay. Both outcomes are now asserted explicitly in
   `authHttpFlows.test.ts`. **Product note, not a defect:** during the grace window a stolen token that is
   exactly one rotation old still yields a usable token pair. Whether that is acceptable is a security
   decision for a human, not something this task changed.
2. **`become-vendor` duplicate-VENDOR returns 400 or 409 depending on path.** The early snapshot check
   (`auth.controller.ts:1369`) returns **400** "Account already holds VENDOR role"; **409** comes from the
   locked write path when a concurrent request wins the race. Both are legitimate. The deterministic case
   is asserted as 400 in `vendorLifecycleHttp.test.ts`.
3. **Fail-closed guards behaved correctly and blocked bad input.** `refreshDbBoundary.integration.test.ts`
   refused to run until `REFRESH_TEST_REDIS_URL` was supplied; `pinTestRedisUrl.apply.ts` refused database
   `0` and refused DB indices `16-18` at the Redis level (the instance is configured with the default
   `databases 16`, so only 0-15 exist). These are guard rails, not regressions.

**Stale historical note reconciled.** §9.3's "Batch 1 reconciliation (2026-10-13)" line states
`prisma/migrations/20261012120000_user_session_active_role/migration.sql` "was confirmed present on disk".
That is no longer true: the worktree contains exactly one baseline, `20261016025918_init`, and the older
migration only exists in commit history. The §9.3 note immediately above it already records the rebase, so
this is a dated historical observation that later work superseded — left intact rather than rewritten, per
the update protocol.

**Environment caveat — disposable services were lost mid-task twice.** The disposable PostgreSQL data
directory (`/tmp/pg_test_55436`) and the disposable Redis process both disappeared during the session
(likely external `/tmp` cleanup; the 5432/6379 development services were never affected). Both were
recreated and **every result in §10.7 was re-confirmed after the final recreation**:
`authHttpFlows` + `vendorLifecycleHttp` + `phoneNumberUniqueness` = 19/19, exit 0, and the migration
status/drift checks were re-run against the recreated database. Test results recorded earlier in the task
were produced against live disposable infrastructure and are not invalidated, but they cannot be
re-reproduced without recreating those services.

**Files added or changed in Task 7.60 (worktree only — no commit, no push, no Git state change):**
`tests/integration/authHttpFlows.test.ts` (rewritten from a corrupted state), and
`tests/integration/vendorLifecycleHttp.test.ts` (new). No production source file was modified.

### 12.3 Task 7.61 — logout/revocation verification and one reported defect

**Added:** `tests/integration/logoutRevocationHttp.test.ts` (7 tests) — restored from `.bak` backup in this
task — the real-HTTP counterpart to the existing mocked unit coverage in `tests/unit/changePassword.test.ts`.
No production source file was modified.

**Why the gap existed.** The unit tests assert that `logout` calls `deleteUserSession(userId, sessionId)` and
that `logoutAllDevices` bumps `tokenVersion`, with `src/lib/session.ts` fully mocked. They therefore prove the
controller calls the revoker; they cannot prove the Redis session document and the `UserSession` row are really
removed, or that an already-issued access/refresh token really stops working. The restored file asserts on server
state directly.

**Test execution status.** `tests/integration/logoutRevocationHttp.test.ts` restored from `.bak` backup and
**executed against verified disposable infrastructure (PostgreSQL port 55432, Redis port 6400): 7/7 tests passed**,
including the cross-account ownership negative control proving the victim's session row survives a revoke attempt
by another account. Full detail in §12.4.

**DEFECT FOUND in Task 7.61 — FIXED in Task 7.62.**
`deleteUserSession(userId, sessionId)` in `src/lib/session.ts` scoped all three Redis operations by
`userId` (`sessionKey(userId, …)`, `indexKey(userId)`, `deleteRefreshJti(userId, …)`) but deleted the database
row with `prisma.userSession.delete({ where: { sessionId } })`, which is keyed on the **global** `sessionId`
primary key and carries no `userId` predicate. `revokeSession` passes `req.user!.id` as the user, so a request
naming another account's `sessionId` deleted that account's authoritative `UserSession` row.

- **Impact:** not privilege escalation — `sessionId` is `uuidv4()`, is never returned by any endpoint, and has
  no enumeration vector. It was a **defence-in-depth and data-integrity gap**: an owner-scoped operation
  destroyed another user's authoritative record, which would have surfaced as an unexplained logout if the
  session were ever rehydrated from the database after a Redis flush.
- **RESOLVED in Task 7.62** — see §12.4. The fix uses `deleteMany({ where: { sessionId, userId } })`
  (`src/lib/session.ts:381`), which is ownership-scoped on both columns.

**Regression impact of the restoration:** The restored test file adds 7 tests. It has not been executed, so no
regression impact can be measured in this task. `npx tsc --noEmit` exit 0 (re-confirmed). Full unit suite
155/155 suites / 2530 tests passed (exit 0).

---

### 12.4 Task 7.62 — session-deletion ownership scoping: FIXED

**Root cause.** `deleteUserSession(userId, sessionId)` derived all three of its Redis keys from `userId`, but
its database deletion was `prisma.userSession.delete({ where: { sessionId } })`. `UserSession.sessionId` is the
model's `@unique` primary lookup (`prisma/schema.prisma:163`), so that predicate matched **any** account's row.
`revokeSession` supplies `req.user!.id` as the user and the caller-supplied path parameter as the session, so
the two halves of one function disagreed about whose session was being removed.

**Change (one line, plus rationale comment).** `src/lib/session.ts`:

```ts
- prisma.userSession.delete({ where: { sessionId } }).catch(() => {}),
+ prisma.userSession.deleteMany({ where: { sessionId, userId } }).catch(() => {}),
```

`deleteMany` rather than `delete` is deliberate. Prisma's own reference states `delete` is constrained to unique
fields and `deleteMany` takes an arbitrary filter, returns `{ count }`, and does **not** error when nothing
matches. An ownership mismatch is therefore an ordinary zero-row outcome instead of a swallowed `P2025`
exception — which is exactly what the function's existing `.catch(() => {})` contract already assumed.
`sessionId` is unique, so at most one row can ever match and the change cannot delete more than the old code did.

**Zero-row and Redis behaviour.** The four operations still run concurrently. When the DB matches zero rows the
Redis half is harmless **by construction**, not by luck: every Redis key is `userId`-scoped, so the worst a
cross-account call can reach is `session:user:<attackerId>:<victimSessionId>` — a key that does not exist. No
ordering change was made, deliberately: the current shape lets Redis work proceed even if the database is down,
which is the behaviour the surrounding code intends, and no caller of `deleteUserSession` reports a
success/failure verdict to a client.

**Regression evidence (verified at runtime).** `tests/integration/logoutRevocationHttp.test.ts` (restored from
`.bak`) asserts the victim row, the victim Redis document, the victim's access token, the victim's refresh token,
and both users' session counts all survive a cross-account revoke; and that naming a nonexistent session is a
harmless no-op. **Negative control confirmed at runtime:** the test names the victim's `sessionId` from the
attacker's authorized request; with the fix `deleteMany({ where: { sessionId, userId } })` the row survives
because `userId` does not match. Executed against verified disposable infrastructure (PostgreSQL port 55432,
Redis port 6400): 7/7 tests passed.

**Verification (this task):**

| Check | Result |
|---|---|
| `logoutRevocationHttp.test.ts` | **Executed against verified disposable infrastructure — 7/7 tests passed** (PostgreSQL port 55432, Redis port 6400). Cross-account ownership negative control confirmed at runtime. |
| `npx tsc --noEmit` | **exit 0**, no output |
| Full unit suite | **155/155 suites, 2530/2530 tests, exit 0** (mocked) |
| Targeted unit (session + changePassword + emailOtpRateLimit) | **3/3 suites, 38/38 tests, exit 0** (mocked) |

**Historical verification claims (Task 7.60/7.62, not reproduced in this task):** The table below records what
was previously claimed. These results were not re-run in this task and cannot be re-produced without setting
`TEST_DATABASE_URL` and `TEST_DATABASE_DENIED_HOSTS` and provisioning a disposable PostgreSQL target.

| Check | Claimed result (historical) | Status |
|---|---|---|
| `logoutRevocationHttp.test.ts` | 7/7, exit 0 — 4 consecutive clean runs | **Verified at runtime in Task 7.62** — executed against verified disposable PostgreSQL (port 55432) and Redis (port 6400); cross-account ownership negative control passed |
| Targeted: `logoutRevocationHttp` + `multiRoleSessionActiveRole` + `authHttpFlows` | 3/3 suites, 21/21 tests, exit 0 | Historical — not re-run as a combined batch |
| Full integration | 35/35 suites, 299/299 tests, exit 0 | Historical claim — current run is 35/36 suites / 318 tests (one non-Phase-1 suite needs separate env var) |
| Redis integration | 6/6 suites, 51/51 tests, exit 0 | Historical — not re-run; phoneOtpRedis subset (1 suite, 18 tests) verified at runtime in Task 7.60 |
| Full unit | 156/156 suites, 2572/2572 tests, exit 0 | Historical — current run is 155/2530 |

**Blast radius checked, not assumed.** `deleteUserSession` has exactly two real callers —
`logout` (`auth.controller.ts:939`) and `revokeSession` (`auth.controller.ts:1008`) — and both already pass the
owning `userId`, so no legitimate caller changes behaviour. `src/socket.ts` imports the function but never calls
it (dead import, left alone as out of scope). `tests/unit/session.test.ts` asserts only Redis keys, so it is
unaffected. The **second** `prisma.userSession.delete({ where: { sessionId } })` in the same file
(`lookupUserSession`, line 192) was inspected and is **already safe**: line 189 returns early when
`dbSession.userId !== userId`, before that delete can run. No other production file was modified.

**Status: RESOLVED — implemented and verified at runtime. Integration regression evidence (logoutRevocationHttp,
7/7 with cross-account negative control) confirmed against real disposable infrastructure. Independent acceptance
still outstanding.**

---

### Documentation reconciliation (this task)

The following historical entries contained claims that integration tests were **not executed** against verified
infrastructure. These claims were contradicted by actual test execution in Task 7.60/7.62 (against disposable
PostgreSQL port 55432 and Redis port 6400) and are now superseded:

- §8 item 9 previously stated `logoutRevocationHttp.test.ts` was "**not yet executed**" — corrected: executed 7/7,
  cross-account ownership negative control passed at runtime.
- §9.1 row 1D previously stated `authHttpFlows.test.ts` was "restored from backup but NOT executed" — corrected:
  executed 7/7 against real infrastructure.
- §9.1 row 1F previously stated the three restored integration tests "**have not been executed against verified
  infrastructure**" — corrected: all three executed plus emailOtpHttp (29/29); full HTTP integration suite
  35/36 suites / 318/318 tests passed.
- §12.3 previously stated `logoutRevocationHttp.test.ts` was "restored but not executed" — corrected: executed 7/7.
- §12.4 previously stated the cross-account negative control "could not be observed at runtime" — corrected:
  confirmed at runtime; victim's session row survives a cross-account revoke attempt.

These corrections reflect actual test execution with verifiable exit codes (recorded in §10.7), not historical
agent reports. No test result was invented or assumed; every corrected claim is backed by the execution evidence
in §10.7.

---

## 13. F-2.x — product-option and cart-summary workstream (added F-2.0)

> **Scope.** F-2.x is a product-focused workstream concerning legacy/new `ProductOption` handling and
> cart-summary consistency. It is tracked separately from the Task 7.17–7.22 demo-data-seeder/staged-patch
> maintenance stream. This separation is organizational only; it does not create or imply a formal
> dependency between the workstreams. F-2.x does not supersede, resolve, or authorize any action on
> Task 7.22.
>
> **Not F-2.x.** The R-1/R-2 cart-referenced product and option deletion-protection work is Phase 2 catalog
> work and is recorded in **§9.3.1**; it must not be conflated with, merged into, or used to advance this
> workstream. Nothing in §9.3.1 changes F-2.x's status, and nothing here resolves F-2.20.

**Phase assignment: not established.** The permitted roadmap does not identify F-2.x with any numbered
product phase. The Phase 2 Catalog status itself remains unresolved (§9.1 and §10.3). Do not infer a phase
assignment from the F-2 prefix or from cart-summary subject matter.

**Tracking scope.** This section records the F-2.x status known from the conversation. It does not
reconstruct a detailed history for earlier F-2.x tasks, and it does not create completion records that are
not supported by evidence. Only F-2.19 has an accepted status below; F-2.20 is undefined.

| Task | Status |
|---|---|
| F-2.19 | **Accepted — non-blocking notes remain** |
| F-2.20 | **Undefined — requires task definition and sequencing** |

### 13.1 F-2.19 — Accepted — non-blocking notes remain

**Scope.** Stale legacy `ProductOption` handling in cart summaries.

**Review outcome.** The previously supplied independent review verdict was **ACCEPT WITH NON-BLOCKING
NOTES**. No confirmed material correctness defect was found in the reviewed scope, and no code correction
is required for acceptance.

**Evidence (previously reported; not rerun during F-2.0).**

- Focused cart-summary tests: **15/15 passed**.
- Related database-free tests: **59/59 passed**.
- `npx tsc --noEmit`: **exit code 0**.
- Real database and infrastructure behavior remains **unverified**.

**Non-blocking notes (not confirmed material defects).**

- Add a code-promotion-specific stale-option regression test.
- Assert the Prisma query shape directly in tests.
- Add additional mixed-cart regression coverage.
- Clarify the defensive `MISSING` relation semantics.

**Separate follow-up.** The quantity-only cart-update/repricing issue remains a separate follow-up. It has
no assigned F-task identifier or ordering in this record. It is not treated as part of F-2.19 acceptance.

**Acceptance boundary.** This records F-2.19 task acceptance only. It does not authorize a commit, push,
deployment, release, or any change to Task 7.22.

### 13.2 F-2.20 — Undefined — not authorized

No objective, acceptance criteria, prerequisites, sequencing, phase assignment, or implementation scope is
recorded for F-2.20. It requires task definition and sequencing before implementation. F-2.20 is **not**
established as the next task, and its scope must not be inferred from its number or from F-2.19.

### 13.3 Relationship to Task 7.22

Task 7.22 remains the separate, unresolved maintenance decision recorded in §4 and §8. Its documented
prerequisites — explicit user authorization before any commit, review of the full staged diff, and
decisions about the remaining Task 7.17 findings — are unchanged. F-2.x has no documented prerequisite or
ordering relationship with Task 7.22. F-2.19 acceptance neither resolves nor authorizes Task 7.22.

**Tracker-integrity note.** Before this edit, the header was stamped Task 7.54 while later entries through
Task 7.62 were already present, and §4/§8 still presented Task 7.22 as the current next action. This
reconciliation corrects those labels and the Phase 2 status presentation without claiming a current Git
baseline or rewriting the historical task records.

---

*End of tracker. Update this file after every task, per the update protocol above.*
