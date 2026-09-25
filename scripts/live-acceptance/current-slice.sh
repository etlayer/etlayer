#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

echo "Running current live acceptance slice: VS20 Guarded Governance Publication"
exec bash "$ROOT_DIR/scripts/once/vs20-governance-publication.sh"
