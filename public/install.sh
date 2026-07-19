#!/usr/bin/env bash
set -euo pipefail

# Bootstrap installer endpoint for curl|bash usage.
# The contents API avoids stale raw.githubusercontent.com branch caches.
SCRIPT_URL="https://api.github.com/repos/emiliauh/yaemipaste/contents/install.sh?ref=main"
TMP_SCRIPT="$(mktemp)"

cleanup() {
  rm -f "$TMP_SCRIPT"
}
trap cleanup EXIT

curl -fsSL \
  -H 'Accept: application/vnd.github.raw+json' \
  -H 'X-GitHub-Api-Version: 2022-11-28' \
  "${SCRIPT_URL}&cache_bust=$(date +%s)" \
  -o "$TMP_SCRIPT"
if [[ -t 0 ]]; then
  bash "$TMP_SCRIPT" "$@"
elif { true </dev/tty; } 2>/dev/null; then
  # curl | bash consumes stdin; reopen the terminal for the guided installer.
  bash "$TMP_SCRIPT" "$@" </dev/tty
else
  printf 'The guided installer needs an interactive terminal. Clone the repository or run install.sh with --action and --yes.\n' >&2
  exit 1
fi
