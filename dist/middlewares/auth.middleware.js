"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.authorizeDeliveryPerson = exports.authorizeCustomer = exports.authorizeVendor = exports.authenticate = void 0;
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const config_1 = __importDefault(require("../config/config"));
const session_1 = require("../lib/session");
// ✅ Middleware: Authenticate JWT + verify active session in Redis
const authenticate = async (req, res, next) => {
    const authReq = req;
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        res.status(401).json({ message: 'No token provided' });
        return;
    }
    const token = authHeader.split(' ')[1];
    try {
        // Decode and verify token
        const decoded = jsonwebtoken_1.default.verify(token, config_1.default.jwtSecret);
        // Check if user session exists in Redis (optional but good for logout tracking)
        const session = await (0, session_1.getUserSession)(decoded.id);
        if (!session) {
            res.status(401).json({ message: 'Session expired or not found. Please log in again.' });
            return;
        }
        // Attach user to request
        authReq.user = {
            id: decoded.id,
            role: decoded.role,
            name: decoded.name,
            email: decoded.email,
        };
        next();
    }
    catch (err) {
        console.error('Auth error:', err);
        res.status(401).json({ message: 'Invalid or expired token' });
    }
};
exports.authenticate = authenticate;
// ✅ Middleware: Only allow vendors
const authorizeVendor = (req, res, next) => {
    const authReq = req;
    if (authReq.user?.role !== 'VENDOR') {
        res.status(403).json({ message: 'Access denied: vendors only' });
        return;
    }
    next();
};
exports.authorizeVendor = authorizeVendor;
const authorizeCustomer = (req, res, next) => {
    const authReq = req;
    if (authReq.user?.role !== 'CUSTOMER') {
        res.status(403).json({ message: 'Access denied: Customers only' });
        return;
    }
    next();
};
exports.authorizeCustomer = authorizeCustomer;
const authorizeDeliveryPerson = (req, res, next) => {
    const authReq = req;
    console.log("Delivery auth check -> req.user:", authReq.user);
    if (authReq.user?.role !== 'DELIVERY') {
        res.status(403).json({ message: 'Access denied: Delivery persons only' });
        return;
    }
    next();
};
exports.authorizeDeliveryPerson = authorizeDeliveryPerson;
