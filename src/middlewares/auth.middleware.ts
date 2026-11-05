import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import config from '../config/config';
import { deleteAllUserSessions, getUserSession, resolveSessionRole } from '../lib/session';
import prisma from '../lib/prisma';
import { UnauthorizedError, ForbiddenError } from '../errors/AppError';

// Combined interface: supports user + multer file handling
export interface AuthRequest extends Request {
  // Deliberately just {id, role, sessionId} — matches exactly what's
  // actually signed into the JWT (see utils/generateToken.ts). Previously
  // this claimed name/email were always present too, but they were never
  // in the token — req.user.name/req.user.email were silently `undefined`
  // everywhere despite the type saying `string`. Anything needing current
  // name/email should fetch it fresh from the database.
  user?: { id: string; role: string; sessionId: string };
  file?: Express.Multer.File;
  files?: Express.Multer.File[] | { [fieldname: string]: Express.Multer.File[] };
}

// Middleware: Authenticate JWT + verify the specific per-device session is
// still active in Redis (also enables server-side logout/revocation of
// one device without affecting others).
// Throws instead of manually writing res.json — Express 5 forwards the
// rejection to the central error middleware automatically.
export const authenticate = async (
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> => {
  const authReq = req as AuthRequest;
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new UnauthorizedError('No token provided');
  }

  const token = authHeader.split(' ')[1];

  let decoded: { id: string; role: string; sessionId: string; tokenVersion?: unknown; typ?: unknown };
  try {
    decoded = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] }) as typeof decoded;
  } catch {
    throw new UnauthorizedError('Invalid or expired token');
  }

  // Phase 1E.2 — type and version gate, BEFORE any state is touched.
  //
  // Access and refresh tokens share one signing secret, so a refresh token
  // must not be able to pose as a Bearer access token: refresh tokens carry a
  // `tokenVersion` but no `typ`, and are refused here.
  //
  // A missing or non-numeric `tokenVersion` is a pre-1E.2 token. It is
  // REJECTED, never treated as current: a permissive "assume it is fine"
  // fallback would silently re-open exactly the window this change closes.
  // The impact is a one-time forced refresh, and clients recover seamlessly
  // because their refresh token is checked against the same authoritative
  // value and is unaffected by this change.
  if (decoded.typ !== 'access') {
    throw new UnauthorizedError('Invalid or expired token');
  }
  if (typeof decoded.tokenVersion !== 'number' || !Number.isInteger(decoded.tokenVersion)) {
    throw new UnauthorizedError('Session expired or not found. Please refresh your session.');
  }

  if (!decoded.sessionId) {
    // A token signed before this session redesign (or malformed) —
    // reject cleanly rather than crashing on a missing session lookup key.
    throw new UnauthorizedError('Session expired or not found. Please log in again.');
  }

  const session = await getUserSession(decoded.id, decoded.sessionId);
  if (!session) {
    throw new UnauthorizedError('Session expired or not found. Please log in again.');
  }

  // Backend enforcement of the admin block: a blocked user keeps no usable
  // session even if a token was issued before the block (e.g. revocation
  // raced a login) or the session was restored from the DB fallback.
  //
  // Phase 1E / 1E.2: the SAME per-request lookup that already ran for
  // `isBlocked` now also reads the held roles and the live `tokenVersion`, so
  // both role enforcement and version enforcement cost NO additional database
  // round trip. Nothing is cached for this decision — the value is compared
  // against the authoritative row on every request, which is what stops a
  // cached session from resurrecting a pre-password-change token.
  const account = await prisma.user
    .findUnique({
      where: { id: decoded.id },
      select: { isBlocked: true, role: true, roles: true, tokenVersion: true },
    })
    .catch(() => null);
  if (account?.isBlocked) {
    await deleteAllUserSessions(decoded.id).catch(() => {});
    throw new ForbiddenError('This account has been blocked.');
  }

  // The authoritative invalidation. A password change (and password reset)
  // increments `User.tokenVersion`; this compares the token's claim against
  // the live value, so a pre-change access token dies the moment the bump is
  // durable — independently of whether the session sweep succeeded.
  if (!account || account.tokenVersion !== decoded.tokenVersion) {
    throw new UnauthorizedError('Session expired or not found. Please log in again.');
  }

  // The session is the authority on which role is in play; the JWT claim is
  // only a cached copy of it. Comparing the two is what makes a role switch
  // (or a demotion) take effect immediately instead of whenever the 15-minute
  // access token happens to expire.
  const sessionRole = resolveSessionRole(session, account?.role);
  const tokenRole = decoded.role ?? null;
  if (tokenRole !== sessionRole) {
    throw new UnauthorizedError('Session role is out of date. Please refresh your session.');
  }

  // A role the account no longer authorises must never survive on a session,
  // whichever layer supplied it.
  if (sessionRole !== null && account && !account.roles.includes(sessionRole as never)) {
    throw new ForbiddenError(`Access denied: ${sessionRole} is no longer held by this account.`);
  }

  authReq.user = {
    id: decoded.id,
    role: sessionRole ?? '',
    sessionId: decoded.sessionId,
  };

  next();
};

// Middleware: Optional authentication for endpoints that enrich the response
// when a valid token is present but must still serve guests (e.g. the home
// feed). Uses exactly the same JWT + Redis-session verification as
// `authenticate`; any failure — missing header, bad token, revoked session —
// silently continues as an unauthenticated request instead of throwing.
// Personalization data is therefore only ever derived from a *verified*
// token; guests can never read another user's private data.
export const optionalAuth = async (
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> => {
  const authReq = req as AuthRequest;
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return next();
  }

  try {
    const token = authHeader.split(' ')[1];

    const decoded = jwt.verify(token, config.jwtSecret) as {
      id: string;
      role: string;
      sessionId: string;
      typ?: unknown;
    };

    // Phase 1E.2: only an access token counts as "signed in" here. A refresh
    // token shares the signing secret, so without the discriminator one could
    // be presented as a Bearer token and enrich a response as if signed in.
    // Deliberately NOT a version check: this middleware is enrichment-only
    // (it is mounted on exactly one route, `/feed`, with no role gate behind
    // it), and turning it into an authorization mechanism would add a database
    // read per request for no security gain — anything that actually
    // authorizes goes through `authenticate`.
    if (decoded.typ !== 'access') return next();

    if (!decoded.sessionId) return next();

    const session = await getUserSession(decoded.id, decoded.sessionId);
    if (!session) return next();

    authReq.user = {
      id: decoded.id,
      // Same precedence as `authenticate`: a session that carries its own
      // role wins. No account lookup is added here — this middleware is for
      // enrichment only and must stay a single cached read, so a legacy
      // session falls back to the token claim exactly as it did before.
      role: resolveSessionRole(session, decoded.role) ?? '',
      sessionId: decoded.sessionId,
    };
  } catch {
    // Invalid/expired token on an enrichment-only endpoint: treat as guest.
  }

  next();
};

// Generic role-gate middleware factory. All the role-specific middlewares
// below are thin wrappers around this — one implementation, consistent
// behavior, easy to extend (e.g. requireRole('VENDOR', 'ADMIN')).
export const requireRole = (...roles: string[]) => {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const authReq = req as AuthRequest;

    if (!authReq.user) {
      throw new UnauthorizedError('Authentication required');
    }

    if (!roles.includes(authReq.user.role)) {
      throw new ForbiddenError(`Access denied: requires one of [${roles.join(', ')}]`);
    }

    next();
  };
};

export const authorizeVendor = requireRole('VENDOR');
export const authorizeCustomer = requireRole('CUSTOMER');
export const authorizeDeliveryPerson = requireRole('DELIVERY');
export const authorizeAdmin = requireRole('ADMIN');
