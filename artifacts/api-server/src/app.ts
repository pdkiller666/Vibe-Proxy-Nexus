import express, { type Express } from "express";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { mountStaticFrontend } from "./lib/staticServer";
import { getSessionSecret, startSessionCleanupJob } from "./lib/session";
import { corsOriginCheck } from "./lib/corsOrigins";
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
// inflates a ~10MB photo to ~13-14MB of JSON text. Express's default 100kb
// body limit rejected these with a 413 before the request ever reached the
// route handler. Cap at 15mb here to match the 10MB client-side file limit
// enforced in payment-screenshot-upload.tsx (base64 + JSON overhead ~37%).
app.use(express.json({ limit: "15mb" }));
app.use(express.urlencoded({ extended: true, limit: "15mb" }));
app.use(cookieParser(getSessionSecret()));

app.use("/api", router);

// In the all-in-one deployment, also serve the built frontend from this process.
// No-op when STATIC_DIR is unset (e.g. Replit dev).
mountStaticFrontend(app);

startSessionCleanupJob();
startSubscriptionExpiryJob();
startTrafficPollingJob();
startHourlyBillingJob();

export default app;
