import express, { type Express } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { mountStaticFrontend } from "./lib/staticServer";
import { getSessionSecret, startSessionCleanupJob } from "./lib/session";

const app: Express = express();

// Amvera's edge (Envoy) terminates TLS and forwards plain HTTP to the
// container over its internal network, adding an X-Forwarded-Proto header.
// Without trusting the proxy, req.protocol/req.secure would always report
// "http" even though the public-facing request was HTTPS — which would leak
// into things like the generated subscription URL.
app.set("trust proxy", true);

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

app.use(cors({ credentials: true, origin: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser(getSessionSecret()));

app.use("/api", router);

// In the all-in-one deployment, also serve the built frontend from this process.
// No-op when STATIC_DIR is unset (e.g. Replit dev).
mountStaticFrontend(app);

startSessionCleanupJob();

export default app;
