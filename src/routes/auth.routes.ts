import { Router, Request, Response } from 'express';
import {register,login,refreshToken, logout,forgotPassword, getProfile,getAllUsers,selectRole,verifyResetCode,secureResetPassword,verifyEmail,resendVerificationEmail, googleLogin, updateProfile, createAddress, getAllAddresses, updateAddress, deleteAddress,} from '../controllers/auth.controller';
import { registerValidator, loginValidator, updateProfileValidator } from '../validators/auth.validator';
import { validateRequest } from '../middlewares/validateRequest.middleware';
import { authRateLimiter } from '../middlewares/rateLimiter.middleware';
import { authenticate } from '../middlewares/auth.middleware';
import { upload } from '../utils/multer';
import { trackUserAction } from '../middlewares/tracking.middleware';
import { geoMiddleware, GeoRequest } from '../middlewares/geo.middleware';
import { getNearbyVendors } from '../controllers/vendorControllerMapping';

const router = Router();

//  POST /register
//  Register a new user (with avatar upload) and save initial data
//  access Public
router.post('/register',authRateLimiter,upload.single('avatarUrl'),registerValidator,validateRequest,async (req: Request, res: Response) => {await register(req, res);});

//  POST /login
//  Authenticate user and return access + refresh tokens
//  access Public
// router.post('/login',authRateLimiter,loginValidator,trackUserAction("LOGIN"),validateRequest,async (req: GeoRequest, res: Response) => {await login(req, res);});
// router.post('/login',geoMiddleware,authRateLimiter,loginValidator,trackUserAction("LOGIN"),validateRequest,async (req: GeoRequest, res: Response) => {await login(req, res);});

router.post('/login',login );

//  POST /logout
//  Logs out user by clearing cookies or invalidating token
//  access Public or Private (based on your logic)
router.post('/logout', async (req: Request, res: Response) => { await logout(req, res);});

//  GET /profile
//  Returns authenticated user's profile
//  access Private
router.get('/profile', authenticate, async (req: Request, res: Response) => { await getProfile(req, res);});

//update profile 
router.patch('/profile', upload.single('avatarUrl'), authenticate, updateProfileValidator, validateRequest, updateProfile);

//  GET /alluser
//  Returns all users (can be restricted to ADMIN later)
//  access Public (should be Private in production)
router.get('/alluser', async (req: Request, res: Response) => { await getAllUsers(req, res);});

//  POST /select-role
//  Allows user to choose a role (CUSTOMER, VENDOR) only once
//  access Private
router.post('/select-role', authenticate, async (req: Request, res: Response) => {await selectRole(req, res);});

//  POST /refresh-token
//  Issues new access token using refresh token
//  access Public
router.post('/refresh-token',async (req: Request, res: Response) => { await refreshToken(req, res);});

//  POST /forgot-password
//  Sends reset code to user's email
//  access Public
router.post('/forgot-password', authRateLimiter, async (req: Request, res: Response) => {await forgotPassword(req, res);});

//  GET /verify-email
//  Verifies user email via token sent in query param
//  access Public
router.get('/verify-email', verifyEmail);

//  POST /resend-verification
//  Resends email verification link if token expired or lost
//  access Public
router.post('/resend-verification', resendVerificationEmail);

//  POST /verify-reset-code
//  Verifies email + reset code before allowing password reset
//  access Public
router.post('/verify-reset-code', async (req: Request, res: Response) => {await verifyResetCode(req, res);});

//  POST /secure-reset-password
//  Final step: reset password using token (after code is verified)
//  access Public
router.post('/secure-reset-password', async (req: Request, res: Response) => {await secureResetPassword(req, res);});

// post /google-login
router.post('/google-login',async (req: Request, res: Response) => {await googleLogin(req, res);});


//  --- Optional legacy route ---
//  POST /reset-password
//  Resets user password directly (older method, currently disabled)
//  access Public
// router.post('/reset-password', async (req: Request, res: Response) => {
//   await resetPassword(req, res);
// }); this endpoint is still working but due to forget password have inbuilt resend code 


router.post('/addresses', authenticate, createAddress);
router.get('/addresses', authenticate, getAllAddresses);
router.patch('/addresses/:id', authenticate, updateAddress);
router.delete('/addresses/:id', authenticate, deleteAddress);

router.get("/nearby", getNearbyVendors);

export default router;
 