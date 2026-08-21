"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.notFoundHandler = exports.errorHandler = void 0;
exports.resolveError = resolveError;
const client_1 = require("@prisma/client");
const zod_1 = require("zod");
const multer_1 = __importDefault(require("multer"));
const logger_1 = require("../lib/logger");
const AppError_1 = require("../errors/AppError");
function isProductionEnv() {
    return process.env.NODE_ENV === "production";
}
/**
 * Maps any thrown error to { statusCode, envelope }. Kept as a pure
 * function (no res/logging side effects) so it's independently testable.
 */
function resolveError(err) {
    // Our own typed errors — already carry the right status/code.
    if ((0, AppError_1.isAppError)(err)) {
        return {
            statusCode: err.statusCode,
            envelope: { success: false, message: err.message, code: err.code, ...(err.details ? { errors: err.details } : {}) },
            logLevel: err.statusCode >= 500 ? "error" : "warn",
        };
    }
    // Zod validation errors (thrown directly, e.g. schema.parse(...))
    if (err instanceof zod_1.ZodError) {
        return {
            statusCode: 422,
            envelope: { success: false, message: "Validation failed", code: "VALIDATION_ERROR", errors: err.flatten().fieldErrors },
            logLevel: "warn",
        };
    }
    // Prisma: unique constraint violation
    if (err instanceof client_1.Prisma.PrismaClientKnownRequestError) {
        if (err.code === "P2002") {
            const target = err.meta?.target?.[0] ?? "Field";
            return {
                statusCode: 409,
                envelope: { success: false, message: `${target} already exists`, code: "CONFLICT" },
                logLevel: "warn",
            };
        }
        if (err.code === "P2025") {
            return {
                statusCode: 404,
                envelope: { success: false, message: "Record not found", code: "NOT_FOUND" },
                logLevel: "warn",
            };
        }
        if (err.code === "P2003") {
            return {
                statusCode: 409,
                envelope: { success: false, message: "This action conflicts with related records", code: "FOREIGN_KEY_CONSTRAINT" },
                logLevel: "warn",
            };
        }
        // Other known Prisma errors — treat as server-side, but don't leak internals.
        return {
            statusCode: 500,
            envelope: { success: false, message: "A database error occurred", code: "DATABASE_ERROR" },
            logLevel: "error",
        };
    }
    if (err instanceof client_1.Prisma.PrismaClientValidationError) {
        return {
            statusCode: 400,
            envelope: { success: false, message: "Invalid data provided", code: "DATABASE_VALIDATION_ERROR" },
            logLevel: "warn",
        };
    }
    // File upload errors (Multer)
    if (err instanceof multer_1.default.MulterError) {
        return {
            statusCode: 400,
            envelope: { success: false, message: err.message, code: `UPLOAD_${err.code}` },
            logLevel: "warn",
        };
    }
    // JWT errors that slipped past auth middleware
    if (err instanceof Error && (err.name === "JsonWebTokenError" || err.name === "TokenExpiredError")) {
        return {
            statusCode: 401,
            envelope: { success: false, message: "Invalid or expired token", code: "UNAUTHORIZED" },
            logLevel: "warn",
        };
    }
    // Unknown/unexpected — never leak internals to the client.
    return {
        statusCode: 500,
        envelope: {
            success: false,
            message: isProductionEnv() ? "Something went wrong" : err instanceof Error ? err.message : "Unknown error",
            code: "INTERNAL_ERROR",
        },
        logLevel: "error",
    };
}
const errorHandler = (err, req, res, _next) => {
    const { statusCode, envelope, logLevel } = resolveError(err);
    const logContext = {
        requestId: req.id,
        method: req.method,
        url: req.originalUrl,
        statusCode,
        userId: req.user?.id,
        err: err instanceof Error ? { message: err.message, stack: err.stack, name: err.name } : err,
    };
    logger_1.logger[logLevel](logContext, `${req.method} ${req.originalUrl} -> ${statusCode}`);
    // Non-production: attach stack trace for faster debugging.
    if (!isProductionEnv() && err instanceof Error && statusCode >= 500) {
        envelope.stack = err.stack;
    }
    res.status(statusCode).json(envelope);
};
exports.errorHandler = errorHandler;
/**
 * 404 handler for routes that don't match anything — mount this after all
 * route registrations, before errorHandler.
 */
const notFoundHandler = (req, res) => {
    res.status(404).json({
        success: false,
        message: `Route ${req.method} ${req.originalUrl} not found`,
        code: "ROUTE_NOT_FOUND",
    });
};
exports.notFoundHandler = notFoundHandler;
