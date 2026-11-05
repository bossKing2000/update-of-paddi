/**
 * Phase 2B.1 — product foundation schema/migration contract.
 * Static checks (no database required).
 */
import fs from "fs";
import path from "path";

const SCHEMA = fs.readFileSync(
  path.join(__dirname, "../../prisma/schema.prisma"),
  "utf8",
);
const MIGRATION_SQL = fs.readFileSync(
  path.join(
    __dirname,
    "../../prisma/migrations/20261016025918_init/migration.sql",
  ),
  "utf8",
);

describe("product foundation schema", () => {
  it("gives Product a required denormalized categoryId", () => {
    expect(SCHEMA).toMatch(/categoryId String\n/);
    expect(SCHEMA).toMatch(/category\s+Category @relation\(fields: \[categoryId\], references: \[id\], onDelete: Restrict\)/);
    expect(SCHEMA).toMatch(/@@index\(\[categoryId\]\)/);
    expect(SCHEMA).toMatch(/@@index\(\[categoryId, archived\]\)/);
  });

  it("adds scheduling and capacity columns with the specified types", () => {
    expect(SCHEMA).toMatch(/isScheduled Boolean @default\(false\)/);
    expect(SCHEMA).toMatch(/orderCutoffTime String\?/);
    expect(SCHEMA).toMatch(/dailyCap Int\?/);
    expect(SCHEMA).not.toMatch(/dailyOrderCount/);
  });

  it("defines OptionGroup with selection semantics", () => {
    expect(SCHEMA).toMatch(/model OptionGroup \{/);
    expect(SCHEMA).toMatch(/minSelections\s+Int\s+@default\(0\)/);
    expect(SCHEMA).toMatch(/maxSelections\s+Int\s+@default\(1\)/);
    expect(SCHEMA).toMatch(/@@index\(\[productId, sortOrder\]\)/);
    expect(SCHEMA).toMatch(/optionGroups\s+OptionGroup\[\]/);
  });

  it("defines OptionGroupItem with integer-kobo priceAdd (Phase 3A)", () => {
    expect(SCHEMA).toMatch(/model OptionGroupItem \{/);
    expect(SCHEMA).toMatch(/priceAdd\s+Int\s+@default\(0\)/);
    expect(SCHEMA).toMatch(/@@index\(\[optionGroupId, isActive, sortOrder\]\)/);
  });

  it("defines ProductDailyCounter with a composite identity", () => {
    expect(SCHEMA).toMatch(/model ProductDailyCounter \{/);
    expect(SCHEMA).toMatch(/count\s+Int\s+@default\(0\)/);
    expect(SCHEMA).toMatch(/@@id\(\[productId, date\]\)/);
    expect(SCHEMA).toMatch(/@@index\(\[date\]\)/);
    expect(SCHEMA).toMatch(/dailyCounters\s+ProductDailyCounter\[\]/);
  });

  it("keeps the legacy option tables and FKs untouched", () => {
    expect(SCHEMA).toMatch(/model ProductOption \{/);
    expect(SCHEMA).toMatch(/model CartItemOption \{/);
    expect(SCHEMA).toMatch(/model OrderItemOption \{/);
    expect(SCHEMA).toMatch(/options\s+ProductOption\[\]\s+@relation\("ProductOptions"\)/);
  });
});

describe("product foundation migration", () => {
  it("creates the new tables without touching legacy option tables", () => {
    // A from-empty initial migration creates every table fresh, including legacy
    // option tables. Their structure is unchanged; they are not dropped.
    for (const stmt of [
      'CREATE TABLE "OptionGroup"',
      'CREATE TABLE "OptionGroupItem"',
      'CREATE TABLE "ProductDailyCounter"',
    ]) {
      expect(MIGRATION_SQL).toContain(stmt);
    }
    // Legacy option tables exist unchanged (their definition is carried over).
    expect(MIGRATION_SQL).toContain('CREATE TABLE "ProductOption"');
    expect(MIGRATION_SQL).toContain('CREATE TABLE "CartItemOption"');
    expect(MIGRATION_SQL).toContain('CREATE TABLE "OrderItemOption"');
    // No legacy table is dropped.
    expect(MIGRATION_SQL).not.toMatch(/DROP TABLE/);
  });

  it("defines Product with categoryId already NOT NULL in CREATE TABLE and the FK", () => {
    // Product is created fresh in a from-empty migration, so categoryId is NOT NULL
    // inline in CREATE TABLE — no ALTER TABLE ADD COLUMN / SET NOT NULL backfill needed.
    expect(MIGRATION_SQL).toMatch(/CREATE TABLE "Product" [\s\S]*?"categoryId" TEXT NOT NULL/);
    expect(MIGRATION_SQL).toMatch(/"Product_categoryId_fkey"/);
    expect(MIGRATION_SQL).toMatch(/ON DELETE RESTRICT/);
  });

  it("creates the required indexes and FK behaviors", () => {
    for (const stmt of [
      '"Product_categoryId_idx"',
      '"Product_categoryId_archived_idx"',
      '"OptionGroup_productId_sortOrder_idx"',
      '"OptionGroupItem_optionGroupId_isActive_sortOrder_idx"',
      '"ProductDailyCounter_date_idx"',
      '"OptionGroup_productId_fkey"',
      '"ProductDailyCounter_productId_fkey"',
    ]) {
      expect(MIGRATION_SQL).toContain(stmt);
    }
    expect(MIGRATION_SQL).toMatch(/"priceAdd" DOUBLE PRECISION NOT NULL DEFAULT 0/);
  });
});
