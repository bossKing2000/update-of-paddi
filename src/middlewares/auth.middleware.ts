import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import config from '../config/config';
import { getUserSession } from '../lib/session';
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

  let decoded: { id: string; role: string; sessionId: string };
  try {
    decoded = jwt.verify(token, config.jwtSecret) as typeof decoded;
  } catch {
    throw new UnauthorizedError('Invalid or expired token');
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

  authReq.user = {
    id: decoded.id,
    role: decoded.role,
    sessionId: decoded.sessionId,
  };

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
