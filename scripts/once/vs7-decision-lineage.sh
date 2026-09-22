#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INGEST_DIR="$ROOT_DIR/packages/cloudflare-ingest"
FIXTURE_URL="${ETLAYER_FIXTURE_URL:-https://etlayer-cloudflare-fixture.sergii-ponomarov.workers.dev}"
INGEST_URL="${ETLAYER_INGEST_URL:-https://etlayer-ingest.sergii-ponomarov.workers.dev}"
ARCHIVE_BUCKET="${ETLAYER_ARCHIVE_BUCKET:-etlayer-events-archive}"
RUN_ID="${RUN_ID:-vs7-decision-lineage-$(date -u +%Y%m%dT%H%M%SZ)-$(openssl rand -hex 4)}"
COOKIE_JAR="/tmp/etlayer-vs7-decision-lineage-$$.txt"

say() {
  printf '\n==> %s\n' "$*"
}

die() {
  printf '\nERROR: %s\n' "$*" >&2
  exit 1
}

cleanup() {
  rm -f "$COOKIE_JAR"
}

trap cleanup EXIT

read_json_field() {
  node -e '
    const value = JSON.parse(process.argv[1]);
    const path = process.argv[2].split(".");
    let current = value;

    for (const key of path) {
      current = current?.[key];
    }

    if (typeof current !== "string" || current.length === 0) {
      process.exit(1);
    }

    process.stdout.write(current);
  ' "$1" "$2"
}

cd "$ROOT_DIR"

npx wrangler whoami >/dev/null 2>&1 ||
  die "Wrangler is not authenticated. Run: npx wrangler login"

say "Creating isolated VS7 session"
printf 'correlation.id: %s\n' "$RUN_ID"

curl --fail --silent --show-error \
  -c "$COOKIE_JAR" \
  "$FIXTURE_URL/?run=$RUN_ID&utm_source=docs&utm_medium=acceptance&utm_campaign=vs7-decision-lineage" \
  >/dev/null

say "Emitting a contract-valid browser spoof that authority must block"
SPOOF_RESPONSE="$(
  curl --fail-with-body --silent --show-error \
    -b "$COOKIE_JAR" \
    -X POST "$FIXTURE_URL/api/acceptance/authority-spoof" \
    -H "content-type: application/json" \
    --data '{"profile":"browser"}'
)"
printf '%s\n' "$SPOOF_RESPONSE"

EVENT_ID="$(read_json_field "$SPOOF_RESPONSE" eventId)" ||
  die "Spoof response missing eventId."

cd "$INGEST_DIR"

get_r2_json() {
  local key="$1"
  local value=""

  for attempt in $(seq 1 30); do
    if value="$(
      npx wrangler r2 object get \
        "$ARCHIVE_BUCKET/$key" \
        --remote --pipe 2>/dev/null
    )"; then
      printf '%s' "$value"
      return 0
    fi

    sleep 1
  done

  return 1
}

assert_delivery_absent() {
  local destination="$1"
  local event_id="$2"
  local key="deliveries/$destination/$event_id.json"

  if npx wrangler r2 object get \
    "$ARCHIVE_BUCKET/$key" \
    --remote --pipe >/dev/null 2>&1; then
    die "Unexpected $destination delivery state exists for blocked event $event_id"
  fi
}

say "Reading initial decision pointer"
INITIAL_POINTER="$(get_r2_json "decision-latest/$EVENT_ID.json")" ||
  die "Initial decision pointer is missing."

INITIAL_DECISION_ID="$(read_json_field "$INITIAL_POINTER" decisionId)" ||
  die "Initial decision pointer missing decisionId."
INITIAL_DECISION_KEY="$(read_json_field "$INITIAL_POINTER" key)" ||
  die "Initial decision pointer missing key."

INITIAL_DECISION="$(get_r2_json "$INITIAL_DECISION_KEY")" ||
  die "Initial decision record is missing."

node -e '
  const value = JSON.parse(process.argv[1]);
  const eventId = process.argv[2];

  const authorityCodes = (value.authority?.errors || []).map(
    ({ code }) => code,
  );

  const ok =
    value.version === 1 &&
    value.eventId === eventId &&
    value.evaluationKind === "processing" &&
    value.validation?.status === "valid" &&
    value.validation?.validatorVersion === 1 &&
    value.validation?.contractId === "account.created@1" &&
    value.authority?.status === "blocked" &&
    value.authority?.policyVersion === 1 &&
    value.authority?.profileId === "browser" &&
    value.authority?.trustedProducerKind === "browser" &&
    authorityCodes.includes("producer_kind_mismatch") &&
    authorityCodes.includes("authority_not_allowed") &&
    value.privacy?.policyVersion === 1 &&
    value.provenance?.version === 1 &&
    value.provenance?.profileId === "browser" &&
    value.provenance?.producerKind === "browser" &&
    value.routeEligible === false;

  if (!ok) {
    console.error(JSON.stringify(value, null, 2));
    process.exit(1);
  }
' "$INITIAL_DECISION" "$EVENT_ID" ||
  die "Initial decision lineage evidence is incorrect."

SOURCE_KEY="$(read_json_field "$INITIAL_DECISION" sourceKey)" ||
  die "Initial decision record missing canonical sourceKey."

assert_delivery_absent posthog "$EVENT_ID"
assert_delivery_absent statsig "$EVENT_ID"

say "Rotating operator credential for canonical revalidation"
OPERATOR_KEY="$(openssl rand -hex 32)"
printf '%s' "$OPERATOR_KEY" |
  npx wrangler secret put ETLAYER_REPLAY_KEY >/dev/null

say "Deploying current ingest Worker before revalidation"
npx wrangler deploy >/tmp/etlayer-vs7-revalidate-deploy.txt
cat /tmp/etlayer-vs7-revalidate-deploy.txt

say "Revalidating the same preserved canonical event"
REVALIDATION="$(
  curl --fail-with-body --silent --show-error \
    -X POST "$INGEST_URL/_ops/revalidate" \
    -H "authorization: Bearer $OPERATOR_KEY" \
    -H "content-type: application/json" \
    --data "$(jq -nc --arg sourceKey "$SOURCE_KEY" '{sourceKey:$sourceKey}')"
)"
printf '%s\n' "$REVALIDATION"

REVALIDATION_DECISION_ID="$(
  read_json_field "$REVALIDATION" decision.decisionId
)" || die "Revalidation response missing decision.decisionId."

node -e '
  const value = JSON.parse(process.argv[1]);
  const initialDecisionId = process.argv[2];

  const ok =
    value.validation?.status === "valid" &&
    value.authority?.status === "blocked" &&
    value.decision?.evaluationKind === "revalidation" &&
    value.decision?.validation?.validatorVersion === 1 &&
    value.decision?.authority?.policyVersion === 1 &&
    value.decision?.privacy?.policyVersion === 1 &&
    value.decision?.routeEligible === false &&
    value.decision?.decisionId !== initialDecisionId &&
    Array.isArray(value.deliveries) &&
    value.deliveries.length === 0;

  if (!ok) {
    console.error(JSON.stringify(value, null, 2));
    process.exit(1);
  }
' "$REVALIDATION" "$INITIAL_DECISION_ID" ||
  die "Revalidation decision lineage is incorrect."

say "Verifying latest pointer advanced without rewriting original decision"
LATEST_POINTER="$(get_r2_json "decision-latest/$EVENT_ID.json")" ||
  die "Latest decision pointer is missing after revalidation."

LATEST_DECISION_ID="$(read_json_field "$LATEST_POINTER" decisionId)" ||
  die "Latest pointer missing decisionId."
LATEST_DECISION_KEY="$(read_json_field "$LATEST_POINTER" key)" ||
  die "Latest pointer missing key."

if [[ "$LATEST_DECISION_ID" != "$REVALIDATION_DECISION_ID" ]]; then
  die "Latest pointer does not reference the revalidation decision."
fi

if [[ "$LATEST_DECISION_ID" == "$INITIAL_DECISION_ID" ]]; then
  die "Revalidation reused the initial decision id."
fi

LATEST_DECISION="$(get_r2_json "$LATEST_DECISION_KEY")" ||
  die "Revalidation decision record is missing."

ORIGINAL_AFTER_REVALIDATION="$(get_r2_json "$INITIAL_DECISION_KEY")" ||
  die "Original decision record disappeared after revalidation."

if [[ "$ORIGINAL_AFTER_REVALIDATION" != "$INITIAL_DECISION" ]]; then
  die "Original decision record changed after revalidation."
fi

node -e '
  const value = JSON.parse(process.argv[1]);
  const expectedDecisionId = process.argv[2];

  const ok =
    value.decisionId === expectedDecisionId &&
    value.evaluationKind === "revalidation" &&
    value.validation?.status === "valid" &&
    value.authority?.status === "blocked" &&
    value.routeEligible === false;

  if (!ok) {
    console.error(JSON.stringify(value, null, 2));
    process.exit(1);
  }
' "$LATEST_DECISION" "$LATEST_DECISION_ID" ||
  die "Persisted revalidation decision is incorrect."

assert_delivery_absent posthog "$EVENT_ID"
assert_delivery_absent statsig "$EVENT_ID"

unset OPERATOR_KEY

say "VS7 append-only decision lineage acceptance passed"
cat <<EOF
{
  "correlationId": "$RUN_ID",
  "eventId": "$EVENT_ID",
  "canonicalSourceKey": "$SOURCE_KEY",
  "initialDecisionId": "$INITIAL_DECISION_ID",
  "initialDecisionKey": "$INITIAL_DECISION_KEY",
  "revalidationDecisionId": "$LATEST_DECISION_ID",
  "revalidationDecisionKey": "$LATEST_DECISION_KEY",
  "initialEvaluationKind": "processing",
  "revalidationEvaluationKind": "revalidation",
  "initialDecisionPreservedByteForByte": true,
  "latestPointerAdvanced": true,
  "validation": "valid",
  "authority": "blocked",
  "routeEligible": false,
  "deliveries": []
}
EOF
