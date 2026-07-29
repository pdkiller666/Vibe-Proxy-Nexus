import pino from "pino";

const isProduction = process.env.NODE_ENV === "production";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: [
    "req.headers.authorization",
    "req.headers.cookie",
    "res.headers['set-cookie']",
  ],
  // Amvera's log viewer collapses nested JSON fields, so a log entry like
  // `{ err: { code: "EACCES", message: "..." } }` only shows the outer `msg`
  // — the actual cause is invisible without fetching raw log JSON separately.
  //
  // `formatters.log` runs before serialization and receives the raw merged
  // object. We use it to hoist `err.code` → `errCode` and `err.message` →
  // `errMsg` as true top-level siblings of `msg`, so Amvera's UI shows them
  // as plain readable columns without any manual JSON parsing.
  //
  // Note: pino `serializers` only *transform* the value of the keyed field;
  // they do NOT flatten the result into the top level. `formatters.log` is
  // the only pino mechanism that can add new top-level keys.
  formatters: {
    log(object: Record<string, unknown>): Record<string, unknown> {
      const err = object["err"];
      if (err == null || typeof err !== "object") {
        return object;
      }
      const e = err as Record<string, unknown>;
      const hoisted: Record<string, unknown> = {};
      if (typeof e["code"] === "string" && e["code"]) {
        hoisted["errCode"] = e["code"];
      }
      const message =
        typeof e["message"] === "string"
          ? e["message"]
          : err instanceof Error
            ? err.message
            : undefined;
      if (message !== undefined) {
        hoisted["errMsg"] = message;
      }
      return { ...object, ...hoisted };
    },
  },
  // Use pino's standard error serializer so the `err` field itself is still
  // a clean { type, message, stack, code } object (not "[object Error]").
  serializers: {
    err: pino.stdSerializers.err,
  },
  ...(isProduction
    ? {}
    : {
        transport: {
          target: "pino-pretty",
          options: { colorize: true },
        },
      }),
});
