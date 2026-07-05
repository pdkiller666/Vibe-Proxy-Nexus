import type { CorsOptions } from "cors";

// All legitimate browser traffic to this API is same-origin: the frontend
// calls relative `/api/*` paths (see lib/api-client-react/custom-fetch.ts),
// and in both the Replit dev proxy and the Amvera all-in-one deployment the
// frontend and API are reached through the same public host. Browsers never
// apply CORS checks to same-origin requests, so those requests are
// unaffected by anything below.
//
// This allowlist only matters for genuinely cross-origin, credentialed
// browser requests (e.g. a future admin dashboard hosted on another domain).
// Configure it via a comma-separated CORS_ORIGIN env var when that's needed;
// by default nothing extra is allowed.
const extraAllowedOrigins = (process.env.CORS_ORIGIN ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

export const corsOriginCheck: CorsOptions["origin"] = (origin, callback) => {
  // No Origin header means the request isn't a cross-origin browser request
  // (same-origin navigation, curl, VPN client apps fetching the subscription
  // URL, server-to-server calls) — always allow.
  if (!origin) {
    callback(null, true);
    return;
  }

  callback(null, extraAllowedOrigins.includes(origin));
};
