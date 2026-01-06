"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.validatePaystackSignature = void 0;
const crypto_1 = __importDefault(require("crypto"));
const validatePaystackSignature = (rawBody, signature) => {
    const secret = process.env.PAYSTACK_SECRET;
    const hash = crypto_1.default.createHmac("sha512", secret).update(rawBody).digest("hex");
    return hash === signature;
};
exports.validatePaystackSignature = validatePaystackSignature;
