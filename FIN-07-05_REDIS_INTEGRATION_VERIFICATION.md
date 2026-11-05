# FIN-07-05 — Redis Integration Verification (Batch Report)

## Purpose and scope

This report records the FIN-07-05 Redis integration verification and its shutdown-timing
investigation. It is a **verification record**, not a claim of exhaustive Redis coverage. It
does not cover the PostgreSQL integration suite, which is a separate concern, and it does not
constitute acceptance of any remediation batch.

## FIN-07-05n — Runtime verification

| Item | Value |
|---|---|
| Command | `npm run test:redis-integration` |
| Exit code | `0` |
| Test suites | 6 passed, 6 total |
| Tests | 51 passed, 51 total |
| Disposable Redis target | `127.0.0.1:6401`, logical database 15 |

All six suites passed, including `webhookHandlerClaimRedis`. At the time of that run, the Jest
process was **observed alive after** the final summary was printed.

## FIN-07-05o — Open-handle diagnostic

| Item | Value |
|---|---|
| Command | `npm run test:redis-integration -- --detectOpenHandles` |
| Exit code | `0` |
| Test suites | 6 passed, 6 total |
| Tests | 51 passed, 51 total |
| Disposable Redis target | `127.0.0.1:6402`, logical database 15 |

Jest reported **no open handles**. The process was again observed alive after the summary, but
**the cause was not established** by that run.

## FIN-07-05p — Process inspection

A later read-only inspection found **no Jest-matching process** alive. The original PID had not
been recorded, so the identity of the process seen in earlier runs **could not be established
retrospectively**.

- Classification: **previous process exited**.
- No processes were terminated or signalled.

## FIN-07-05q — Shutdown timing

| Item | Value |
|---|---|
| Command | `npm run test:redis-integration` |
| Exit code | `0` |
| Test suites | 6 passed, 6 total |
| Tests | 51 passed, 51 total |
| Disposable Redis target | `127.0.0.1:6403`, logical database 15 |
| Final summary → top-level command exit | approximately **0.42 seconds** |
| Total runtime | approximately 7.00 seconds |

Timing was captured by an independent observer polling every 400 ms without signalling any
process. The **earlier delay was not reproduced** in this run.

- Classification: **prompt shutdown**.
- The **original cause of the earlier observation remains unproven**. No leak was identified, and
  none is claimed here.

## Safety and cleanup

- Verification runs used **disposable loopback-only Redis instances** and the repository's
  existing disposable-Redis safety gate (`evaluateDisposableRedisTarget`), which was not
  modified, bypassed, or duplicated.
- The four test-specific Redis URL variables (`OTP_`, `NOTIF_`, `REFRESH_`, `WEBHOOK_TEST_REDIS_URL`)
  were configured to the disposable target for the duration of each runtime verification.
- Where reported, the parent application `REDIS_URL` was **preserved** and never overwritten
  with the disposable endpoint.
- The reports confirm the **application Redis and PostgreSQL were left untouched**: the
  application Redis was observed only via process/socket metadata and never connected to, and
  PostgreSQL was not contacted or modified.
- Each disposable instance was **stopped**, its port released, and its dedicated temporary
  directory removed. A small number of test keys remained inside the disposable databases before
  shutdown; those instances were destroyed, so nothing persisted.

## Final outcome

- The Redis integration suite **passed in every recorded run**: 6/6 suites and 51/51 tests.
- The earlier shutdown delay **was not reproduced** in FIN-07-05q, which measured a ~0.42 s
  interval between the final summary and command exit.
- **No code fix was required or implemented in this batch.**
- This report records the available evidence. It **does not establish exhaustive Redis
  correctness**, and the cause of the earlier post-summary observation remains unproven.
- **PostgreSQL integration verification is a separate concern** and is not addressed here.
- The remediation-status register (`docs/engineering/remediation-status.md`) was **not** created,
  read, or modified; that document does not exist and remains restricted by `AGENTS.md` §10.3.
