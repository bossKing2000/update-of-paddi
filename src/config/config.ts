import dotenv from "dotenv";
dotenv.config();

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

export default {
  port: process.env.PORT ? Number(process.env.PORT) : 5000,

  nodeEnv: process.env.NODE_ENV || "development",
  isProduction: process.env.NODE_ENV === "production",

  jwtSecret: process.env.JWT_SECRET!,
  jwtResetSecret: process.env.JWT_RESET_SECRET!,

  bcryptSaltRounds: Number(process.env.BCRYPT_SALT_ROUNDS) || 10,

  clientUrl: process.env.CLIENT_URL,

  // Single source of truth for CORS (server.ts) and Socket.IO CORS
  // (socket.ts) — previously duplicated as two separate hardcoded lists
  // that could silently drift apart. Extend via the ALLOWED_ORIGINS env
  // var (comma-separated) without touching code.
  allowedOrigins: [
    "https://ui-food-paddi.onrender.com",
    "https://ceeb2aee.food-paddi-website.pages.dev",
    "http://10.0.2.2:5000",
    "http://127.0.0.1:5500",
    "http://127.0.0.1:60308",
    ...(process.env.CLIENT_URL ? [process.env.CLIENT_URL] : []),
    ...(process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(",").map((o) => o.trim()) : []),
  ],

  emailUser: process.env.EMAIL_USER!,
  emailPass: process.env.EMAIL_PASS!,

  serverUrl: process.env.SERVER_URL || process.env.RENDER_EXTERNAL_URL!,

  googleClientId: process.env.GOOGLE_CLIENT_ID!,

  paystackSecret: process.env.PAYSTACK_SECRET_KEY!,
  paystackPublicKey: process.env.PAYSTACK_PUBLIC_KEY!,
  paystackCallbackUrl: (() => {
    const url = process.env.PAYSTACK_CALLBACK_URL || "";
    if (!url) return "";
    try {
      const parsed = new URL(url);
      if (process.env.NODE_ENV === "production" && parsed.protocol !== "https:") {
        throw new Error("PAYSTACK_CALLBACK_URL must be https in production");
      }
      if (!["https:", "http:"].includes(parsed.protocol)) {
        throw new Error("PAYSTACK_CALLBACK_URL must be http or https");
      }
      return url;
    } catch (e: any) {
      if (e.message?.includes("PAYSTACK_CALLBACK_URL")) throw e;
      throw new Error(`Invalid PAYSTACK_CALLBACK_URL: ${e.message}`);
    }
  })(),

  cloudinaryUrl: process.env.CLOUDINARY_URL!, // full URL

  openSearchNode: process.env.OPENSEARCH_NODE!,

  dojah: {
    appId: process.env.DOJAH_APP_ID,
    secretKey: process.env.DOJAH_SECRET_KEY,
    baseUrl: process.env.DOJAH_BASE_URL || "https://sandbox.dojah.io",
  },
};
