"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getClientInfo = void 0;
/**
 * Returns basic client info from the request.
 * Does NOT perform geolocation lookup.
 */
const getClientInfo = (req) => {
    const xForwardedFor = req.headers["x-forwarded-for"];
    const ip = typeof xForwardedFor === "string"
        ? xForwardedFor.split(",")[0].trim()
        : req.socket.remoteAddress || "unknown";
    const userAgent = req.headers["user-agent"] || "unknown";
    const deviceId = req.headers["x-device-id"] || null;
    return { ip, userAgent, deviceId };
};
exports.getClientInfo = getClientInfo;
