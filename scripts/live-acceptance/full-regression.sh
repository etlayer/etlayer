#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOG_DIR="${ETLAYER_ACCEPTANCE_LOG_DIR:-/tmp/etlayer-live-acceptance}"

mkdir -p "$LOG_DIR"

run_slice() {
  local name="$1"
  local script="$2"

  printf '\n===== %s =====\n' "$name"

  bash "$ROOT_DIR/$script" |
    tee "$LOG_DIR/$name.log"
}

run_slice vs8 scripts/once/vs8-project-isolation.sh
run_slice vs9 scripts/once/vs9-dynamic-management.sh
run_slice vs10 scripts/once/vs10-first-external-onboarding.sh
run_slice vs11 scripts/once/vs11-project-destination-credentials.sh
run_slice vs12 scripts/once/vs12-external-integration-contract.sh
run_slice vs13 scripts/once/vs13-encryption-root-rotation.sh
run_slice vs14 scripts/once/vs14-quarantine.sh
run_slice vs15 scripts/once/vs15-control-plane-audit.sh
run_slice vs17 scripts/once/vs17-contract-plan.sh
run_slice vs18 scripts/once/vs18-delivery-attempts.sh
run_slice vs19 scripts/once/vs19-governance-as-code.sh
run_slice vs20 scripts/once/vs20-governance-publication.sh
run_slice vs21 scripts/once/vs21-contract-lifecycle.sh
run_slice vs22 scripts/once/vs22-ownership-metadata.sh
run_slice vs23 scripts/once/vs23-governance-metrics.sh
run_slice vs24 scripts/once/vs24-service-protection.sh

printf '\nFull live regression passed: VS8 -> VS24\n'
