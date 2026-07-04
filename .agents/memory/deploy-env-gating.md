---
name: All-in-one deploy env gating
description: Why production-only backend behaviors are gated behind env vars, and which gates exist
---

The api-server has behaviors that must ONLY run in the all-in-one Amvera container,
never in Replit dev. They are gated behind env vars that are unset in dev:

- `STATIC_DIR` — when set, Express also serves the built React SPA (static + SPA
  fallback) from the same process. Unset in dev, where Vite serves the frontend.
- `XRAY_CONFIG_PATH` — when set, the key-issuance route edits the local Xray
  config on disk and reloads via `supervisorctl restart xray`. Unset in dev, where
  keys are generated locally but not connectable.

**Why:** the app is developed on Replit but deployed as one container to Amvera.
Gating keeps a single codebase working in both places without a build-time split.

**How to apply:** any new behavior that only makes sense when co-located with Xray
or when serving static frontend must be gated the same way (check the env var,
no-op if unset). Do not assume the container topology in shared code paths.
