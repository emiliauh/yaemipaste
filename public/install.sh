#!/usr/bin/env bash
set -euo pipefail

# Bootstrap installer endpoint for curl|bash usage.
# This script intentionally downloads the latest full installer from the public repo.
SCRIPT_URL="https://raw.githubusercontent.com/emiliauh/yaemipaste/main/install.sh"
TMP_SCRIPT="$(mktemp)"

cleanup() {
  rm -f "$TMP_SCRIPT"
}
trap cleanup EXIT

curl -fsSL "$SCRIPT_URL" -o "$TMP_SCRIPT"
if [[ -t 0 ]]; then
  bash "$TMP_SCRIPT" "$@"
elif { true </dev/tty; } 2>/dev/null; then
  # curl | bash consumes stdin; reopen the terminal for the guided installer.
  bash "$TMP_SCRIPT" "$@" </dev/tty
else
  printf 'The guided installer needs an interactive terminal. Clone the repository or run install.sh with --action and --yes.\n' >&2
  exit 1
fi
