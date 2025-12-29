// import { createClient, RedisClientType } from "redis";

// // Parse the REDIS_URL for TLS / host info
// if (!process.env.REDIS_URL) {
//   throw new Error("REDIS_URL is not defined in environment variables!");
// }


// /**
//  * Factory function to create a Redis client for a specific DB index.
//  * Handles reconnection automatically.
//  */
// function createRedisClient(db: number): RedisClientType {
//   const client: RedisClientType = createClient({
//     url: process.env.REDIS_URL,
//     database: db,
//     // ⚠️ redis@5+ handles offline queue internally; no extra options needed
//   });

//   client.on("error", (err) => {
//     console.error(`❌ Redis Client Error [DB ${db}]:`, err);
//   });

//   client.on("connect", () => console.log(`🔗 Redis [DB ${db}] connecting...`));
//   client.on("ready", () => console.log(`✅ Redis [DB ${db}] ready`));
//   client.on("end", () => console.warn(`⚠️ Redis [DB ${db}] connection closed`));
//   client.on("reconnecting", () => console.log(`♻️ Redis [DB ${db}] reconnecting...`));

//   return client;
// }

// /**
//  * Redis clients for different purposes
//  */
// export const redisNotifications = createRedisClient(0);
// export const redisProducts = createRedisClient(1);
// export const redisSearch = createRedisClient(2);
// export const redisTotalViews = createRedisClient(3);
// export const redisUsersSessions = createRedisClient(4);
// export const ShopCartRedis = createRedisClient(5);

// /**
//  * Ensure a Redis client is connected (bootstrap helper)
//  */
// export async function connectRedis(client: RedisClientType, label: string) {
//   if (!client.isOpen) {
//     await client.connect();
//     console.log(`✅ Redis connected [${label}]`);
//   }
// }

// /**
//  * Call this once at server startup to connect all Redis DBs
//  */
// export async function ensureRedisReady() {
//   try {
//     await connectRedis(redisNotifications, "Notifications");
//     await connectRedis(redisProducts, "Products");
//     await connectRedis(redisSearch, "Search");
//     await connectRedis(redisTotalViews, "TotalViews");
//     await connectRedis(redisUsersSessions, "UserSessions"); 
//     await connectRedis(ShopCartRedis, "shopCart");

//     // sanity check
//     await redisNotifications.ping();
//     console.log("✅ All Redis clients are ready");
//   } catch (err) {
//     console.error("❌ Redis connection failed", err);
//     process.exit(1); // fail fast if Redis is not available
//   }
// }




// src/services/redis.ts
import { createClient, RedisClientType } from "redis";

if (!process.env.REDIS_URL) {
  throw new Error("REDIS_URL is not defined in environment variables!");
}

/**
 * Helper to create a Redis client for a specific DB index.
 */
function createRedisClient(db: number): RedisClientType {
  const client: RedisClientType = createClient({
    url: process.env.REDIS_URL,
    database: db,
  });

  // Logging
  client.on("error", (err) => {
    console.error(`❌ Redis Client Error [DB ${db}]:`, err);
  });

  client.on("connect", () =>
    console.log(`🔗 Redis [DB ${db}] connecting...`)
  );

  client.on("ready", () =>
    console.log(`✅ Redis [DB ${db}] ready`)
  );

  client.on("end", () =>
    console.warn(`⚠️ Redis [DB ${db}] connection closed`)
  );

  client.on("reconnecting", () =>
    console.log(`♻️ Redis [DB ${db}] reconnecting...`)
  );

  return client;
}

/**
 * Create Redis instances for different features
 */
export const redisNotifications = createRedisClient(0);
export const redisProducts = createRedisClient(1);
export const redisSearch = createRedisClient(2);
export const redisTotalViews = createRedisClient(3);
export const redisUsersSessions = createRedisClient(4);
export const ShopCartRedis = createRedisClient(5);

/**
 * Connect Redis client if not already connected
 */
export async function connectRedis(client: RedisClientType, label: string) {
  if (!client.isOpen) {
    await client.connect();
    console.log(`🚀 Redis connected [${label}]`);
  }
}

/**
 * Connect all Redis databases at startup
 */
export async function ensureRedisReady() {
  try {
    await connectRedis(redisNotifications, "Notifications");
    await connectRedis(redisProducts, "Products");
    await connectRedis(redisSearch, "Search");
    await connectRedis(redisTotalViews, "TotalViews");
    await connectRedis(redisUsersSessions, "UserSessions");
    await connectRedis(ShopCartRedis, "ShopCart");

    // Health check
    await redisNotifications.ping();
    console.log("✅ All Redis DBs connected and ready");
  } catch (err) {
    console.error("❌ Redis initialization failed:", err);
    process.exit(1); // Stop server if Redis is not available
  }
}
