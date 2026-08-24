"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const auth_controller_1 = require("../controllers/auth.controller");
const auth_validator_1 = require("../validators/auth.validator");
const validateRequest_middleware_1 = require("../middlewares/validateRequest.middleware");
const rateLimiter_middleware_1 = require("../middlewares/rateLimiter.middleware");
const auth_middleware_1 = require("../middlewares/auth.middleware");
const multer_1 = require("../utils/multer");
const tracking_middleware_1 = require("../middlewares/tracking.middleware");
const geo_middleware_1 = require("../middlewares/geo.middleware");
const vendorControllerMapping_1 = require("../controllers/vendorControllerMapping");
const dojah_service_1 = require("../services/dojah.service");
const admin_controller_1 = require("../controllers/admin.controller");
const router = (0, express_1.Router)();
//  POST /register
//  Register a new user (with avatar upload) and save initial data
//  access Public
router.post("/register", rateLimiter_middleware_1.authRateLimiter, multer_1.upload.single("avatarUrl"), auth_validator_1.registerValidator, validateRequest_middleware_1.validateRequest, async (req, res) => {
    await (0, auth_controller_1.register)(req, res);
});
//  POST /login
//  Authenticate user and return access + refresh tokens
//  access Public
router.post("/login", geo_middleware_1.geoMiddleware, rateLimiter_middleware_1.authRateLimiter, auth_validator_1.loginValidator, (0, tracking_middleware_1.trackUserAction)("LOGIN"), validateRequest_middleware_1.validateRequest, async (req, res) => {
    await (0, auth_controller_1.login)(req, res);
});
//  POST /logout
//  Logs out user from this device only (see /logout-all-devices for every device)
//  access Private
// Previously had no authenticate middleware at all — req.user was always
// undefined, so logout always hit the "not authenticated" branch and
// never actually deleted a session. It has never worked until now.
router.post("/logout", auth_middleware_1.authenticate, async (req, res) => {
    await (0, auth_controller_1.logout)(req, res);
});
//  POST /logout-all-devices
//  Revokes every active session and invalidates every outstanding refresh token
//  access Private
// Previously existed as a function but was never wired to any route at all.
router.post("/logout-all-devices", auth_middleware_1.authenticate, async (req, res) => {
    await (0, auth_controller_1.logoutAllDevices)(req, res);
});
//  GET /sessions
//  Lists every active session (device) for the current user
//  access Private
router.get("/sessions", auth_middleware_1.authenticate, async (req, res) => {
    await (0, auth_controller_1.getMySessions)(req, res);
});
//  DELETE /sessions/:sessionId
//  Revokes one specific device's session without touching any others
//  access Private
router.delete("/sessions/:sessionId", auth_middleware_1.authenticate, async (req, res) => {
    await (0, auth_controller_1.revokeSession)(req, res);
});
//  GET /login-history
//  Recent logins for the current user (device/location/time), for
//  spotting activity they don't recognize
//  access Private
router.get("/login-history", auth_middleware_1.authenticate, async (req, res) => {
    await (0, auth_controller_1.getLoginHistory)(req, res);
});
//  GET /profile
//  Returns authenticated user's profile
//  access Private
router.get("/profile", auth_middleware_1.authenticate, async (req, res) => {
    await (0, auth_controller_1.getProfile)(req, res);
});
//update profile
router.patch("/profile", multer_1.upload.single("avatarUrl"), auth_middleware_1.authenticate, auth_validator_1.updateProfileValidator, validateRequest_middleware_1.validateRequest, auth_controller_1.updateProfile);
// NOTE: GET /alluser used to live here — no auth, no pagination, dumped
// every user's email/phone/name/bio to any anonymous caller. Removed.
// Use GET /api/admin/users instead (paginated, admin-only, built in the
// Admin domain).
router.get("/alluser", async (req, res) => {
    await (0, admin_controller_1.getAllUsers)(req, res);
});
//  POST /select-role
//  Allows user to choose a role (CUSTOMER, VENDOR) only once
//  access Private
router.post("/select-role", auth_middleware_1.authenticate, async (req, res) => {
    await (0, auth_controller_1.selectRole)(req, res);
});
//  POST /refresh-token
//  Issues new access token using refresh token
//  access Public
router.post("/refresh-token", async (req, res) => {
    await (0, auth_controller_1.refreshToken)(req, res);
});
//  POST /forgot-password
//  Sends reset code to user's email
//  access Public
router.post("/forgot-password", rateLimiter_middleware_1.authRateLimiter, async (req, res) => {
    await (0, auth_controller_1.forgotPassword)(req, res);
});
//  GET /verify-email
//  Verifies user email via token sent in query param
//  access Public
router.get("/verify-email", auth_controller_1.verifyEmail);
//  POST /resend-verification
//  Resends email verification link if token expired or lost
//  access Public
router.post("/resend-verification", auth_controller_1.resendVerificationEmail);
//  POST /verify-reset-code
//  Verifies email + reset code before allowing password reset
//  access Public
router.post("/verify-reset-code", rateLimiter_middleware_1.authRateLimiter, async (req, res) => {
    await (0, auth_controller_1.verifyResetCode)(req, res);
});
//  POST /secure-reset-password
//  Final step: reset password using token (after code is verified).
//  Now also revokes every existing session, since an account compromise
//  is often exactly why someone is resetting their password.
//  access Public
router.post("/secure-reset-password", async (req, res) => {
    await (0, auth_controller_1.secureResetPassword)(req, res);
});
// post /google-login
router.post("/google-login", async (req, res) => {
    await (0, auth_controller_1.googleLogin)(req, res);
});
router.post("/addresses", auth_middleware_1.authenticate, auth_controller_1.createAddress);
router.get("/addresses", auth_middleware_1.authenticate, auth_controller_1.getAllAddresses);
router.patch("/addresses/:id", auth_middleware_1.authenticate, auth_controller_1.updateAddress);
router.delete("/addresses/:id", auth_middleware_1.authenticate, auth_controller_1.deleteAddress);
router.get("/nearby", vendorControllerMapping_1.getNearbyVendors);
//  POST /kyc/verify-nin
//  Verify a VENDOR or DELIVERY user's NIN via Dojah, flips kycStatus to VERIFIED
//  access Private (authenticated VENDOR/DELIVERY only — enforced in the service)
router.post("/kyc/verify-nin", auth_middleware_1.authenticate, dojah_service_1.verifyNINService);
exports.default = router;
