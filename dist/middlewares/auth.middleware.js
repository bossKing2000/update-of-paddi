"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.authorizeAdmin = exports.authorizeDeliveryPerson = exports.authorizeCustomer = exports.authorizeVendor = exports.requireRole = exports.optionalAuth = exports.authenticate = void 0;
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const config_1 = __importDefault(require("../config/config"));
const session_1 = require("../lib/session");
const AppError_1 = require("../errors/AppError");
// Middleware: Authenticate JWT + verify the specific per-device session is
// still active in Redis (also enables server-side logout/revocation of
// one device without affecting others).
// Throws instead of manually writing res.json — Express 5 forwards the
// rejection to the central error middleware automatically.
const authenticate = async (req, _res, next) => {
    const authReq = req;
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        throw new AppError_1.UnauthorizedError('No token provided');
    }
    const token = authHeader.split(' ')[1];
    let decoded;
    try {
        decoded = jsonwebtoken_1.default.verify(token, config_1.default.jwtSecret);
    }
    catch {
        throw new AppError_1.UnauthorizedError('Invalid or expired token');
    }
    if (!decoded.sessionId) {
        // A token signed before this session redesign (or malformed) —
        // reject cleanly rather than crashing on a missing session lookup key.
        throw new AppError_1.UnauthorizedError('Session expired or not found. Please log in again.');
    }
    const session = await (0, session_1.getUserSession)(decoded.id, decoded.sessionId);
    if (!session) {
        throw new AppError_1.UnauthorizedError('Session expired or not found. Please log in again.');
    }
    authReq.user = {
        id: decoded.id,
        role: decoded.role,
        sessionId: decoded.sessionId,
    };
    next();
};
exports.authenticate = authenticate;
// Middleware: Optional authentication for endpoints that enrich the response
// when a valid token is present but must still serve guests (e.g. the home
// feed). Uses exactly the same JWT + Redis-session verification as
// `authenticate`; any failure — missing header, bad token, revoked session —
// silently continues as an unauthenticated request instead of throwing.
// Personalization data is therefore only ever derived from a *verified*
// token; guests can never read another user's private data.
const optionalAuth = async (req, _res, next) => {
    const authReq = req;
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return next();
    }
    try {
        const token = authHeader.split(' ')[1];
        const decoded = jsonwebtoken_1.default.verify(token, config_1.default.jwtSecret);
        if (!decoded.sessionId)
            return next();
        const session = await (0, session_1.getUserSession)(decoded.id, decoded.sessionId);
        if (!session)
            return next();
        authReq.user = {
            id: decoded.id,
            role: decoded.role,
            sessionId: decoded.sessionId,
        };
    }
    catch {
        // Invalid/expired token on an enrichment-only endpoint: treat as guest.
    }
    next();
};
exports.optionalAuth = optionalAuth;
// Generic role-gate middleware factory. All the role-specific middlewares
// below are thin wrappers around this — one implementation, consistent
// behavior, easy to extend (e.g. requireRole('VENDOR', 'ADMIN')).
const requireRole = (...roles) => {
    return (req, _res, next) => {
        const authReq = req;
        if (!authReq.user) {
            throw new AppError_1.UnauthorizedError('Authentication required');
        }
        if (!roles.includes(authReq.user.role)) {
            throw new AppError_1.ForbiddenError(`Access denied: requires one of [${roles.join(', ')}]`);
        }
        next();
    };
};
exports.requireRole = requireRole;
exports.authorizeVendor = (0, exports.requireRole)('VENDOR');
exports.authorizeCustomer = (0, exports.requireRole)('CUSTOMER');
exports.authorizeDeliveryPerson = (0, exports.requireRole)('DELIVERY');
exports.authorizeAdmin = (0, exports.requireRole)('ADMIN');
