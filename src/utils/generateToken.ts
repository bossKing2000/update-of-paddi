import jwt, { SignOptions } from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import config from '../config/config';

/**
 * Phase 1E requires a 15-minute access token. This was previously `'5h'`,
 * which meant a stolen bearer token stayed usable for five hours even after
 * the user logged out elsewhere, and a role demotion could not take effect for
 * up to five hours (the role is a JWT claim, so `authenticate` trusts it).
 *
 * 15 minutes bounds that window. The compensating control is the refresh flow:
 * `POST /api/auth/refresh-token` mints a new access token from a valid,
 * single-use refresh token, so clients must refresh rather than hold a token.
 * The refresh token keeps its own independent 7-day lifetime below — the two
 * are deliberately different clocks and must not be conflated.
 */
const accessTokenOptions: SignOptions = {
  expiresIn: '15m',
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
/**
 * Phase 1E.2: the access token now carries `tokenVersion` and a `typ`
 * discriminator.
 *
 * `tokenVersion` is what makes a password change take effect on ACCESS tokens
 * immediately, instead of whenever the 15-minute expiry happens to arrive.
 * Previously invalidation relied entirely on the session row disappearing, so
 * a failed session deletion left pre-change access tokens usable for their
 * remaining lifetime. `authenticate` already loads the user row once per
 * request, so the comparison adds no extra database read.
 *
 * `typ` exists because access and refresh tokens are signed with the SAME
 * secret. Without a discriminator a refresh token — which legitimately carries
 * `tokenVersion` — could be replayed as a Bearer access token and sail through
 * the new version check. Access tokens are required to present `typ: 'access'`;
 * anything else is rejected rather than treated as current.
 *
 * `tokenVersion` is a REQUIRED parameter rather than an optional one, so a
 * call site cannot silently mint an unverifiable token: every caller must pass
 * the authoritative value.
 */
export const generateAccessToken = (
  userId: string,
  role: string | null | undefined,
  sessionId: string,
  tokenVersion: number,
): string => {
  const payload: { id: string; role?: string; sessionId: string; tokenVersion: number; typ: 'access' } = {
    id: userId,
    sessionId,
    tokenVersion,
    typ: 'access',
  };
  if (role != null) payload.role = role;
  return jwt.sign(payload, config.jwtSecret, accessTokenOptions);
};

export const generateRefreshToken = (userId: string, tokenVersion: number, sessionId: string, jti?: string): string => {
  const tokenId = jti || uuidv4();
  return jwt.sign({ id: userId, tokenVersion, sessionId, jti: tokenId }, config.jwtSecret, refreshTokenOptions);
};

export const decodeRefreshToken = (token: string): { id: string; tokenVersion: number; sessionId?: string; jti?: string } | null => {
  try {
    return jwt.verify(token, config.jwtSecret) as any;
  } catch {
    return null;
  }
};
