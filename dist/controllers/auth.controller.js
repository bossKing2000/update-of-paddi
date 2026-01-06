"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.deleteAddress = exports.updateAddress = exports.getAllAddresses = exports.createAddress = exports.updateProfile = exports.googleLogin = exports.resendVerificationEmail = exports.verifyEmail = exports.secureResetPassword = exports.verifyResetCode = exports.selectRole = exports.getAllUsers = exports.getProfile = exports.forgotPassword = exports.logoutAllDevices = exports.logout = exports.refreshToken = exports.login = exports.register = void 0;
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const prisma_1 = __importDefault(require("../lib/prisma"));
const zod_1 = require("zod");
const config_1 = __importDefault(require("../config/config"));
const generateToken_1 = require("../utils/generateToken");
const buildResponse_1 = require("../utils/buildResponse");
const client_1 = require("@prisma/client");
const uuid_1 = require("uuid");
const crypto_1 = __importDefault(require("crypto"));
const dayjs_1 = __importDefault(require("dayjs"));
const sendVerificatioEmail_1 = require("../services/mail/sendVerificatioEmail");
const google_auth_library_1 = require("google-auth-library");
const authSchema_1 = require("../validations/authSchema");
const generateResetToken_1 = require("../utils/generateResetToken");
const session_1 = require("../lib/session");
const schema = zod_1.z.object({ email: zod_1.z.string().email() });
const googleClient = new google_auth_library_1.OAuth2Client();
const findUserByEmail = (email) => prisma_1.default.user.findUnique({ where: { email } });
const findUserById = (id) => prisma_1.default.user.findUnique({ where: { id } });
const comparePasswords = (plain, hashed) => bcryptjs_1.default.compare(plain, hashed);
const incrementTokenVersion = (userId) => prisma_1.default.user.update({ where: { id: userId }, data: { tokenVersion: { increment: 1 } } });
function handlePrismaError(error, res) {
    if (error instanceof client_1.Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const target = error.meta?.target?.[0] ?? 'Field';
        return res.status(409).json({ message: `${target} already exists` });
    }
    console.error(error);
    return res.status(500).json({ message: 'Something went wrong' });
}
const register = async (req, res) => {
    const parsed = authSchema_1.registerSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(422).json({ errors: parsed.error.flatten().fieldErrors });
    const { username, name, email, password, role, phoneNumber, brandName } = parsed.data;
    try {
        const existingUser = await findUserByEmail(email);
        if (existingUser)
            return res.status(400).json({ message: 'User already exists' });
        const avatarUrl = req.file ? `/uploads/${req.file.filename}` : undefined;
        const hashed = await bcryptjs_1.default.hash(password, 10);
        const verificationToken = (0, uuid_1.v4)();
        const emailExpires = new Date(Date.now() + 60 * 60 * 1000);
        const data = {
            name, // required
            email,
            password: hashed,
            emailVerificationToken: verificationToken,
            emailVerificationExpiresAt: emailExpires,
        };
        if (username)
            data.username = username;
        if (role)
            data.role = client_1.Role[role];
        if (phoneNumber)
            data.phoneNumber = phoneNumber;
        if (avatarUrl)
            data.avatarUrl = avatarUrl;
        if (brandName)
            data.brandName = brandName;
        const user = await prisma_1.default.user.create({ data });
        // ✅ If role is DELIVERY, auto-create linked DeliveryPerson record
        if (role && role.toUpperCase() === "DELIVERY") {
            await prisma_1.default.deliveryPerson.create({
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
        const accessToken = (0, generateToken_1.generateAccessToken)(user.id, user.role);
        const refreshToken = (0, generateToken_1.generateRefreshToken)(user.id, user.tokenVersion);
        res.cookie('refreshToken', refreshToken, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'strict',
            maxAge: 7 * 24 * 60 * 60 * 1000,
            path: '/refresh-token',
        });
        res.status(201).json({ message: 'User registered successfully', pendingRole: !user.role, ...(0, buildResponse_1.buildAuthResponse)(user, accessToken) });
    }
    catch (error) {
        return handlePrismaError(error, res);
    }
};
exports.register = register;
// export const login = async (req: Request, res: Response) => {
//   const parsed = loginSchema.safeParse(req.body);
//   if (!parsed.success) return res.status(422).json({ errors: parsed.error.flatten().fieldErrors });
//   const { email, password } = parsed.data;
//   try {
//     const user = await findUserByEmail(email);
//     if (!user || !user.password || !(await comparePasswords(password, user.password))) {
//       return res.status(401).json({ message: 'Invalid credentials' });
//     }
//     if (!user.isEmailVerified) return res.status(403).json({ message: 'Please verify your email before logging in.' });
//     const updates: any = {
//       lastLoginAt: new Date(),
//       loginMethod: 'LOCAL',
//       loginHistory: {
//         create: {
//           method: 'LOCAL',
//           ip: req.ip || '',
//           userAgent: req.headers['user-agent'] || '',
//         },
//       },
//     };
//     if (!user.authProviders.includes('LOCAL')) {
//       updates.authProviders = { push: 'LOCAL' };
//     }
//   // inside login controller
// const updatedUser = await prisma.user.update({
//   where: { id: user.id },
//   data: {
//     lastLoginAt: new Date(),
//     loginMethod: 'LOCAL',
//     authProviders: user.authProviders.includes('LOCAL') ? undefined : { push: 'LOCAL' }
//   }
// });
//     const accessToken = generateAccessToken(user.id, user.role);
//     const refreshToken = generateRefreshToken(user.id, user.tokenVersion);
//     res.cookie('refreshToken', refreshToken, {
//       httpOnly: true,
//       secure: process.env.NODE_ENV === 'production',
//       sameSite: 'strict',
//       maxAge: 7 * 24 * 60 * 60 * 1000,
//       path: '/refresh-token',
//     });
//     res.status(200).json({
//       message: 'Login successful',
//       pendingRole: !user.role,
//       ...buildAuthResponse(user, accessToken),
//     });
//   } catch (error) {
//     console.error('Login error:', error);
//     res.status(500).json({ message: 'Something went wrong during login' });
//   }
// };
// Refresh Token
const login = async (req, res) => {
    const parsed = authSchema_1.loginSchema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(422).json({ errors: parsed.error.flatten().fieldErrors });
    }
    const { email, password } = parsed.data;
    try {
        const user = await findUserByEmail(email);
        if (!user || !user.password || !(await comparePasswords(password, user.password))) {
            return res.status(401).json({ message: 'Invalid credentials' });
        }
        if (!user.isEmailVerified) {
            return res.status(403).json({ message: 'Please verify your email before logging in.' });
        }
        // Use client info if provided by geoMiddleware
        const clientInfo = req.clientInfo || {};
        const ip = clientInfo.ip || req.ip || "unknown";
        const userAgent = clientInfo.userAgent || req.headers['user-agent'] || "unknown";
        const deviceId = clientInfo.deviceId || null;
        const city = clientInfo.city || "unknown";
        const region = clientInfo.region || "unknown";
        const country = clientInfo.country || "unknown";
        // Update last login and create loginHistory
        const updatedUser = await prisma_1.default.user.update({
            where: { id: user.id },
            data: {
                lastLoginAt: new Date(),
                loginMethod: 'LOCAL',
                authProviders: user.authProviders.includes('LOCAL') ? undefined : { push: 'LOCAL' },
                loginHistory: {
                    create: {
                        method: 'LOCAL',
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
        // Generate tokens
        const accessToken = (0, generateToken_1.generateAccessToken)(user.id, user.role);
        const refreshToken = (0, generateToken_1.generateRefreshToken)(user.id, user.tokenVersion);
        // Store session in Redis
        await (0, session_1.setUserSession)(user.id, {
            accessToken,
            refreshToken,
            lastLoginAt: new Date(),
            ip,
            userAgent,
            deviceId,
            geoCity: city,
            geoRegion: region,
            geoCountry: country,
        });
        res.cookie('refreshToken', refreshToken, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'strict',
            maxAge: 7 * 24 * 60 * 60 * 1000,
            path: '/refresh-token',
        });
        // If request is from mobile, also send refreshToken in JSON
        const isMobile = req.headers["x-client-type"] === "mobile";
        res.status(200).json({
            message: 'Login successful',
            pendingRole: !user.role,
            ...(0, buildResponse_1.buildAuthResponse)(user, accessToken),
            ...(isMobile ? { refreshToken } : {}),
        });
    }
    catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ message: 'Something went wrong during login' });
    }
};
exports.login = login;
// export const refreshToken = async (req: Request, res: Response) => {
//   const token = req.cookies.refreshToken;
//   if (!token) return res.status(401).json({ message: 'No refresh token provided' });
//   try {
//     const decoded = jwt.verify(token, config.jwtSecret) as { id: string; tokenVersion: number };
//     const user = await findUserById(decoded.id);
//     if (!user || user.tokenVersion !== decoded.tokenVersion) {
//       return res.status(401).json({ message: 'Invalid refresh token' });
//     }
//     const newAccessToken = generateAccessToken(user.id, user.role);
//     const newRefreshToken = generateRefreshToken(user.id, user.tokenVersion);
//     res.cookie('refreshToken', newRefreshToken, {
//       httpOnly: true,
//       secure: process.env.NODE_ENV === 'production',
//       sameSite: 'strict',
//       maxAge: 7 * 24 * 60 * 60 * 1000,
//       path: '/refresh-token',
//     });
//     res.status(200).json({ accessToken: newAccessToken });
//   } catch (error) {
//     console.error('Refresh token error:', error);
//     res.status(401).json({ message: 'Invalid or expired refresh token' });
//   }
// };
// old refresh token
// ✅ Handles refresh tokens from both cookie (web) and body (mobile)
const refreshToken = async (req, res) => {
    // Get refresh token from either cookie or request body
    const token = req.cookies.refreshToken || req.body.refreshToken;
    if (!token) {
        return res.status(401).json({ message: 'No refresh token provided' });
    }
    try {
        // Verify and decode refresh token
        const decoded = jsonwebtoken_1.default.verify(token, config_1.default.jwtSecret);
        // Find user in DB
        const user = await findUserById(decoded.id);
        if (!user || user.tokenVersion !== decoded.tokenVersion) {
            return res.status(401).json({ message: 'Invalid refresh token' });
        }
        // Generate new tokens
        const newAccessToken = (0, generateToken_1.generateAccessToken)(user.id, user.role);
        const newRefreshToken = (0, generateToken_1.generateRefreshToken)(user.id, user.tokenVersion);
        // Send refresh token as cookie (for web clients)
        res.cookie('refreshToken', newRefreshToken, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'strict',
            maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
            path: '/refresh-token',
        });
        // Also return refresh token in body for mobile apps
        return res.status(200).json({
            accessToken: newAccessToken,
            refreshToken: newRefreshToken, // mobile clients will use this
        });
    }
    catch (error) {
        console.error('Refresh token error:', error);
        return res.status(401).json({ message: 'Invalid or expired refresh token' });
    }
};
exports.refreshToken = refreshToken;
// Logout
const logout = async (req, res) => {
    try {
        const userId = req.user?.id;
        if (!userId)
            return res.status(401).json({ message: 'Not authenticated' });
        await incrementTokenVersion(userId);
        // 🧹 Delete user session from Redis
        await (0, session_1.deleteUserSession)(userId);
        res.clearCookie('refreshToken', {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'strict',
            path: '/refresh-token',
        });
        res.status(200).json({ message: 'Logged out successfully' });
    }
    catch (error) {
        console.error('Logout error:', error);
        res.status(500).json({ message: 'Something went wrong during logout' });
    }
};
exports.logout = logout;
// logout-all.ts
const logoutAllDevices = async (req, res) => {
    await (0, session_1.deleteUserSession)(req.user.id); // Clear all sessions from Redis
    await incrementTokenVersion(req.user.id);
    res.json({ message: "Logged out from all devices" });
};
exports.logoutAllDevices = logoutAllDevices;
// Forgot Password
const forgotPassword = async (req, res) => {
    const { email } = req.body;
    if (!email)
        return res.status(422).json({ message: 'Email is required' });
    try {
        const user = await findUserByEmail(email);
        if (!user)
            return res.status(404).json({ message: 'User not found' });
        const resetToken = (0, generateResetToken_1.generateResetToken)(6); // generates a 6-character alphanumeric token
        const expiresInMinutes = 10;
        await prisma_1.default.passwordResetToken.upsert({
            where: { userId: user.id },
            update: {
                token: resetToken,
                expiresAt: new Date(Date.now() + expiresInMinutes * 60 * 1000)
            },
            create: {
                userId: user.id,
                token: resetToken,
                expiresAt: new Date(Date.now() + expiresInMinutes * 60 * 1000),
            },
        });
        // await sendResetEmail(req, email, resetToken);
        // 👇 For testing only — logs the reset code to console
        if (process.env.NODE_ENV !== 'production') {
            console.log(`🧪 Reset code for ${email}: ${resetToken}`);
        }
        res.status(200).json({ message: 'Reset code sent to your email' });
    }
    catch (error) {
        console.error('Forgot password error:', error);
        res.status(500).json({ message: 'Something went wrong during password reset request' });
    }
};
exports.forgotPassword = forgotPassword;
// Reset Password
// for this part it can reset password but i won't have to pass through verifcation it will just use the reset token gotten from the forgot password email
// so i lock it because of the mobile app that have a verification page in the ui so we will use verify endpoint
// so the code is working fine just not using it for 
// export const resetPassword = async (req: Request, res: Response) => {
//   const parsed = resetSchema.safeParse(req.body);
//   if (!parsed.success) {
//     return res.status(422).json({ errors: parsed.error.flatten().fieldErrors });
//   }
//   const { email, code, newPassword } = parsed.data;
//   try {
//     const user = await findUserByEmail(email);
//     if (!user) return res.status(404).json({ message: 'User not found' });
//     const tokenEntry = await prisma.passwordResetToken.findUnique({
//       where: { userId: user.id },
//     });
//     if (!tokenEntry || tokenEntry.token !== code || tokenEntry.expiresAt < new Date()) {
//       return res.status(400).json({ message: 'Invalid or expired code' });
//     }
//     const hashedPassword = await bcrypt.hash(newPassword, 10);
//     await prisma.user.update({ where: { id: user.id }, data: { password: hashedPassword } });
//     await prisma.passwordResetToken.delete({ where: { userId: user.id } });
//     res.status(200).json({ message: 'Password reset successful' });
//   } catch (error) {
//     console.error('Reset password error:', error);
//     res.status(500).json({ message: 'Something went wrong during password reset' });
//   }
// };
// Get Profile
const getProfile = async (req, res) => {
    try {
        const userId = req.user?.id;
        const userRole = req.user?.role;
        if (!userId) {
            return res.status(400).json({ message: "User ID not found in token" });
        }
        // Fetch base user info
        const user = await prisma_1.default.user.findUnique({
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
        const response = { ...user, pendingRole: !user.role };
        // Flatten delivery details for DELIVERY role
        if (userRole === "DELIVERY" && user.deliveryPerson) {
            response.deliveryProfile = user.deliveryPerson;
        }
        res.status(200).json({ user: response });
    }
    catch (error) {
        console.error("Get profile error:", error);
        res.status(500).json({ message: "Failed to load user profile" });
    }
};
exports.getProfile = getProfile;
// Get All Users
const getAllUsers = async (_req, res) => {
    try {
        const users = await prisma_1.default.user.findMany({
            select: {
                id: true,
                username: true,
                name: true,
                email: true,
                role: true,
                preferences: true,
                avatarUrl: true,
                bio: true,
                phoneNumber: true,
                createdAt: true,
            },
        });
        res.status(200).json(users);
    }
    catch (error) {
        console.error('Get all users error:', error);
        res.status(500).json({ message: 'Failed to fetch users' });
    }
};
exports.getAllUsers = getAllUsers;
const selectRole = async (req, res) => {
    const { role } = req.body;
    const userId = req.user?.id;
    if (!userId)
        return res.status(401).json({ message: 'Not authenticated' });
    // Narrow the type of role
    if (role !== 'CUSTOMER' && role !== 'VENDOR' && role !== 'DELIVERY') {
        return res.status(400).json({ message: 'Invalid role' });
    }
    try {
        const user = await prisma_1.default.user.findUnique({ where: { id: userId } });
        if (!user)
            return res.status(404).json({ message: 'User not found' });
        if (user.role)
            return res.status(400).json({ message: 'Role already selected' });
        const updated = await prisma_1.default.user.update({
            where: { id: userId },
            data: { role: client_1.Role[role] }, // ✅ Safe and typed
        });
        res.status(200).json({ message: 'Role updated', role: updated.role });
    }
    catch (error) {
        console.error('Select role error:', error);
        res.status(500).json({ message: 'Something went wrong while setting role' });
    }
};
exports.selectRole = selectRole;
// to verify the token to reset new password
// export const verifyResetCode = async (req: Request, res: Response) => {
//   const { email, code } = req.body;
//   if (!email || !code) {
//     return res.status(422).json({ message: 'Email and code are required' });
//   }
//   try {
//     const user = await findUserByEmail(email);
//     if (!user) return res.status(404).json({ message: 'User not found' });
//     const tokenEntry = await prisma.passwordResetToken.findUnique({
//       where: { userId: user.id },
//     });
//     if (!tokenEntry || tokenEntry.token !== code || tokenEntry.expiresAt < new Date()) {
//       return res.status(406).json({ message: 'Invalid or expired reset code' });
//     }
//     // Issue short-lived JWT
//     const resetToken = jwt.sign(
//       { id: user.id },
//       config.jwtResetSecret, // 👈 Add this to config (a different secret from access/refresh)
//       { expiresIn: '10m' } // valid for 10 minutes
//     );
//     return res.status(200).json({ resetToken });
//   } catch (error) {
//     console.error('Verify code error:', error);
//     return res.status(500).json({ message: 'Failed to verify reset code' });
//   }
// };
// Verify the reset code and issue a short-lived JWT
const verifyResetCode = async (req, res) => {
    const { email, code } = req.body;
    if (!email || !code) {
        return res.status(422).json({ message: 'Email and code are required' });
    }
    try {
        const user = await findUserByEmail(email);
        if (!user)
            return res.status(404).json({ message: 'User not found' });
        const tokenEntry = await prisma_1.default.passwordResetToken.findUnique({
            where: { userId: user.id },
        });
        const now = new Date();
        if (!tokenEntry || tokenEntry.token !== code || tokenEntry.expiresAt < now) {
            return res.status(406).json({ message: 'Invalid or expired reset code' });
        }
        // Create short-lived reset token
        const resetToken = jsonwebtoken_1.default.sign({ id: user.id }, config_1.default.jwtResetSecret, { expiresIn: '10m' });
        // Save the resetToken itself in DB
        await prisma_1.default.passwordResetToken.update({
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
    }
    catch (error) {
        console.error('Verify code error:', error);
        return res.status(500).json({ message: 'Failed to verify reset code' });
    }
};
exports.verifyResetCode = verifyResetCode;
// Secure Reset Password so this will change the password or user will be able to create new password
// export const secureResetPassword = async (req: Request, res: Response) => {
//   const parsed = secureResetSchema.safeParse(req.body);
//   if (!parsed.success) {
//     return res.status(422).json({ errors: parsed.error.flatten().fieldErrors });
//   }
//   const { resetToken, newPassword } = parsed.data;
//   try {
//     const decoded = jwt.verify(resetToken, config.jwtResetSecret) as { id: string };
//     const user = await findUserById(decoded.id);
//     if (!user) return res.status(404).json({ message: 'User not found' });
//     const hashedPassword = await bcrypt.hash(newPassword, 10);
//     await prisma.user.update({
//       where: { id: user.id },
//       data: { 
//         password: hashedPassword ,
//         authProviders: user.authProviders.includes('GOOGLE') ? user.authProviders: { push: 'LOCAL' }
//       },
//     });
//     // Clean up the used/expired reset token(s)
//     await prisma.passwordResetToken.deleteMany({
//       where: { userId: user.id },
//     });
//     res.status(200).json({ message: 'Password has been reset successfully' });
//   } catch (error) {
//     console.error('Secure reset password error:', error);
//     return res.status(407).json({ message: 'Invalid or expired reset token' });
//   }
// };
const secureResetPassword = async (req, res) => {
    const parsed = authSchema_1.secureResetSchema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(422).json({ errors: parsed.error.flatten().fieldErrors });
    }
    const { resetToken, newPassword } = parsed.data;
    try {
        const decoded = jsonwebtoken_1.default.verify(resetToken, config_1.default.jwtResetSecret);
        const user = await findUserById(decoded.id);
        if (!user)
            return res.status(404).json({ message: 'User not found' });
        // 🔥 Check DB entry for reset token
        const tokenEntry = await prisma_1.default.passwordResetToken.findUnique({
            where: { userId: user.id },
        });
        if (!tokenEntry || tokenEntry.token !== resetToken || tokenEntry.expiresAt < new Date()) {
            return res.status(406).json({ message: 'Invalid or expired reset token' });
        }
        // Hash new password
        const hashedPassword = await bcryptjs_1.default.hash(newPassword, 10);
        await prisma_1.default.user.update({
            where: { id: user.id },
            data: {
                password: hashedPassword,
                authProviders: user.authProviders.includes('GOOGLE')
                    ? user.authProviders
                    : { push: 'LOCAL' }
            },
        });
        // Delete token after use
        await prisma_1.default.passwordResetToken.deleteMany({
            where: { userId: user.id },
        });
        res.status(200).json({ message: 'Password has been reset successfully' });
    }
    catch (error) {
        console.error('Secure reset password error:', error);
        return res.status(407).json({ message: 'Invalid or expired reset token' });
    }
};
exports.secureResetPassword = secureResetPassword;
// this link is to verify email
const verifyEmail = async (req, res) => {
    const { token } = req.query;
    console.log('Verify email called with token:', token);
    if (!token || typeof token !== 'string') {
        console.log('Invalid token format');
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
        const user = await prisma_1.default.user.findFirst({
            where: {
                emailVerificationToken: token,
                emailVerificationExpiresAt: { gt: new Date() },
            },
        });
        if (!user) {
            console.log('No user found with this token');
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
        await prisma_1.default.user.update({
            where: { id: user.id },
            data: {
                isEmailVerified: true,
                emailVerificationToken: null,
                emailVerificationExpiresAt: null,
            },
        });
        console.log('Email verified for user:', user.email);
        res.status(200).send(`
      <html>
        <head><title>Email Verified</title></head>
        <body style="font-family: sans-serif; text-align: center; padding: 3rem;">
          <h2 style="color: green;">✅ Email verified successfully!</h2>
          <p>You can now close this tab and return to the app.</p>
        </body>
      </html>
    `);
    }
    catch (error) {
        console.error('Email verification error:', error);
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
exports.verifyEmail = verifyEmail;
// this will resend the verification link to the user's email if it's invalid or expired
const resendVerificationEmail = async (req, res) => {
    try {
        const result = schema.safeParse(req.body);
        if (!result.success) {
            res.status(400).json({ message: 'Invalid email address' });
            return;
        }
        const { email } = result.data;
        const user = await prisma_1.default.user.findUnique({ where: { email } });
        if (!user) {
            res.status(404).json({ message: 'User not found' });
            return;
        }
        if (user.isEmailVerified) {
            res.status(400).json({ message: 'Email is already verified' });
            return;
        }
        const token = crypto_1.default.randomUUID();
        const expiresAt = (0, dayjs_1.default)().add(30, 'second').toDate();
        await prisma_1.default.user.update({
            where: { email },
            data: {
                emailVerificationToken: token,
                emailVerificationExpiresAt: expiresAt
            }
        });
        await (0, sendVerificatioEmail_1.sendVerificationEmail)(req, user.email, token); // ✅
        res.status(200).json({ message: 'Verification email resent successfully' });
    }
    catch (error) {
        console.error('[resendVerificationEmail]', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};
exports.resendVerificationEmail = resendVerificationEmail;
const googleLogin = async (req, res) => {
    try {
        const { idToken } = req.body;
        if (!idToken) {
            return res.status(400).json({ message: 'Google ID token is missing.' });
        }
        let ticket;
        try {
            ticket = await googleClient.verifyIdToken({
                idToken,
                audience: process.env.GOOGLE_CLIENT_ID,
            });
        }
        catch (verifyError) {
            console.error('[Google Token Verification Failed]', verifyError);
            return res.status(401).json({ message: 'Invalid or expired Google token. Please sign in again.' });
        }
        const payload = ticket.getPayload();
        if (!payload || !payload.email) {
            return res.status(400).json({ message: 'Unable to extract user information from Google token.' });
        }
        const { email, name, picture, sub: googleId } = payload;
        let user = await prisma_1.default.user.findUnique({ where: { email } });
        if (user) {
            if (!user.googleId) {
                // Attach Google to existing user
                user = await prisma_1.default.user.update({
                    where: { email },
                    data: {
                        googleId,
                        isEmailVerified: true,
                        authProviders: { push: 'GOOGLE' },
                    },
                });
            }
            else if (user.googleId !== googleId) {
                return res.status(409).json({
                    message: 'This email is already linked to a different Google account. Please use the correct account or login with email/password.',
                });
            }
        }
        else {
            const username = `user_${crypto_1.default.randomUUID().slice(0, 8)}`;
            user = await prisma_1.default.user.create({
                data: {
                    email,
                    username,
                    name: name || '',
                    password: null,
                    avatarUrl: picture || null,
                    isEmailVerified: true,
                    googleId,
                    authProviders: ['GOOGLE'],
                    loginMethod: 'GOOGLE',
                    lastLoginAt: new Date(),
                    loginHistory: {
                        create: [
                            {
                                method: 'GOOGLE',
                                ip: req.ip || '',
                                userAgent: req.headers['user-agent'] || '',
                            },
                        ],
                    },
                },
            });
        }
        const updates = {
            lastLoginAt: new Date(),
            loginMethod: 'GOOGLE',
            loginHistory: {
                create: {
                    method: 'GOOGLE',
                    ip: req.ip || '',
                    userAgent: req.headers['user-agent'] || '',
                },
            },
        };
        if (!user.authProviders.includes('GOOGLE')) {
            updates.authProviders = { push: 'GOOGLE' };
        }
        user = await prisma_1.default.user.update({
            where: { id: user.id },
            data: updates,
        });
        const accessToken = (0, generateToken_1.generateAccessToken)(user.id, user.role);
        return res.status(200).json({
            accessToken,
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
    }
    catch (err) {
        console.error('[Unhandled Google Login Error]', err);
        return res.status(500).json({
            message: 'Something went wrong while logging in with Google. Please try again later.',
        });
    }
};
exports.googleLogin = googleLogin;
const updateProfile = async (req, res) => {
    const userId = req.user?.id;
    const userRole = req.user?.role;
    if (!userId) {
        res.status(401).json({ message: 'Unauthorized' });
        return;
    }
    const parsed = authSchema_1.updateUserSchema.safeParse(req.body);
    if (!parsed.success) {
        res.status(422).json({ errors: parsed.error.flatten().fieldErrors });
        return;
    }
    const rawData = parsed.data;
    const data = {};
    // Helper to include fields only if explicitly set and optionally for specific roles
    const includeField = (key, roles) => {
        if (Object.prototype.hasOwnProperty.call(rawData, key)) {
            if (!roles || roles.includes(userRole)) {
                data[key] = rawData[key];
            }
        }
    };
    // Common fields for all roles
    includeField("name");
    includeField("phoneNumber");
    includeField("bio");
    includeField("avatarUrl");
    // Role-specific fields
    includeField("brandName", ["VENDOR"]);
    includeField("brandLogo", ["VENDOR"]);
    // customer only field
    includeField("preferences", ["CUSTOMER"]);
    // Uploaded file overrides avatarUrl
    if (req.file) {
        data.avatarUrl = `/uploads/${req.file.filename}`;
    }
    try {
        const updated = await prisma_1.default.user.update({
            where: { id: userId },
            data,
            select: {
                id: true,
                username: true,
                phoneNumber: true,
                avatarUrl: true,
                bio: true,
                preferences: true,
                role: true,
                addresses: true,
                brandName: true,
                brandLogo: true,
                updatedAt: true,
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
                    }
                }
            },
        });
        // Delivery-specific updates
        if (userRole === "DELIVERY") {
            const deliveryUpdates = {};
            if (rawData.vehicleType)
                deliveryUpdates.vehicleType = rawData.vehicleType;
            if (rawData.licensePlate)
                deliveryUpdates.licensePlate = rawData.licensePlate;
            if (rawData.status)
                deliveryUpdates.status = rawData.status;
            if (Object.keys(deliveryUpdates).length > 0) {
                await prisma_1.default.deliveryPerson.updateMany({
                    where: { userId },
                    data: deliveryUpdates,
                });
            }
        }
        res.status(200).json({
            message: "Profile updated successfully",
            user: updated,
            pendingRole: !updated.role,
        });
    }
    catch (error) {
        handlePrismaError(error, res);
    }
};
exports.updateProfile = updateProfile;
const createAddress = async (req, res) => {
    const userId = req.user?.id;
    if (!userId) {
        res.status(401).json({ message: 'Unauthorized' });
        return;
    }
    const parsed = authSchema_1.createAddressSchema.safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({ errors: parsed.error.flatten().fieldErrors });
        return;
    }
    try {
        const newAddress = await prisma_1.default.address.create({
            data: {
                ...parsed.data,
                userId,
            },
        });
        res.status(201).json({ message: 'Address added successfully', address: newAddress });
    }
    catch (err) {
        console.error('Create address error:', err);
        res.status(500).json({ error: 'Server error' });
    }
};
exports.createAddress = createAddress;
// ✅ Get all addresses
const getAllAddresses = async (req, res) => {
    try {
        const addresses = await prisma_1.default.address.findMany({
            where: { userId: req.user?.id },
            orderBy: { createdAt: "desc" },
        });
        res.json({ addresses });
    }
    catch (err) {
        console.error(err);
        res.status(500).json({ error: "Server error" });
    }
};
exports.getAllAddresses = getAllAddresses;
// ✅ Update an address (with ownership check)
const updateAddress = async (req, res) => {
    const { id } = req.params;
    const userId = req.user?.id;
    if (!userId) {
        res.status(401).json({ message: "Unauthorized" });
        return;
    }
    const parsed = authSchema_1.createAddressSchema.partial().safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({ errors: parsed.error.flatten().fieldErrors });
        return;
    }
    try {
        const updated = await prisma_1.default.address.updateMany({
            where: { id, userId }, // ✅ ensures only the owner's address can be updated
            data: parsed.data,
        });
        if (updated.count === 0) {
            res.status(404).json({ message: "Address not found or not owned by you" });
            return;
        }
        const address = await prisma_1.default.address.findUnique({ where: { id } });
        res.status(200).json({ message: "Address updated", address });
    }
    catch (err) {
        console.error("Update address error:", err);
        res.status(500).json({ error: "Server error" });
    }
};
exports.updateAddress = updateAddress;
// ✅ Delete an address (with ownership check)
const deleteAddress = async (req, res) => {
    const userId = req.user?.id;
    if (!userId) {
        res.status(401).json({ message: "Unauthorized" });
        return;
    }
    const { id } = req.params;
    try {
        const deleted = await prisma_1.default.address.deleteMany({
            where: { id, userId }, // ✅ ensures only the owner's address can be deleted
        });
        if (deleted.count === 0) {
            res.status(404).json({ message: "Address not found or not owned by you" });
            return;
        }
        res.status(200).json({ message: "Address deleted" });
    }
    catch (err) {
        console.error("Delete address error:", err);
        res.status(500).json({ error: "Server error" });
    }
};
exports.deleteAddress = deleteAddress;
