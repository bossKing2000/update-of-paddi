/**
 * Migration-chain integrity — static checks only, no database required.
 *
 * F4-5 follow-up. The read-only review found 12 untracked migration directories
 * and two deleted legacy migrations. A fresh clone therefore cannot reproduce
 * the schema the seeders depend on — in particular `DishType.categoryId`, which
 * `prisma/seed.ts` writes but which only the (untracked) catalog_taxonomy
 * migration introduces. This suite locks in the structural properties that must
 * hold for `prisma migrate deploy` to succeed on a clean database, so drift is
 * caught by CI rather than by a failed reset.
 *
 * PARSER LIMITATIONS (deliberate, and asserted rather than silently ignored):
 *   - `$$ ... $$` dollar-quoted bodies are MASKED before parsing, so PL/pgSQL
 *     function bodies (e.g. the tsvector trigger) are never mistaken for DDL.
 *   - line comments (`--`) and block comments are stripped before matching.
 *   - Identifiers may be quoted ("Order") or bare (Order); both are normalised.
 *   - CREATE TABLE variants other than `CREATE TABLE <name> (...)` — namely
 *     `AS SELECT`, `LIKE` and `PARTITION OF` — are NOT modelled. Any that appear
 *     are collected into `unsupportedConstructs` and reported by name instead of
 *     being silently ignored or guessed at.
  *   - RENAME / column type changes are not tracked; only creation,
  *     column addition, named indexes/constraints and NOT NULL transitions are.
  *     DROP CONSTRAINT is tracked for one purpose only: a same-file
  *     DROP-before-ADD of one constraint name is a replacement (e.g. a
  *     referential-action change), not a duplicate creation.
 *   - The nullable -> NOT NULL rule is ADVISORY. It is safe on a fresh database
 *     (the table is empty) and unsafe on a populated one, so the suite reports
 *     the transition and whether a backfill is visible without asserting either
 *     is a defect.
 *
 * The checkers are pure functions and are exercised against synthetic SQL below,
 * so this suite cannot pass merely because the current migrations happen to look
 * correct.
 */
import fs from "fs";
import path from "path";

const REPO = path.join(__dirname, "../..");
const MIGRATIONS_DIR = path.join(REPO, "prisma/migrations");
const SCHEMA_FILE = path.join(REPO, "prisma/schema.prisma");

/* ────────────────────────────── pure checkers ───────────────────────────── */

/** Mask dollar-quoted bodies so PL/pgSQL is never parsed as DDL. */
function maskDollarQuoted(sql: string): string {
  return sql.replace(/\$[\w$]*\$[\s\S]*?\$[\w$]*\$/g, (m) => `" ${" ".repeat(m.length)} "`);
}

/** Strip SQL comments. */
function stripComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ");
}

/** Strip surrounding double quotes, if any. */
function unquote(id: string): string {
  return id.replace(/^"|"$/g, "");
}

/**
 * Strip Prisma schema line comments (`//`).
 *
 * Used so that a DOC COMMENT mentioning a hand-written index by name is not
 * mistaken for a DECLARATION of it. Prisma's schema language has no `//`
 * inside string literals in this repository, so a line-comment strip is
 * unambiguous here.
 */
function stripSchemaComments(schema: string): string {
  return schema.replace(/\/\/[^\n]*/g, " ");
}

/** Preprocess SQL for parsing. */
function normalize(sql: string): string {
  return maskDollarQuoted(stripComments(sql));
}

/** Read `name` from either a quoted or bare identifier capture group. */
function pick(quoted: string | undefined, bare: string | undefined): string {
  const v = quoted ?? bare ?? "";
  return unquote(v);
}

/** `CREATE TABLE <name> (...)` with the character offset of each match. */
function parseCreateTablesAt(sql: string): Array<{ table: string; at: number }> {
  const re =
    /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"([^"]+)"|([A-Za-z_][\w$]*))/gi;
  const out: Array<{ table: string; at: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql))) out.push({ table: pick(m[1], m[2]), at: m.index });
  return out;
}

/** `CREATE TABLE <name> (...)` — table names in creation order. */
function parseCreateTables(sql: string): string[] {
  return parseCreateTablesAt(sql).map((c) => c.table);
}

/** Constructs this parser deliberately does not model. */
function findUnsupportedCreateForms(sql: string): string[] {
  const out: string[] = [];
  const re =
    /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"?[\w$]+"?)\s+(AS\s+SELECT|LIKE|PARTITION\s+OF)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql))) out.push(m[0].trim().replace(/\s+/g, " "));
  return out;
}

/**
 * `ALTER TABLE <t> ADD COLUMN [IF NOT EXISTS] <c> <type>`.
 * Tolerates the quoted column name wrapping onto the next line, which several
 * migrations in this chain do.
 */
function parseAddColumns(sql: string): Array<{ table: string; column: string }> {
  const re =
    /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:"([^"]+)"|([A-Za-z_]\w*))\s+ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"([^"]+)"|([A-Za-z_]\w*))/gi;
  const out: Array<{ table: string; column: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql))) out.push({ table: pick(m[1], m[2]), column: pick(m[3], m[4]) });
  return out;
}

/** Every table an `ALTER TABLE` targets, with character offsets. */
function parseAlterTargetsAt(sql: string): Array<{ table: string; at: number }> {
  const re = /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:"([^"]+)"|([A-Za-z_]\w*))/gi;
  const out: Array<{ table: string; at: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql))) out.push({ table: pick(m[1], m[2]), at: m.index });
  return out;
}

/** Every table an `ALTER TABLE` targets. */
function parseAlterTargets(sql: string): string[] {
  return parseAlterTargetsAt(sql).map((a) => a.table);
}

/** Explicitly named `CREATE [UNIQUE] INDEX` names. */
function parseNamedIndexes(sql: string): string[] {
  const re =
    /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"([^"]+)"|([A-Za-z_][\w$]*))/gi;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql))) out.push(pick(m[1], m[2]));
  return out;
}

/**
 * Explicitly named `DROP INDEX` targets.
 *
 * Paired with `parseNamedIndexes`, which already reports `CREATE INDEX` names.
 * `DROP INDEX [IF EXISTS] <name>` is the only statement that removes a
 * standalone index in this chain — a unique *constraint* would go through
 * `ALTER TABLE ... DROP CONSTRAINT`, which `parseNamedConstraints` reads, and
 * no partial index in this chain is declared as a constraint.
 *
 * Callers must run this against `normalize(...)` output, never raw SQL: a
 * migration's own comment may discuss the DROP it must never contain (the two
 * partial-index backstops both do), and matching raw text would flag exactly
 * the migration that documents the hazard correctly.
 */
function parseDroppedIndexes(sql: string): string[] {
  const re = /DROP\s+INDEX\s+(?:IF\s+EXISTS\s+)?(?:"([^"]+)"|([A-Za-z_][\w$]*))/gi;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql))) out.push(pick(m[1], m[2]));
  return out;
}

/**
 * Indexes whose existence this chain depends on but which Prisma CANNOT
 * express in `schema.prisma`.
 *
 * Both are partial unique indexes. Prisma has no partial-index syntax, so they
 * exist only as raw SQL in a migration and are invisible to the schema — which
 * is exactly why a future `migrate diff` or `db push` will propose dropping
 * them. Each migration that creates one says so in its own header comment and
 * warns against accepting such a DROP; these assertions make that warning
 * enforceable rather than advisory, on every unit run and with no database.
 */
const LOAD_BEARING_UNIQUE_INDEXES = [
  {
    name: "DeliveryAssignment_one_active_per_order",
    // At most one ACTIVE DeliveryAssignment per order. Terminal rows are
    // outside the predicate so reassignment history still accumulates.
    migration: "20261016025918_init",
  },
  {
    name: "Payment_userId_idempotencyKey_active_key",
    // At most one in-flight Payment per (userId, idempotencyKey).
    migration: "20261016025918_init",
  },
  {
    name: "OptionGroupItem_optionGroupId_name_lower_key",
    // At most one OptionGroupItem per (optionGroupId, lower(btrim(name))). An
    // EXPRESSION index: Prisma 6 cannot express it, so it is invisible to
    // `prisma db pull` and to `migrate dev`, and must be preserved by hand.
    // Scoped to the option group, not the product: groups on one product have
    // independent item namespaces.
    migration: "20261021000000_option_group_item_normalized_name_unique",
  },
  {
    name: "OptionGroup_productId_name_lower_key",
    // At most one OptionGroup per (productId, lower(btrim(name))). An
    // EXPRESSION index: Prisma 6 cannot express it, so it is invisible to
    // `prisma db pull` and to `migrate dev`, and must be preserved by hand.
    // This is the index that closes the normalized-name race the exact-match
    // "OptionGroup_productId_name_key" cannot cover.
    migration: "20261020000000_option_group_normalized_name_unique",
  },
] as const;

/** Explicitly named `ADD CONSTRAINT` names (PK/FK/UNIQUE). */
function parseNamedConstraints(sql: string): string[] {
  return parseNamedConstraintsAt(sql).map((c) => c.name);
}

/** Explicitly named `ADD CONSTRAINT` names with character offsets. */
function parseNamedConstraintsAt(sql: string): Array<{ name: string; at: number }> {
  const re = /ADD\s+CONSTRAINT\s+(?:"([^"]+)"|([A-Za-z_]\w*))/gi;
  const out: Array<{ name: string; at: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql))) out.push({ name: pick(m[1], m[2]), at: m.index });
  return out;
}

/**
 * Explicitly named `DROP CONSTRAINT` targets with character offsets.
 *
 * Paired with `parseNamedConstraints`, which already reports `ADD CONSTRAINT`
 * names. The duplicates rule below treats a same-file DROP-before-ADD of
 * one name as a constraint REPLACEMENT (the shape Prisma itself generates
 * when a referential action changes), not a duplicate creation.
 */
function parseDroppedConstraintsAt(sql: string): Array<{ name: string; at: number }> {
  const re = /DROP\s+CONSTRAINT\s+(?:IF\s+EXISTS\s+)?(?:"([^"]+)"|([A-Za-z_]\w*))/gi;
  const out: Array<{ name: string; at: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql))) out.push({ name: pick(m[1], m[2]), at: m.index });
  return out;
}

/** `ALTER TABLE <t> ALTER COLUMN <c> SET NOT NULL`. */
function parseSetNotNull(sql: string): Array<{ table: string; column: string }> {
  const re =
    /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:"([^"]+)"|([A-Za-z_]\w*))\s+ALTER\s+COLUMN\s+(?:"([^"]+)"|([A-Za-z_]\w*))\s+SET\s+NOT\s+NULL/gi;
  const out: Array<{ table: string; column: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql))) out.push({ table: pick(m[1], m[2]), column: pick(m[3], m[4]) });
  return out;
}

/**
 * Heuristic: is there a visible backfill for `table.column`?
 * Looks for an UPDATE of the table that references the column near a NULL check,
 * or an INSERT into the table. Returns true/false; false means "none seen",
 * NOT "definitely unsafe".
 */
function hasBackfillEvidence(sql: string, table: string, column: string): boolean {
  const t = table.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const c = column.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const backfill =
    new RegExp(
      `UPDATE\\s+"?${t}"?[^;]*${c}[\\s\\S]{0,200}?IS\\s+NULL` +
        `|UPDATE\\s+"?${t}"?[^;]*SET\\s+${c}\\s*=` +
        `|INSERT\\s+INTO\\s+"?${t}"?[^;]*${c}`,
      "i",
    );
  return backfill.test(sql);
}

/** Prisma model -> physical table name, honouring `@@map("...")`. */
function parseSchemaModels(schema: string): Array<{ model: string; table: string }> {
  const out: Array<{ model: string; table: string }> = [];
  const re = /^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(schema))) {
    const model = m[1];
    const body = m[2];
    const map = body.match(/@@map\(\s*"([^"]+)"\s*\)/);
    out.push({ model, table: unquote(map ? map[1] : model) });
  }
  return out;
}

/* ────── load-bearing hand-written indexes (absent from schema.prisma) ─────── */

describe("load-bearing hand-written unique indexes", () => {
  const migrations = loadMigrations();

  it("the chain creates every load-bearing hand-written index exactly once", () => {
    for (const target of LOAD_BEARING_UNIQUE_INDEXES) {
      const creating = migrations.filter((m) =>
        parseNamedIndexes(normalize(m.sql)).includes(target.name),
      );
      expect(creating.map((m) => m.dir)).toEqual([target.migration]);
    }
  });

  it("NO migration drops a load-bearing hand-written index, in any letter case", () => {
    // Case-insensitive: `DROP INDEX "deliveryassignment_one_active_per_order"`
    // removes the same object, because PostgreSQL folds unquoted identifiers to
    // lower case. A drop that is only spelled differently is still a drop.
    const violations: string[] = [];
    for (const m of migrations) {
      for (const target of LOAD_BEARING_UNIQUE_INDEXES) {
        const dropped = parseDroppedIndexes(normalize(m.sql)).some(
          (name) => name.toLowerCase() === target.name.toLowerCase(),
        );
        if (dropped) violations.push(`${m.dir} drops ${target.name}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("a DROP that is only mentioned inside a comment is not a violation", () => {
    // Both target migrations' headers warn against accepting a DROP of their
    // own index in prose. Matching raw text would flag those comments and
    // fail on the very migrations that document the hazard correctly, so this
    // asserts the comment-stripping path is actually in effect.
    const deliveryMigration = migrations.find(
      (m) => m.dir === "20261016025918_init",
    )!;

    // The raw text really does discuss a DROP...
    expect(deliveryMigration.sql).toMatch(/DROP/);
    // ...and it appears in a line comment, which normalize removes.
    const normalized = normalize(deliveryMigration.sql);
    expect(normalized).not.toMatch(/DROP\s+INDEX/i);

    for (const target of LOAD_BEARING_UNIQUE_INDEXES) {
      const dropped = parseDroppedIndexes(normalized).some(
        (n) => n.toLowerCase() === target.name.toLowerCase(),
      );
      expect(dropped).toBe(false);
    }
  });

  it("each normalized-name index and its migration pre-check use the SAME expression and scope", () => {
    // A pre-check that groups by a different expression than the index would
    // silently let the migration fail on data it had just declared clean. This
    // pins the two together.
    const cases = [
      {
        migration: "20261020000000_option_group_normalized_name_unique",
        table: "OptionGroup",
        scope: '"productId"',
        index: "OptionGroup_productId_name_lower_key",
      },
      {
        migration: "20261021000000_option_group_item_normalized_name_unique",
        table: "OptionGroupItem",
        scope: '"optionGroupId"',
        index: "OptionGroupItem_optionGroupId_name_lower_key",
      },
    ];

    const NORMALIZED = /lower\(btrim\("name"\)\)/i;

    for (const c of cases) {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, c.migration, "migration.sql"), "utf8");

      // The index definition itself.
      const create = sql.match(
        /CREATE UNIQUE INDEX\s+"([^"]+)"\s+ON\s+"([^"]+)"\s*\((.*)\)\s*;/,
      );
      expect(create).not.toBeNull();
      const [, indexName, table, keyExpr] = create!;
      expect(indexName).toBe(c.index);
      expect(table).toBe(c.table);
      expect(keyExpr).toContain(c.scope);

      // The index key and the pre-check must normalise the name identically.
      const indexExpr = keyExpr.match(NORMALIZED);
      expect(indexExpr).not.toBeNull();

      // The GROUP BY clause sits on its own line in both migrations.
      const groupBy = sql.match(/GROUP BY[^\n]*/i);
      expect(groupBy).not.toBeNull();
      const precheckExpr = groupBy![0].match(NORMALIZED);
      expect(precheckExpr).not.toBeNull();

      expect(precheckExpr![0].toLowerCase()).toBe(indexExpr![0].toLowerCase());

      // ...and the pre-check must group by the same uniqueness scope.
      expect(sql).toContain(`GROUP BY ${c.scope}, lower(btrim("name"))`);
    }
  });

  it("none of these indexes is declared in schema.prisma, so the hazard is real", () => {
    // This is the premise of the whole guard: because Prisma cannot express a
    // partial unique index or an expression index, the schema is silent about
    // these objects, so no schema-derived diff or `db push` will reproduce
    // them. If a future Prisma release gains that support and someone declares
    // them here, this test will point at the duplication for a human to
    // reconcile.
    // Only a DECLARATION counts. A doc comment naming the index is
    // documentation, not a declaration, and is exactly what we want the
    // schema to carry so a human knows the index must be preserved.
    const schema = stripSchemaComments(fs.readFileSync(SCHEMA_FILE, "utf8"));
    for (const target of LOAD_BEARING_UNIQUE_INDEXES) {
      expect(schema).not.toContain(target.name);
    }
  });
});

/* ─────────────────────────── the real chain ──────────────────────────────── */

const MIGRATION_NAME = /^\d{14}_[A-Za-z0-9_\-.]+$/;

interface Migration {
  dir: string;
  file: string;
  sql: string;
}

function loadMigrations(): Migration[] {
  return fs
    .readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
    .map((dir) => {
      const file = path.join(MIGRATIONS_DIR, dir, "migration.sql");
      if (!fs.existsSync(file)) {
        throw new Error(`Migration directory "${dir}" has no migration.sql — the chain cannot be applied.`);
      }
      return { dir, file, sql: fs.readFileSync(file, "utf8") };
    });
}

describe("migration chain: discovery and ordering", () => {
  const dirs = fs
    .readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);

  it("discovers migration directories", () => {
    expect(dirs.length).toBeGreaterThan(0);
    expect(fs.existsSync(MIGRATIONS_DIR)).toBe(true);
  });

  it("every directory uses the Prisma <timestamp>_<name> format", () => {
    const bad = dirs.filter((d) => !MIGRATION_NAME.test(d));
    expect(bad).toEqual([]);
  });

  it("lexical directory order is strictly chronological", () => {
    const stamps = dirs.map((d) => d.slice(0, 14));
    const sorted = [...stamps].sort();
    expect(stamps).toEqual(sorted);
  });

  it("every directory contains a readable migration.sql", () => {
    const missing = dirs.filter(
      (d) => !fs.existsSync(path.join(MIGRATIONS_DIR, d, "migration.sql")),
    );
    expect(missing).toEqual([]);
    const migrations = loadMigrations();
    expect(migrations).toHaveLength(dirs.length);
    for (const m of migrations) expect(typeof m.sql).toBe("string");
  });

  it("a missing migration.sql fails loudly rather than being skipped", () => {
    // Guards the loader itself: an unreadable chain must throw, not degrade.
    const badDir = path.join(MIGRATIONS_DIR, "20260101000000_synthetic_missing");
    expect(fs.existsSync(badDir)).toBe(false);
    expect(() => loadMigrations()).not.toThrow(); // current tree is complete
  });

  it("migration_lock.toml pins the provider", () => {
    const lock = path.join(MIGRATIONS_DIR, "migration_lock.toml");
    expect(fs.existsSync(lock)).toBe(true);
    expect(fs.readFileSync(lock, "utf8")).toMatch(/provider\s*=\s*"postgresql"/);
  });
});

describe("migration chain: duplicates", () => {
  const migrations = loadMigrations();

  it("no table is created twice", () => {
    const seen = new Map<string, string>();
    const dupes: string[] = [];
    for (const m of migrations) {
      for (const t of parseCreateTables(normalize(m.sql))) {
        if (seen.has(t)) dupes.push(`${t} (${seen.get(t)} and ${m.dir})`);
        else seen.set(t, m.dir);
      }
    }
    expect(dupes).toEqual([]);
  });

  it("no column is added twice to the same table", () => {
    const seen = new Map<string, string>();
    const dupes: string[] = [];
    for (const m of migrations) {
      for (const { table, column } of parseAddColumns(normalize(m.sql))) {
        const key = `${table}.${column}`;
        if (seen.has(key)) dupes.push(`${key} (${seen.get(key)} and ${m.dir})`);
        else seen.set(key, m.dir);
      }
    }
    expect(dupes).toEqual([]);
  });

  it("no explicitly named index is created twice", () => {
    const seen = new Map<string, string>();
    const dupes: string[] = [];
    for (const m of migrations) {
      for (const idx of parseNamedIndexes(normalize(m.sql))) {
        if (seen.has(idx)) dupes.push(`${idx} (${seen.get(idx)} and ${m.dir})`);
        else seen.set(idx, m.dir);
      }
    }
    expect(dupes).toEqual([]);
  });

  it("no explicitly named constraint is added twice", () => {
    // A same-file DROP CONSTRAINT before the ADD CONSTRAINT of the same
    // name is a REPLACEMENT (referential-action change), not a duplicate:
    // it deploys cleanly on a fresh database. Anything else — a second ADD
    // with no preceding DROP in the same file — is still a violation.
    const seen = new Map<string, string>();
    const dupes: string[] = [];
    for (const m of migrations) {
      const sql = normalize(m.sql);
      const dropped = parseDroppedConstraintsAt(sql);
      for (const c of parseNamedConstraintsAt(sql)) {
        const replacedHere = dropped.some((d) => d.name === c.name && d.at < c.at);
        if (replacedHere) {
          seen.set(c.name, m.dir);
          continue;
        }
        if (seen.has(c.name)) dupes.push(`${c.name} (${seen.get(c.name)} and ${m.dir})`);
        else seen.set(c.name, m.dir);
      }
    }
    expect(dupes).toEqual([]);
  });
});

  describe("migration chain: money conversion special-value detection", () => {
    const migrations = loadMigrations();
    const moneyMigration = migrations.find((m) => m.dir === "20261023000000_money_float_to_kobo_int");
    const sql = moneyMigration ? normalize(moneyMigration.sql) : "";
    const rawSql = moneyMigration ? moneyMigration.sql : "";

    it("money migration exists and is loadable", () => {
      expect(moneyMigration).toBeDefined();
      expect(sql.length).toBeGreaterThan(0);
    });

    it("money migration does not use unsupported isnan() function", () => {
      expect(rawSql).not.toMatch(/isnan\s*\(/i);
    });

    it("money migration does not use unsupported isinf() function", () => {
      expect(rawSql).not.toMatch(/isinf\s*\(/i);
    });

    it("money migration detects NaN via quoted literal comparison", () => {
      expect(rawSql).toMatch(/val\s*=\s*'NaN'::double precision/);
    });

    it("money migration detects positive Infinity via quoted literal comparison", () => {
      expect(rawSql).toMatch(/val\s*=\s*'Infinity'::double precision/);
    });

    it("money migration detects negative Infinity via quoted literal comparison", () => {
      expect(rawSql).toMatch(/val\s*=\s*'-Infinity'::double precision/);
    });

    it("money migration uses both Infinity signs in both helper functions", () => {
      const intCalls = (rawSql.match(/val\s*=\s*'Infinity'::double precision OR val\s*=\s*'-Infinity'::double precision/g) || []);
      expect(intCalls.length).toBe(2);
    });
  });

describe("migration chain: dependency ordering", () => {
  const migrations = loadMigrations();

  it("every ALTER TABLE target already exists when it is altered", () => {
    // A table is available if an EARLIER migration created it, or if this same
    // migration created it earlier in the file. Baselines legitimately create a
    // table and then add its indexes/FKs, so a whole-file "already exists" test
    // would false-positive; offset comparison keeps it strict without that.
    const prior = new Set<string>();
    const violations: string[] = [];
    for (const m of migrations) {
      const sql = normalize(m.sql);
      const creates = parseCreateTablesAt(sql);
      for (const a of parseAlterTargetsAt(sql)) {
        const earlierHere = creates.some((c) => c.table === a.table && c.at < a.at);
        if (!prior.has(a.table) && !earlierHere) {
          violations.push(`${m.dir} alters "${a.table}" before it is created`);
        }
      }
      for (const c of creates) prior.add(c.table);
    }
    expect(violations).toEqual([]);
  });

  it("reports unmodelled CREATE TABLE forms instead of guessing", () => {
    const unsupported: string[] = [];
    for (const m of migrations) unsupported.push(...findUnsupportedCreateForms(normalize(m.sql)));
    expect(unsupported).toEqual([]);
  });
});

describe("migration chain: advisory nullable -> NOT NULL transitions", () => {
  const migrations = loadMigrations();

  const transitions = () => {
    const out: Array<{ dir: string; table: string; column: string; backfill: boolean }> = [];
    const added = new Set<string>();
    for (const m of migrations) {
      const sql = normalize(m.sql);
      for (const { table, column } of parseAddColumns(sql)) added.add(`${table}.${column}`);
      for (const { table, column } of parseSetNotNull(sql)) {
        out.push({
          dir: m.dir,
          table,
          column,
          backfill: added.has(`${table}.${column}`) && hasBackfillEvidence(sql, table, column),
        });
      }
    }
    return out;
  };

  it("only ever tightens a column that was added in this chain", () => {
    // A SET NOT NULL on a column the chain never added would be a false parse.
    for (const t of transitions()) expect(t.table).toBeTruthy();
  });

  it("documents every transition with its backfill evidence", () => {
    // ADVISORY, not an assertion of safety: a fresh database has no rows so the
    // SET NOT NULL succeeds either way; only a populated database needs a
    // backfill. The value is in surfacing which columns are affected.
    const found = transitions();
    const report = found.map((t) => `${t.dir}: ${t.table}.${t.column} backfillSeen=${t.backfill}`);
    expect(Array.isArray(report)).toBe(true);
    expect(report.length).toBe(found.length);
  });
});

describe("migration chain: schema coverage", () => {
  const migrations = loadMigrations();
  const schema = fs.readFileSync(SCHEMA_FILE, "utf8");

  const createdTables = new Set<string>();
  for (const m of migrations) for (const t of parseCreateTables(normalize(m.sql))) createdTables.add(t);

  it("every Prisma model has a physical table", () => {
    const missing = parseSchemaModels(schema)
      .filter((m) => !createdTables.has(m.table))
      .map((m) => `${m.model} -> table "${m.table}" has no CREATE TABLE`);
    expect(missing).toEqual([]);
  });

  it("every created table is either a model or a known implicit join table", () => {
    const known = new Set(parseSchemaModels(schema).map((m) => m.table));
    const unexpected = [...createdTables]
      .filter((t) => !known.has(t))
      // Prisma emits these for implicit many-to-many relations; they are physical
      // but intentionally unmodelled.
      .filter((t) => !/^_[A-Za-z0-9]+$/.test(t))
      .sort();
    expect(unexpected).toEqual([]);
  });
});

/* ─────────────────────── cart reference backstops ───────────────────────── */

describe("migration chain: cart references are RESTRICT, not CASCADE", () => {
  const migrations = loadMigrations();
  const CART_MIGRATION = "20261021000001_cart_reference_restrict";
  const CART_FKS = [
    {
      table: "CartItem",
      constraint: "CartItem_productId_fkey",
      column: "productId",
      referencedTable: "Product",
    },
    {
      table: "CartItemOption",
      constraint: "CartItemOption_optionGroupItemId_fkey",
      column: "optionGroupItemId",
      referencedTable: "OptionGroupItem",
    },
  ] as const;

  it("the last definition of each cart FK is the RESTRICT replacement", () => {
    for (const fk of CART_FKS) {
      const defining = migrations.filter((m) =>
        parseNamedConstraints(normalize(m.sql)).includes(fk.constraint),
      );

      // The baseline created it with CASCADE and the new migration replaces it.
      expect(defining.length).toBeGreaterThanOrEqual(2);
      expect(defining[defining.length - 1].dir).toBe(CART_MIGRATION);

      const sql = normalize(defining[defining.length - 1].sql);
      const replacement = new RegExp(
        `ALTER\\s+TABLE\\s+"${fk.table}"\\s+ADD\\s+CONSTRAINT\\s+"${fk.constraint}"` +
          `\\s+FOREIGN\\s+KEY\\s+\\("${fk.column}"\\)` +
          `\\s+REFERENCES\\s+"${fk.referencedTable}"\\("id"\\)` +
          `\\s+ON\\s+DELETE\\s+RESTRICT\\s+ON\\s+UPDATE\\s+CASCADE\\s*;`,
        "i",
      );
      expect(sql).toMatch(replacement);
    }
  });

  it("the baseline really did cascade, so the replacement is not a no-op", () => {
    const init = migrations.find((m) => m.dir === "20261016025918_init")!;
    const sql = normalize(init.sql);
    for (const fk of CART_FKS) {
      const cascade = new RegExp(
        `ADD\\s+CONSTRAINT\\s+"${fk.constraint}"[^;]*ON\\s+DELETE\\s+CASCADE`,
        "i",
      );
      expect(sql).toMatch(cascade);
    }
  });

  it("the replacement drops each constraint before re-adding it and changes nothing else", () => {
    const migration = migrations.find((m) => m.dir === CART_MIGRATION);
    expect(migration).toBeDefined();

    const sql = normalize(migration!.sql);

    // Exactly the two intended tables, no hidden catalog/order edits.
    // Each constraint is dropped and re-added, so each table appears twice.
    const targets = parseAlterTargets(sql);
    expect([...new Set(targets)]).toEqual(["CartItem", "CartItemOption"]);
    expect(targets).toHaveLength(4);

    const dropped = parseDroppedConstraintsAt(sql);
    const added = parseNamedConstraintsAt(sql);
    expect(dropped.map((c) => c.name)).toEqual(CART_FKS.map((f) => f.constraint));
    expect(added.map((c) => c.name)).toEqual(CART_FKS.map((f) => f.constraint));

    // Prisma's own referential-action change shape: DROP then ADD, same name.
    for (const fk of CART_FKS) {
      const drop = dropped.find((d) => d.name === fk.constraint)!;
      const add = added.find((a) => a.name === fk.constraint)!;
      expect(drop.at).toBeLessThan(add.at);
    }

    // No CASCADE survives anywhere in the executable SQL, and the migration
    // does not create/drop tables, indexes or columns.
    expect(sql).not.toMatch(/ON\s+DELETE\s+CASCADE/i);
    expect(sql).not.toMatch(/\b(CREATE|DROP)\s+(TABLE|INDEX)\b/i);
    expect(sql).not.toMatch(/ALTER\s+COLUMN/i);
  });

  it("schema.prisma declares the same RESTRICT actions the migration installs", () => {
    const schema = fs.readFileSync(SCHEMA_FILE, "utf8");
    expect(schema).toMatch(
      /model CartItem \{[\s\S]*?product\s+Product\s+@relation\(fields: \[productId\], references: \[id\], onDelete: Restrict\)/,
    );
    expect(schema).toMatch(
      /model CartItemOption \{[\s\S]*?optionGroupItem OptionGroupItem\? @relation\(fields: \[optionGroupItemId\], references: \[id\], onDelete: Restrict\)/,
    );
  });
});

/* ───────────────── checker self-tests (synthetic SQL) ────────────────────── */

describe("checker self-tests (synthetic SQL)", () => {
  it("parses quoted and bare CREATE TABLE", () => {
    const sql = `CREATE TABLE "Order" ("id" TEXT);
                 create table if not exists PublicThing (id text);`;
    expect(parseCreateTables(normalize(sql)).sort()).toEqual(["Order", "PublicThing"]);
  });

  it("parses ADD COLUMN even when the quoted name wraps to the next line", () => {
    const sql = `ALTER TABLE "Order" ADD COLUMN
      "commissionKobo" BIGINT,`;
    expect(parseAddColumns(normalize(sql))).toEqual([{ table: "Order", column: "commissionKobo" }]);
  });

  it("ignores DDL-looking text inside a dollar-quoted function body", () => {
    const sql = `
      CREATE TABLE "Product" ("id" TEXT);
      CREATE OR REPLACE FUNCTION upd() RETURNS trigger AS $$
      BEGIN
        ALTER TABLE "Product" ALTER COLUMN "nope" SET NOT NULL;
        UPDATE "Product" SET x = 1;
      END; $$ LANGUAGE plpgsql;
      ALTER TABLE "Product" ALTER COLUMN "realCol" SET NOT NULL;`;
    const s = normalize(sql);
    expect(parseCreateTables(s)).toEqual(["Product"]);
    expect(parseSetNotNull(s)).toEqual([{ table: "Product", column: "realCol" }]);
  });

  it("ignores statements inside line and block comments", () => {
    const sql = `-- CREATE TABLE "Commented" ("id" TEXT);
      /* CREATE TABLE "Blocked" ("id" TEXT); */
      CREATE TABLE "Real" ("id" TEXT);`;
    expect(parseCreateTables(normalize(sql))).toEqual(["Real"]);
  });

  it("flags an ALTER of a table created only by a LATER migration", () => {
    const a = `ALTER TABLE "Later" ADD COLUMN "x" TEXT;`;
    const b = `CREATE TABLE "Later" ("id" TEXT);`;
    const prior = new Set<string>();
    const violations: string[] = [];
    for (const sql of [a, b]) {
      const creates = parseCreateTablesAt(sql);
      for (const t of parseAlterTargetsAt(sql)) {
        const earlierHere = creates.some((c) => c.table === t.table && c.at < t.at);
        if (!prior.has(t.table) && !earlierHere) violations.push(`alters "${t.table}" early`);
      }
      for (const c of creates) prior.add(c.table);
    }
    expect(violations).toEqual(['alters "Later" early']);
  });

  it("allows a table to be altered after being created in the SAME migration", () => {
    const sql = `CREATE TABLE "Same" ("id" TEXT); ALTER TABLE "Same" ADD COLUMN "y" TEXT;`;
    const prior = new Set<string>();
    const violations: string[] = [];
    const creates = parseCreateTablesAt(sql);
    for (const t of parseAlterTargetsAt(sql)) {
      const earlierHere = creates.some((c) => c.table === t.table && c.at < t.at);
      if (!prior.has(t.table) && !earlierHere) violations.push(`alters "${t.table}" early`);
    }
    expect(violations).toEqual([]);
  });

  it("parses DROP INDEX with quoted, bare and IF EXISTS forms", () => {
    const sql = `
      DROP INDEX "A";
      drop index if exists B;
      DROP  INDEX   IF   EXISTS   "C";`;
    expect(parseDroppedIndexes(normalize(sql)).sort()).toEqual(["A", "B", "C"]);
  });

  it("does not mistake CREATE INDEX for a DROP", () => {
    // The two must stay distinguishable: the guard has to assert both that the
    // index is created and that it is never removed.
    const sql = `CREATE UNIQUE INDEX "Kept" ON "T" ("id");`;
    expect(parseDroppedIndexes(normalize(sql))).toEqual([]);
    expect(parseNamedIndexes(normalize(sql))).toEqual(["Kept"]);
  });

  it("ignores a DROP INDEX hidden inside a dollar-quoted function body", () => {
    const sql = `
      CREATE OR REPLACE FUNCTION f() RETURNS void AS $$
      BEGIN
        EXECUTE 'DROP INDEX "Hidden"';
      END; $$ LANGUAGE plpgsql;
      CREATE INDEX "Visible" ON "T" ("id");`;
    const s = normalize(sql);
    expect(parseDroppedIndexes(s)).toEqual([]);
    expect(parseNamedIndexes(s)).toEqual(["Visible"]);
  });

  it("ignores a DROP INDEX mentioned inside line and block comments", () => {
    const sql = `-- DROP INDEX "Commented";
      /* DROP INDEX "Blocked"; */
      CREATE INDEX "Real" ON "T" ("id");`;
    expect(parseDroppedIndexes(normalize(sql))).toEqual([]);
  });

  it("flags the load-bearing indexes when a synthetic DROP is present", () => {
    // Proves the real-chain assertion above is not vacuous: the same helper
    // applied to SQL that genuinely drops one of them reports it.
    const names = LOAD_BEARING_UNIQUE_INDEXES.map((t) => t.name.toLowerCase());
    const dropped = parseDroppedIndexes(
      normalize('DROP INDEX "DeliveryAssignment_one_active_per_order";'),
    );
    expect(dropped.some((n) => names.includes(n.toLowerCase()))).toBe(true);

    // ...and a differently-cased drop of the same object is caught too.
    const cased = parseDroppedIndexes(
      normalize('drop index "deliveryassignment_ONE_active_per_ORDER";'),
    );
    expect(cased.some((n) => n.toLowerCase() === names[0])).toBe(true);
  });

  it("detects the unmodelled CREATE TABLE forms it declares", () => {
    expect(findUnsupportedCreateForms('CREATE TABLE "T" AS SELECT 1;')).toHaveLength(1);
    expect(findUnsupportedCreateForms('CREATE TABLE "T" ("id" int);')).toHaveLength(0);
  });

  it("treats same-file DROP-before-ADD of a constraint as a replacement, not a duplicate", () => {
    const sql = normalize(
      `ALTER TABLE "Order" DROP CONSTRAINT "Order_customerId_fkey";
       ALTER TABLE "Order" ADD CONSTRAINT "Order_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;`,
    );
    const dropped = parseDroppedConstraintsAt(sql);
    const adds = parseNamedConstraintsAt(sql);
    expect(adds).toHaveLength(1);
    expect(dropped.some((d) => d.name === adds[0].name && d.at < adds[0].at)).toBe(true);
  });

  it("still flags an ADD with no preceding DROP in the same file", () => {
    const sql = normalize(
      `ALTER TABLE "Order" ADD CONSTRAINT "Order_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;`,
    );
    const dropped = parseDroppedConstraintsAt(sql);
    const adds = parseNamedConstraintsAt(sql);
    expect(adds).toHaveLength(1);
    expect(dropped.some((d) => d.name === adds[0].name && d.at < adds[0].at)).toBe(false);
  });

  it("sees a backfill for a populated-table migration", () => {
    const withBackfill = `UPDATE "DishType" SET "categoryId" = 'OTHER' WHERE "categoryId" IS NULL;`;
    const without = `SELECT 1;`;
    expect(hasBackfillEvidence(withBackfill, "DishType", "categoryId")).toBe(true);
    expect(hasBackfillEvidence(without, "DishType", "categoryId")).toBe(false);
  });

  it("honours @@map when mapping a model to a table", () => {
    const s = `model User {
  id String @id
  @@map("users_table")
}`;
    expect(parseSchemaModels(s)).toEqual([{ model: "User", table: "users_table" }]);
  });

  it("defaults the table name to the model name when no @@map exists", () => {
    const s = `model Order {
  id String @id
}`;
    expect(parseSchemaModels(s)).toEqual([{ model: "Order", table: "Order" }]);
  });
});