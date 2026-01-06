"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.setupSearch = setupSearch;
const prisma_1 = __importDefault(require("./prisma"));
/**
 * Sets up full-text search and trigram search on the "Product" table.
 * - Ensures pg_trgm extension
 * - Adds tsvector column if missing
 * - Creates GIN indexes for full-text and trigram search
 * - Creates trigger function to auto-update tsvector column
 * - Attaches trigger to the table
 * - Backfills existing rows
 */
async function setupSearch() {
    console.log("🔧 Starting full-text + trigram search setup...");
    try {
        // 0️⃣ Ensure pg_trgm extension
        console.log("➡️ Step 0: Checking pg_trgm extension...");
        await prisma_1.default.$executeRawUnsafe(`CREATE EXTENSION IF NOT EXISTS pg_trgm;`);
        console.log("✅ pg_trgm extension ready");
        // 1️⃣ Add tsvector column if it does not exist
        console.log("➡️ Step 1: Checking for tsvector_col column...");
        await prisma_1.default.$executeRawUnsafe(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'Product' AND column_name = 'tsvector_col'
        ) THEN
          ALTER TABLE "Product" ADD COLUMN tsvector_col tsvector;
        END IF;
      END$$;
    `);
        console.log("✅ tsvector_col ensured");
        // 2️⃣ Create GIN index for full-text search
        console.log("➡️ Step 2: Checking for FTS GIN index...");
        await prisma_1.default.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS product_tsv_idx
      ON "Product" USING GIN(tsvector_col);
    `);
        console.log("✅ FTS GIN index ready");
        // 3️⃣ Create Trigram indexes for fuzzy search
        console.log("➡️ Step 3: Checking trigram indexes...");
        // Trigram index for product name
        await prisma_1.default.$executeRawUnsafe(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE c.relname = 'product_name_trgm_idx'
            AND n.nspname = 'public'
        ) THEN
          CREATE INDEX product_name_trgm_idx
          ON "Product" USING gin (name gin_trgm_ops);
        END IF;
      END$$;
    `);
        // Trigram index for product description
        await prisma_1.default.$executeRawUnsafe(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE c.relname = 'product_description_trgm_idx'
            AND n.nspname = 'public'
        ) THEN
          CREATE INDEX product_description_trgm_idx
          ON "Product" USING gin (description gin_trgm_ops);
        END IF;
      END$$;
    `);
        console.log("✅ Trigram indexes ready");
        // 4️⃣ Create trigger function to auto-update tsvector column
        console.log("➡️ Step 4: Creating trigger function...");
        await prisma_1.default.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION update_tsvector_col() RETURNS trigger AS $$
      BEGIN
        NEW.tsvector_col := to_tsvector(
          'english',
          coalesce(NEW.name,'') || ' ' || coalesce(NEW.description,'')
        );
        RETURN NEW;
      END
      $$ LANGUAGE plpgsql;
    `);
        console.log("✅ Trigger function ready");
        // 5️⃣ Attach trigger to Product table
        console.log("➡️ Step 5: Attaching trigger...");
        await prisma_1.default.$executeRawUnsafe(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_trigger WHERE tgname = 'trigger_update_tsvector_col'
        ) THEN
          CREATE TRIGGER trigger_update_tsvector_col
          BEFORE INSERT OR UPDATE ON "Product"
          FOR EACH ROW EXECUTE FUNCTION update_tsvector_col();
        END IF;
      END$$;
    `);
        console.log("✅ Trigger attached");
        // 6️⃣ Backfill existing rows with tsvector data
        console.log("➡️ Step 6: Backfilling data...");
        const updated = await prisma_1.default.$executeRawUnsafe(`
      UPDATE "Product"
      SET tsvector_col = to_tsvector(
        'english',
        coalesce(name,'') || ' ' || coalesce(description,'')
      )
      WHERE tsvector_col IS NULL;
    `);
        console.log(`✅ Backfill complete (${updated} rows updated)`);
        console.log("🎉 Search setup finished successfully!");
    }
    catch (error) {
        console.error("❌ Error during setupSearch:", error);
        if (require.main === module)
            process.exit(1); // only exit if script is run directly
        else
            throw error; // re-throw if imported
    }
    finally {
        await prisma_1.default.$disconnect();
    }
}
// ✅ Run only if called directly from command line
if (require.main === module) {
    setupSearch().then(() => process.exit(0));
}
// Usage:
// npx ts-node src/lib\setupSearch.ts
