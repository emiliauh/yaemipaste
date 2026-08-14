#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Sourcing exposes installer functions without running its interactive entrypoint.
source "$ROOT/install.sh"

[[ "$DEFAULT_BRANCH" == "main" ]]

temp_dir="$(mktemp -d)"
trap 'rm -rf "$temp_dir"' EXIT

# A fresh configuration must create backend-compatible secrets even when the
# installer is launched from a directory unrelated to the install directory.
INSTALL_DIR="$temp_dir/fresh-install"
mkdir -p "$INSTALL_DIR"
cp "$ROOT/.env.example" "$INSTALL_DIR/.env.example"
YES=1
PUBLIC_URL_OVERRIDE="http://example.test:8080"
configure_env
fresh_jwt="$(env_get JWT_SECRET "")"
fresh_bearer="$(env_get AUTH_ADMIN_BEARER "")"
fresh_image_tag="$(env_get YAEMIPASTE_IMAGE_TAG "")"
[[ "$fresh_jwt" =~ ^[a-f0-9]{64}$ ]]
[[ "$fresh_bearer" =~ ^[a-f0-9]{64}$ ]]
[[ "$fresh_image_tag" == "main" ]]
[[ "$(stat -c '%a' "$INSTALL_DIR/.env")" == "600" ]]

INSTALL_DIR="$temp_dir/legacy-install"
mkdir -p "$INSTALL_DIR"
cp "$ROOT/.env.example" "$INSTALL_DIR/.env.example"
cat > "$INSTALL_DIR/.env" <<'EOF'
PASTE_URL=http://example.test:8080
YAEMIPASTE_IMAGE_TAG=nestjs-rewrite
JWT_SECRET=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
AUTH_ADMIN_BEARER=abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789
EOF
configure_env
[[ "$(env_get YAEMIPASTE_IMAGE_TAG "")" == "main" ]]

INSTALL_DIR="$temp_dir/claim-install"
mkdir -p "$INSTALL_DIR"
touch "$INSTALL_DIR/$COMPOSE_FILE"
cat > "$INSTALL_DIR/.env" <<'EOF'
PASTE_URL=http://127.0.0.1:8080
UI_PORT=8080
JWT_SECRET=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
AUTH_ADMIN_BEARER=abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789
AUTH_ADMIN_BASE_URL=http://127.0.0.1:8080/auth/admin
AUTH_ADMIN_CLAIM_INIT_PATH=/claim/init
EOF

http_json() {
  [[ "$1" == "POST" ]]
  [[ "$2" == "http://127.0.0.1:8080/auth/admin/claim/init" ]]
  [[ "$3" == '{"reset":false}' ]]
  [[ "$4" == "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789" ]]
  HTTP_STATUS="200"
  HTTP_BODY='{"token":"installer-smoke-claim-token","expires_at":9999999999}'
}

claim_output="$(init_admin_claim 0 2>&1)"
[[ "$claim_output" == *"installer-smoke-claim-token"* ]]

http_json() {
  HTTP_STATUS="409"
  HTTP_BODY='{"detail":"An administrator already exists"}'
}

existing_admin_output="$(init_admin_claim 0 2>&1)"
[[ "$existing_admin_output" == *"AUTH_ADMIN_BEARER is for installer requests, not admin-panel login"* ]]

INSTALL_DIR="$temp_dir/install"
mkdir -p "$INSTALL_DIR"
touch "$INSTALL_DIR/$COMPOSE_FILE"

cat > "$INSTALL_DIR/.env" <<'EOF'
PASTE_URL=http://192.168.16.162:8080
UI_PORT=8080
JWT_SECRET=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
AUTH_ADMIN_BEARER=abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789
COMPOSE_PROFILES=ui,api
DEPLOYMENT_IMAGE_MODE=pull
EOF

read_auth_settings
[[ "$AUTH_ADMIN_BASE_URL_VALUE" == "http://127.0.0.1:8080/auth/admin" ]]
[[ "$AUTH_REGISTER_URL_VALUE" == "http://192.168.16.162:8080/auth/register" ]]
rotation_first="0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
rotation_second="abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"
AUTH_ADMIN_BEARER_VALUE="  ${rotation_first}, ${rotation_second}"
[[ "$(read_admin_bearer)" == "$rotation_first" ]]

compose_env_file=""
compose_project_directory=""
run() {
  [[ "$1" == "mock-compose" ]]
  [[ "$2" == "--env-file" ]]
  compose_env_file="$3"
  [[ "$4" == "--project-directory" ]]
  compose_project_directory="$5"
  [[ -f "$compose_env_file" ]]
  if [[ "$*" == *" config" ]]; then
    [[ "$compose_env_file" == "$INSTALL_DIR/.env" ]]
    [[ "$compose_project_directory" == "$INSTALL_DIR" ]]
    [[ "$(awk -F= '$1 == "JWT_SECRET" { print $2 }' "$compose_env_file")" != "" ]]
    [[ "$(awk -F= '$1 == "AUTH_ADMIN_BEARER" { print $2 }' "$compose_env_file")" != "" ]]
  else
    [[ "$(awk -F= '$1 == "JWT_SECRET" { print $2 }' "$compose_env_file")" == "uninstall-placeholder" ]]
    [[ "$(awk -F= '$1 == "AUTH_ADMIN_BEARER" { print $2 }' "$compose_env_file")" == "uninstall-placeholder" ]]
    [[ "$(awk -F= '$1 == "YAEMIPASTE_IMAGE_TAG" { print $2 }' "$compose_env_file")" == "uninstall-placeholder" ]]
  fi
}

COMPOSE_CMD=(mock-compose)
old_dir="$PWD"
cd /tmp
compose config
cd "$old_dir"
normal_compose_env_file="$compose_env_file"
normal_compose_project_directory="$compose_project_directory"
[[ "$normal_compose_env_file" == "$INSTALL_DIR/.env" ]]
[[ "$normal_compose_project_directory" == "$INSTALL_DIR" ]]

ensure_runtime_prereqs() { COMPOSE_CMD=(mock-compose); }
confirm_count=0
confirm() {
  confirm_count=$((confirm_count + 1))
  [[ "$confirm_count" -lt 3 ]]
}
prompt() { printf 'DELETE'; }

stack_uninstall
[[ ! -e "$compose_env_file" ]]

printf 'installer smoke tests passed\n'
