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
UI_COLOR=0
UI_MOTION=0
UI_RESET=""
UI_DIM=""
UI_ACCENT=""
UI_GOOD=""
UI_WARN=""
UI_BAD=""
UI_RULE_WIDTH=58

setup_ui() {
  if [[ -t 1 && "${TERM:-}" != "dumb" ]]; then
    UI_COLOR=1
    UI_MOTION=1
    UI_RESET=$'\033[0m'
    UI_DIM=$'\033[2m'
    UI_ACCENT=$'\033[1;38;5;213m'
    UI_GOOD=$'\033[1;38;5;114m'
    UI_WARN=$'\033[1;38;5;221m'
    UI_BAD=$'\033[1;38;5;203m'
  fi
}

style() {
  local color="$1"
  shift
  if [[ "$UI_COLOR" -eq 1 ]]; then
    printf '%s%s%s' "$color" "$*" "$UI_RESET"
  else
    printf '%s' "$*"
  fi
}

repeat_char() {
  local char="$1"
  local count="$2"
  local out=""
  while (( ${#out} < count )); do
    out+="$char"
  done
  printf '%s' "${out:0:count}"
}

rule() {
  printf '%s' "$(repeat_char "-" "$UI_RULE_WIDTH")"
}

box_row() {
  local text="$1"
  local width="$UI_RULE_WIDTH"
  local padded
  printf -v padded '%-*.*s' "$width" "$width" "$text"
  printf '| %s |\n' "$padded"
}

ui_pause() {
  [[ "$UI_MOTION" -eq 1 && "$YES" -eq 0 ]] || return 0
  sleep "${1:-0.05}"
}

print_box_line() {
  local text="$1"
  printf '%s\n' "$text"
  ui_pause 0.03
}

print_banner() {
  local top bottom
  top="$(style "$UI_DIM" "+$(repeat_char "=" "$((UI_RULE_WIDTH + 2))")+")"
  bottom="$(style "$UI_DIM" "+$(repeat_char "=" "$((UI_RULE_WIDTH + 2))")+")"
  printf '\n'
  print_box_line "$top"
  print_box_line "$(style "$UI_ACCENT" "$(box_row "yaemipaste")")"
  print_box_line "$(style "$UI_DIM" "$(box_row "install script + runtime manager")")"
  print_box_line "$(style "$UI_DIM" "$(box_row "working, but still evolving")")"
  print_box_line "$bottom"
  printf '\n'
}

section() {
  printf '\n%s\n' "$(style "$UI_DIM" "$(rule)")"
  printf '%s\n' "$(style "$UI_ACCENT" "$*")"
}

step() {
  printf '%s %s\n' "$(style "$UI_DIM" "[..]")" "$*"
}

success() {
  printf '%s %s\n' "$(style "$UI_GOOD" "[ok]")" "$*"
}

log() {
  printf '%s %s\n' "$(style "$UI_DIM" "[info]")" "$*"
}

warn() {
  printf '%s %s\n' "$(style "$UI_WARN" "[warn]")" "$*" >&2
}

error() {
  printf '%s %s\n' "$(style "$UI_BAD" "[error]")" "$*" >&2
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

apt_install_packages() {
  local packages=("$@")
  [[ ${#packages[@]} -gt 0 ]] || return 0
  run apt-get update
  run env DEBIAN_FRONTEND=noninteractive apt-get install -y "${packages[@]}"
}

ensure_docker_runtime() {
  if command_exists docker && docker compose version >/dev/null 2>&1; then
    return 0
  fi
  if command_exists docker-compose; then
    return 0
  fi
  if [[ "$DRY_RUN" -eq 1 ]]; then
    warn "Docker Compose not found; continuing because --dry-run is enabled."
    return 0
  fi

  if command_exists apt-get; then
    log "Docker/Compose not found. Installing runtime prerequisites via apt..."
    apt_install_packages ca-certificates gnupg docker.io docker-compose-v2
    if command_exists systemctl; then
      run systemctl enable --now docker
    fi
    return 0
  fi

  die "Docker Compose not found and automatic installation is unsupported on this OS."
}

maybe_use_local_checkout_as_repo() {
  if [[ "$REPO_URL" != "$DEFAULT_REPO_URL" ]]; then
    return 0
  fi
  local script_dir top_level current_branch
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  top_level="$(git -C "$script_dir" rev-parse --show-toplevel 2>/dev/null || true)"
  if [[ -z "$top_level" ]] && [[ -f "$script_dir/install.sh" && -f "$script_dir/${COMPOSE_FILE}" ]]; then
    top_level="$script_dir"
  fi
  if [[ -n "$top_level" && -f "$top_level/install.sh" && -f "$top_level/${COMPOSE_FILE}" ]]; then
    REPO_URL="$top_level"
    current_branch="$(git -C "$top_level" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
    if [[ "$BRANCH" == "$DEFAULT_BRANCH" && -n "$current_branch" && "$current_branch" != "HEAD" ]]; then
      BRANCH="$current_branch"
    fi
    log "Using local checkout as install source: ${REPO_URL}"
  fi
}

generate_secret() {
  if command_exists openssl; then
    openssl rand -hex 32
    return 0
  fi
  date +%s%N | sha256sum | awk '{print $1}'
}

detect_host_address() {
  local value=""
  if command_exists ip; then
    value="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i <= NF; i += 1) if ($i == "src") { print $(i + 1); exit }}')"
  fi
  if [[ -z "$value" ]] && command_exists hostname; then
    value="$(hostname -I 2>/dev/null | awk '{print $1}')"
  fi
  if [[ -z "$value" ]]; then
    value="localhost"
  fi
  printf '%s' "$value"
}

default_public_url() {
  local port="$1"
  printf 'http://%s:%s' "$(detect_host_address)" "$port"
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
    read -r -p "$(printf '%s %s [%s]: ' "$(style "$UI_ACCENT" ">")" "$message" "$default")" value || true
    printf '%s' "${value:-$default}"
    return 0
  fi
  read -r -p "$(printf '%s %s: ' "$(style "$UI_ACCENT" ">")" "$message")" value || true
  printf '%s' "$value"
}

prompt_secret() {
  local message="$1"
  local value=""
  if [[ "$YES" -eq 1 ]]; then
    printf ''
    return 0
  fi
  read -r -s -p "$(printf '%s %s: ' "$(style "$UI_ACCENT" ">")" "$message")" value || true
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
  read -r -p "$(printf '%s %s %s ' "$(style "$UI_ACCENT" "?")" "$message" "$suffix")" answer || true
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
  ensure_docker_runtime
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
  if [[ ! -f "${INSTALL_DIR}/${COMPOSE_FILE}" ]]; then
    if [[ "$DRY_RUN" -eq 1 ]]; then
      log "[DRY-RUN] would run compose against ${INSTALL_DIR}/${COMPOSE_FILE} after cloning the repository"
      return 0
    fi
    die "Compose file not found at ${INSTALL_DIR}/${COMPOSE_FILE}"
  fi
  local resolver_enabled
  local -a profile_args
  resolver_enabled="$(env_get RESOLVER_ENABLED "0")"
  profile_args=()
  if [[ "$resolver_enabled" != "0" ]]; then
    profile_args=(--profile with-resolver)
  fi
  run "${COMPOSE_CMD[@]}" -f "${INSTALL_DIR}/${COMPOSE_FILE}" --project-name "$APP_NAME" "${profile_args[@]}" "$@"
}

ensure_repo_present() {
  if [[ -d "${INSTALL_DIR}/.git" || -f "${INSTALL_DIR}/${COMPOSE_FILE}" ]]; then
    return 0
  fi
  die "No installed stack found at ${INSTALL_DIR}. Run install first."
}

ensure_runtime_prereqs() {
  if ! command_exists git && command_exists apt-get && [[ "$DRY_RUN" -eq 0 ]]; then
    log "Installing missing prerequisite: git"
    apt_install_packages git
  fi
  if ! command_exists curl && command_exists apt-get && [[ "$DRY_RUN" -eq 0 ]]; then
    log "Installing missing prerequisite: curl"
    apt_install_packages curl
  fi
  if ! command_exists awk && command_exists apt-get && [[ "$DRY_RUN" -eq 0 ]]; then
    log "Installing missing prerequisite: gawk"
    apt_install_packages gawk
  fi
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

env_get_nonempty() {
  local key="$1"
  local default="${2:-}"
  local value
  value="$(env_get "$key" "")"
  if [[ -n "$value" ]]; then
    printf '%s' "$value"
    return 0
  fi
  printf '%s' "$default"
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
  local expected_pattern='^2[0-9][0-9]$'
  local attempts="${4:-30}"
  local delay="${5:-2}"
  local code=""
  local i
  if [[ $# -ge 3 && -n "$3" ]]; then
    expected_pattern="$3"
  fi
  for ((i = 1; i <= attempts; i += 1)); do
    if [[ "$DRY_RUN" -eq 1 ]]; then
      log "[DRY-RUN] would probe ${label} (${url})"
      return 0
    fi
    code="$(curl -s -o /dev/null -w "%{http_code}" "$url" || true)"
    if [[ "$code" =~ $expected_pattern ]]; then
      log "${label} is responding (HTTP ${code})"
      return 0
    fi
    sleep "$delay"
  done
  warn "${label} did not become ready in time (${url})"
  return 1
}

configure_env() {
  section "Install Configuration"
  local env_path="${INSTALL_DIR}/${ENV_FILE}"
  if [[ ! -f "$env_path" ]]; then
    if [[ ! -f "${INSTALL_DIR}/.env.example" ]]; then
      if [[ "$DRY_RUN" -eq 1 ]]; then
        log "[DRY-RUN] would initialize ${env_path} from ${INSTALL_DIR}/.env.example after cloning the repository"
      else
        die "Missing .env.example in repository."
      fi
    else
      run cp "${INSTALL_DIR}/.env.example" "$env_path"
      success "Created ${env_path} from .env.example"
    fi
  fi

  local ui_port public_url api_base auth_base sharex_enabled auth_enabled turnstile_key turnstile_secret jwt_secret admin_base bootstrap_path token_create_path token_revoke_path register_url admin_bearer passkeys_enabled passkey_rp_name passkey_rp_id passkey_origins resolver_enabled resolve_base
  ui_port="$(prompt "UI port" "$(env_get UI_PORT "$DEFAULT_UI_PORT")")"
  public_url="$(prompt "Public site URL" "$(env_get_nonempty PASTE_URL "$(default_public_url "$ui_port")")")"
  api_base="$(prompt "Paste API base" "$(env_get VITE_PASTE_API "/api")")"
  auth_base="$(prompt "Auth API base" "$(env_get VITE_AUTH_API "/auth")")"
  sharex_enabled="$(prompt "Enable ShareX UI (1=yes, 0=no)" "$(env_get VITE_ENABLE_SHAREX "1")")"
  auth_enabled="$(prompt "Enable account UI (1=yes, 0=no)" "$(env_get VITE_ENABLE_AUTH "1")")"
  turnstile_key="$(prompt "Turnstile site key" "$(env_get VITE_TURNSTILE_SITE_KEY "")")"
  turnstile_secret="$(prompt "Turnstile secret key" "$(env_get TURNSTILE_SECRET_KEY "")")"
  jwt_secret="$(prompt "JWT secret (leave empty to auto-generate)" "$(env_get JWT_SECRET "")")"
  passkeys_enabled="$(prompt "Enable passkeys (1=yes, 0=no)" "$(env_get PASSKEYS_ENABLED "0")")"
  passkey_rp_name="$(prompt "Passkey RP name" "$(env_get PASSKEY_RP_NAME "yaemipaste")")"
  passkey_rp_id="$(prompt "Passkey RP ID (optional)" "$(env_get PASSKEY_RP_ID "")")"
  passkey_origins="$(prompt "Passkey origins CSV (optional)" "$(env_get PASSKEY_ORIGINS "")")"
  resolver_enabled="$(prompt "Enable compatibility resolver (1=yes, 0=no)" "$(env_get RESOLVER_ENABLED "0")")"
  admin_base="$(prompt "Auth admin base URL" "$(env_get_nonempty AUTH_ADMIN_BASE_URL "${public_url%/}/auth/admin")")"
  bootstrap_path="$(prompt "Auth bootstrap path" "$(env_get AUTH_BOOTSTRAP_PATH "/bootstrap")")"
  token_create_path="$(prompt "Auth token create path" "$(env_get AUTH_TOKEN_CREATE_PATH "/tokens")")"
  token_revoke_path="$(prompt "Auth token revoke path" "$(env_get AUTH_TOKEN_REVOKE_PATH "/tokens/%s")")"
  register_url="$(prompt "Register endpoint URL" "$(env_get_nonempty AUTH_REGISTER_URL "${public_url%/}/auth/register")")"
  admin_bearer="$(prompt "Admin bearer token" "$(env_get_nonempty AUTH_ADMIN_BEARER "")")"

  if [[ ! "$sharex_enabled" =~ ^[01]$ ]]; then
    warn "Invalid ShareX toggle '${sharex_enabled}', defaulting to 0"
    sharex_enabled="0"
  fi
  if [[ ! "$auth_enabled" =~ ^[01]$ ]]; then
    warn "Invalid auth toggle '${auth_enabled}', defaulting to 1"
    auth_enabled="1"
  fi
  if [[ ! "$passkeys_enabled" =~ ^[01]$ ]]; then
    warn "Invalid passkeys toggle '${passkeys_enabled}', defaulting to 0"
    passkeys_enabled="0"
  fi
  if [[ ! "$resolver_enabled" =~ ^[01]$ ]]; then
    warn "Invalid resolver toggle '${resolver_enabled}', defaulting to 1"
    resolver_enabled="1"
  fi
  resolve_base="$(env_get VITE_FILE_RESOLVE_BASE "/api/resolve")"
  if [[ "$resolver_enabled" == "0" ]]; then
    if [[ -z "$resolve_base" ]]; then
      resolve_base="/api/resolve"
    fi
    log "Resolver disabled: expecting compatible Rust backend routes at ${resolve_base}."
  elif [[ -z "$resolve_base" ]]; then
    resolve_base="/resolve"
  fi
  if [[ "$auth_enabled" == "0" ]]; then
    if [[ -n "$turnstile_key" || -n "$turnstile_secret" || "$passkeys_enabled" == "1" ]]; then
      warn "Auth disabled: clearing Turnstile/passkey settings for anonymous mode."
    fi
    turnstile_key=""
    turnstile_secret=""
    passkeys_enabled="0"
  fi
  if [[ "$auth_enabled" == "1" && -z "$admin_bearer" ]]; then
    admin_bearer="$(generate_secret)"
    success "Generated admin bearer automatically."
  fi
  if [[ -n "$turnstile_key" && -z "$turnstile_secret" ]]; then
    warn "Turnstile site key set but TURNSTILE_SECRET_KEY is empty; login challenges will fail."
  fi
  if [[ -z "$jwt_secret" ]]; then
    jwt_secret="$(generate_secret)"
    success "Generated JWT secret automatically."
  fi
  upsert_env UI_PORT "$ui_port"
  upsert_env PASTE_URL "$public_url"
  upsert_env PASTE_PUBLIC_API "$(env_get_nonempty PASTE_PUBLIC_API "${public_url%/}/api")"
  upsert_env VITE_PASTE_API "$api_base"
  upsert_env VITE_AUTH_API "$auth_base"
  upsert_env VITE_FILE_RESOLVE_BASE "$resolve_base"
  upsert_env VITE_TOKEN_OWNER_PATH "$(env_get VITE_TOKEN_OWNER_PATH "/api/token-owner")"
  upsert_env VITE_ENABLE_SHAREX "$sharex_enabled"
  upsert_env VITE_ENABLE_AUTH "$auth_enabled"
  upsert_env VITE_TURNSTILE_SITE_KEY "$turnstile_key"
  upsert_env TURNSTILE_SECRET_KEY "$turnstile_secret"
  upsert_env JWT_SECRET "$jwt_secret"
  upsert_env PASSKEYS_ENABLED "$passkeys_enabled"
  upsert_env PASSKEY_RP_NAME "$passkey_rp_name"
  upsert_env PASSKEY_RP_ID "$passkey_rp_id"
  upsert_env PASSKEY_ORIGINS "$passkey_origins"
  upsert_env RESOLVER_ENABLED "$resolver_enabled"
  upsert_env AUTH_ADMIN_BASE_URL "$admin_base"
  upsert_env AUTH_BOOTSTRAP_PATH "$bootstrap_path"
  upsert_env AUTH_TOKEN_CREATE_PATH "$token_create_path"
  upsert_env AUTH_TOKEN_REVOKE_PATH "$token_revoke_path"
  upsert_env AUTH_REGISTER_URL "$register_url"
  upsert_env AUTH_ADMIN_BEARER "$admin_bearer"
}

clone_or_update_repo() {
  if [[ "$REPO_URL" == /* && -d "$REPO_URL" ]]; then
    log "Syncing local source from ${REPO_URL}"
    if [[ -d "$INSTALL_DIR" ]] && [[ -n "$(find "$INSTALL_DIR" -mindepth 1 -maxdepth 1 2>/dev/null | head -n 1)" ]] && [[ ! -f "${INSTALL_DIR}/${COMPOSE_FILE}" ]]; then
      die "Install directory is not empty: ${INSTALL_DIR}"
    fi
    run mkdir -p "$INSTALL_DIR"
    run rsync -a --delete --exclude '.git' "${REPO_URL}/" "${INSTALL_DIR}/"
    return 0
  fi

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
  section "Yaemipaste Install"
  ensure_runtime_prereqs
  safe_install_path "$INSTALL_DIR" || die "Refusing unsafe install path: ${INSTALL_DIR}"
  maybe_use_local_checkout_as_repo
  step "Syncing repository"
  clone_or_update_repo
  configure_env
  section "Starting Stack"
  compose pull || warn "Compose pull failed; continuing with local build"
  compose up -d --build
  local ui_port probe_host
  ui_port="$(env_get UI_PORT "$DEFAULT_UI_PORT")"
  probe_host="127.0.0.1"
  wait_for_http "http://${probe_host}:${ui_port}/" "UI endpoint" '^200$' 60 2 || die "UI endpoint failed readiness check."
  wait_for_http "http://${probe_host}:${ui_port}/auth/sharex" "Auth endpoint" '^(200|400|401)$' 30 2 || die "Auth endpoint failed readiness check."
  wait_for_http "http://${probe_host}:${ui_port}/api/" "Paste endpoint" '^(200|400|401|405)$' 30 2 || die "Paste endpoint failed readiness check."
  success "Yaemipaste install/update completed."
}

stack_start() {
  section "Service Control"
  ensure_runtime_prereqs
  ensure_repo_present
  step "Starting Yaemipaste services"
  compose up -d
  success "Services started."
}

stack_stop() {
  section "Service Control"
  ensure_runtime_prereqs
  ensure_repo_present
  step "Stopping Yaemipaste services"
  compose stop
  success "Services stopped."
}

stack_restart() {
  section "Service Control"
  ensure_runtime_prereqs
  ensure_repo_present
  step "Restarting Yaemipaste services"
  compose restart
  success "Services restarted."
}

stack_status() {
  section "Service Control"
  ensure_runtime_prereqs
  ensure_repo_present
  compose ps
}

read_auth_settings() {
  local inferred_public_url
  inferred_public_url="$(env_get_nonempty PASTE_URL "$(default_public_url "$(env_get UI_PORT "$DEFAULT_UI_PORT")")")"
  AUTH_ADMIN_BASE_URL_VALUE="$(env_get_nonempty AUTH_ADMIN_BASE_URL "${inferred_public_url%/}/auth/admin")"
  AUTH_BOOTSTRAP_PATH_VALUE="$(env_get AUTH_BOOTSTRAP_PATH "/bootstrap")"
  AUTH_TOKEN_CREATE_PATH_VALUE="$(env_get AUTH_TOKEN_CREATE_PATH "/tokens")"
  AUTH_TOKEN_REVOKE_PATH_VALUE="$(env_get AUTH_TOKEN_REVOKE_PATH "/tokens/%s")"
  AUTH_REGISTER_URL_VALUE="$(env_get_nonempty AUTH_REGISTER_URL "${inferred_public_url%/}/auth/register")"
  AUTH_ADMIN_BEARER_VALUE="$(env_get_nonempty AUTH_ADMIN_BEARER "")"
}

read_admin_bearer() {
  local token="${AUTH_ADMIN_BEARER_VALUE}"
  [[ -n "$token" ]] || die "AUTH_ADMIN_BEARER is empty in .env. Set it, restart the stack, then retry."
  printf '%s' "$token"
}

create_initial_user() {
  section "Auth Bootstrap"
  ensure_repo_present
  read_auth_settings
  local username password register_token
  username="$(prompt "Initial username" "")"
  [[ -n "$username" ]] || die "Username is required."
  password="$(prompt_secret "Initial password")"
  [[ -n "$password" ]] || die "Password is required."
  register_token="$(prompt "Registration token (optional)" "")"

  local payload
  payload="{\"username\":\"$(json_escape "$username")\",\"password\":\"$(json_escape "$password")\""
  if [[ -n "$register_token" ]]; then
    payload+=",\"token\":\"$(json_escape "$register_token")\"}"
    http_json POST "$AUTH_REGISTER_URL_VALUE" "$payload"
    expect_2xx || die "Failed to create user using register endpoint."
    success "Initial user created via register endpoint."
    return 0
  fi
  payload+="}"
  local admin_bearer
  admin_bearer="$(read_admin_bearer)"
  local bootstrap_url="${AUTH_ADMIN_BASE_URL_VALUE%/}/${AUTH_BOOTSTRAP_PATH_VALUE#/}"
  http_json POST "$bootstrap_url" "$payload" "$admin_bearer"
  expect_2xx || die "Bootstrap user creation failed. Provide a registration token or verify auth admin endpoint settings."
  success "Initial user created via admin bootstrap endpoint."
}

create_token() {
  section "Token Management"
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
    success "Token created."
  else
    warn "Token endpoint did not return a recognizable token field."
    printf '%s\n' "$HTTP_BODY"
  fi
}

revoke_token() {
  section "Token Management"
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
  success "Token revoked."
}

stack_uninstall() {
  section "Uninstall"
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
      success "Removed ${INSTALL_DIR}"
    else
      warn "Confirmation phrase mismatch. Directory was not removed."
    fi
  fi
}

print_menu() {
  local frame
  frame="$(style "$UI_DIM" "+$(repeat_char "-" "$((UI_RULE_WIDTH + 2))")+")"
  printf '\n%s\n' "$frame"
  printf '%s\n' "$(style "$UI_ACCENT" "$(box_row "Control Center")")"
  printf '%s\n' "$(style "$UI_DIM" "$(box_row "Install dir: ${INSTALL_DIR}")")"
  printf '%s\n' "$(style "$UI_DIM" "$(box_row "Source: ${REPO_URL} (${BRANCH})")")"
  printf '%s\n' "$frame"
  cat <<EOF
  1. Install / Update full stack
  2. Create initial user
  3. Create auth token
  4. Revoke token
  5. Start services
  6. Stop services
  7. Restart services
  8. Service status
  9. Uninstall / cleanup
  0. Exit
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
Yaemipaste installer + runtime manager

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
  setup_ui
  parse_args "$@"
  if [[ "$YES" -eq 0 ]]; then
    print_banner
  fi
  run_action "$ACTION"
}

main "$@"
