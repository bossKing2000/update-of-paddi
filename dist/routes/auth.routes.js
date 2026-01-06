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
const router = (0, express_1.Router)();
//  POST /register
//  Register a new user (with avatar upload) and save initial data
//  access Public
router.post('/register', rateLimiter_middleware_1.authRateLimiter, multer_1.upload.single('avatarUrl'), auth_validator_1.registerValidator, validateRequest_middleware_1.validateRequest, async (req, res) => { await (0, auth_controller_1.register)(req, res); });
//  POST /login
//  Authenticate user and return access + refresh tokens
//  access Public
// router.post('/login',authRateLimiter,loginValidator,trackUserAction("LOGIN"),validateRequest,async (req: GeoRequest, res: Response) => {await login(req, res);});
router.post('/login', geo_middleware_1.geoMiddleware, rateLimiter_middleware_1.authRateLimiter, auth_validator_1.loginValidator, (0, tracking_middleware_1.trackUserAction)("LOGIN"), validateRequest_middleware_1.validateRequest, async (req, res) => { await (0, auth_controller_1.login)(req, res); });
// router.post('/login',login );
//  POST /logout
//  Logs out user by clearing cookies or invalidating token
//  access Public or Private (based on your logic)
router.post('/logout', async (req, res) => { await (0, auth_controller_1.logout)(req, res); });
//  GET /profile
//  Returns authenticated user's profile
//  access Private
router.get('/profile', auth_middleware_1.authenticate, async (req, res) => { await (0, auth_controller_1.getProfile)(req, res); });
//update profile 
router.patch('/profile', multer_1.upload.single('avatarUrl'), auth_middleware_1.authenticate, auth_validator_1.updateProfileValidator, validateRequest_middleware_1.validateRequest, auth_controller_1.updateProfile);
//  GET /alluser
//  Returns all users (can be restricted to ADMIN later)
//  access Public (should be Private in production)
router.get('/alluser', async (req, res) => { await (0, auth_controller_1.getAllUsers)(req, res); });
//  POST /select-role
//  Allows user to choose a role (CUSTOMER, VENDOR) only once
//  access Private
router.post('/select-role', auth_middleware_1.authenticate, async (req, res) => { await (0, auth_controller_1.selectRole)(req, res); });
//  POST /refresh-token
//  Issues new access token using refresh token
//  access Public
router.post('/refresh-token', async (req, res) => { await (0, auth_controller_1.refreshToken)(req, res); });
//  POST /forgot-password
//  Sends reset code to user's email
//  access Public
router.post('/forgot-password', rateLimiter_middleware_1.authRateLimiter, async (req, res) => { await (0, auth_controller_1.forgotPassword)(req, res); });
//  GET /verify-email
//  Verifies user email via token sent in query param
//  access Public
router.get('/verify-email', auth_controller_1.verifyEmail);
//  POST /resend-verification
//  Resends email verification link if token expired or lost
//  access Public
router.post('/resend-verification', auth_controller_1.resendVerificationEmail);
//  POST /verify-reset-code
//  Verifies email + reset code before allowing password reset
//  access Public
router.post('/verify-reset-code', async (req, res) => { await (0, auth_controller_1.verifyResetCode)(req, res); });
//  POST /secure-reset-password
//  Final step: reset password using token (after code is verified)
//  access Public
router.post('/secure-reset-password', async (req, res) => { await (0, auth_controller_1.secureResetPassword)(req, res); });
// post /google-login
router.post('/google-login', async (req, res) => { await (0, auth_controller_1.googleLogin)(req, res); });
//  --- Optional legacy route ---
//  POST /reset-password
//  Resets user password directly (older method, currently disabled)
//  access Public
// router.post('/reset-password', async (req: Request, res: Response) => {
//   await resetPassword(req, res);
// }); this endpoint is still working but due to forget password have inbuilt resend code 
router.post('/addresses', auth_middleware_1.authenticate, auth_controller_1.createAddress);
router.get('/addresses', auth_middleware_1.authenticate, auth_controller_1.getAllAddresses);
router.patch('/addresses/:id', auth_middleware_1.authenticate, auth_controller_1.updateAddress);
router.delete('/addresses/:id', auth_middleware_1.authenticate, auth_controller_1.deleteAddress);
router.get("/nearby", vendorControllerMapping_1.getNearbyVendors);
exports.default = router;
