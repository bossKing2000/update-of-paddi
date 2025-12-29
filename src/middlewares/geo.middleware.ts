// middlewares/geo.middleware.ts
import { Request, Response, NextFunction } from 'express';
import axios from 'axios';
import { getClientInfo, ClientInfo } from '../utils/ip';

export interface GeoRequest extends Request {
  clientInfo?: ClientInfo & {
    city?: string;
    region?: string;
    country?: string;
    latitude?: number;
    longitude?: number;
  };
}


export const geoMiddleware = async (req: GeoRequest, res: Response, next: NextFunction) => {
  // Get basic client info
  const { ip, userAgent, deviceId } = getClientInfo(req);

  // Default to basic info
  let clientInfo: GeoRequest['clientInfo'] = { ip, userAgent, deviceId };

  try {
    // Lookup geolocation
    const resGeo = await axios.get(`https://ipapi.co/${ip}/json/`);
    const { city, region, country_name: country, latitude, longitude } = resGeo.data;

    clientInfo = { ip, userAgent, deviceId, city, region, country, latitude, longitude };
  } catch (err) {
    console.warn('Geo lookup failed:', err);
  }

  // Attach to request
  req.clientInfo = clientInfo;

  next();
};




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
