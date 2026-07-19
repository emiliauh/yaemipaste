#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root_dir"

require() {
  command -v "$1" >/dev/null 2>&1 || {
    printf 'Required command not found: %s\n' "$1" >&2
    exit 1
  }
}

require docker
require npm
require git

bash -n install.sh
git diff --check
if git grep -nE 'paste\.yaemi\.one|papi\.yaemi\.one' -- ':!docs/deployment' ':!README.md'; then
  printf 'Replace instance-specific hostnames before publishing.\n' >&2
  exit 1
fi

for fixture in tests/fixtures/deployment-same.env tests/fixtures/deployment-split.env; do
  docker compose --env-file "$fixture" -f docker-compose.yml config --quiet
done

npm ci
npm run build
PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=ubuntu24.04-x64 PLAYWRIGHT_BROWSERS_PATH=0 PLAYWRIGHT_CONTAINER=1 npx playwright test tests/e2e/rustypaste.spec.ts --workers=1

if command -v cargo >/dev/null 2>&1; then
  cargo test --locked --manifest-path backend/rustypaste/Cargo.toml
else
  printf 'cargo is unavailable; backend compilation is validated by docker compose build.\n'
  docker compose --env-file tests/fixtures/deployment-same.env -f docker-compose.yml build paste-api
fi

printf 'Production validation passed.\n'
