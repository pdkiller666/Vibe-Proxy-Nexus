import http from "http";
import net from "net";
import app from "./app";
import { logger } from "./lib/logger";
import { seedDefaultAdmin } from "./lib/seedAdmin";
import { VPN_WS_PATH } from "./lib/vless";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// Local Xray WebSocket inbound (see deploy/amvera-all-in-one/xray-config.json.template).
// Amvera's edge (Traefik) terminates TLS and forwards the HTTP/WebSocket upgrade
// to this Node process; we relay the upgrade to Xray so VLESS rides on a normal
// HTTPS/WebSocket tunnel (see lib/vless.ts for why raw-TCP VLESS doesn't work).
const XRAY_WS_PORT = 10000;
const XRAY_WS_HOST = "127.0.0.1";

const server = http.createServer(app);

server.on("upgrade", (req, socket, head) => {
  const pathOnly = (req.url ?? "").split("?")[0];

  if (pathOnly !== VPN_WS_PATH) {
    socket.destroy();
    return;
  }

  const upstream = net.connect(XRAY_WS_PORT, XRAY_WS_HOST, () => {
    const headerLines: string[] = [];
    const raw = req.rawHeaders;
    for (let i = 0; i < raw.length; i += 2) {
      headerLines.push(`${raw[i]}: ${raw[i + 1]}`);
    }

    upstream.write(
      `${req.method} ${req.url} HTTP/1.1\r\n${headerLines.join("\r\n")}\r\n\r\n`,
    );
    if (head && head.length > 0) {
      upstream.write(head);
    }

    socket.pipe(upstream);
    upstream.pipe(socket);
  });

  const cleanup = () => {
    socket.destroy();
    upstream.destroy();
  };

  upstream.on("error", cleanup);
  socket.on("error", cleanup);
});

server.on("error", (err) => {
  logger.error({ err }, "Error listening on port");
  process.exit(1);
});

server.listen(port, () => {
  logger.info({ port }, "Server listening");

  // Fire-and-forget: never block startup on the DB. If it's briefly
  // unreachable at boot, this just logs and does nothing — same as the
  // background schema push.
  void seedDefaultAdmin();
});
