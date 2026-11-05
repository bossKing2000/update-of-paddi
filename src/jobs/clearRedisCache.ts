/**
 * Standalone Redis cache-clearing maintenance script.
 *
 * Run with: npx ts-node src/jobs/clearRedisCache.ts
 *
 * ── Why this does not use flushDb() ────────────────────────────────────────
 * Task 7.44 found that the previous version called `flushDb()` on every client
 * it was given. `FLUSHDB` deletes a whole logical database regardless of key
 * name, so on `redisNotifications` (logical database 0) it would also have
 * deleted the BullMQ queue state that shares that database (`bull:*`), and on
 * `redisUsersSessions` it would have destroyed live login sessions and the
 * refresh-token replay guard.
 *
 * The script now deletes ONLY explicitly named, disposable cache namespaces,
 * and refuses to touch the databases whose contents are operational state.
 *
 * ── What counts as disposable here ──────────────────────────────────────────
 * A namespace is cleared only when its entries are TTL-bounded read-through
 * caches that the application rebuilds on demand. Anything holding user-visible
 * state, analytics, sessions, queues or notifications is left alone.
 */
import "dotenv/config";
import { redisProducts, ShopCartRedis } from "../lib/redis";
import { scanKeys } from "../lib/redisScan";
import type { RedisClientType } from "redis";

/**
 * Clients this script deliberately does NOT touch, with the evidence for each.
 *
 * These are skipped rather than cleared because their namespaces could not be
 * established as disposable with confidence. Each entry names the concrete data
 * at risk.
 */
export const SKIPPED_CLIENTS: ReadonlyArray<{ name: string; reason: string }> = [
  {
    name: "notifications",
    reason:
      "Database 0 holds `notifications:*` and `notif:unread:*` (user-visible notification state) " +
      "AND shares the database with BullMQ's `bull:*` queue keys. Never swept from here.",
  },
  {
    name: "userSessions",
    reason:
      "Database 4 holds `session:user:*` plus the refresh-token JTI and previous-JTI keys " +
      "(src/lib/session.ts). These are ACTIVE LOGIN SESSIONS and the refresh-replay guard; " +
      "clearing them logs every user out and weakens replay protection.",
  },
  {
    name: "search",
    reason:
      "Database 2 holds `search:*:hits` per-user hashes written with hIncrBy and a 7-day TTL " +
      "(product.service.ts:212-213), consumed by getSearchAnalytics. Analytics, not a cache.",
  },
  {
    name: "totalViews",
    reason:
      "Database 3 holds `product:*:views:total` counters with a 24-hour TTL " +
      "(product.service.ts:195-201). Accumulated counters, not a rebuildable cache.",
  },
];

/**
 * Keys that live in a database this script DOES sweep but that are deliberately
 * left in place. Recorded so the omissions are intentional and reviewable
 * rather than accidental. Do NOT add these to CACHE_SWEEPS without a separate
 * review establishing that clearing them is safe.
 */
export const INTENTIONALLY_RETAINED: ReadonlyArray<{ key: string; reason: string }> = [
  {
    key: "global:popularity:max",
    reason:
      "Popularity-score ceiling on redisProducts (updatePopularityScore.ts:262). A 5-minute " +
      "cache, but it is not part of the product-listing cache family and is cheap to leave in " +
      "place; widening the sweep to reach it is not justified by this task.",
  },
  {
    key: "cart:product:<id>:users",
    reason:
      "Cart index on redisProducts (product.service.ts:160) — note it is NOT on ShopCartRedis. " +
      "It maps a product to the users whose carts contain it. Out of scope here; clearing it " +
      "needs its own review because it is cart-derived state, not a listing cache.",
  },
  {
    key: "job:popularity:progress",
    reason:
      "Live popularity-job progress marker (server.ts:322, updatePopularityScore.ts:71). It is " +
      "a running-job signal rather than cache, so it must survive a cache clear.",
  },
];

/**
 * Redis glob metacharacters. A sweep pattern is built as `${prefix}*` and fed to
 * SCAN MATCH, then the returned keys are re-checked with `key.startsWith(prefix)`.
 * Those two are only equivalent while the prefix itself is free of glob syntax:
 * otherwise MATCH could match (or exclude) keys the literal check disagrees with.
 * `assertGlobSafePrefixes` enforces that before anything is scanned or deleted.
 */
export const GLOB_METACHARACTERS: readonly string[] = ["*", "?", "[", "]", "\\"];

export function isGlobSafePrefix(prefix: string): boolean {
  return prefix.length > 0 && !GLOB_METACHARACTERS.some((c) => prefix.includes(c));
}

/** Throws before any scan or delete if a prefix is empty or contains glob syntax. */
export function assertGlobSafePrefixes(prefixes: readonly string[]): void {
  const unsafe = prefixes.filter((p) => !isGlobSafePrefix(p));
  if (unsafe.length > 0) {
    throw new Error(
      `Refusing to sweep: prefix(es) are empty or contain Redis glob metacharacters ` +
        `(${GLOB_METACHARACTERS.join(" ")}): ${JSON.stringify(unsafe)}`,
    );
  }
}

/**
 * The complete set of namespaces this script is allowed to delete.
 *
 * Each entry is a key PREFIX. Deletion requires a key to start with its own
 * sweep's prefix, so a key is only ever removed by the sweep that owns it.
 */
export const CACHE_SWEEPS: ReadonlyArray<{
  name: string;
  client: RedisClientType;
  prefixes: readonly string[];
}> = [
  {
    name: "products",
    client: redisProducts,
    // All from CACHE_KEYS / CACHE_TTLS (src/services/redisCacheTiming.ts), every
    // entry TTL-bounded and recomputed on the next request.
    //
    // On `product:` specifically: the only `product:*` key written to THIS client
    // is PRODUCT_DETAIL (`product:<id>:detail`). The view counter
    // `product:<id>:views:total` lives in logical database 3, which this script
    // never connects to, and PROTECTED_FRAGMENTS additionally refuses any
    // `:views:` / `:hits` key even if it were somehow reachable here.
    prefixes: [
      "products:",
      "product:",
      "categories:",
      "tags:",
      "dishtypes:",
      "home:",
      "vendor:",
      // Task 7.47. `promotions:active:product` (promotionPricing.service.ts:50)
      // is a 60-second derived cache written only to redisProducts and rebuilt
      // from `prisma.promotion.findMany` on a miss (:254), so the database stays
      // authoritative and clearing it is safe. The prefix is the FULL key rather
      // than a bare `promotions:` on purpose: `promotions:` is the only other
      // literal in src/, but narrowing keeps any future non-cache key in that
      // namespace out of this sweep by default.
      "promotions:active:product",
    ],
  },
  {
    name: "shopCart",
    client: ShopCartRedis,
    // `cart:user:v2:<id>` (current) and legacy `cart:user:<id>` entries. Both
    // are written with CART_TTL_SECONDS and rebuilt from the database on a
    // miss, so they are disposable. Keeping the shared prefix means this
    // maintenance sweep continues to clear old and versioned formats.
    prefixes: ["cart:user:"],
  },
];

/**
 * Key fragments that mark NON-cache data even when the key happens to sit under
 * an approved cache prefix.
 *
 * The `product:` cache prefix is the one broad prefix above. The only `product:*`
 * key written to redisProducts is PRODUCT_DETAIL, but `product:<id>:views:total`
 * is a view counter (product.service.ts:195-201). It normally lives in logical
 * database 3, which this script never connects to — but if that ever changed,
 * the prefix alone would let this script delete a counter. These fragments make
 * the protection intrinsic to the script rather than dependent on database
 * separation.
 */
export const PROTECTED_FRAGMENTS: readonly string[] = [":views:", ":hits"];

/**
 * Delete the approved cache namespaces for one client.
 *
 * Validates the prefixes FIRST, so an unsafe prefix aborts before any SCAN or
 * DEL runs. Then scans with a MATCH per prefix (so Redis, not this file, bounds
 * the result set), re-validates every returned key against this sweep's own
 * prefixes AND against the protected fragments, and deletes in batches.
 */
export async function sweepCacheNamespace(sweep: {
  name: string;
  client: RedisClientType;
  prefixes: readonly string[];
}): Promise<{ deleted: number; scanned: number }> {
  const { client, prefixes } = sweep;

  // Fail closed BEFORE touching Redis. An unsafe prefix must never reach SCAN.
  assertGlobSafePrefixes(prefixes);

  let scanned = 0;
  let deleted = 0;

  for (const prefix of prefixes) {
    const keys = await scanKeys(client, `${prefix}*`);

    // Defence in depth: never hand back anything this sweep does not own, and
    // never anything carrying a protected non-cache marker. This holds even if a
    // future caller passed a client or pattern we did not expect.
    const owned = keys.filter(
      (key) =>
        prefixes.some((p) => key.startsWith(p)) &&
        !PROTECTED_FRAGMENTS.some((fragment) => key.includes(fragment)),
    );
    scanned += keys.length;

    for (let i = 0; i < owned.length; i += 200) {
      const batch = owned.slice(i, i + 200);
      if (batch.length === 0) continue;
      deleted += await client.del(batch);
    }
  }

  return { deleted, scanned };
}

/**
 * How long cleanup waits for the graceful `close()` fallback before forcing the
 * client down with `destroy()`.
 *
 * `close()` in @redis/client 5.10.0 resolves only once the command queue drains
 * (client/index.js:919-932). If a command never settles after a rejected QUIT,
 * awaiting it would block the fallback — and therefore the whole cleanup pass —
 * for as long as the socket stays open. This is a one-shot local CLI talking to
 * a loopback Redis, where a healthy QUIT is answered in well under a
 * millisecond, so a two-second ceiling is generous while still bounded.
 */
export const CLOSE_TIMEOUT_MS = 2000;

type CloseOutcome = "settled" | "rejected" | "timed-out";

/**
 * Wait for `work`, but no longer than `ms`.
 *
 * The timeout does NOT cancel `work` — JavaScript has no promise cancellation.
 * Handlers are therefore attached to the ORIGINAL promise immediately, so if it
 * later rejects after this race has already been decided, that rejection is
 * consumed rather than surfacing as an unhandled rejection. The timer is
 * cleared and unref'd so a pending guard can never keep this CLI alive.
 */
async function settleWithin(work: Promise<unknown>, ms: number): Promise<CloseOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  // Consume both outcomes on the original promise; `guarded` never rejects, so
  // the race below always resolves and cannot produce an unhandled rejection.
  const guarded = work.then(
    () => "settled" as const,
    () => "rejected" as const,
  );

  const timeout = new Promise<"timed-out">((resolve) => {
    timer = setTimeout(() => resolve("timed-out"), ms);
    timer.unref?.();
  });

  try {
    return await Promise.race([guarded, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Close every client that is open, independently. Returns true if any graceful
 * OR fallback cleanup failed.
 *
 * One client's quit() rejecting must not prevent the others from being closed,
 * so each attempt is isolated and reported.
 *
 * If quit() rejects, the run is already marked failed even when a fallback
 * manages to close the socket — a rejected graceful close is a real failure, not
 * a formality.
 *
 * Fallbacks use only methods supported by the installed client
 * (@redis/client 5.10.0, verified against its source):
 *   - `close()`   — clears the ping timer and destroys the socket once the
 *                   command queue drains. Preferred first fallback, and BOUNDED
 *                   so a stuck queue cannot block `destroy()`.
 *   - `destroy()` — synchronous; flushes the queue and destroys the socket.
 *                   Used when `close()` rejects, times out, or leaves the client
 *                   open.
 * `disconnect()` is deliberately NOT used: it is deprecated in this version.
 */
async function closeAllSweepClients(closeTimeoutMs: number = CLOSE_TIMEOUT_MS): Promise<boolean> {
  let failed = false;

  for (const sweep of CACHE_SWEEPS) {
    if (!sweep.client.isOpen) continue;
    try {
      await sweep.client.quit();
    } catch (err) {
      // Report the ORIGINAL failure first, so a fallback can never mask it.
      failed = true;
      console.error(`❌ Failed to close "${sweep.name}" client gracefully:`, err);

      // Bounded fallback: a rejected QUIT must not leave a socket (and its
      // reconnect machinery) holding the event loop open on this one-shot CLI.
      const outcome = await settleWithin(sweep.client.close(), closeTimeoutMs);

      if (outcome === "timed-out") {
        failed = true;
        console.error(
          `⚠️  Fallback close() for "${sweep.name}" did not settle within ` +
            `${closeTimeoutMs}ms; forcing destroy().`,
        );
      } else if (outcome === "rejected") {
        failed = true;
        console.error(`❌ Fallback close() for "${sweep.name}" also rejected.`);
      }

      // If the socket survived every graceful attempt, destroy it outright.
      if (sweep.client.isOpen) {
        try {
          sweep.client.destroy();
        } catch (destroyErr) {
          failed = true;
          console.error(`❌ Fallback destroy() for "${sweep.name}" also failed:`, destroyErr);
        }
      }
    }
  }

  return failed;
}

export async function clearAllCaches(
  options: { closeTimeoutMs?: number } = {},
): Promise<void> {
  // Names of clients that are confirmed open. Only these are ever swept.
  const opened = new Set<string>();
  // Sticky: any failed connection, sweep or cleanup fails the whole run.
  let failed = false;

  try {
    // Open only the clients this script is allowed to touch. A connection failure
    // is recorded and the run continues, so it cannot bypass the cleanup below.
    for (const sweep of CACHE_SWEEPS) {
      if (sweep.client.isOpen) {
        opened.add(sweep.name);
        continue;
      }
      try {
        await sweep.client.connect();
        opened.add(sweep.name);
      } catch (err) {
        failed = true;
        console.error(
          `❌ Failed to connect "${sweep.name}"; its cache will NOT be swept: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    for (const sweep of CACHE_SWEEPS) {
      // A client whose connection failed is never swept: no scan, no delete.
      if (!opened.has(sweep.name)) {
        console.log(`⏭️  Skipped "${sweep.name}" sweep: client was not connected.`);
        continue;
      }
      try {
        const { deleted, scanned } = await sweepCacheNamespace(sweep);
        console.log(
          `🧹 Cleared ${deleted}/${scanned} "${sweep.name}" cache keys ` +
            `(approved prefixes only; no FLUSHDB)`,
        );
      } catch (err) {
        // Report and continue. Deliberately no fallback to a broader delete.
        failed = true;
        console.error(`❌ Failed to clear "${sweep.name}" cache keys:`, err);
      }
    }

    for (const skipped of SKIPPED_CLIENTS) {
      console.log(`⏭️  Skipped "${skipped.name}": ${skipped.reason}`);
    }
    for (const retained of INTENTIONALLY_RETAINED) {
      console.log(`🔒 Retained "${retained.key}": ${retained.reason}`);
    }
  } finally {
    // Always reached, including when the connect loop or an unexpected error
    // throws. Every open client still gets its own cleanup attempt.
    if (await closeAllSweepClients(options.closeTimeoutMs)) failed = true;
  }

  // Honest exit status. This only ever ESCALATES: it never resets exitCode, so a
  // pre-existing non-zero code from anything else is preserved.
  if (failed) {
    process.exitCode = 1;
    console.error("❌ One or more cache-clear operations FAILED (see above).");
  }
}

// Preserve the original CLI behaviour (`npx ts-node src/jobs/clearRedisCache.ts`
// still runs immediately) while allowing the function to be imported by tests.
if (require.main === module) {
  void clearAllCaches().catch((err) => {
    // An unexpected rejection must still be reported and must still fail the
    // process, rather than depending on Node's unhandled-rejection settings.
    console.error("❌ clearAllCaches rejected unexpectedly:", err);
    process.exitCode = 1;
  });
}