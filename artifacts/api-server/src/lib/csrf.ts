import type { RequestHandler } from "express";

// Explicit CSRF defence: state-changing browser requests must originate from
// the same host as the API itself. This is a second, independent line behind
// cors() + sameSite:lax — if either of those is ever misconfigured, this
// still blocks cross-site state mutations.
//
// Requests with no Origin header are always allowed: same-origin navigation,
// curl, VPN client apps fetching /sub/:token, FreeKassa server-side webhooks,
// and other non-browser callers never send Origin.
//
// GET / HEAD / OPTIONS are safe methods and are always allowed.
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export const csrfCheck: RequestHandler = (req, res, next) => {
  if (SAFE_METHODS.has(req.method)) {
    next();
    return;
  }

  const origin = req.get("Origin");
  if (!origin) {
    // No browser cross-origin context — allow (curl, webhooks, server-side).
    next();
    return;
  }

  // req.get("Host") is set by Amvera's Envoy edge from the original Host
  // header, and we trust exactly one proxy hop (app.set("trust proxy", 1)),
  // so this value cannot be spoofed by a downstream attacker.
  const expectedOrigin = `${req.protocol}://${req.get("Host")}`;

  if (origin !== expectedOrigin) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  next();
};
