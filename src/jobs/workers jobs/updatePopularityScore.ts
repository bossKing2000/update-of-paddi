import prisma from "../../lib/prisma";
import { redisProducts, redisTotalViews } from "../../lib/redis";
import fs from "fs";
import path from "path";
import { CACHE_KEYS } from "../../services/redisCacheTiming";

// ─── Job configuration ───────────────────────────────────────
const BATCH_SIZE = 500;
const CONCURRENT_UPDATES = 10;
const RESUME_FILE = path.join(__dirname, "lastProcessed.json");
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;

// ─── Interfaces ─────────────────────────────────────────────
interface ProductBatchItem {
  id: string;
  createdAt: Date;
  popularityUpdatedAt: Date | null;
}

// ─── Helpers ────────────────────────────────────────────────
async function getLastProcessedId(): Promise<string | null> {
  try {
    const data = fs.readFileSync(RESUME_FILE, "utf-8");
    return JSON.parse(data).lastId ?? null;
  } catch {
    return null;
  }
}

async function saveLastProcessedId(lastId: string) {
  fs.writeFileSync(RESUME_FILE, JSON.stringify({ lastId }));
}

function delay(ms: number) {
  return new Promise((res) => setTimeout(res, ms));
}

async function safeExecute<T>(fn: () => Promise<T>, retries = MAX_RETRIES): Promise<T> {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      attempt++;
      if (attempt > retries) throw err;
      console.warn(
        `⚠️ Retry ${attempt}/${retries} after error:`,
        err instanceof Error ? err.message : err
      );
      await delay(RETRY_DELAY_MS * attempt);
    }
  }
}

async function delPattern(pattern: string) {
  const keys = await redisProducts.keys(pattern);
  if (keys.length > 0) await redisProducts.del(keys);
}

// ─── Cancellation ───────────────────────────────────────────
let shouldAbort = false;
export function cancelPopularityJob() {
  shouldAbort = true;
}

// ─── Reset Function ───────────────────────────────
export async function resetPopularityJob() {
  if (fs.existsSync(RESUME_FILE)) fs.unlinkSync(RESUME_FILE);
  await redisProducts.del("job:popularity:progress");
  await redisProducts.del("global:popularity:max");

  return {
    message: "Popularity job reset successfully. Next run will start from the beginning.",
  };
}

// ─── Main Popularity Update ─────────────────────────────────
export async function updatePopularityScores() {
  shouldAbort = false; // reset at start

  const totalProducts = await prisma.product.count();
  let lastId = await getLastProcessedId();
  let inMemoryMaxScore = 0;
  let inMemoryMinScore = Infinity;

  let alreadyProcessed = 0;
  if (lastId) {
    alreadyProcessed = await prisma.product.count({
      where: { id: { lte: lastId } },
    });
  }

  let totalProductsProcessed = alreadyProcessed;
  console.log(`Total products: ${totalProducts}`);
  if (lastId) console.log(`Resuming from last processed ID: ${lastId} (already processed: ${alreadyProcessed})`);

  // ─── PHASE 1: Compute all popularityScores ───────────────
  while (true) {
    if (shouldAbort) {
      console.log("⛔ Popularity job aborted!");
      break;
    }

    const productsBatch: ProductBatchItem[] = await prisma.product.findMany({
      take: BATCH_SIZE,
      where: lastId ? { id: { gt: lastId } } : {},
      orderBy: { id: "asc" },
      select: { id: true, createdAt: true, popularityUpdatedAt: true },
    });

    if (productsBatch.length === 0) break;

    const productIds = productsBatch.map((p) => p.id);

    const productTotals = await prisma.product.findMany({
      where: { id: { in: productIds } },
      select: { id: true, totalViews: true },
    });
    const totalViewsMap = new Map(productTotals.map((t) => [t.id, t.totalViews ?? 0]));

    const orderGroups = await prisma.orderItem.groupBy({
      by: ["productId"],
      _count: { productId: true },
      where: { productId: { in: productIds } },
    });
    const orderCountMap = new Map(orderGroups.map((g) => [(g as any).productId, (g as any)._count.productId ?? 0]));

    const reviewGroups = await prisma.productReview.groupBy({
      by: ["productId"],
      _avg: { rating: true },
      _count: { productId: true },
      where: { productId: { in: productIds } },
    });
    const reviewMap = new Map<string, { avgRating: number; reviewCount: number }>(
      reviewGroups.map((r) => {
        const pid = (r as any).productId as string;
        return [pid, { avgRating: (r as any)._avg.rating ?? 0, reviewCount: (r as any)._count.productId ?? 0 }];
      })
    );

    let didInvalidateListingCachesThisBatch = false;

    for (let i = 0; i < productsBatch.length; i += CONCURRENT_UPDATES) {
      if (shouldAbort) break;
      const batchSlice = productsBatch.slice(i, i + CONCURRENT_UPDATES);

      await Promise.all(
        batchSlice.map(async (p) => {
          if (shouldAbort) return;

          try {
            const redisTotalKey = `product:${p.id}:views:total`;
            const totalViewsFromRedis = await redisTotalViews.get(redisTotalKey);
            const totalViewsIncrement = parseInt(totalViewsFromRedis || "0");

            const currentTotalViews = totalViewsMap.get(p.id) ?? 0;
            const totalViewsAllTime = currentTotalViews + totalViewsIncrement;

            const orderCount = orderCountMap.get(p.id) ?? 0;
            const reviewAgg = reviewMap.get(p.id) ?? { avgRating: 0, reviewCount: 0 };

            const daysSinceCreation = (Date.now() - p.createdAt.getTime()) / (1000 * 60 * 60 * 24);

            const popularityScore =
              totalViewsAllTime * 0.1 +
              orderCount * 2 +
              reviewAgg.avgRating * reviewAgg.reviewCount * 5 +
              Math.max(0, 30 - daysSinceCreation);

            inMemoryMaxScore = Math.max(inMemoryMaxScore, popularityScore);
            inMemoryMinScore = Math.min(inMemoryMinScore, popularityScore);

            await safeExecute(() =>
              prisma.product.update({
                where: { id: p.id },
                data: {
                  totalViews: { increment: totalViewsIncrement },
                  popularityScore,
                  averageRating: reviewAgg.avgRating,
                  reviewCount: reviewAgg.reviewCount,
                  popularityUpdatedAt: new Date(),
                },
              })
            );

            await redisTotalViews.del(redisTotalKey);
            await redisProducts.del(CACHE_KEYS.PRODUCT_DETAIL(p.id));

            if (!didInvalidateListingCachesThisBatch) {
              await delPattern("products:all:*");
              await delPattern("search:*");
              await delPattern("products:mostPopular:*");
              didInvalidateListingCachesThisBatch = true;
            }

            totalProductsProcessed++;
            const percent = (totalProductsProcessed / totalProducts) * 100;
            await redisProducts.set(
              "job:popularity:progress",
              JSON.stringify({ total: totalProducts, processed: totalProductsProcessed, percent: parseFloat(percent.toFixed(2)) }),
              { EX: 60 * 5 }
            );

            process.stdout.write(
              `\rProgress: ${totalProductsProcessed}/${totalProducts} (${percent.toFixed(2)}%)`
            );

            await saveLastProcessedId(p.id);
          } catch (err) {
            console.error(`❌ Failed processing product ${p.id}:`, err);
          }
        })
      );
    }

    lastId = productsBatch[productsBatch.length - 1].id;
    await saveLastProcessedId(lastId);
  }

  // ─── PHASE 2: Compute global popularityPercent ─────────────
  // ─── PHASE 2: Compute global popularityPercent ─────────────
try {
  console.log("\n🔄 Starting Phase 2: Finalizing popularityPercent...");

  // Reset all popularityPercent to 0 before recalculation
  await prisma.$executeRawUnsafe(`UPDATE "Product" SET "popularityPercent" = 0;`);
  console.log("✅ Reset all popularityPercent to 0");

  // Get global min/max popularityScore from DB
  const agg = await prisma.product.aggregate({
    _max: { popularityScore: true },
    _min: { popularityScore: true },
  });
  const dbMaxScore = agg._max.popularityScore ?? inMemoryMaxScore;
  const dbMinScore = agg._min.popularityScore ?? inMemoryMinScore;

  console.log(`💡 Global popularityScore range: min=${dbMinScore}, max=${dbMaxScore}`);

  if (dbMaxScore > 0) {
    // Logarithmic scaling: compresses high outliers, keeps zero-score safe
  await prisma.$executeRaw`
  UPDATE "Product"
  SET "popularityPercent" = LEAST(
    99.9,
    ROUND(
      (LN("popularityScore" + 1)::numeric / LN(${dbMaxScore} + 1)::numeric) * 100,
      2
    )
  )
  WHERE "popularityScore" IS NOT NULL;
`;

    console.log("✅ popularityPercent updated using logarithmic scaling");
  } else {
    await prisma.$executeRaw`UPDATE "Product" SET "popularityPercent" = 0;`;
    console.log("⚠️ All popularityPercent set to 0 (no scores found)");
  }

  // Cache max popularityScore for frontend or other jobs
  await redisProducts.set("global:popularity:max", String(dbMaxScore), { EX: 60 * 5 });

  // Invalidate caches
  console.log("♻️  Clearing relevant Redis caches...");
  await delPattern("products:mostPopular:*");
  await delPattern("products:all:*");
  await delPattern("product:*:views:*"); // clear any per-product view totals
  console.log("✅ Relevant Redis caches cleared");

  // Cleanup resume file if exists
  if (fs.existsSync(RESUME_FILE)) fs.unlinkSync(RESUME_FILE);
  console.log("🗑️ Resume file cleaned up");

  console.log("\n✅ Phase 2 complete: popularity scores & percents finalized successfully");
} catch (err) {
  console.error("❌ Phase 2 failed:", err);
}

}



// npx ts-node src\jobs\workers jobs\updatePopularityScore.ts
