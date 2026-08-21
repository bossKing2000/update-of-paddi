import { ZodError, z } from "zod";
import { Prisma } from "@prisma/client";
import { resolveError } from "../../src/middlewares/error.middleware";
import { ValidationError, NotFoundError, ForbiddenError } from "../../src/errors/AppError";

describe("resolveError", () => {
  it("maps AppError subclasses to their declared status/code", () => {
    const { statusCode, envelope } = resolveError(new NotFoundError("Order"));
    expect(statusCode).toBe(404);
    expect(envelope.code).toBe("NOT_FOUND");
    expect(envelope.message).toBe("Order not found");
  });

  it("maps ForbiddenError to 403", () => {
    const { statusCode, envelope } = resolveError(new ForbiddenError());
    expect(statusCode).toBe(403);
    expect(envelope.code).toBe("FORBIDDEN");
  });

  it("includes details on ValidationError when provided", () => {
    const { envelope } = resolveError(new ValidationError("Bad input", { field: "email" }));
    expect(envelope.errors).toEqual({ field: "email" });
  });

  it("maps ZodError to 422 with field errors", () => {
    const schema = z.object({ email: z.string().email() });
    const result = schema.safeParse({ email: "not-an-email" });
    expect(result.success).toBe(false);
    if (!result.success) {
      const { statusCode, envelope } = resolveError(result.error);
      expect(statusCode).toBe(422);
      expect(envelope.code).toBe("VALIDATION_ERROR");
    }
  });

  it("maps Prisma P2002 (unique constraint) to 409", () => {
    const err = new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
      code: "P2002",
      clientVersion: "5.0.0",
      meta: { target: ["email"] },
    });
    const { statusCode, envelope } = resolveError(err);
    expect(statusCode).toBe(409);
    expect(envelope.message).toBe("email already exists");
  });

  it("maps Prisma P2025 (record not found) to 404", () => {
    const err = new Prisma.PrismaClientKnownRequestError("Record not found", {
      code: "P2025",
      clientVersion: "5.0.0",
    });
    const { statusCode } = resolveError(err);
    expect(statusCode).toBe(404);
  });

  it("falls back to 500 for completely unknown errors, without leaking internals in production", () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const { statusCode, envelope } = resolveError(new Error("some internal detail"));
      expect(statusCode).toBe(500);
      expect(envelope.message).toBe("Something went wrong");
      expect(envelope.message).not.toContain("internal detail");
    } finally {
      process.env.NODE_ENV = originalEnv;
    }
  });
});
