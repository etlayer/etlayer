#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INGEST_DIR="$ROOT_DIR/packages/cloudflare-ingest"
FIXTURE_URL="${ETLAYER_FIXTURE_URL:-https://etlayer-cloudflare-fixture.sergii-ponomarov.workers.dev}"
ARCHIVE_BUCKET="${ETLAYER_ARCHIVE_BUCKET:-etlayer-events-archive}"
PROJECT_ID="${ETLAYER_PROJECT_ID:-etlayer-default}"
PROJECT_PREFIX="projects/$PROJECT_ID"
ETLAYER_URL="${ETLAYER_URL:-https://etlayer-ingest.sergii-ponomarov.workers.dev}"
RUN_ID="${RUN_ID:-vs3-invalid-account-$(date -u +%Y%m%dT%H%M%SZ)-$(openssl rand -hex 4)}"
COOKIE_JAR="/tmp/etlayer-vs3-invalid-account-$$.txt"

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

cd "$ROOT_DIR"

npx wrangler whoami >/dev/null 2>&1 ||
  die "Wrangler is not authenticated. Run: npx wrangler login"

say "Creating isolated VS3 fixture context"
printf 'correlation.id: %s\n' "$RUN_ID"

curl --fail --silent --show-error \
  -c "$COOKIE_JAR" \
  "$FIXTURE_URL/?run=$RUN_ID" \
  >/dev/null

say "Emitting intentionally invalid account.created@1"
RESPONSE="$(
  curl --fail-with-body --silent --show-error \
    -b "$COOKIE_JAR" \
    -X POST "$FIXTURE_URL/api/acceptance/invalid-account" \
    -H "content-type: application/json" \
    --data '{"causationId":"vs3_acceptance_root"}'
)"

printf '%s\n' "$RESPONSE"

EVENT_ID="$(
  node -e '
    const value = JSON.parse(process.argv[1]);
    if (!value.eventId) process.exit(1);
    process.stdout.write(value.eventId);
  ' "$RESPONSE"
)" || die "Fixture response did not contain eventId."

CORRELATION_ID="$(
  node -e '
    const value = JSON.parse(process.argv[1]);
    if (!value.correlationId) process.exit(1);
    process.stdout.write(value.correlationId);
  ' "$RESPONSE"
)" || die "Fixture response did not contain correlationId."

printf 'event.id: %s\n' "$EVENT_ID"
printf 'correlation.id: %s\n' "$CORRELATION_ID"

cd "$INGEST_DIR"

VALIDATION_KEY="$PROJECT_PREFIX/validation/$EVENT_ID.json"
VALIDATION=""

say "Waiting for durable validation evidence"
for attempt in $(seq 1 20); do
  if VALIDATION="$(
    npx wrangler r2 object get \
      "$ARCHIVE_BUCKET/$VALIDATION_KEY" \
      --remote --pipe 2>/dev/null
  )"; then
    break
  fi

  if [ "$attempt" -eq 20 ]; then
    die "Validation state did not appear: $VALIDATION_KEY"
  fi

  sleep 1
done

if command -v jq >/dev/null 2>&1; then
  printf '%s\n' "$VALIDATION" | jq
else
  printf '%s\n' "$VALIDATION"
fi

node -e '
  const state = JSON.parse(process.argv[1]);
  const errors = state.errors || [];
  const exact =
    state.status === "blocked" &&
    state.eventName === "account.created" &&
    state.schemaVersion === 1 &&
    state.contractId === "account.created@1" &&
    errors.length === 1 &&
    errors[0].code === "required_attribute_missing" &&
    errors[0].attribute === "account.id" &&
    typeof state.sourceKey === "string" &&
    state.sourceKey.startsWith(
      `projects/${process.argv[2]}/events/`,
    );

  if (!exact) {
    console.error("Unexpected validation state:", JSON.stringify(state, null, 2));
    process.exit(1);
  }
' "$VALIDATION" "$PROJECT_ID" || die "Validation result did not match the VS3 acceptance contract."

SOURCE_KEY="$(
  node -e '
    const state = JSON.parse(process.argv[1]);
    process.stdout.write(state.sourceKey);
  ' "$VALIDATION"
)"

say "Reading preserved canonical event"
CANONICAL="$(
  npx wrangler r2 object get \
    "$ARCHIVE_BUCKET/$SOURCE_KEY" \
    --remote --pipe
)" || die "Canonical event is missing: $SOURCE_KEY"

node -e '
  const event = JSON.parse(process.argv[1]);
  const expectedId = process.argv[2];

  if (
    event.id !== expectedId ||
    event.eventName !== "account.created"
  ) {
    console.error("Unexpected canonical event:", JSON.stringify(event, null, 2));
    process.exit(1);
  }

  process.stdout.write(JSON.stringify({
    id: event.id,
    eventName: event.eventName,
    receivedAt: event.receivedAt,
  }, null, 2) + "\n");
' "$CANONICAL" "$EVENT_ID" ||
  die "Canonical event did not match the emitted logical event."

say "Verifying destination routing was blocked"
for destination in posthog statsig; do
  DELIVERY_KEY="$PROJECT_PREFIX/deliveries/$destination/$EVENT_ID.json"

  if npx wrangler r2 object get \
    "$ARCHIVE_BUCKET/$DELIVERY_KEY" \
    --remote --pipe \
    >/tmp/etlayer-vs3-delivery-check-$$.json 2>/dev/null; then
    cat /tmp/etlayer-vs3-delivery-check-$$.json >&2 || true
    rm -f /tmp/etlayer-vs3-delivery-check-$$.json
    die "Blocked event unexpectedly has $destination delivery state."
  fi

  rm -f /tmp/etlayer-vs3-delivery-check-$$.json
  printf '%s delivery state: absent ✓\n' "$destination"
done

say "Revalidating the preserved canonical event without producer re-emission"
OPERATOR_KEY="$(openssl rand -hex 32)"
printf '%s' "$OPERATOR_KEY" | npx wrangler secret put ETLAYER_REPLAY_KEY >/dev/null

say "Deploying Worker version with rotated operator credential"
npx wrangler deploy >/tmp/etlayer-vs3-revalidate-deploy-$.txt
cat /tmp/etlayer-vs3-revalidate-deploy-$.txt

say "Waiting for deployed Worker health"
for attempt in $(seq 1 20); do
  if curl --fail --silent --show-error "$ETLAYER_URL/health" >/dev/null 2>&1; then
    break
  fi

  if [ "$attempt" -eq 20 ]; then
    die "Worker did not become healthy after operator credential rotation."
  fi

  sleep 1
done

REVALIDATE_BODY="$(
  node -e '
    const [projectId, sourceKey] = process.argv.slice(1);
    process.stdout.write(JSON.stringify({ projectId, sourceKey }));
  ' "$PROJECT_ID" "$SOURCE_KEY"
)"

REVALIDATE_RESPONSE="$(
  curl --fail-with-body --silent --show-error \
    -X POST "$ETLAYER_URL/_ops/revalidate" \
    -H "authorization: Bearer $OPERATOR_KEY" \
    -H "content-type: application/json" \
    --data "$REVALIDATE_BODY"
)" || die "Canonical revalidation request failed."

unset OPERATOR_KEY

if command -v jq >/dev/null 2>&1; then
  printf '%s\n' "$REVALIDATE_RESPONSE" | jq
else
  printf '%s\n' "$REVALIDATE_RESPONSE"
fi

node -e '
  const result = JSON.parse(process.argv[1]);
  const errors = result.validation?.errors || [];
  const valid =
    result.sourceKey === process.argv[2] &&
    result.eventId === process.argv[3] &&
    result.validation?.status === "blocked" &&
    errors.length === 1 &&
    errors[0].code === "required_attribute_missing" &&
    errors[0].attribute === "account.id" &&
    Array.isArray(result.deliveries) &&
    result.deliveries.length === 0;

  if (!valid) {
    console.error(
      "Unexpected revalidation result:",
      JSON.stringify(result, null, 2),
    );
    process.exit(1);
  }
' "$REVALIDATE_RESPONSE" "$SOURCE_KEY" "$EVENT_ID" ||
  die "Preserved-event revalidation did not match expected blocked result."

say "VS3 invalid-event acceptance passed"
cat <<EOF
{
  "correlationId": "$CORRELATION_ID",
  "eventId": "$EVENT_ID",
  "validationStatus": "blocked",
  "validationError": "required_attribute_missing:account.id",
  "sourceKey": "$SOURCE_KEY",
  "posthogDelivery": "absent",
  "statsigDelivery": "absent",
  "revalidation": "blocked_without_producer_reemission"
}
EOF
