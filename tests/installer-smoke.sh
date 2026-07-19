#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Sourcing exposes installer functions without running its interactive entrypoint.
source "$ROOT/install.sh"

temp_dir="$(mktemp -d)"
trap 'rm -rf "$temp_dir"' EXIT
INSTALL_DIR="$temp_dir/install"
mkdir -p "$INSTALL_DIR"
touch "$INSTALL_DIR/$COMPOSE_FILE"

cat > "$INSTALL_DIR/.env" <<'EOF'
PASTE_URL=http://192.168.16.162:8080
UI_PORT=8080
JWT_SECRET=
AUTH_ADMIN_BEARER=
EOF

read_auth_settings
[[ "$AUTH_ADMIN_BASE_URL_VALUE" == "http://127.0.0.1:8080/auth/admin" ]]
[[ "$AUTH_REGISTER_URL_VALUE" == "http://192.168.16.162:8080/auth/register" ]]

compose_env_file=""
run() {
  [[ "$1" == "mock-compose" ]]
  [[ "$2" == "--env-file" ]]
  compose_env_file="$3"
  [[ -f "$compose_env_file" ]]
  [[ "$(awk -F= '$1 == "JWT_SECRET" { print $2 }' "$compose_env_file")" == "uninstall-placeholder" ]]
  [[ "$(awk -F= '$1 == "AUTH_ADMIN_BEARER" { print $2 }' "$compose_env_file")" == "uninstall-placeholder" ]]
}
ensure_runtime_prereqs() { COMPOSE_CMD=(mock-compose); }
confirm_count=0
confirm() {
  ((confirm_count += 1))
  [[ "$confirm_count" -lt 3 ]]
}
prompt() { printf 'DELETE'; }

stack_uninstall
[[ ! -e "$compose_env_file" ]]

printf 'installer smoke tests passed\n'
