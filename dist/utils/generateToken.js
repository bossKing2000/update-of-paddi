"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateRefreshToken = exports.generateAccessToken = void 0;
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const config_1 = __importDefault(require("../config/config"));
const accessTokenOptions = {
    expiresIn: '5h', // 
};
const refreshTokenOptions = {
    expiresIn: '7d', // 7 days
};
// Only include role if it is defined
const generateAccessToken = (userId, role // Allow null
) => {
    const payload = { id: userId };
    if (role != null)
        payload.role = role;
    return jsonwebtoken_1.default.sign(payload, config_1.default.jwtSecret, accessTokenOptions);
};
exports.generateAccessToken = generateAccessToken;
const generateRefreshToken = (userId, tokenVersion) => {
    return jsonwebtoken_1.default.sign({ id: userId, tokenVersion }, config_1.default.jwtSecret, refreshTokenOptions);
};
exports.generateRefreshToken = generateRefreshToken;
