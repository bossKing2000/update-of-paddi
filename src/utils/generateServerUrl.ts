import { Request } from "express";

export function generateServerUrl(req: Request): string {
  // Priority: 1. Manually set 2. Render auto 3. Runtime from request
  return (
    process.env.SERVER_URL?.replace(/\/$/, "") ||
    process.env.RENDER_EXTERNAL_URL?.replace(/\/$/, "") ||
    `${req.protocol}://${req.get("host")}`
  );
}
