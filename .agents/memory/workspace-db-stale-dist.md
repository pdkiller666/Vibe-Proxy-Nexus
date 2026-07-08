---
name: pnpm workspace — lib/db has stale compiled dist/ despite source exports
description: Why editing lib/db/src/schema can still fail downstream tsc typechecks until dist/ is rebuilt.
---

`lib/db/package.json` exports point at `./src/*.ts` (no build step needed to
*run* it — it's consumed as TS source). But `lib/db/tsconfig.json` is
`composite: true` with `emitDeclarationOnly`, and it has a checked-in
`dist/` with `.d.ts` files from a previous build. Downstream packages
(e.g. `artifacts/api-server`) reference `lib/db` as a TS project reference,
and `tsc -p .` (without `-b`) resolves that reference through the
**compiled `dist/*.d.ts`**, not the live `src/*.ts` — so a schema column
added in `src/schema/*.ts` throws `TS2339: Property does not exist` in
every downstream consumer until `dist/` is regenerated.

**Why:** composite project references are declaration-file based by
design; `tsc --noEmit -p .` on a downstream package doesn't rebuild
upstream references automatically the way `tsc -b` would.

**How to apply:** after editing anything under `lib/db/src/schema/`,
run `pnpm --filter @workspace/db exec tsc -p .` to refresh `dist/*.d.ts`
before typechecking or trusting errors in packages that depend on it.
