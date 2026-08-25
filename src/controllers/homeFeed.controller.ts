import { Response } from "express";
import { AuthRequest } from "../middlewares/auth.middleware";
import { sendSuccess } from "../utils/apiResponse";
import {
  getHomeFeed,
  parseHomeFeedQuery,
} from "../services/homeFeed.service";

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
  // Invalid category throws ValidationError → central error middleware
  // serializes it with the standard error envelope.
  const query = parseHomeFeedQuery({
    lat: req.query.lat,
    lng: req.query.lng,
    category: req.query.category as string | undefined,
    limit: req.query.limit,
  });

  const viewer =
    req.user != null ? { id: req.user.id, role: req.user.role } : null;

  const { payload, cache } = await getHomeFeed(viewer, query);

  res.setHeader("X-Cache", cache);
  return sendSuccess(res, payload, "Home feed fetched successfully");
};
