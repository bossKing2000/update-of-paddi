import { Request, Response } from "express";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import prisma from "../lib/prisma";
import { z } from "zod";
import config from "../config/config";
import {
  generateAccessToken,
  generateRefreshToken,
} from "../utils/generateToken";
import { buildAuthResponse } from "../utils/buildResponse";
import { sendResetEmail } from "../services/mail/sendResetEmail";
import { AuthRequest } from "../middlewares/auth.middleware";
import { Role, Prisma, User } from "@prisma/client";
import { v4 as uuidv4 } from "uuid";
import crypto from "crypto";
import dayjs from "dayjs";
import { generateServerUrl } from "../utils/generateServerUrl";
import { OAuth2Client } from "google-auth-library";
import {
  registerSchema,
  loginSchema,
  changePasswordSchema,
  secureResetSchema,
  updateUserSchema,
  createAddressSchema,
  becomeVendorSchema,
  switchRoleSchema,
  requestPhoneOtpSchema,
  verifyPhoneOtpSchema,
  requestEmailLoginOtpSchema,
  verifyEmailLoginOtpSchema,
  removePhoneSchema,
} from "../validations/authSchema";
import { generateResetToken } from "../utils/generateResetToken";
import {
  resetCodeDigest,
  resetCodeMatches,
  resetJwtDigest,
  resetJwtMatches,
} from "../utils/resetTokenDigest";
import { hasRole, assertRoleCombination } from "../utils/roles";
import { normalizePhoneNumber, resolveProfilePhoneWrite } from "../utils/phone";
import { ensureVendorStatusNew, evaluateVendorStatus } from "../services/vendorStatus.service";
import {
  requestOtp,
  verifyOtp,
  clearOtp,
  OtpPurpose,
  OtpServiceError,
  OtpDeliveryError,
} from "../services/phoneOtp.service";
import { getSmsProvider, SmsProviderError } from "../services/sms/smsProvider";
import {
  requestEmailOtp,
  verifyEmailOtp,
  clearEmailOtp,
  canonicalizeEmail,
  EmailOtpPurpose,
} from "../services/emailOtp.service";
import { getEmailProvider, EmailProviderError } from "../services/mail/emailProvider";
import {
  acquireResetCooldown,
  clearResetAttempts,
  recordResetAttempt,
  resetAttemptsKeyFor,
  resetCooldownKeyFor,
  resetUnknownAttemptsKeyFor,
  resetUnknownCooldownKeyFor,
  resetFinalizeKeyFor,
  RESET_FINALIZE_MAX_ATTEMPTS,
  RESET_LIMITS_COMMAND_TIMEOUT_MS,
} from "../services/passwordResetLimits.service";
import { usableLoginMethods } from "../utils/loginMethods";
import { ensureString } from "../utils/paramUtils";
import { logger } from "../lib/logger";
import { redisPayments } from "../lib/redis";
import {
  deleteUserSession,
  deleteAllUserSessions,
  createUserSession,
  listUserSessions,
  getUserSession,
  lookupUserSession,
  setRefreshJti,
  rotateRefreshJtiCAS,
  deleteRefreshJti,
  setSessionActiveRole,
  resolveSessionRole,
  type RefreshRotationOutcome,
} from "../lib/session";

const schema = z.object({ email: z.string().email() });
const googleClient = new OAuth2Client();

const findUserByEmail = (email: string) =>
  prisma.user.findUnique({ where: { email } });
const findUserById = (id: string) => prisma.user.findUnique({ where: { id } });
const comparePasswords = (plain: string, hashed: string) =>
  bcrypt.compare(plain, hashed);
const incrementTokenVersion = (userId: string) =>
  prisma.user.update({
    where: { id: userId },
    data: { tokenVersion: { increment: 1 } },
  });

export function handlePrismaError(error: any, res: Response) {
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  ) {
    const target = (error.meta?.target as string[] | undefined)?.[0] ?? "Field";
    return res.status(409).json({ message: `${target} already exists` });
  }
  // Phase 1D.4 (F1): the project logger, not `console.error`. This handler is
  // the catch-all for every auth flow, so it is reachable with whatever
  // exception was thrown — including Redis connection errors whose message may
  // carry a connection string. `console.*` writes straight to stdout and
  // bypasses pino entirely, including the `otp` / `*.otp` redaction configured
  // in lib/logger.ts; the structured `err` field goes through pino instead.
  // The client-facing response is unchanged and still generic.
  logger.error({ err: error }, "Unhandled error in auth request");
  return res.status(500).json({ message: "Something went wrong" });
}

// ─────────────────────────────────────────────────────────────────────────────
// ONBOARDING STATE
// Single source of truth for "what does this user still need to do".
// Called after register, login, select-role, KYC verification, and profile
// update, so the frontend never has to hardcode this sequencing itself —
// it just reads `onboarding.nextStep` / `onboarding.steps`.
// ─────────────────────────────────────────────────────────────────────────────

export type OnboardingStepKey = "ROLE" | "KYC" | "PROFILE";

export interface OnboardingStep {
  key: OnboardingStepKey;
  done: boolean;
  missingFields: string[];
}

export interface OnboardingState {
  steps: OnboardingStep[];
  isComplete: boolean;
  nextStep: OnboardingStepKey | null;
}

export type OnboardingUser = {
  role: Role | null;
  roles?: Role[] | null;
  kycStatus: import("@prisma/client").KycStatus;
  phoneNumber: string | null;
  brandName: string | null;
  brandLogo: string | null;
};

function onboardingField(step: OnboardingStepKey, name: string) {
  return `${step}.${name}`;
}

export function resolveOnboardingState(user: OnboardingUser): OnboardingState {
  const role = user.role ?? null;
  const kyc = user.kycStatus ?? "PENDING";
  // Phase 1B: KYC / profile requirements derive from HELD roles so a
  // dual-role CUSTOMER+VENDOR account still completes vendor onboarding
  // while its active role is CUSTOMER. ROLE step stays active-role based.
  const held: Role[] = user.roles ?? (role ? [role] : []);
  const holdsVendor = held.includes(Role.VENDOR);
  const holdsDelivery = held.includes(Role.DELIVERY);

  const steps: OnboardingStep[] = [];

  // STEP 1: ROLE — user must pick CUSTOMER / VENDOR / DELIVERY before anything else
  const roleDone = !!role;
  steps.push({
    key: "ROLE",
    done: roleDone,
    missingFields: roleDone ? [] : [onboardingField("ROLE", "role")],
  });

  // STEP 2: KYC — only VENDOR and DELIVERY need NIN verification
  const needsKyc = holdsVendor || holdsDelivery;
  const kycDone = !needsKyc ? true : kyc === "VERIFIED";
  steps.push({
    key: "KYC",
    done: kycDone,
    missingFields: needsKyc && !kycDone ? [onboardingField("KYC", "nin")] : [],
  });

  // STEP 3: PROFILE — role-specific required fields
  const missingFields: string[] = [];

  if (holdsVendor || holdsDelivery) {
    if (!user.phoneNumber)
      missingFields.push(onboardingField("PROFILE", "phoneNumber"));
  }

  if (holdsVendor) {
    if (!user.brandName)
      missingFields.push(onboardingField("PROFILE", "brandName"));
    if (!user.brandLogo)
      missingFields.push(onboardingField("PROFILE", "brandLogo"));
  }

  const profileDone = missingFields.length === 0;
  steps.push({ key: "PROFILE", done: profileDone, missingFields });

  const isComplete = steps.every((step) => step.done);
  const nextStep = steps.find((step) => !step.done)?.key ?? null;

  return { steps, isComplete, nextStep };
}

/**
 * Single place that renders and delivers the email-ownership link.
 *
 * Every caller (registration, resend, email-change) goes through here so the
 * link shape cannot drift between them, and so delivery is routed through the
 * provider abstraction — which is what makes the flow assertable in tests and
 * safe in production (no hardcoded smtp.gmail.com, no silent dev fallback).
 *
 * Delivery is detached and best-effort: the surrounding request has already
 * decided its outcome, and a gateway outage must not turn a successful
 * registration into a 500. The user can always request a resend.
 */
function sendVerificationLinkAsync(req: Request, to: string, token: string): void {
  let provider: ReturnType<typeof getEmailProvider>;
  try {
    provider = getEmailProvider();
  } catch (err) {
    // No provider configured (e.g. production without EMAIL_PROVIDER). The
    // account state is already committed; surface it in logs only.
    logger.warn({ err }, "verification email: no provider available");
    return;
  }
  const link = `${generateServerUrl(req)}/api/auth/verify-email?token=${token}`;
  Promise.resolve()
    .then(() =>
      provider.sendEmail({
        to,
        subject: "Verify your Food Paddi email",
        text: `Verify your Food Paddi email address using this link: ${link}`,
        purpose: "VERIFY_EMAIL",
      }),
    )
    .catch((err) => {
      logger.warn({ err }, "verification email delivery failed");
    });
}

export const register = async (req: AuthRequest, res: Response) => {
  // Defense in depth: never trust a client-supplied privileged role, even
  // if validation layers change. ADMIN is rejected outright (403), not
  // silently downgraded — the caller must know the attempt was refused.
  const rawRole =
    typeof req.body?.role === "string" ? req.body.role.toUpperCase() : null;
  if (rawRole === "ADMIN") {
    return res
      .status(403)
      .json({ message: "Registration with ADMIN role is not allowed" });
  }

  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success)
    return res.status(422).json({ errors: parsed.error.flatten().fieldErrors });

  const { username, name, email, password, role, phoneNumber, brandName } =
    parsed.data;

  try {
    const existingUser = await findUserByEmail(email);
    if (existingUser)
      return res.status(400).json({ message: "User already exists" });

    const avatarUrl = req.file ? `/uploads/${req.file.filename}` : undefined;
    const hashed = await bcrypt.hash(password, 10);
    const verificationToken = uuidv4();
    const emailExpires = new Date(Date.now() + 60 * 60 * 1000);

    const data: any = {
      name, // required
      email,
      password: hashed,
      emailVerificationToken: verificationToken,
      emailVerificationExpiresAt: emailExpires,
    };
    if (username) data.username = username;
    if (role) {
      const assigned = Role[role as keyof typeof Role];
      data.role = assigned;
      data.roles = [assigned];
    }
    if (phoneNumber) data.phoneNumber = phoneNumber;
    if (avatarUrl) data.avatarUrl = avatarUrl;
    if (brandName) data.brandName = brandName;

    const isDeliverySignup = !!role && role.toUpperCase() === "DELIVERY";

    // One business operation spanning two writes (the account and, for a
    // rider, the linked rider profile) must be all-or-nothing: without this,
    // a failure in the second write leaves an account holding DELIVERY with no
    // rider profile, which 404s later at getDriver with no way to self-repair.
    // Only database work belongs inside the callback — the Redis session and
    // the response cookie below are deliberately left outside it, because a
    // transaction rolls back writes but cannot unsend a side effect.
    const user = await prisma.$transaction(async (tx) => {
      const created = await tx.user.create({ data });
      if (isDeliverySignup) {
        await tx.deliveryPerson.create({
          data: {
            userId: created.id,
            // INACTIVE, never ACTIVE. Selecting the DELIVERY role identifies
            // an applicant; it does not approve a rider. `ACTIVE` is reserved
            // for an administrator via PATCH /api/admin/delivery/:userId/status.
            // The dispatch predicate requires status === ACTIVE
            // (services/deliveryAssignment.ts), so a self-selected rider is
            // excluded from every operational path until approved.
            status: "INACTIVE",
            isOnline: false,
            rating: 0,
            totalDeliveries: 0,
          },
        });
      }
      return created;
    });

    // Deliver the verification link. This was previously dead code (the call
    // was commented out), so registration minted an emailVerificationToken that
    // was never sent and a brand-new account could only be verified by
    // separately triggering a resend.
    sendVerificationLinkAsync(req, user.email, verificationToken);

    // Previously register never created a Redis session at all — the
    // accessToken it returned would be rejected by authenticate on the
    // very first authenticated request (e.g. selecting a role right
    // after signing up), forcing an unexpected extra login. Same
    // multi-device session design as login (see lib/session.ts).
    const sessionId = uuidv4();
    const refreshJti = uuidv4();
    const accessToken = generateAccessToken(user.id, user.role, sessionId, user.tokenVersion);
    const refreshToken = generateRefreshToken(
      user.id,
      user.tokenVersion,
      sessionId,
      refreshJti,
    );

    const regClientInfo = (req as any).clientInfo || {};
    await createUserSession(user.id, sessionId, {
      ip: regClientInfo.ip || req.ip || "unknown",
      userAgent:
        regClientInfo.userAgent || req.headers["user-agent"] || "unknown",
      deviceId: regClientInfo.deviceId || null,
      geoCity: regClientInfo.city,
      geoRegion: regClientInfo.region,
      geoCountry: regClientInfo.country,
      lastLoginAt: new Date(),
    });
    // Recording the first jti is best-effort at login: it seeds rotation
    // state, it is not a security decision. If it fails, refresh adopts the
    // incoming jti on first use (the legacy path) rather than rejecting a
    // legitimate sign-in. The REFRESH path below is where an unreadable store
    // must fail closed.
    await setRefreshJti(user.id, sessionId, refreshJti).catch((e) =>
      logger.warn({ err: e, userId: user.id }, "Failed to seed refresh jti at login"),
    );

    // Cookie Path must match the refresh endpoint's request path
    // (/api/auth/refresh-token) or browsers will not send it back and web
    // refresh silently breaks. All set/clear sites use this same path.
    res.cookie("refreshToken", refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      maxAge: 7 * 24 * 60 * 60 * 1000,
      path: "/api/auth/refresh-token",
    });

    const onboarding = resolveOnboardingState({
      role: user.role,
      roles: user.roles,
      kycStatus: user.kycStatus,
      phoneNumber: user.phoneNumber,
      brandName: user.brandName,
      brandLogo: user.brandLogo,
    });

    // Phase 1C: VENDOR accounts enter the onboarding lifecycle as NEW.
    if (user.role === Role.VENDOR) {
      await ensureVendorStatusNew(user.id);
      await evaluateVendorStatus(user.id);
    }

    res.status(201).json({
      message: "User registered successfully",
      pendingRole: !user.role,
      onboarding,
      ...buildAuthResponse(user, accessToken),
    });
  } catch (error) {
    return handlePrismaError(error, res);
  }
};



// ─────────────────────────────────────────────────────────────────────────────
// SESSION ISSUANCE (Phase 1D.38)
//
// Extracted verbatim from `login` so every flow that authenticates a user
// produces the exact same session: same token lifetimes, same per-login
// sessionId, same active role carried in the access token, same tokenVersion
// and refresh-jti seeding, same cookie, same response body. Phone login
// reuses this rather than inventing a second token path — a second path is
// how active-role-per-session and refresh rotation drift apart.
//
// `authenticate` re-checks the account's blocked state on every request, so
// a session issued here stops working the moment the account is blocked.
// ─────────────────────────────────────────────────────────────────────────────

interface SessionIssuanceOptions {
  /** LoginHistory.method / authProviders label: LOCAL | GOOGLE | PHONE. */
  method: string;
  /** Message returned as `message` in the auth response body. */
  message: string;
  /** Hook run immediately before the response (login clears its attempt counter here). */
  beforeResponse?: () => Promise<void> | void;
}

async function issueAuthenticatedSession(
  req: Request,
  res: Response,
  user: User,
  options: SessionIssuanceOptions,
): Promise<void> {
  // Use client info if provided by geoMiddleware
  const clientInfo = (req as any).clientInfo || {};
  const ip = clientInfo.ip || req.ip || "unknown";
  const userAgent =
    clientInfo.userAgent || req.headers["user-agent"] || "unknown";
  const deviceId = clientInfo.deviceId || null;
  const city = clientInfo.city || "unknown";
  const region = clientInfo.region || "unknown";
  const country = clientInfo.country || "unknown";

  // Update last login and create loginHistory
  await prisma.user.update({
    where: { id: user.id },
    data: {
      lastLoginAt: new Date(),
      loginMethod: options.method,
      authProviders: user.authProviders.includes(options.method)
        ? undefined
        : { push: options.method },
      loginHistory: {
        create: {
          method: options.method,
          ip,
          userAgent,
          deviceId,
          geoCity: city,
          geoRegion: region,
          geoCountry: country,
        },
      },
    },
  });

  // Generate tokens — sessionId ties this specific login to its own
  // Redis session, so logging in on another device doesn't silently
  // kick this one out.
  const sessionId = uuidv4();
  const refreshJti = uuidv4();
  const accessToken = generateAccessToken(user.id, user.role, sessionId, user.tokenVersion);
  const refreshToken = generateRefreshToken(
    user.id,
    user.tokenVersion,
    sessionId,
    refreshJti,
  );

  // Store session in Redis
  // Phase 1E: the new session starts acting as the account's current role.
  // It is seeded from the account row, never from the client.
  await createUserSession(user.id, sessionId, {
    activeRole: user.role ?? null,
    lastLoginAt: new Date(),
    ip,
    userAgent,
    deviceId,
    geoCity: city,
    geoRegion: region,
    geoCountry: country,
  });
  // Recording the first jti is best-effort at login: it seeds rotation
  // state, it is not a security decision. If it fails, refresh adopts the
  // incoming jti on first use (the legacy path) rather than rejecting a
  // legitimate sign-in. The REFRESH path below is where an unreadable store
  // must fail closed.
  await setRefreshJti(user.id, sessionId, refreshJti).catch((e) =>
    logger.warn({ err: e, userId: user.id }, "Failed to seed refresh jti at login"),
  );

  res.cookie("refreshToken", refreshToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: "/api/auth/refresh-token",
  });

  // If request is from mobile, also send refreshToken in JSON
  const isMobile = req.headers["x-client-type"] === "mobile";

  const onboarding = resolveOnboardingState({
    role: user.role,
    roles: user.roles,
    kycStatus: user.kycStatus,
    phoneNumber: user.phoneNumber,
    brandName: user.brandName,
    brandLogo: user.brandLogo,
  });

  if (options.beforeResponse) {
    await options.beforeResponse();
  }

  res.status(200).json({
    message: options.message,
    pendingRole: !user.role,
    onboarding,
    ...buildAuthResponse(user, accessToken),
    ...(isMobile ? { refreshToken } : {}),
  });
}

export const login = async (req: Request, res: Response) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(422).json({ errors: parsed.error.flatten().fieldErrors });
  }

  const { email, password } = parsed.data;

    // Track failed login attempts per email
    const attemptsKey = `login_attempts:${email.toLowerCase()}`;
    const attemptsStr = await redisPayments.get(attemptsKey);
    const attempts = attemptsStr ? parseInt(attemptsStr, 10) : 0;
    if (attempts >= 5) {
      return res.status(429).json({ message: "Too many failed attempts. Try again in 15 minutes." });
    }

    try {
    const user = await findUserByEmail(email);

  if (
    !user ||
    !user.password ||
    !(await comparePasswords(password, user.password))
  ) {
    // Increment failed attempts
    const newAttempts = attempts + 1;
    await redisPayments.set(attemptsKey, newAttempts.toString(), { EX: 900 });
    return res.status(401).json({ message: "Invalid credentials" });
  }

    if (!user.isEmailVerified) {
      return res
        .status(403)
        .json({ message: "Please verify your email before logging in." });
    }

    // Blocked accounts cannot authenticate. Revoke any lingering sessions
    // (e.g. issued before the block if revocation partially failed) so the
    // block takes effect immediately and cannot be bypassed by re-login.
    if (user.isBlocked) {
      await deleteAllUserSessions(user.id).catch(() => {});
      return res
        .status(403)
        .json({ message: "This account has been blocked." });
    }

    // Delete the login attempt counter upon successful login
    await issueAuthenticatedSession(req, res, user, {
      method: "LOCAL",
      message: "Login successful",
      beforeResponse: async () => {
        await redisPayments.del(attemptsKey);
      },
    });
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    console.error("Login error:", err.message);
    res.status(500).json({ message: "Something went wrong during login" });
  }
};

// Handles refresh tokens from both cookie (web) and body (mobile) — with rotation & reuse detection
/** Retryable outage response shared by every refresh infrastructure failure. */
function refreshUnavailable(res: Response) {
  return res.status(503).json({
    message: "Session refresh is temporarily unavailable. Please retry shortly.",
  });
}
export const refreshToken = async (req: Request, res: Response) => {
  // Get refresh token from either cookie or request body
  const token = req.cookies.refreshToken || req.body.refreshToken;

  if (!token) {
    return res.status(401).json({ message: "No refresh token provided" });
  }

  try {
    // Verify and decode refresh token
    const decoded = jwt.verify(token, config.jwtSecret) as {
      id: string;
      tokenVersion: number;
      sessionId?: string;
      jti?: string;
    };

    // Find user in DB. A throw here is an infrastructure failure, not an
    // invalid credential: fail closed with a retryable 503 and revoke
    // nothing, rather than mislabelling it "invalid refresh token".
    let user;
    try {
      user = await findUserById(decoded.id);
    } catch {
      return refreshUnavailable(res);
    }
    if (!user || user.tokenVersion !== decoded.tokenVersion) {
      return res.status(401).json({ message: "Invalid refresh token" });
    }

    // Blocked accounts cannot mint fresh tokens — revoke everything.
    if (user.isBlocked) {
      await deleteAllUserSessions(user.id).catch(() => {});
      return res
        .status(403)
        .json({ message: "This account has been blocked." });
    }

    // A refresh token issued before this session redesign won't carry a
    // sessionId — treat that as expired rather than crashing, forcing a
    // clean re-login (which is the only way to get a real session anyway).
    if (!decoded.sessionId) {
      return res.status(401).json({ message: "Please log in again" });
    }

    const incomingJti = decoded.jti;

    // --- Refresh-token rotation & reuse detection (transparent to normal users) ---
    //
    // Every step below reads or writes the single-use jti store. If that store
    // is unreachable we CANNOT establish whether this token is unused, and an
    // unreadable store is not evidence of a clean token. Rather than let a
    // Redis blip silently disable replay detection, this fails CLOSED with a
    // retryable 503 — critically WITHOUT revoking sessions, because a temporary
    // outage is not evidence of compromise.
    try {
      await runRefreshRotation(res, decoded as { id: string; tokenVersion: number; sessionId: string; jti?: string }, user, incomingJti);
    } catch (e) {
      const err = e as { jtiStoreUnavailable?: boolean };
      if (err?.jtiStoreUnavailable) {
        logger.warn(
          { userId: user.id, sessionId: decoded.sessionId },
          "Refresh rejected: replay-detection store unavailable",
        );
        return refreshUnavailable(res);
      }
      throw e;
    }

    // (runRefreshRotation writes its own response and returns once complete.)
    return undefined;
  } catch (error) {
    // A marked infrastructure failure (e.g. the legacy-JTI store write below)
    // is a retryable outage, not an invalid credential. Everything else stays
    // a generic 401 with no internals.
    const marked = error as { jtiStoreUnavailable?: boolean };
    if (marked?.jtiStoreUnavailable) {
      return refreshUnavailable(res);
    }
    const err = error instanceof Error ? error : new Error(String(error));
    console.error("Refresh token error:", err.message);
    return res
      .status(401)
      .json({ message: "Invalid or expired refresh token" });
  }
};

/** Marker so the catch above can tell a store outage from a logic error. */
function jtiStoreUnavailable(): Error & { jtiStoreUnavailable: true } {
  const e = new Error("refresh jti store unavailable") as Error & { jtiStoreUnavailable: true };
  e.jtiStoreUnavailable = true;
  return e;
}

/**
 * Phase 1E: the role a refreshed access token must be minted with.
 *
 * Both refresh paths — the normal rotation and the concurrent-retry grace
 * window — resolve the role HERE so they cannot diverge. Previously only the
 * normal path consulted the session; the grace path minted `user.role`, so a
 * VENDOR session on a CUSTOMER-default account silently received a CUSTOMER
 * token on a legitimate concurrent retry and was rejected on its next request.
 *
 * Returns `undefined` when the session's role is no longer authorised for the
 * account. That is fail-closed: `authenticate` rejects such a token on the very
 * next request anyway, so minting one would only hand back a credential that
 * is dead on arrival. `hasRole` also treats a missing/non-array `roles` as
 * "not held", so an unreadable account fails closed rather than open.
 */
function resolveRefreshRole(
  session: { activeRole?: string | null } | null,
  user: { role: Role | null; roles?: Role[] },
): string | null | undefined {
  const sessionRole = resolveSessionRole(session, user.role);
  if (sessionRole === null) return null;
  // `hasRole` already fails closed on a missing/non-array `roles`.
  return hasRole({ roles: user.roles }, sessionRole as Role) ? sessionRole : undefined;
}

/**
 * Rotation + replay detection for a refresh token. Writes the response itself.
 *
 * Split out of `refreshToken` so the store-unavailable case can be handled in
 * one place, rather than each Redis call silently degrading.
 */
async function runRefreshRotation(
  res: Response,
  decoded: { id: string; tokenVersion: number; sessionId: string; jti?: string },
  user: { id: string; role: Role | null; tokenVersion: number },
  incomingJti: string | undefined,
): Promise<unknown> {
  // The rotation decision for the next jti is minted up front: the CAS below
  // consumes it on exactly one path (a win), and it is discarded on every
  // other path (grace reuses the current jti, replay and legacy never mint).
  // Generating it here keeps the minting code below unchanged.
  const newJti = uuidv4();
  {
    if (incomingJti) {
      // Batch 1D.60: one atomic compare-and-set replaces the old
      // read-compare-write sequence (getRefreshJti → compare →
      // rotateRefreshJti), under which two concurrent refreshes with the
      // same valid JTI both passed the read before either wrote and each
      // minted an independently valid token pair. Exactly one concurrent
      // caller can now win a rotation; the rest observe the already-rotated
      // state as grace (benign retry) or replay (theft).
      let rotation: RefreshRotationOutcome;
      try {
        rotation = await rotateRefreshJtiCAS(user.id, decoded.sessionId, incomingJti, newJti);
      } catch (e) {
        logger.warn({ err: e, userId: user.id }, "rotateRefreshJtiCAS failed");
        throw jtiStoreUnavailable();
      }
      if (rotation.outcome === "replay") {
        // Possible stolen token reuse — revoke all sessions for this user
        logger.warn({ userId: user.id, sessionId: decoded.sessionId, incomingJti, storedJti: rotation.currentJti }, "Refresh token reuse detected — revoking all sessions");
        await deleteAllUserSessions(user.id);
        await prisma.user.update({ where: { id: user.id }, data: { tokenVersion: { increment: 1 } } }).catch(() => {});
        return res.status(401).json({ message: "Session compromised. Please log in again." });
      }
      if (rotation.outcome === "grace") {
        // Within grace window — the CAS observed incoming == prev atomically,
        // so this is a benign concurrent retry, not theft. Issue new access
        // token but reuse current refresh jti (do not rotate again) to keep
        // clients converged. `currentJti` was observed in the same atomic
        // step, so no second read can disagree with the decision.
        const currentJti = rotation.currentJti;
        // The session must be read BEFORE the role is resolved: the grace path
        // now mints from the session's active role, exactly like the normal
        // path below, so the two cannot diverge.
        //
        // Phase 1E.5B: an infrastructure error here is UNKNOWN validity, not
        // a missing session. Return the retryable 503 without minting,
        // revoking, or tearing down JTI state (grace must stay recoverable).
        const lookup = await lookupUserSession(user.id, decoded.sessionId);
        if (lookup.status === "error") {
          return refreshUnavailable(res);
        }
        const existingSession = lookup.status === "found" ? lookup.session : null;
        if (!existingSession) {
          // Same rule as the main restore path below: no session in Redis
          // or DB means explicit revocation, not expiry — do not resurrect.
          await deleteRefreshJti(user.id, decoded.sessionId).catch(() => {});
          return res.status(401).json({ message: "Please log in again" });
        }
        const graceRole = resolveRefreshRole(existingSession, user);
        if (graceRole === undefined) {
          // The session's role is no longer authorised for this account. Fail
          // closed and issue nothing, rather than mint a token that would be
          // rejected on its next use.
          await deleteRefreshJti(user.id, decoded.sessionId).catch(() => {});
          return res.status(401).json({ message: "Please log in again" });
        }
        const newAccessTokenGrace = generateAccessToken(user.id, graceRole, decoded.sessionId, user.tokenVersion);
        const graceRefreshToken = generateRefreshToken(user.id, user.tokenVersion, decoded.sessionId, currentJti);
        // Strip a possibly-stale cached role exactly like the normal path
        // below: the database row is authoritative, and spreading the cached
        // value back would let a stale read silently revert a role switch.
        // createUserSession re-reads the stored role for the cache payload
        // when none is stated.
        const { activeRole: _staleActiveRoleGrace, ...graceMetadata } = existingSession;
        // The DB upsert can still fail after the CAS already rotated. That is
        // an infrastructure failure, not an invalid credential: fail closed
        // with a retryable 503 and leave JTI state alone so grace recovery
        // stays possible. Never mint on this path.
        try {
          await createUserSession(user.id, decoded.sessionId, { ...graceMetadata, lastRefreshedAt: new Date() });
        } catch {
          return refreshUnavailable(res);
        }
        res.cookie("refreshToken", graceRefreshToken, {
          httpOnly: true,
          secure: process.env.NODE_ENV === "production",
          sameSite: "strict",
          maxAge: 7 * 24 * 60 * 60 * 1000,
          path: "/api/auth/refresh-token",
        });
        return res.status(200).json({ accessToken: newAccessTokenGrace, refreshToken: graceRefreshToken });
      }
      // outcome === "rotated": the new jti is already persisted by the CAS.
      // Fall through to the shared session-restore + 200 tail below, which
      // still gates minting on a live session (no resurrection).
    }

    // Valid refresh — rotate to new jti
    // Phase 1E.5B: same unknown-vs-missing distinction as the grace path
    // above. An infrastructure error denies retryably without minting,
    // revoking, or tearing down JTI state; only a confirmed-missing session
    // takes the 401 no-resurrection path.
    const restore = await lookupUserSession(user.id, decoded.sessionId);
    if (restore.status === "error") {
      return refreshUnavailable(res);
    }
    const existingSession = restore.status === "found" ? restore.session : null;

    // Session gone from both Redis and the DB fallback. That means it
    // was explicitly revoked (logout / admin block / demotion) — NOT mere
    // cache expiry — because revocation deletes the DB row while expiry
    // only lapses Redis (DB rows live 30d, refresh tokens only 7d).
    // Refuse to resurrect it: the old refresh token dies with the session.
    // (The legitimate Redis-loss case still restores, because then the DB
    // row is still present and getUserSession above would have found it.)
    if (!existingSession) {
      await deleteRefreshJti(user.id, decoded.sessionId).catch(() => {});
      return res.status(401).json({ message: "Please log in again" });
    }

    // Phase 1E: mint the new access token from the SESSION's active role, not
    // the account role. Refreshing must never undo a role this session chose,
    // and must never silently restore a stale account-wide role either.
    // The same helper the grace path uses, so both refresh paths agree.
    const sessionRole = resolveRefreshRole(existingSession, user);
    if (sessionRole === undefined) {
      // The session's role is no longer authorised for this account. Fail
      // closed and issue nothing, rather than mint a token that would be
      // rejected on its next use. The session's refresh state is torn down on
      // the same rule as a missing session above.
      await deleteRefreshJti(user.id, decoded.sessionId).catch(() => {});
      return res.status(401).json({ message: "Please log in again" });
    }

    const newAccessToken = generateAccessToken(
      user.id,
      sessionRole,
      decoded.sessionId,
      user.tokenVersion,
    );
    const newRefreshToken = generateRefreshToken(
      user.id,
      user.tokenVersion,
      decoded.sessionId,
      newJti,
    );

    // Persist new jti for legacy tokens without one (the incoming-jti paths
    // above already persisted via the CAS or never mint a new jti at all).
    if (!incomingJti) {
      // Legacy token without jti — simply set new
      try {
        await setRefreshJti(user.id, decoded.sessionId, newJti);
      } catch (e) {
        logger.warn({ err: e, userId: user.id }, "setRefreshJti(new) failed");
        throw jtiStoreUnavailable();
      }
    }

    // Session existence was already established above; this call only slides the
    // TTL forward and preserves `activeRole` (createUserSession deliberately
    // does not overwrite a role the caller did not restate).
    //
    // Phase 1E.1: the role is stripped out on purpose. `existingSession` comes
    // from a cache-first read, so it can be OLDER than the database row — and
    // spreading it back would make `createUserSession` write that stale role
    // over the authoritative one, silently reverting a role switch. Dropping
    // the field means the refresh only ever touches the TTL; the stored role is
    // left exactly as the database holds it. No extra round trip.
    const { activeRole: _staleActiveRole, ...refreshMetadata } = existingSession;
    // Phase 1E.5B: a DB failure here must not become a misleading 401. The
    // CAS already rotated, so deny retryably and leave JTI state alone —
    // the client recovers inside the grace window once the store is back.
    try {
      await createUserSession(user.id, decoded.sessionId, {
        ...refreshMetadata,
        lastRefreshedAt: new Date(),
      });
    } catch {
      return refreshUnavailable(res);
    }

    // Send refresh token as cookie (for web clients)
    res.cookie("refreshToken", newRefreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
      path: "/api/auth/refresh-token",
    });

    // Also return refresh token in body for mobile apps
    return res.status(200).json({
      accessToken: newAccessToken,
      refreshToken: newRefreshToken, // mobile clients will use this
    });
  }
}

// Logout — revokes only THIS device's session. Previously this called
// incrementTokenVersion, a blunt global mechanism that silently broke
// refresh capability on every OTHER logged-in device too — an inconsistent
// half-logout where another device's access token kept working until it
// naturally expired, then would confusingly fail to refresh with no
// explicit action taken there. logoutAllDevices (below) is the actual
// "sign me out everywhere" action now.
export const logout = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const sessionId = req.user?.sessionId;
    if (!userId || !sessionId)
      return res.status(401).json({ message: "Not authenticated" });

    await deleteUserSession(userId, sessionId);

    res.clearCookie("refreshToken", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      path: "/api/auth/refresh-token",
    });

    res.status(200).json({ message: "Logged out successfully" });
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    console.error("Logout error:", err.message);
    res.status(500).json({ message: "Something went wrong during logout" });
  }
};

// Logs out every device — was previously exported but never wired to any
// route at all (dead code). Now genuinely revokes every active session
// (not just the current one) and bumps tokenVersion so no outstanding
// refresh token, on any device, can mint a new access token afterward.
export const logoutAllDevices = async (req: AuthRequest, res: Response) => {
  await deleteAllUserSessions(req.user!.id);
  await incrementTokenVersion(req.user!.id);

  res.clearCookie("refreshToken", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/api/auth/refresh-token",
  });
  res.json({ message: "Logged out from all devices" });
};

// GET /auth/login-history — LoginHistory has been written to on every
// login (see middlewares/tracking.middleware.ts) but nothing ever read
// it back — there was no way for a user to see "here's everywhere you've
// logged in recently" to spot activity they don't recognize.
export const getLoginHistory = async (req: AuthRequest, res: Response) => {
  const history = await prisma.loginHistory.findMany({
    where: { userId: req.user!.id },
    orderBy: { createdAt: "desc" },
    take: 20,
  });
  res.json({ history });
};

// GET /auth/sessions — list every active session (device) for the current
// user, so they can see "iPhone, Lagos, last active 2 hours ago" etc. and
// spot a session they don't recognize. Didn't exist before — there was no
// way for a user to see their own active devices, let alone revoke one.
export const getMySessions = async (req: AuthRequest, res: Response) => {
  const sessions = await listUserSessions(req.user!.id);
  const withCurrentFlag = sessions.map((s) => ({
    ...s,
    current: s.sessionId === req.user!.sessionId,
  }));
  res.json({ sessions: withCurrentFlag });
};

// DELETE /auth/sessions/:sessionId — revoke one specific device's session
// without touching any others (e.g. "that's my old phone, sign it out").
export const revokeSession = async (req: AuthRequest, res: Response) => {
  const sessionId = ensureString(req.params.sessionId);
  if (!sessionId)
    return res.status(400).json({ message: "sessionId is required" });

  await deleteUserSession(req.user!.id, sessionId);
  res.json({
    message: "Session revoked",
    wasCurrentSession: sessionId === req.user!.sessionId,
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// Account-enumeration hardening.
//
// These public, unauthenticated endpoints must not let a caller learn whether
// an address is registered. Two techniques are used, deliberately:
//
//   1. IDENTICAL RESPONSES — the same status code and the same body for the
//      known and unknown branches. The message is intentionally vague and
//      makes no claim about whether mail was sent.
//   2. NO TELLTALE SHORT-CIRCUIT — the unknown branch performs the same class
//      of work (token generation plus one indexed DB round trip) instead of
//      returning early. No artificial sleep is introduced; equalising work by
//      doing equivalent work is simpler and does not slow the happy path.
//
// Endpoint-specific judgement: `verifyResetCode` DOES still validate the
// submitted code, because a caller who already holds a code is not learning
// anything new, and silently accepting a wrong code would break real users.
// Its unknown-account branch returns the SAME 406 as an invalid code, so
// existence is not disclosed even there.
// ─────────────────────────────────────────────────────────────────────────────

/** Public response for a reset request, regardless of whether the account exists. */
const RESET_REQUEST_MESSAGE =
  "If an account exists for that address, a reset code has been sent.";

/** Public response for a verification resend, regardless of account existence. */
const RESEND_VERIFICATION_MESSAGE =
  "If an account exists for that address, a verification email has been sent.";

// Forgot Password
export const forgotPassword = async (req: Request, res: Response) => {
  const { email: rawEmail } = req.body;
  if (!rawEmail) return res.status(422).json({ message: "Email is required" });

  // Registration canonicalises addresses with `.toLowerCase().trim()`
  // (see registerUser), but this lookup historically used the RAW submitted
  // string. That routed a genuinely registered account into the "unknown"
  // branch whenever the caller typed different casing or stray whitespace —
  // so account existence was decided by something other than the account — and
  // it bound the reset-code digest (and the delivery target) to a string that
  // the verification step may not reproduce.
  //
  // Canonicalise once, here, so the lookup, the digest and the delivery target
  // all agree with registration. A non-string input is passed through
  // untouched so the existing validation/500 behaviour is preserved exactly.
  const email = typeof rawEmail === "string" ? rawEmail.trim().toLowerCase() : rawEmail;

  try {
    const user = await findUserByEmail(email);

    // Account-enumeration hardening: an unknown address must be
    // indistinguishable from a known one. Both branches return the SAME status
    // and the SAME message. The unknown branch still performs the same class
    // of work (token generation + a DB round trip) rather than returning
    // early, so response timing does not disclose existence either — and no
    // artificial sleep is needed.
    if (!user) {
      generateResetToken(6);
      await prisma.passwordResetToken.findFirst({ where: { userId: "__no_such_user__" } });
      // Batch 1D.53: same class of Redis work as the known branch, against a
      // one-way decoy identity — preserves the timing posture and fails the
      // same way if Redis is down, so an outage cannot oracle existence.
      // Batch 1D.74: bounded, so a half-open connection cannot hang the
      // request; a timeout throws and this branch still fails identically to
      // the known one.
      await acquireResetCooldown(resetUnknownCooldownKeyFor(email), {
        timeoutMs: RESET_LIMITS_COMMAND_TIMEOUT_MS,
      });
      logger.info("[forgotPassword] request received for an unregistered address");
      return res.status(200).json({ message: RESET_REQUEST_MESSAGE });
    }

    // Batch 1D.53: per-account resend cooldown, acquired atomically. Losing
    // the race returns the uniform response WITHOUT issuing a credential or
    // sending email — the caller cannot distinguish it from a fresh send.
    const cooldownWon = await acquireResetCooldown(resetCooldownKeyFor(user.id), {
      timeoutMs: RESET_LIMITS_COMMAND_TIMEOUT_MS,
    });
    if (!cooldownWon) {
      logger.info({ userId: user.id }, "forgotPassword: resend cooldown active");
      return res.status(200).json({ message: RESET_REQUEST_MESSAGE });
    }

    const resetToken = generateResetToken(6); // generates a 6-character alphanumeric token
    const expiresInMinutes = 10;

    // Batch 1D.51: the code is a bearer credential — only its HMAC digest
    // reaches the database, bound to the account's canonical email. The raw
    // code exists in memory just long enough to be emailed below.
    const digest = resetCodeDigest(config.jwtResetSecret, email, resetToken);

    // Batch 1D.53: a fresh challenge re-arms verification — drop any
    // exhausted attempt counter first, fail-closed so a stale counter can
    // never strand the new code.
    // Batch 1D.74: bounded, so issuance cannot hang on an unhealthy
    // connection; a timeout still fails the whole request closed.
    await clearResetAttempts(resetAttemptsKeyFor(user.id), {
      timeoutMs: RESET_LIMITS_COMMAND_TIMEOUT_MS,
    });

    await prisma.passwordResetToken.upsert({
      where: { userId: user.id },
      update: {
        token: digest,
        expiresAt: new Date(Date.now() + expiresInMinutes * 60 * 1000),
      },
      create: {
        userId: user.id,
        token: digest,
        expiresAt: new Date(Date.now() + expiresInMinutes * 60 * 1000),
      },
    });

    try {
      await sendResetEmail(req, email, resetToken);
    } catch (err) {
      // Delivery failed: invalidate the code the user never received, so no
      // live credential lingers that they cannot know. Cleanup is
      // best-effort and the failure stays server-side — the response below
      // is the same uniform 200 as every other branch, so a mailer outage
      // cannot become an account-existence oracle.
      logger.warn({ err, userId: user.id }, "forgotPassword: reset email delivery failed");
      try {
        // Batch 1D.53: compare-and-delete — remove ONLY the credential this
        // request created. A newer concurrent reset overwrote the row with a
        // different digest, and an unconditional delete would destroy that
        // live, already-emailed code.
        await prisma.passwordResetToken.deleteMany({ where: { userId: user.id, token: digest } });
      } catch (cleanupErr) {
        logger.warn({ err: cleanupErr, userId: user.id }, "forgotPassword: cleanup after delivery failure failed");
      }
    }

    res.status(200).json({ message: RESET_REQUEST_MESSAGE });
  } catch (error) {
    // Phase 1 security: routed through the shared serializer. `error` is a
    // live exception object; Prisma errors can carry query metadata, and this
    // catch sits behind a deliberately uniform 200 so the log must not become
    // a second oracle.
    logger.error({ err: error }, "forgotPassword failed");
    res
      .status(500)
      .json({ message: "Something went wrong during password reset request" });
  }
};

// Get Profile

export const getProfile = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const userRole = req.user?.role;

    if (!userId) {
      return res.status(400).json({ message: "User ID not found in token" });
    }

    // Fetch base user info
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        username: true,
        name: true,
        email: true,
        role: true,
        roles: true,
        phoneNumber: true,
        avatarUrl: true,
        bio: true,
        preferences: true,
        addresses: true,
        brandName: true,
        brandLogo: true,
        kycStatus: true,
        isEmailVerified: true,
        createdAt: true,
        deliveryPerson: {
          select: {
            id: true,
            vehicleType: true,
            licensePlate: true,
            status: true,
            rating: true,
            totalDeliveries: true,
            isOnline: true,
            latitude: true,
            longitude: true,
            walletBalance: true,
            createdAt: true,
          },
        },
      },
    });

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const onboarding = resolveOnboardingState({
      role: user.role,
      roles: user.roles,
      kycStatus: user.kycStatus,
      phoneNumber: user.phoneNumber,
      brandName: user.brandName,
      brandLogo: user.brandLogo,
    });

    const response: any = { ...user, pendingRole: !user.role, onboarding };

    // Flatten delivery details for DELIVERY role
    if (userRole === "DELIVERY" && user.deliveryPerson) {
      response.deliveryProfile = user.deliveryPerson;
    }

    res.status(200).json({ user: response });
  } catch (error) {
    logger.error({ err: error, userId: req.user?.id }, "getProfile failed");
    res.status(500).json({ message: "Failed to load user profile" });
  }
};

// NOTE: an unauthenticated getAllUsers used to live here, wired to
// GET /api/auth/alluser — no auth check at all, no pagination, dumping
// every user's email, phone number, name, and bio to any anonymous
// caller. Removed entirely; superseded by the proper admin-only,
// paginated GET /api/admin/users built in the Admin domain.

export const selectRole = async (req: AuthRequest, res: Response) => {
  const { role } = req.body;

  const userId = req.user?.id;

  if (!userId) return res.status(401).json({ message: "Not authenticated" });

  // Narrow the type of role
  if (role !== "CUSTOMER" && role !== "VENDOR" && role !== "DELIVERY") {
    return res.status(400).json({ message: "Invalid role" });
  }

  try {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return res.status(404).json({ message: "User not found" });
    if ((user.roles && user.roles.length > 0) || user.role)
      return res.status(400).json({ message: "Role already selected" });

    const assigned = Role[role as keyof typeof Role];

    // Validate the combination against the shared role policy BEFORE any
    // write, mirroring becomeVendor (which does the same over `[...held,
    // VENDOR]`).
    //
    // `[assigned]` IS the complete resulting set here, and that is a property of
    // the write below rather than an assumption about the caller: the write
    // REPLACES `roles` with a single-element array, and it only runs while the
    // account still holds no role at all. So the persisted `roles` can only be
    // `[assigned]`, which is exactly what was validated here.
    try {
      assertRoleCombination([assigned]);
    } catch (e) {
      return res.status(403).json({
        message: e instanceof Error ? e.message : "Invalid role combination",
      });
    }

    // Role + rider profile are one business operation and must not be able to
    // half-apply. Vendor onboarding below stays outside the transaction
    // because ensureVendorStatusNew/evaluateVendorStatus are follow-on work,
    // not part of the role write.
    //
    // The "no role selected yet" precondition is re-asserted HERE, inside the
    // transaction and as part of the WHERE clause, because the read above is a
    // normal statement: it is stale the moment any other role-write lands in
    // between (another select-role, an admin role change, becomeVendor). Under
    // the previous unguarded `update`, such a caller would overwrite a role it
    // should have been refused. A conditional claim is the same idiom
    // becomeVendor uses, so exactly one row can win and the loser writes
    // nothing. Mirrors becomeVendor above.
    const claimed = await prisma.$transaction(async (tx) => {
      const claim = await tx.user.updateMany({
        where: {
          id: userId,
          // Same condition as the guard above, evaluated against the latest row.
          role: null,
          AND: [
            {
              NOT: {
                roles: {
                  hasSome: [
                    Role.CUSTOMER,
                    Role.VENDOR,
                    Role.ADMIN,
                    Role.DELIVERY,
                  ],
                },
              },
            },
          ],
        },
        data: { role: assigned, roles: [assigned] },
      });
      if (claim.count === 0) return null;

      // Same linked record as local DELIVERY registration creates — without
      // it every rider endpoint fails at getDriver ("Rider profile" 404).
      if (role === "DELIVERY") {
        await tx.deliveryPerson.upsert({
          where: { userId },
          // Empty update on purpose: re-selecting a role must never demote a
          // rider an administrator has already approved to ACTIVE.
          update: {},
          create: {
            userId,
            // INACTIVE, never ACTIVE. Selecting the role identifies an
            // applicant; approval is a separate administrator action via
            // PATCH /api/admin/delivery/:userId/status. Same policy as the
            // register path above.
            status: "INACTIVE",
            isOnline: false,
            rating: 0,
            totalDeliveries: 0,
          },
        });
      }
      // `updateMany` returns a count only, so read the row back inside the same
      // transaction to answer the response from committed state.
      return tx.user.findUnique({ where: { id: userId } });
    });

    // Lost the race: the account gained a role between the read above and this
    // write. Same refusal the guard gives a caller that already held a role.
    if (!claimed) {
      return res.status(400).json({ message: "Role already selected" });
    }
    const updated = claimed;

    // Phase 1C: VENDOR accounts enter the onboarding lifecycle as NEW.
    if (updated.role === Role.VENDOR) {
      await ensureVendorStatusNew(userId);
      await evaluateVendorStatus(userId);
    }

    const onboarding = resolveOnboardingState({
      role: updated.role,
      roles: updated.roles,
      kycStatus: updated.kycStatus,
      phoneNumber: updated.phoneNumber,
      brandName: updated.brandName,
      brandLogo: updated.brandLogo,
    });

    res
      .status(200)
      .json({ message: "Role updated", role: updated.role, onboarding });
  } catch (error) {
    logger.error({ err: error, userId }, "selectRole failed");
    res
      .status(500)
      .json({ message: "Something went wrong while setting role" });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Phase 1B multi-role: POST /api/auth/become-vendor
// A CUSTOMER adds VENDOR to their held roles without changing the active
// role. KYC / isLive flow stays exactly as is (new vendors start offline).
// ─────────────────────────────────────────────────────────────────────────────
export const becomeVendor = async (req: AuthRequest, res: Response) => {
  const parsed = becomeVendorSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(422).json({ errors: parsed.error.flatten().fieldErrors });
  }

  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ message: "Not authenticated" });

  try {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return res.status(404).json({ message: "User not found" });
    if (user.isBlocked)
      return res.status(403).json({ message: "This account has been blocked." });

    const held = user.roles ?? [];
    if (held.includes(Role.ADMIN) || held.includes(Role.DELIVERY)) {
      return res
        .status(403)
        .json({ message: "ADMIN and DELIVERY accounts cannot become vendors" });
    }
    if (!held.includes(Role.CUSTOMER)) {
      return res
        .status(403)
        .json({ message: "Only CUSTOMER accounts can become vendors" });
    }
    if (held.includes(Role.VENDOR)) {
      return res.status(400).json({ message: "Account already holds VENDOR role" });
    }
    if (!user.isEmailVerified) {
      return res
        .status(403)
        .json({ message: "Please verify your email before becoming a vendor." });
    }

    const nextRoles = [...held, Role.VENDOR];
    try {
      assertRoleCombination(nextRoles);
    } catch (e) {
      return res
        .status(403)
        .json({ message: e instanceof Error ? e.message : "Invalid role combination" });
    }

    // Conditional atomic update. The predicate below re-derives the role
    // rules against the LATEST row rather than trusting the read above,
    // because that read can go stale before this write lands:
    //
    //   * another become-vendor winning the race  -> excluded, no duplicate
    //   * a concurrent admin role change to ADMIN / DELIVERY -> excluded, so
    //     the push cannot produce the forbidden [ADMIN, VENDOR] or
    //     [DELIVERY, VENDOR] combinations that `assertRoleCombination` above
    //     only proves for the combination as it was READ.
    //
    // Both exclusions are expressed in the same UPDATE's WHERE clause, so
    // they are evaluated by PostgreSQL against the row as it is locked for
    // this statement — there is no window between the check and the write.
    // (A row whose `roles` is NULL matches neither exclusion and so is
    // skipped entirely; such a row is already refused earlier by the
    // CUSTOMER-membership check, which reads `roles ?? []`.)
    const data: Record<string, unknown> = {
      brandName: parsed.data.brandName,
    };
    if (parsed.data.phoneNumber !== undefined) {
      // Batch 1D.40: same identity guard as updateProfile. Collecting a phone
      // during vendor onboarding must not be able to displace a number the
      // user already proved, because this write never touches
      // `phoneNumberE164` / `isPhoneVerified`. An unverified number is still
      // accepted (it is how the vendor PROFILE step gets filled in).
      // Reuses the user row already loaded above; no extra round trip.
      const decision = resolveProfilePhoneWrite(parsed.data.phoneNumber, {
        phoneNumber: user.phoneNumber,
        phoneNumberE164: user.phoneNumberE164,
        isPhoneVerified: user.isPhoneVerified,
      });
      if (decision.kind === "reject") {
        return res.status(decision.status).json({
          success: false,
          code: decision.code,
          message: decision.message,
        });
      }
      if (decision.kind === "accept") data.phoneNumber = decision.phoneNumber;
    }
    if (parsed.data.brandLogo !== undefined) data.brandLogo = parsed.data.brandLogo;

    const claimed = await prisma.user.updateMany({
      where: {
        id: userId,
        AND: [
          { NOT: { roles: { has: Role.VENDOR } } },
          { NOT: { roles: { hasSome: [Role.ADMIN, Role.DELIVERY] } } },
        ],
      },
      data: { ...data, roles: { push: Role.VENDOR } },
    });
    if (claimed.count === 0) {
      const fresh = await prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, roles: true },
      });
      if (!fresh) return res.status(404).json({ message: "User not found" });
      // The predicate now excludes two distinct situations, so the loser of
      // the write must be told which one actually happened rather than
      // always being told it already holds VENDOR.
      const freshRoles = fresh.roles ?? [];
      if (freshRoles.includes(Role.ADMIN) || freshRoles.includes(Role.DELIVERY)) {
        return res
          .status(403)
          .json({ message: "ADMIN and DELIVERY accounts cannot become vendors" });
      }
      return res.status(409).json({ message: "Account already holds VENDOR role" });
    }

    const updated = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, role: true, roles: true },
    });
    if (!updated) return res.status(404).json({ message: "User not found" });

    // Phase 1C: the account now holds VENDOR — enter the lifecycle as NEW.
    await ensureVendorStatusNew(userId);
    await evaluateVendorStatus(userId);

    return res.status(200).json({
      message: "VENDOR role added. Switch to it via POST /api/auth/switch-role.",
      role: updated.role,
      roles: updated.roles,
    });
  } catch (error) {
    return handlePrismaError(error, res);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Phase 1B multi-role: POST /api/auth/switch-role
// Switch the ACTIVE role between held CUSTOMER/VENDOR roles and mint a fresh
// access token for the new active role. Refresh tokens/sessions unchanged.
// ─────────────────────────────────────────────────────────────────────────────
export const switchRole = async (req: AuthRequest, res: Response) => {
  const parsed = switchRoleSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(422).json({ errors: parsed.error.flatten().fieldErrors });
  }

  const userId = req.user?.id;
  const sessionId = req.user?.sessionId;
  if (!userId || !sessionId)
    return res.status(401).json({ message: "Not authenticated" });

  try {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return res.status(404).json({ message: "User not found" });
    if (user.isBlocked) {
      await deleteAllUserSessions(user.id).catch(() => {});
      return res
        .status(403)
        .json({ message: "This account has been blocked." });
    }

    const target = Role[parsed.data.role as keyof typeof Role];
    if (!hasRole(user, target)) {
      return res
        .status(403)
        .json({ message: "Account does not hold the requested role" });
    }

    // The authenticate middleware already verified this session, but the
    // token must also be rejected if the session was revoked between the
    // middleware check and now (logout-all-devices racing a switch).
    const session = await getUserSession(userId, sessionId);
    if (!session) {
      return res.status(401).json({ message: "Session expired. Please log in again." });
    }

    // Phase 1E: a role switch belongs to THIS session only. It used to write
    // `User.role`, which is account-wide, so switching on a phone silently
    // re-roled every other device — and a second switch back on a laptop
    // re-roled the phone. The account role now stays the account default and
    // each session carries its own active role; `authenticate` rejects a token
    // whose claim no longer matches the session's role, so the new role takes
    // effect on the very next request rather than at token expiry.
    await setSessionActiveRole(userId, sessionId, target);

    const accessToken = generateAccessToken(user.id, target, sessionId, user.tokenVersion);

    return res.status(200).json({
      accessToken,
      role: target,
      roles: user.roles,
    });
  } catch (error) {
    logger.error({ err: error, userId, sessionId }, "Switch role failed");
    return res.status(500).json({ message: "Something went wrong while switching role" });
  }
};

// Verify the reset code and issue a short-lived JWT
export const verifyResetCode = async (req: Request, res: Response) => {
  const { email, code } = req.body;

  if (!email || !code) {
    return res.status(422).json({ message: "Email and code are required" });
  }

  try {
    const user = await findUserByEmail(email);

    // Enumeration hardening: an unknown account yields the SAME 406 the caller
    // already receives for a wrong or expired code, so this endpoint discloses
    // nothing about whether the address is registered. The submitted code is
    // still validated on the real path — a caller holding a genuine code is not
    // learning anything new, and accepting a wrong code would break real users.
    if (!user) {
      await prisma.passwordResetToken.findUnique({
        where: { userId: "__no_such_user__" },
      });
      // Batch 1D.53: same class of Redis work as the known branch (an
      // increment that is never read back), so an outage fails both branches
      // identically instead of oracling existence.
      // Batch 1D.74: bounded, so this branch fails the same way as the known
      // one on an unhealthy connection.
      await recordResetAttempt(resetUnknownAttemptsKeyFor(email), {
        timeoutMs: RESET_LIMITS_COMMAND_TIMEOUT_MS,
      });
      logger.info("[verifyResetCode] request received for an unregistered address");
      return res.status(406).json({ message: "Invalid or expired reset code" });
    }

    const tokenEntry = await prisma.passwordResetToken.findUnique({
      where: { userId: user.id },
    });

    const now = new Date();

    if (!tokenEntry) {
      // Batch 1D.75: this branch used to answer 406 without touching Redis,
      // which made it the odd one out during an outage — an unknown address
      // and a known address WITH a challenge both reached Redis and failed to
      // 500, while this path still returned 406. That difference let a caller
      // separate "registered, no active challenge" from everything else, which
      // is exactly what the decoy increment above exists to prevent.
      //
      // So the same bounded increment runs here too. When Redis is healthy the
      // response is unchanged (406, same body); when it is not, this branch now
      // fails exactly like the other two.
      //
      // It cannot weaken the attempt limit: the counter is only ever READ on
      // the path where a challenge exists, and issuing a challenge calls
      // clearResetAttempts fail-closed first, so a counter created here can
      // never strand or pre-exhaust a real challenge.
      await recordResetAttempt(resetAttemptsKeyFor(user.id), {
        timeoutMs: RESET_LIMITS_COMMAND_TIMEOUT_MS,
      });
      return res.status(406).json({ message: "Invalid or expired reset code" });
    }

    // Batch 1D.53: increment-first attempt counting in one atomic Lua round
    // trip. The 1st–5th attempts of a challenge are answered on the merits;
    // from the 6th on the challenge is exhausted and even the correct code
    // is refused. Counting before comparing (rather than only on mismatch)
    // is what keeps concurrent guesses from slipping extras past the limit.
    const attempt = await recordResetAttempt(resetAttemptsKeyFor(user.id), {
      timeoutMs: RESET_LIMITS_COMMAND_TIMEOUT_MS,
    });
    if (attempt.exhausted) {
      logger.info({ userId: user.id }, "verifyResetCode: challenge attempt limit exhausted");
      return res.status(406).json({ message: "Invalid or expired reset code" });
    }

    if (
      !resetCodeMatches(tokenEntry.token, config.jwtResetSecret, email, code) ||
      tokenEntry.expiresAt < now
    ) {
      return res.status(406).json({ message: "Invalid or expired reset code" });
    }

    // Create short-lived reset token
    const resetToken = jwt.sign({ id: user.id }, config.jwtResetSecret, {
      expiresIn: "10m",
    });

    // Save the resetToken itself in DB
    await prisma.passwordResetToken.update({
      where: { userId: user.id },
      data: {
        // Batch 1D.51: the JWT is a bearer credential — store only its HMAC
        // digest, never the raw token. The client keeps the only usable copy.
        token: resetJwtDigest(config.jwtResetSecret, resetToken), // replaces the code digest
        expiresAt: new Date(Date.now() + 10 * 60 * 1000), // 10 mins
      },
    });

    // The challenge is consumed: drop its attempt counter so no stale state
    // lingers. Best-effort — the next issuance clears it fail-closed anyway,
    // so a failure here must not fail the verification itself.
    // Batch 1D.74: bounded like the others. Swallowing the ERROR is correct;
    // without a bound, a hung command would still hold the request open, so
    // the timeout is what actually makes this cleanup best-effort in practice.
    try {
      await clearResetAttempts(resetAttemptsKeyFor(user.id), {
        timeoutMs: RESET_LIMITS_COMMAND_TIMEOUT_MS,
      });
    } catch (clearErr) {
      logger.warn({ err: clearErr, userId: user.id }, "verifyResetCode: attempt-counter cleanup failed");
    }

    return res.status(200).json({
      message: "Reset code verified successfully",
      resetToken,
    });
  } catch (error) {
    logger.error({ err: error }, "verifyCode failed");
    return res.status(500).json({ message: "Failed to verify reset code" });
  }
};





export const secureResetPassword = async (req: Request, res: Response) => {
  const parsed = secureResetSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(422).json({ errors: parsed.error.flatten().fieldErrors });
  }

  const { resetToken, newPassword } = parsed.data;

  try {
    const decoded = jwt.verify(resetToken, config.jwtResetSecret) as {
      id: string;
      exp?: number;
    };

    // Batch 1D.70: shared, cross-instance finalization counter.
    //
    // Placement is load-bearing. It sits AFTER signature verification (so an
    // unauthenticated caller cannot flood Redis with keys derived from junk,
    // and the 407 contract for an undecodable token is untouched) and BEFORE
    // every database lookup and the bcrypt hash (so a refused request costs
    // one Redis round trip and nothing else — the endpoint used to be a CPU
    // amplifier, because the expensive hash ran before the single-use gate and
    // concurrent racers each paid it before losing the transaction).
    //
    // The counter is credential-scoped, not account-scoped: see
    // resetFinalizeIdentity for why a user-id key would be an enumeration
    // oracle and a lockout vector.
    if (typeof decoded.exp !== "number") {
      // Every reset token this service issues carries `exp`; a signed token
      // without one is refused rather than given a counter whose lifetime we
      // cannot bound.
      return res.status(406).json({ message: "Invalid or expired reset token" });
    }
    // Expiry tracks the credential's ACTUAL remaining lifetime rather than a
    // fresh fixed window: the counter must never lapse while the token it
    // guards is still usable. `exp` is whole seconds, so ceil() rounds the
    // remainder UP and the counter strictly outlives the credential; the Lua
    // sets EXPIRE only on the first increment, so later attempts cannot
    // shorten or extend it.
    const remainingSeconds = Math.max(
      1,
      Math.ceil((decoded.exp * 1000 - Date.now()) / 1000),
    );
    let finalizeAttempt: { count: number; exhausted: boolean };
    try {
      finalizeAttempt = await recordResetAttempt(resetFinalizeKeyFor(resetToken), {
        windowSeconds: remainingSeconds,
        maxAttempts: RESET_FINALIZE_MAX_ATTEMPTS,
        timeoutMs: RESET_LIMITS_COMMAND_TIMEOUT_MS,
      });
    } catch (e) {
      // Fail CLOSED and retryably: an unreadable counter is not evidence that
      // the request is legitimate. Nothing has been written, consumed or
      // revoked at this point, so the caller may safely retry once Redis is
      // back. The response is fixed and carries nothing about the account.
      logger.warn(
        { err: e instanceof Error ? e : new Error(String(e)) },
        "Secure reset password: finalization counter unavailable",
      );
      return res.status(503).json({
        message: "Password reset is temporarily unavailable. Please retry shortly.",
      });
    }
    // Increment-first, so every request that reaches here consumes budget —
    // whether or not the token lookup, digest check or finalization below
    // succeeds. The 6th attempt is refused here, before any work.
    if (finalizeAttempt.exhausted) {
      return res.status(429).json({
        success: false,
        code: "RESET_RATE_LIMITED",
        message: "Too many password reset attempts. Please try again later.",
      });
    }

    const user = await findUserById(decoded.id);
    if (!user) return res.status(404).json({ message: "User not found" });

    // 🔥 Check DB entry for reset token
    const tokenEntry = await prisma.passwordResetToken.findUnique({
      where: { userId: user.id },
    });

    if (
      !tokenEntry ||
      !resetJwtMatches(tokenEntry.token, config.jwtResetSecret, resetToken) ||
      tokenEntry.expiresAt < new Date()
    ) {
      return res
        .status(406)
        .json({ message: "Invalid or expired reset token" });
    }

    // Hash new password outside the transaction below: bcrypt is CPU-bound
    // (~100ms+) and there is no reason to hold a database transaction open
    // while it runs. A losing racer wastes one hash; that is harmless.
    const hashedPassword = await bcrypt.hash(
      newPassword,
      config.bcryptSaltRounds,
    );

    // Batch 1D.55: consume-then-write inside ONE transaction. The conditional
    // delete is the single-use gate — it removes exactly the presented
    // credential (this user, this digest, still unexpired) and reports how
    // many rows it removed. A concurrent request that already consumed it
    // finds nothing to delete (count 0) and aborts BEFORE any password
    // write, so two racers cannot both succeed and neither can leave a
    // half-finalized state: any failure rolls everything back.
    const expectedDigest = resetJwtDigest(config.jwtResetSecret, resetToken);
    try {
      await prisma.$transaction(async (tx) => {
        const consumed = await tx.passwordResetToken.deleteMany({
          where: {
            userId: user.id,
            token: expectedDigest,
            expiresAt: { gt: new Date() },
          },
        });
        if (consumed.count !== 1) {
          throw new ResetCredentialConsumedError();
        }
        await tx.user.update({
          where: { id: user.id },
          data: {
            password: hashedPassword,
            authProviders: user.authProviders.includes("GOOGLE")
              ? user.authProviders
              : { push: "LOCAL" },
            // Previously a separate post-write update; folded in so the
            // version bump commits or rolls back together with the password.
            // Refresh rejects on version mismatch, so this bump is the hard
            // revocation guarantee behind the session cleanup below.
            tokenVersion: { increment: 1 },
          },
        });
      });
    } catch (txErr) {
      if (txErr instanceof ResetCredentialConsumedError) {
        return res
          .status(406)
          .json({ message: "Invalid or expired reset token" });
      }
      throw txErr;
    }

    // Revoke every existing session and invalidate every outstanding
    // refresh token — previously missing entirely. If the account had
    // been compromised (which resetting a password is often a response
    // to), an attacker's already-active session stayed valid right
    // through the reset, completely defeating the point of it.
    //
    // Batch 1D.55: best-effort from here on. The password change and
    // credential consumption above have already committed, and the
    // tokenVersion bump inside the transaction already guarantees that
    // outstanding refresh tokens are rejected — so a Redis outage must not
    // turn an accomplished reset into an error response.
    try {
      await deleteAllUserSessions(user.id);
    } catch (sessionErr) {
      logger.warn(
        { err: sessionErr instanceof Error ? sessionErr : new Error(String(sessionErr)), userId: user.id },
        "Secure reset password: session cleanup failed",
      );
    }

    res.status(200).json({
      message:
        "Password has been reset successfully. You have been logged out of all devices for security.",
    });
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    console.error("Secure reset password error:", err.message);
    return res.status(407).json({ message: "Invalid or expired reset token" });
  }
};

/**
 * Batch 1D.55: thrown inside the finalization transaction when the
 * conditional credential delete removes nothing — i.e. a concurrent request
 * already consumed it (or it lapsed between the pre-check and the write).
 * Caught immediately around the transaction and answered 406, the existing
 * invalid-credential contract.
 */
class ResetCredentialConsumedError extends Error {
  constructor() {
    super("Reset credential already consumed");
    this.name = "ResetCredentialConsumedError";
  }
}

// Phase 1E: authenticated password change.
//
// - Requires the current password for password accounts (bcrypt compare).
// - Rejects reusing the current password (no history table in this phase).
// - Google-only accounts (password null) are directed to the existing
//   forgot-password flow, which is the supported way to establish one.
// - Phase 1E security-first policy: changing the password invalidates EVERY
//   credential issued before the change — the `tokenVersion` bump and the new
//   hash are written in one atomic statement — and then re-issues a fresh
//   session for the calling device only, under the new tokenVersion.
//   Previously other sessions were swept best-effort with no version bump, so
//   a sweep failure silently left other devices holding working credentials.
export const changePassword = async (req: AuthRequest, res: Response) => {
  const parsed = changePasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(422).json({ errors: parsed.error.flatten().fieldErrors });
  }

  const userId = req.user?.id;
  const sessionId = req.user?.sessionId;
  if (!userId || !sessionId)
    return res.status(401).json({ message: "Not authenticated" });

  const { currentPassword, newPassword } = parsed.data;

  try {
    const user = await findUserById(userId);
    if (!user) return res.status(404).json({ message: "User not found" });

    if (!user.password) {
      return res.status(400).json({
        message:
          "This account signs in with Google and has no password yet. Use forgot-password to set one.",
      });
    }

    if (!(await comparePasswords(currentPassword, user.password))) {
      return res.status(401).json({ message: "Current password is incorrect" });
    }

    if (await comparePasswords(newPassword, user.password)) {
      return res.status(400).json({
        message: "New password must be different from the current password",
      });
    }

    const hashed = await bcrypt.hash(newPassword, config.bcryptSaltRounds);

    // Phase 1E security-first policy: every credential issued before this
    // change becomes unusable, and the calling device gets a fresh valid
    // session.
    //
    // The authoritative step is this ONE database write. Bumping `tokenVersion`
    // in the same statement as the hash means there is no window in which the
    // new password is stored but old refresh tokens still validate — and it
    // cannot half-succeed, because it is one row update. If it throws, the
    // catch below returns a failure and no success is implied.
    //
    // This is what makes the *best-effort* Redis sweep below safe. Previously
    // the sweep WAS the invalidation, so a sweep failure silently left other
    // devices holding working refresh tokens. Now those tokens are already
    // dead against the new `tokenVersion` (refresh compares it at
    // refreshToken), and the sweep is defence in depth plus cleanup.
    const bumped = await prisma.user.update({
      where: { id: userId },
      data: { password: hashed, tokenVersion: { increment: 1 } },
      select: { tokenVersion: true },
    });
    const tokenVersionAfter = bumped.tokenVersion;

    // Sweep every session, including the current one: its sessionId is about
    // to be retired, and leaving it behind would leave a credential that
    // passes `tokenVersion` but still names a stale session.
    //
    // Phase 1E.1: the verdict comes from the authoritative database delete,
    // not from this call merely resolving. If the rows survived, outstanding
    // access tokens may still work, and the response must say so rather than
    // claim every device was signed out.
    let sessionsDeleted = false;
    try {
      sessionsDeleted = await deleteAllUserSessions(userId);
    } catch (e) {
      logger.error(
        { err: e, userId },
        "changePassword: session sweep threw after tokenVersion was already bumped",
      );
      sessionsDeleted = false;
    }

    // Re-establish the caller: a NEW sessionId under the NEW tokenVersion.
    // Its access token carries the role the caller was acting as, so a
    // password change does not silently drop them back to the account role.
    const roleForNewSession = await getUserSession(userId, sessionId)
      .then((s) => resolveSessionRole(s, user.role))
      .catch(() => null)
      .then((r) => r ?? user.role ?? null);
    const newSessionId = uuidv4();
    const newRefreshJti = uuidv4();
    await createUserSession(userId, newSessionId, {
      activeRole: roleForNewSession,
      lastLoginAt: new Date(),
      ip: req.ip,
      userAgent: req.headers?.["user-agent"] ?? "unknown",
    });
    const newAccessToken = generateAccessToken(userId, roleForNewSession, newSessionId, tokenVersionAfter);
    const newRefreshToken = generateRefreshToken(userId, tokenVersionAfter, newSessionId, newRefreshJti);
    await setRefreshJti(userId, newSessionId, newRefreshJti);

    res.cookie("refreshToken", newRefreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      maxAge: 7 * 24 * 60 * 60 * 1000,
      path: "/api/auth/refresh-token",
    });

    const isMobile = req.headers?.["x-client-type"] === "mobile";
    return res.status(200).json({
      message: sessionsDeleted
        ? "Password changed successfully. All other devices have been signed out."
        : // Truthful partial outcome: the password IS changed and every
          // pre-change refresh token IS dead (the tokenVersion bump above is
          // what guarantees that). What could not be confirmed is the
          // deletion of the session rows, so outstanding ACCESS tokens — which
          // carry no version claim and stop only when their session goes — may
          // keep working until they expire. Say exactly that, and say nothing
          // about the password having been rolled back.
          "Password changed successfully, but we could not confirm that other devices were signed out. " +
            "Other devices may remain signed in for a short period. If this was not you, sign out of all devices again shortly and contact support.",
      accessToken: newAccessToken,
      ...(isMobile ? { refreshToken: newRefreshToken } : {}),
    });
  } catch (error) {
    return handlePrismaError(error, res);
  }
};

// this link is to verify email
export const verifyEmail = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const { token } = req.query;
  console.log('Verify email called with token:', '***');

  if (!token || typeof token !== "string") {
    console.log("Invalid token format");
    res.status(400).send(`
      <html>
        <head><title>Invalid Token</title></head>
        <body style="font-family: sans-serif; text-align: center; padding: 3rem;">
          <h2 style="color: red;">❌ Invalid token</h2>
          <p>The verification link is invalid.</p>
        </body>
      </html>
    `);
    return;
  }

  try {
    const user = await prisma.user.findFirst({
      where: {
        emailVerificationToken: token,
        emailVerificationExpiresAt: { gt: new Date() },
      },
    });

    if (!user) {
      console.log("No user found with this token");
      res.status(400).send(`
        <html>
          <head><title>Verification Failed</title></head>
          <body style="font-family: sans-serif; text-align: center; padding: 3rem;">
            <h2 style="color: red;">❌ Email verification failed</h2>
            <p>This verification link is invalid or has expired.</p>
          </body>
        </html>
      `);
      return;
    }

    await prisma.user.update({
      where: { id: user.id },
      data: {
        isEmailVerified: true,
        emailVerificationToken: null,
        emailVerificationExpiresAt: null,
      },
    });

    console.log('Email verified for user:', '***');
    res.status(200).send(`
      <html>
        <head><title>Email Verified</title></head>
        <body style="font-family: sans-serif; text-align: center; padding: 3rem;">
          <h2 style="color: green;">✅ Email verified successfully!</h2>
          <p>You can now close this tab and return to the app.</p>
        </body>
      </html>
    `);
  } catch (error) {
    logger.error({ err: error }, "verifyEmail failed");
    res.status(500).send(`
      <html>
        <head><title>Server Error</title></head>
        <body style="font-family: sans-serif; text-align: center; padding: 3rem;">
          <h2 style="color: red;">⚠️ Internal Server Error</h2>
          <p>Please try again later.</p>
        </body>
      </html>
    `);
  }
};

// this will resend the verification link to the user's email if it's invalid or expired
export const resendVerificationEmail = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      res.status(400).json({ message: "Invalid email address" });
      return;
    }

    const { email } = result.data;

    const user = await prisma.user.findUnique({ where: { email } });

    // Enumeration hardening. Two leaks are closed here:
    //   - a missing account used to answer 404 "User not found";
    //   - an ALREADY-VERIFIED account used to answer 400 "Email is already
    //     verified", which disclosed account state to an unauthenticated caller.
    // Both now return the same 200 + same message as the happy path. The work
    // done on each branch is comparable (one indexed lookup plus, for a real
    // unverified account, token generation and an update), so no artificial
    // delay is needed to blunt the timing difference.
    if (!user) {
      logger.info("[resendVerificationEmail] request received for an unregistered address");
      res.status(200).json({ message: RESEND_VERIFICATION_MESSAGE });
      return;
    }

    if (user.isEmailVerified) {
      logger.info({
        userId: user.id,
      }, "[resendVerificationEmail] request received for an already-verified address");
      res.status(200).json({ message: RESEND_VERIFICATION_MESSAGE });
      return;
    }

    const token = crypto.randomUUID();
    const expiresAt = dayjs().add(30, "second").toDate();

    await prisma.user.update({
      where: { email },
      data: {
        emailVerificationToken: token,
        emailVerificationExpiresAt: expiresAt,
      },
    });

    sendVerificationLinkAsync(req, user.email, token);

    res.status(200).json({ message: RESEND_VERIFICATION_MESSAGE });
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    console.error("[resendVerificationEmail]", err.message);
    res.status(500).json({ message: "Internal server error" });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Phase 1D.3: phone OTP (authenticated only).
//
// Both endpoints require a valid session. There is deliberately no public
// OTP endpoint in this phase: without touching the registration flow, a
// public endpoint could not distinguish new numbers from other users'
// numbers without leaking ownership or enabling SMS abuse. Registration,
// login and password-reset integration arrive in later 1D tasks.
// ─────────────────────────────────────────────────────────────────────────────

// Anti-enumeration (Phase 1D.4).
//
// These two endpoints used to answer 409 "This phone number is unavailable"
// as soon as the submitted number turned out to belong to somebody else, which
// made the authenticated add/verify pair a reliable oracle for "is this number
// registered?": 409 meant somebody else's, 200 "Verification code sent" meant
// nobody's. Phone ownership is now an INTERNAL decision only. It gates SMS
// delivery and it blocks the write; it never shapes a response.
//
// The public phone-login pair below already worked this way (see
// requestPhoneLoginOtp) and must keep working this way. Sharing one constant
// between the ordinary wrong-code branch and both conflict branches makes the
// equivalence structural rather than a coincidence of wording.
const PHONE_OTP_INVALID_MESSAGE = "Invalid verification code";

// POST /api/auth/phone/request-otp
export const requestPhoneOtp = async (req: AuthRequest, res: Response) => {
  const parsed = requestPhoneOtpSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(422).json({ errors: parsed.error.flatten().fieldErrors });
  }

  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ message: "Not authenticated" });

  let e164: string;
  try {
    e164 = normalizePhoneNumber(parsed.data.phoneNumber);
  } catch {
    return res.status(400).json({ message: "Invalid phone number" });
  }
  const purpose = OtpPurpose[parsed.data.purpose];

  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, phoneNumberE164: true, isPhoneVerified: true, password: true },
    });
    if (!user) return res.status(404).json({ message: "User not found" });

    // Idempotent: already verified for this exact canonical number.
    if (user.isPhoneVerified && user.phoneNumberE164 === e164) {
      return res.status(200).json({ message: "Phone number already verified" });
    }

    // Phase 1D.4 step-up: replacing an already-verified phone needs the
    // current password on top of the session + new-number OTP, so a stolen
    // session alone cannot re-point the account's verified number. New
    // numbers alone are never enough proof for a verified-phone change.
    // Passwordless (Google-only) accounts have no password to re-check;
    // their OAuth session plus the new-number OTP remain the factors.
    const changingVerifiedPhone =
      user.isPhoneVerified && !!user.phoneNumberE164 && user.phoneNumberE164 !== e164;
    if (changingVerifiedPhone && user.password) {
      if (!parsed.data.currentPassword) {
        return res.status(400).json({ message: "Current password is required to change your phone number" });
      }
      if (!(await comparePasswords(parsed.data.currentPassword, user.password))) {
        return res.status(401).json({ message: "Current password is incorrect" });
      }
    }

    // Ownership lookup stays internal. It decides whether an SMS leaves the
    // building, never whether the caller learns the answer: a number owned by
    // another account is answered exactly like an unclaimed one.
    const owner = await prisma.user.findUnique({
      where: { phoneNumberE164: e164 },
      select: { id: true },
    });
    const ownedByAnother = !!owner && owner.id !== userId;

    const provider = getSmsProvider();
    const result = await requestOtp(
      // req.ip is the address Express resolved under the app's `trust proxy`
      // setting, so the shared per-IP budget cannot be sidestepped by
      // forging forwarding headers.
      { phoneNumber: e164, purpose, ip: req.ip },
      {
        // Delivery is conditional; the stored record and both budgets are not,
        // exactly as on the public phone-login path. A probe of somebody
        // else's number therefore still costs the per-phone request budget,
        // the per-IP budget and the resend cooldown, so enumerating this
        // endpoint is bounded by the same cross-instance limits as any other
        // OTP request. Nothing is delivered, so no usable code is ever issued
        // for a number the caller does not control.
        onGenerated: ownedByAnother
          ? undefined
          : (otp) => provider.sendOtp({ phoneNumberE164: e164, otp, purpose }),
      },
    );
    if (result.status === "COOLDOWN") {
      return res.status(429).json({ message: "Please wait before requesting another code" });
    }
    if (result.status === "RATE_LIMITED") {
      return res.status(429).json({ message: "Too many OTP requests, please try again later" });
    }
    return res.status(200).json({ message: "Verification code sent" });
  } catch (error) {
    if (error instanceof OtpDeliveryError) {
      return res.status(502).json({ message: "Failed to send verification code, please try again" });
    }
    if (error instanceof SmsProviderError) {
      return res.status(503).json({ message: "Verification service unavailable, please try again" });
    }
    if (error instanceof OtpServiceError) {
      return res.status(503).json({ message: "Verification service unavailable, please try again" });
    }
    return handlePrismaError(error, res);
  }
};

// POST /api/auth/phone/verify-otp
export const verifyPhoneOtp = async (req: AuthRequest, res: Response) => {
  const parsed = verifyPhoneOtpSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(422).json({ errors: parsed.error.flatten().fieldErrors });
  }

  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ message: "Not authenticated" });

  let e164: string;
  try {
    e164 = normalizePhoneNumber(parsed.data.phoneNumber);
  } catch {
    return res.status(400).json({ message: "Invalid phone number" });
  }
  const purpose = OtpPurpose[parsed.data.purpose];
  const rawInput = parsed.data.phoneNumber.trim();

  try {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return res.status(404).json({ message: "User not found" });

    // Idempotent: already verified for this exact number — no OTP needed.
    if (user.isPhoneVerified && user.phoneNumberE164 === e164) {
      return res.status(200).json({ message: "Phone number already verified", phoneNumberE164: e164 });
    }

    // The OTP is validated FIRST. Checking ownership before it was an oracle
    // twice over: the 409 told the caller the number was taken, and the
    // short-circuit skipped the attempt counter, so a number owned by
    // somebody else never reached MAX_ATTEMPTS while every other number did.
    // Both channels are closed by validating first and letting the ordinary
    // attempt accounting run for every number alike.
    const result = await verifyOtp({ phoneNumber: e164, purpose, otp: parsed.data.otp });
    if (result.status === "INVALID") {
      return res.status(400).json({ message: PHONE_OTP_INVALID_MESSAGE });
    }
    if (result.status === "EXPIRED") {
      return res.status(400).json({ message: "Verification code expired, please request a new one" });
    }
    if (result.status === "MAX_ATTEMPTS") {
      return res.status(429).json({ message: "Too many attempts, please request a new code" });
    }

    // Only a caller who already held a valid code for this number gets this
    // far, so this lookup cannot be used to probe ownership. The code has been
    // consumed; the number is simply left unattached and the answer is the
    // same one a wrong code would have received.
    const recheck = await prisma.user.findUnique({
      where: { phoneNumberE164: e164 },
      select: { id: true },
    });
    if (recheck && recheck.id !== userId) {
      return res.status(400).json({ message: PHONE_OTP_INVALID_MESSAGE });
    }

    try {
      await prisma.user.update({
        where: { id: userId },
        data: {
          phoneNumberE164: e164,
          // Keep the display field coherent with the verified identity:
          // vendor onboarding and contact surfaces read phoneNumber.
          phoneNumber: rawInput,
          isPhoneVerified: true,
          phoneVerifiedAt: new Date(),
        },
      });
    } catch (dbError) {
      if (dbError instanceof Prisma.PrismaClientKnownRequestError && dbError.code === "P2002") {
        // The unique index is the final integrity safeguard against a
        // double owner; losing that race must read exactly like any other
        // failed verification rather than disclose who holds the number.
        return res.status(400).json({ message: PHONE_OTP_INVALID_MESSAGE });
      }
      throw dbError;
    }

    return res.status(200).json({
      message: "Phone number verified successfully",
      phoneNumberE164: e164,
    });
  } catch (error) {
    if (error instanceof OtpServiceError) {
      return res.status(503).json({ message: "Verification service unavailable, please try again" });
    }
    return handlePrismaError(error, res);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Phase 1D.38: public phone login.
//
// The authenticated /phone/* pair above attaches a number to the caller's
// own account. These two endpoints are the other half: proving control of an
// ALREADY-VERIFIED number in order to sign in as its owner, without the owner
// having verified their email address.
//
// Anti-enumeration rules, which are the reason these are shaped this way:
//
//  1. `request-otp` runs the full cooldown + both rate limits and stores a
//     record for EVERY syntactically valid number, then returns one fixed
//     200 body. The SMS is sent only when an eligible account exists, which
//     the caller cannot observe. Known and unknown numbers are therefore
//     indistinguishable in status, body and Redis side effects.
//  2. `verify-otp` consumes the OTP FIRST. Only a caller who already holds a
//     valid code can learn anything about the account behind the number, and
//     the "wrong code" and "no such number" branches return the identical
//     status and body.
//  3. `isEmailVerified` is never read as a gate and never written, so phone
//     login cannot become a way to mark an address verified. Blocked
//     accounts, role handling and session rules are the ordinary ones,
//     applied by the shared issueAuthenticatedSession helper.
// ─────────────────────────────────────────────────────────────────────────────

// Deliberately vague, and shared by the INVALID / EXPIRED / unknown-account
// branches, so a caller cannot tell those apart.
const EMAIL_LOGIN_SENT_MESSAGE =
  "If an account exists for this email address, a verification code has been sent.";
const EMAIL_LOGIN_FAILURE_MESSAGE = "Invalid or expired verification code";

// POST /api/auth/email/login/request-otp — public
export const requestEmailLoginOtp = async (req: Request, res: Response) => {
  const parsed = requestEmailLoginOtpSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(422).json({ errors: parsed.error.flatten().fieldErrors });
  }

  const email = canonicalizeEmail(parsed.data.email);

  // req.ip is the address Express resolved under the app's `trust proxy`
  // setting. The raw X-Forwarded-For header is deliberately NOT read: it is
  // client-supplied and would let a caller mint unlimited IP budgets.
  const ip = req.ip;

  try {
    const account = await prisma.user.findUnique({
      where: { email },
      select: { id: true, isBlocked: true },
    });

    const provider = getEmailProvider();
    const result = await requestEmailOtp(
      { email, purpose: EmailOtpPurpose.LOGIN, ip },
      {
        // Delivery is conditional; the store/limit side effects are not.
        onGenerated:
          account && !account.isBlocked
            ? (otp) =>
                provider.sendEmail({
                  to: email,
                  subject: "Your Food Paddi login code",
                  text: `Your Food Paddi login code is ${otp}. It expires in 5 minutes. If you did not request this code you can ignore this email.`,
                  purpose: "LOGIN_OTP",
                  secretCode: otp,
                })
            : undefined,
        // Dispatch happens AFTER the record is stored and is never awaited, so
        // the response time cannot reveal whether this address has an account,
        // and a gateway outage cannot become a distinguishable 503.
        //
        // Residual, NOT eliminated: dispatch is still skipped for an ineligible
        // address, so a sub-round-trip statistical timing difference remains.
        // Closing that would need a fixed delay, which this codebase
        // deliberately does not add.
        detachDelivery: true,
      },
    );

    if (result.status === "COOLDOWN") {
      return res.status(429).json({ message: "Please wait before requesting another code" });
    }
    if (result.status === "RATE_LIMITED") {
      return res.status(429).json({ message: "Too many OTP requests, please try again later" });
    }

    return res.status(200).json({ message: EMAIL_LOGIN_SENT_MESSAGE });
  } catch (error) {
    if (
      error instanceof OtpDeliveryError ||
      error instanceof EmailProviderError ||
      error instanceof OtpServiceError
    ) {
      return res.status(503).json({ message: "Verification service unavailable, please try again" });
    }
    return handlePrismaError(error, res);
  }
};

// POST /api/auth/email/login/verify-otp — public
export const verifyEmailLoginOtp = async (req: Request, res: Response) => {
  const parsed = verifyEmailLoginOtpSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(422).json({ errors: parsed.error.flatten().fieldErrors });
  }

  const email = canonicalizeEmail(parsed.data.email);

  try {
    // Prove control of the address BEFORE asking the database anything, so a
    // caller who holds no valid code cannot learn whether the account exists.
    const result = await verifyEmailOtp({
      email,
      purpose: EmailOtpPurpose.LOGIN,
      otp: parsed.data.otp,
    });
    if (result.status === "INVALID" || result.status === "EXPIRED") {
      return res.status(400).json({ message: EMAIL_LOGIN_FAILURE_MESSAGE });
    }
    if (result.status === "MAX_ATTEMPTS") {
      return res.status(429).json({ message: "Too many attempts, please request a new code" });
    }

    // The code proved control of THIS address. The lookup is by canonical
    // email, which is the unique account identifier, so a code issued for one
    // account can never authenticate a different one.
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      // Same body as a wrong code.
      return res.status(400).json({ message: EMAIL_LOGIN_FAILURE_MESSAGE });
    }

    // Blocked accounts cannot authenticate this way either. Session revocation
    // is best-effort; `authenticate` re-checks the flag on every request
    // regardless, so a stale session still cannot be used.
    if (user.isBlocked) {
      await deleteAllUserSessions(user.id).catch(() => {});
      return res.status(403).json({ message: "This account has been blocked." });
    }

    // Note what is deliberately absent: isEmailVerified is neither checked nor
    // written. Possession of the mailbox is proof of the login itself; it is
    // NOT a substitute for marking the address VERIFIED, which stays a
    // separate VERIFY_EMAIL-purpose flow.
    await issueAuthenticatedSession(req, res, user, {
      method: "EMAIL",
      message: "Login successful",
    });
  } catch (error) {
    if (error instanceof OtpServiceError) {
      return res.status(503).json({ message: "Verification service unavailable, please try again" });
    }
    return handlePrismaError(error, res);
  }
};

// DELETE /api/auth/phone — private
//
// Targets only req.user.id, so there is no id in the request that could name
// another account. Removing frees the canonical number for normal re-claiming.
export const removePhone = async (req: AuthRequest, res: Response) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ message: "Not authenticated" });

  const parsed = removePhoneSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(422).json({ errors: parsed.error.flatten().fieldErrors });
  }

  try {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return res.status(404).json({ message: "User not found" });

    const hadPhone = !!user.phoneNumber || !!user.phoneNumberE164;
    if (!hadPhone) {
      return res.status(200).json({ message: "No phone number to remove" });
    }

    // Same step-up as replacing a verified phone: a session alone must not be
    // enough to detach the account's identity factor. Passwordless accounts
    // have nothing to re-check, matching the verified-phone change rule.
    if (user.password) {
      if (!parsed.data.currentPassword) {
        return res.status(400).json({ message: "Current password is required to remove your phone number" });
      }
      if (!(await comparePasswords(parsed.data.currentPassword, user.password))) {
        return res.status(401).json({ message: "Current password is incorrect" });
      }
    }

    // Removal must not strand the account. Count only the methods that
    // survive the removal — the phone itself is excluded, so an account
    // whose verified phone was its last way in is refused.
    const remaining = usableLoginMethods({
      isEmailVerified: user.isEmailVerified,
      password: user.password,
      googleId: user.googleId,
      isPhoneVerified: false,
      phoneNumberE164: null,
    });
    if (remaining.length === 0) {
      return res.status(409).json({
        message: "Add and verify another login method before removing your phone number",
      });
    }

    await prisma.user.update({
      where: { id: userId },
      data: {
        // All three move together: clearing only the unique canonical column
        // would leave a display number that no verified identity backs, and
        // vendor onboarding reads `phoneNumber`.
        phoneNumberE164: null,
        phoneNumber: null,
        isPhoneVerified: false,
        phoneVerifiedAt: null,
      },
    });

    // Codes issued against the number are meaningless once it is detached.
    if (user.phoneNumberE164) {
      await clearOtp({ phoneNumber: user.phoneNumberE164, purpose: OtpPurpose.PHONE_VERIFICATION });
      await clearOtp({ phoneNumber: user.phoneNumberE164, purpose: OtpPurpose.PHONE_CHANGE });
    }

    return res.status(200).json({ message: "Phone number removed successfully" });
  } catch (error) {
    if (error instanceof OtpServiceError) {
      return res.status(503).json({ message: "Verification service unavailable, please try again" });
    }
    return handlePrismaError(error, res);
  }
};

export const googleLogin = async (req: Request, res: Response) => {
  try {
    const { idToken } = req.body;

    if (!idToken) {
      return res.status(400).json({ message: "Google ID token is missing." });
    }

    let ticket;
    try {
      ticket = await googleClient.verifyIdToken({
        idToken,
        audience: process.env.GOOGLE_CLIENT_ID,
      });
    } catch (verifyError) {
      const verr = verifyError instanceof Error ? verifyError : new Error(String(verifyError));
      console.error("[Google Token Verification Failed]", verr.message);
      return res.status(401).json({
        message: "Invalid or expired Google token. Please sign in again.",
      });
    }

    const payload = ticket.getPayload();
    if (!payload || !payload.email) {
      return res.status(400).json({
        message: "Unable to extract user information from Google token.",
      });
    }

    const { email, name, picture, sub: googleId } = payload;

    let user = await prisma.user.findUnique({ where: { email } });

    if (user) {
      if (!user.googleId) {
        // Attach Google to existing user
        user = await prisma.user.update({
          where: { email },
          data: {
            googleId,
            isEmailVerified: true,
            authProviders: { push: "GOOGLE" },
          },
        });
      } else if (user.googleId !== googleId) {
        return res.status(409).json({
          message:
            "This email is already linked to a different Google account. Please use the correct account or login with email/password.",
        });
      }
    } else {
      const username = `user_${crypto.randomUUID().slice(0, 8)}`;
      user = await prisma.user.create({
        data: {
          email,
          username,
          name: name || "",
          password: null,
          avatarUrl: picture || null,
          isEmailVerified: true,
          googleId,
          authProviders: ["GOOGLE"],
          loginMethod: "GOOGLE",
          lastLoginAt: new Date(),
          loginHistory: {
            create: [
              {
                method: "GOOGLE",
                ip: req.ip || "",
                userAgent: req.headers["user-agent"] || "",
              },
            ],
          },
        },
      });
    }

    const updates: any = {
      lastLoginAt: new Date(),
      loginMethod: "GOOGLE",
      loginHistory: {
        create: {
          method: "GOOGLE",
          ip: req.ip || "",
          userAgent: req.headers["user-agent"] || "",
        },
      },
    };

    if (!user.authProviders.includes("GOOGLE")) {
      updates.authProviders = { push: "GOOGLE" };
    }

    user = await prisma.user.update({
      where: { id: user.id },
      data: updates,
    });

    // Blocked accounts cannot authenticate via Google either.
    if (user.isBlocked) {
      await deleteAllUserSessions(user.id).catch(() => {});
      return res
        .status(403)
        .json({ message: "This account has been blocked." });
    }

    const sessionId = uuidv4();
    const refreshJti = uuidv4();
    const accessToken = generateAccessToken(user.id, user.role, sessionId, user.tokenVersion);
    const refreshToken = generateRefreshToken(
      user.id,
      user.tokenVersion,
      sessionId,
      refreshJti,
    );

    // Previously missing entirely — the accessToken returned here would
    // be rejected by authenticate on literally every protected endpoint,
    // since no Redis session existed for it. Google login was completely
    // unusable past the login response itself.
    await createUserSession(user.id, sessionId, {
      lastLoginAt: new Date(),
      ip: req.ip || "unknown",
      userAgent: (req.headers["user-agent"] as string) || "unknown",
      deviceId: null,
    });
    // Recording the first jti is best-effort at login: it seeds rotation
    // state, it is not a security decision. If it fails, refresh adopts the
    // incoming jti on first use (the legacy path) rather than rejecting a
    // legitimate sign-in. The REFRESH path below is where an unreadable store
    // must fail closed.
    await setRefreshJti(user.id, sessionId, refreshJti).catch((e) =>
      logger.warn({ err: e, userId: user.id }, "Failed to seed refresh jti at login"),
    );

    res.cookie("refreshToken", refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      maxAge: 7 * 24 * 60 * 60 * 1000,
      path: "/api/auth/refresh-token",
    });

    // Canonical auth contract (same user shape as email login/register,
    // including roles + vendorStatus/isPhoneVerified routing scalars), plus
    // the Google-specific refreshToken body field and isProfileComplete.
    const auth = buildAuthResponse(user, accessToken);
    return res.status(200).json({
      ...auth,
      refreshToken, // also returned in body for mobile clients, matching login/register
      onboarding: resolveOnboardingState({
        role: user.role,
        roles: user.roles,
        kycStatus: user.kycStatus,
        phoneNumber: user.phoneNumber,
        brandName: user.brandName,
        brandLogo: user.brandLogo,
      }),
      pendingRole: !user.role,
      isProfileComplete: !!user.role,
    });
  } catch (err) {
    // Widest catch in this controller: it spans the provider exchange, the
    // user lookup/upsert and session issuance. Nothing sensitive is passed as
    // a separate field — the error goes through the shared allowlist.
    logger.error({ err, provider: "GOOGLE" }, "googleLogin failed");
    return res.status(500).json({
      message:
        "Something went wrong while logging in with Google. Please try again later.",
    });
  }
};

export const updateProfile = async (
  req: AuthRequest,
  res: Response,
): Promise<void> => {
  const userId = req.user?.id;
  const userRole = req.user?.role;

  if (!userId) {
    res.status(401).json({ message: "Unauthorized" });
    return;
  }

  const parsed = updateUserSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(422).json({ errors: parsed.error.flatten().fieldErrors });
    return;
  }

  const rawData = parsed.data;
  const data: Record<string, any> = {};

  // Helper to include fields only if explicitly set and optionally for specific roles
  const includeField = (key: keyof typeof rawData, roles?: string[]) => {
    if (Object.prototype.hasOwnProperty.call(rawData, key)) {
      if (!roles || roles.includes(userRole!)) {
        data[key] = rawData[key];
      }
    }
  };

  // Email change — allow fixing invalid email blocking payments
  if (Object.prototype.hasOwnProperty.call(rawData, "email") && rawData.email) {
    const normalizedEmail = (rawData.email as string).toLowerCase().trim();
    const existing = await prisma.user.findUnique({ where: { email: normalizedEmail } });
    if (existing && existing.id !== userId) {
      res.status(409).json({ success: false, code: "PROFILE_EMAIL_TAKEN", message: "Email already in use" });
      return;
    }
    const currentUser = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        email: true,
        password: true,
        googleId: true,
        isEmailVerified: true,
        isPhoneVerified: true,
        phoneNumberE164: true,
      },
    });
    if (currentUser && currentUser.email !== normalizedEmail) {
      // Changing the address resets isEmailVerified, so LOCAL sign-in stops
      // working until the new address is confirmed. Refuse when that would
      // be the account's LAST way in — the same rule that stops a user
      // removing their only login method, evaluated over the methods that
      // survive the change. (A verified phone survives an email change, so
      // an account whose phone is its only method keeps working.)
      const before = {
        isEmailVerified: currentUser.isEmailVerified,
        password: currentUser.password,
        googleId: currentUser.googleId,
        isPhoneVerified: currentUser.isPhoneVerified,
        phoneNumberE164: currentUser.phoneNumberE164,
      };
      const remaining = usableLoginMethods({
        ...before,
        isEmailVerified: false,
      });
      // Only a change that TAKES AWAY the last method is refused. An
      // account that already had none keeps its recovery path — the
      // verification email for the new address — instead of being trapped.
      if (usableLoginMethods(before).length > 0 && remaining.length === 0) {
        res.status(409).json({
          success: false,
          code: "PROFILE_EMAIL_CHANGE_NO_LOGIN_METHOD",
          message:
            "Add and verify another login method before changing your email address",
        });
        return;
      }
      data.email = normalizedEmail;
      data.isEmailVerified = false;
      data.emailVerificationToken = uuidv4();
      data.emailVerificationExpiresAt = new Date(Date.now() + 60 * 60 * 1000);
    }
  }

  // Phone number — guarded, because this endpoint is not the verification
  // flow. Writing `phoneNumber` here used to leave `phoneNumberE164` and
  // `isPhoneVerified` untouched, so a user with a verified number could swap
  // the displayed number and keep the "verified" flag on a number nobody
  // ever proved. Replacing a verified number must go through
  // /auth/phone/request-otp + /auth/phone/verify-otp (purpose PHONE_CHANGE),
  // which is the only writer of the canonical column.
  if (Object.prototype.hasOwnProperty.call(rawData, "phoneNumber")) {
    const current = await prisma.user.findUnique({
      where: { id: userId },
      select: { phoneNumber: true, phoneNumberE164: true, isPhoneVerified: true },
    });
    const decision = resolveProfilePhoneWrite(rawData.phoneNumber, {
      phoneNumber: current?.phoneNumber ?? null,
      phoneNumberE164: current?.phoneNumberE164 ?? null,
      isPhoneVerified: current?.isPhoneVerified ?? false,
    });
    if (decision.kind === "reject") {
      res.status(decision.status).json({
        success: false,
        code: decision.code,
        message: decision.message,
      });
      return;
    }
    if (decision.kind === "accept") data.phoneNumber = decision.phoneNumber;
  }

  // Common fields for all roles
  includeField("name");
  includeField("bio");
  includeField("avatarUrl");

  // Role-specific fields
  includeField("brandName", ["VENDOR"]);
  includeField("brandLogo", ["VENDOR"]);

  // Notification and discovery preferences are supported for all app roles.
  includeField("preferences", ["CUSTOMER", "VENDOR", "DELIVERY"]);

  // Uploaded file overrides avatarUrl
  if (req.file) {
    data.avatarUrl = `/uploads/${req.file.filename}`;
  }

  // If email changed, we already set isEmailVerified=false + token above
  const emailChanged = !!data.email;

  try {
    const updated = await prisma.user.update({
      where: { id: userId },
      data,
      select: {
        id: true,
        username: true,
        email: true,
        isEmailVerified: true,
        phoneNumber: true,
        avatarUrl: true,
        bio: true,
        preferences: true,
        role: true,
        roles: true,
        addresses: true,
        brandName: true,
        brandLogo: true,
        kycStatus: true,
        updatedAt: true,
        emailVerificationToken: true,
        deliveryPerson: {
          select: {
            id: true,
            vehicleType: true,
            licensePlate: true,
            status: true,
            rating: true,
            totalDeliveries: true,
            walletBalance: true,
            isOnline: true,
          },
        },
      },
    });

    if (emailChanged && updated.emailVerificationToken) {
      sendVerificationLinkAsync(req, updated.email, updated.emailVerificationToken);
    }

    // Phase 1C: a completed profile may satisfy the vendor requirements.
    if (("brandName" in data || "phoneNumber" in data) && updated.roles.includes("VENDOR")) {
      await evaluateVendorStatus(userId).catch((err) =>
        logger.warn({ err, userId }, "evaluateVendorStatus failed after profile update"),
      );
    }

    // Delivery-specific updates (vehicle details only — moderation status
    // is admin-only and never writable here).
    if (userRole === "DELIVERY") {
      const deliveryUpdates: Record<string, any> = {};
      if (rawData.vehicleType)
        deliveryUpdates.vehicleType = rawData.vehicleType;
      if (rawData.licensePlate)
        deliveryUpdates.licensePlate = rawData.licensePlate;

      if (Object.keys(deliveryUpdates).length > 0) {
        await prisma.deliveryPerson.updateMany({
          where: { userId },
          data: deliveryUpdates,
        });
      }
    }

    const onboarding = resolveOnboardingState({
      role: updated.role,
      roles: updated.roles,
      kycStatus: updated.kycStatus,
      phoneNumber: updated.phoneNumber,
      brandName: updated.brandName,
      brandLogo: updated.brandLogo,
    });

    res.status(200).json({
      message: "Profile updated successfully",
      user: updated,
      pendingRole: !updated.role,
      onboarding,
    });
  } catch (error) {
    handlePrismaError(error, res);
  }
};

export const createAddress = async (
  req: AuthRequest,
  res: Response,
): Promise<void> => {
  const userId = req.user?.id;
  if (!userId) {
    res.status(401).json({ message: "Unauthorized" });
    return;
  }

  const parsed = createAddressSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ errors: parsed.error.flatten().fieldErrors });
    return;
  }

  try {
    const newAddress = await prisma.address.create({
      data: {
        ...parsed.data,
        userId,
      },
    });

    res
      .status(201)
      .json({ message: "Address added successfully", address: newAddress });
  } catch (err) {
    logger.error({ err, userId: req.user?.id }, "createAddress failed");
    res.status(500).json({ error: "Server error" });
  }
};

// ✅ Get all addresses
export const getAllAddresses = async (
  req: AuthRequest,
  res: Response,
): Promise<void> => {
  try {
    const addresses = await prisma.address.findMany({
      where: { userId: req.user?.id },
      orderBy: { createdAt: "desc" },
    });
    res.json({ addresses });
  } catch (err) {
    logger.error({ err, userId: req.user?.id }, "getAllAddresses failed");
    res.status(500).json({ error: "Server error" });
  }
};

// ✅ Update an address (with ownership check)
export const updateAddress = async (
  req: AuthRequest,
  res: Response,
): Promise<void> => {
  // Make sure we only get a single string ID
  const rawId = req.params.id;
  const id = Array.isArray(rawId) ? rawId[0] : rawId;

  const userId = req.user?.id;
  if (!userId) {
    res.status(401).json({ message: "Unauthorized" });
    return;
  }

  const parsed = createAddressSchema.partial().safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ errors: parsed.error.flatten().fieldErrors });
    return;
  }

  try {
    // updateMany ensures only the owner's address can be updated
    const updated = await prisma.address.updateMany({
      where: { id, userId },
      data: parsed.data,
    });

    if (updated.count === 0) {
      res
        .status(404)
        .json({ message: "Address not found or not owned by you" });
      return;
    }

    // findUnique expects a single string ID
    const address = await prisma.address.findUnique({
      where: { id },
    });

    res.status(200).json({ message: "Address updated", address });
  } catch (err) {
    logger.error({ err, userId: req.user?.id }, "updateAddress failed");
    res.status(500).json({ error: "Server error" });
  }
};

// ✅ Delete an address (with ownership check)
export const deleteAddress = async (
  req: AuthRequest,
  res: Response,
): Promise<void> => {
  const userId = req.user?.id;
  if (!userId) {
    res.status(401).json({ message: "Unauthorized" });
    return;
  }

  // Ensure ID is a string
  const rawId = req.params.id;
  const id = Array.isArray(rawId) ? rawId[0] : rawId;

  try {
    const deleted = await prisma.address.deleteMany({
      where: { id, userId }, // only owner's address
    });

    if (deleted.count === 0) {
      res
        .status(404)
        .json({ message: "Address not found or not owned by you" });
      return;
    }

    res.status(200).json({ message: "Address deleted" });
  } catch (err) {
    logger.error({ err, userId: req.user?.id }, "deleteAddress failed");
    res.status(500).json({ error: "Server error" });
  }
};
