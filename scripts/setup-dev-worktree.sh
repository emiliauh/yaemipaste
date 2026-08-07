#!/usr/bin/env bash
set -euo pipefail

DEV_DIR="${1:-../yaemipaste-ui-dev}"
PROD_BRANCH="production"
DEV_BRANCH="development"

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "Run this inside the repository root." >&2
  exit 1
fi

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Working tree is not clean. Commit or stash changes first." >&2
  exit 1
fi

current_branch="$(git rev-parse --abbrev-ref HEAD)"
if ! git show-ref --verify --quiet "refs/heads/${PROD_BRANCH}"; then
  if [[ "$current_branch" != "main" && "$current_branch" != "$PROD_BRANCH" ]]; then
    echo "Create '${PROD_BRANCH}' from a stable baseline (main/production). Current: '${current_branch}'." >&2
    exit 1
  fi
  git branch "$PROD_BRANCH"
fi

if ! git ls-remote --exit-code --heads origin "$PROD_BRANCH" >/dev/null 2>&1; then
  git push origin "$PROD_BRANCH"
fi

if [[ -d "$DEV_DIR" ]]; then
  echo "Directory '$DEV_DIR' already exists."
  exit 0
fi

if git show-ref --verify --quiet "refs/heads/${DEV_BRANCH}"; then
  git worktree add "$DEV_DIR" "$DEV_BRANCH"
else
  git worktree add "$DEV_DIR" -b "$DEV_BRANCH"
  if ! git ls-remote --exit-code --heads origin "$DEV_BRANCH" >/dev/null 2>&1; then
    git push -u origin "$DEV_BRANCH"
  fi
fi

echo "Created development worktree at '$DEV_DIR' on branch '$DEV_BRANCH'."
