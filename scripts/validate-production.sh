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
npm --prefix backend/nestjs ci
npm run api:build
npm run api:test
PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=ubuntu24.04-x64 PLAYWRIGHT_BROWSERS_PATH=0 PLAYWRIGHT_CONTAINER=1 npx playwright test tests/e2e/yaemipaste.spec.ts --workers=1

printf 'Production validation passed.\n'
