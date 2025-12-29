// src/jobs/getSearchAnalytics.ts
import "dotenv/config";
import { redisSearch } from "../../lib/redis";
import fs from "fs";

/**
 * Fetch all search keywords stored in Redis.
 */
async function getAllSearchKeywords(): Promise<string[]> {
  // Fetch all keys with pattern search:*:hits
  const keys = await redisSearch.keys("search:*:hits");
  // Extract the keyword part from each key
  return keys.map((key) => key.replace(/^search:(.*):hits$/, "$1"));
}

/**
 * Gather analytics for a list of keywords.
 */
async function getSearchAnalytics(keywords: string[]) {
  const analytics: Record<
    string,
    {
      totalSearches: number;
      perUser: Record<string, number>;
    }
  > = {};

  for (const keyword of keywords) {
    const redisKey = `search:${keyword}:hits`;
    const perUserRaw = await redisSearch.hGetAll(redisKey);

    const perUser: Record<string, number> = {};
    let totalSearches = 0;

    for (const userId in perUserRaw) {
      const count = parseInt(perUserRaw[userId]);
      perUser[userId] = count;
      totalSearches += count;
    }

    analytics[keyword] = { totalSearches, perUser };
  }

  return analytics;
}

// ─── Run script ─────────────────────────────────────────────
async function main() {
  if (!process.env.REDIS_URL) {
    console.error("❌ REDIS_URL not set in environment variables");
    process.exit(1);
  }

  try {
    // ✅ Connect Redis client first
    await redisSearch.connect();

    // dynamically fetch all keywords
    const keywords = await getAllSearchKeywords();

    if (keywords.length === 0) {
      console.log("No search keywords found in Redis.");
      return;
    }

    const data = await getSearchAnalytics(keywords);

    // save to JSON file
    fs.writeFileSync("searchAnalytics.json", JSON.stringify(data, null, 2));

    console.log("✅ Search analytics saved to searchAnalytics.json");
    console.log(data);
  } catch (err) {
    console.error("Fatal error:", err);
  } finally {
    // ✅ Quit Redis safely
    if (redisSearch.isOpen) await redisSearch.quit();
  }
}

main();




// npx ts-node src/jobs/getSearchAnalytics.ts
