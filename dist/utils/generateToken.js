"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateRefreshToken = exports.generateAccessToken = void 0;
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const config_1 = __importDefault(require("../config/config"));
const accessTokenOptions = {
    expiresIn: '5h',
};
const refreshTokenOptions = {
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
const generateAccessToken = (userId, role, sessionId) => {
    const payload = { id: userId, sessionId };
    if (role != null)
        payload.role = role;
    return jsonwebtoken_1.default.sign(payload, config_1.default.jwtSecret, accessTokenOptions);
};
exports.generateAccessToken = generateAccessToken;
const generateRefreshToken = (userId, tokenVersion, sessionId) => {
    return jsonwebtoken_1.default.sign({ id: userId, tokenVersion, sessionId }, config_1.default.jwtSecret, refreshTokenOptions);
};
exports.generateRefreshToken = generateRefreshToken;
