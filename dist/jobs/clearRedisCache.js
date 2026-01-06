"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const redis_1 = require("../lib/redis");
async function clearAllCaches() {
    try {
        // Ensure all connections are open
        for (const client of [
            redis_1.redisProducts,
            redis_1.redisNotifications,
            redis_1.redisSearch,
            redis_1.redisTotalViews,
            redis_1.redisUsersSessions,
            redis_1.ShopCartRedis,
        ]) {
            if (!client.isOpen) {
                await client.connect();
            }
        }
        // Define clients with labels
        const clients = [
            { name: "products", client: redis_1.redisProducts },
            { name: "notifications", client: redis_1.redisNotifications },
            { name: "search", client: redis_1.redisSearch },
            { name: "views", client: redis_1.redisTotalViews },
            // { name: "userSessions", client: redisUsersSessions},
            { name: "shopCart", client: redis_1.ShopCartRedis }
        ];
        for (const { name, client } of clients) {
            await client.flushDb(); // clears everything in that DB
            console.log(`🧹 Cleared ALL keys from ${name} cache`);
        }
        console.log("✅ All Redis caches fully cleared!");
    }
    catch (err) {
        console.error("❌ Failed to clear Redis caches", err);
    }
    finally {
        // Close all clients
        for (const client of [
            redis_1.redisProducts,
            redis_1.redisNotifications,
            redis_1.redisSearch,
            redis_1.redisTotalViews,
        ]) {
            if (client.isOpen) {
                await client.quit();
            }
        }
    }
}
clearAllCaches();
// Run with: npx ts-node src/jobs/clearRedisCache.ts
