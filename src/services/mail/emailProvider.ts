import nodemailer from "nodemailer";
import config from "../../config/config";
import { logger } from "../../lib/logger";

// Email provider abstraction (mirrors src/services/sms/smsProvider.ts).
//
// - The OTP service generates and verifies codes; providers only DELIVER what
//   they are handed. Providers must never mint their own codes.
// - No production vendor is selected here. `EMAIL_PROVIDER` picks the
//   implementation; unknown names and the log/memory/failing providers are
//   REJECTED in production so a missing real provider fails loudly instead of
//   pretending an email was delivered.
// - A code/credential must never be written to production logs. The log
//   provider only emits the code at debug level, and only outside production.

/**
 * Logical purpose of a message. Used for logging and for nothing else — it is
 * never mixed into a code's HMAC input here (that lives in the OTP service,
 * which owns purpose scoping).
 */
export type EmailPurpose = "LOGIN_OTP" | "VERIFY_EMAIL" | "PASSWORD_RESET";

export interface SendEmailInput {
  to: string;
  subject: string;
  text: string;
  html?: string;
  purpose: EmailPurpose;
  /**
   * Set only for one-time codes. Providers MUST NOT log this outside
   * production, and MUST NOT persist it.
   */
  secretCode?: string;
}

export interface EmailProvider {
  readonly name: string;
  sendEmail(input: SendEmailInput): Promise<void>;
}

export class EmailProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmailProviderError";
  }
}

/** Local-part masking for logs: jane.doe@example.com -> j***e@example.com */
export function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 0) return "***";
  const local = email.slice(0, at);
  const domain = email.slice(at);
  if (local.length <= 2) return `*${domain}`;
  return `${local[0]}***${local[local.length - 1]}${domain}`;
}

/**
 * Development provider: no external delivery. Records the attempt with a
 * masked address; the one-time code is emitted at debug level ONLY outside
 * production, so manual dev testing is possible without ever leaking a code
 * from production logs.
 */
export class LogEmailProvider implements EmailProvider {
  readonly name = "log";

  async sendEmail(input: SendEmailInput): Promise<void> {
    logger.info({ to: maskEmail(input.to), purpose: input.purpose }, "email.send");
    if (!config.isProduction && input.secretCode) {
      logger.debug({ code: input.secretCode }, "email.dev-code (non-production only)");
    }
  }
}

/** Test provider: captures deliveries in memory so tests can assert the whole
 * request -> email -> verify flow. Rejected in production by the factory. */
export interface CapturedEmail extends SendEmailInput {}

export class InMemoryEmailProvider implements EmailProvider {
  readonly name = "memory";
  readonly sent: CapturedEmail[] = [];

  async sendEmail(input: SendEmailInput): Promise<void> {
    this.sent.push(input);
  }

  /** Most recent one-time code delivered to an address, or null. */
  lastCodeFor(to: string): string | null {
    const target = to.trim().toLowerCase();
    for (let i = this.sent.length - 1; i >= 0; i--) {
      if (this.sent[i].to.trim().toLowerCase() === target) return this.sent[i].secretCode ?? null;
    }
    return null;
  }

  countFor(to: string): number {
    const target = to.trim().toLowerCase();
    return this.sent.filter((m) => m.to.trim().toLowerCase() === target).length;
  }

  clear(): void {
    this.sent.length = 0;
  }
}

/** Failing provider for tests: simulates a mail gateway outage. */
export class FailingEmailProvider implements EmailProvider {
  readonly name = "failing";

  async sendEmail(): Promise<void> {
    throw new EmailProviderError("Email gateway unavailable");
  }
}

/**
 * Real delivery. Credentials come from the existing EMAIL_USER / EMAIL_PASS
 * configuration; when they are absent this throws rather than silently
 * degrading, so production can never "succeed" without sending anything.
 */
export class SmtpEmailProvider implements EmailProvider {
  readonly name = "smtp";

  async sendEmail(input: SendEmailInput): Promise<void> {
    const user = (process.env.EMAIL_USER || config.emailUser || "").trim();
    const pass = process.env.EMAIL_PASS || config.emailPass || "";
    if (!user || !pass) {
      throw new EmailProviderError("Email SMTP credentials are not configured");
    }

    const transporter = nodemailer.createTransport({
      host: (process.env.EMAIL_HOST || "smtp.gmail.com").trim(),
      port: Number(process.env.EMAIL_PORT || 587),
      secure: (process.env.EMAIL_SECURE || "false").trim() === "true",
      auth: { user, pass },
    });

    await transporter.sendMail({
      from: `"Food Paddi" <${user}>`,
      to: input.to,
      subject: input.subject,
      text: input.text,
      html: input.html,
    });
  }
}

function buildProvider(name: string): EmailProvider {
  switch (name) {
    case "log":
      return new LogEmailProvider();
    case "memory":
      return new InMemoryEmailProvider();
    case "failing":
      return new FailingEmailProvider();
    case "smtp":
      return new SmtpEmailProvider();
    default:
      throw new EmailProviderError(`Unknown email provider: ${name}`);
  }
}

let overrideForTests: EmailProvider | null = null;

/**
 * Test seam: swap the process-wide provider inside automated tests.
 * Pass null to restore factory behavior. Not for production use.
 */
export function __setEmailProviderForTests(provider: EmailProvider | null): void {
  overrideForTests = provider;
}

export function getEmailProvider(): EmailProvider {
  if (overrideForTests) return overrideForTests;
  const raw = (process.env.EMAIL_PROVIDER || "").trim().toLowerCase();
  if (!raw) {
    if (config.isProduction) {
      throw new EmailProviderError("No email provider configured for production");
    }
    return new LogEmailProvider();
  }
  if (config.isProduction && (raw === "log" || raw === "memory" || raw === "failing")) {
    throw new EmailProviderError(`Email provider "${raw}" is not allowed in production`);
  }
  return buildProvider(raw);
}