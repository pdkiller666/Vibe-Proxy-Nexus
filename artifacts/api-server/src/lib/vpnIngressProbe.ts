import { randomBytes } from "node:crypto";
import { promises as dns } from "node:dns";
import https from "node:https";
import { isIP } from "node:net";
import type { TLSSocket } from "node:tls";
import { VPN_WS_PATH } from "./vless.js";

export type VpnIngressProbeStage =
  | "configuration"
  | "dns"
  | "connect"
  | "tls"
  | "ws_upgrade";

export interface VpnIngressProbeTarget {
  name: string;
  host: string | null;
  sni: string | null;
  port: number | null;
}

export interface VpnIngressProbeResult {
  ok: boolean;
  stage: VpnIngressProbeStage;
  elapsedMs: number;
  statusCode: number | null;
  error: string | null;
}

const PROBE_TIMEOUT_MS = 8_000;

function errorDetails(error: unknown): { code: string | null; message: string } {
  if (error instanceof Error) {
    const code = "code" in error && typeof error.code === "string" ? error.code : null;
    return { code, message: error.message.slice(0, 240) };
  }
  return { code: null, message: String(error).slice(0, 240) };
}

function failureStage(code: string | null, tlsEstablished: boolean): VpnIngressProbeStage {
  if (code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "ENODATA") return "dns";
  if (code?.startsWith("CERT_") || code?.startsWith("ERR_TLS_") || code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE") {
    return "tls";
  }
  return tlsEstablished ? "ws_upgrade" : "connect";
}

function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const parts = address.split(".").map(Number);
    const [a, b, c] = parts;
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
      return false;
    }
    if (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b! >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b! >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19 || b === 51 && c === 100)) ||
      (a === 203 && b === 0 && c === 113) ||
      (a === 192 && b === 0 && c === 2) ||
      a! >= 224
    ) {
      return false;
    }
    return true;
  }

  if (family === 6) {
    const normalized = address.toLowerCase().split("%")[0] ?? "";
    if (normalized.startsWith("::ffff:")) return false;
    const firstHextet = Number.parseInt(normalized.split(":")[0] ?? "", 16);
    return firstHextet >= 0x2000 && firstHextet <= 0x3fff && !normalized.startsWith("2001:db8:");
  }

  return false;
}

async function resolveProbeAddress(
  host: string,
  timeoutMs: number,
): Promise<{ address: string; family: 4 | 6 }> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    const addresses = await Promise.race([
      dns.lookup(host, { all: true, verbatim: true }),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("DNS lookup timed out")), timeoutMs);
      }),
    ]);
    const publicAddresses = addresses.filter((entry) => isPublicAddress(entry.address));
    if (publicAddresses.length === 0 || publicAddresses.length !== addresses.length) {
      throw new Error("Target resolves to a non-public address; probe refused");
    }
    const selected = publicAddresses[0]!;
    return { address: selected.address, family: selected.family as 4 | 6 };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/**
 * Sends a TLS-verified WebSocket upgrade to the node's configured public
 * ingress. A 101 proves only that the public WS endpoint accepts upgrades; it
 * does not prove VLESS authentication or VPN data transfer.
 */
export async function probeVpnWsIngress(
  target: VpnIngressProbeTarget,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<VpnIngressProbeResult> {
  const host = target.host?.trim() || target.sni?.trim() || "";
  const servername = target.sni?.trim() || host;
  const port = target.port ?? 443;

  if (
    !host ||
    !servername ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535 ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0
  ) {
    return Promise.resolve({
      ok: false,
      stage: "configuration",
      elapsedMs: 0,
      statusCode: null,
      error: "Missing or invalid WS host, SNI, port, or timeout",
    });
  }

  const startedAt = Date.now();
  let resolvedAddress: { address: string; family: 4 | 6 };
  try {
    resolvedAddress = await resolveProbeAddress(host, timeoutMs);
  } catch (error) {
    const details = errorDetails(error);
    const stage = details.code === "ENOTFOUND" || details.code === "EAI_AGAIN" || details.code === "ENODATA"
      ? "dns"
      : "configuration";
    return {
      ok: false,
      stage,
      elapsedMs: Date.now() - startedAt,
      statusCode: null,
      error: `${details.code ? `${details.code}: ` : ""}${details.message}`,
    };
  }

  return new Promise((resolve) => {
    let settled = false;
    let tlsEstablished = false;
    let timeout: NodeJS.Timeout | undefined;

    const finish = (result: Omit<VpnIngressProbeResult, "elapsedMs">) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      resolve({ ...result, elapsedMs: Date.now() - startedAt });
    };

    const request = https.request({
      hostname: resolvedAddress.address,
      family: resolvedAddress.family,
      port,
      path: VPN_WS_PATH,
      method: "GET",
      servername,
      rejectUnauthorized: true,
      agent: false,
      headers: {
        Host: servername,
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": randomBytes(16).toString("base64"),
      },
    });

    request.once("socket", (socket) => {
      (socket as TLSSocket).once("secureConnect", () => {
        tlsEstablished = true;
      });
    });

    request.once("upgrade", (response, socket) => {
      const statusCode = response.statusCode ?? 0;
      if (statusCode === 101) {
        finish({ ok: true, stage: "ws_upgrade", statusCode, error: null });
      } else {
        finish({
          ok: false,
          stage: "ws_upgrade",
          statusCode,
          error: `HTTP ${statusCode || "unknown"} during WebSocket upgrade`,
        });
      }
      socket.destroy();
    });

    request.once("response", (response) => {
      const statusCode = response.statusCode ?? 0;
      response.resume();
      finish({
        ok: false,
        stage: "ws_upgrade",
        statusCode,
        error: `HTTP ${statusCode || "unknown"} instead of WebSocket 101`,
      });
      response.socket?.destroy();
    });

    request.once("error", (error: NodeJS.ErrnoException) => {
      const details = errorDetails(error);
      finish({
        ok: false,
        stage: failureStage(details.code, tlsEstablished),
        statusCode: null,
        error: `${details.code ? `${details.code}: ` : ""}${details.message}`,
      });
    });

    timeout = setTimeout(() => {
      request.destroy(new Error(`Probe timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    request.end();
  });
}