import { Response } from "express";
import { AuthRequest } from "../middlewares/auth.middleware";
import { sendSuccess } from "../utils/apiResponse";
import {
  getHomeFeed,
  parseHomeFeedQuery,
} from "../services/homeFeed.service";
import { fetchWhatsInThePot } from "../services/product.service";

// GET /api/home/feed
//
// Composed homepage feed. Authentication is OPTIONAL: guests receive the
// public feed, verified users additionally get customer promotions and
// their unread notification count. The viewer is always derived from the
// verified token (optionalAuth middleware) — never from query parameters.
export const getHomeFeedController = async (
  req: AuthRequest,
  res: Response
) => {
  // Invalid dishType throws ValidationError → central error middleware
  // serializes it with the standard error envelope.
  const query = await parseHomeFeedQuery({
    lat: req.query.lat,
    lng: req.query.lng,
    dishType: req.query.dishType as string | undefined,
    category: req.query.category as string | undefined,
    limit: req.query.limit,
  });

  const viewer =
    req.user != null ? { id: req.user.id, role: req.user.role } : null;

  const { payload, cache } = await getHomeFeed(viewer, query);

  res.setHeader("X-Cache", cache);
  return sendSuccess(res, payload, "Home feed fetched successfully");
};

// GET /api/home/whats-in-the-pot — public, no auth required.
// Dish types with at least one orderable product right now, ranked by
// count. Dynamic: a dish with nothing orderable never appears.
export const getWhatsInThePotController = async (
  _req: AuthRequest,
  res: Response,
) => {
  const pot = await fetchWhatsInThePot();
  return sendSuccess(res, { pot }, "What's in the pot fetched successfully");
};
