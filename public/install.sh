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
bash "$TMP_SCRIPT" "$@"
