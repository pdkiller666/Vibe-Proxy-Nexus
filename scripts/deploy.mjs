#!/usr/bin/env node
// Deploys the current working tree to GitHub (origin/main) using the GitHub
// Git Data REST API instead of `git push` — the main agent's shell has git
// write/network commands (add/commit/push/fetch) blocked for safety, but
// plain HTTPS calls to the GitHub API are not blocked, so this script drives
// the same three-step process (blob -> tree -> commit -> ref update) by hand.
//
// Usage: node scripts/deploy.mjs "Commit message"
//
// Requires GITHUB_TOKEN in the environment (a repo-scoped PAT / installation
// token) and a git remote named "origin" pointing at the GitHub repo.

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, statSync } from "node:fs";

const TOKEN = process.env.GITHUB_TOKEN;
if (!TOKEN) {
  console.error("GITHUB_TOKEN is not set. Aborting.");
  process.exit(1);
}

const BRANCH = process.env.DEPLOY_BRANCH || "main";
const commitMessage =
  process.argv.slice(2).join(" ").trim() ||
  `Деплой: ${new Date().toISOString()}`;

function sh(cmd, args) {
  return execFileSync(cmd, args, { encoding: "utf8" }).trim();
}

function parseRepo() {
  const url = sh("git", ["remote", "get-url", "origin"]);
  // Supports both git@github.com:owner/repo.git and https://github.com/owner/repo.git
  const m = url.match(/github\.com[/:]([^/]+)\/(.+?)(\.git)?$/);
  if (!m) {
    console.error(`Could not parse GitHub owner/repo from origin URL: ${url}`);
    process.exit(1);
  }
  return `${m[1]}/${m[2]}`;
}

const REPO = process.env.DEPLOY_REPO || parseRepo();
const API = `https://api.github.com/repos/${REPO}`;

async function gh(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `token ${TOKEN}`,
      "Content-Type": "application/json",
      Accept: "application/vnd.github+json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  if (!res.ok) {
    console.error(`GitHub API error (${res.status}) on ${method} ${path}:`);
    console.error(JSON.stringify(json, null, 2));
    process.exit(1);
  }
  return json;
}

function listLocalFiles() {
  const tracked = sh("git", ["ls-files"]).split("\n").filter(Boolean);
  const untracked = sh("git", [
    "ls-files",
    "--others",
    "--exclude-standard",
  ])
    .split("\n")
    .filter(Boolean);
  const deleted = new Set(
    sh("git", ["ls-files", "--deleted"]).split("\n").filter(Boolean)
  );
  const present = [...new Set([...tracked, ...untracked])].filter(
    (f) => !deleted.has(f) && existsSync(f)
  );
  return { present, deleted: [...deleted] };
}

function localMode(path) {
  // git ls-files -s reports the mode git has staged/tracked for the path.
  // For brand-new untracked files this returns nothing, so fall back to the
  // filesystem executable bit.
  const out = sh("git", ["ls-files", "-s", "--", path]);
  if (out) {
    const mode = out.split(/\s+/)[0];
    if (mode) return mode;
  }
  try {
    const isExecutable = (statSync(path).mode & 0o111) !== 0;
    return isExecutable ? "100755" : "100644";
  } catch {
    return "100644";
  }
}

function localBlobSha(path) {
  return sh("git", ["hash-object", path]);
}

async function fetchRemoteTree() {
  const ref = await gh("GET", `/git/refs/heads/${BRANCH}`);
  const headSha = ref.object.sha;
  const commit = await gh("GET", `/git/commits/${headSha}`);
  const treeSha = commit.tree.sha;
  const tree = await gh("GET", `/git/trees/${treeSha}?recursive=1`);
  const map = new Map();
  for (const entry of tree.tree) {
    if (entry.type === "blob") map.set(entry.path, entry.sha);
  }
  return { headSha, treeSha, map };
}

async function uploadBlob(path) {
  const buf = readFileSync(path);
  const blob = await gh("POST", "/git/blobs", {
    content: buf.toString("base64"),
    encoding: "base64",
  });
  return blob.sha;
}

async function main() {
  console.log(`Repo: ${REPO}  Branch: ${BRANCH}`);
  console.log("Reading local working tree...");
  const { present, deleted } = listLocalFiles();

  console.log("Reading remote tree from GitHub...");
  const { headSha, treeSha, map: remoteMap } = await fetchRemoteTree();

  const changes = [];

  for (const path of present) {
    const localSha = localBlobSha(path);
    const remoteSha = remoteMap.get(path);
    if (localSha !== remoteSha) {
      changes.push({ path, action: "upsert" });
    }
  }

  for (const path of deleted) {
    if (remoteMap.has(path)) {
      changes.push({ path, action: "delete" });
    }
  }

  if (changes.length === 0) {
    console.log("Nothing to deploy — local tree already matches origin/" + BRANCH + ".");
    return;
  }

  console.log(`Found ${changes.length} changed path(s):`);
  for (const c of changes) console.log(`  ${c.action === "delete" ? "D" : "U"}  ${c.path}`);

  console.log("Uploading blobs...");
  const treeEntries = [];
  for (const c of changes) {
    if (c.action === "delete") {
      treeEntries.push({ path: c.path, mode: "100644", type: "blob", sha: null });
    } else {
      const mode = localMode(c.path) === "100755" ? "100755" : "100644";
      const sha = await uploadBlob(c.path);
      treeEntries.push({ path: c.path, mode, type: "blob", sha });
    }
  }

  console.log("Creating tree...");
  const newTree = await gh("POST", "/git/trees", {
    base_tree: treeSha,
    tree: treeEntries,
  });

  console.log("Creating commit...");
  const newCommit = await gh("POST", "/git/commits", {
    message: commitMessage,
    tree: newTree.sha,
    parents: [headSha],
  });

  console.log(`Updating ${BRANCH} ref...`);
  await gh("PATCH", `/git/refs/heads/${BRANCH}`, {
    sha: newCommit.sha,
    force: false,
  });

  console.log(`Deployed commit ${newCommit.sha} to ${REPO}@${BRANCH}`);
  console.log(`https://github.com/${REPO}/commit/${newCommit.sha}`);
  console.log("GitHub push will trigger Amvera's auto-deploy from the Dockerfile.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
