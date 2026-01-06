"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.geoMiddleware = void 0;
const axios_1 = __importDefault(require("axios"));
const ip_1 = require("../utils/ip");
const geoMiddleware = async (req, res, next) => {
    // Get basic client info
    const { ip, userAgent, deviceId } = (0, ip_1.getClientInfo)(req);
    // Default to basic info
    let clientInfo = { ip, userAgent, deviceId };
    try {
        // Lookup geolocation
        const resGeo = await axios_1.default.get(`https://ipapi.co/${ip}/json/`);
        const { city, region, country_name: country, latitude, longitude } = resGeo.data;
        clientInfo = { ip, userAgent, deviceId, city, region, country, latitude, longitude };
    }
    catch (err) {
        console.warn('Geo lookup failed:', err);
    }
    // Attach to request
    req.clientInfo = clientInfo;
    next();
};
exports.geoMiddleware = geoMiddleware;
// src/utils/geo.ts
/**
 * Find the nearest online driver
 */
// export async function findNearestDriver(lat: number, lng: number) {
//   // fetch all online drivers
//   const drivers = await prisma.deliveryPerson.findMany({
//     where: { isOnline: true },
//     select: { id: true, userId: true, latitude: true, longitude: true },
//   });
//   if (!drivers.length) return null;
//   const calcDist = (d: any) =>
//     Math.sqrt(Math.pow((d.latitude ?? 0) - lat, 2) + Math.pow((d.longitude ?? 0) - lng, 2));
//   return drivers.reduce((nearest, d) =>
//     calcDist(d) < calcDist(nearest) ? d : nearest
//   );
// }
