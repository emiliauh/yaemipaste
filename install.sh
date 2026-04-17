#!/usr/bin/env bash
set -Eeuo pipefail

APP_NAME="yaemipaste"
DEFAULT_REPO_URL="https://github.com/emiliauh/yaemipaste.git"
DEFAULT_BRANCH="main"
DEFAULT_INSTALL_DIR="/opt/yaemipaste"
DEFAULT_UI_PORT="8080"
COMPOSE_FILE="docker-compose.yml"
ENV_FILE=".env"

INSTALL_DIR="$DEFAULT_INSTALL_DIR"
REPO_URL="$DEFAULT_REPO_URL"
BRANCH="$DEFAULT_BRANCH"
ACTION="menu"
YES=0
DRY_RUN=0

COMPOSE_CMD=()
HTTP_STATUS=""
HTTP_BODY=""

log() {
  printf '[INFO] %s\n' "$*"
}

warn() {
  printf '[WARN] %s\n' "$*" >&2
}

error() {
  printf '[ERROR] %s\n' "$*" >&2
}

die() {
  error "$*"
  exit 1
}

on_error() {
  local exit_code="$1"
  local line="$2"
  error "Command failed (line ${line}, exit ${exit_code})"
}

trap 'on_error "$?" "$LINENO"' ERR

run() {
  if [[ "$DRY_RUN" -eq 1 ]]; then
    printf '[DRY-RUN] %q ' "$@"
    printf '\n'
    return 0
  fi
  "$@"
}

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

require_command() {
  local cmd="$1"
  command_exists "$cmd" || die "Required command not found: ${cmd}"
}

prompt() {
  local message="$1"
  local default="${2:-}"
  local value=""
  if [[ "$YES" -eq 1 ]]; then
    printf '%s' "$default"
    return 0
  fi
  if [[ -n "$default" ]]; then
    read -r -p "${message} [${default}]: " value || true
    printf '%s' "${value:-$default}"
    return 0
  fi
  read -r -p "${message}: " value || true
  printf '%s' "$value"
}

prompt_secret() {
  local message="$1"
  local value=""
  if [[ "$YES" -eq 1 ]]; then
    printf ''
    return 0
  fi
  read -r -s -p "${message}: " value || true
  printf '\n' >&2
  printf '%s' "$value"
}

confirm() {
  local message="$1"
  local default="${2:-n}"
  if [[ "$YES" -eq 1 ]]; then
    return 0
  fi
  local suffix="[y/N]"
  local fallback="n"
  if [[ "$default" == "y" ]]; then
    suffix="[Y/n]"
    fallback="y"
  fi
  local answer=""
  read -r -p "${message} ${suffix} " answer || true
  answer="${answer:-$fallback}"
  case "$answer" in
    y|Y|yes|YES) return 0 ;;
    *) return 1 ;;
  esac
}

json_escape() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//$'\n'/\\n}"
  value="${value//$'\r'/\\r}"
  value="${value//$'\t'/\\t}"
  printf '%s' "$value"
}

url_encode() {
  local value="$1"
  local output=""
  local index char hex
  for ((index = 0; index < ${#value}; index += 1)); do
    char="${value:index:1}"
    case "$char" in
      [a-zA-Z0-9.~_-]) output+="$char" ;;
      *)
        printf -v hex '%%%02X' "'$char"
        output+="$hex"
        ;;
    esac
  done
  printf '%s' "$output"
}

safe_install_path() {
  # Guard rails: never allow destructive cleanup on top-level/system-critical paths.
  local path="$1"
  [[ -n "$path" ]] || return 1
  [[ "$path" == /* ]] || return 1
  [[ "$path" != "/" ]] || return 1
  [[ "$path" != "/root" ]] || return 1
  [[ "$path" != "/home" ]] || return 1
  [[ "$path" != "/opt" ]] || return 1
  return 0
}

detect_compose_cmd() {
  if command_exists docker && docker compose version >/dev/null 2>&1; then
    COMPOSE_CMD=(docker compose)
    return 0
  fi
  if command_exists docker-compose; then
    COMPOSE_CMD=(docker-compose)
    return 0
  fi
  if [[ "$DRY_RUN" -eq 1 ]]; then
    COMPOSE_CMD=(docker compose)
    warn "Docker Compose not found; continuing because --dry-run is enabled."
    return 0
  fi
  die "Docker Compose not found. Install Docker (with compose plugin) or docker-compose."
}

compose() {
  [[ ${#COMPOSE_CMD[@]} -gt 0 ]] || detect_compose_cmd
  [[ -f "${INSTALL_DIR}/${COMPOSE_FILE}" ]] || die "Compose file not found at ${INSTALL_DIR}/${COMPOSE_FILE}"
  run "${COMPOSE_CMD[@]}" -f "${INSTALL_DIR}/${COMPOSE_FILE}" --project-name "$APP_NAME" "$@"
}

ensure_repo_present() {
  [[ -d "${INSTALL_DIR}/.git" ]] || die "No git repository at ${INSTALL_DIR}. Run install first."
}

ensure_runtime_prereqs() {
  require_command git
  require_command curl
  require_command sed
  require_command awk
  detect_compose_cmd
}

env_get() {
  local key="$1"
  local default="${2:-}"
  local file="${INSTALL_DIR}/${ENV_FILE}"
  if [[ ! -f "$file" ]]; then
    printf '%s' "$default"
    return 0
  fi
  local line
  line="$(grep -E "^${key}=" "$file" | tail -n 1 || true)"
  if [[ -z "$line" ]]; then
    printf '%s' "$default"
    return 0
  fi
  printf '%s' "${line#*=}"
}

upsert_env() {
  local key="$1"
  local value="$2"
  local file="${INSTALL_DIR}/${ENV_FILE}"
  if [[ ! -f "$file" ]]; then
    if [[ "$DRY_RUN" -eq 1 ]]; then
      run bash -c "printf '\n%s=%s\n' '$key' '$value' >> '$file'"
      return 0
    fi
    run cp "${INSTALL_DIR}/.env.example" "$file"
  fi
  local escaped
  escaped="$(printf '%s' "$value" | sed -e 's/[\/&]/\\&/g')"
  if grep -q -E "^${key}=" "$file"; then
    run sed -i "s/^${key}=.*/${key}=${escaped}/" "$file"
  else
    run bash -c "printf '\n%s=%s\n' '$key' '$value' >> '$file'"
  fi
}

http_json() {
  local method="$1"
  local url="$2"
  local payload="${3:-}"
  local bearer="${4:-}"
  local response_file
  response_file="$(mktemp)"
  local -a headers
  headers=(-H "Accept: application/json")
  if [[ -n "$payload" ]]; then
    headers+=(-H "Content-Type: application/json" --data "$payload")
  fi
  if [[ -n "$bearer" ]]; then
    headers+=(-H "Authorization: Bearer ${bearer}")
  fi
  if [[ "$DRY_RUN" -eq 1 ]]; then
    log "[DRY-RUN] ${method} ${url}"
    HTTP_STATUS="200"
    HTTP_BODY='{"dry_run":true}'
    rm -f "$response_file"
    return 0
  fi
  HTTP_STATUS="$(
    curl -sS -o "$response_file" -w "%{http_code}" -X "$method" "${headers[@]}" "$url"
  )"
  HTTP_BODY="$(cat "$response_file")"
  rm -f "$response_file"
}

expect_2xx() {
  if [[ "${HTTP_STATUS}" =~ ^2[0-9]{2}$ ]]; then
    return 0
  fi
  error "Request failed with HTTP ${HTTP_STATUS}"
  if [[ -n "${HTTP_BODY}" ]]; then
    printf '%s\n' "$HTTP_BODY" >&2
  fi
  return 1
}

extract_token_from_json() {
  local body="$1"
  if command_exists jq; then
    jq -r '.token // .paste_token // .value // .data.token // .data.paste_token // empty' <<<"$body" 2>/dev/null
    return 0
  fi
  sed -nE 's/.*"(token|paste_token|value)"[[:space:]]*:[[:space:]]*"([^"]+)".*/\2/p' <<<"$body" | head -n 1
}

wait_for_http() {
  local url="$1"
  local label="$2"
  local attempts="${3:-30}"
  local delay="${4:-2}"
  local code=""
  local i
  for ((i = 1; i <= attempts; i += 1)); do
    if [[ "$DRY_RUN" -eq 1 ]]; then
      log "[DRY-RUN] would probe ${label} (${url})"
      return 0
    fi
    code="$(curl -s -o /dev/null -w "%{http_code}" "$url" || true)"
    if [[ "$code" =~ ^[1-4][0-9][0-9]$ ]]; then
      log "${label} is responding (HTTP ${code})"
      return 0
    fi
    sleep "$delay"
  done
  warn "${label} did not become ready in time (${url})"
  return 1
}

configure_env() {
  local env_path="${INSTALL_DIR}/${ENV_FILE}"
  if [[ ! -f "$env_path" ]]; then
    [[ -f "${INSTALL_DIR}/.env.example" ]] || die "Missing .env.example in repository."
    run cp "${INSTALL_DIR}/.env.example" "$env_path"
    log "Created ${env_path} from .env.example"
  fi

  local ui_port paste_image auth_image turnstile_key admin_base bootstrap_path token_create_path token_revoke_path register_url
  ui_port="$(prompt "UI port to expose" "$(env_get UI_PORT "$DEFAULT_UI_PORT")")"
  paste_image="$(prompt "Paste API image" "$(env_get PASTE_API_IMAGE "orhunp/rustypaste:latest")")"
  auth_image="$(prompt "Auth API image" "$(env_get AUTH_API_IMAGE "ghcr.io/emiliauh/yaemipaste-auth:latest")")"
  turnstile_key="$(prompt "Turnstile site key (leave empty to disable)" "$(env_get VITE_TURNSTILE_SITE_KEY "")")"
  admin_base="$(prompt "Auth admin base URL" "$(env_get AUTH_ADMIN_BASE_URL "http://localhost:${ui_port}/auth/admin")")"
  bootstrap_path="$(prompt "Auth bootstrap path" "$(env_get AUTH_BOOTSTRAP_PATH "/bootstrap")")"
  token_create_path="$(prompt "Token create path" "$(env_get AUTH_TOKEN_CREATE_PATH "/tokens")")"
  token_revoke_path="$(prompt "Token revoke path (use %s placeholder for token)" "$(env_get AUTH_TOKEN_REVOKE_PATH "/tokens/%s")")"
  register_url="$(prompt "Register endpoint URL" "$(env_get AUTH_REGISTER_URL "http://localhost:${ui_port}/auth/register")")"

  upsert_env UI_PORT "$ui_port"
  upsert_env PASTE_API_IMAGE "$paste_image"
  upsert_env AUTH_API_IMAGE "$auth_image"
  upsert_env VITE_TURNSTILE_SITE_KEY "$turnstile_key"
  upsert_env VITE_PASTE_API "/api"
  upsert_env VITE_AUTH_API "/auth"
  upsert_env AUTH_ADMIN_BASE_URL "$admin_base"
  upsert_env AUTH_BOOTSTRAP_PATH "$bootstrap_path"
  upsert_env AUTH_TOKEN_CREATE_PATH "$token_create_path"
  upsert_env AUTH_TOKEN_REVOKE_PATH "$token_revoke_path"
  upsert_env AUTH_REGISTER_URL "$register_url"
  upsert_env AUTH_ADMIN_BEARER "$(env_get AUTH_ADMIN_BEARER "")"
}

clone_or_update_repo() {
  if [[ -d "${INSTALL_DIR}/.git" ]]; then
    log "Updating existing repository at ${INSTALL_DIR}"
    run git -C "$INSTALL_DIR" fetch --prune origin
    run git -C "$INSTALL_DIR" checkout "$BRANCH"
    run git -C "$INSTALL_DIR" pull --ff-only origin "$BRANCH"
    return 0
  fi

  if [[ -d "$INSTALL_DIR" ]] && [[ -n "$(find "$INSTALL_DIR" -mindepth 1 -maxdepth 1 2>/dev/null | head -n 1)" ]]; then
    die "Install directory is not empty: ${INSTALL_DIR}"
  fi

  run mkdir -p "$INSTALL_DIR"
  run git clone --branch "$BRANCH" --single-branch "$REPO_URL" "$INSTALL_DIR"
}

stack_install_or_update() {
  ensure_runtime_prereqs
  safe_install_path "$INSTALL_DIR" || die "Refusing unsafe install path: ${INSTALL_DIR}"
  clone_or_update_repo
  configure_env
  log "Starting full stack..."
  compose pull || warn "Compose pull failed; continuing with local build"
  compose up -d --build
  local ui_port
  ui_port="$(env_get UI_PORT "$DEFAULT_UI_PORT")"
  wait_for_http "http://localhost:${ui_port}/" "UI endpoint" || true
  wait_for_http "http://localhost:${ui_port}/auth/" "Auth endpoint" || true
  wait_for_http "http://localhost:${ui_port}/api/" "Paste endpoint" || true
  log "Install/update completed."
}

stack_start() {
  ensure_runtime_prereqs
  ensure_repo_present
  compose up -d
}

stack_stop() {
  ensure_runtime_prereqs
  ensure_repo_present
  compose stop
}

stack_restart() {
  ensure_runtime_prereqs
  ensure_repo_present
  compose restart
}

stack_status() {
  ensure_runtime_prereqs
  ensure_repo_present
  compose ps
}

read_auth_settings() {
  AUTH_ADMIN_BASE_URL_VALUE="$(env_get AUTH_ADMIN_BASE_URL "http://localhost:8080/auth/admin")"
  AUTH_BOOTSTRAP_PATH_VALUE="$(env_get AUTH_BOOTSTRAP_PATH "/bootstrap")"
  AUTH_TOKEN_CREATE_PATH_VALUE="$(env_get AUTH_TOKEN_CREATE_PATH "/tokens")"
  AUTH_TOKEN_REVOKE_PATH_VALUE="$(env_get AUTH_TOKEN_REVOKE_PATH "/tokens/%s")"
  AUTH_REGISTER_URL_VALUE="$(env_get AUTH_REGISTER_URL "http://localhost:8080/auth/register")"
  AUTH_ADMIN_BEARER_VALUE="$(env_get AUTH_ADMIN_BEARER "")"
}

read_admin_bearer() {
  # Prefer prompting at runtime so admin credentials are not persisted by default.
  local token="${AUTH_ADMIN_BEARER_VALUE}"
  if [[ -n "$token" ]]; then
    printf '%s' "$token"
    return 0
  fi
  token="$(prompt_secret "Enter auth admin bearer token (not stored)")"
  [[ -n "$token" ]] || die "Admin bearer token is required for this action."
  printf '%s' "$token"
}

create_initial_user() {
  ensure_repo_present
  read_auth_settings
  local username password register_token
  username="$(prompt "Initial username" "")"
  [[ -n "$username" ]] || die "Username is required."
  password="$(prompt_secret "Initial password")"
  [[ -n "$password" ]] || die "Password is required."
  register_token="$(prompt "Registration token (leave empty to use bootstrap endpoint)" "")"

  local payload
  payload="{\"username\":\"$(json_escape "$username")\",\"password\":\"$(json_escape "$password")\""
  if [[ -n "$register_token" ]]; then
    payload+=",\"token\":\"$(json_escape "$register_token")\"}"
    http_json POST "$AUTH_REGISTER_URL_VALUE" "$payload"
    expect_2xx || die "Failed to create user using register endpoint."
    log "Initial user created via register endpoint."
    return 0
  fi
  payload+="}"
  local admin_bearer
  admin_bearer="$(read_admin_bearer)"
  local bootstrap_url="${AUTH_ADMIN_BASE_URL_VALUE%/}/${AUTH_BOOTSTRAP_PATH_VALUE#/}"
  http_json POST "$bootstrap_url" "$payload" "$admin_bearer"
  expect_2xx || die "Bootstrap user creation failed. Provide a registration token or verify auth admin endpoint settings."
  log "Initial user created via admin bootstrap endpoint."
}

create_token() {
  ensure_repo_present
  read_auth_settings
  local label ttl payload
  label="$(prompt "Token label" "install-$(date +%Y%m%d-%H%M%S)")"
  ttl="$(prompt "Token TTL seconds (optional)" "")"
  payload="{\"label\":\"$(json_escape "$label")\""
  if [[ -n "$ttl" ]]; then
    [[ "$ttl" =~ ^[0-9]+$ ]] || die "TTL must be numeric seconds."
    payload+=",\"ttl_seconds\":${ttl}"
  fi
  payload+="}"
  local admin_bearer
  admin_bearer="$(read_admin_bearer)"
  local create_url="${AUTH_ADMIN_BASE_URL_VALUE%/}/${AUTH_TOKEN_CREATE_PATH_VALUE#/}"
  http_json POST "$create_url" "$payload" "$admin_bearer"
  expect_2xx || die "Token creation failed."
  local created
  created="$(extract_token_from_json "$HTTP_BODY")"
  if [[ -n "$created" ]]; then
    printf '\nNew token:\n%s\n\n' "$created"
  else
    warn "Token endpoint did not return a recognizable token field."
    printf '%s\n' "$HTTP_BODY"
  fi
}

revoke_token() {
  ensure_repo_present
  read_auth_settings
  local token
  token="$(prompt "Token to revoke" "")"
  [[ -n "$token" ]] || die "Token is required."
  local encoded revoke_path revoke_url admin_bearer
  encoded="$(url_encode "$token")"
  revoke_path="$AUTH_TOKEN_REVOKE_PATH_VALUE"
  if [[ "$revoke_path" == *"%s"* ]]; then
    revoke_path="${revoke_path//%s/${encoded}}"
  else
    revoke_path="${revoke_path%/}/${encoded}"
  fi
  revoke_url="${AUTH_ADMIN_BASE_URL_VALUE%/}/${revoke_path#/}"
  admin_bearer="$(read_admin_bearer)"
  http_json DELETE "$revoke_url" "" "$admin_bearer"
  expect_2xx || die "Token revocation failed."
  log "Token revoked."
}

stack_uninstall() {
  ensure_runtime_prereqs
  safe_install_path "$INSTALL_DIR" || die "Refusing unsafe uninstall path: ${INSTALL_DIR}"
  if ! confirm "This will stop ${APP_NAME} services. Continue?" n; then
    log "Cancelled."
    return 0
  fi
  if [[ -f "${INSTALL_DIR}/${COMPOSE_FILE}" ]]; then
    if confirm "Remove Docker volumes too? (destructive)" n; then
      compose down --volumes --remove-orphans
    else
      compose down --remove-orphans
    fi
  fi
  if confirm "Delete install directory ${INSTALL_DIR}?" n; then
    local check
    check="$(prompt "Type DELETE to confirm directory removal" "")"
    if [[ "$check" == "DELETE" ]]; then
      run rm -rf "$INSTALL_DIR"
      log "Removed ${INSTALL_DIR}"
    else
      warn "Confirmation phrase mismatch. Directory was not removed."
    fi
  fi
}

print_menu() {
  cat <<EOF

${APP_NAME} install manager
Install directory: ${INSTALL_DIR}
Repository: ${REPO_URL} (${BRANCH})

1) Install / Update full stack
2) Create initial user
3) Create registration token
4) Revoke token
5) Start services
6) Stop services
7) Restart services
8) Service status
9) Uninstall / cleanup
0) Exit
EOF
}

run_action() {
  case "$1" in
    install) stack_install_or_update ;;
    init-user) create_initial_user ;;
    create-token) create_token ;;
    revoke-token) revoke_token ;;
    start) stack_start ;;
    stop) stack_stop ;;
    restart) stack_restart ;;
    status) stack_status ;;
    uninstall) stack_uninstall ;;
    menu)
      while true; do
        print_menu
        local choice
        choice="$(prompt "Choose an option" "")"
        case "$choice" in
          1) stack_install_or_update ;;
          2) create_initial_user ;;
          3) create_token ;;
          4) revoke_token ;;
          5) stack_start ;;
          6) stack_stop ;;
          7) stack_restart ;;
          8) stack_status ;;
          9) stack_uninstall ;;
          0) log "Bye."; break ;;
          *) warn "Invalid option: ${choice}" ;;
        esac
      done
      ;;
    *)
      die "Unknown action: $1"
      ;;
  esac
}

usage() {
  cat <<EOF
Usage: $0 [options]

Options:
  --action <install|init-user|create-token|revoke-token|start|stop|restart|status|uninstall|menu>
  --install-dir <path>   Default: ${DEFAULT_INSTALL_DIR}
  --repo-url <url>       Default: ${DEFAULT_REPO_URL}
  --branch <name>        Default: ${DEFAULT_BRANCH}
  --yes                  Non-interactive confirmations (best effort)
  --dry-run              Print actions without changing system state
  -h, --help             Show this help
EOF
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --action)
        [[ $# -ge 2 ]] || die "--action requires a value"
        ACTION="$2"
        shift 2
        ;;
      --install-dir)
        [[ $# -ge 2 ]] || die "--install-dir requires a path"
        INSTALL_DIR="$2"
        shift 2
        ;;
      --repo-url)
        [[ $# -ge 2 ]] || die "--repo-url requires a value"
        REPO_URL="$2"
        shift 2
        ;;
      --branch)
        [[ $# -ge 2 ]] || die "--branch requires a value"
        BRANCH="$2"
        shift 2
        ;;
      --yes)
        YES=1
        shift
        ;;
      --dry-run)
        DRY_RUN=1
        shift
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      install|init-user|create-token|revoke-token|start|stop|restart|status|uninstall|menu)
        ACTION="$1"
        shift
        ;;
      *)
        die "Unknown argument: $1"
        ;;
    esac
  done
}

main() {
  parse_args "$@"
  run_action "$ACTION"
}

main "$@"
