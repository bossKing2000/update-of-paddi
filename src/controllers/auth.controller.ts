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
import { Role, Prisma } from "@prisma/client";
import { v4 as uuidv4 } from "uuid";
import crypto from "crypto";
import dayjs from "dayjs";
import { sendVerificationEmail } from "../services/mail/sendVerificatioEmail";
import { OAuth2Client } from "google-auth-library";
import {
  registerSchema,
  loginSchema,
  secureResetSchema,
  updateUserSchema,
  createAddressSchema,
} from "../validations/authSchema";
import { generateResetToken } from "../utils/generateResetToken";
import { ensureString } from "../utils/paramUtils";
import { logger } from "../lib/logger";
import {
  deleteUserSession,
  deleteAllUserSessions,
  createUserSession,
  listUserSessions,
  getUserSession,
  setRefreshJti,
  getRefreshJti,
  rotateRefreshJti,
  isRefreshJtiReplay,
  deleteRefreshJti,
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
  console.error(error);
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

  const steps: OnboardingStep[] = [];

  // STEP 1: ROLE — user must pick CUSTOMER / VENDOR / DELIVERY before anything else
  const roleDone = !!role;
  steps.push({
    key: "ROLE",
    done: roleDone,
    missingFields: roleDone ? [] : [onboardingField("ROLE", "role")],
  });

  // STEP 2: KYC — only VENDOR and DELIVERY need NIN verification
  const needsKyc = role === "VENDOR" || role === "DELIVERY";
  const kycDone = !needsKyc ? true : kyc === "VERIFIED";
  steps.push({
    key: "KYC",
    done: kycDone,
    missingFields: needsKyc && !kycDone ? [onboardingField("KYC", "nin")] : [],
  });

  // STEP 3: PROFILE — role-specific required fields
  const missingFields: string[] = [];

  if (role === "VENDOR" || role === "DELIVERY") {
    if (!user.phoneNumber)
      missingFields.push(onboardingField("PROFILE", "phoneNumber"));
  }

  if (role === "VENDOR") {
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

export const register = async (req: AuthRequest, res: Response) => {
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
    if (role) data.role = Role[role as keyof typeof Role];
    if (phoneNumber) data.phoneNumber = phoneNumber;
    if (avatarUrl) data.avatarUrl = avatarUrl;
    if (brandName) data.brandName = brandName;

    const user = await prisma.user.create({ data });

    // ✅ If role is DELIVERY, auto-create linked DeliveryPerson record
    if (role && role.toUpperCase() === "DELIVERY") {
      await prisma.deliveryPerson.create({
        data: {
          userId: user.id,
          status: "ACTIVE",
          isOnline: false,
          rating: 0,
          totalDeliveries: 0,
        },
      });
    }

    // await sendVerificationEmail(req, user.email, verificationToken);

    // Previously register never created a Redis session at all — the
    // accessToken it returned would be rejected by authenticate on the
    // very first authenticated request (e.g. selecting a role right
    // after signing up), forcing an unexpected extra login. Same
    // multi-device session design as login (see lib/session.ts).
    const sessionId = uuidv4();
    const refreshJti = uuidv4();
    const accessToken = generateAccessToken(user.id, user.role, sessionId);
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
    await setRefreshJti(user.id, sessionId, refreshJti);

    res.cookie("refreshToken", refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      maxAge: 7 * 24 * 60 * 60 * 1000,
      path: "/refresh-token",
    });

    const onboarding = resolveOnboardingState({
      role: user.role,
      kycStatus: user.kycStatus,
      phoneNumber: user.phoneNumber,
      brandName: user.brandName,
      brandLogo: user.brandLogo,
    });

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



export const login = async (req: Request, res: Response) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(422).json({ errors: parsed.error.flatten().fieldErrors });
  }

  const { email, password } = parsed.data;

  try {
    const user = await findUserByEmail(email);

    if (
      !user ||
      !user.password ||
      !(await comparePasswords(password, user.password))
    ) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    if (!user.isEmailVerified) {
      return res
        .status(403)
        .json({ message: "Please verify your email before logging in." });
    }

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
    const updatedUser = await prisma.user.update({
      where: { id: user.id },
      data: {
        lastLoginAt: new Date(),
        loginMethod: "LOCAL",
        authProviders: user.authProviders.includes("LOCAL")
          ? undefined
          : { push: "LOCAL" },
        loginHistory: {
          create: {
            method: "LOCAL",
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
    const accessToken = generateAccessToken(user.id, user.role, sessionId);
    const refreshToken = generateRefreshToken(
      user.id,
      user.tokenVersion,
      sessionId,
      refreshJti,
    );

    // Store session in Redis
    await createUserSession(user.id, sessionId, {
      lastLoginAt: new Date(),
      ip,
      userAgent,
      deviceId,
      geoCity: city,
      geoRegion: region,
      geoCountry: country,
    });
    await setRefreshJti(user.id, sessionId, refreshJti);

    res.cookie("refreshToken", refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      maxAge: 7 * 24 * 60 * 60 * 1000,
      path: "/refresh-token",
    });

    // If request is from mobile, also send refreshToken in JSON
    const isMobile = req.headers["x-client-type"] === "mobile";

    const onboarding = resolveOnboardingState({
      role: user.role,
      kycStatus: user.kycStatus,
      phoneNumber: user.phoneNumber,
      brandName: user.brandName,
      brandLogo: user.brandLogo,
    });

    res.status(200).json({
      message: "Login successful",
      pendingRole: !user.role,
      onboarding,
      ...buildAuthResponse(user, accessToken),
      ...(isMobile ? { refreshToken } : {}),
    });
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({ message: "Something went wrong during login" });
  }
};

// Handles refresh tokens from both cookie (web) and body (mobile) — with rotation & reuse detection
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

    // Find user in DB
    const user = await findUserById(decoded.id);
    if (!user || user.tokenVersion !== decoded.tokenVersion) {
      return res.status(401).json({ message: "Invalid refresh token" });
    }

    // A refresh token issued before this session redesign won't carry a
    // sessionId — treat that as expired rather than crashing, forcing a
    // clean re-login (which is the only way to get a real session anyway).
    if (!decoded.sessionId) {
      return res.status(401).json({ message: "Please log in again" });
    }

    const incomingJti = decoded.jti;

    // --- Refresh-token rotation & reuse detection (transparent to normal users) ---
    // New tokens carry jti; legacy tokens (no jti) are grandfathered once then rotated.
    if (incomingJti) {
      const storedJti = await getRefreshJti(user.id, decoded.sessionId);
      // First refresh after deployment: no stored jti yet — adopt incoming as current
      if (!storedJti) {
        await setRefreshJti(user.id, decoded.sessionId, incomingJti);
      } else if (storedJti !== incomingJti) {
        const isReplay = await isRefreshJtiReplay(user.id, decoded.sessionId, incomingJti);
        if (isReplay) {
          // Possible stolen token reuse — revoke all sessions for this user
          logger.warn({ userId: user.id, sessionId: decoded.sessionId, incomingJti, storedJti }, "Refresh token reuse detected — revoking all sessions");
          await deleteAllUserSessions(user.id);
          await prisma.user.update({ where: { id: user.id }, data: { tokenVersion: { increment: 1 } } }).catch(() => {});
          return res.status(401).json({ message: "Session compromised. Please log in again." });
        }
        // Within grace window — reuse of previous jti from concurrent request (isReplay false but not current).
        // Issue new access token but reuse current refresh jti (do not rotate again) to keep clients converged.
        const prevJti = await (async () => {
          try {
            const { redisUsersSessions } = await import("../lib/redis");
            return await redisUsersSessions.get(`refresh:jti:prev:${user.id}:${decoded.sessionId}`);
          } catch { return null; }
        })();
        if (prevJti === incomingJti) {
          const currentJti = storedJti;
          const newAccessTokenGrace = generateAccessToken(user.id, user.role, decoded.sessionId);
          const graceRefreshToken = generateRefreshToken(user.id, user.tokenVersion, decoded.sessionId, currentJti);
          const existingSession = await getUserSession(user.id, decoded.sessionId);
          if (existingSession) {
            await createUserSession(user.id, decoded.sessionId, { ...existingSession, lastRefreshedAt: new Date() });
          } else {
            await createUserSession(user.id, decoded.sessionId, {
              ip: undefined, userAgent: undefined, deviceId: undefined, geoCity: undefined, geoRegion: undefined, geoCountry: undefined,
              lastLoginAt: new Date(), restoredAt: new Date(),
            });
          }
          res.cookie("refreshToken", graceRefreshToken, {
            httpOnly: true,
            secure: process.env.NODE_ENV === "production",
            sameSite: "strict",
            maxAge: 7 * 24 * 60 * 60 * 1000,
            path: "/refresh-token",
          });
          return res.status(200).json({ accessToken: newAccessTokenGrace, refreshToken: graceRefreshToken });
        }
      }
    }

    // Valid refresh — rotate to new jti
    const newJti = uuidv4();
    const newAccessToken = generateAccessToken(
      user.id,
      user.role,
      decoded.sessionId,
    );
    const newRefreshToken = generateRefreshToken(
      user.id,
      user.tokenVersion,
      decoded.sessionId,
      newJti,
    );

    // Persist new jti, keep old as prev for grace window if we had an incoming jti
    if (incomingJti) {
      await rotateRefreshJti(user.id, decoded.sessionId, incomingJti, newJti);
    } else {
      // Legacy token without jti — simply set new
      await setRefreshJti(user.id, decoded.sessionId, newJti);
    }

    const existingSession = await getUserSession(user.id, decoded.sessionId);
    
    // If session exists in Redis, refresh it normally
    if (existingSession) {
      await createUserSession(user.id, decoded.sessionId, {
        ...existingSession,
        lastRefreshedAt: new Date(),
      });
    } else {
      // Session in Redis has expired, but refresh token is still valid.
      // This can happen if user was away for longer than session TTL
      // but within refresh token lifetime. Recreate session from the
      // valid refresh token (grace period for session restoration).
      // We create a fresh session with the same sessionId.
      await createUserSession(user.id, decoded.sessionId, {
        ip: undefined,
        userAgent: undefined,
        deviceId: undefined,
        geoCity: undefined,
        geoRegion: undefined,
        geoCountry: undefined,
        lastLoginAt: new Date(),
        restoredAt: new Date(),
      });
    }

    // Send refresh token as cookie (for web clients)
    res.cookie("refreshToken", newRefreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
      path: "/refresh-token",
    });

    // Also return refresh token in body for mobile apps
    return res.status(200).json({
      accessToken: newAccessToken,
      refreshToken: newRefreshToken, // mobile clients will use this
    });
  } catch (error) {
    console.error("Refresh token error:", error);
    return res
      .status(401)
      .json({ message: "Invalid or expired refresh token" });
  }
};

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
      path: "/refresh-token",
    });

    res.status(200).json({ message: "Logged out successfully" });
  } catch (error) {
    console.error("Logout error:", error);
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
    path: "/refresh-token",
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

// Forgot Password
export const forgotPassword = async (req: Request, res: Response) => {
  const { email } = req.body;
  if (!email) return res.status(422).json({ message: "Email is required" });

  try {
    const user = await findUserByEmail(email);
    if (!user) return res.status(404).json({ message: "User not found" });

    const resetToken = generateResetToken(6); // generates a 6-character alphanumeric token
    const expiresInMinutes = 10;

    await prisma.passwordResetToken.upsert({
      where: { userId: user.id },
      update: {
        token: resetToken,
        expiresAt: new Date(Date.now() + expiresInMinutes * 60 * 1000),
      },
      create: {
        userId: user.id,
        token: resetToken,
        expiresAt: new Date(Date.now() + expiresInMinutes * 60 * 1000),
      },
    });

    // await sendResetEmail(req, email, resetToken);
    // 👇 For testing only — logs the reset code to console
    if (process.env.NODE_ENV !== "production") {
      console.log(`🧪 Reset code for ${email}: ${resetToken}`);
    }
    res.status(200).json({ message: "Reset code sent to your email" });
  } catch (error) {
    console.error("Forgot password error:", error);
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
        phoneNumber: true,
        avatarUrl: true,
        bio: true,
        preferences: true,
        addresses: true,
        brandName: true,
        brandLogo: true,
        kycStatus: true,
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
    console.error("Get profile error:", error);
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
    if (user.role)
      return res.status(400).json({ message: "Role already selected" });

    const updated = await prisma.user.update({
      where: { id: userId },
      data: { role: Role[role as keyof typeof Role] }, // ✅ Safe and typed
    });

    const onboarding = resolveOnboardingState({
      role: updated.role,
      kycStatus: updated.kycStatus,
      phoneNumber: updated.phoneNumber,
      brandName: updated.brandName,
      brandLogo: updated.brandLogo,
    });

    res
      .status(200)
      .json({ message: "Role updated", role: updated.role, onboarding });
  } catch (error) {
    console.error("Select role error:", error);
    res
      .status(500)
      .json({ message: "Something went wrong while setting role" });
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
    if (!user) return res.status(404).json({ message: "User not found" });

    const tokenEntry = await prisma.passwordResetToken.findUnique({
      where: { userId: user.id },
    });

    const now = new Date();

    if (
      !tokenEntry ||
      tokenEntry.token !== code ||
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
        token: resetToken, // replaces the code
        expiresAt: new Date(Date.now() + 10 * 60 * 1000), // 10 mins
      },
    });

    return res.status(200).json({
      message: "Reset code verified successfully",
      resetToken,
    });
  } catch (error) {
    console.error("Verify code error:", error);
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
    };

    const user = await findUserById(decoded.id);
    if (!user) return res.status(404).json({ message: "User not found" });

    // 🔥 Check DB entry for reset token
    const tokenEntry = await prisma.passwordResetToken.findUnique({
      where: { userId: user.id },
    });

    if (
      !tokenEntry ||
      tokenEntry.token !== resetToken ||
      tokenEntry.expiresAt < new Date()
    ) {
      return res
        .status(406)
        .json({ message: "Invalid or expired reset token" });
    }

    // Hash new password
    const hashedPassword = await bcrypt.hash(
      newPassword,
      config.bcryptSaltRounds,
    );

    await prisma.user.update({
      where: { id: user.id },
      data: {
        password: hashedPassword,
        authProviders: user.authProviders.includes("GOOGLE")
          ? user.authProviders
          : { push: "LOCAL" },
      },
    });

    // Revoke every existing session and invalidate every outstanding
    // refresh token — previously missing entirely. If the account had
    // been compromised (which resetting a password is often a response
    // to), an attacker's already-active session stayed valid right
    // through the reset, completely defeating the point of it.
    await deleteAllUserSessions(user.id);
    await incrementTokenVersion(user.id);

    // Delete token after use
    await prisma.passwordResetToken.deleteMany({
      where: { userId: user.id },
    });

    res.status(200).json({
      message:
        "Password has been reset successfully. You have been logged out of all devices for security.",
    });
  } catch (error) {
    console.error("Secure reset password error:", error);
    return res.status(407).json({ message: "Invalid or expired reset token" });
  }
};

// this link is to verify email
export const verifyEmail = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const { token } = req.query;
  console.log("Verify email called with token:", token);

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

    console.log("Email verified for user:", user.email);
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
    console.error("Email verification error:", error);
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

    if (!user) {
      res.status(404).json({ message: "User not found" });
      return;
    }

    if (user.isEmailVerified) {
      res.status(400).json({ message: "Email is already verified" });
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

    await sendVerificationEmail(req, user.email, token); // ✅

    res.status(200).json({ message: "Verification email resent successfully" });
  } catch (error) {
    console.error("[resendVerificationEmail]", error);
    res.status(500).json({ message: "Internal server error" });
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
      console.error("[Google Token Verification Failed]", verifyError);
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

    const sessionId = uuidv4();
    const refreshJti = uuidv4();
    const accessToken = generateAccessToken(user.id, user.role, sessionId);
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
    await setRefreshJti(user.id, sessionId, refreshJti);

    res.cookie("refreshToken", refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      maxAge: 7 * 24 * 60 * 60 * 1000,
      path: "/refresh-token",
    });

    return res.status(200).json({
      accessToken,
      refreshToken, // also returned in body for mobile clients, matching login/register
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        avatarUrl: user.avatarUrl,
        isEmailVerified: user.isEmailVerified,
        role: user.role,
        isProfileComplete: !!user.role,
      },
    });
  } catch (err) {
    console.error("[Unhandled Google Login Error]", err);
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
    const currentUser = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
    if (currentUser && currentUser.email !== normalizedEmail) {
      data.email = normalizedEmail;
      data.isEmailVerified = false;
      data.emailVerificationToken = uuidv4();
      data.emailVerificationExpiresAt = new Date(Date.now() + 60 * 60 * 1000);
    }
  }

  // Common fields for all roles
  includeField("name");
  includeField("phoneNumber");
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
      try {
        await sendVerificationEmail(req, updated.email, updated.emailVerificationToken);
      } catch (e) {
        logger.warn({ err: e, userId }, "Failed to send verification email after email change");
      }
    }

    // Delivery-specific updates
    if (userRole === "DELIVERY") {
      const deliveryUpdates: Record<string, any> = {};
      if (rawData.vehicleType)
        deliveryUpdates.vehicleType = rawData.vehicleType;
      if (rawData.licensePlate)
        deliveryUpdates.licensePlate = rawData.licensePlate;
      if (rawData.status) deliveryUpdates.status = rawData.status;

      if (Object.keys(deliveryUpdates).length > 0) {
        await prisma.deliveryPerson.updateMany({
          where: { userId },
          data: deliveryUpdates,
        });
      }
    }

    const onboarding = resolveOnboardingState({
      role: updated.role,
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
    console.error("Create address error:", err);
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
    console.error(err);
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
    console.error("Update address error:", err);
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
    console.error("Delete address error:", err);
    res.status(500).json({ error: "Server error" });
  }
};
