/**
 * FIN-07-05g — give the production Redis module a disposable endpoint WITHOUT
 * corrupting the safety reference the gate depends on.
 *
 * THE REGRESSION THIS FIXES (FIN-07-05f)
 * ---------------------------------------
 * The first version of this file assigned the validated test URL to
 * `process.env.REDIS_URL` and left it there. But
 * `evaluateDisposableRedisTarget` uses `process.env.REDIS_URL` as the ambient
 * APPLICATION endpoint for its final host+port denylist comparison. Once the pin
 * set it, every suite that later called the gate found its own candidate
 * "identical to the application's REDIS_URL" and refused it:
 *
 *     "this endpoint is the same as the application's REDIS_URL, which is
 *      shared infrastructure"
 *
 * `webhookHandlerClaimRedis` survived only because it uses its own inline
 * `assertDisposableRedisUrl` instead of the shared gate.
 *
 * THE FIX
 * -------
 * `src/lib/redis.ts` reads `process.env.REDIS_URL` exactly once, at
 * module-evaluation time, to build its client (src/lib/redis.ts:88). So the
 * value only has to be present WHILE THAT MODULE EVALUATES:
 *
 *   1. Remember the pre-existing `REDIS_URL` — the genuine application
 *      reference. In this harness it is normally unset, which is exactly why
 *      the production module used to throw.
 *   2. Validate the candidate with the UNCHANGED gate, while the remembered
 *      value is still in place, so the denylist comparison is truthful.
 *   3. Assign the validated URL, with ONLY its database pathname removed so
 *      each client's own `database` option selects the intended logical
 *      database (see `withoutDatabasePath` below). Scheme, host and port are
 *      unchanged; every guard in step 2 already ran against the full value.
 *   4. Evaluate `src/lib/redis` NOW, while the value is set, so the production
 *      client is constructed against the disposable endpoint.
 *   5. Restore `REDIS_URL` to its original state.
 *
 * After step 4 the module is in Node's cache, so a suite's later
 * `import { redisPayments }` receives the same already-configured client. From
 * step 5 onward every gate invocation sees the ORIGINAL ambient value again and
 * behaves exactly as it did before this pin existed.
 *
 * WHY THIS IS NOT A TIMING ASSUMPTION
 * -----------------------------------
 * The whole sequence runs synchronously inside one `setupFiles` module, so it
 * does not depend on Jest's relative ordering of files, suites or workers. Jest
 * guarantees only that `setupFiles` complete before any test module is required,
 * and that guarantee is used here exactly once.
 *
 * SAFETY PROPERTIES
 * -----------------
 *   * The gate is imported and called unchanged. Every rule it owns — loopback
 *     host, plain `redis://`, non-default database index, and host+port
 *     separation from the application endpoint — still applies.
 *   * Validation happens BEFORE any assignment and before the production module
 *     is evaluated, so a missing or refused candidate means no Redis client is
 *     ever constructed and the worker aborts.
 *   * There is no fallback: the candidate comes only from `OTP_TEST_REDIS_URL`.
 *     Nothing here can adopt the application's endpoint.
 *   * No Redis client is connected here, and no URL or credential is printed;
 *     failures surface the gate's own reason, which never contains one.
 */
import { evaluateDisposableRedisTarget } from "../helpers/localRedisTarget";

/**
 * Strip ONLY the database pathname from an ALREADY-VALIDATED URL.
 *
 * WHY (Task 7.40, root cause proven empirically in Task 7.39)
 * -------------------------------------------------------
 * `node-redis` gives a database path in the URL PRECEDENCE over the explicit
 * `database` option. Verified against the installed version: a client built as
 * `{ url: "redis://127.0.0.1:6399/9", database: 3 }` writes to database 9.
 *
 * `src/lib/redis.ts` builds every client as `createClient({ url: process.env.REDIS_URL, database: db })`
 * with per-feature indices (`redisUsersSessions` = 4, `ShopCartRedis` = 5,
 * `redisPayments` = 6). Publishing the validated `/15` therefore silently
 * dropped EVERY application client onto the OTP suite's database, so a suite
 * that mixes a production client with its own inspector client
 * (`webhookHandlerClaimRedis`, handler on the OTP database, inspector on
 * WEBHOOK_TEST_REDIS_URL's) addressed two different logical databases and failed
 * three tests.
 *
 * Removing the path lets each client's own `database` option select its intended
 * database, which is both correct and production-faithful.
 *
 * WHAT IS NOT TOUCHED
 * ------------------
 * The gate above already ran, UNCHANGED, against the COMPLETE candidate — so the
 * loopback-host rule, the plain-`redis:` scheme rule, the "database index must
 * be >= 1" rule, and the host+port separation from the ambient application
 * endpoint all still apply to the full value. This helper is applied strictly
 * AFTER a successful validation and cannot rescue a refused candidate.
 *
 * Scheme, host and port are carried through unchanged by `URL`, and any
 * userinfo is preserved; nothing is re-parsed, re-resolved, defaulted or
 * logged. With the pathname empty, `URL.toString()` yields the `redis://host:port/`
 * form, which was verified to honour the explicit `database` option.
 */
function withoutDatabasePath(validatedUrl: string): string {
  const parsed = new URL(validatedUrl);
  parsed.pathname = "";
  return parsed.toString();
}

// 1. Remember the genuine application endpoint before touching anything.
const originalRedisUrl = process.env.REDIS_URL;

// 2. Validate with the unchanged gate, while the real ambient value is still
//    in place so its host+port denylist comparison is truthful.
const candidate = process.env.OTP_TEST_REDIS_URL;
const result = evaluateDisposableRedisTarget(candidate);

if (!result.ok) {
  throw new Error(
    `[pinTestRedisUrl] BLOCKED: the disposable Redis target was refused — ${result.reason ?? "no reason supplied"}. ` +
      "The production Redis client will not be initialised. Refusing to fall back " +
      "to the application's REDIS_URL.",
  );
}

// 3. Publish the validated scheme/host/port with the database pathname removed
//    (see `withoutDatabasePath`). Every guard above has already run against the
//    complete candidate; this changes which LOGICAL database the clients select,
//    never WHICH SERVER they connect to.
process.env.REDIS_URL = withoutDatabasePath(result.url);

// 4. Evaluate the production module now, so its client is built against the
//    disposable endpoint while the value is available. It is cached from here on.
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("../../src/lib/redis");
} finally {
  // 5. Restore the genuine ambient reference so every later gate call compares
  //    against the application's real endpoint again.
  if (originalRedisUrl === undefined) delete process.env.REDIS_URL;
  else process.env.REDIS_URL = originalRedisUrl;
}

export {};
