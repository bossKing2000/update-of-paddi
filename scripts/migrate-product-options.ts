/**
 * Phase 2B.2 one-time data migration runner (NOT seed data — run once).
 *
 * Copies legacy ProductOption rows into OptionGroup ("Extras") /
 * OptionGroupItem rows. Legacy rows, carts, orders and snapshots are
 * never written. Idempotent: safe to re-run.
 *
 * This file is a THIN SHELL. All ordering, guard and authorization logic lives
 * in `src/services/productMigrationRunner.ts` so it can be unit-tested without
 * constructing a real Prisma client. In particular:
 *
 *   - The database client is imported LAZILY, inside `loadPrisma`, and that
 *     callback is only ever invoked after the target guard, the environment
 *     precedence re-check, and the write opt-in have all passed. A refused run
 *     therefore never constructs a client (review finding F-4).
 *   - The client is disconnected only if it was actually created.
 *
 * Usage:
 *   npx ts-node scripts/migrate-product-options.ts                      # preflight + dry run
 *   npx ts-node scripts/migrate-product-options.ts --apply              # execute migration
 */
import { runProductOptionMigration } from "../src/services/productMigrationRunner";

const APPLY = process.argv.includes("--apply");

async function main(): Promise<void> {
  const result = await runProductOptionMigration({
    env: process.env,
    apply: APPLY,
    // Reproduces Prisma's own env resolution so the runner re-verifies the
    // target the client will actually use (review finding F-5). Quiet so no
    // .env content is ever printed.
    loadDotenv: (env) => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const dotenv = require("dotenv") as { config: (o: { path: string; quiet?: boolean }) => unknown };
      dotenv.config({ path: require("path").resolve(__dirname, "..", ".env"), quiet: true });
      void env;
    },
    loadPrisma: async () => {
      const { default: prisma } = await import("../src/lib/prisma");
      return prisma;
    },
  });

  if (result.exitCode !== 0) process.exitCode = result.exitCode;
}

main().catch(() => {
  // Review follow-up B-2. Sanitizing the runner is not sufficient on its own:
  // anything thrown OUTSIDE `runProductOptionMigration` — a module-resolution
  // failure, an error raised while importing the Prisma client, or an error
  // escaping preflight/migrate — lands here instead. Prisma errors can embed
  // the datasource URL, and a URL embeds credentials, so this catch prints a
  // fixed message and never the error, its message, or its stack.
  console.error(
    "migration runner failed unexpectedly; no database writes were performed by this process.",
  );
  process.exitCode = 1;
});