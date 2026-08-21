import jwt, { SignOptions } from 'jsonwebtoken';
import config from '../config/config';

const accessTokenOptions: SignOptions = {
  expiresIn: '5h',
};

const refreshTokenOptions: SignOptions = {
  expiresIn: '7d', // 7 days
};

/**
 * Access token payload is deliberately minimal: id, role, and now
 * sessionId (needed to look up the specific per-device session in Redis
 * — see lib/session.ts). Previously the payload only ever had {id, role}
 * despite auth.middleware.ts's decoded-token type claiming name/email
 * were present too — they never were, so req.user.name/req.user.email
 * were silently `undefined` everywhere, a type-safety lie waiting to
 * bite something that trusted them (it did: paymentController.ts's
 * chargeSavedCard relied on req.user.email and would have sent Paystack
 * `email: undefined` on every real charge attempt).
 *
 * Deliberately NOT adding name/email here instead of just fixing the
 * one broken caller — a JWT shouldn't carry mutable profile data that
 * can go stale (a user changing their email wouldn't be reflected until
 * their token naturally expires). Anything that needs current name/email
 * should fetch it fresh from the database.
 */
export const generateAccessToken = (userId: string, role: string | null | undefined, sessionId: string): string => {
  const payload: { id: string; role?: string; sessionId: string } = { id: userId, sessionId };
  if (role != null) payload.role = role;
  return jwt.sign(payload, config.jwtSecret, accessTokenOptions);
};

export const generateRefreshToken = (userId: string, tokenVersion: number, sessionId: string): string => {
  return jwt.sign({ id: userId, tokenVersion, sessionId }, config.jwtSecret, refreshTokenOptions);
};
