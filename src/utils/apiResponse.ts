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
  return res.status(statusCode).json(
    toJsonSafe({
      success: true,
      message,
      data,
      ...(meta ? { meta } : {}),
    }),
  );
}

export function sendCreated<T>(res: Response, data: T, message = "Created successfully") {
  return sendSuccess(res, data, message, 201);
}

export function sendNoContent(res: Response) {
  return res.status(204).send();
}

/**
 * Phase 3.2b BigInt boundary safety.
 *
 * Prisma BigInt columns (Order kobo snapshots) surface as JS bigints,
 * which `JSON.stringify` (Express res.json, Redis payloads) cannot
 * serialize — it throws "Do not know how to serialize a BigInt". This
 * converts bigints to Numbers at serialization boundaries. Snapshot kobo
 * values are small integers, Number-safe by domain. Strictly additive:
 * payloads without bigints serialize byte-identically to before.
 */
export function bigIntToNumber(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? Number(value) : value;
}

export function toJsonSafe<T>(data: T): T {
  return JSON.parse(JSON.stringify(data, bigIntToNumber)) as T;
}

/**
 * Phase 3A: convert integer kobo to naira for API responses.
 *
 * All monetary columns are now stored as integer kobo (minor currency unit).
 * Legacy clients (Flutter/web) expect naira, so monetary values are converted
 * to naira at API response boundaries and never mixed with kobo internally.
 *
 * `kobo / 100` is exact for two-decimal naira values (the domain's granularity)
 * and is Number-safe for all amounts in scope. Returns the input unchanged for
 * non-finite or non-numeric values so callers can apply it defensively.
 */
export function koboToNaira(kobo: unknown): number | unknown {
  if (typeof kobo !== "number" || !Number.isFinite(kobo)) return kobo;
  return Number((kobo / 100).toFixed(2));
}
