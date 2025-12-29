import crypto from "crypto";

export const validatePaystackSignature = (rawBody: string | Buffer, signature: string) => {
  const secret = process.env.PAYSTACK_SECRET!;
  const hash = crypto.createHmac("sha512", secret).update(rawBody).digest("hex");
  return hash === signature;
};
