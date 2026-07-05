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
