---
name: Always check deploy state before trusting production matches code
description: Merged/implemented code can sit undeployed to Amvera indefinitely — always verify prod schema/behaviour matches HEAD before treating a feature as live.
---

## Rule
Before verifying any feature against production, run `node scripts/deploy.mjs --dry-run` (or `git log origin/main..HEAD --oneline`) to confirm there are no undeployed commits. If there are pending commits, deploy first, wait for Amvera to rebuild (~3–8 min), then verify.

**Why:** Amvera auto-builds only on `git push`. Task-agent merges land in the local repo but never push automatically. A feature can be "implemented and merged" in the codebase while production is still running old code — causing spurious verification failures that look like bugs in the implementation.

**How to apply:**
- Before any production verification step, check `git status` and `git log origin/main..HEAD`.
- Deploy via `./deploy.sh "message"` (the main agent's shell blocks raw `git push`).
- After deploy, wait for schema migration: `entrypoint.sh` runs `drizzle-kit push --force` in the background on every boot with up to 150s timeout — new columns appear in DB only after this completes.
- The external TCP Postgres hostname for out-of-cluster verification is provided by the user (not in the repo); the internal CNPG hostname is unreachable from Replit. See `amvera-prod-db-unreachable-from-sandbox.md`.
