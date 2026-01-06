"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.trackUserAction = void 0;
const axios_1 = __importDefault(require("axios"));
const auditLog_service_1 = require("../utils/auditLog.service");
const prisma_1 = __importDefault(require("../lib/prisma"));
// Track user action middleware
const trackUserAction = (action) => {
    return (req, res, next) => {
        const { ip: originalIp, userAgent, deviceId } = req.clientInfo || {};
        const userId = req.user?.id || null;
        // Call next immediately (do not block request)
        next();
        // Background logging
        (async () => {
            try {
                let geoData = {};
                // If geoMiddleware not used, fetch geo info dynamically
                const ipToLookup = originalIp || req.ip || "unknown";
                if (!req.clientInfo?.city) {
                    try {
                        const resGeo = await axios_1.default.get(`https://ipapi.co/${ipToLookup}/json/`);
                        const { city, region, country_name: country, latitude, longitude } = resGeo.data;
                        geoData = { city, region, country, latitude, longitude };
                    }
                    catch (err) {
                        console.warn("Geo lookup failed:", err);
                    }
                }
                else {
                    geoData = {
                        city: req.clientInfo?.city,
                        region: req.clientInfo?.region,
                        country: req.clientInfo?.country,
                        latitude: req.clientInfo?.latitude,
                        longitude: req.clientInfo?.longitude,
                    };
                }
                // Use the service
                await (0, auditLog_service_1.createAuditLog)({
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
                    await prisma_1.default.loginHistory.create({
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
            }
            catch (err) {
                console.error("Async tracking error:", err);
            }
        })();
    };
};
exports.trackUserAction = trackUserAction;
