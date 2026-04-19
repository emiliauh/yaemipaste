#!/usr/bin/env bash
set -euo pipefail

ORIGIN_REMOTE="${1:-origin}"
PRIVATE_REMOTE="${2:-}"
SOURCE_BRANCH="development"
TARGET_BRANCH="production"

current_branch="$(git rev-parse --abbrev-ref HEAD)"
if [[ "$current_branch" != "$SOURCE_BRANCH" ]]; then
  echo "Run this script from '$SOURCE_BRANCH' (current: '$current_branch')." >&2
  exit 1
fi

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Working tree is not clean. Commit or stash changes first." >&2
  exit 1
fi

echo "Running release validation..."
npm ci
npm run build
npm run test:e2e

echo "Syncing branches..."
git fetch "$ORIGIN_REMOTE" "$SOURCE_BRANCH" "$TARGET_BRANCH"
git pull --ff-only "$ORIGIN_REMOTE" "$SOURCE_BRANCH"
git push "$ORIGIN_REMOTE" "$SOURCE_BRANCH"

if [[ -n "$PRIVATE_REMOTE" ]]; then
  echo "Pushing '$SOURCE_BRANCH' to private remote '$PRIVATE_REMOTE'..."
  git push "$PRIVATE_REMOTE" "$SOURCE_BRANCH"
fi

if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  pr_number="$(gh pr list --base "$TARGET_BRANCH" --head "$SOURCE_BRANCH" --state open --json number --jq '.[0].number')"
  if [[ -z "$pr_number" ]]; then
    gh pr create \
      --base "$TARGET_BRANCH" \
      --head "$SOURCE_BRANCH" \
      --title "Promote ${SOURCE_BRANCH} to ${TARGET_BRANCH}" \
      --body "Validated with npm run build and npm run test:e2e. Ready for protected merge to ${TARGET_BRANCH}."
    pr_number="$(gh pr list --base "$TARGET_BRANCH" --head "$SOURCE_BRANCH" --state open --json number --jq '.[0].number')"
  fi
  echo "Promotion PR ready: #${pr_number} (${SOURCE_BRANCH} -> ${TARGET_BRANCH})."
else
  echo "Create a PR manually: ${SOURCE_BRANCH} -> ${TARGET_BRANCH}."
fi
