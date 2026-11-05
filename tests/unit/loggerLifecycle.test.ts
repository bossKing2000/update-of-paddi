/**
 * Batch 1D.48 regression test.
 *
 * The application logger (`src/lib/logger.ts`) used to attach a
 * `pino-pretty` transport in every non-production environment. That transport
 * spawns a `thread-stream` worker thread at logger construction time. Under
 * Jest the worker outlives the test run, so suites importing the logger
 * finished all assertions yet the process never exited
 * ("Jest did not exit"; `phoneAuth.test.ts` hung ~4 runs in 5).
 *
 * The fix disables the transport when NODE_ENV is "test". This suite asserts
 * the property that actually prevents the hang — importing the logger must
 * not construct a `worker_threads.Worker` — by observing construction
 * directly, rather than by asserting on pino internals.
 */
describe("logger lifecycle under Jest", () => {
  it("runs with NODE_ENV=test, which is what the transport decision keys off", () => {
    // Jest sets NODE_ENV to "test" when it is otherwise unset; verified for
    // this repo's `npm test` runs. The logger fix relies on this value, so
    // the precondition is asserted rather than assumed.
    expect(process.env.NODE_ENV).toBe("test");
  });

  it("constructing the logger does not start a worker thread", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const wt = require("worker_threads");
    const OriginalWorker = wt.Worker;
    const seen: unknown[][] = [];
    wt.Worker = function (...args: unknown[]) {
      seen.push(args);
      return new OriginalWorker(...(args as []));
    };
    jest.resetModules();
    try {
      // Fresh copy so this observes construction, not a cached module.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require("../../src/lib/logger");
    } finally {
      wt.Worker = OriginalWorker;
    }
    expect(seen).toHaveLength(0);
  });

  it("the logger module still loads and exposes its API", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("../../src/lib/logger");
    expect(typeof mod.logger.info).toBe("function");
    expect(typeof mod.createRequestLogger).toBe("function");
    expect(() => mod.createRequestLogger("req-1")).not.toThrow();
  });
});
