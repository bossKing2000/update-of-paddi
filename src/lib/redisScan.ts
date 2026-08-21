import type { RedisClientType } from "redis";

/**
 * Non-blocking equivalent of `client.keys(pattern)`.
 *
 * KEYS scans the entire keyspace in one blocking operation — on a Redis
 * instance with any real amount of data, that's a multi-millisecond (or
 * worse) stall for every other client connected to that instance, every
 * time it's called. SCAN does the same pattern match but walks the
 * keyspace in small non-blocking batches via a cursor, so it never blocks
 * other traffic. Same result, safe at production scale.
 */
export async function scanKeys(
  client: RedisClientType,
  pattern: string,
): Promise<string[]> {
  const found: string[] = [];
  let cursor = "0";

  do {
    const result = await client.scan(cursor, { MATCH: pattern, COUNT: 100 });
    cursor = result.cursor;
    found.push(...result.keys);
  } while (cursor !== "0");

  return found;
}
