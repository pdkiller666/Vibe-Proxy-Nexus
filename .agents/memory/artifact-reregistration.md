---
name: Artifact re-registration on re-import
description: What to do when a re-imported repo has valid artifact.toml files on disk but listArtifacts() is empty and the shared proxy 502s.
---

On a re-imported repo, the platform can lose artifact registration even though `.replit-artifact/artifact.toml` files and source code are fully intact on disk. Symptoms: `listArtifacts()` returns empty, `WorkflowsRestart` can't find the expected managed workflow names, and the root shared proxy 502s.

**Do not** work around this with manual `configureWorkflow` calls — ad-hoc workflows run fine standalone but are never wired into the path-based proxy, so `localhost:80/<path>` keeps 502ing.

**Fix:** call `createArtifact` for just one of the missing artifacts (matching its existing slug/previewPath/kind). This triggers a platform reconciliation pass that also auto-detects and re-registers *other* pre-existing-but-unregistered `artifact.toml` files in the repo as a side effect — confirmed re-registering 3 artifacts (web, api, design) from one `createArtifact` call.

**Caveat:** `createArtifact` scaffolds a fresh placeholder app into the target directory (default boilerplate `App.tsx`/`index.css`/etc.), overwriting real source there. Move the real source directory aside first (e.g. to `/tmp`), let `createArtifact` finish, then restore the real source back in — but keep the newly generated `.replit-artifact/artifact.toml` (or merge it), not the placeholder code.

**Why:** the registration/reconciliation step and the file-scaffolding step are coupled inside `createArtifact`; there's no lighter-weight "just register" call.

**How to apply:** any time a re-imported or forked repl has working artifact source on disk but `listArtifacts()`/proxy routing don't reflect it.
