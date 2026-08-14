#!/usr/bin/env bash
set -Eeuo pipefail

APP_NAME="yaemipaste"
DEFAULT_REPO_URL="https://github.com/emiliauh/yaemipaste.git"
DEFAULT_BRANCH="main"
DEFAULT_INSTALL_DIR="/opt/yaemipaste"
DEFAULT_UI_PORT="8080"
COMPOSE_FILE="docker-compose.yml"
ENV_FILE=".env"
NETWORK_CHECK_URL="${YAEMIPASTE_NETWORK_CHECK_URL:-https://github.com/}"

INSTALL_DIR="$DEFAULT_INSTALL_DIR"
REPO_URL="$DEFAULT_REPO_URL"
BRANCH="$DEFAULT_BRANCH"
ACTION="menu"
YES=0
ACTION_SET=0
INTERACTIVE_REQUESTED=0
DRY_RUN=0
PUBLIC_URL_OVERRIDE=""
DEPLOYMENT_MODE_OVERRIDE=""
API_ORIGIN_OVERRIDE=""
SPLIT_ROLE_OVERRIDE=""
UI_BIND_OVERRIDE=""

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
INSTALL_DIR_CREATED_THIS_RUN=0
STACK_STARTED_THIS_RUN=0
ROLLBACK_IN_PROGRESS=0

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

rollback_new_install() {
  [[ "$INSTALL_DIR_CREATED_THIS_RUN" -eq 1 && "$DRY_RUN" -eq 0 && "$ROLLBACK_IN_PROGRESS" -eq 0 ]] || return 0
  ROLLBACK_IN_PROGRESS=1
  warn "Installation failed. Reverting the newly created installation at ${INSTALL_DIR}."
  trap - ERR
  set +e
  if [[ "$STACK_STARTED_THIS_RUN" -eq 1 && -f "${INSTALL_DIR}/${COMPOSE_FILE}" ]]; then
    compose down --remove-orphans >/dev/null 2>&1 || warn "Could not fully stop the failed stack; inspect Docker with: docker compose -f ${INSTALL_DIR}/${COMPOSE_FILE} ps"
  fi
  safe_install_path "$INSTALL_DIR" && rm -rf "$INSTALL_DIR" || warn "Could not remove ${INSTALL_DIR}; remove it manually after reviewing its contents."
  set -e
}

on_exit() {
  local status="$1"
  if [[ "$status" -ne 0 ]]; then
    rollback_new_install
  fi
}

trap 'on_exit "$?"' EXIT

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

network_failure_message() {
  local purpose="$1"
  local detail="${2:-}"
  error "Internet access is required to ${purpose}."
  [[ -n "$detail" ]] && error "$detail"
  error "Check DNS, firewall or security-group rules, and proxy/VPN settings. Cloudflare WARP can route traffic through a virtual interface or reset connections; pause or disconnect it, then retry."
}

ensure_internet_access() {
  local purpose="$1"
  [[ "$DRY_RUN" -eq 1 ]] && return 0
  local output=""
  if command_exists curl; then
    if output="$(curl -fsS --connect-timeout 5 --max-time 10 -o /dev/null "$NETWORK_CHECK_URL" 2>&1)"; then
      return 0
    fi
  elif command_exists timeout; then
    if timeout 10 bash -c ':</dev/tcp/github.com/443' 2>/dev/null; then
      return 0
    fi
    output="Could not establish a TCP connection to github.com:443"
  else
    output="Install curl or timeout so the installer can verify connectivity."
  fi
  network_failure_message "$purpose" "$output"
  die "Installation stopped before making network-dependent changes."
}

apt_install_packages() {
  local packages=("$@")
  [[ ${#packages[@]} -gt 0 ]] || return 0
  ensure_internet_access "install system packages (${packages[*]})"
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
  if [[ -r /dev/urandom ]] && command_exists od; then
    od -An -N32 -tx1 /dev/urandom | tr -d ' \n'
    return 0
  fi
  die "Unable to generate a secure secret. Install openssl or provide /dev/urandom + od."
}

valid_installer_secret() {
  local value="$1"
  [[ "$value" =~ ^[a-f0-9]{64}$ ]] || return 1
  # Match the backend's production guard: a repeated character is not a secret.
  local first="${value:0:1}"
  [[ "${value//"$first"/}" != "" ]]
}

valid_admin_bearers() {
  local value="$1"
  local item
  local -a bearers
  [[ -n "$value" ]] || return 1
  IFS=',' read -r -a bearers <<< "$value"
  [[ "${#bearers[@]}" -gt 0 ]] || return 1
  for item in "${bearers[@]}"; do
    item="${item#${item%%[![:space:]]*}}"
    item="${item%${item##*[![:space:]]}}"
    valid_installer_secret "$item" || return 1
  done
}

detect_host_address() {
  local value=""
  if command_exists ip; then
    value="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i <= NF; i += 1) if ($i == "src") { print $(i + 1); exit }}' || true)"
  fi
  if [[ -z "$value" ]] && command_exists hostname; then
    value="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
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

valid_origin() {
  [[ "$1" =~ ^https?://[^/?#]+/?$ ]]
}

is_ip_origin() {
  local authority="${1#*://}"
  authority="${authority%/}"
  [[ "$authority" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}(:[0-9]+)?$ || "$authority" =~ ^\[[0-9A-Fa-f:]+\](:[0-9]+)?$ ]]
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
  local env_path="${INSTALL_DIR}/${ENV_FILE}"
  if [[ ! -f "$env_path" ]]; then
    if [[ "$DRY_RUN" -eq 1 ]]; then
      log "[DRY-RUN] would load Compose environment from ${env_path}"
    else
      die "Environment file not found at ${env_path}. Run the install action first so secrets are generated."
    fi
  fi
  local resolver_enabled profiles profile image_mode
  local -a profile_list
  local -a profile_args
  resolver_enabled="$(env_get RESOLVER_ENABLED "0")"
  profile_args=()
  if [[ "$resolver_enabled" != "0" ]]; then
    profile_args=(--profile with-resolver)
  fi
  profiles="$(env_get COMPOSE_PROFILES "ui,api")"
  IFS=',' read -r -a profile_list <<< "$profiles"
  for profile in "${profile_list[@]}"; do
    [[ -n "$profile" ]] && profile_args+=(--profile "$profile")
  done
  image_mode="$(env_get DEPLOYMENT_IMAGE_MODE "pull")"
  local -a compose_args=(--env-file "$env_path" --project-directory "$INSTALL_DIR")
  local -a compose_files=(-f "${INSTALL_DIR}/${COMPOSE_FILE}")
  if [[ "$image_mode" == "build" ]]; then
    compose_files+=(-f "${INSTALL_DIR}/docker-compose.build.yml")
  fi
  run "${COMPOSE_CMD[@]}" "${compose_args[@]}" "${compose_files[@]}" --project-name "$APP_NAME" "${profile_args[@]}" "$@"
}

compose_for_uninstall() {
  [[ ${#COMPOSE_CMD[@]} -gt 0 ]] || detect_compose_cmd
  local uninstall_env down_status=0 purge_status=0
  uninstall_env="$(mktemp)"
  # `down` must still work when the installation .env is incomplete or corrupt.
  # Keep production validation in compose(); these placeholders only satisfy
  # Compose interpolation while it removes the existing project resources.
  # Compose still validates required image-tag interpolation during `down`.
  # Use safe placeholders so cleanup works even when .env is incomplete.
  printf 'JWT_SECRET=uninstall-placeholder\nAUTH_ADMIN_BEARER=uninstall-placeholder\nYAEMIPASTE_IMAGE_TAG=uninstall-placeholder\n' > "$uninstall_env"
  if run "${COMPOSE_CMD[@]}" --env-file "$uninstall_env" --project-directory "$INSTALL_DIR" -f "${INSTALL_DIR}/${COMPOSE_FILE}" --project-name "$APP_NAME" down "$@"; then
    :
  else
    down_status=$?
    warn "Compose cleanup returned exit ${down_status}; checking for remaining ${APP_NAME} containers."
  fi
  rm -f "$uninstall_env"
  if purge_compose_project_containers; then
    :
  else
    purge_status=$?
  fi
  [[ "$down_status" -eq 0 ]] || return "$down_status"
  return "$purge_status"
}

purge_compose_project_containers() {
  [[ "$DRY_RUN" -eq 1 ]] && return 0
  command_exists docker || {
    warn "Docker is unavailable while verifying ${APP_NAME} container cleanup."
    return 1
  }
  local container_output
  if ! container_output="$(docker ps -aq --filter "label=com.docker.compose.project=${APP_NAME}" 2>/dev/null)"; then
    warn "Could not inspect Docker containers for ${APP_NAME}."
    return 1
  fi
  [[ -n "$container_output" ]] || return 0
  local -a container_ids=()
  mapfile -t container_ids <<< "$container_output"
  warn "Removing ${#container_ids[@]} remaining ${APP_NAME} container(s)."
  run docker rm -f "${container_ids[@]}"
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
  if [[ "$DRY_RUN" -eq 1 ]]; then
    local display_value="$value"
    case "$key" in
      JWT_SECRET|TURNSTILE_SECRET_KEY|AUTH_ADMIN_BEARER|*PASSWORD*|*SECRET*) display_value="<redacted>" ;;
    esac
    printf '[DRY-RUN] set %s=%s in %s\n' "$key" "$display_value" "$file"
    return 0
  fi
  if [[ ! -f "$file" ]]; then
    run install -m 0600 "${INSTALL_DIR}/.env.example" "$file"
  fi
  [[ "$value" != *$'\n'* && "$value" != *$'\r'* ]] || die "Environment values cannot contain newlines."
  if grep -q -E "^${key}=" "$file"; then
    local temp_file
    temp_file="$(mktemp)"
    awk -v key="$key" -v value="$value" 'index($0, key "=") == 1 { print key "=" value; next } { print }' "$file" > "$temp_file"
    run mv "$temp_file" "$file"
  else
    printf '\n%s=%s\n' "$key" "$value" >> "$file"
  fi
  run chmod 0600 "$file"
}

http_json() {
  local method="$1"
  local url="$2"
  local payload="${3:-}"
  local bearer="${4:-}"
  local response_file error_file curl_exit
  response_file="$(mktemp)"
  error_file="$(mktemp)"
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
    rm -f "$response_file" "$error_file"
    return 0
  fi
  if HTTP_STATUS="$(curl -sS --connect-timeout 10 --max-time 30 -o "$response_file" -w "%{http_code}" -X "$method" "${headers[@]}" "$url" 2>"$error_file")"; then
    :
  else
    curl_exit=$?
    network_failure_message "contact ${url}" "curl exited ${curl_exit}: $(tr '\n' ' ' < "$error_file")"
    rm -f "$response_file" "$error_file"
    die "Request could not be completed. No partial installation was kept."
  fi
  HTTP_BODY="$(cat "$response_file")"
  rm -f "$response_file" "$error_file"
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

extract_detail_from_json() {
  local body="$1"
  if command_exists jq; then
    jq -r '.detail // .error // .message // empty' <<<"$body" 2>/dev/null
    return 0
  fi
  sed -nE 's/.*"(detail|error|message)"[[:space:]]*:[[:space:]]*"([^"]+)".*/\2/p' <<<"$body" | head -n 1
}

wait_for_http() {
  local url="$1"
  local label="$2"
  local expected_pattern='^2[0-9][0-9]$'
  local attempts="${4:-30}"
  local delay="${5:-2}"
  local code="" curl_error="" error_file=""
  local i
  if [[ $# -ge 3 && -n "$3" ]]; then
    expected_pattern="$3"
  fi
  for ((i = 1; i <= attempts; i += 1)); do
    if [[ "$DRY_RUN" -eq 1 ]]; then
      log "[DRY-RUN] would probe ${label} (${url})"
      return 0
    fi
    error_file="$(mktemp)"
    code="$(curl -sS --connect-timeout 5 --max-time 10 -o /dev/null -w "%{http_code}" "$url" 2>"$error_file" || true)"
    if [[ "$code" =~ $expected_pattern ]]; then
      log "${label} is responding (HTTP ${code})"
      rm -f "$error_file"
      return 0
    fi
    [[ -s "$error_file" ]] && curl_error="$(tr '\n' ' ' < "$error_file")" || curl_error=""
    rm -f "$error_file"
    [[ -n "$curl_error" ]] && warn "Waiting for ${label}: ${curl_error}"
    sleep "$delay"
  done
  warn "${label} did not become ready in time (${url}). Check Docker logs with: docker compose --env-file ${INSTALL_DIR}/${ENV_FILE} --project-directory ${INSTALL_DIR} -f ${INSTALL_DIR}/${COMPOSE_FILE} logs"
  return 1
}

configure_env() {
  section "Install Configuration"
  local env_path="${INSTALL_DIR}/${ENV_FILE}"
  local env_created=0
  if [[ ! -f "$env_path" ]]; then
    if [[ ! -f "${INSTALL_DIR}/.env.example" ]]; then
      if [[ "$DRY_RUN" -eq 1 ]]; then
        log "[DRY-RUN] would initialize ${env_path} from ${INSTALL_DIR}/.env.example after cloning the repository"
      else
        die "Missing .env.example in repository."
      fi
    else
      run install -m 0600 "${INSTALL_DIR}/.env.example" "$env_path"
      env_created=1
      success "Created ${env_path} from .env.example"
    fi
  fi
  if [[ "$DRY_RUN" -eq 0 ]]; then
    run chmod 0600 "$env_path"
  fi

  local ui_port public_url api_base auth_base sharex_enabled auth_enabled turnstile_key turnstile_secret jwt_secret admin_base bootstrap_path token_create_path token_revoke_path claim_init_path register_url admin_bearer passkeys_enabled passkey_rp_name passkey_rp_id passkey_origins resolver_enabled resolve_base deployment_mode split_role api_origin ui_bind cors_origins csp_connect auth_admin_origin internal_admin_origin configure_features turnstile_enabled direct_ip_access api_port image_tag
  deployment_mode="$(prompt "Deployment mode (same or split)" "${DEPLOYMENT_MODE_OVERRIDE:-$(env_get DEPLOYMENT_MODE "same")}")"
  [[ "$deployment_mode" =~ ^(same|split)$ ]] || die "Deployment mode must be same or split."
  split_role="$(env_get SPLIT_ROLE "")"
  if [[ "$deployment_mode" == "split" ]]; then
    split_role="$(prompt "Split deployment role (ui or api)" "${SPLIT_ROLE_OVERRIDE:-${split_role:-ui}}")"
    [[ "$split_role" =~ ^(ui|api)$ ]] || die "Split deployment role must be ui or api."
  else
    split_role=""
  fi
  ui_port="$(env_get UI_PORT "$DEFAULT_UI_PORT")"
  [[ "$ui_port" =~ ^[1-9][0-9]{0,4}$ ]] && (( ui_port <= 65535 )) || die "UI port must be between 1 and 65535."
  public_url="$(prompt "Public site URL (HTTPS preferred; HTTP/IP supported)" "${PUBLIC_URL_OVERRIDE:-$(env_get_nonempty PASTE_URL "$(default_public_url "$ui_port")")}")"
  valid_origin "$public_url" || die "Public site URL must be an origin such as https://paste.example.com or http://192.0.2.10:8080."
  if is_ip_origin "$public_url"; then
    warn "An IP-based public URL cannot be verified from this host. Confirm it is reachable from another network; VPNs such as Cloudflare WARP can select an unreachable virtual address."
  fi
  if [[ "$public_url" == http://* ]]; then
    warn "Using HTTP for the public URL. HTTPS with a DNS name is recommended for internet-facing deployments."
  fi
  ui_bind="${UI_BIND_OVERRIDE:-$(env_get UI_BIND_ADDRESS "127.0.0.1")}"
  if [[ -z "$UI_BIND_OVERRIDE" && "$ui_bind" == "127.0.0.1" ]] && is_ip_origin "$public_url"; then
    direct_ip_access="$(prompt "Expose UI directly on this IP (1=yes, 0=no)" "1")"
    if [[ "$direct_ip_access" == "1" ]]; then
      ui_bind="0.0.0.0"
    elif [[ "$direct_ip_access" != "0" ]]; then
      warn "Invalid direct IP choice '${direct_ip_access}', keeping the UI loopback-bound."
    fi
  fi
  api_origin="$(env_get_nonempty PASTE_PUBLIC_API "")"
  if [[ "$deployment_mode" == "split" ]]; then
    api_origin="$(prompt "Public API origin (HTTPS preferred; HTTP/IP supported)" "${API_ORIGIN_OVERRIDE:-$api_origin}")"
    valid_origin "$api_origin" || die "Split API origin must be an origin such as https://api.example.com or http://192.0.2.10:8000."
    api_origin="${api_origin%/}"
    api_base="$api_origin"
    auth_base="$api_origin/auth"
    resolve_base="$api_origin/resolve"
    cors_origins="$public_url"
    csp_connect="$api_origin"
  else
    api_origin="${public_url%/}/api"
    api_base="/api"
    auth_base="/auth"
    resolve_base="/api/resolve"
    cors_origins=""
    csp_connect=""
  fi
  auth_admin_origin="$public_url"
  if [[ "$deployment_mode" == "split" ]]; then
    auth_admin_origin="$api_origin"
  fi
  # Installer control-plane calls stay on the local listener. This avoids a
  # WSL/Windows NAT hairpin through a LAN address while preserving public URLs
  # for browser-facing links and registration.
  internal_admin_origin="http://127.0.0.1:${ui_port}"
  if [[ "$deployment_mode" == "split" && "$split_role" == "api" ]]; then
    api_port="$(env_get API_PUBLISH_PORT "8000")"
    internal_admin_origin="http://127.0.0.1:${api_port}"
  fi
  sharex_enabled="$(env_get VITE_ENABLE_SHAREX "1")"
  auth_enabled="$(env_get VITE_ENABLE_AUTH "1")"
  turnstile_key="$(env_get VITE_TURNSTILE_SITE_KEY "")"
  turnstile_secret="$(env_get TURNSTILE_SECRET_KEY "")"
  passkeys_enabled="$(env_get PASSKEYS_ENABLED "0")"
  passkey_rp_name="$(env_get PASSKEY_RP_NAME "yaemipaste")"
  passkey_rp_id="$(env_get PASSKEY_RP_ID "")"
  passkey_origins="$(env_get PASSKEY_ORIGINS "")"
  resolver_enabled="$(env_get RESOLVER_ENABLED "0")"
  configure_features="$(prompt "Configure optional features (1=yes, 0=no)" "0")"

  if [[ ! "$configure_features" =~ ^[01]$ ]]; then
    warn "Invalid optional feature choice '${configure_features}', keeping defaults."
    configure_features="0"
  fi
  if [[ "$configure_features" == "1" ]]; then
    sharex_enabled="$(prompt "Enable ShareX UI (1=yes, 0=no)" "$sharex_enabled")"
    auth_enabled="$(prompt "Enable account UI (1=yes, 0=no)" "$auth_enabled")"
    turnstile_enabled="0"
    [[ -n "$turnstile_key" || -n "$turnstile_secret" ]] && turnstile_enabled="1"
    turnstile_enabled="$(prompt "Enable Turnstile (1=yes, 0=no)" "$turnstile_enabled")"
    if [[ ! "$turnstile_enabled" =~ ^[01]$ ]]; then
      warn "Invalid Turnstile toggle '${turnstile_enabled}', disabling Turnstile."
      turnstile_enabled="0"
    fi
    if [[ "$turnstile_enabled" == "1" ]]; then
      turnstile_key="$(prompt "Turnstile site key" "$turnstile_key")"
      turnstile_secret="$(prompt "Turnstile secret key" "$turnstile_secret")"
    else
      turnstile_key=""
      turnstile_secret=""
    fi
    passkeys_enabled="$(prompt "Enable passkeys (1=yes, 0=no)" "$passkeys_enabled")"
    if [[ "$passkeys_enabled" == "1" ]]; then
      passkey_rp_name="$(prompt "Passkey RP name" "$passkey_rp_name")"
      passkey_rp_id="$(prompt "Passkey RP ID (optional)" "$passkey_rp_id")"
      passkey_origins="$(prompt "Passkey origins CSV (optional)" "$passkey_origins")"
    else
      passkey_rp_id=""
      passkey_origins=""
    fi
  fi

  jwt_secret="$(env_get JWT_SECRET "")"
  admin_base="$(env_get_nonempty AUTH_ADMIN_BASE_URL "${internal_admin_origin%/}/auth/admin")"
  bootstrap_path="$(env_get AUTH_BOOTSTRAP_PATH "/bootstrap")"
  token_create_path="$(env_get AUTH_TOKEN_CREATE_PATH "/tokens")"
  token_revoke_path="$(env_get AUTH_TOKEN_REVOKE_PATH "/tokens/%s")"
  claim_init_path="$(env_get AUTH_ADMIN_CLAIM_INIT_PATH "/claim/init")"
  register_url="$(env_get_nonempty AUTH_REGISTER_URL "${auth_admin_origin%/}/auth/register")"
  admin_bearer="$(env_get_nonempty AUTH_ADMIN_BEARER "")"

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
    warn "Invalid resolver toggle '${resolver_enabled}', defaulting to 0"
    resolver_enabled="0"
  fi
  resolve_base="${resolve_base:-$(env_get VITE_FILE_RESOLVE_BASE "/api/resolve")}"
  if [[ "$resolver_enabled" == "0" ]]; then
    if [[ -z "$resolve_base" ]]; then
      resolve_base="/api/resolve"
    fi
    log "Resolver disabled: expecting compatible NestJS backend routes at ${resolve_base}."
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
  if [[ -z "$admin_bearer" ]]; then
    admin_bearer="$(generate_secret)"
    success "Generated admin bearer automatically."
  elif ! valid_admin_bearers "$admin_bearer"; then
    if [[ "$env_created" -eq 1 ]]; then
      die "AUTH_ADMIN_BEARER in .env.example is invalid. It must be a 64-character lowercase hex secret."
    fi
    die "AUTH_ADMIN_BEARER in ${env_path} is invalid for production. Replace it with a 64-character lowercase hex secret, then rerun the installer."
  fi
  if [[ -n "$turnstile_key" && -z "$turnstile_secret" ]]; then
    warn "Turnstile site key set but TURNSTILE_SECRET_KEY is empty; the secret is what enables enforcement, so the widget will not run and logins will succeed without any challenge. Set a secret to actually enable Turnstile."
  fi
  if [[ -n "$turnstile_secret" && -z "$turnstile_key" ]]; then
    warn "TURNSTILE_SECRET_KEY is set but no Turnstile site key is configured; the login form has no widget to solve, so the login page will show 'Security check is misconfigured on the server' and no one can log in. Set a site key or clear TURNSTILE_SECRET_KEY."
  fi
  if [[ -z "$jwt_secret" ]]; then
    jwt_secret="$(generate_secret)"
    success "Generated JWT secret automatically."
  elif ! valid_installer_secret "$jwt_secret"; then
    if [[ "$env_created" -eq 1 ]]; then
      die "JWT_SECRET in .env.example is invalid. It must be a 64-character lowercase hex secret."
    fi
    die "JWT_SECRET in ${env_path} is invalid for production. Replace it with a 64-character lowercase hex secret, then rerun the installer."
  fi
  upsert_env DEPLOYMENT_MODE "$deployment_mode"
  upsert_env SPLIT_ROLE "$split_role"
  if [[ "$deployment_mode" == "split" ]]; then
    upsert_env COMPOSE_PROFILES "$split_role"
    upsert_env API_UPSTREAM "$api_origin"
  else
    upsert_env COMPOSE_PROFILES "ui,api"
    upsert_env API_UPSTREAM "http://paste-api:8000"
  fi
  upsert_env UI_BIND_ADDRESS "$ui_bind"
  upsert_env UI_PORT "$ui_port"
  upsert_env PASTE_URL "$public_url"
  upsert_env PASTE_PUBLIC_API "$api_origin"
  upsert_env VITE_PASTE_API "$api_base"
  upsert_env VITE_AUTH_API "$auth_base"
  upsert_env VITE_FILE_RESOLVE_BASE "$resolve_base"
  upsert_env CORS_ALLOWED_ORIGINS "$cors_origins"
  upsert_env CSP_CONNECT_SRC "$csp_connect"
  upsert_env VITE_ENABLE_SHAREX "$sharex_enabled"
  upsert_env VITE_ENABLE_AUTH "$auth_enabled"
  upsert_env VITE_PUBLIC_META_CACHE_BUST "$(env_get_nonempty VITE_PUBLIC_META_CACHE_BUST "1")"
  upsert_env VITE_TURNSTILE_SITE_KEY "$turnstile_key"
  upsert_env TURNSTILE_SECRET_KEY "$turnstile_secret"
  local csp_turnstile_src=""
  if [[ -n "$turnstile_secret" ]]; then
    csp_turnstile_src="https://challenges.cloudflare.com"
  fi
  upsert_env CSP_TURNSTILE_SRC "$csp_turnstile_src"
  upsert_env JWT_SECRET "$jwt_secret"
  upsert_env PASSKEYS_ENABLED "$passkeys_enabled"
  upsert_env PASSKEY_RP_NAME "$passkey_rp_name"
  upsert_env PASSKEY_RP_ID "$passkey_rp_id"
  upsert_env PASSKEY_ORIGINS "$passkey_origins"
  upsert_env RESOLVER_ENABLED "$resolver_enabled"
  if [[ "$deployment_mode" == "split" || "$resolver_enabled" != "0" ]]; then
    upsert_env DEPLOYMENT_IMAGE_MODE "build"
  else
    upsert_env DEPLOYMENT_IMAGE_MODE "$(env_get DEPLOYMENT_IMAGE_MODE "pull")"
  fi
  image_tag="$(env_get_nonempty YAEMIPASTE_IMAGE_TAG "")"
  # Move existing installs from the retired branch tag to main. Preserve an
  # explicit custom or SHA tag because production operators may pin images.
  if [[ -z "$image_tag" || ( "$BRANCH" == "$DEFAULT_BRANCH" && "$image_tag" == "nestjs-rewrite" ) ]]; then
    image_tag="$BRANCH"
  fi
  upsert_env YAEMIPASTE_IMAGE_TAG "$image_tag"
  upsert_env AUTH_ADMIN_BASE_URL "$admin_base"
  upsert_env AUTH_BOOTSTRAP_PATH "$bootstrap_path"
  upsert_env AUTH_TOKEN_CREATE_PATH "$token_create_path"
  upsert_env AUTH_TOKEN_REVOKE_PATH "$token_revoke_path"
  upsert_env AUTH_ADMIN_CLAIM_INIT_PATH "$claim_init_path"
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
    # Keep local configuration and Git metadata while matching the source tree.
    run find "$INSTALL_DIR" -mindepth 1 -maxdepth 1 ! -name '.git' ! -name '.env' ! -name '.env.*' -exec rm -rf {} +
    local source_entry source_name
    shopt -s dotglob nullglob
    for source_entry in "$REPO_URL"/*; do
      source_name="${source_entry##*/}"
      [[ "$source_name" == '.git' || "$source_name" == '.env' || ( "$source_name" == .env.* && "$source_name" != '.env.example' ) ]] && continue
      run cp -a "$source_entry" "$INSTALL_DIR/"
    done
    shopt -u dotglob nullglob
    return 0
  fi

  if [[ -d "${INSTALL_DIR}/.git" ]]; then
    log "Updating existing repository at ${INSTALL_DIR}"
    ensure_internet_access "update the repository"
    run git -C "$INSTALL_DIR" fetch --prune origin
    run git -C "$INSTALL_DIR" checkout "$BRANCH"
    run git -C "$INSTALL_DIR" pull --ff-only origin "$BRANCH"
    return 0
  fi

  if [[ -d "$INSTALL_DIR" ]] && [[ -n "$(find "$INSTALL_DIR" -mindepth 1 -maxdepth 1 2>/dev/null | head -n 1)" ]]; then
    die "Install directory is not empty: ${INSTALL_DIR}"
  fi

  run mkdir -p "$INSTALL_DIR"
  ensure_internet_access "clone the repository"
  run git clone --branch "$BRANCH" --single-branch "$REPO_URL" "$INSTALL_DIR"
}

stack_install_or_update() {
  section "Yaemipaste Install"
  ensure_runtime_prereqs
  safe_install_path "$INSTALL_DIR" || die "Refusing unsafe install path: ${INSTALL_DIR}"
  [[ ! -e "$INSTALL_DIR" ]] && INSTALL_DIR_CREATED_THIS_RUN=1
  maybe_use_local_checkout_as_repo
  step "Syncing repository"
  clone_or_update_repo
  configure_env
  section "Starting Stack"
  local image_mode
  image_mode="$(env_get DEPLOYMENT_IMAGE_MODE "pull")"
  if [[ "$image_mode" == "build" ]]; then
    warn "Local image builds are enabled; dependency installation and compilation may take several minutes."
    ensure_internet_access "build Docker images and download build dependencies"
    STACK_STARTED_THIS_RUN=1
    compose up -d --build
  else
    ensure_internet_access "pull Docker images"
    compose pull
    STACK_STARTED_THIS_RUN=1
    compose up -d
  fi
  local ui_port api_port probe_host deployment_mode split_role
  ui_port="$(env_get UI_PORT "$DEFAULT_UI_PORT")"
  api_port="$(env_get API_PUBLISH_PORT "8000")"
  deployment_mode="$(env_get DEPLOYMENT_MODE "same")"
  split_role="$(env_get SPLIT_ROLE "")"
  probe_host="127.0.0.1"
  if [[ "$deployment_mode" == "split" && "$split_role" == "api" ]]; then
    wait_for_http "http://${probe_host}:${api_port}/auth/admin/public-settings" "API auth endpoint" '^200$' 60 2 || die "API endpoint failed readiness check."
  else
    wait_for_http "http://${probe_host}:${ui_port}/" "UI endpoint" '^200$' 60 2 || die "UI endpoint failed readiness check."
    for route in /files /history /login /register /admin; do
      wait_for_http "http://${probe_host}:${ui_port}${route}" "UI route ${route}" '^200$' 30 2 || die "UI route ${route} failed readiness check."
    done
    wait_for_http "http://${probe_host}:${ui_port}/auth/sharex" "Auth endpoint" '^(200|400|401)$' 30 2 || die "Auth endpoint failed readiness check."
    wait_for_http "http://${probe_host}:${ui_port}/api/" "Paste endpoint" '^(200|400|401|405)$' 30 2 || die "Paste endpoint failed readiness check."
  fi
  if [[ "$(env_get VITE_ENABLE_AUTH "1")" == "1" && ! ( "$deployment_mode" == "split" && "$split_role" == "api" ) ]]; then
    init_admin_claim 0
  fi
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
  local inferred_public_url deployment_mode split_role ui_port api_port inferred_admin_origin
  inferred_public_url="$(env_get_nonempty PASTE_URL "$(default_public_url "$(env_get UI_PORT "$DEFAULT_UI_PORT")")")"
  deployment_mode="$(env_get DEPLOYMENT_MODE "same")"
  split_role="$(env_get SPLIT_ROLE "")"
  ui_port="$(env_get UI_PORT "$DEFAULT_UI_PORT")"
  inferred_admin_origin="http://127.0.0.1:${ui_port}"
  if [[ "$deployment_mode" == "split" && "$split_role" == "api" ]]; then
    api_port="$(env_get API_PUBLISH_PORT "8000")"
    inferred_admin_origin="http://127.0.0.1:${api_port}"
  fi
  AUTH_ADMIN_BASE_URL_VALUE="$(env_get_nonempty AUTH_ADMIN_BASE_URL "${inferred_admin_origin%/}/auth/admin")"
  AUTH_BOOTSTRAP_PATH_VALUE="$(env_get AUTH_BOOTSTRAP_PATH "/bootstrap")"
  AUTH_TOKEN_CREATE_PATH_VALUE="$(env_get AUTH_TOKEN_CREATE_PATH "/tokens")"
  AUTH_TOKEN_REVOKE_PATH_VALUE="$(env_get AUTH_TOKEN_REVOKE_PATH "/tokens/%s")"
  AUTH_ADMIN_CLAIM_INIT_PATH_VALUE="$(env_get AUTH_ADMIN_CLAIM_INIT_PATH "/claim/init")"
  AUTH_REGISTER_URL_VALUE="$(env_get_nonempty AUTH_REGISTER_URL "${inferred_public_url%/}/auth/register")"
  AUTH_ADMIN_BEARER_VALUE="$(env_get_nonempty AUTH_ADMIN_BEARER "")"
}

read_admin_bearer() {
  local token="${AUTH_ADMIN_BEARER_VALUE}"
  if [[ -z "$token" && "$DRY_RUN" -eq 1 ]]; then
    log "[DRY-RUN] AUTH_ADMIN_BEARER not found in .env; using a placeholder for the dry-run request."
    printf 'dry-run-placeholder-bearer'
    return 0
  fi
  [[ -n "$token" ]] || die "AUTH_ADMIN_BEARER is empty in .env. Set it, restart the stack, then retry."
  # The backend accepts a comma-separated rotation set, while each request
  # still carries exactly one Bearer token. Use the first configured key for
  # installer calls and leave the full CSV intact in Compose.
  token="${token%%,*}"
  token="${token#${token%%[![:space:]]*}}"
  token="${token%${token##*[![:space:]]}}"
  [[ -n "$token" ]] || die "AUTH_ADMIN_BEARER has no usable bearer in .env."
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

print_admin_claim_instructions() {
  local token="$1"
  local public_url
  public_url="$(env_get_nonempty PASTE_URL "$(default_public_url "$(env_get UI_PORT "$DEFAULT_UI_PORT")")")"
  printf '\n'
  section "Admin Claim Token"
  printf 'Open this URL and claim the first administrator:\n%s/admin/claim\n\n' "${public_url%/}"
  printf 'One-time claim token (shown once):\n%s\n\n' "$token"
  warn "Store this token temporarily in a password manager. It is not stored in plaintext and cannot be shown again."
}

init_admin_claim() {
  local reset="${1:-0}"
  section "Admin Claim"
  if [[ "$DRY_RUN" -eq 0 ]]; then
    ensure_repo_present
  fi
  read_auth_settings
  local admin_bearer claim_url payload detail
  admin_bearer="$(read_admin_bearer)"
  claim_url="${AUTH_ADMIN_BASE_URL_VALUE%/}/${AUTH_ADMIN_CLAIM_INIT_PATH_VALUE#/}"
  payload="{\"reset\":$([[ "$reset" -eq 1 ]] && printf true || printf false)}"
  if [[ "$DRY_RUN" -eq 1 ]]; then
    log "[DRY-RUN] would request admin claim initialization at ${claim_url}"
    log "[DRY-RUN] reset=$([[ "$reset" -eq 1 ]] && printf true || printf false); existing admin/pending claim state would be preserved unless reset is true."
    print_admin_claim_instructions "dry-run-claim-token-not-valid"
    return 0
  fi
  http_json POST "$claim_url" "$payload" "$admin_bearer"
  if [[ "$HTTP_STATUS" == "409" ]]; then
    detail="$(extract_detail_from_json "$HTTP_BODY")"
    [[ -n "$detail" ]] || detail="$HTTP_BODY"
    if [[ "$detail" == *"administrator already exists"* ]]; then
      log "Administrator already exists; no new claim token is needed."
      log "Sign in with the existing administrator account. AUTH_ADMIN_BEARER is for installer requests, not admin-panel login."
    else
      warn "Admin claim token was not generated: ${detail}"
      if [[ "$reset" -eq 0 ]]; then
        warn "Existing claim state was left unchanged. Use --action reset-admin-claim only when no administrator exists and the pending token was lost."
      fi
    fi
    return 0
  fi
  expect_2xx || die "Admin claim initialization failed."
  local created
  created="$(extract_token_from_json "$HTTP_BODY")"
  if [[ -z "$created" ]]; then
    warn "Claim endpoint did not return a token. Response:"
    printf '%s\n' "$HTTP_BODY"
    return 0
  fi
  print_admin_claim_instructions "$created"
}

stack_uninstall() {
  section "Uninstall"
  safe_install_path "$INSTALL_DIR" || die "Refusing unsafe uninstall path: ${INSTALL_DIR}"
  local install_path_present=0 compose_file_present=0
  [[ -e "$INSTALL_DIR" ]] && install_path_present=1
  [[ -f "${INSTALL_DIR}/${COMPOSE_FILE}" ]] && compose_file_present=1
  if [[ "$install_path_present" -eq 0 ]]; then
    warn "${APP_NAME} has no install directory at ${INSTALL_DIR}; no Docker resources were changed."
    return 0
  fi
  ensure_runtime_prereqs
  if [[ "$compose_file_present" -eq 0 ]]; then
    warn "No ${COMPOSE_FILE} found at ${INSTALL_DIR}; treating it as a partial installation."
  fi
  if ! confirm "This will stop ${APP_NAME} services. Continue?" n; then
    log "Cancelled."
    return 0
  fi
  if [[ "$compose_file_present" -eq 1 ]]; then
    if confirm "Remove Docker volumes too? (destructive)" n; then
      if ! compose_for_uninstall --volumes --remove-orphans; then
        die "Could not fully stop and remove ${APP_NAME} containers. The install directory was kept for recovery."
      fi
    else
      if ! compose_for_uninstall --remove-orphans; then
        die "Could not fully stop and remove ${APP_NAME} containers. The install directory was kept for recovery."
      fi
    fi
  elif ! purge_compose_project_containers; then
    die "Could not verify cleanup of ${APP_NAME} containers. The partial install directory was kept for recovery."
  fi
  if confirm "Delete install directory ${INSTALL_DIR}?" n; then
    local check
    if [[ "$YES" -eq 1 ]]; then
      check="DELETE"
    else
      check="$(prompt "Type DELETE to confirm directory removal" "")"
    fi
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
  printf '%s\n' "$(style "$UI_DIM" "$(box_row "Install dir: ${INSTALL_DIR} (c to change)")")"
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
  9. Generate admin claim token
  10. Reset admin claim token
  11. Uninstall / cleanup
  0. Exit
EOF
}

run_action() {
  case "$1" in
    install) stack_install_or_update ;;
    init-user) create_initial_user ;;
    create-token) create_token ;;
    revoke-token) revoke_token ;;
    admin-claim) init_admin_claim 0 ;;
    reset-admin-claim) init_admin_claim 1 ;;
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
          c|C)
            INSTALL_DIR="$(prompt "Install dir (Enter to save)" "$INSTALL_DIR")"
            ;;
          1) stack_install_or_update ;;
          2) create_initial_user ;;
          3) create_token ;;
          4) revoke_token ;;
          5) stack_start ;;
          6) stack_stop ;;
          7) stack_restart ;;
          8) stack_status ;;
          9) init_admin_claim 0 ;;
          10) init_admin_claim 1 ;;
          11) stack_uninstall ;;
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
  --action <install|init-user|create-token|revoke-token|admin-claim|reset-admin-claim|start|stop|restart|status|uninstall|menu>
  --interactive          Launch the guided shell menu (default when no action is supplied)
  --install-dir <path>   Default: ${DEFAULT_INSTALL_DIR}
  --repo-url <url>       Default: ${DEFAULT_REPO_URL}
  --branch <name>        Default: ${DEFAULT_BRANCH} (custom NestJS backend branch)
  --public-url <url>     Public UI origin; HTTPS DNS is preferred, HTTP/IP is supported
  --ui-bind <address>    UI bind address; use 0.0.0.0 for direct IP access
  --deployment <mode>    same (default) or split
  --api-origin <url>     Required public API origin for split --yes installs
  --split-role <role>    ui or api for split --yes installs
  --yes                  Non-interactive confirmations; requires a non-menu action
  --dry-run              Print actions without changing system state
  -h, --help             Show this help

Interactive mode launches the guided shell menu.
EOF
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --action)
        [[ $# -ge 2 ]] || die "--action requires a value"
        ACTION="$2"
        ACTION_SET=1
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
      --public-url)
        [[ $# -ge 2 ]] || die "--public-url requires a URL"
        PUBLIC_URL_OVERRIDE="$2"
        shift 2
        ;;
      --ui-bind)
        [[ $# -ge 2 ]] || die "--ui-bind requires an address"
        UI_BIND_OVERRIDE="$2"
        shift 2
        ;;
      --deployment)
        [[ $# -ge 2 ]] || die "--deployment requires same or split"
        DEPLOYMENT_MODE_OVERRIDE="$2"
        shift 2
        ;;
      --api-origin)
        [[ $# -ge 2 ]] || die "--api-origin requires a URL"
        API_ORIGIN_OVERRIDE="$2"
        shift 2
        ;;
      --split-role)
        [[ $# -ge 2 ]] || die "--split-role requires ui or api"
        SPLIT_ROLE_OVERRIDE="$2"
        shift 2
        ;;
      --interactive)
        ACTION="menu"
        ACTION_SET=1
        INTERACTIVE_REQUESTED=1
        shift
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
      install|init-user|create-token|revoke-token|admin-claim|reset-admin-claim|start|stop|restart|status|uninstall|menu)
        ACTION="$1"
        ACTION_SET=1
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
  if [[ "$YES" -eq 1 && "$ACTION" == "menu" ]]; then
    die "--yes cannot run the interactive menu. Pass --action install (or another non-menu action), or use --interactive without --yes."
  fi
  if [[ "$ACTION" == "menu" && ! -t 0 ]]; then
    die "Interactive mode requires a terminal. Use https://paste.yaemi.one/install.sh for curl installs, or pass --action with --yes."
  fi
  if [[ "$YES" -eq 0 ]]; then
    print_banner
  fi
  run_action "$ACTION"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
