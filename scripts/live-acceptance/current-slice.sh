#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

echo "Running current live acceptance slice: VS21 Contract Lifecycle"
exec bash "$ROOT_DIR/scripts/once/vs21-contract-lifecycle.sh"
