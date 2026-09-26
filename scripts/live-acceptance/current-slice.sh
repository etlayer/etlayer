#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

echo "Running current live acceptance slice: VS24 Service Protection"
exec bash "$ROOT_DIR/scripts/once/vs24-service-protection.sh"
