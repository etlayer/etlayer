#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

echo "Running current live acceptance slice: VS25 Supported Project Read Surface"
exec bash "$ROOT_DIR/scripts/once/vs25-project-read-surface.sh"
