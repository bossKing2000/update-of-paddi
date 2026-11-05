/**
 * Independent, NON-CONNECTING verification that a Prisma migration command will
 * target the disposable local test database.
 *
 * NOT EXECUTED IN THIS BATCH. Provided for a future, separately-approved run.
 *
 * Why this exists
 * ---------------
 * `prisma/schema.prisma` declares `url = env("DATABASE_URL")`, so every Prisma
 * CLI command resolves the target from `DATABASE_URL`. The repository `.env`
 * also declares `DATABASE_URL`, and the CLI loads it via
 * `dotenv.config({path, debug})` — with no `override` option, verified in
 * `node_modules/prisma/build/index.js` and in dotenv 17.3.1 itself. That means
 * an explicitly exported `DATABASE_URL` takes precedence over `.env`.
 *
 * This script checks that precedence holds and that the resulting target is the
 * intended loopback test database, WITHOUT running any Prisma command, without
 * opening a socket, and without printing a credential.
 *
 * Usage (future, after approval):
 *
 *   DATABASE_URL="$TEST_DATABASE_URL" npx ts-node --compiler-options \
 *     '{"module":"commonjs","esModuleInterop":true,"skipLibCheck":true}' \
 *     tests/scripts/verifyMigrationTarget.ts
 *
 * It exits 0 only when every check passes.
 */
import fs from "fs";
import os from "os";
import path from "path";

const repoRoot = path.resolve(__dirname, "..", "..");

function fail(msg: string): never {
  console.error(`  FAIL: ${msg}`);
  process.exit(1);
}

/** Prints user@host:port/database. Never prints a password or full URL. */
function describe(raw: string): string {
  const u = new URL(raw);
  return `${decodeURIComponent(u.username || "<no-user>")}@${u.hostname}:${u.port || "(default)"}/${u.pathname.replace(/^\//, "")}`;
}

function normalizeHost(h: string): string {
  let out = h.trim().toLowerCase();
  while (out.endsWith(".")) out = out.slice(0, -1);
  if (out.startsWith("[") && out.endsWith("]")) out = out.slice(1, -1);
  return out;
}

function isLoopback(host: string): boolean {
  if (host === "localhost" || host === "::1") return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const o = m.slice(1).map(Number);
  return o.every((n) => n <= 255) && o[0] === 127;
}

console.log("  migration-target verification (no database connection)\n");

// 1. An explicit DATABASE_URL must be present: that is what we hand to Prisma.
const explicit = process.env.DATABASE_URL;
if (!explicit) fail("DATABASE_URL is not set in the environment. Run this with DATABASE_URL=\"$TEST_DATABASE_URL\".");
console.log(`  1. explicit DATABASE_URL present : ${describe(explicit)}`);

// 2. It must be the same target as TEST_DATABASE_URL, so the check cannot pass
//    against a different database than the one the gate would allow.
const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl) fail("TEST_DATABASE_URL is not set; refusing to guess the intended target.");
if (new URL(explicit).hostname !== new URL(testUrl).hostname || new URL(explicit).port !== new URL(testUrl).port) {
  fail("DATABASE_URL does not match TEST_DATABASE_URL host:port.");
}
console.log("  2. matches TEST_DATABASE_URL host:port : yes");

// 3. Loopback-only, mirroring the gate's own rule.
const host = normalizeHost(new URL(explicit).hostname);
if (!isLoopback(host)) fail(`Target host "${host}" is not loopback. Refusing.`);
console.log(`  3. target is loopback                : yes (${host})`);

// 4. Explicit non-default port.
const port = new URL(explicit).port;
if (!port) fail("No explicit port on DATABASE_URL.");
console.log(`  4. explicit port                     : ${port}`);

// 5. Prove the .env cannot win: run dotenv exactly as the Prisma CLI does and
//    confirm DATABASE_URL is unchanged afterwards. This is pure string
//    manipulation — no Prisma process, no connection.
const dotenv = require(path.join(repoRoot, "node_modules", "dotenv")) as typeof import("dotenv");
const envPath = path.join(repoRoot, ".env");
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
  if (process.env.DATABASE_URL !== explicit) {
    fail(".env overrode DATABASE_URL. The explicit override did not take precedence — do NOT migrate.");
  }
  console.log("  5. .env present, explicit var wins  : yes (unchanged)");
} else {
  console.log("  5. .env present                     : no (.env absent)");
}

// 6. The mandated deny list must still be configured for the integration gate.
const denied = process.env.TEST_DATABASE_DENIED_HOSTS;
if (!denied || !denied.trim()) {
  fail("TEST_DATABASE_DENIED_HOSTS is required by the gate but is unset. Do not migrate.");
}
console.log(`  6. TEST_DATABASE_DENIED_HOSTS set   : yes (${denied.split(",").length} entr${denied.split(",").length === 1 ? "y" : "ies"})`);

console.log("\n  RESULT: the migration target is the disposable local test database.");
console.log("  Not yet verified: that Prisma actually connects to it. No connection was made here.");