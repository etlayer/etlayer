#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

echo "Running current live acceptance slice: VS27 Supported Contract Catalog"
exec bash "$ROOT_DIR/scripts/once/vs27-contract-catalog.sh"
