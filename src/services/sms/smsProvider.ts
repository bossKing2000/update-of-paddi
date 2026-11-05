import config from "../../config/config";
import { logger } from "../../lib/logger";
import type { OtpPurpose } from "../phoneOtp.service";

// Phase 1D.3 — SMS provider abstraction.
//
// - The OTP service generates and verifies OTPs; providers only deliver
//   the OTP they are handed. Providers must never mint their own codes.
// - No production vendor is selected here (no Twilio/Termii/etc.).
//   `SMS_PROVIDER` picks the implementation; unknown names and the
//   log/memory providers are rejected in production so a missing real
//   provider fails loudly instead of pretending an SMS was sent.

export interface SendOtpInput {
  phoneNumberE164: string;
  otp: string;
  purpose: OtpPurpose;
}

export interface SmsProvider {
  readonly name: string;
  sendOtp(input: SendOtpInput): Promise<void>;
}

export class SmsProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SmsProviderError";
  }
}

/** Last-4 masking for logs: +2348012345678 -> +234***5678. */
export function maskPhone(e164: string): string {
  if (e164.length <= 7) return "***";
  return `${e164.slice(0, 4)}***${e164.slice(-4)}`;
}

/**
 * Development provider: no external delivery. Logs the send attempt with
 * a masked number; the OTP itself is logged at debug level only outside
 * production so manual dev testing is possible without ever leaking
 * codes from production logs.
 */
export class LogSmsProvider implements SmsProvider {
  readonly name = "log";

  async sendOtp(input: SendOtpInput): Promise<void> {
    logger.info(
      { to: maskPhone(input.phoneNumberE164), purpose: input.purpose },
      "sms.otp.send",
    );
    if (!config.isProduction) {
      logger.debug({ otp: input.otp }, "sms.otp.dev-code (non-production only)");
    }
  }
}

/**
 * Test provider: captures deliveries in memory so tests can assert the
 * full request -> SMS -> verify flow. Never used in production (the
 * factory rejects it there).
 */
export interface CapturedSms {
  to: string;
  otp: string;
  purpose: OtpPurpose;
}

export class InMemorySmsProvider implements SmsProvider {
  readonly name = "memory";
  readonly sent: CapturedSms[] = [];

  async sendOtp(input: SendOtpInput): Promise<void> {
    this.sent.push({ to: input.phoneNumberE164, otp: input.otp, purpose: input.purpose });
  }

  lastOtpFor(to: string): string | null {
    for (let i = this.sent.length - 1; i >= 0; i--) {
      if (this.sent[i].to === to) return this.sent[i].otp;
    }
    return null;
  }

  clear(): void {
    this.sent.length = 0;
  }
}

/** Failing provider for tests: simulates an SMS gateway outage. */
export class FailingSmsProvider implements SmsProvider {
  readonly name = "failing";

  async sendOtp(): Promise<void> {
    throw new SmsProviderError("SMS gateway unavailable");
  }
}

function buildProvider(name: string): SmsProvider {
  switch (name) {
    case "log":
      return new LogSmsProvider();
    case "memory":
      return new InMemorySmsProvider();
    case "failing":
      return new FailingSmsProvider();
    default:
      throw new SmsProviderError(`Unknown SMS provider: ${name}`);
  }
}

let overrideForTests: SmsProvider | null = null;

/**
 * Test seam: swap the process-wide provider inside automated tests.
 * Pass null to restore factory behavior. Not for production use.
 */
export function __setSmsProviderForTests(provider: SmsProvider | null): void {
  overrideForTests = provider;
}

export function getSmsProvider(): SmsProvider {
  if (overrideForTests) return overrideForTests;
  const raw = (process.env.SMS_PROVIDER || "").trim().toLowerCase();
  if (!raw) {
    if (config.isProduction) {
      throw new SmsProviderError("No SMS provider configured for production");
    }
    return new LogSmsProvider();
  }
  if (config.isProduction && (raw === "log" || raw === "memory" || raw === "failing")) {
    throw new SmsProviderError(`SMS provider "${raw}" is not allowed in production`);
  }
  return buildProvider(raw);
}
