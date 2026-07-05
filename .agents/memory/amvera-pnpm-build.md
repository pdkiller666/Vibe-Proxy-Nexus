---
name: Amvera build pnpm version pin
description: Why the root package.json pins packageManager to pnpm@10.x for the Amvera Docker build.
---

# Amvera Docker build: pin pnpm version

The Dockerfile runs `corepack enable` then `pnpm install --frozen-lockfile`. With **no** `packageManager` field in root `package.json`, corepack fetches the **latest** pnpm (was 11.10.0) inside the Amvera build, while Replit dev uses pnpm 10.x. pnpm 11 did **not** honor `onlyBuiltDependencies` from `pnpm-workspace.yaml` the same way, so it kept failing with `ERR_PNPM_IGNORED_BUILDS: @clerk/shared, esbuild`.

**Fix:** pin `"packageManager": "pnpm@10.26.1"` in root `package.json`. corepack then downloads that exact version and the `onlyBuiltDependencies` allowlist is respected — `@clerk/shared` and `esbuild` postinstall scripts run, build passes.

**Why:** deterministic builds require the same pnpm major across dev and CI/Docker; corepack defaults to latest otherwise.
**How to apply:** keep the pin in sync with the local dev pnpm major version; if you bump one, bump both.

# Build succeeds — remaining failures are runtime, not build

Once the build passes it ends with `Pushing image to harbor.waw.amverum.com/...`. If the deploy still doesn't come up, it's the **container entrypoint** (`deploy/amvera-all-in-one/entrypoint.sh`), which hard-requires these env vars set in the Amvera panel or it exits immediately: `REALITY_SNI`, `REALITY_PRIVATE_KEY`, `REALITY_SHORT_ID`, `DATABASE_URL`. For Clerk in the browser also need build arg `VITE_CLERK_PUBLISHABLE_KEY` + runtime `CLERK_SECRET_KEY`. That is a runtime/config problem, not a build problem.
