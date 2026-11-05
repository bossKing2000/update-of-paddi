/**
 * Deterministic, run-scoped E.164 test numbers for the real-Redis OTP suite.
 *
 * WHY THIS EXISTS (Batch 1D.45)
 * ----------------------------
 * The prepared integration suite generated phone numbers inline with
 *
 *     `+12025550` + String(1000 + counter).padStart(4, "0")
 *
 * which is two defects that no test could catch, because the suite had never
 * actually executed against Redis:
 *
 *   1. It produced `+120255501001` — a 13-character string that
 *      `normalizePhoneNumber()` rejects outright, so every `requestOtp()`
 *      call would have thrown `InvalidPhoneNumberError` before reaching
 *      Redis. The suite's own shape assertion expected a 12-character
 *      string, so it disagreed with its own generator too.
 *   2. The counter restarted at 1 on every run, and a `RUN` constant
 *      declared beside it was dead code. Because the production Redis keys
 *      are `otp:<kind>:<E.164>` (`otpKeyFor`), the phone number IS the key
 *      discriminator — so two runs used the same keys, and one run's
 *      cleanup could delete another run's data.
 *
 * The key format is production code and is not changed here. The only lever a
 * test has for isolation is therefore the phone number, which is why the
 * generator is run-scoped.
 *
 * The space used is `+23480` + 8 digits = 100,000 values, every one of which
 * was verified to parse as a valid Nigerian mobile number by
 * libphonenumber-js (the same library `normalizePhoneNumber` uses).
 */
import { normalizePhoneNumber } from "../../src/utils/phone";

/** `+234` + "80" + 8 digits. All 100,000 values verified valid. */
const E164_PREFIX = "+23480";
/** Number of distinct subscribers addressable after the prefix. */
export const SUBSCRIBER_SPACE = 100_000;
/** How many numbers one run may consume, so runs get disjoint ranges. */
export const RESERVED_PER_RUN = 64;

/**
 * Per-run entropy.
 *
 * Batch 1D.46. The original seed was `Date.now()` alone, and the block index
 * was `seed % (SPACE - RESERVED)`. That is periodic, not injective: two runs
 * started `SPACE - RESERVED` milliseconds apart — about 100 seconds — landed
 * on the SAME block, and therefore on the same Redis keys. The same applied
 * to the client IP, which aliased every 254 ms.
 *
 * The timestamp is still included (so runs are chronologically ordered and
 * reproducible if a seed is supplied), but it is XORed with a random draw so
 * two runs starting in the same millisecond also differ, and it is passed
 * through a bit mixer so nearby timestamps scatter across the space instead
 * of stepping by one.
 */
export function runEntropy(): number {
  const time = Date.now() >>> 0;
  const random = Math.floor(Math.random() * 0x1_0000_0000) >>> 0;
  return (time ^ random) >>> 0;
}

/**
 * 32-bit avalanche mix (murmur3 finaliser). Bijective on 32 bits, so distinct
 * inputs stay distinct here; the modulo below is then the only place where
 * two different runs can converge, at a known probability rather than on a
 * fixed period.
 */
export function mix32(value: number): number {
  let x = value >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return x >>> 0;
}

/** Number of distinct blocks a run can be allocated. */
export const BLOCK_COUNT = SUBSCRIBER_SPACE - RESERVED_PER_RUN;

/**
 * Build a generator of phone numbers unique to one run.
 *
 * @param entropy run identity; defaults to `runEntropy()`. Pass a fixed value
 *   to obtain a reproducible range.
 *
 * Documented concurrency model: at most a handful of suites run at once
 * against one disposable Redis. Within that model two independent runs share
 * a block with probability 1/BLOCK_COUNT per pair, instead of deterministically
 * every ~100 seconds as before. Absolute disjointness is not achievable here
 * without shared state (a registry in the Redis under test), which this
 * module deliberately does not read or write.
 */
export function createRunPhoneNumberFactory(
  entropy: number = runEntropy(),
): () => string {
  const blockStart = mix32(entropy) % BLOCK_COUNT;
  let counter = 0;
  return function nextPhone(): string {
    if (counter >= RESERVED_PER_RUN) {
      throw new Error(
        `OTP test ran out of reserved phone numbers (${RESERVED_PER_RUN}). ` +
          "Raise RESERVED_PER_RUN or reduce the number of issuances per run.",
      );
    }
    const subscriber = blockStart + counter;
    counter += 1;
    return `${E164_PREFIX}${String(subscriber).padStart(8, "0")}`;
  };
}

/**
 * Documentation-only address blocks (RFC 5737). All three /24s are used, so
 * the address space is 762 hosts rather than 254 — the previous single-block
 * choice made two runs 254 ms apart collide.
 */
const RFC5737_BLOCKS = ["192.0.2", "198.51.100", "203.0.113"];
const HOSTS_PER_BLOCK = 254;
export const TEST_IP_SPACE = RFC5737_BLOCKS.length * HOSTS_PER_BLOCK;

/**
 * A per-run client IP for the per-IP rate-limit tests.
 *
 * Run-scoped for the same reason as the numbers: the IP is the key
 * discriminator for `otp:rl:ip:<identity>` counters, so two runs sharing one
 * would share a counter, break each other's exact-count assertions, and then
 * delete each other's data during cleanup.
 */
export function runScopedTestIp(entropy: number = runEntropy()): string {
  const host = mix32(entropy) % TEST_IP_SPACE; // 0 .. 761
  const block = RFC5737_BLOCKS[Math.floor(host / HOSTS_PER_BLOCK)];
  const octet = (host % HOSTS_PER_BLOCK) + 1; // 1 .. 254, never .0/.255
  return `${block}.${octet}`;
}

/** True when `value` is a number this module could have produced. */
export function isRunScopedTestPhone(value: string): boolean {
  // `E164_PREFIX` contains a literal "+", which is a regex metacharacter.
  const pattern = new RegExp(`^${E164_PREFIX.replace(/[.+*?^${}()|[\]\\]/g, "\\$&")}\\d{8}$`);
  return pattern.test(value) && normalizePhoneNumber(value) !== null;
}