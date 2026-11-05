/**
 * Phase 2B.2 (review follow-up, F-4 + F-5) — testable runner orchestration.
 *
 * WHY THIS IS SEPARATE FROM `scripts/migrate-product-options.ts`
 * -----------------------------------------------------------
 * The script is the thin executable shell. Everything that decides *whether a
 * database client may exist at all* lives here as a pure, injectable function so
 * it can be unit-tested without importing `src/lib/prisma.ts` (which constructs
 * a `PrismaClient` at module scope, line 9).
 *
 * The ordering guarantee is now structural rather than editorial:
 *
 *     1. verify target                       (no I/O)
 *     2. load .env the way Prisma will       (no connection)
 *     3. RE-verify target against the        <- proves precedence (F-5)
 *        post-dotenv environment
 *     4. verify write authorization          (no I/O)
 *     5. load the Prisma client              <- FIRST possible client
 *
 * `loadPrisma` is invoked only after steps 1-4 all succeed, and only once. A
 * refused run therefore cannot construct a client, which is exactly what review
 * finding F-4 flagged in the previous `finally`-based implementation.
 *
 * F-5 — why re-verify rather than trust precedence
 * -------------------------------------------------
 * `tests/scripts/verifyMigrationTarget.ts` established (step 5, lines 86-99)
 * that dotenv does NOT override an already-exported `DATABASE_URL`. Relying on
 * that as an unstated assumption was the gap F-5 identified. Instead of assuming
 * it, we reproduce Prisma's own env-loading step and then run the FULL guard
 * again against the resulting environment. If `.env` ever did win — or if it
 * changes anything the guard cares about — the second check fails and the run is
 * refused before any client exists. This is stronger than the original script:
 * it re-validates host, port, database name, loopback and deny-list, not just
 * one variable.
 *
 * No connection is opened and no `.env` content is printed or logged.
 */
import {
  checkMigrationTarget,
  readMigrationTargetConfig,
  isMigrationWriteOptedIn,
  MIGRATION_OPT_IN_ENV,
  MIGRATION_OPT_IN_VALUE,
} from "./migrationTargetGuard";
import {
  preflightProductOptionMigration,
  migrateProductOptions,
  hasUnresolvedConflicts,
  MIGRATION_GROUP_NAME,
  LEGACY_MIGRATION_GROUP_NAME,
  type MigrationDb,
} from "./productOptionMigration";

export interface MigrationDbHandle extends MigrationDb {
  $disconnect?(): Promise<void>;
}

export interface RunnerDeps {
  env: Record<string, string | undefined>;
  apply: boolean;
  /** Produces the database client. Called at most once, only after all guards. */
  loadPrisma: () => Promise<MigrationDbHandle>;
  /**
   * Loads `.env` into `env` exactly as the Prisma engine does. Optional so
   * tests can inject a no-op and assert the precedence re-check still runs.
   */
  loadDotenv?: (env: Record<string, string | undefined>) => void;
  log?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
}

export interface RunnerResult {
  exitCode: 0 | 1;
  /** True when a Prisma client was actually constructed. */
  clientInitialized: boolean;
  /** Short machine-readable outcome, useful for tests and operator logs. */
  outcome:
    | "REFUSED_TARGET"
    | "REFUSED_ENV_PRECEDENCE"
    | "REFUSED_NOT_AUTHORIZED"
    | "REFUSED_INTEGRITY"
    | "CLIENT_INIT_FAILED"
    | "DRY_RUN"
    | "DRY_RUN_WITH_CONFLICTS"
    | "APPLIED"
    | "APPLIED_WITH_CONFLICTS";
  conflicts?: number;
}

export async function runProductOptionMigration(deps: RunnerDeps): Promise<RunnerResult> {
  const log = deps.log ?? ((m: string) => console.log(m));
  const warn = deps.warn ?? ((m: string) => console.warn(m));
  const error = deps.error ?? ((m: string) => console.error(m));

  // ── 1. Verify the target ────────────────────────────────────────────────
  const target = checkMigrationTarget(readMigrationTargetConfig(deps.env));
  if (!target.ok) {
    error(`STOP: database target not verified — ${target.message}`);
    error("No connection was opened; nothing was read or written.");
    return { exitCode: 1, clientInitialized: false, outcome: "REFUSED_TARGET" };
  }

  // ── 2. Reproduce Prisma's env loading ──────────────────────────────────
  // Prisma resolves its datasource from DATABASE_URL after dotenv populates
  // process.env. Doing the same here means step 3 inspects the environment the
  // client will actually see, rather than the one the shell happened to have.
  deps.loadDotenv?.(deps.env);

  // ── 3. Re-verify against the post-dotenv environment (F-5) ─────────────
  const recheck = checkMigrationTarget(readMigrationTargetConfig(deps.env));
  if (!recheck.ok) {
    error(
      "STOP: database target changed after environment loading — " +
        "the .env file would override the authorised target. Refusing to run.",
    );
    error("No connection was opened; nothing was read or written.");
    return { exitCode: 1, clientInitialized: false, outcome: "REFUSED_ENV_PRECEDENCE" };
  }
  log(`Target verified: loopback ${recheck.host}:${recheck.port}`);

  // ── 4. Explicit authorization for writes ───────────────────────────────
  if (deps.apply && !isMigrationWriteOptedIn(deps.env)) {
    error("STOP: --apply requires explicit opt-in.");
    error(`Set ${MIGRATION_OPT_IN_ENV}=${MIGRATION_OPT_IN_VALUE} for this run only.`);
    return { exitCode: 1, clientInitialized: false, outcome: "REFUSED_NOT_AUTHORIZED" };
  }

  // ── 5. First point at which a database client may exist ────────────────
  let prisma: MigrationDbHandle;
  try {
    prisma = await deps.loadPrisma();
  } catch {
    // Review follow-up B-2. NEVER print the raw error here.
    //
    // Prisma initialization failures routinely embed the datasource URL, and a
    // URL embeds credentials — `P1000` alone quotes the database user. The
    // runner's console is the one place in this codebase that prints raw
    // driver text, so it must not be given unfiltered messages at all.
    //
    // The caller still learns what happened (a fixed, non-sensitive sentence
    // plus the distinct `CLIENT_INIT_FAILED` outcome, which separates "the
    // target was refused" from "the client could not be built"). Debugging
    // detail belongs in an environment the operator controls, not on stdout of a
    // script that may be run in CI.
    error("STOP: the migration runner could not initialise its database client.");
    error("No connection was opened; nothing was read or written.");
    return { exitCode: 1, clientInitialized: false, outcome: "CLIENT_INIT_FAILED" };
  }

  try {
    log(`=== ProductOption → ${MIGRATION_GROUP_NAME} preflight ===`);
    const pre = await preflightProductOptionMigration(prisma);
    log(JSON.stringify(pre, null, 2));

    if (pre.orphanOptions > 0 || pre.duplicateNames > 0) {
      error("STOP: integrity problems found — refusing to migrate.");
      return { exitCode: 1, clientInitialized: true, outcome: "REFUSED_INTEGRITY" };
    }
    if (pre.legacyNamedGroups > 0) {
      warn(
        `WARNING: ${pre.legacyNamedGroups} group(s) still named "${LEGACY_MIGRATION_GROUP_NAME}" from an earlier run. ` +
          "Affected products will be reported as conflicts and left untouched; rename or merge them, then rerun.",
      );
    }

    if (!deps.apply) {
      log("DRY RUN — no writes. Re-run with --apply to execute.");
      const preview = await migrateProductOptions(prisma, { dryRun: true });
      log(JSON.stringify(preview, null, 2));

      // The preview is read-only, but it is also the operator's pre-flight
      // gate. A preview that already contains unresolved conflicts must not
      // exit 0: the same conflicts would block a subsequent --apply run, which
      // reports APPLIED_WITH_CONFLICTS and exits 1.
      //
      // Decide from the conflict list itself — never from the product counters.
      // `productsMigrated` counts a partially-migrated product as migrated, so
      // it cannot answer "is this run clean?".
      if (hasUnresolvedConflicts(preview)) {
        error(
          `${preview.conflicts.length} unresolved conflict(s) found in the dry-run preview. ` +
            "Re-running with --apply would leave the affected products unresolved. " +
            "Resolve the conflicts above manually, then rerun the dry run.",
        );
        return {
          exitCode: 1,
          clientInitialized: true,
          outcome: "DRY_RUN_WITH_CONFLICTS",
          conflicts: preview.conflicts.length,
        };
      }
      return { exitCode: 0, clientInitialized: true, outcome: "DRY_RUN" };
    }

    log("=== executing migration (per-product transactions) ===");
    const result = await migrateProductOptions(prisma);
    log(JSON.stringify(result, null, 2));

    const post = await preflightProductOptionMigration(prisma);
    log("=== post-migration preflight ===");
    log(JSON.stringify(post, null, 2));

    if (hasUnresolvedConflicts(result)) {
      error(
        `${result.conflicts.length} unresolved conflict(s) recorded. The migration is additive-only: ` +
          "products that succeeded stay committed, and the failed products rolled back cleanly. " +
          "Resolve the conflicts above manually, then rerun — a rerun reuses compatible groups and " +
          "never duplicates items.",
      );
      return {
        exitCode: 1,
        clientInitialized: true,
        outcome: "APPLIED_WITH_CONFLICTS",
        conflicts: result.conflicts.length,
      };
    }
    return { exitCode: 0, clientInitialized: true, outcome: "APPLIED" };
  } finally {
    // Cleanup only for a client we actually created. No connection is opened
    // just to disconnect, and a disconnect failure must not mask the result.
    await prisma.$disconnect?.().catch(() => undefined);
  }
}