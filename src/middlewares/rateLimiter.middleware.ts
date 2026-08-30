import rateLimit from 'express-rate-limit';

export const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20, // max 20 requests per window per IP
  message: 'Too many requests from this IP, please try again after 15 minutes',
  standardHeaders: true,
  legacyHeaders: false,
});

export const paymentRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  keyGenerator: (req: any) => req.user?.id || req.ip,
  message: { success: false, code: 'PAYMENT_RATE_LIMITED', message: 'Too many payment requests, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

export const checkoutRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  keyGenerator: (req: any) => req.user?.id || req.ip,
  message: { success: false, code: 'PAYMENT_RATE_LIMITED', message: 'Too many checkout attempts, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

export const otpRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  keyGenerator: (req: any) => {
    const userId = req.user?.id || req.ip;
    const ref = req.body?.reference || req.body?.cardId || '';
    return `${userId}:${ref}`;
  },
  message: { success: false, code: 'PAYMENT_RATE_LIMITED', message: 'Too many attempts, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

export const cartSummaryRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  keyGenerator: (req: any) => req.user?.id || req.ip,
  message: { success: false, code: 'RATE_LIMITED', message: 'Too many requests, please slow down' },
  standardHeaders: true,
  legacyHeaders: false,
});
