// One definition of "which client is this", shared by every layer that
// rate-limits by origin.
//
// Phase 1D.39 (F1). A single IPv6 allocation is typically handed to a client
// as a whole /64 or /56, and the client is free to use any address inside
// it. Keying a limit on the raw `req.ip` therefore lets an IPv6 caller mint
// a fresh budget by rotating host bits — the limit becomes decorative for
// exactly the address family that makes it decorative.
//
// express-rate-limit ships `ipKeyGenerator`, which folds an IPv6 address
// down to the start address of a configurable prefix (default /56) using the
// `ip-address` package, and deliberately returns IPv4 addresses UNCHANGED.
// We reuse that implementation rather than inventing a second, subtly
// different truncation, so the middleware store and the Redis-backed OTP
// counters agree on what "same client" means. Express-rate-limit documents
// this same normalisation as the fix for its own ERR_ERL_KEY_GEN_IPV6
// validation.
//
// ## Trust assumption for `req.ip`
//
// `clientRateLimitIdentity` is only as trustworthy as the address handed to
// it. It normalises; it does not authenticate. This application calls it with
// `req.ip`, which Express derives from the socket address and, when
// `app.set("trust proxy", N)` is set, from the X-Forwarded-For chain.
//
// `src/server.ts` sets `trust proxy = 1`, which assumes EXACTLY ONE reverse
// proxy in front of the app (Render's edge). Under that assumption
// `req.ip` is the address the proxy observed, and a client cannot forge it:
// the proxy appends to the chain and Express walks it back one hop.
//
// The assumption breaks in two ways and both must be avoided by deployment,
// not by this function:
//   - Direct reachability of the app (bypassing the proxy) lets a client
//     supply X-Forwarded-For itself; Express would trust it. Keep the service
//     behind the proxy / bound to the platform's private interface.
//   - More than one proxy hop makes `1` the wrong number and shifts which
//     address is considered the client.
// If `trust proxy` ever changes, this identity must be revisited at the same
// time.

import net from "net";
import { ipKeyGenerator } from "express-rate-limit";

/**
 * IPv6 prefix used for rate-limit identity. Matches express-rate-limit's own
 * default so the in-process middleware store and this key agree.
 */
export const IPV6_RATE_LIMIT_SUBNET = 56;

/**
 * Identity used when no usable address is available at all. Not an escape
 * hatch: every such caller shares this ONE budget, so it is still bounded by
 * the configured limits rather than being unlimited.
 */
export const UNKNOWN_CLIENT_IDENTITY = "unknown";

/**
 * The rate-limit identity for a client address.
 *
 * - valid IPv6 -> start address of its /56, suffixed with the prefix length
 * - valid IPv4 -> the address itself, so unrelated IPv4 clients are never
 *   grouped together
 * - present but not a valid IP -> that exact string, so malformed input is
 *   bucketed deterministically instead of collapsing everyone into one key
 *   (and still bounded)
 * - missing/blank -> UNKNOWN_CLIENT_IDENTITY
 */
export function clientRateLimitIdentity(ip: string | undefined | null): string {
  if (typeof ip !== "string") return UNKNOWN_CLIENT_IDENTITY;
  const trimmed = ip.trim();
  if (!trimmed) return UNKNOWN_CLIENT_IDENTITY;
  if (!net.isIP(trimmed)) return trimmed;
  return ipKeyGenerator(trimmed, IPV6_RATE_LIMIT_SUBNET);
}

/**
 * True when the two addresses belong to the same rate-limit identity, i.e.
 * when a single caller would be charged for both.
 */
export function isSameClientIdentity(a: string | undefined | null, b: string | undefined | null): boolean {
  return clientRateLimitIdentity(a) === clientRateLimitIdentity(b);
}