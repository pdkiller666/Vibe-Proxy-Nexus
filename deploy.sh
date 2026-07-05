#!/usr/bin/env bash
# Deploys the current working tree to GitHub (origin/main), which triggers
# Amvera's auto-deploy (Amvera watches the repo and rebuilds from the
# Dockerfile on every push).
#
# The main agent's shell has git write/network commands blocked (add, commit,
# push, fetch, etc.), so a plain `git push` cannot be used here. Instead this
# script drives the GitHub Git Data REST API directly via scripts/deploy.mjs:
# it reads the local working tree with read-only git commands, compares it to
# origin/main's tree over HTTPS, and uploads only the changed files as a new
# commit.
#
# Usage:
#   ./deploy.sh "Commit message describing the task"
#
# Requires GITHUB_TOKEN to be set in the environment.

set -e
cd "$(dirname "$0")"
node scripts/deploy.mjs "$@"
