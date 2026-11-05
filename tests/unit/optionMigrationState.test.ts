/**
 * Phase 2B.2 review F-2 — dual-representation state derivation.
 *
 * Pure functions over already-loaded rows. No database.
 *
 * The contract question this CANNOT answer is whether a deployed client reads
 * `options[]` or `optionGroups[]`; see the review report. What it does answer is
 * whether a product's legacy add-on set is FULLY represented in `Extras`, which
 * is the precondition for any consumer to safely avoid rendering an add-on twice.
 */
import {
  deriveLegacyOptionMigrationState,
  MIGRATED_GROUP_NAME,
} from "../../src/services/optionMigrationState";

const legacy = (name: string, price: number, isActive = true) => ({ name, price, isActive });
const group = (name: string, items: Array<{ name: string; priceAdd: number; isActive?: boolean }>) => ({
  name,
  items: items.map((i) => ({ priceAdd: i.priceAdd, isActive: i.isActive ?? true, name: i.name })),
});

describe("fully migrated", () => {
  it("a product with no legacy add-ons and no Extras group is NOT 'migrated'", () => {
    // Nothing was migrated, so the flag must not claim otherwise. A consumer is
    // unaffected (zero legacy add-ons cannot render twice), but asserting
    // `true` here would claim a migration happened when none did.
    const s = deriveLegacyOptionMigrationState([], []);
    expect(s.fullyMigrated).toBe(false);
    expect(s.legacyCount).toBe(0);
    expect(s.blockers).toEqual(["NO_MIGRATED_GROUP"]);
  });

  it("a product with no legacy add-ons but a vendor-authored Extras group is migrated", () => {
    const s = deriveLegacyOptionMigrationState([], [group(MIGRATED_GROUP_NAME, [])]);
    expect(s.fullyMigrated).toBe(true);
  });

  it("an exact 1:1 copy is fully migrated", () => {
    const s = deriveLegacyOptionMigrationState(
      [legacy("Egg", 500), legacy("Cheese", 800, false)],
      [group(MIGRATED_GROUP_NAME, [{ name: "Egg", priceAdd: 500 }, { name: "Cheese", priceAdd: 800, isActive: false }])],
    );
    expect(s.fullyMigrated).toBe(true);
    expect(s.migratedItemCount).toBe(2);
  });

  it("matches names case-insensitively, mirroring the migration's own rule", () => {
    const s = deriveLegacyOptionMigrationState(
      [legacy("Extra Egg", 500)],
      [group("extras", [{ name: "  extra egg  ", priceAdd: 500 }])],
    );
    expect(s.fullyMigrated).toBe(true);
  });
});

describe("not migrated", () => {
  it("no Extras group at all", () => {
    const s = deriveLegacyOptionMigrationState([legacy("Egg", 500)], []);
    expect(s.fullyMigrated).toBe(false);
    expect(s.blockers).toContain("NO_MIGRATED_GROUP");
  });

  it("an unrelated group does not count as migrated", () => {
    const s = deriveLegacyOptionMigrationState(
      [legacy("Egg", 500)],
      [group("Size", [{ name: "Large", priceAdd: 0 }])],
    );
    expect(s.fullyMigrated).toBe(false);
    expect(s.blockers).toContain("NO_MIGRATED_GROUP");
  });

  it("a legacy add-on missing from Extras", () => {
    const s = deriveLegacyOptionMigrationState(
      [legacy("Egg", 500), legacy("Cheese", 800)],
      [group(MIGRATED_GROUP_NAME, [{ name: "Egg", priceAdd: 500 }])],
    );
    expect(s.fullyMigrated).toBe(false);
    expect(s.blockers).toContain("LEGACY_OPTION_UNMATCHED");
  });

  it("a price difference is a mismatch, not a silent pass", () => {
    const s = deriveLegacyOptionMigrationState(
      [legacy("Egg", 500)],
      [group(MIGRATED_GROUP_NAME, [{ name: "Egg", priceAdd: 550 }])],
    );
    expect(s.fullyMigrated).toBe(false);
    expect(s.blockers).toContain("PRICE_MISMATCH");
  });

  it("an active-flag difference is a mismatch", () => {
    const s = deriveLegacyOptionMigrationState(
      [legacy("Egg", 500)],
      [group(MIGRATED_GROUP_NAME, [{ name: "Egg", priceAdd: 500, isActive: false }])],
    );
    expect(s.fullyMigrated).toBe(false);
    expect(s.blockers).toContain("ACTIVE_MISMATCH");
  });
});

describe("defensive coercion (a response builder must never throw)", () => {
  it("treats a non-array options payload as empty rather than crashing", () => {
    const s = deriveLegacyOptionMigrationState(
      undefined as never,
      undefined as never,
    );
    expect(s.fullyMigrated).toBe(false);
    expect(s.blockers).toContain("NO_MIGRATED_GROUP");
  });

  it("tolerates a nested-write descriptor in place of a groups array", () => {
    // Some Prisma call shapes return `{ create: [...] }` rather than rows.
    // Iterating that must not throw, because this runs inside response
    // assembly — a throw here would 500 an otherwise successful write.
    const s = deriveLegacyOptionMigrationState([], { create: [] } as never);
    expect(s.fullyMigrated).toBe(false);
    expect(s.migratedItemCount).toBe(0);
  });

  it("tolerates a group with a non-array items payload", () => {
    const s = deriveLegacyOptionMigrationState([], [
      { name: MIGRATED_GROUP_NAME, items: undefined as never },
    ]);
    expect(s.fullyMigrated).toBe(true);
    expect(s.migratedItemCount).toBe(0);
  });
});

describe("conflicted and ambiguous states are never reported as migrated", () => {
  it("two Extras groups", () => {
    const s = deriveLegacyOptionMigrationState(
      [legacy("Egg", 500)],
      [
        group(MIGRATED_GROUP_NAME, [{ name: "Egg", priceAdd: 500 }]),
        group("extras", [{ name: "Egg", priceAdd: 500 }]),
      ],
    );
    expect(s.fullyMigrated).toBe(false);
    expect(s.blockers).toContain("MULTIPLE_MIGRATED_GROUPS");
  });

  it("a leftover Add-ons group from an earlier run", () => {
    const s = deriveLegacyOptionMigrationState(
      [legacy("Egg", 500)],
      [
        group(MIGRATED_GROUP_NAME, [{ name: "Egg", priceAdd: 500 }]),
        group("Add-ons", [{ name: "Egg", priceAdd: 500 }]),
      ],
    );
    expect(s.fullyMigrated).toBe(false);
    expect(s.blockers).toContain("LEGACY_ADDONS_GROUP_PRESENT");
  });

  it("two legacy add-ons normalizing to the same name", () => {
    const s = deriveLegacyOptionMigrationState(
      [legacy("Egg", 500), legacy("egg", 600)],
      [group(MIGRATED_GROUP_NAME, [{ name: "Egg", priceAdd: 500 }])],
    );
    expect(s.fullyMigrated).toBe(false);
    expect(s.blockers).toContain("LEGACY_NAME_AMBIGUOUS");
  });

  it("two migrated items normalizing to the same name", () => {
    const s = deriveLegacyOptionMigrationState(
      [legacy("Egg", 500)],
      [
        group(MIGRATED_GROUP_NAME, [
          { name: "Egg", priceAdd: 500 },
          { name: "egg", priceAdd: 500 },
        ]),
      ],
    );
    expect(s.fullyMigrated).toBe(false);
    expect(s.blockers).toContain("MIGRATED_NAME_AMBIGUOUS");
  });

  it("blockers are sorted and de-duplicated for stable output", () => {
    const a = deriveLegacyOptionMigrationState([legacy("A", 1)], []);
    const b = deriveLegacyOptionMigrationState([legacy("A", 1)], []);
    expect(a.blockers).toEqual(b.blockers);
    expect([...a.blockers].sort()).toEqual(a.blockers);
    expect(new Set(a.blockers).size).toBe(a.blockers.length);
  });
});