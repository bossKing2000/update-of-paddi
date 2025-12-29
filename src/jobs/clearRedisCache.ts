import "dotenv/config";
import {redisNotifications,redisProducts,redisSearch,redisTotalViews,redisUsersSessions,ShopCartRedis,} from "../lib/redis";

async function clearAllCaches() {
  try {
    // Ensure all connections are open
    for (const client of [
      redisProducts,
      redisNotifications,
      redisSearch,
      redisTotalViews,
      redisUsersSessions,
      ShopCartRedis,
    ]) {
      if (!client.isOpen) {
        await client.connect();
      }
    }

    // Define clients with labels
    const clients = [
      { name: "products", client: redisProducts },
      { name: "notifications", client: redisNotifications },
      { name: "search", client: redisSearch },
      { name: "views", client: redisTotalViews },
      // { name: "userSessions", client: redisUsersSessions},
      { name: "shopCart", client: ShopCartRedis}
    ];

    for (const { name, client } of clients) {
      await client.flushDb(); // clears everything in that DB
      console.log(`🧹 Cleared ALL keys from ${name} cache`);
    }

    console.log("✅ All Redis caches fully cleared!");
  } catch (err) {
    console.error("❌ Failed to clear Redis caches", err);
  } finally {
    // Close all clients
    for (const client of [
      redisProducts,
      redisNotifications,
      redisSearch,
      redisTotalViews,
    ]) {
      if (client.isOpen) {
        await client.quit();
      }
    }
  }
}

clearAllCaches();

// Run with: npx ts-node src/jobs/clearRedisCache.ts


 