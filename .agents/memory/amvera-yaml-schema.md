---
name: Amvera amvera.yaml real schema
description: The authoritative field list for amvera.yaml's run/build sections — avoids repeating invalid-field deploy failures.
---

`amvera.yaml` has exactly three top-level sections: `meta`, `build`, `run`.

- `build` only supports `dockerfile` and `skip`. Nothing else — no `ports`, no `env`.
- `run` supports: `image`, `command`, `args` (string, not array), `containerPort` (single integer, default 80), `persistenceMount` (default `/data`). There is **no `env` key** and **no `ports` (list) key** — both are silently/loudly rejected as "unknown fields", even though many plausible-looking variants (plain list, `{number, protocol}` objects) seem reasonable.

**Why this matters:** a deploy with an invalid field can still show "Container builder has completed with exit code: 0" and "Pushed image" in the *build* log — the Docker image builds and pushes fine. The "Configuration error: unknown fields" only shows up in the separate *app/runtime* log, so a clean build log does NOT mean the config is valid. Always check the app log (not just build log) after a deploy touching amvera.yaml.

**How to apply:** if you need more than one exposed port (e.g. a web port + a raw TCP VPN port), only one (`containerPort`) can be routed via the public Amvera domain through amvera.yaml. Any additional raw TCP port must be exposed through Amvera's dashboard networking settings ("Dedicated IPv4" add-on), not through amvera.yaml — there is no YAML-level multi-port mechanism.

Env vars always go in the Amvera dashboard's "Configuration"/"Переменные" tab, never in amvera.yaml.
