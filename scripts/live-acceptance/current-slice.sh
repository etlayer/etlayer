#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

echo "Running current live acceptance slice: VS22 Ownership Metadata"
exec bash "$ROOT_DIR/scripts/once/vs22-ownership-metadata.sh"
