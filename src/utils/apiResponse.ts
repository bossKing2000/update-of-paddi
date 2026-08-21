import { Response } from "express";

/**
 * Standard success envelope used across the rewritten API surface:
 *   { success: true, message, data, meta? }
 *
 * Paired with errors thrown as AppError subclasses, which the central
 * error middleware serializes as:
 *   { success: false, message, code, errors? }
 *
 * Older, not-yet-rewritten endpoints may still return bespoke shapes —
 * this is being adopted domain by domain, not as a big-bang rewrite.
 */
export interface ApiMeta {
  page?: number;
  limit?: number;
  total?: number;
  totalPages?: number;
  [key: string]: unknown;
}

export function sendSuccess<T>(
  res: Response,
  data: T,
  message = "Success",
  statusCode = 200,
  meta?: ApiMeta
) {
  return res.status(statusCode).json({
    success: true,
    message,
    data,
    ...(meta ? { meta } : {}),
  });
}

export function sendCreated<T>(res: Response, data: T, message = "Created successfully") {
  return sendSuccess(res, data, message, 201);
}

export function sendNoContent(res: Response) {
  return res.status(204).send();
}
