"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.successResponse = successResponse;
exports.errorResponse = errorResponse;
// ✅ Reusable response helpers
function successResponse(code, message, data, pagination) {
    return {
        success: true,
        code,
        message,
        ...(data !== undefined && { data }),
        ...(pagination !== undefined && { pagination }),
    };
}
function errorResponse(code, message, data) {
    return {
        success: false,
        code,
        message,
        ...(data !== undefined && { data }), // optional extra info
    };
}
