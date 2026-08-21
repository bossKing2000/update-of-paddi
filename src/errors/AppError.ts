/**
 * Base class for every intentional, expected error in the app.
 *
 * Route handlers/services should `throw new SomeAppError(...)` instead of
 * manually calling `res.status(x).json(...)`. Because update-of-paddi runs
 * on Express 5, any thrown error (sync or from a rejected promise) is
 * automatically forwarded to the error middleware — no try/catch or
 * next(err) boilerplate required in controllers.
 *
 * `isOperational: true` marks this as a known, "expected" failure (bad
 * input, not found, etc.) as opposed to a genuine bug/crash — the error
 * middleware uses this to decide what's safe to show the client.
 */
export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly isOperational: boolean;
  public readonly details?: unknown;

  constructor(
    message: string,
    statusCode: number,
    code: string,
    details?: unknown,
  ) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.code = code;
    this.isOperational = true;
    this.details = details;
    Error.captureStackTrace(this, this.constructor);
  }
}

/** 400 — the request itself is malformed / fails validation */
export class ValidationError extends AppError {
  constructor(message = "Validation failed", details?: unknown) {
    super(message, 400, "VALIDATION_ERROR", details);
  }
}

/** 401 — no/invalid credentials */
export class UnauthorizedError extends AppError {
  constructor(message = "Unauthorized") {
    super(message, 401, "UNAUTHORIZED");
  }
}

/** 403 — authenticated, but not allowed to do this */
export class ForbiddenError extends AppError {
  constructor(message = "You don't have permission to do this") {
    super(message, 403, "FORBIDDEN");
  }
}

/** 404 — resource doesn't exist */
export class NotFoundError extends AppError {
  constructor(resource = "Resource") {
    super(`${resource} not found`, 404, "NOT_FOUND");
  }
}

/** 409 — conflicts with current state (duplicate email, already verified, etc.) */
export class ConflictError extends AppError {
  constructor(message = "Conflict with current state") {
    super(message, 409, "CONFLICT");
  }
}

/** 422 — well-formed request, but semantically invalid (schema-level validation) */
export class UnprocessableEntityError extends AppError {
  constructor(message = "Unprocessable request", details?: unknown) {
    super(message, 422, "UNPROCESSABLE_ENTITY", details);
  }
}

/** 429 — rate limited */
export class TooManyRequestsError extends AppError {
  constructor(message = "Too many requests, please try again later") {
    super(message, 429, "TOO_MANY_REQUESTS");
  }
}

/** 502 — an upstream provider (Paystack, Dojah, Cloudinary, etc.) failed or misbehaved */
export class UpstreamServiceError extends AppError {
  constructor(
    provider: string,
    message?: string,
    details: Record<string, unknown> = {},
  ) {
    super(
      message || `${provider} is currently unavailable`,
      502,
      "UPSTREAM_SERVICE_ERROR",
      { provider, ...details },
    );
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
