#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CLI="$ROOT_DIR/scripts/check-contract-compatibility.mjs"
CURRENT="$ROOT_DIR/packages/cloudflare-ingest/contracts/account.created.v1.js"
COMPATIBLE="$ROOT_DIR/scripts/fixtures/contracts/account.created.v2.backward-compatible.js"
BREAKING="$ROOT_DIR/scripts/fixtures/contracts/account.created.v2.backward-breaking.js"
TMP_PREFIX="/tmp/etlayer-vs16-$$"

cleanup() {
  rm -f "$TMP_PREFIX".*
}

trap cleanup EXIT

say() {
  printf '\n==> %s\n' "$*"
}

die() {
  printf '\nERROR: %s\n' "$*" >&2
  exit 1
}

say "Backward-compatible relaxation exits 0"
node "$CLI"   --from "$CURRENT"   --to "$COMPATIBLE"   --mode backward   --json > "$TMP_PREFIX.backward-compatible.json"

node -e '
  const value = JSON.parse(process.argv[1]);
  if (
    value.mode !== "backward" ||
    value.compatible !== true ||
    value.backward?.compatible !== true ||
    value.forward?.compatible !== false
  ) {
    console.error(JSON.stringify(value, null, 2));
    process.exit(1);
  }
' "$(cat "$TMP_PREFIX.backward-compatible.json")" ||
  die "Backward relaxation result is incorrect"

say "The same relaxation is breaking under full compatibility"
set +e
node "$CLI"   --from "$CURRENT"   --to "$COMPATIBLE"   --mode full   --json > "$TMP_PREFIX.full.json"
FULL_STATUS=$?
set -e

[ "$FULL_STATUS" = "2" ] ||
  die "Full compatibility must exit 2, got $FULL_STATUS"

node -e '
  const value = JSON.parse(process.argv[1]);
  const violation = value.forward?.violations?.find(
    (item) =>
      item.code === "required_attribute_removed" &&
      item.attribute === "causation.id",
  );

  if (
    value.compatible !== false ||
    value.classification !== "breaking" ||
    !violation
  ) {
    console.error(JSON.stringify(value, null, 2));
    process.exit(1);
  }
' "$(cat "$TMP_PREFIX.full.json")" ||
  die "Forward-breaking relaxation was not explained"

say "Required-field addition and type tightening are backward-breaking"
set +e
node "$CLI"   --from "$CURRENT"   --to "$BREAKING"   --mode backward   --json > "$TMP_PREFIX.breaking.json"
BREAKING_STATUS=$?
set -e

[ "$BREAKING_STATUS" = "2" ] ||
  die "Breaking compatibility must exit 2, got $BREAKING_STATUS"

node -e '
  const value = JSON.parse(process.argv[1]);
  const violations = value.backward?.violations || [];

  const required = violations.some(
    (item) =>
      item.code === "required_attribute_added" &&
      item.attribute === "plan.id",
  );
  const type = violations.some(
    (item) =>
      item.code === "attribute_constraint_narrowed" &&
      item.attribute === "account.id",
  );

  if (
    value.compatible !== false ||
    !required ||
    !type
  ) {
    console.error(JSON.stringify(value, null, 2));
    process.exit(1);
  }
' "$(cat "$TMP_PREFIX.breaking.json")" ||
  die "Breaking changes were not machine-readable"

say "VS16 contract compatibility acceptance passed"
cat <<EOF
{
  "baseline": "account.created@1",
  "backwardRelaxation": "compatible",
  "fullRelaxation": "breaking",
  "requiredAddition": "breaking",
  "typeTightening": "breaking",
  "compatibleExitCode": 0,
  "breakingExitCode": 2
}
EOF
