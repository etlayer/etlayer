#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

echo "Running current live acceptance slice: VS23 Governance Metrics"
exec bash "$ROOT_DIR/scripts/once/vs23-governance-metrics.sh"
