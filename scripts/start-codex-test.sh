#!/usr/bin/env bash
set -euo pipefail

# Starts an isolated local stack for browser testing. It never changes .env or
# production containers, and Turnstile is disabled only in this local profile.
root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
env_file="$root_dir/.env.codex-test"
override_file="$root_dir/docker-compose.codex-test.yml"

if [[ ! -f "$env_file" ]]; then
  umask 077
  cp "$root_dir/.env.example" "$env_file"
  jwt_secret="$(openssl rand -hex 32)"
  admin_bearer="$(openssl rand -hex 32)"
  sed -i \
    -e 's|^PASTE_URL=.*|PASTE_URL=http://127.0.0.1:18080|' \
    -e 's|^PASTE_PUBLIC_API=.*|PASTE_PUBLIC_API=http://127.0.0.1:18080/api|' \
    -e 's|^UI_PORT=.*|UI_PORT=18080|' \
    -e "s|^JWT_SECRET=.*|JWT_SECRET=$jwt_secret|" \
    -e "s|^AUTH_ADMIN_BEARER=.*|AUTH_ADMIN_BEARER=$admin_bearer|" \
    -e 's|^TURNSTILE_SECRET_KEY=.*|TURNSTILE_SECRET_KEY=|' \
    -e 's|^VITE_TURNSTILE_SITE_KEY=.*|VITE_TURNSTILE_SITE_KEY=|' \
    -e 's|^AUTH_ADMIN_BASE_URL=.*|AUTH_ADMIN_BASE_URL=http://127.0.0.1:18080/auth/admin|' \
    -e 's|^AUTH_REGISTER_URL=.*|AUTH_REGISTER_URL=http://127.0.0.1:18080/auth/register|' \
    "$env_file"
fi

docker compose --env-file "$env_file" -f "$root_dir/docker-compose.yml" -f "$override_file" up --build -d

for _ in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:18080/auth/admin/public-settings >/dev/null; then
    break
  fi
  sleep 1
done

set -a
. "$env_file"
set +a
username="${CODEX_TEST_USERNAME:-codex}"
password="${CODEX_TEST_PASSWORD:?Set CODEX_TEST_PASSWORD to provision the local test account}"
payload="$(CODEX_TEST_USERNAME="$username" CODEX_TEST_PASSWORD="$password" node -e 'process.stdout.write(JSON.stringify({ username: process.env.CODEX_TEST_USERNAME, password: process.env.CODEX_TEST_PASSWORD }))')"
curl -fsS \
  -H "Authorization: Bearer $AUTH_ADMIN_BEARER" \
  -H 'Content-Type: application/json' \
  --data "$payload" \
  http://127.0.0.1:18080/auth/admin/bootstrap >/dev/null || true

echo "Local test UI: http://127.0.0.1:18080"
echo "Turnstile is disabled only for this isolated local stack."
echo "Local test account: $username"
