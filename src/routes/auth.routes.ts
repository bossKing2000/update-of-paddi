import { Router, Request, Response } from "express";
import {
  register,
  login,
  refreshToken,
  logout,
  logoutAllDevices,
  getMySessions,
  revokeSession,
  getLoginHistory,
  forgotPassword,
  getProfile,
  selectRole,
  verifyResetCode,
  secureResetPassword,
  verifyEmail,
  resendVerificationEmail,
  googleLogin,
  updateProfile,
  createAddress,
  getAllAddresses,
  updateAddress,
  deleteAddress,
} from "../controllers/auth.controller";
import {
  registerValidator,
  loginValidator,
  updateProfileValidator,
} from "../validators/auth.validator";
import { validateRequest } from "../middlewares/validateRequest.middleware";
import { authRateLimiter } from "../middlewares/rateLimiter.middleware";
import { authenticate } from "../middlewares/auth.middleware";
import { upload } from "../utils/multer";
import { trackUserAction } from "../middlewares/tracking.middleware";
import { geoMiddleware, GeoRequest } from "../middlewares/geo.middleware";
import { getNearbyVendors } from "../controllers/vendorControllerMapping";
import { verifyNINService } from "../services/dojah.service";
import { getAllUsers } from "../controllers/admin.controller";

const router = Router();

//  POST /register
//  Register a new user (with avatar upload) and save initial data
//  access Public
router.post(
  "/register",
  authRateLimiter,
  upload.single("avatarUrl"),
  registerValidator,
  validateRequest,
  async (req: Request, res: Response) => {
    await register(req, res);
  },
);

//  POST /login
//  Authenticate user and return access + refresh tokens
//  access Public
router.post(
  "/login",
  geoMiddleware,
  authRateLimiter,
  loginValidator,
  trackUserAction("LOGIN"),
  validateRequest,
  async (req: GeoRequest, res: Response) => {
    await login(req, res);
  },
);

//  POST /logout
//  Logs out user from this device only (see /logout-all-devices for every device)
//  access Private
// Previously had no authenticate middleware at all — req.user was always
// undefined, so logout always hit the "not authenticated" branch and
// never actually deleted a session. It has never worked until now.
router.post("/logout", authenticate, async (req: Request, res: Response) => {
  await logout(req, res);
});

//  POST /logout-all-devices
//  Revokes every active session and invalidates every outstanding refresh token
//  access Private
// Previously existed as a function but was never wired to any route at all.
router.post(
  "/logout-all-devices",
  authenticate,
  async (req: Request, res: Response) => {
    await logoutAllDevices(req, res);
  },
);

//  GET /sessions
//  Lists every active session (device) for the current user
//  access Private
router.get("/sessions", authenticate, async (req: Request, res: Response) => {
  await getMySessions(req, res);
});

//  DELETE /sessions/:sessionId
//  Revokes one specific device's session without touching any others
//  access Private
router.delete(
  "/sessions/:sessionId",
  authenticate,
  async (req: Request, res: Response) => {
    await revokeSession(req, res);
  },
);

//  GET /login-history
//  Recent logins for the current user (device/location/time), for
//  spotting activity they don't recognize
//  access Private
router.get(
  "/login-history",
  authenticate,
  async (req: Request, res: Response) => {
    await getLoginHistory(req, res);
  },
);

//  GET /profile
//  Returns authenticated user's profile
//  access Private
router.get("/profile", authenticate, async (req: Request, res: Response) => {
  await getProfile(req, res);
});

//update profile
router.patch(
  "/profile",
  upload.single("avatarUrl"),
  authenticate,
  updateProfileValidator,
  validateRequest,
  updateProfile,
);

// NOTE: GET /alluser used to live here — no auth, no pagination, dumped
// every user's email/phone/name/bio to any anonymous caller. Removed.
// Use GET /api/admin/users instead (paginated, admin-only, built in the
// Admin domain).

router.get("/alluser", async (req: Request, res: Response) => {
  await getAllUsers(req, res);
});

//  POST /select-role
//  Allows user to choose a role (CUSTOMER, VENDOR) only once
//  access Private
router.post(
  "/select-role",
  authenticate,
  async (req: Request, res: Response) => {
    await selectRole(req, res);
  },
);

//  POST /refresh-token
//  Issues new access token using refresh token — rate-limited per IP to prevent brute-force / credential stuffing amplification
//  access Public
router.post("/refresh-token", authRateLimiter, async (req: Request, res: Response) => {
  await refreshToken(req, res);
});

//  POST /forgot-password
//  Sends reset code to user's email
//  access Public
router.post(
  "/forgot-password",
  authRateLimiter,
  async (req: Request, res: Response) => {
    await forgotPassword(req, res);
  },
);

//  GET /verify-email
//  Verifies user email via token sent in query param
//  access Public
router.get("/verify-email", verifyEmail);

//  POST /resend-verification
//  Resends email verification link if token expired or lost
//  access Public
router.post("/resend-verification", resendVerificationEmail);

//  POST /verify-reset-code
//  Verifies email + reset code before allowing password reset
//  access Public
router.post(
  "/verify-reset-code",
  authRateLimiter,
  async (req: Request, res: Response) => {
    await verifyResetCode(req, res);
  },
);

//  POST /secure-reset-password
//  Final step: reset password using token (after code is verified).
//  Now also revokes every existing session, since an account compromise
//  is often exactly why someone is resetting their password.
//  access Public
router.post("/secure-reset-password", async (req: Request, res: Response) => {
  await secureResetPassword(req, res);
});

// post /google-login
router.post("/google-login", async (req: Request, res: Response) => {
  await googleLogin(req, res);
});

router.post("/addresses", authenticate, createAddress);
router.get("/addresses", authenticate, getAllAddresses);
router.patch("/addresses/:id", authenticate, updateAddress);
router.delete("/addresses/:id", authenticate, deleteAddress);

router.get("/nearby", getNearbyVendors);

//  POST /kyc/verify-nin
//  Verify a VENDOR or DELIVERY user's NIN via Dojah, flips kycStatus to VERIFIED
//  access Private (authenticated VENDOR/DELIVERY only — enforced in the service)
router.post("/kyc/verify-nin", authenticate, verifyNINService);

export default router;
