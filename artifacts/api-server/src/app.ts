import express, { type Express, type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { mountStaticFrontend } from "./lib/staticServer";
import { getSessionSecret, startSessionCleanupJob } from "./lib/session";
import { corsOriginCheck } from "./lib/corsOrigins";
import { csrfCheck } from "./lib/csrf";
import { startSubscriptionExpiryJob } from "./lib/subscriptionLifecycle";
import { startTrafficPollingJob } from "./lib/trafficPolling";
import { startHourlyBillingJob } from "./lib/hourlyBilling";

const app: Express = express();

// Amvera's edge (Envoy) terminates TLS and forwards plain HTTP to the
// container over its internal network, adding an X-Forwarded-Proto header.
// Without trusting the proxy, req.protocol/req.secure would always report
// "http" even though the public-facing request was HTTPS — which would leak
// into things like the generated subscription URL.
//
// Trust exactly one hop (the Envoy edge itself), not `true` (any hop). This
// still lets req.protocol read X-Forwarded-Proto, but req.ip and any
// IP-based logic (e.g. rate limiting) only trust the immediate proxy's
// X-Forwarded-For entry, not an attacker-supplied chain of arbitrary length.
app.set("trust proxy", 1);

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(cors({ credentials: true, origin: corsOriginCheck }));
// Payment screenshots are uploaded as base64 JSON (see payments.ts), which
// inflates a photo to ~1.37x its size as JSON text. Express's default 100kb
// body limit rejected these with a 413 before the request ever reached the
// route handler.
//
// Amvera's edge (Traefik) also enforces its OWN hard request-body cap around
// 10MB, confirmed empirically (payloads >~10MB get rejected by the edge with
// its own JSON 413 before even reaching this app — amvera.yaml has no config
// knob to raise it). So our own limit here must stay comfortably below that,
// or requests just above our limit but under the edge's would get our JSON
// error while ones above the edge's get a less friendly one; keeping both
// close means the app is always the one answering. 8mb here pairs with the
// 5.5MB client-side file cap in payment-screenshot-upload.tsx (5.5 * 1.37 ~
// 7.5MB, leaving headroom under both this limit and the edge's ~10MB one).
app.use(express.json({ limit: "8mb" }));
app.use(express.urlencoded({ extended: true, limit: "8mb" }));
app.use(cookieParser(getSessionSecret()));

app.use("/api", csrfCheck);
app.use("/api", router);

// Global error handler: catches any unhandled exception thrown by route
// handlers and returns a sanitized 500 instead of letting Express default to
// leaking a stack trace in the response body.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  logger.error({ err }, "Unhandled route error");
  res.status(500).json({ error: "Internal server error" });
});

// In the all-in-one deployment, also serve the built frontend from this process.
// No-op when STATIC_DIR is unset (e.g. Replit dev).
mountStaticFrontend(app);

startSessionCleanupJob();
startSubscriptionExpiryJob();
startTrafficPollingJob();
startHourlyBillingJob();

export default app;
