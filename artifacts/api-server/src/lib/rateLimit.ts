import rateLimit from "express-rate-limit";

// IP-based limiter for account creation. Generous enough to not bother real
// users signing up a few times, tight enough to blunt scripted bulk-account
// creation / email enumeration via repeated registrations.
export const registerRateLimit = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Слишком много попыток регистрации. Попробуйте позже." },
});

// IP-based limiter for password-reset requests. This endpoint always returns
// a generic 200 response regardless of whether the account exists, so the
// main abuse vector is flooding the reset-token/email pipeline rather than
// enumeration — a stricter limit than login is appropriate.
export const forgotPasswordRateLimit = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "Слишком много запросов на сброс пароля. Попробуйте позже.",
  },
});

// Per-referral-code limiter for account creation. Complements the IP-based
// registerRateLimit: an attacker who rotates IPs but reuses one leaked referral
// code is still blocked. Keyed by normalised code so case/whitespace variants
// don't bypass the limit. Limit is intentionally tight (5/hour) because a
// legitimate inviter rarely hands the same code to more than a handful of
// people in a short window; the IP-based limit is the primary gate for
// normal traffic.
export const registerPerCodeRateLimit = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  limit: 5,
  keyGenerator: (req) => {
    const ref =
      typeof req.body?.ref === "string" ? req.body.ref.trim().toLowerCase() : "unknown";
    return `reg-code:${ref}`;
  },
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "Слишком много регистраций по этой реферальной ссылке. Попробуйте позже.",
  },
});

// IP-based limiter for the public, token-authenticated subscription endpoint
// (/api/sub/:token). This endpoint has no session/auth cookie by design (VPN
// client apps like Happ/v2rayNG fetch it directly), so its only line of
// defense against token brute-forcing or DB-load abuse is this limiter.
// Real clients only auto-refresh every SUBSCRIPTION_UPDATE_INTERVAL_HOURS
// (see subscription.ts), so this budget is generous enough for a user with
// several devices/apps polling independently, while still bounding how many
// distinct tokens a single IP can probe per window.
export const subscriptionRateLimit = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Слишком много запросов. Попробуйте позже." },
});
