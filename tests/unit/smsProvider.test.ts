/**
 * Phase 1D.3 — SMS provider factory and development driver.
 *
 * `getSmsProvider` is the only thing standing between a misconfigured
 * production deployment and a system that quietly pretends an SMS was sent.
 * `phoneAuth.test.ts` and `phoneLogin.test.ts` install their providers through
 * `__setSmsProviderForTests`, which bypasses the factory entirely, so nothing
 * else covers this logic: before this suite the production-rejection branches
 * had no test at all.
 *
 * No network, no credentials and no .env access: the factory only reads
 * NODE_ENV and SMS_PROVIDER, both supplied here explicitly.
 */
import type { OtpPurpose } from "../../src/services/phoneOtp.service";

const BASE_ENV = { ...process.env };

/** Captured instead of written, so "was the OTP logged?" is answerable. */
const mockLogged: Array<{ level: string; payload: Record<string, unknown> }> = [];

jest.mock("../../src/lib/logger", () => ({
  logger: {
    info: (payload: Record<string, unknown>) => mockLogged.push({ level: "info", payload }),
    debug: (payload: Record<string, unknown>) => mockLogged.push({ level: "debug", payload }),
    warn: () => {},
    error: () => {},
  },
}));

type ProviderModule = typeof import("../../src/services/sms/smsProvider");

const PURPOSE = "PHONE_VERIFICATION" as OtpPurpose;
const E164 = "+2348031234567";

/**
 * Load a fresh copy of the provider module under a controlled environment, so
 * `config.isProduction` and `SMS_PROVIDER` are re-evaluated from env instead of
 * being captured by whatever the first import happened to see.
 */
function loadFactory(env: {
  nodeEnv: "production" | "development";
  smsProvider?: string;
}): ProviderModule {
  process.env.NODE_ENV = env.nodeEnv;
  // config refuses to load in production without it (src/config/config.ts:30).
  process.env.PHONE_OTP_SECRET = "unit-test-only-otp-secret";
  if (env.smsProvider === undefined) delete process.env.SMS_PROVIDER;
  else process.env.SMS_PROVIDER = env.smsProvider;
  jest.resetModules();
  return require("../../src/services/sms/smsProvider") as ProviderModule;
}

beforeEach(() => {
  mockLogged.length = 0;
});

afterEach(() => {
  jest.resetModules();
  process.env = { ...BASE_ENV };
});

describe("getSmsProvider", () => {
  it("refuses to resolve a provider in production when none is configured", () => {
    const { getSmsProvider, SmsProviderError } = loadFactory({ nodeEnv: "production" });
    expect(() => getSmsProvider()).toThrow(SmsProviderError);
    expect(() => getSmsProvider()).toThrow("No SMS provider configured for production");
  });

  it("refuses the log, memory and failing providers in production", () => {
    for (const name of ["log", "memory", "failing"]) {
      const { getSmsProvider, SmsProviderError } = loadFactory({
        nodeEnv: "production",
        smsProvider: name,
      });
      expect(() => getSmsProvider()).toThrow(SmsProviderError);
      expect(() => getSmsProvider()).toThrow(`SMS provider "${name}" is not allowed in production`);
    }
  });

  it("refuses an unrecognised provider name instead of degrading quietly", () => {
    // The failure mode that matters: naming a real vendor that has not been
    // implemented must break loudly, never silently fall back to the log
    // driver and leave an operator believing SMS is being delivered.
    const { getSmsProvider, SmsProviderError } = loadFactory({
      nodeEnv: "production",
      smsProvider: "termii",
    });
    expect(() => getSmsProvider()).toThrow(SmsProviderError);
    expect(() => getSmsProvider()).toThrow("Unknown SMS provider: termii");
  });

  it("falls back to the log driver outside production so development needs no vendor", () => {
    const { getSmsProvider } = loadFactory({ nodeEnv: "development" });
    expect(getSmsProvider().name).toBe("log");
  });

  it("honours an explicitly selected non-production driver", () => {
    expect(loadFactory({ nodeEnv: "development", smsProvider: "memory" }).getSmsProvider().name)
      .toBe("memory");
  });
});

describe("LogSmsProvider — development driver", () => {
  it("never performs network delivery", async () => {
    // It has no transport at all, which is what makes "development never
    // sends SMS" structurally true rather than a configuration choice.
    const { getSmsProvider } = loadFactory({ nodeEnv: "development", smsProvider: "log" });
    const provider = getSmsProvider();
    await expect(
      provider.sendOtp({ phoneNumberE164: E164, otp: "123456", purpose: PURPOSE }),
    ).resolves.toBeUndefined();
  });

  it("logs the code outside production so it can be tested manually", async () => {
    const { getSmsProvider } = loadFactory({ nodeEnv: "development", smsProvider: "log" });
    await getSmsProvider().sendOtp({ phoneNumberE164: E164, otp: "123456", purpose: PURPOSE });
    expect(mockLogged.some((l) => l.level === "debug" && l.payload.otp === "123456")).toBe(true);
  });

  it("never logs the code in production", async () => {
    // `log` is rejected by the factory in production, so the driver is
    // reached directly; what is under test is the driver's own guard, which
    // must hold regardless of how the instance was obtained.
    const { LogSmsProvider } = loadFactory({ nodeEnv: "production", smsProvider: "log" });
    await new LogSmsProvider().sendOtp({ phoneNumberE164: E164, otp: "123456", purpose: PURPOSE });
    expect(JSON.stringify(mockLogged)).not.toContain("123456");
  });

  it("masks the destination number in every line it writes", async () => {
    const { getSmsProvider } = loadFactory({ nodeEnv: "development", smsProvider: "log" });
    await getSmsProvider().sendOtp({ phoneNumberE164: E164, otp: "123456", purpose: PURPOSE });
    const info = mockLogged.find((l) => l.level === "info");
    expect(info?.payload.to).toBe("+234***4567");
    expect(JSON.stringify(mockLogged)).not.toContain(E164);
  });

  it("refuses to expose a short or malformed number unmasked", () => {
    const { maskPhone } = loadFactory({ nodeEnv: "development" });
    expect(maskPhone("+23481")).toBe("***");
    expect(maskPhone(E164)).toBe("+234***4567");
  });
});