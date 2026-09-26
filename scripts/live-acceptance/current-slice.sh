#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

echo "Running current live acceptance slice: VS26 Typed Contract Artifact"
exec bash "$ROOT_DIR/scripts/once/vs26-typed-contract-artifact.sh"
