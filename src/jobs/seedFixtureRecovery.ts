/**
 * Recovery guard for deterministic seed fixtures keyed by a fixed ID.
 *
 * The demo seeder writes showcase rows with stable IDs so later fixtures
 * (cart lines, order lines) can reference them. Two failure modes matter:
 *
 *   1. A row already exists at the expected ID but no longer matches the
 *      fixture. Reusing it silently would make the seeded dataset disagree
 *      with its own hard-coded snapshots.
 *   2. Two writers both observe "no row" and both insert. The database
 *      rejects the loser with P2002. Simply failing leaves a partial seed;
 *      blindly retrying or upserting can overwrite or duplicate data.
 *
 * This helper keeps the additive posture: it never updates or deletes. It
 * re-reads after a confirmed P2002 and only reuses a row that matches the
 * intended fixture exactly. A different-ID row is never assumed to be
 * interchangeable, because downstream fixtures depend on the fixed ID.
 *
 * Only P2002 is handled. Every other error (including P2003 foreign-key
 * failures) propagates unchanged. A failure during the recovery re-read also
 * propagates unchanged; it is never converted into a duplicate conflict.
 */
import { isUniqueConstraintConflict } from "../services/optionGroupNameRules";

export interface SeedFixtureRecoveryOptions<T extends object> {
  /** Human-readable model name, e.g. "OptionGroup". */
  fixture: string;
  /** The fixed fixture ID the downstream seed data references. */
  id: string;
  /** Fields that define the fixture. Only these are compared. */
  expected: Record<string, unknown>;
  /** Read the row by the fixed ID. */
  findById: () => Promise<T | null>;
  /** Create the row. Called only when no row exists at the fixed ID. */
  create: () => Promise<T>;
}

export class SeedFixtureMismatchError extends Error {
  public readonly fixture: string;
  public readonly fixtureId: string;
  public readonly mismatchedFields: string[];

  constructor(
    fixture: string,
    fixtureId: string,
    mismatchedFields: string[],
    details: string[],
  ) {
    super(
      `Seed fixture drift for ${fixture} "${fixtureId}": ${details.join("; ")}. ` +
        "Refusing to reuse or overwrite a drifted fixture; inspect and clean the conflicting demo row before rerunning.",
    );
    this.name = "SeedFixtureMismatchError";
    this.fixture = fixture;
    this.fixtureId = fixtureId;
    this.mismatchedFields = mismatchedFields;
  }
}

export class SeedFixtureIdentityConflictError extends Error {
  public readonly fixture: string;
  public readonly fixtureId: string;

  constructor(fixture: string, fixtureId: string) {
    super(
      `Seed fixture identity conflict for ${fixture} "${fixtureId}": the insert was rejected by a unique ` +
        "constraint, but no row exists at the expected id. A different row may own the same normalized name, " +
        "and downstream showcase fixtures depend on this fixed id. Refusing to guess; inspect and clean the " +
        "conflicting row before rerunning.",
    );
    this.name = "SeedFixtureIdentityConflictError";
    this.fixture = fixture;
    this.fixtureId = fixtureId;
  }
}

function formatValue(value: unknown): string {
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}

function collectMismatches(
  actual: object,
  expected: Record<string, unknown>,
): { fields: string[]; details: string[] } {
  const row = actual as Record<string, unknown>;
  const fields: string[] = [];
  const details: string[] = [];

  for (const [field, expectedValue] of Object.entries(expected)) {
    const actualValue = row[field];
    if (!Object.is(actualValue, expectedValue)) {
      fields.push(field);
      details.push(
        `${field}: expected ${formatValue(expectedValue)}, found ${formatValue(actualValue)}`,
      );
    }
  }

  return { fields, details };
}

function assertFixtureMatches<T extends object>(
  fixture: string,
  id: string,
  row: T,
  expected: Record<string, unknown>,
): T {
  const { fields, details } = collectMismatches(row, expected);
  if (fields.length > 0) {
    throw new SeedFixtureMismatchError(fixture, id, fields, details);
  }
  return row;
}

/**
 * Return the row at `options.id` if it exists and matches, otherwise create it.
 *
 * On a confirmed P2002:
 *   - re-read by the fixed ID;
 *   - reuse the row only if it matches;
 *   - throw SeedFixtureMismatchError if it drifted;
 *   - throw SeedFixtureIdentityConflictError if no row exists at that ID.
 *
 * A re-read failure propagates as-is, so a read error is never misreported as
 * a duplicate conflict.
 */
export async function ensureSeedFixture<T extends object>(
  options: SeedFixtureRecoveryOptions<T>,
): Promise<T> {
  const { fixture, id, expected, findById, create } = options;

  const existing = await findById();
  if (existing) {
    return assertFixtureMatches(fixture, id, existing, expected);
  }

  try {
    return await create();
  } catch (error) {
    if (!isUniqueConstraintConflict(error)) {
      throw error;
    }

    // Deliberately outside another try/catch: if this read fails, its error
    // propagates unchanged and is not disguised as the original P2002.
    const raced = await findById();
    if (raced) {
      return assertFixtureMatches(fixture, id, raced, expected);
    }

    throw new SeedFixtureIdentityConflictError(fixture, id);
  }
}
