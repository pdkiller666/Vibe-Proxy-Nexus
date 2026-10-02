#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { appendFile } from "node:fs/promises";
import https from "node:https";
import { isIP } from "node:net";

const DEFAULT_API_URL = "https://vpnexus.pro/api/vpn-nodes";
const WS_PATH = "/vpnws";
const TIMEOUT_MS = 8_000;

function safeCell(value) {
  return String(value ?? "").replaceAll("|", "\\|").replaceAll("\n", " ").trim();
}

function describeError(error) {
  const code = typeof error?.code === "string" ? error.code : null;
  const message = error instanceof Error ? error.message : String(error);
  return { code, message: message.slice(0, 240) };
}

function classifyError(code, tlsEstablished) {
  if (["ENOTFOUND", "EAI_AGAIN", "ENODATA"].includes(code)) return "dns";
  if (code?.startsWith("CERT_") || code?.startsWith("ERR_TLS_") || code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE") return "tls";
  return tlsEstablished ? "ws_upgrade" : "connect";
}

function isPublicAddress(address) {
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
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113) ||
      (a === 192 && b === 0 && c === 2) ||
      a >= 224
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

async function resolvePublicAddress(host) {
  const addresses = await lookup(host, { all: true, verbatim: true });
  const publicAddresses = addresses.filter((entry) => isPublicAddress(entry.address));
  if (publicAddresses.length === 0 || publicAddresses.length !== addresses.length) {
    throw new Error(`Target ${host} resolves to a non-public address; probe refused`);
  }
  return publicAddresses[0];
}

function probeNode(node) {
  const host = typeof node.host === "string" && node.host.trim()
    ? node.host.trim()
    : typeof node.sni === "string" ? node.sni.trim() : "";
  const servername = typeof node.sni === "string" && node.sni.trim()
    ? node.sni.trim()
    : host;
  const port = node.port ?? 443;
  const name = typeof node.name === "string" && node.name.trim() ? node.name.trim() : host;

  if (!host || !servername || !Number.isInteger(port) || port < 1 || port > 65_535) {
    return Promise.resolve({
      name,
      host,
      ok: false,
      stage: "configuration",
      statusCode: null,
      elapsedMs: 0,
      error: "Missing or invalid WS host, SNI, or port",
    });
  }

  const startedAt = Date.now();
  return resolvePublicAddress(host).then((resolvedAddress) => new Promise((resolve) => {
    let settled = false;
    let tlsEstablished = false;
    let timeout;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ name, host, ...result, elapsedMs: Date.now() - startedAt });
    };

    const request = https.request({
      hostname: resolvedAddress.address,
      family: resolvedAddress.family,
      port,
      path: WS_PATH,
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
      socket.once("secureConnect", () => {
        tlsEstablished = true;
      });
    });

    request.once("upgrade", (response, socket) => {
      const statusCode = response.statusCode ?? 0;
      finish({
        ok: statusCode === 101,
        stage: "ws_upgrade",
        statusCode,
        error: statusCode === 101 ? null : `HTTP ${statusCode || "unknown"} during WS upgrade`,
      });
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

    request.once("error", (error) => {
      const details = describeError(error);
      finish({
        ok: false,
        stage: classifyError(details.code, tlsEstablished),
        statusCode: null,
        error: `${details.code ? `${details.code}: ` : ""}${details.message}`,
      });
    });

    timeout = setTimeout(() => request.destroy(new Error(`Probe timed out after ${TIMEOUT_MS}ms`)), TIMEOUT_MS);
    request.end();
  })).catch((error) => ({
    name,
    host,
    ok: false,
    stage: "dns",
    statusCode: null,
    elapsedMs: Date.now() - startedAt,
    error: error instanceof Error ? error.message.slice(0, 240) : String(error).slice(0, 240),
  }));
}

async function main() {
  const apiUrl = process.env.VPN_INGRESS_API_URL?.trim() || DEFAULT_API_URL;
  const parsedUrl = new URL(apiUrl);
  if (parsedUrl.protocol !== "https:") {
    throw new Error("VPN_INGRESS_API_URL must use HTTPS");
  }

  const response = await fetch(parsedUrl, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`Public node inventory returned HTTP ${response.status}`);
  const inventory = await response.json();
  if (!Array.isArray(inventory)) throw new Error("Public node inventory was not an array");

  const nodes = inventory.filter((node) => node?.isActive === true && node.transport === "ws");
  if (nodes.length === 0) throw new Error("No active WS nodes were returned by the public node inventory");

  const results = await Promise.all(nodes.map(probeNode));
  const failed = results.filter((result) => !result.ok);

  console.log(JSON.stringify({
    checkedAt: new Date().toISOString(),
    source: "github-actions",
    inventoryUrl: parsedUrl.origin + parsedUrl.pathname,
    results,
  }, null, 2));

  if (process.env.GITHUB_STEP_SUMMARY) {
    const rows = results.map((result) =>
      `| ${safeCell(result.name)} | ${safeCell(result.host)} | ${result.ok ? "OK" : "FAIL"} | ${safeCell(result.stage)} | ${result.statusCode ?? "—"} | ${result.elapsedMs} ms | ${safeCell(result.error ?? "—")} |`
    );
    const summary = [
      "## Public VPN WS ingress probe",
      "",
      `Source: GitHub Actions · ${new Date().toISOString()}`,
      "",
      "| Node | Host | Result | Stage | HTTP | Time | Details |",
      "|---|---|---:|---|---:|---:|---|",
      ...rows,
      "",
      "HTTP 101 confirms only TLS + WebSocket upgrade, not VLESS authentication or VPN traffic.",
      "",
    ].join("\n");
    await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
  }

  if (failed.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});