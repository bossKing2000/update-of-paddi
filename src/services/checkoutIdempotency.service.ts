import crypto from "crypto";
import { redisPayments } from "../lib/redis";
import { logger } from "../lib/logger";

// Checkout idempotency (mandatory Idempotency-Key header).
//
// Key layout: idem:checkout:{userId}:{key} — scoped by user AND endpoint,
// 24h TTL, claimed atomically with SET NX so two concurrent checkouts with
// the same key cannot both run:
//
// - no record            -> claim in-flight, caller proceeds
// - complete + same hash -> replay: return the stored response, nothing new
// - complete + other hash -> 422 (same key must mean same purchase)
// - in-flight + fresh    -> 409 (still running, poll/retry later)
// - in-flight + stale    -> reclaim (crashed worker must not poison the key)
//
// A failed checkout releases its in-flight claim so retries work. If Redis
// itself is unreachable we fail OPEN (rely on the DB idempotencyKey lookup
// + single-use snapshot) and log — matching this codebase's Redis posture.

const IDEM_TTL_SECONDS = 24 * 3600;
const INFLIGHT_STALE_MS = 5 * 60 * 1000;

type ClaimRecord = {
  status: "in-flight" | "complete";
  payloadHash: string;
  claimedAt: number;
  response?: unknown;
};

export type ClaimOutcome =
  | { action: "proceed" }
  | { action: "proceed-degraded"; reason: string }
  | { action: "replay"; response: unknown }
  | { action: "mismatch" }
  | { action: "conflict" };

const keyFor = (userId: string, idempotencyKey: string) =>
  `idem:checkout:${userId}:${idempotencyKey}`;

/** Canonical fingerprint of what is being bought (NOT who/when). */
export function checkoutPayloadHash(input: { summaryId: string; addressId: string }): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify({ summaryId: input.summaryId, addressId: input.addressId }))
    .digest("hex");
}

function parseRecord(raw: string | null): ClaimRecord | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as ClaimRecord;
    if (parsed && (parsed.status === "in-flight" || parsed.status === "complete") && typeof parsed.payloadHash === "string") {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

export async function claimCheckoutKey(
  userId: string,
  idempotencyKey: string,
  payloadHash: string,
): Promise<ClaimOutcome> {
  const key = keyFor(userId, idempotencyKey);
  const now = Date.now();

  try {
    const existing = parseRecord(await redisPayments.get(key));

    if (!existing) {
      const record: ClaimRecord = { status: "in-flight", payloadHash, claimedAt: now };
      const setResult = await redisPayments.set(key, JSON.stringify(record), { NX: true, EX: IDEM_TTL_SECONDS });
      if (setResult === "OK") return { action: "proceed" };
      // Lost the race (or a non-NX-aware stub) — re-read and adjudicate.
      const raced = parseRecord(await redisPayments.get(key));
      if (!raced) return { action: "proceed-degraded", reason: "idempotency store unavailable" };
      return adjudicate(raced, payloadHash, key, now);
    }

    return adjudicate(existing, payloadHash, key, now);
  } catch (err) {
    logger.warn({ err, userId }, "Idempotency claim failed (fail-open)");
    return { action: "proceed-degraded", reason: "idempotency store unavailable" };
  }
}

async function adjudicate(
  existing: ClaimRecord,
  payloadHash: string,
  key: string,
  now: number,
): Promise<ClaimOutcome> {
  if (existing.status === "complete") {
    if (existing.payloadHash === payloadHash) {
      return { action: "replay", response: existing.response ?? { orders: [] } };
    }
    return { action: "mismatch" };
  }

  // In-flight: fresh means another attempt is running right now.
  if (now - existing.claimedAt < INFLIGHT_STALE_MS) {
    return { action: "conflict" };
  }

  // Stale in-flight (crashed worker): reclaim so the key is not poisoned.
  const record: ClaimRecord = { status: "in-flight", payloadHash, claimedAt: now };
  await redisPayments.set(key, JSON.stringify(record), { EX: IDEM_TTL_SECONDS });
  return { action: "proceed" };
}

/** Mark the key complete with the response to replay on retries. */
export async function completeCheckoutKey(
  userId: string,
  idempotencyKey: string,
  payloadHash: string,
  response: unknown,
): Promise<void> {
  const record: ClaimRecord = { status: "complete", payloadHash, claimedAt: Date.now(), response };
  await redisPayments
    .set(keyFor(userId, idempotencyKey), JSON.stringify(record), { EX: IDEM_TTL_SECONDS })
    .catch((err) => logger.warn({ err, userId }, "Failed to mark idempotency complete (DB fallback still applies)"));
}

/** Release an in-flight claim after a failed checkout so retries proceed. */
export async function releaseCheckoutKey(userId: string, idempotencyKey: string): Promise<void> {
  await redisPayments.del(keyFor(userId, idempotencyKey)).catch((err) => {
    logger.warn({ err, userId }, "Failed to release idempotency claim");
  });
}
