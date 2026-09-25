#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

echo "Running current live acceptance slice: VS19 Governance-as-Code"
exec bash "$ROOT_DIR/scripts/once/vs19-governance-as-code.sh"
