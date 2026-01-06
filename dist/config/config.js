"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
// Required environment checks
if (!process.env.JWT_SECRET)
    throw new Error("Missing environment variable: JWT_SECRET");
if (!process.env.JWT_RESET_SECRET)
    throw new Error("Missing environment variable: JWT_RESET_SECRET");
if (!process.env.SERVER_URL)
    throw new Error("Missing environment variable: SERVER_URL");
if (!process.env.CLOUDINARY_URL)
    throw new Error("Missing environment variable: CLOUDINARY_URL");
if (!process.env.OPENSEARCH_NODE)
    throw new Error("Missing environment variable: OPENSEARCH_NODE");
exports.default = {
    port: process.env.PORT ? Number(process.env.PORT) : 5000,
    jwtSecret: process.env.JWT_SECRET,
    jwtResetSecret: process.env.JWT_RESET_SECRET,
    bcryptSaltRounds: Number(process.env.BCRYPT_SALT_ROUNDS) || 10,
    clientUrl: process.env.CLIENT_URL,
    emailUser: process.env.EMAIL_USER,
    emailPass: process.env.EMAIL_PASS,
    serverUrl: process.env.SERVER_URL || process.env.RENDER_EXTERNAL_URL,
    googleClientId: process.env.GOOGLE_CLIENT_ID,
    paystackSecret: process.env.PAYSTACK_SECRET_KEY,
    paystackPublicKey: process.env.PAYSTACK_PUBLIC_KEY,
    paystackCallbackUrl: process.env.PAYSTACK_CALLBACK_URL || "",
    cloudinaryUrl: process.env.CLOUDINARY_URL, // full URL
    openSearchNode: process.env.OPENSEARCH_NODE,
};
