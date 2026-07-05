---
name: Amvera cannot expose raw TCP (non-HTTP) ports — confirmed for both containerPort and the "TCP domain" (MONGO/POSTGRES/REDIS) feature
description: Amvera's edge always terminates TLS itself with its own Let's Encrypt certificate and forwards decrypted traffic — true for the plain HTTP(S) controller AND for the dashboard's "TCP domain" connection-type feature. Confirmed this breaks VLESS-Reality.
---

Amvera's dashboard config UI hints that `run.containerPort` accepts a
comma-separated list (e.g. `"5000,3000,80"`), suggesting multi-port exposure
might be possible without the paid "Dedicated IPv4" add-on. Amvera docs also
describe a "TCP domain" feature: attaching a domain with connection type
MONGO/POSTGRES/REDIS on a fixed external port (5432/27017/6379), described
as SNI-based routing "without TLS termination" (as opposed to the HTTP(S)
controller, which always terminates TLS).

**Tested and confirmed NOT to work for either mechanism:**

1. `containerPort: "8080,443"` (web app + Reality on 443 sharing one
   container) — external 443 still answers with Amvera's own domain
   certificate regardless of SNI.
2. Dashboard "TCP domain" with connection type MONGO, external port 27017,
   pointed at a `tcp-waw0.amvera.tech` subdomain — `openssl s_client`
   against `host:27017` still completes a full TLS handshake and returns a
   valid Let's Encrypt certificate for `*.tcp-waw0.amvera.tech`. A raw
   non-TLS byte probe (plain TCP, no ClientHello) gets silently swallowed
   (no response, no error) rather than forwarded — confirming the edge is
   parsing/terminating TLS, not blindly relaying bytes to the container.

**Why:** despite the "TCP domain" naming and docs implying passthrough,
Amvera's edge appears to terminate TLS for every public port/domain it
manages using its own certs. There is no product path (short of the paid
Dedicated IPv4 add-on) that delivers an unmodified TLS ClientHello to the
container.

**How to apply:** any protocol that must own the raw TLS handshake itself
(Reality, raw VLESS/Trojan, custom TCP protocols) cannot be exposed through
Amvera's shared free networking — neither via `containerPort` nor via the
"TCP domain" feature. Viable paths going forward: (1) Dedicated IPv4 add-on
(paid), (2) host that one service on separate infra with real TCP access,
keeping only the HTTP web/API on Amvera, or (3) switch the VPN transport to
something that tolerates edge TLS termination — e.g. VLESS over WebSocket
with TLS handled by Amvera's own cert (client TLS terminates at Amvera,
plaintext WS forwarded to the container) — trading away Reality's
active-probing resistance for actually working within Amvera's free tier.

---

## RESOLVED — VLESS over WebSocket through the HTTP(S) web domain works

Confirmed end-to-end working solution (tunnel verified: traffic exits from
the Amvera node IP, not the client IP):

- **Two DIFFERENT edges.** The `waw0.amvera.tech` web domain is fronted by
  **Envoy** (`server: envoy`, HTTP/2), NOT Traefik. The `tcp-waw0.amvera.tech`
  TCP domain is fronted by **Traefik**. Both terminate TLS.
- **Raw-TCP VLESS over the Traefik TCP domain fails**: Traefik treats the
  TLS-terminated stream as HTTP (via ALPN) and returns plaintext, corrupting a
  raw VLESS payload (client sees TLS "wrong version number" / connection reset).
  `acceptProxyProtocol` does not fix it.
- **VLESS + WebSocket over the Envoy web domain WORKS.** WS is a legitimate
  HTTP upgrade, so Envoy forwards it. Architecture: Xray runs a VLESS+WS inbound
  on container-internal loopback (127.0.0.1:10000, security "none",
  wsSettings.path=`/vpnws`); the Node/Express server does `http.createServer`
  and, on the `upgrade` event for that path, raw-pipes the socket to Xray. One
  public port (8080) serves web + API + VPN. Client link:
  `type=ws&security=tls&sni=<web domain>&host=<web domain>&path=/vpnws&encryption=none`.
  Both `fp=chrome` (ALPN h2,http/1.1) and forced `alpn=http/1.1` connect fine.
- **Why:** protocols that look like normal HTTPS (WS upgrade, XHTTP) ride
  through TLS-terminating edges; anything needing raw TLS or raw TCP does not.

**Amvera build latency:** a `./deploy.sh` push can take up to ~8 minutes to go
live (full Docker image: Vite + xray download + node build), and the old
container keeps serving until it does. Do not judge a change from a timed wait
alone — confirm the live build with a deterministic marker (a temporary endpoint
returning a known string, or the served vless-link format) before any prod test.
