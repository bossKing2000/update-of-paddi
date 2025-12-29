import { Request } from "express";

export interface ClientInfo {
  ip: string;
  userAgent: string;
  deviceId: string | null;
  city?: string;
  region?: string;
  country?: string;
  latitude?: number;
  longitude?: number;
}

/**
 * Returns basic client info from the request.
 * Does NOT perform geolocation lookup.
 */
export const getClientInfo = (req: Request): ClientInfo => {
  const xForwardedFor = req.headers["x-forwarded-for"];
  const ip = typeof xForwardedFor === "string"
    ? xForwardedFor.split(",")[0].trim()
    : req.socket.remoteAddress || "unknown";

  const userAgent = req.headers["user-agent"] || "unknown";
  const deviceId = (req.headers["x-device-id"] as string) || null;

  return { ip, userAgent, deviceId };
};
