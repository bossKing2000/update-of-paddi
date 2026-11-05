import rateLimit from 'express-rate-limit';
import { clientRateLimitIdentity } from '../utils/clientIp';

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

// Phase 1D.3/1D.38/1D.39: phone OTP endpoints. Defense in depth on top of the
// Redis-backed service limits (Phase 1D.38: 5 generations/phone/24h,
// 20 generations/IP/24h, 5 attempts/OTP, 60s resend cooldown), which are
// the authoritative ones — they are atomic and shared across instances,
// whereas this in-process store is per instance.
// ACTUAL KEYING: per client IP, on every mount. The `req.user?.id ||` branch
// below is DEAD CODE here, not a fallback. All five mounts of this limiter
// register it BEFORE `authenticate` (see routes/auth.routes.ts: the
// `/phone/request-otp`, `/phone/verify-otp` and `DELETE /phone` routes pass
// `phoneOtpRateLimiter, authenticate` in that order), so `req.user` is always
// undefined at the moment the key generator runs. This limiter is therefore
// IP-keyed end to end, and the comment previously claiming "keyed per account
// where there is one, else per IP ... so one abusive account cannot exhaust
// the shared IP budget" described intent the wiring does not deliver. Task
// 7.34 corrected that text; it did NOT change any behaviour.
//
// Consequence, stated plainly: an authenticated account behind a shared NAT
// consumes the same IP budget as its neighbours and has no separate allowance
// here. That is not an unbounded hole, because the authoritative limits are
// NOT this one — `phoneOtp.service.ts` charges a purpose-independent per-
// NORMALIZED-PHONE budget (5/24h, keyed `otp:rl:phone:<E.164>`) and a per-IP
// budget (20/24h), both atomically inside `ISSUE_LUA` and shared across
// instances. Abuse of one account's OTP surface stays bounded by that per-phone
// budget regardless of how requests are distributed across IPs.
//
// Do NOT "fix" this by reordering the middleware so `authenticate` runs first.
// That is a security-behaviour change, not a documentation change, and it has
// trade-offs in both directions: per-account keys stop one abusive account
// from exhausting a NAT's shared IP budget, but they also let a caller spread
// requests across many addresses to obtain a fresh per-account budget, which
// is precisely what the IP key prevents. It additionally changes the public
// phone-login routes, where no account exists at all. Any such redesign needs
// its own explicit security decision plus regression coverage (see
// tests/unit/phoneOtpRateLimit.test.ts and tests/unit/ipv6RateLimitBypass.test.ts,
// which pin the CURRENT IP-keyed behaviour and would have to be re-authored
// deliberately, not incidentally).
//
// Phase 1D.39 (F1): the IP component goes through the SAME
// `clientRateLimitIdentity` normalisation the OTP service uses for its Redis
// key. Both layers must agree on "same client" or a caller could hop between
// them to double its budget, and raw IPv6 addresses would otherwise get a
// fresh bucket per host address. See utils/clientIp.ts.
export const phoneOtpRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  keyGenerator: (req: any) => req.user?.id || clientRateLimitIdentity(req.ip),
  message: { success: false, code: 'RATE_LIMITED', message: 'Too many phone verification requests, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Phase 1E: email OTP passwordless login. Mirrors phoneOtpRateLimiter for the
// two PUBLIC /email/login/* routes.
//
// It is deliberately its OWN instance rather than a reuse of authRateLimiter:
// that limiter is shared by /login, /refresh-token, /resend-verification and
// /verify-reset-code, so sharing it would let a caller guessing email login
// codes exhaust the per-IP budget of an unrelated authenticated user behind
// the same address. A dedicated instance keeps the blast radius to the two
// routes that actually consume a one-time code.
//
// The Redis-backed limits in emailOtp.service.ts remain authoritative and
// shared across instances; this limiter is the in-process first line that
// bounds code-guessing on a public endpoint.
export const emailOtpRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  keyGenerator: (req: any) => req.user?.id || clientRateLimitIdentity(req.ip),
  message: { success: false, code: 'RATE_LIMITED', message: 'Too many email verification requests, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Phase 1E: authenticated password changes. Tight per-account budget so
// the current-password check cannot be brute-forced; the service-level
// login limiter is a different surface (unauthenticated, per email).
//
// Batch 1D.77: the IP branch now folds IPv6 to a /56 via
// `clientRateLimitIdentity`. This limiter is mounted BEFORE `authenticate`
// on /change-password (see routes/auth.routes.ts), so `req.user` is always
// undefined here and the IP branch is the only one that ever runs — which
// made a raw `req.ip` key a real bypass: a client handed a routed /56 could
// mint a fresh budget per request by rotating host bits, defeating the very
// brute-force budget this limiter exists to enforce.
export const passwordChangeRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  keyGenerator: (req: any) => req.user?.id || clientRateLimitIdentity(req.ip),
  message: { success: false, code: 'RATE_LIMITED', message: 'Too many password change attempts, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Batch 1D.67: the final step of the password-reset flow
// (POST /secure-reset-password). It is deliberately NOT covered by
// authRateLimiter: that limiter guards the *code* step
// (/verify-reset-code) and is shared by five routes, so reusing it here would
// make one user's reset finalization draw from the same per-IP budget as
// their refresh-token and login calls and lock them out of unrelated
// operations. A dedicated instance keeps the blast radius to this route.
//
// Volume, not guessing, is the threat here: the endpoint's credential is
// single-use (an atomic consume inside the reset transaction), so this limiter
// does not weaken that guarantee — it bounds how much work an unauthenticated
// caller can request. That matters because each request reaching the
// controller costs a bcrypt hash before the single-use gate, so an unbounded
// script of requests carrying one valid token turns the endpoint into a CPU
// amplifier.
//
// Keyed on the client address, never on the decoded user id: keying on the
// account would turn a 429 into an account-existence oracle for a caller who
// does not hold the token.
//
// LIMITATION (deliberate, unresolved): this is the library's default
// in-process store, so the budget is per process, resets on restart, and is NOT
// shared across replicas. Like every limiter in this file, it is defence in
// depth, not a cross-instance control. A Redis-backed per-account/per-token
// counter (fail-closed, like src/services/passwordResetLimits.service.ts) is
// the authoritative design and is intentionally deferred to a separate batch.
export const secureResetRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  keyGenerator: (req: any) => clientRateLimitIdentity(req.ip),
  message: { success: false, code: 'RATE_LIMITED', message: 'Too many password reset attempts, please try again later' },
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

// AI endpoints that fan out to paid third-party calls per request
// (recommendations issues one embedding call per catalog product).
// search-correct is offline/local and intentionally left unlimited.
//
// Batch 1D.77: these routes are deliberately unauthenticated (see
// routes/aiRouter.ts), so `req.user` is never set and the IP branch is always
// taken. Folding IPv6 to a /56 closes the same host-bit rotation bypass here —
// which matters more than usual on a cost control guarding paid embedding
// calls.
export const aiRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  keyGenerator: (req: any) => req.user?.id || clientRateLimitIdentity(req.ip),
  message: { success: false, code: 'RATE_LIMITED', message: 'Too many AI requests, please slow down' },
  standardHeaders: true,
  legacyHeaders: false,
});
