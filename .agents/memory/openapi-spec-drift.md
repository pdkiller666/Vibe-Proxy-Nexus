---
name: openapi.yaml spec drift (support tickets / device slots / trial) — resolved
description: Root cause and fix for a spec/implementation drift that blocked pnpm run build; lesson for avoiding it again.
---

**Resolved.** DB schema, backend routes, and frontend pages for support tickets, extra device-slot purchases, and trial-period payment settings were fully implemented, but `lib/api-spec/openapi.yaml` was never updated — and worse, `lib/api-client-react/src/generated/api.ts` had been hand-patched directly (manual section comments, ad-hoc inline types) instead of produced by orval, while `lib/api-zod/src/generated/api.ts` had *also* been hand-edited to add fields ahead of the spec. Both generated clients had silently diverged from `openapi.yaml` and from each other.

**Fix:** added the missing schemas/paths to `openapi.yaml` (matching the real DB/route shapes, including correct `required` arrays for NOT NULL DB columns), then ran `pnpm --filter @workspace/api-spec run codegen` to fully regenerate both clients from the spec, overwriting the hand-written stubs. Follow-up compile errors were mechanical: renaming imports where the operationId-derived name differed from what a hand-patched file had guessed (e.g. `UpdateUserDeviceSlots*` → `UpdateUserExtraSlots*`), and updating react-query mutate() call shapes to the generated `{ pathParam, data: {...} }` convention instead of a hand-rolled flat object.

**Why this matters:** never hand-edit files under any `generated/` directory (orval, or any other codegen). If implementation races ahead of the spec, the fix is always: edit `openapi.yaml` first, then regenerate — never patch the generated output directly, since it silently decouples the two API clients from each other and from the spec, and the gap only surfaces at full `pnpm run build` (dev servers skip typecheck).

**How to apply:** before adding a new endpoint/field to routes or frontend pages, add the OpenAPI schema entry first, run `pnpm --filter @workspace/api-spec run codegen`, then write the route/page code against the generated types.
