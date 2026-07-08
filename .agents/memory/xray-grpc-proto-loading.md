---
name: Xray gRPC proto loading with protobufjs
description: How to correctly load Xray-core's .proto files with protobufjs when hand-rolling a gRPC client (no proto-loader/protoc), and how Xray's API inbound must be wired.
---

When loading Xray-core's own `.proto` files (command.proto, user.proto, etc.) with protobufjs's `Root.load()`, the default `resolvePath` resolves relative `import` statements against the *importing file's directory*, not against a shared include root. Xray's protos use include-root-relative imports (e.g. `app/proxyman/command/command.proto` does `import "common/protocol/user.proto"`, meaning relative to the proto root, not to its own `app/proxyman/command/` folder). Left unfixed, this produces `ENOENT` for a nonsensical concatenated path.

**Why:** protoc/proto-loader use explicit `includeDirs` for this; protobufjs has no such option built in and silently assumes origin-relative imports instead.

**How to apply:** override `root.resolvePath = (_origin, target) => path.join(PROTO_ROOT, target)` before calling `root.load([...])`, so every import resolves against the single shared proto root regardless of which file references it.

Separately: Xray's gRPC API works via a `dokodemo-door` inbound tagged (e.g.) `api`, with a routing rule sending `inboundTag: ["api"]` to `outboundTag: "api"` — no actual `api`-tagged outbound object is needed; Xray's core intercepts and handles it internally. This is easy to second-guess but is correct as-is.

When testing an Xray process from Replit's agent sandbox: background processes started with `&`/`nohup`/`setsid`/`disown` in one bash tool call do NOT survive into the next tool call — the sandbox reaps child processes at the end of each call regardless of detachment. Start the process and run the test that depends on it within the *same* bash invocation.

**Confirmed working (2026-07-08):** `app/stats/command/command.proto` (StatsService) is self-contained with zero cross-file imports, so it sidesteps the resolvePath problem entirely — load it with `@grpc/grpc-js` + `@grpc/proto-loader` normally. `QueryStats({ pattern: "user>>>", reset: true })` works end-to-end against a real Xray binary and returns real non-zero counters (stat names like `user>>>{email}>>>traffic>>>uplink`); `GetUsersStats` (newer RPC) returned UNIMPLEMENTED on the release binary tested — use `QueryStats` with pattern matching for per-user traffic, not `GetUsersStats`. Also: Xray's internal "email" tag used for stats attribution must be a value guaranteed unique per client (e.g. the client's own UUID), not a user-facing label — labels can collide across users/keys and corrupt attribution.
