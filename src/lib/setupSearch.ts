import prisma from "./prisma";

/**
 * Verifies full-text + trigram search objects on the "Product" table.
 *
 * Verify-only: all DDL now lives in migration
 * 20261004010000_drift_capture (idempotent). This function only CHECKS that
 * the column, indexes, trigger function and trigger exist, and reports how
 * many rows still have a NULL tsvector_col — it never creates or backfills
 * anything, so a partially-provisioned database fails loudly at boot
 * instead of silently degrading search (or half-creating objects).
 */
export async function setupSearch() {
  console.log("🔧 Verifying full-text + trigram search setup...");

  const problems: string[] = [];

  // 0️⃣ pg_trgm extension present?
  const ext = await prisma.$queryRawUnsafe<Array<{ exists: boolean }>>(`
    SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') AS "exists";
  `).catch((e) => {
    problems.push(`pg_trgm check failed: ${(e as Error).message}`);
    return [{ exists: false }];
  });
  if (!ext[0]?.exists) problems.push("pg_trgm extension is missing");

  // 1️⃣ tsvector column present?
  const col = await prisma.$queryRawUnsafe<Array<{ exists: boolean }>>(`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'Product' AND column_name = 'tsvector_col'
    ) AS "exists";
  `).catch((e) => {
    problems.push(`tsvector_col check failed: ${(e as Error).message}`);
    return [{ exists: false }];
  });
  if (!col[0]?.exists) problems.push("Product.tsvector_col column is missing");

  // 2️⃣ indexes present?
  for (const idx of ["product_tsv_idx", "product_name_trgm_idx", "product_description_trgm_idx"]) {
    const found = await prisma.$queryRawUnsafe<Array<{ exists: boolean }>>(`
      SELECT EXISTS (SELECT 1 FROM pg_class WHERE relname = '${idx}') AS "exists";
    `).catch(() => [{ exists: false }]);
    if (!found[0]?.exists) problems.push(`index ${idx} is missing`);
  }

  // 3️⃣ trigger function + trigger present?
  const fn = await prisma.$queryRawUnsafe<Array<{ exists: boolean }>>(`
    SELECT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'update_tsvector_col') AS "exists";
  `).catch(() => [{ exists: false }]);
  if (!fn[0]?.exists) problems.push("trigger function update_tsvector_col() is missing");

  const trg = await prisma.$queryRawUnsafe<Array<{ exists: boolean }>>(`
    SELECT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trigger_update_tsvector_col') AS "exists";
  `).catch(() => [{ exists: false }]);
  if (!trg[0]?.exists) problems.push("trigger trigger_update_tsvector_col is missing");

  // 4️⃣ any rows never vectorised?
  try {
    const rows = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(`
      SELECT COUNT(*)::bigint AS "count" FROM "Product" WHERE tsvector_col IS NULL;
    `);
    const pending = Number(rows[0]?.count ?? 0);
    if (pending > 0) problems.push(`${pending} Product row(s) have NULL tsvector_col`);
  } catch (e) {
    problems.push(`tsvector backfill check failed: ${(e as Error).message}`);
  }

  if (problems.length > 0) {
    console.error("❌ Search setup verification FAILED:");
    for (const p of problems) console.error(`   - ${p}`);
    console.error("   Run the baseline migration (it is idempotent).");
    throw new Error(`Search setup incomplete: ${problems.join("; ")}`);
  }

  console.log("✅ Search setup verified (column, indexes, trigger, backfill)");

  await prisma.$disconnect().catch(() => {});
}

// ✅ Run only if called directly from command line
if (require.main === module) {
  setupSearch().then(() => process.exit(0));
}

// Usage:
// npx ts-node src/lib/setupSearch.ts
