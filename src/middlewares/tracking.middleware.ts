// src/middlewares/trackUserAction.ts
import { Request, Response, NextFunction } from "express";
import axios from "axios";
import { createAuditLog } from "../utils/auditLog.service";
import prisma from "../lib/prisma";

// Extended request type if using geoMiddleware
interface ClientRequest extends Request {
  clientInfo?: {
    ip: string;
    userAgent: string;
    deviceId: string | null;
    city?: string;
    region?: string;
    country?: string;
    latitude?: number;
    longitude?: number;
  };
}

// Track user action middleware
export const trackUserAction = (action: string) => {
  return (req: ClientRequest, res: Response, next: NextFunction) => {
    const { ip: originalIp, userAgent, deviceId } = req.clientInfo || {};
    const userId = (req as any).user?.id || null;

    // Call next immediately (do not block request)
    next();

    // Background logging
    (async () => {
      try {
        let geoData = {} as {
          city?: string;
          region?: string;
          country?: string;
          latitude?: number;
          longitude?: number;
        };

        // If geoMiddleware not used, fetch geo info dynamically
        const ipToLookup = originalIp || req.ip || "unknown";
        if (!req.clientInfo?.city) {
          try {
            const resGeo = await axios.get(`https://ipapi.co/${ipToLookup}/json/`);
            const { city, region, country_name: country, latitude, longitude } = resGeo.data;
            geoData = { city, region, country, latitude, longitude };
          } catch (err) {
            console.warn("Geo lookup failed:", err);
          }
        } else {
          geoData = {
            city: req.clientInfo?.city,
            region: req.clientInfo?.region,
            country: req.clientInfo?.country,
            latitude: req.clientInfo?.latitude,
            longitude: req.clientInfo?.longitude,
          };
        }

        // Use the service
        await createAuditLog({
          userId,
          action,
          req,
          metadata: {
            ip: originalIp || "unknown",
            userAgent: userAgent || "unknown",
            deviceId: deviceId || null,
            geo: geoData,
            headers: req.headers,
          },
        });

        // Extra: Login-specific logs
        if (action === "LOGIN" && userId) {
          await prisma.loginHistory.create({
            data: {
              userId,
              method: "password",
              ip: originalIp || "unknown",
              userAgent: userAgent || "unknown",
              deviceId: deviceId || null,
              geoCity: geoData.city,
              geoRegion: geoData.region,
              geoCountry: geoData.country,
            },
          });
        }
      } catch (err) {
        console.error("Async tracking error:", err);
      }
    })();
  };
};
