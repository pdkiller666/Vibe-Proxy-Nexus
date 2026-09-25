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

## Remote Reality nodes

**Rule:** Reality cannot run through Amvera's TLS-terminating ingress, so it
must use a separate external VPS with raw TCP. The product now intentionally
allows active Reality nodes in public location lists, normal user issuance,
least-loaded assignment, and automatic migration alongside WS. WS remains the
default transport for newly created nodes. Store the public key and short ID in
the database; keep the Reality private key on the VPS. Use TCP 443 for the
Reality listener.

The automatic Reality provisioner follows the existing production Management
API REST route on port 8443 and opens that port in UFW. The tested Reality VPS
uses port 8444 through a private SSH tunnel instead; do not assume those access
paths are equivalent. Verify the intended production route and firewall policy
before running provisioning on a live VPS.

**Why:** Amvera cannot pass the raw Reality handshake, while the product
requirement now explicitly includes normal-user assignment and migration.
Management API exposure remains an infrastructure boundary: a mismatch can
leave a node reachable for clients but unmanageable by the API.

**How to apply:** keep Reality on external raw-TCP VPS nodes, preserve WS as
the default, and allow configured Reality nodes through normal issuance and
migration. Before live provisioning, confirm Management API reachability and
firewall policy; do not reconfigure an existing test or production node as part
of a code-only change.

## Reality connection diagnosis

**Rule:** a client-side `dialing TCP` message or local TUN `accepted` entry
does not prove that a Reality connection reached the VPS. Correlate the test
time with server-side Xray logs and per-key counters. A `REALITY: processed
invalid connection` entry confirms a connection attempt reached Reality, but
not that the Reality handshake or VLESS authentication succeeded; a server-side
accepted VLESS entry or increasing per-key counters is stronger confirmation.

**Why:** mobile client logs can show retries without reporting the final
transport failure, while locally accepted TUN flows only show that the client
app captured traffic.

**How to apply:** record the test time, inspect Xray logs on the selected
remote node for that same interval, then check the selected key's counters
before changing Reality parameters or moving ports.
