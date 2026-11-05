/**
 * Phase 2A.1 — catalog taxonomy schema/migration/seed contract.
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
const SEED = fs.readFileSync(
  path.join(__dirname, "../../prisma/seed.ts"),
  "utf8",
);

const LEGACY_DISH_IDS = [
  "JOLLOF", "FRIED_RICE", "OFADA", "WHITE_RICE", "COCONUT_RICE",
  "AMALA", "EBA", "POUNDED_YAM", "FUFU", "SEMOVITA", "TUWO",
  "EWA_AGOYIN", "BEANS", "MOI_MOI", "AKARA", "PUFF_PUFF",
  "EGUSI", "OGBONO", "OKRA", "EFO_RIRO", "AFANG", "EDIKANG",
  "BANGA", "OHA", "BITTERLEAF", "NSALA", "FISHERMAN", "PEPPER_SOUP",
  "ASUN", "SUYA", "BOLI", "PLANTAIN", "FRIED_YAM", "YAM_PORRIDGE",
  "ABACHA", "NKWOBI", "ISIEWU", "KILISHI", "PONMO", "OKPA",
  "AGIDI_PAP", "CHICKEN", "GOAT_MEAT", "FISH", "SMALL_CHOPS",
  "SNACKS", "SHAWARMA", "NOODLES", "DRINKS", "OTHER",
];

const CATEGORY_IDS = [
  "RICE_DISHES", "SOUPS_AND_SWALLOW", "GRILLS_AND_PROTEINS",
  "SNACKS_AND_SMALL_CHOPS", "BREAKFAST", "DRINKS",
  "PASTRIES_AND_BAKERY", "LOCAL_SPECIALS", "NOODLES_AND_PASTA",
  "SALADS_AND_HEALTHY", "COMBOS_AND_PACKS", "DESSERTS_AND_SMOOTHIES",
];

describe("catalog schema", () => {
  it("defines Category with stable identity and unique slug/name", () => {
    expect(SCHEMA).toMatch(/model Category \{/);
    expect(SCHEMA).toMatch(/slug\s+String\s+@unique/);
    expect(SCHEMA).toMatch(/@@index\(\[isActive, sortOrder\]\)/);
  });

  it("defines Tag/TagType with CUISINE/DIET/OCCASION", () => {
    expect(SCHEMA).toMatch(/enum TagType \{[\s\S]*?CUISINE[\s\S]*?DIET[\s\S]*?OCCASION/);
    expect(SCHEMA).toMatch(/model Tag \{/);
    expect(SCHEMA).toMatch(/@@index\(\[type, isActive\]\)/);
  });

  it("defines ProductTag with a composite primary key", () => {
    expect(SCHEMA).toMatch(/model ProductTag \{/);
    expect(SCHEMA).toMatch(/@@id\(\[productId, tagId\]\)/);
    expect(SCHEMA).toMatch(/@@index\(\[tagId, productId\]\)/);
    expect(SCHEMA).toMatch(/tags\s+ProductTag\[\]/);
  });

  it("defines CategorySuggestion with PENDING/APPROVED/REJECTED lifecycle", () => {
    expect(SCHEMA).toMatch(/enum SuggestionStatus \{[\s\S]*?PENDING[\s\S]*?APPROVED[\s\S]*?REJECTED/);
    expect(SCHEMA).toMatch(/model CategorySuggestion \{/);
    expect(SCHEMA).toMatch(/approvedDishTypeId\s+String\?\s+@unique/);
    expect(SCHEMA).toMatch(/"SuggestionVendor"/);
    expect(SCHEMA).toMatch(/"SuggestionReviewer"/);
  });

  it("gives every DishType a required category", () => {
    expect(SCHEMA).toMatch(/categoryId String\n/);
    expect(SCHEMA).toMatch(/onDelete: Restrict/);
    expect(SCHEMA).toMatch(/@@index\(\[categoryId, isActive, sortOrder\]\)/);
  });

  it("keeps ProductOption and option snapshots untouched", () => {
    expect(SCHEMA).toMatch(/model ProductOption \{/);
    expect(SCHEMA).toMatch(/model OrderItemOption \{/);
    expect(SCHEMA).toMatch(/model CartItemOption \{/);
  });

  it("leaves Product.categoryId/OptionGroup to the 2B.1 product foundation (see productSchema.test.ts)", () => {
    // Phase 2B.1 implemented these; the boundary guard served its purpose.
    // Presence is pinned in productSchema.test.ts; here we only pin that
    // the pre-existing portionLabel survived untouched.
    const productBlock = SCHEMA.slice(SCHEMA.indexOf("model Product {"), SCHEMA.indexOf("model ProductOption {"));
    expect(productBlock).toContain("portionLabel");
  });
});

describe("catalog migration", () => {
  it("creates the taxonomy tables and enums", () => {
    for (const stmt of [
      'CREATE TYPE "TagType"',
      'CREATE TYPE "SuggestionStatus"',
      'CREATE TABLE "Category"',
      'CREATE TABLE "Tag"',
      'CREATE TABLE "ProductTag"',
      'CREATE TABLE "CategorySuggestion"',
    ]) {
      expect(MIGRATION_SQL).toContain(stmt);
    }
  });

  it("seeds the 12 categories and defines DishType with required categoryId", () => {
    for (const id of CATEGORY_IDS) {
      expect(MIGRATION_SQL).toContain(`'${id}'`);
    }
    // DishType is created with categoryId already NOT NULL in CREATE TABLE
    expect(MIGRATION_SQL).toMatch(/CREATE TABLE "DishType" [\s\S]*?"categoryId" TEXT NOT NULL/);
    // Categories are seeded inline via INSERT (no backfill needed on a fresh database)
    expect(MIGRATION_SQL).toMatch(/INSERT INTO "Category"/);
    // FK added after table creation
    expect(MIGRATION_SQL).toMatch(/"DishType_categoryId_fkey"/);
  });

  it("creates the required constraints and indexes", () => {
    for (const stmt of [
      '"Category_slug_key"',
      '"Tag_name_key"',
      '"CategorySuggestion_approvedDishTypeId_key"',
      '"DishType_categoryId_isActive_sortOrder_idx"',
      '"ProductTag_tagId_productId_idx"',
      '"CategorySuggestion_status_createdAt_idx"',
      '"CategorySuggestion_vendorId_status_idx"',
    ]) {
      expect(MIGRATION_SQL).toContain(stmt);
    }
    // ProductTag primary key is inline in CREATE TABLE (not a separate index statement)
    expect(MIGRATION_SQL).toMatch(/CONSTRAINT "ProductTag_pkey" PRIMARY KEY \("productId","tagId"\)/);
  });
});

describe("catalog seed", () => {
  it("preserves all 50 legacy DishType ids and names", () => {
    for (const id of LEGACY_DISH_IDS) {
      expect(SEED).toContain(`id: "${id}"`);
    }
  });

  it("assigns a category to every DishType", () => {
    const entries = SEED.match(/\{ id: "[A-Z_]+", name: "[^"]+", description: "[^"]*", sortOrder: \d+, categoryId: "[A-Z_]+" \}/g) ?? [];
    expect(entries.length).toBeGreaterThanOrEqual(LEGACY_DISH_IDS.length);
    for (const id of CATEGORY_IDS) {
      expect(SEED).toContain(`categoryId: "${id}"`);
    }
  });

  it("seeds exactly 12 categories and 20 tags", () => {
    const categoryIds = SEED.match(/id: "[A-Z_]+", name: "[^"]+", slug: "[a-z-]+", sortOrder: \d+ \}/g) ?? [];
    expect(categoryIds).toHaveLength(12);
    const tags = SEED.match(/\{ id: "[A-Z_]+", name: "[^"]+", type: TagType\.[A-Z]+ \}/g) ?? [];
    expect(tags).toHaveLength(20);
  });

  it("seeds WEEKEND/OCCASION and no SPICY canonical tag", () => {
    expect(SEED).toContain('{ id: "WEEKEND", name: "Weekend", type: TagType.OCCASION }');
    expect(SEED).not.toContain('"SPICY"');
  });

  it("never forces isActive back on reseed", () => {
    expect(SEED).not.toMatch(/update: \{[^}]*isActive: true/);
  });
});
