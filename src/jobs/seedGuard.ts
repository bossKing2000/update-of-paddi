/**
 * Seeder opt-in guard (F4-5 seeder-reliability work).
 *
 * Every seeder in this repository writes to a real PostgreSQL database. The
 * configured `DATABASE_URL` is a single, shared, long-lived instance, and
 * `src/jobs/seed.ts` carries a comment block (lines 23-29) documenting
 * `prisma db push --force-reset` / `prisma migrate reset`. Nothing in the
 * seeder previously confirmed an operator actually intended to run it, so a
 * stray `npm run db:seed` or a copy-pasted reset line would write to whatever
 * database happened to be configured.
 *
 * This guard makes that intent explicit and machine-checked. It is deliberately
 * NOT satisfied by anything that merely *looks* like a non-production target:
 * a development-looking host name, a localhost `SERVER_URL`, test-mode payment
 * credentials, or `NODE_ENV`. Those are observations about configuration, not
 * evidence that a human authorised a write to a database holding real rider,
 * order and wallet records.
 *
 * Contract:
 *   - Seeders write only when `SEED_ALLOW=yes`.
 *   - The check performs no database access and prints no environment values,
 *     connection strings, credentials or tokens.
 *   - It throws, so each entry point's existing error handling decides the exit
 *     code (`process.exit(1)` in `prisma/seed.ts`, `process.exitCode = 1` in
 *     `src/jobs/seed.ts`).
 */

/** The only accepted opt-in value. Case-sensitive on purpose. */
export const SEED_OPT_IN_VALUE = "yes";

/** The environment variable an operator must set. */
export const SEED_OPT_IN_ENV = "SEED_ALLOW";

/** Files that are guarded entry points, for error messages and documentation. */
export type SeedEntrypoint = "prisma/seed.ts" | "src/jobs/seed.ts" | "src/jobs/seedFinancialFixtures.ts";

export class SeedNotAllowedError extends Error {
  readonly entrypoint: string;
  constructor(entrypoint: string) {
    super(
      [
        `Refusing to seed: ${entrypoint} writes to the configured database and requires explicit opt-in.`,
        `Set ${SEED_OPT_IN_ENV}=${SEED_OPT_IN_VALUE} in the environment for this run only.`,
        "This guard is not satisfied by a development-looking host, a localhost SERVER_URL,",
        "test-mode payment credentials, or NODE_ENV — it is an explicit human decision to write.",
        "WARNING: SEED_ALLOW authorises the SEEDER to write. It does NOT make the target safe, and it",
        "does NOT undo anything destructive that already ran. `prisma migrate reset` and",
        "`prisma db push --force-reset` DROP AND RECREATE the schema BEFORE the seed command is ever",
        "invoked, so the guard cannot prevent that. Verify the target database yourself first.",
      ].join(" "),
    );
    this.name = "SeedNotAllowedError";
    this.entrypoint = entrypoint;
  }
}

/**
 * Throws unless the operator has explicitly opted in.
 *
 * Called before the first database write in every seeder. Reads only the
 * presence of the opt-in variable — never its neighbours — so it cannot leak a
 * secret through an error message.
 */
export function assertSeedAllowed(entrypoint: SeedEntrypoint): void {
  const provided = process.env[SEED_OPT_IN_ENV];
  if (provided === SEED_OPT_IN_VALUE) return;
  throw new SeedNotAllowedError(entrypoint);
}

/** Non-throwing form, for tests and for callers that want to branch. */
export function isSeedAllowed(): boolean {
  return process.env[SEED_OPT_IN_ENV] === SEED_OPT_IN_VALUE;
}