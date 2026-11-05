/**
 * AUTH-3 regression: the OTP issuance path must not log the Lua result, the
 * Redis record, or the raw key to stdout, and must not re-read the record it
 * just wrote.
 *
 * Before this fix `requestEmailOtp` followed `ISSUE_LUA` with an extra
 * `client.get(key)` and three `logger.info` calls that printed the Lua return
 * code, the freshly-written record and the key itself. None of that output was
 * used for a security decision, response, state transition or error-handling
 * path — it was pure debug logging that also emitted an extra round trip to
 * Redis on a public, unauthenticated endpoint.
 *
 * This suite exercises the service through its `opts.client` seam with a mock
 * client and asserts:
 *   - `client.get` is never called after ISSUE_LUA (no redundant Redis read),
 *   - the three debug `logger.info` messages are never emitted,
 *   - the operational "sent" log is still emitted (useful logging preserved),
 *   - the success path and its security semantics are unchanged.
 */
import type { RedisClientType } from "redis";

import { logger } from "../../src/lib/logger";
import {
  EmailOtpPurpose,
  requestEmailOtp,
} from "../../src/services/emailOtp.service";

const SECRET = "test-only-email-otp-secret-do-not-use-in-prod";
process.env.EMAIL_OTP_SECRET = SECRET;

const PURPOSE = EmailOtpPurpose.LOGIN;
const EMAIL = "user@example.com";

const infoSpy = jest.spyOn(logger, "info").mockImplementation(() => undefined);

const mockEval = jest.fn().mockResolvedValue(0); // ISSUE_LUA: 0 = stored
const mockGet = jest.fn();
const mockClient = { eval: mockEval, get: mockGet } as unknown as RedisClientType;

beforeEach(() => {
  infoSpy.mockClear();
  mockEval.mockClear();
  mockGet.mockClear();
});

afterAll(() => {
  infoSpy.mockRestore();
});

describe("email OTP issuance — no debug logging, no redundant Redis read", () => {
  it("issues a code successfully without re-reading the record", async () => {
    const res = await requestEmailOtp(
      { email: EMAIL, purpose: PURPOSE },
      { client: mockClient },
    );

    expect(res).toEqual({ status: "SUCCESS" });
    // ISSUE_LUA ran once (atomic: cooldown check, both budgets, and the write).
    expect(mockEval).toHaveBeenCalledTimes(1);
    // No redundant read-back of the record just written.
    expect(mockGet).not.toHaveBeenCalled();
  });

  it("does not log the Lua result, the Redis record, or the key", async () => {
    await requestEmailOtp(
      { email: EMAIL, purpose: PURPOSE },
      { client: mockClient },
    );

    expect(infoSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: "emailOtp.request: ISSUE_LUA result" }),
    );
    expect(infoSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: "emailOtp.request: post-ISSUE_LUA Redis state" }),
    );
    expect(infoSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: "emailOtp.request: Lua return code analysis" }),
    );
    // Neither the key nor the record contents may appear in any log line.
    const allInfoArgs = infoSpy.mock.calls.map((args) => JSON.stringify(args));
    expect(allInfoArgs.join(" ")).not.toContain(EMAIL);
    expect(allInfoArgs.join(" ")).not.toContain(`otp:email:${PURPOSE}:`);
  });

  it("still emits the operational 'sent' log on success", async () => {
    await requestEmailOtp(
      { email: EMAIL, purpose: PURPOSE },
      { client: mockClient },
    );

    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: PURPOSE }),
      "emailOtp.request: sent",
    );
  });

  it("still enforces cooldown and rate-limit through ISSUE_LUA", async () => {
    mockEval.mockResolvedValueOnce(1); // cooldown
    const cooldown = await requestEmailOtp(
      { email: EMAIL, purpose: PURPOSE },
      { client: mockClient },
    );
    expect(cooldown).toEqual({ status: "COOLDOWN" });

    mockEval.mockResolvedValueOnce(2); // rate limited
    const limited = await requestEmailOtp(
      { email: EMAIL, purpose: PURPOSE },
      { client: mockClient },
    );
    expect(limited).toEqual({ status: "RATE_LIMITED" });
    // The blocked request stored nothing, so nothing to re-read either.
    expect(mockGet).not.toHaveBeenCalled();
  });

  it("fails closed when the store throws", async () => {
    mockEval.mockRejectedValue(new Error("store down"));
    await expect(
      requestEmailOtp({ email: EMAIL, purpose: PURPOSE }, { client: mockClient }),
    ).rejects.toThrow(/OTP service unavailable/);
    expect(mockGet).not.toHaveBeenCalled();
  });
});
