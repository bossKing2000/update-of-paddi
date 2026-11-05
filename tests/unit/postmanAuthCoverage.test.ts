/**
 * Phase 1F — client-authentication expectations artifact coverage.
 *
 * `postman/food-paddi-complete.postman_collection.json` is the repo's
 * documented client-expectations artifact for the 1F confirmation gate.
 * The session-scoped (1E) and phone-login (1D) auth flows must be
 * represented there with the exact method, path, auth, and body shape the
 * server enforces — otherwise mobile/web integrators have no contract to
 * confirm against.
 *
 * Pure JSON inspection: no network, no services.
 */
import * as fs from "fs";
import * as path from "path";

interface CollectedRequest {
  method: string;
  rawUrl: string;
  hasBearerAuth: boolean;
  bodyRaw: string;
}

function collectRequests(): Map<string, CollectedRequest> {
  const file = path.resolve(
    __dirname,
    "..",
    "..",
    "postman",
    "food-paddi-complete.postman_collection.json",
  );
  const collection = JSON.parse(fs.readFileSync(file, "utf8"));
  const found = new Map<string, CollectedRequest>();
  const walk = (items: unknown[]): void => {
    for (const item of items as Array<Record<string, unknown>>) {
      if (Array.isArray(item.item)) {
        walk(item.item as unknown[]);
        continue;
      }
      const request = item.request as Record<string, unknown>;
      const url = request.url as string | { raw?: string };
      const auth = (request.auth ?? {}) as { type?: string };
      const body = (request.body ?? {}) as { raw?: string };
      found.set(item.name as string, {
        method: request.method as string,
        rawUrl: typeof url === "string" ? url : (url.raw ?? ""),
        hasBearerAuth: auth.type === "bearer",
        bodyRaw: body.raw ?? "",
      });
    }
  };
  walk(collection.item);
  return found;
}

// name → [method, path suffix, bearer required, required body keys]
const EXPECTED: Array<[string, string, string, boolean, string[]]> = [
  ["Switch active role", "POST", "/api/auth/switch-role", true, ['"role"']],
  ["Change password", "POST", "/api/auth/change-password", true, ['"currentPassword"', '"newPassword"']],
  ["Phone login - request OTP", "POST", "/api/auth/phone/login/request-otp", false, ['"phoneNumber"']],
  ["Phone login - verify OTP", "POST", "/api/auth/phone/login/verify-otp", false, ['"phoneNumber"', '"otp"']],
  [
    "Request phone OTP (authenticated)",
    "POST",
    "/api/auth/phone/request-otp",
    true,
    ['"phoneNumber"', '"purpose"'],
  ],
  [
    "Verify phone OTP (authenticated)",
    "POST",
    "/api/auth/phone/verify-otp",
    true,
    ['"phoneNumber"', '"otp"', '"purpose"'],
  ],
];

describe("postman collection documents the session/phone auth contract", () => {
  it.each(EXPECTED)("%s uses %s %s", (name, method, pathSuffix) => {
    const found = collectRequests().get(name);
    expect(found).toBeDefined();
    expect(found!.method).toBe(method);
    expect(found!.rawUrl.endsWith(pathSuffix)).toBe(true);
  });

  it.each(EXPECTED)("%s carries the expected auth and body shape", (name, _method, _path, bearer, keys) => {
    const found = collectRequests().get(name);
    expect(found).toBeDefined();
    expect(found!.hasBearerAuth).toBe(bearer);
    for (const key of keys as string[]) {
      expect(found!.bodyRaw).toContain(key);
    }
  });
});
