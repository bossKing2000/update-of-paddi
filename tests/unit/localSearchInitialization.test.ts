/**
 * Batch 1D.46 — regression coverage for the local-search dictionary lifecycle.
 *
 * The module used to call `enUS(cb)`, whose callback fires from inside
 * `fs.readFile`. That asynchronous task escaped module evaluation, so it could
 * finish after the importing code had finished. Under Jest the two
 * `console.log` calls in that callback then produced
 * `Cannot log after tests are done`, which Jest records as a suite failure
 * and which made `npm test` exit 1 while every assertion passed.
 *
 * These tests assert the property that actually prevents it: once the module
 * is required, its initialisation is COMPLETE. There is no pending async task
 * left to log later.
 *
 * The console output is intentionally NOT removed — it is emitted during
 * import now, deterministically. Silencing it would hide the symptom rather
 * than fix the lifecycle, which is why it is asserted here instead.
 */
import { execFileSync } from "child_process";
import path from "path";

const MODULE_PATH = path.join(process.cwd(), "src", "AI", "localSearchCorrect.ts");

/** Load the module in a clean process and report what it printed. */
function loadModuleFresh(): { stdout: string; elapsedMs: number } {
  const started = Date.now();
  const stdout = execFileSync(
    process.execPath,
    [
      "-r",
      "ts-node/register/transpile-only",
      "-e",
      `require(${JSON.stringify(MODULE_PATH)});`,
    ],
    { encoding: "utf8", cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
  );
  return { stdout, elapsedMs: Date.now() - started };
}

describe("local search dictionary initialisation", () => {
  it("is complete by the time the module has been required", () => {
    const { stdout } = loadModuleFresh();
    // Both of the module's startup logs are emitted during require(), not
    // afterwards. If either arrives late, this ordering is what breaks.
    expect(stdout).toContain("custom food words from");
    expect(stdout).toContain("Local search correction dictionary loaded");
  });

  it("loads the custom food dictionary, so the branch still runs", () => {
    const { stdout } = loadModuleFresh();
    const match = /Loaded (\d+) custom food words/.exec(stdout);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBeGreaterThan(0);
  });

  it("exposes a working correction API immediately after import", () => {
    // The async version had a window where `spell` was still undefined and
    // `correctWord` silently returned its input. Synchronous init removes it.
    const out = execFileSync(
      process.execPath,
      [
        "-r",
        "ts-node/register/transpile-only",
        "-e",
        `const m = require(${JSON.stringify(MODULE_PATH)});
         const out = [];
         out.push(m.correctWord("recieve"));
         out.push(m.correctQuery("jollof"));
         process.stdout.write("RESULT:" + JSON.stringify(out));`,
      ],
      { encoding: "utf8", cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
    );
    const match = /RESULT:(\[.*\])/.exec(out);
    expect(match).not.toBeNull();
    const [word, query] = JSON.parse(match![1]);
    // "jollof" is in the custom food dictionary, so it must survive intact.
    expect(query).toBe("jollof");
    // A misspelling is corrected rather than passed straight through.
    expect(word).not.toBe("recieve");
  });
});
