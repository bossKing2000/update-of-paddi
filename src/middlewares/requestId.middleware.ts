import { Request, Response, NextFunction } from "express";
import { v4 as uuidv4 } from "uuid";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      id: string;
    }
  }
}

/**
 * Attaches a unique request ID to every incoming request (reusing an
 * upstream one from X-Request-Id if a proxy/load balancer already set it)
 * and echoes it back in the response header. Every log line for this
 * request should include it — makes tracing a single user's request
 * across logs trivial, especially once multiple instances are running.
 */
export function requestIdMiddleware(req: Request, res: Response, next: NextFunction) {
  const incoming = req.headers["x-request-id"];
  req.id = typeof incoming === "string" && incoming.length > 0 ? incoming : uuidv4();
  res.setHeader("X-Request-Id", req.id);
  next();
}
