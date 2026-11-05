# Foodi Paddi Backend — Permanent Agent Instructions

## 1. Project Mission

Foodi Paddi is a Nigerian food marketplace connecting customers with home cooks, students, and local food vendors. Customers order meals, vendors prepare them, and delivery personnel deliver them.

The goal is to build a secure, reliable, maintainable backend suitable for a real-world marketplace.

The project uses technologies including Node.js, TypeScript, Express.js, PostgreSQL, Prisma, Redis, Socket.IO, Paystack, and Jest. Always inspect the actual project and its configuration to confirm the technologies and versions in use.

## 2. Mandatory Instructions for Every Task

Before acting on any new task:

1. Read and follow this `AGENTS.md`.
2. Understand the user's latest request, scope, constraints, and acceptance criteria.
3. Read `README.md` when it contains relevant product requirements, roadmap information, or task dependencies.
4. Inspect the relevant source code, tests, configuration, and existing implementation.
5. For ongoing remediation, consult relevant previous batch reports and available engineering records without violating the documentation restrictions in Section 10.
6. Identify relevant security, compatibility, concurrency, data-integrity, and regression risks.
7. Research applicable documentation before significant technical changes.
8. Implement the smallest complete, maintainable solution when implementation is authorized.
9. Run appropriate verification and inspect the final changes.
10. Report the actual results, failures, blockers, and unresolved issues.

Do not rely exclusively on AI model memory or previous agent reports. Verify important claims against source code, documentation, and test evidence.

Do not begin unsafe operations or make unresolved business decisions on the user's behalf. If essential requirements or authorization are missing, stop and ask.

A task prompt defines the work authorized for the current run. Do not expand its scope without approval. A read-only audit must remain read-only even if the general engineering workflow describes implementation steps.

## 3. Mandatory Online Research Policy

### When research is required

Before non-trivial, security-sensitive, architectural, concurrency, payment, authentication, database-integrity, infrastructure, or third-party integration changes, research the relevant technical subject before implementation.

Research should be proportional to the risk and complexity of the task.

### What to research

1. **Official documentation:** Read the relevant documentation for the exact technology, library, API, or version used by the project.
2. **Security standards:** Consult applicable authoritative guidance, such as OWASP, NIST, or relevant protocol specifications.
3. **Real-world implementations:** When useful, inspect maintained open-source repositories, established production patterns, documented vulnerabilities, technical incident reports, and credible engineering write-ups.
4. **Existing implementation:** Read the relevant Foodi Paddi code and tests to understand the current behavior and constraints.
5. **Failure scenarios:** Investigate edge cases, concurrency, retries, timeouts, partial failures, compatibility, and recovery behavior where relevant.

Do not blindly copy examples or assume that a popular implementation is correct for Foodi Paddi. Evaluate the evidence and adapt the solution to the project's architecture.

### How to access online sources

Use the available web-search, HTTP-fetch, browser, or documentation-retrieval tools when they are available and permitted.

- Search for the relevant information rather than assuming a URL or documentation page is correct.
- Open and inspect the actual source content.
- Prefer official documentation and primary sources over summaries.
- Verify that examples and recommendations apply to the project's installed versions.
- Follow links to relevant official references when necessary.
- Do not claim to have read a page merely because a search result displayed its title or snippet.
- Do not claim that an HTTP request succeeded unless the tool returned evidence of success.
- Never invent URLs, quotations, documentation, citations, or research findings.

If a task requires research but web access is unavailable, blocked, or unsuccessful, explicitly report the limitation. Do not pretend research was completed. Decide whether the change can safely proceed using verified local evidence or whether it must wait for further research.

Routine, low-risk changes do not require unnecessary browsing when the existing code and established behavior provide sufficient evidence.

### Research reporting

For significant changes, report:

- The actual source title and URL.
- The relevant documentation section, passage, or technical finding.
- How the evidence influenced the implementation decision.
- Any disagreement between external guidance and the existing implementation.
- Any unresolved assumptions or limitations.

A list of links alone is not proof that the sources were inspected.

## 4. Security and Data Integrity

Security and data integrity are core requirements.

Pay particular attention to:

- Authentication, authorization, and role boundaries.
- Account enumeration and information leakage.
- Password reset, email verification, phone verification, and OTP security.
- Session management, refresh-token rotation, replay detection, and token revocation.
- Rate limiting, abuse prevention, and resource exhaustion.
- Input validation, output serialization, and error handling.
- Payment initiation, verification, webhooks, refunds, and idempotency.
- Order ownership and customer/vendor/delivery relationships.
- Inventory consistency, overselling, and concurrent purchases.
- Vendor suspension and account-status restrictions.
- Database transactions, constraints, and concurrent updates.
- Redis failures, retries, timeouts, and required fail-closed behavior.
- Sensitive information in logs, error messages, and API responses.

Never trust client-supplied roles, prices, payment states, ownership identifiers, or privileged values without appropriate server-side validation.

Do not weaken authorization, validation, constraints, or failure handling merely to make a test pass.

For security-sensitive changes, include negative tests showing that unauthorized, invalid, or malicious operations are rejected.

## 5. Implementation Standards

- Follow existing project conventions and architecture unless evidence justifies a change.
- Use TypeScript safely and avoid unnecessary `any`, unsafe casts, and suppressed compiler errors.
- Keep functions focused and code maintainable.
- Handle errors explicitly and consistently.
- Use transactions and database constraints where necessary for correctness.
- Make concurrent operations safe where business rules require it.
- Preserve existing API contracts unless a change is explicitly authorized.
- Avoid unrelated refactoring, speculative features, and unnecessary dependencies.
- Do not delete tests or weaken assertions to obtain passing results.
- Do not modify production behavior simply to accommodate a faulty test.
- Explain significant design decisions and relevant alternatives.

Understand the root cause before implementing a fix. Prefer a small, complete solution over a large collection of superficial patches.

## 6. Testing and Verification

Select tests according to the behavior and risks being changed.

Use:

- Unit tests for isolated business logic.
- Integration tests for interactions between components.
- Real infrastructure tests when correctness depends on PostgreSQL, Redis, Lua scripts, transactions, or concurrency.
- Security and negative tests for authentication, authorization, and abuse prevention.
- Regression tests for previously identified defects.

Mocks can validate application logic but cannot prove that real infrastructure behaves correctly.

After changes, run the relevant regression tests and TypeScript checks. Run broader suites when appropriate and safe.

Report the following for each significant verification step:

- Exact command executed.
- Actual exit code.
- Tests executed and their results.
- Relevant warnings, failures, hangs, and timeouts.
- Whether the test used mocks or real infrastructure.
- Any required tests that remain unexecuted.

Do not use `--forceExit` to conceal open handles, unfinished asynchronous work, or test-runner failures. If used diagnostically, report that result separately from the normal test run.

A passing TypeScript check does not prove runtime correctness. Passing unit tests does not establish real Redis or database behavior. A passing test suite does not automatically establish release readiness.

For read-only audits, run tests only when explicitly permitted by the task scope and when they can be executed safely without prohibited infrastructure access or external side effects.

## 7. Local Development and Infrastructure Safety

The default workflow is local development, testing, debugging, and review. The agent should be able to work efficiently with the project's local code, databases, and development services while protecting production systems and important data.

### Local development and Git

- Work locally by default.
- Do not push code to GitHub or other remote repositories unless the user explicitly requests it.
- Do not create commits, rewrite Git history, or perform other Git operations that change repository state unless authorized. Read-only Git commands may be used to inspect project history and working-tree status.
- Preserve existing modified and untracked files. Do not reset, clean, overwrite, or discard the user's work.
- Do not deploy to Render or any other hosting provider unless explicitly authorized.
- Do not contact production services or perform production operations unless the user explicitly authorizes the specific operation.

### Local databases and testing

- Local PostgreSQL databases may be used for development, debugging, unit tests, integration tests, concurrency tests, and migration testing when appropriate for the task.
- PostgreSQL version 18 and port 5432 are permitted for local development and testing. The version and port alone do not determine whether a database is safe to use.
- Inspect the project's database configuration and verify the target database before performing operations that could modify or delete data. Never display credentials or `.env` secrets while checking configuration.
- Use the project's existing local development database when the operation is safe and appropriate. Prefer a separate disposable test database for destructive tests, migration experiments, and tests that reset or seed data.
- Read-only database queries may be used for audits and debugging when relevant to the task.
- Database writes, test-data seeding, resets, migrations, `prisma db push`, and other schema-changing operations are permitted when they are within the user's authorized task and the target database has been verified.
- Never run destructive tests or unintended schema changes against production databases or databases shared with other users or applications.
- Before resetting a database or running a destructive test, verify the target and determine whether existing data needs to be preserved. If the target or potential impact is unclear, stop and ask the user.
- Do not treat a local database as production merely because it uses a particular PostgreSQL version or port. Determine its actual purpose and configuration.

### Redis and other development services

- Use local Redis and other local development services for appropriate testing when they are available and configured for the task.
- Never use the application's Render-hosted Redis for tests, experiments, cleanup, or other development activities that could affect application data.
- Do not use production services as substitutes for missing local test infrastructure.
- Docker containers, system packages, `sudo`, and system-service changes may be used when necessary for the task, provided the specific operation is authorized and its effects are understood. Do not make unrelated system changes.
- Do not enable or change the stranded-dispatch reconciliation cron unless the user explicitly authorizes that change.

### Environment and configuration

- Inspect configuration files and environment-variable names when needed to understand the project's setup, without exposing secret values.
- Never print, disclose, or copy `.env` contents, passwords, API keys, access tokens, refresh tokens, OTP secrets, or database credentials into reports or user-visible output.
- Local development configuration may be changed when required by the authorized task. Preserve existing values where possible and avoid unrelated configuration changes.
- Do not change production credentials, deployment configuration, or production environment variables without explicit authorization.
- Do not change configuration merely to conceal a test failure, bypass an unrelated security control, or make an unsafe operation appear safe.

### Scope and operational safety

- Follow the scope of the current task and make the smallest complete set of changes needed.
- Authorization to perform one operation does not automatically authorize unrelated deployments, remote Git operations, destructive data changes, or production actions.
- Before significant database changes or destructive tests, confirm the intended target and use appropriate safeguards, such as backups or a disposable test database, when needed.
- If required infrastructure is unavailable, identify the missing prerequisite and propose a practical local alternative rather than silently using production services.
- Run the relevant verification steps when authorized and safe. Report the actual commands, results, failures, and limitations. Never claim that a test or operation succeeded if it was not performed.

### Secrets and sensitive data

- Never disclose secret values or sensitive credentials.
- Avoid including personal data, payment details, authentication tokens, or other sensitive information in logs, test reports, or debugging output unless strictly necessary; redact such values where possible.
- Use test credentials and test data where appropriate, especially when exercising payment integrations or other external services.

The objective of these rules is to support productive local development and reliable testing without accidentally damaging important data, exposing secrets, or affecting production systems.


## 8. Batch-Based Workflow

Perform one clearly scoped remediation batch at a time.

### Before implementation

1. Read `AGENTS.md` first.
2. Read `README.md` for the applicable product requirements, and `progress.md` for current phase status, task sequencing, evidence, and the next authorized task.
3. Consult relevant prior reports or permitted engineering records without violating Section 10.
4. Confirm the task's scope and acceptance criteria.
5. Identify dependencies, risks, and required research.
6. Confirm that necessary test infrastructure is safe and available.
7. Identify any decisions requiring user authorization.

### During implementation

1. Work only within the approved scope.
2. Add or update appropriate tests when implementation is authorized.
3. Run required verification.
4. Investigate failures instead of concealing them.
5. Avoid unrelated changes.
6. Preserve unresolved findings until verified evidence establishes that they are fixed.
7. Do not perform implementation during a read-only audit.

### After implementation or audit

1. Inspect the final changes, if any.
2. Report changed files and the reason for each change, or explicitly state that no files were changed.
3. Report research sources and how they influenced significant implementation decisions.
4. Report commands, exit codes, test results, and limitations.
5. Update only documentation that the current task authorizes and Section 10 permits.
6. State the actual task status.
7. Recommend the next logical action without starting it automatically.

Do not start the next remediation task without the required review or approval.

## 9. Remediation Status and Acceptance

Keep implementation completion distinct from acceptance.

Use these states:

- **Complete:** The implementation work and agreed checks have finished.
- **Blocked:** Required work or verification could not be completed safely or successfully.
- **Awaiting review:** The implementation evidence is available, but independent review or approval remains outstanding.
- **Accepted:** The agreed acceptance criteria have been reviewed and explicitly approved.

Do not mark Phase 1 accepted until all required acceptance criteria and outstanding release decisions are resolved.

Do not describe partially verified functionality as production-ready.

Previously identified defects remain open until evidence demonstrates that each has been resolved and accepted.

Never treat a previous agent's report as automatic proof of acceptance.

A coding agent may report that its own work is complete, but it must not treat that statement as independent acceptance by the user or reviewer.

## 10. Documentation and Continuity

Use persistent project files to preserve engineering decisions and progress across conversations and context limits.

Progress has exactly one home: `progress.md`. Do not duplicate progress tracking in `AGENTS.md` or `README.md`.

Maintain these responsibilities separately:

- `AGENTS.md`: permanent engineering rules and safety restrictions.
- `README.md`: product and technical reference — purpose, stack, architecture, and what each area must achieve. Carries **no progress status**.
- `progress.md`: **the single authoritative progress tracker** — phase and milestone status, checklists and sequencing, implementation status, test and verification evidence, review and acceptance status, outstanding defects, deferred work, and the next authorized task.
- `docs/engineering/remediation-status.md`: engineering remediation status, outstanding defects, blockers, acceptance state, and next approved task, subject to the restriction below.
- Relevant batch reports: detailed changes, research evidence, test results, review findings, and decisions.

### Documentation update permissions

1. **`AGENTS.md` — permanent instructions**
   - Change permanent instructions only when the user explicitly authorizes the instruction change.
   - Do not silently weaken safety rules to accommodate an implementation task.

2. **`README.md` — product and technical reference**
   - Use it to understand the product vision, phase sequence, and what each area must achieve.
   - It does **not** record progress. Do not add phase statuses, checklists, test results, or next-task tracking here; those belong in `progress.md`.
   - Update it only when the current task authorizes documentation changes and verified evidence justifies the update.
   - Do not mark work accepted merely because an agent reports completion.

3. **`docs/engineering/remediation-status.md` — temporarily restricted**
   - Do not read, create, edit, overwrite, rename, delete, or otherwise modify this file as part of remediation work until the user explicitly authorizes resolution of the documentation restriction.
   - This restriction takes precedence over any general instruction elsewhere in this file that would otherwise require reading or updating the remediation-status document.
   - Do not treat the file's contents as a prerequisite for unrelated tasks while this restriction remains active.
   - Use the applicable README roadmap, authorized batch reports, actual source code, and test evidence to establish the status needed for the current task.
   - Do not attempt to bypass this restriction by using another tool, script, or indirect method to access or change the file.

4. **`progress.md` — sole authoritative progress tracker**
   - Progress tracking, milestone status, task sequencing, verification evidence, outstanding work, and acceptance status are maintained **exclusively** in `progress.md`.
   - **Consult it before selecting work, before declaring a task complete, and before reporting progress.** Do not maintain duplicate progress checklists in this file or in `README.md`.
   - Update it after every task, but only when the task authorizes documentation changes.
   - Keep unverified items explicitly marked unverified. Never upgrade a status without evidence, and never convert a historical agent claim into a verified fact.
   - Where `progress.md` and the source or test evidence disagree, the evidence wins and the tracker must be corrected.
   - If conflicting statuses cannot be resolved from available evidence, retain the information and label the conflict as requiring reconciliation rather than guessing.

5. **Batch reports and other engineering documentation**
   - Create or update a report only when the current task authorizes that documentation work.
   - Keep reports evidence-based and preserve unresolved findings.
   - Do not create unrelated documentation as a side effect of a narrowly scoped task.

### Resolving documentation conflicts

- If instructions conflict, follow the more restrictive applicable rule and report the conflict rather than silently overriding it.
- The restriction on `docs/engineering/remediation-status.md` remains in effect until the user explicitly authorizes a change.
- Resolving a documentation conflict does not authorize Git operations, deployment, infrastructure changes, database changes, or any other unrelated operation.
- If a required document is missing or restricted, do not invent its contents. Report the limitation and use available evidence to establish the current status when safe.

### Maintaining continuity

Before continuing existing remediation work, consult the applicable roadmap, task prompt, and available authorized reports.

Update progress only when verified evidence supports the change and the current task permits it.

Do not overwrite unresolved issues with assumptions or delete historical findings merely because a new task has begun.

## 11. Final Report Format

At the end of each implementation task or audit, provide:

### Outcome

Complete, blocked, or awaiting review.

### Changes

Files modified and the purpose of each change. If the task was read-only, explicitly state that no files were changed.

### Research

Sources actually inspected, relevant findings, and the decisions they informed. State explicitly when required research could not be completed.

For a read-only audit, distinguish source-code evidence from external documentation research and state any limitations.

### Verification

Exact commands, exit codes, test results, failures, and limitations.

Distinguish mocked tests from real-infrastructure verification.

### Findings and Remaining Issues

Report confirmed defects, potential risks, unresolved assumptions, missing evidence, and infrastructure blockers. Do not present an unverified concern as a confirmed defect.

### Acceptance

State which acceptance criteria are satisfied and which remain unverified. Do not self-declare acceptance where independent review is required.

### Next Step

Recommend the smallest logical next action without automatically starting it.

Be precise and concise. Never exaggerate the completeness, security, or reliability of the result.

## 12. Final Principle

Build Foodi Paddi using verified evidence, appropriate research, secure engineering, careful testing, and disciplined scope control.

The objective is not merely to make code compile or tests pass. The objective is to make the backend correct, secure, maintainable, and verifiably reliable without hiding defects, fabricating evidence, violating the user's authorization, or risking production infrastructure.
