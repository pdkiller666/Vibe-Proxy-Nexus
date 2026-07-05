---
name: Amvera cannot expose raw TCP (non-HTTP) ports via containerPort
description: containerPort in amvera.yml accepts a comma-separated port list, but Amvera's edge always terminates TLS itself on public 443 and forwards plain HTTP — confirmed this does not work for non-HTTP protocols like VLESS/Reality.
---

Amvera's dashboard config UI hints that `run.containerPort` accepts a
comma-separated list (e.g. `"5000,3000,80"`), suggesting multi-port exposure
might be possible without the paid "Dedicated IPv4" add-on.

**Tested and confirmed NOT to work** for raw/non-HTTP TCP protocols: setting
`containerPort: "8080,443"` so that Xray's VLESS-XTLS-Reality listener (443)
would be reachable alongside the web app (8080). External port 443 kept
answering with Amvera's own `*.<subdomain>.amvera.tech` Let's Encrypt
certificate regardless of the SNI sent (verified with direct `openssl
s_client` probes against both the app's own domain and the Reality mask
domain) — i.e. Amvera's edge terminates TLS itself on 443 for every app and
forwards plain HTTP behind the scenes, it does not do raw TCP passthrough.

**Why:** the multi-port list is for apps that expose multiple HTTP(S)
endpoints on different internal ports, not a general TCP passthrough
mechanism.

**How to apply:** any protocol that needs to own the raw TLS handshake
itself (Reality, raw VLESS/Trojan, custom TCP protocols) cannot go out
through `containerPort`. The only paths are: (1) Amvera's "Dedicated IPv4"
add-on / manual port mapping in the dashboard's networking settings (paid,
outside `amvera.yml`), or (2) hosting that specific service on infrastructure
that supports raw TCP (a separate VPS), keeping only the HTTP web/API on
Amvera.
