# Tests

Two separate suites with two separate commands. They must never be run as one
combined invocation.

| Suite | Command | Requires a database? |
| --- | --- | --- |
| Unit (85 suites) | `npm test` | No |
| Integration (13 suites) | `npm run test:integration` | **Yes — a disposable test database** |

## Why the split exists

`prisma/schema.prisma` declares:

```prisma
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}
```

Every suite in `tests/integration` constructs `new PrismaClient()` **with no
datasource override**, and several transitively import `src/config/config.ts`,
which calls `dotenv.config()` and loads the application's `.env` into
`process.env`.

Before this split, `npm test` was `jest --runInBand` with
`testMatch: ["<rootDir>/tests/**/*.test.ts"]` — so a single `npm test` would
load **all 13 destructive integration suites** against whatever database
`.env` named, which may be the shared application database. Those suites issue
`deleteMany` across `Order`, `OrderItem`, `Payment`, `Product`, `User` and
`CartItemOption`, and create vendor rows.

`deliveryCapacityF5.test.ts` was one such suite that sat in `tests/unit`
despite constructing a real `PrismaClient` and performing unmocked writes. It
was relocated to `tests/integration` so the preflight guards it. Its
`../../src/...` imports needed no change — `tests/unit` and
`tests/integration` are at the same directory depth.

## Selection behaviour

Both configs use a **positive** `testMatch`, not an exclusion:

- `jest.unit.config.js` → `tests/unit/**/*.test.ts`
- `jest.integration.config.js` → `tests/integration/**/*.test.ts`

This is deliberate. An ignore-based split fails open: any new directory is
swept into the unit run. A `testMatch` cannot do that.

All three configs keep `testPathIgnorePatterns: ["/node_modules/", "/dist/"]`
explicitly. This matters because **a CLI `--testPathIgnorePatterns` flag
replaces the config array rather than merging into it**, so the entries must
live in the config file to survive a future CLI override.

All three set `passWithNoTests: false`, so a path typo fails loudly instead of
reporting success having run zero suites.

## Safety of accidental or bare Jest invocation

`jest.config.js` is the config Jest **auto-discovers**. It is safe by two
independent mechanisms: its `testMatch` is `tests/unit/**/*.test.ts`, and it
attaches `tests/setup/defaultConfigGuard.ts` as `globalSetup`.

| Invocation | Result |
| --- | --- |
| `npm test` | 85 unit suites, no database |
| `npm run test:integration` | 13 integration suites, behind the full gate |
| `npx jest` (bare) | 85 unit suites — integration unreachable |
| `npx jest --config jest.config.js` | 85 unit suites — integration unreachable |
| `npx jest tests/integration/<file>` | **exit 1**, "No tests found" |
| `npx jest --testMatch '**/tests/integration/**'` | **exit 1** — refused by the guard |
| `npx ts-node tests/integration/<file>` | **NOT PROTECTED** — see limitations |

The `--testMatch` row matters: because `testMatch` is CLI-overridable, a
`testMatch` alone is not a boundary. The guard runs in the parent process
before any worker starts, so it refuses before a suite module is loaded:

```
[default-config-guard] Refusing to run: --testmatch **/tests/integration/**/*.test.ts
could select database-backed integration suites, but this configuration has no
integration preflight and no worker pin.
```

The guard fails closed on ambiguity: if it cannot prove the selection stays
inside `tests/unit`, it refuses.

### The two test-gate guards, and what they do NOT protect against

The base config attaches **two** guards in **different hooks**:

| Hook | Module | Runs |
| --- | --- | --- |
| `globalSetup` | `tests/setup/defaultConfigGuard.ts` | parent process, once |
| `setupFiles` | `tests/setup/baseSetupGuard.ts` | every worker, before each test module |

That matters because a CLI `--globalSetup <path>` **replaces** `globalSetup`
outright. With only the parent guard, that single flag removed the whole gate.
Now the worker guard survives it, so reaching the integration suites requires
overriding **both** hooks.

Verified with a DB-free suite:

```
npx jest --runInBand -t integration <db-free-suite> --globalSetup ./noop.cjs
  custom globalSetup executed   <- parent guard replaced
  [base-setup-guard] Refusing…  <- worker guard still refuses
  Tests: 0 total
```

Both `--globalSetup <path>` and `--globalSetup=<path>` were checked. Integration
suites were never executed to prove this.

**Not claimed as protected** — these bypass Jest's protections entirely:

- `--setupFiles <path>` — replaces the worker guard too. Overriding
  `globalSetup` **and** `setupFiles` together defeats both gates.
- a tracked config edited to drop `globalSetup` / `setupFiles`
- `--config <path>` outside the three recognised configs
- `node` / `npx ts-node` execution of a suite, which bypasses Jest
- any future Jest mechanism that selects tests from a source not inspected here

No Jest hook is un-overridable. Closing this properly needs an **execution
boundary outside Jest** — a wrapper binary, a container, or a separate process
that owns the test run — not a third hook.

Note: `--listTests` is **discovery, not execution**. It runs neither
`globalSetup` nor `setupFiles`, so `--listTests --testMatch '**/tests/integration/**'`
will still print the 13 files. That enumerates paths and loads nothing. Verify
with a real run.

## The integration database gate

Two parts, both required, and they protect different things.

### 1. `globalSetup` → `tests/setup/integrationPreflight.ts`

Runs once in the **parent** process, before any worker starts. If it throws,
Jest exits non-zero and **no worker is ever spawned** — so no suite module, no
`beforeAll`, no destructive hook. It fails closed on:

1. `TEST_DATABASE_URL` unset, unparseable, or missing a password.
2. `TEST_DATABASE_URL` resolving to the same **host + database name** as an
   ambient `DATABASE_URL`. Identity is compared as a pair, so differing
   credentials, ports or query parameters cannot disguise the same target.
3. **`TEST_DATABASE_DENIED_HOSTS` is MANDATORY.** Unset, empty, or
   whitespace-only is a hard refusal. A missing deny policy is never converted
   into an empty denylist — an absent policy is not consent. Each entry must be
   a bare hostname (no scheme, port or path).
4. **Loopback only.** The host must be `localhost`, any `127.0.0.0/8` address,
   or IPv6 `::1`. This is deliberately stricter than the allowlists: adding an
   arbitrary remote host to `TEST_DATABASE_ALLOWED_HOSTS` still cannot enable
   it, so allowlisting a remote target is not a way to reach one.
5. **Explicit port.** `TEST_DATABASE_URL` must state a port; the default is
   never assumed. The value must be in range 1–65535. The documented local
   setup uses **55432**. The server's own `inet_server_port()` must then
   match, so a URL naming one port cannot land on another.
6. **No query parameters.** A connection string must be a plain
   `host:port/database` URL. Parameters such as `socket_path` or `options` can
   change the transport or redirect the connection, and are interpreted by
   Prisma's native engine where they cannot be verified. All of them are
   refused rather than inspected. A trailing `?` with no parameters is
   harmless and accepted.
7. Host not in `TEST_DATABASE_ALLOWED_HOSTS`.
8. Database name not in `TEST_DATABASE_ALLOWED_NAMES`. Exact names are
   supported, plus an `endswith:` prefix for randomly generated names.
9. Database name matching an application pattern (`prod`, `production`, `live`,
   `main`, `staging`, `shared`, `app`) — rejected **even if allowlisted**, so a
   permissive allowlist cannot authorise a shared database.
10. Host present in `TEST_DATABASE_DENIED_HOSTS`, **or** equal to the host of
    any ambient `DATABASE_URL`. The denied set is derived at runtime, so no
    hostname is hardcoded and no credential is read to build it.
11. **Live identity**, all three compared without exception:
    - `current_database()` must equal the database in the URL. A missing or
      empty reported name refuses.
    - `inet_server_port()` must equal the URL port. A missing or non-numeric
      reported port refuses — the check is never skipped.
    - The reported address must match the URL host, or be a different loopback
      address (URL `localhost` reporting `127.0.0.1`, or vice versa). A
      **missing or empty** reported address refuses. Verification is **not**
      skipped merely because the URL says `localhost`.
12. Any table declared in `schema.prisma` missing — a partially migrated
    database would make `deleteMany` silently affect zero rows and suites would
    report false green results.

Checks 1–10 run **before any connection is opened**, so a disallowed target is
never contacted. The preflight performs read-only catalog queries only and
never prints a password, a full connection URL, or any credential — the log
line shows `user@host:port/database` only.

**Hostname normalisation.** Hosts are lowercased and stripped of trailing dots
before any comparison, so `EXAMPLE.COM.` and `example.com` cannot disagree.
IPv6 literals are unwrapped from the brackets `URL.hostname` adds, so writing
`::1` in an allowlist matches a URL containing `[::1]`. A *denylist entry* with
a trailing dot is rejected as malformed rather than silently normalised —
fail-closed, and it points the operator at a typo.

### 2. `setupFiles` → `tests/setup/pinTestDatabaseUrl.ts`

This is the part that makes the validation meaningful to the **test processes
themselves**.

`globalSetup` runs in the parent process, and assigning `process.env` there is
not a reliable way to reach workers — they are separate processes. Meanwhile
every integration suite constructs a bare `new PrismaClient()`, which resolves
`env("DATABASE_URL")` per `schema.prisma`. Left alone, the preflight would
validate one database while the tests connected to another.

Jest runs `setupFiles` **inside each worker, before the test module is
required**. Verified against Jest 30's source:

| Stage | Location |
| --- | --- |
| `globalSetup` | parent process |
| `setupFiles` | `jest-runner/build/index.js:217` |
| `setupFilesAfterEnv` | `jest-circus/build/runner.js:80` |
| **test module require** | `jest-circus/build/runner.js:94` |
| `beforeAll` / destructive hooks | after the above |

The pin re-runs the purely local checks (1–6 above) in the worker, then sets
`process.env.DATABASE_URL = TEST_DATABASE_URL`. So the clients the suites
construct resolve to exactly the database that passed validation, rather than
to ambient config. It is authoritative against `src/config/config.ts`'s
`dotenv.config()`: dotenv 17 defaults `override` to false, so it will not
overwrite an already-populated variable, and the pin runs before the test
module imports `config.ts`.

If `TEST_DATABASE_URL` is missing or disallowed, the pin throws — the suites
fail closed rather than falling back to `DATABASE_URL`.

### Shared-database protection, and its limits

No hostname is hardcoded anywhere, and none is invented. The shared database is
excluded by rules that do not depend on knowing its address:

1. **Loopback-only.** Any remote target is refused outright, whatever the
   allowlists say. Because the intended integration setup is a disposable local
   PostgreSQL instance, a shared remote database can never be selected — the
   question of "is this host safe?" is not asked, because no remote host is
   admissible.
2. **Mandatory deny policy.** `TEST_DATABASE_DENIED_HOSTS` must be configured;
   an absent policy refuses rather than defaulting to "deny nothing".
3. **Application-name pattern** on the database name, applied even when
   allowlisted.
4. **Ambient-host derivation.** When `DATABASE_URL` is exported, its host is
   added to the deny set at runtime.

**Limitation to state plainly:** the gate proves the target is loopback and
matches the configured policy. It does **not** prove that an unknown remote
hostname would be safe — because no remote hostname can be configured in the
first place. If the shared database were ever mirrored onto `localhost`, these
checks would not detect it; only the mandatory deny list and the application
name pattern would apply.

**This repository currently has no CI configuration** (no `.github/workflows`,
no pipeline YAML). CI enforcement of the gate is therefore **unverified** — the
rules are enforced by whichever shell exports the variables, and nothing in
this repo pins them. When CI is added, `TEST_DATABASE_DENIED_HOSTS` must be set
there explicitly rather than relying on ambient variables being present.

### Remaining limitations

- `node` or `npx ts-node` execution of an integration suite **bypasses Jest's
  protections entirely** — neither `globalSetup` nor `setupFiles` loads. This
  path is unprotected. Do not run integration suites that way.
- Any suite constructing its own `PrismaClient` with an explicit
  `datasource.url` override would ignore the pin. None currently do — all 13
  use a bare `new PrismaClient()`.
- Jest cannot intercept direct `node`/`ts-node` execution of application code.
    The gate is a Jest-level control.
- The worker pin does not connect, so it cannot repeat the preflight's live
    identity and schema verification. It trusts the configuration string the
    preflight already validated. Query-string rules are duplicated in both
    layers so neither can drift.
- A unix-domain-socket connection reports a NULL `inet_server_addr()`, which
    the live host check now refuses rather than tolerating. That transport is
    unreachable here anyway because query parameters are refused, so a refusal
    means the server could not report its address at all.
- `REQUIRED_TABLES` in the gate is verified against `prisma/schema.prisma` on
    every run, so a table removed from the schema cannot silently make every
    integration run refuse with a misleading "not migrated" message.

## Validating vs provisioning — these are different things

**Validating** a test database is what the gate does automatically on every
`npm run test:integration`: it inspects configuration, allowlists, identity and
schema, and aborts if anything is wrong. It never creates, migrates, resets,
seeds or modifies anything. This has happened.

**Provisioning** — starting an instance, creating a database, or applying
migrations — is **manual, has not been performed, and requires separate
explicit approval**. Approval to run the gate is not approval to provision or
migrate anything.

The intended procedure, once approved:

1. Start a **local ephemeral** PostgreSQL instance (container or local daemon)
   on a non-default port with a throwaway superuser. No shared credentials.
2. Create a uniquely named database, e.g. `foodpaddi_test_<random>`.
   Randomness defeats accidental reuse of a stale schema.
3. Export the connection URL as `TEST_DATABASE_URL` — **not** as
   `DATABASE_URL`. Keep the application's `.env` untouched.
4. Set the configuration. All four variables are required — the gate refuses to
   run without them:
   ```bash
   export TEST_DATABASE_URL='postgresql://TESTUSER:TESTPASS@127.0.0.1:55432/foodpaddi_test_ab12cd'
   export TEST_DATABASE_ALLOWED_HOSTS='localhost,127.0.0.1'
   export TEST_DATABASE_ALLOWED_NAMES='endswith:_test_ab12cd'
export TEST_DATABASE_DENIED_HOSTS='<application-db-host>'
     ```
     Port **55432** is the documented non-default local port and is validated
     like any other. The pin rewrites `process.env.DATABASE_URL` inside each
     worker, so `DATABASE_URL` does not need to be exported and should never
     point at the test database.

     **Supplying the denylist value.** `TEST_DATABASE_DENIED_HOSTS` must be a
     bare hostname — no scheme, port, or path — and it is mandatory: unset,
     empty, whitespace-only, or malformed all refuse rather than degrade to an
     empty denylist. To obtain the hostname without revealing credentials, read
     only the host portion of the connection string, for example:

     ```bash
     # Prints a bare hostname and nothing else — no user, password or path.
     node -e "console.log(new URL(process.env.DATABASE_URL).hostname)"
     ```

     Do not paste the full URL, the credentials, or `.env` contents into the
     variable, a ticket, or CI logs. If the shared host is not yet known, leave
     the run unprovisioned rather than guessing a hostname.
5. Apply migrations with **`npx prisma migrate deploy`**. Never
   `prisma migrate db push` — `db push` rewrites the migration chain and would
   invalidate `tests/unit/migrationChainIntegrity.test.ts` (26 cases).
6. Run `npm run test:integration`.
7. Tear down the instance and drop the database. Disposable by construction:
   destroying it loses nothing.

Never point `TEST_DATABASE_URL` at staging or production. The preflight will
refuse, but the intent should be to never set it at all.

## Targeting migrations at the test database (not yet executed)

`prisma/schema.prisma` declares `url = env("DATABASE_URL")`, and the repository
`.env` also declares `DATABASE_URL`. `prisma migrate deploy` would therefore
resolve the target from whichever comes first — and migrating against the
application database would be a serious, hard-to-reverse mistake.

**Precedence is favourable, and verified.** The Prisma 6.19.2 CLI calls
`dotenv.config({path, debug})` with **no `override` option**
(`node_modules/prisma/build/index.js`). dotenv's default is `override: false`,
so **an explicitly exported `DATABASE_URL` wins over `.env`**. Confirmed
empirically with dotenv 17.3.1: with both present, the environment value
survives.

That makes an inline override sufficient — `unset DATABASE_URL` is *not*
required and is not relied upon:

```bash
DATABASE_URL="$TEST_DATABASE_URL" npx prisma migrate deploy
```

**Always use `prisma migrate deploy`, never `prisma db push`.** `db push`
rewrites the migration chain that `tests/unit/migrationChainIntegrity.test.ts`
validates.

### Verify the target independently first

`tests/scripts/verifyMigrationTarget.ts` checks the resolved target **without
connecting to anything** — no Prisma process, no socket, no credential output:

```bash
DATABASE_URL="$TEST_DATABASE_URL" npx ts-node --compiler-options \
  '{"module":"commonjs","esModuleInterop":true,"skipLibCheck":true}' \
  tests/scripts/verifyMigrationTarget.ts
```

It exits 0 only if all of these hold: an explicit `DATABASE_URL` is present; it
matches `TEST_DATABASE_URL` host:port; the target is loopback; the port is
explicit; loading `.env` does **not** change `DATABASE_URL`; and
`TEST_DATABASE_DENIED_HOSTS` is still set. It is deliberately not wired into any
npm script — it is opt-in and has not been run against a live database.

It cannot prove Prisma will connect to that target; it only proves the target
Prisma is configured to use is the disposable local one.

## Recording a baseline

A failing baseline is a valid baseline. Record what **is**, never what should
be. Never report a suite as passing without an observed result.

Run and record the two commands **separately** — never merged into one number:

```bash
npm test
npm run test:integration
```

Per command, capture:

- Suites discovered (`npx jest --config <config> --listTests | wc -l`).
- Cases per suite, and the executed case count.
- Passed / failed / skipped.
- **Environment-blocked** — the suite never ran its assertions (preflight
  aborted, no database). This is *not* a failure.
- Node, Prisma and Jest versions.
- The source revision (`git rev-parse HEAD` — read-only).
- The exact commands used.

Classify per suite:

| Result | Meaning |
| --- | --- |
| Failure | Suite ran and an assertion or error failed. A code defect. |
| Environment-blocked | Suite never executed. Says nothing about code. |
| Skipped | Explicitly skipped. |

**Do not invent results.** If only `--listTests` was run, the honest status of
every suite is "discovered, not executed".

## Adding a suite

Put database-dependent tests in `tests/integration` and DB-free tests in
`tests/unit`. The `testMatch` globs pick them up automatically; no config edit
is needed. A new top-level directory such as `tests/e2e` will be selected by
**neither** config — add an explicit `testMatch` entry if that is intended.