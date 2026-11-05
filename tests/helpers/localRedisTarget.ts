/**
 * Safety gate for the real-Redis OTP integration suite.
 *
 * The suite in tests/integration/redis executes the production ISSUE_LUA and
 * VERIFY_LUA and then writes and deletes keys. That is harmless against a
 * throwaway server on loopback and unacceptable against anything else — the
 * application's configured REDIS_URL is a shared production instance.
 *
 * This module therefore refuses anything it cannot PROVE is a local,
 * disposable, non-default Redis. It never inspects the ambient REDIS_URL to
 * decide what is safe; it only uses it to reject a candidate that resolves to
 * the same endpoint. Nothing here performs I/O, and no credential is ever
 * included in a returned reason.
 */

/** Host spellings that can only mean this machine (before canonicalization). */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]", "0:0:0:0:0:0:0:1"]);

/** Canonical identity shared by every loopback spelling. */
const CANONICAL_LOOPBACK = "loopback";

function isLoopbackIPv4(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4 || parts[0] !== "127") return false;
  return parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

/**
 * Map every loopback spelling to one canonical identity so that
 * `127.0.0.1`, `localhost`, `127.0.0.2` and `::1` compare equal without any
 * DNS lookup or network access. Anything else is returned unchanged
 * (lowercased, brackets/trailing dots stripped) so remote hosts never
 * collapse onto each other.
 */
function normaliseHostname(host: string): string {
  let h = host.toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  h = h.replace(/\.+$/, "");
  if (h === "localhost" || h === "::1" || h === "0:0:0:0:0:0:0:1" || isLoopbackIPv4(h)) {
    return CANONICAL_LOOPBACK;
  }
  return h;
}

/** True for this machine's loopback in any spelling (no DNS, no I/O). */
function isLoopback(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.toLowerCase()) || normaliseHostname(host) === CANONICAL_LOOPBACK;
}

export interface DisposableRedisTarget {
  ok: boolean;
  /** Normalised connection string, safe to hand to createClient. */
  url: string;
  /** Why the candidate was refused. Never contains a credential. */
  reason?: string;
  /** Human-readable description of what was accepted. */
  description?: string;
}

/**
 * Decide whether `candidate` is a local disposable Redis.
 *
 * Refuses, in order: unset value, unparseable value, a scheme other than
 * plain `redis:` (TLS implies a managed remote endpoint), any non-loopback
 * host, database index 0 or absent (the default DB a developer's own server
 * may be using for unrelated work), and any candidate that resolves to the
 * same host and port as the ambient REDIS_URL.
 */
export function evaluateDisposableRedisTarget(candidate: string | undefined): DisposableRedisTarget {
  if (!candidate || !candidate.trim()) {
    return refuse(
      "OTP_TEST_REDIS_URL is not set. Point it at a disposable Redis on loopback, " +
        "e.g. redis://127.0.0.1:6399/15. It must never be the application's REDIS_URL.",
    );
  }

  const raw = candidate.trim();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return refuse(`${raw} is not a parseable connection string.`);
  }

  if (url.protocol !== "redis:") {
    return refuse(
      `scheme ${url.protocol}// is not allowed. Only plain redis:// on loopback is permitted; ` +
        "a TLS endpoint indicates a managed service, not a disposable test instance.",
    );
  }

  const host = url.hostname.toLowerCase();
  if (!isLoopback(host)) {
    return refuse(
      `host ${host} is not a loopback address. This suite may only run against a Redis ` +
        "on the local machine.",
    );
  }

  const port = url.port || "6379";
  const dbIndex = Number(url.pathname.replace(/^\//, "") || "0");
  if (!Number.isInteger(dbIndex) || dbIndex < 1) {
    return refuse(
      `database ${dbIndex} is not allowed. Use a dedicated non-default database index ` +
        "(the path in the URL, e.g. /15) so no unrelated data is ever reachable.",
    );
  }

  // Last line of defence: never the application's own endpoint. An endpoint
  // is host AND port after canonicalizing loopback spellings, so a genuinely
  // distinct local server (different port) is accepted while an alias spelling
  // of the same server (127.0.0.2 vs 127.0.0.1, localhost vs 127.0.0.1) is
  // still refused. Hostname alone proves nothing in either direction.
  const ambient = process.env.REDIS_URL;
  if (ambient) {
    try {
      const ambientUrl = new URL(ambient.trim());
      const ambientHost = ambientUrl.hostname.toLowerCase();
      const ambientPort = ambientUrl.port || "6379";
      if (normaliseHostname(ambientHost) === normaliseHostname(host) && ambientPort === port) {
        return refuse("this endpoint is the same as the application's REDIS_URL, which is shared infrastructure.");
      }
    } catch {
      // An unparseable REDIS_URL cannot be compared; the loopback and
      // non-default-database checks above still stand.
    }
  }

  return {
    ok: true,
    url: raw,
    description: `local Redis at ${host}:${port}, database ${dbIndex}`,
  };
}

function refuse(reason: string): DisposableRedisTarget {
  return { ok: false, url: "", reason };
}

/**
 * Prefix every key this suite creates, so cleanup can delete exactly what it
 * wrote and nothing else. Includes the process id so two concurrent runs
 * cannot collide.
 */
export function redisTestNamespace(suffix: string): string {
  return `otp:itest:${process.pid}:${suffix}`;
}