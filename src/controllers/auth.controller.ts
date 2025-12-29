import { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import prisma from '../lib/prisma';
import { z } from 'zod';
import config from '../config/config';
import { generateAccessToken, generateRefreshToken } from '../utils/generateToken';
import { buildAuthResponse } from '../utils/buildResponse';
import { sendResetEmail } from '../services/mail/sendResetEmail';
import { AuthRequest } from '../middlewares/auth.middleware';
import { Role, Prisma } from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import dayjs from 'dayjs'; 
import { sendVerificationEmail } from '../services/mail/sendVerificatioEmail';
import { OAuth2Client } from 'google-auth-library';
import {registerSchema, loginSchema, secureResetSchema, updateUserSchema, createAddressSchema,} from '../validations/authSchema'
import { generateResetToken } from '../utils/generateResetToken';
import { deleteUserSession, setUserSession } from '../lib/session';


const schema = z.object({ email: z.string().email() });
const googleClient = new OAuth2Client();
 

const findUserByEmail = (email: string) => prisma.user.findUnique({ where: { email } });
const findUserById = (id: string) => prisma.user.findUnique({ where: { id } });
const comparePasswords = (plain: string, hashed: string) => bcrypt.compare(plain, hashed);
const incrementTokenVersion = (userId: string) => prisma.user.update({ where: { id: userId }, data: { tokenVersion: { increment: 1 } } });


function handlePrismaError(error: any, res: Response) {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    const target = (error.meta?.target as string[] | undefined)?.[0] ?? 'Field';
    return res.status(409).json({ message: `${target} already exists` });
  }
  console.error(error);
  return res.status(500).json({ message: 'Something went wrong' });
}

export const register = async (req: AuthRequest, res: Response) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) return res.status(422).json({ errors: parsed.error.flatten().fieldErrors });

  const { username, name, email, password, role, phoneNumber,brandName } = parsed.data;

  try {
    const existingUser = await findUserByEmail(email);
    if (existingUser) return res.status(400).json({ message: 'User already exists' });

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
    if( brandName) data.brandName = brandName;

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

    const accessToken = generateAccessToken(user.id, user.role);
    const refreshToken = generateRefreshToken(user.id, user.tokenVersion);

    res.cookie('refreshToken', refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 7 * 24 * 60 * 60 * 1000,
      path: '/refresh-token',
    });

    res.status(201).json({ message: 'User registered successfully', pendingRole: !user.role, ...buildAuthResponse(user, accessToken) });
  } catch (error) {
    return handlePrismaError(error, res);
  }
};

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


export const login = async (req: Request, res: Response) => {
  const parsed = loginSchema.safeParse(req.body);
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
    const clientInfo = (req as any).clientInfo || {};
    const ip = clientInfo.ip || req.ip || "unknown";
    const userAgent = clientInfo.userAgent || req.headers['user-agent'] || "unknown";
    const deviceId = clientInfo.deviceId || null;
    const city = clientInfo.city || "unknown";
    const region = clientInfo.region || "unknown";
    const country = clientInfo.country || "unknown";

    // Update last login and create loginHistory
    const updatedUser = await prisma.user.update({
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
    const accessToken = generateAccessToken(user.id, user.role);
    const refreshToken = generateRefreshToken(user.id, user.tokenVersion);

    // Store session in Redis
    await setUserSession(user.id, {
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
      ...buildAuthResponse(user, accessToken),
      ...(isMobile ? {refreshToken} : {}),
    });


  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ message: 'Something went wrong during login' });
  }
};

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
export const refreshToken = async (req: Request, res: Response) => {
  // Get refresh token from either cookie or request body
  const token = req.cookies.refreshToken || req.body.refreshToken;

  if (!token) {
    return res.status(401).json({ message: 'No refresh token provided' });
  }

  try {
    // Verify and decode refresh token
    const decoded = jwt.verify(token, config.jwtSecret) as {
      id: string;
      tokenVersion: number;
    };

    // Find user in DB
    const user = await findUserById(decoded.id);
    if (!user || user.tokenVersion !== decoded.tokenVersion) {
      return res.status(401).json({ message: 'Invalid refresh token' });
    }

    // Generate new tokens
    const newAccessToken = generateAccessToken(user.id, user.role);
    const newRefreshToken = generateRefreshToken(user.id, user.tokenVersion);

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
  } catch (error) {
    console.error('Refresh token error:', error);
    return res.status(401).json({ message: 'Invalid or expired refresh token' });
  }
};


// Logout
export const logout = async (req: AuthRequest, res: Response) => {
  try {
  const userId = req.user?.id;
    if (!userId) return res.status(401).json({ message: 'Not authenticated' });

    await incrementTokenVersion(userId);

    // 🧹 Delete user session from Redis
    await deleteUserSession(userId);

    res.clearCookie('refreshToken', {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      path: '/refresh-token',
    });

    res.status(200).json({ message: 'Logged out successfully' });
  } catch (error) {
    console.error('Logout error:', error);
    res.status(500).json({ message: 'Something went wrong during logout' });
  }
};

// logout-all.ts
export const logoutAllDevices = async (req: AuthRequest, res: Response) => {
  await deleteUserSession(req.user!.id); // Clear all sessions from Redis
  await incrementTokenVersion(req.user!.id);
  res.json({ message: "Logged out from all devices" });
};

// Forgot Password
export const forgotPassword = async (req: Request, res: Response) => {
  const { email } = req.body;
  if (!email) return res.status(422).json({ message: 'Email is required' });

  try {
    const user = await findUserByEmail(email);
    if (!user) return res.status(404).json({ message: 'User not found' });
    
    
    const resetToken = generateResetToken(6); // generates a 6-character alphanumeric token
    const expiresInMinutes = 10;

    await prisma.passwordResetToken.upsert({
      where: { userId: user.id },
      update: {
         token: resetToken,
         expiresAt: new Date(Date.now() + expiresInMinutes * 60 * 1000)},
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
  } catch (error) {
    console.error('Forgot password error:', error);
    res.status(500).json({ message: 'Something went wrong during password reset request' });
  }
};

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

    const response: any = { ...user, pendingRole: !user.role };

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

// Get All Users
export const getAllUsers = async (_req: Request, res: Response) => {
  try {
    const users = await prisma.user.findMany({
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
  } catch (error) {
    console.error('Get all users error:', error);
    res.status(500).json({ message: 'Failed to fetch users' });
  }
};

export const selectRole = async (req: AuthRequest, res: Response) => {
  const { role } = req.body;

  const userId = req.user?.id;

  if (!userId) return res.status(401).json({ message: 'Not authenticated' });

  // Narrow the type of role
  if (role !== 'CUSTOMER' && role !== 'VENDOR' && role !== 'DELIVERY') {
    return res.status(400).json({ message: 'Invalid role' });
  }

  try {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return res.status(404).json({ message: 'User not found' });
    if (user.role) return res.status(400).json({ message: 'Role already selected' });

    const updated = await prisma.user.update({
      where: { id: userId },
      data: { role: Role[role as keyof typeof Role] }, // ✅ Safe and typed
    });

    res.status(200).json({ message: 'Role updated', role: updated.role });
  } catch (error) {
    console.error('Select role error:', error);
    res.status(500).json({ message: 'Something went wrong while setting role' });
  }
};

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
export const verifyResetCode = async (req: Request, res: Response) => {
  const { email, code } = req.body;

  if (!email || !code) {
    return res.status(422).json({ message: 'Email and code are required' });
  }

  try {
    const user = await findUserByEmail(email);
    if (!user) return res.status(404).json({ message: 'User not found' });

    const tokenEntry = await prisma.passwordResetToken.findUnique({
      where: { userId: user.id },
    });

    const now = new Date();

    if (!tokenEntry || tokenEntry.token !== code || tokenEntry.expiresAt < now) {
      return res.status(406).json({ message: 'Invalid or expired reset code' });
    }

    // Create short-lived reset token
    const resetToken = jwt.sign(
      { id: user.id },
      config.jwtResetSecret,
      { expiresIn: '10m' }
    );

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
    console.error('Verify code error:', error);
    return res.status(500).json({ message: 'Failed to verify reset code' });
  }
};



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

export const secureResetPassword = async (req: Request, res: Response) => {
  const parsed = secureResetSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(422).json({ errors: parsed.error.flatten().fieldErrors });
  }

  const { resetToken, newPassword } = parsed.data;

  try {
    const decoded = jwt.verify(resetToken, config.jwtResetSecret) as { id: string };

    const user = await findUserById(decoded.id);
    if (!user) return res.status(404).json({ message: 'User not found' });

    // 🔥 Check DB entry for reset token
    const tokenEntry = await prisma.passwordResetToken.findUnique({
      where: { userId: user.id },
    });

    if (!tokenEntry || tokenEntry.token !== resetToken || tokenEntry.expiresAt < new Date()) {
      return res.status(406).json({ message: 'Invalid or expired reset token' });
    }

    // Hash new password
    const hashedPassword = await bcrypt.hash(newPassword, 10);

    await prisma.user.update({
      where: { id: user.id },
      data: { 
        password: hashedPassword,
        authProviders: user.authProviders.includes('GOOGLE') 
          ? user.authProviders 
          : { push: 'LOCAL' }
      },
    });

    // Delete token after use
    await prisma.passwordResetToken.deleteMany({
      where: { userId: user.id },
    });

    res.status(200).json({ message: 'Password has been reset successfully' });
  } catch (error) {
    console.error('Secure reset password error:', error);
    return res.status(407).json({ message: 'Invalid or expired reset token' });
  }
};


// this link is to verify email
export const verifyEmail = async (req: Request, res: Response): Promise<void> => {
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
    const user = await prisma.user.findFirst({
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

    await prisma.user.update({
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
  } catch (error) {
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

// this will resend the verification link to the user's email if it's invalid or expired
export const resendVerificationEmail = async (req: Request, res: Response): Promise<void> => {
  try {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      res.status(400).json({ message: 'Invalid email address' });
      return;
    }

    const { email } = result.data;

    const user = await prisma.user.findUnique({ where: { email } });

    if (!user) {
      res.status(404).json({ message: 'User not found' });
      return;
    }

    if (user.isEmailVerified) {
      res.status(400).json({ message: 'Email is already verified' });
      return;
    }

    const token = crypto.randomUUID();
    const expiresAt = dayjs().add(30, 'second').toDate();

    await prisma.user.update({
      where: { email },
      data: {
        emailVerificationToken: token,
        emailVerificationExpiresAt: expiresAt
      }
    });

    await sendVerificationEmail(req, user.email, token); // ✅

    res.status(200).json({ message: 'Verification email resent successfully' });
  } catch (error) {
    console.error('[resendVerificationEmail]', error);
    res.status(500).json({ message: 'Internal server error' });
  }
};

export const googleLogin = async (req: Request, res: Response) => {
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
    } catch (verifyError) {
      console.error('[Google Token Verification Failed]', verifyError);
      return res.status(401).json({ message: 'Invalid or expired Google token. Please sign in again.' });
    }

    const payload = ticket.getPayload();
    if (!payload || !payload.email) {
      return res.status(400).json({ message: 'Unable to extract user information from Google token.' });
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
            authProviders: { push: 'GOOGLE' },
          },
        });
      } else if (user.googleId !== googleId) {
        return res.status(409).json({
          message: 'This email is already linked to a different Google account. Please use the correct account or login with email/password.',
        });
      }
    } else {
      const username = `user_${crypto.randomUUID().slice(0, 8)}`;
      user = await prisma.user.create({
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

    const updates: any = {
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

    user = await prisma.user.update({
      where: { id: user.id },
      data: updates,
    });

    const accessToken = generateAccessToken(user.id, user.role);

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
  } catch (err) {
    console.error('[Unhandled Google Login Error]', err);
    return res.status(500).json({
      message: 'Something went wrong while logging in with Google. Please try again later.',
    });
  }
};

export const updateProfile = async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.user?.id;
  const userRole = req.user?.role;

  if (!userId) {
    res.status(401).json({ message: 'Unauthorized' });
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
    const updated = await prisma.user.update({
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
      const deliveryUpdates: Record<string, any> = {};
      if (rawData.vehicleType) deliveryUpdates.vehicleType = rawData.vehicleType;
      if (rawData.licensePlate) deliveryUpdates.licensePlate = rawData.licensePlate;
      if (rawData.status) deliveryUpdates.status = rawData.status;

      if (Object.keys(deliveryUpdates).length > 0) {
        await prisma.deliveryPerson.updateMany({
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
  } catch (error) {
    handlePrismaError(error, res);
  }
};




export const createAddress = async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.user?.id;
  if (!userId) {
    res.status(401).json({ message: 'Unauthorized' });
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

    res.status(201).json({ message: 'Address added successfully', address: newAddress });
  } catch (err) {
    console.error('Create address error:', err);
    res.status(500).json({ error: 'Server error' });
  }
};


// ✅ Get all addresses
export const getAllAddresses = async (req: AuthRequest, res: Response): Promise<void> => {
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
export const updateAddress = async (req: AuthRequest, res: Response): Promise<void> => {
  const { id } = req.params;
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
    const updated = await prisma.address.updateMany({
      where: { id, userId }, // ✅ ensures only the owner's address can be updated
      data: parsed.data,
    });

    if (updated.count === 0) {
      res.status(404).json({ message: "Address not found or not owned by you" });
      return;
    }

    const address = await prisma.address.findUnique({ where: { id } });

    res.status(200).json({ message: "Address updated", address });
  } catch (err) {
    console.error("Update address error:", err);
    res.status(500).json({ error: "Server error" });
  }
};

// ✅ Delete an address (with ownership check)
export const deleteAddress = async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.user?.id;

  if (!userId) {
     res.status(401).json({ message: "Unauthorized" });
     return;
  }

  const { id } = req.params;

  try {
    const deleted = await prisma.address.deleteMany({
      where: { id, userId }, // ✅ ensures only the owner's address can be deleted
    });

    if (deleted.count === 0) {
      res.status(404).json({ message: "Address not found or not owned by you" });
      return;
    }

    res.status(200).json({ message: "Address deleted" });
  } catch (err) {
    console.error("Delete address error:", err);
    res.status(500).json({ error: "Server error" });
  }
};
