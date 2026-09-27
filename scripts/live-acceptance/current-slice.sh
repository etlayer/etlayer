#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

echo "Running current live acceptance slice: VS28 Project Contract Pull + TypeScript Generation"
exec bash "$ROOT_DIR/scripts/once/vs28-project-contract-generation.sh"
