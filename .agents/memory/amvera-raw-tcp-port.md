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
