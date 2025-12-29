// ✅ Reusable response helpers
export function successResponse(code: string, message: string, data?: any, pagination?: any) {
  return {
    success: true,
    code,
    message,
    ...(data !== undefined && { data }),
    ...(pagination !== undefined && { pagination }),
  };
}

export function errorResponse(code: string, message: string, data?: any) {
  return {
    success: false,
    code,
    message,
    ...(data !== undefined && { data }), // optional extra info

  };
}



