---
name: drizzle-kit push --force still prompts on rename ambiguity
description: Why prod schema can silently fall behind dev even though the boot script runs drizzle-kit push --force, and the fix pattern.
---

## Symptom
App code (built from latest schema) throws `column "x" does not exist` / `Failed query` in production, even though:
- The same migration was already applied cleanly in dev.
- The Amvera entrypoint runs `drizzle-kit push --force` on every boot with stdin closed (`< /dev/null`) specifically to avoid interactive hangs.

## Root cause
When a single push both drops a column and adds one or more new columns to the same table (e.g. renaming `screenshot_url` into `screenshot_data` + `screenshot_mime_type`), drizzle-kit can't automatically decide whether this is a rename or a drop+add. It emits an interactive "is this a rename?" prompt to resolve the ambiguity. **`--force` does not skip this prompt** — it only skips the separate "this is destructive, are you sure?" confirmation. With stdin closed, the prompt has nothing to read, the process exits/hangs, and the background push job fails silently (the entrypoint only logs a WARNING, it doesn't block startup). Result: prod schema never catches up, indefinitely, until someone notices runtime errors.

**Why:** drizzle-kit's rename-detection heuristic requires a human decision when both a drop and an add appear in one diff; there is no CLI flag to force "always treat as drop+add" non-interactively as of drizzle-kit 0.31.x.

## Fix pattern
Add a dedicated idempotent raw-SQL "heal" step that runs **before** `drizzle-kit push` in the boot sequence, using plain `ALTER TABLE ... ADD COLUMN IF NOT EXISTS ...` statements for any migration known to trigger this ambiguity. Plain DDL like this has no ambiguity to resolve, so it never prompts, and it's safe to run on every boot (no-op once applied). See `deploy/amvera-all-in-one/heal-schema.mjs`, wired into `deploy/amvera-all-in-one/entrypoint.sh` ahead of the drizzle-kit push call.

**How to apply:** whenever a future schema change involves dropping a column while adding differently-named ones on the same table in the same commit, add a corresponding `ADD COLUMN IF NOT EXISTS` line to the heal script rather than relying solely on `drizzle-kit push --force` to carry it to prod. Keep the heal script append-only (one line per historical ambiguous change) — don't remove old entries, they stay harmless no-ops.
