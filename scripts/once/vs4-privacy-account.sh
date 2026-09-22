#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INGEST_DIR="$ROOT_DIR/packages/cloudflare-ingest"
FIXTURE_URL="${ETLAYER_FIXTURE_URL:-https://etlayer-cloudflare-fixture.sergii-ponomarov.workers.dev}"
ARCHIVE_BUCKET="${ETLAYER_ARCHIVE_BUCKET:-etlayer-events-archive}"
PROJECT_ID="${ETLAYER_PROJECT_ID:-etlayer-default}"
PROJECT_PREFIX="projects/$PROJECT_ID"
RUN_ID="${RUN_ID:-vs4-privacy-$(date -u +%Y%m%dT%H%M%SZ)-$(openssl rand -hex 4)}"
COOKIE_JAR="/tmp/etlayer-vs4-privacy-$$.txt"

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

say "Creating isolated VS4 fixture context"
printf 'correlation.id: %s\n' "$RUN_ID"

curl --fail --silent --show-error \
  -c "$COOKIE_JAR" \
  "$FIXTURE_URL/?run=$RUN_ID" \
  >/dev/null

say "Emitting privacy acceptance account.created@1"
RESPONSE="$(
  curl --fail-with-body --silent --show-error \
    -b "$COOKIE_JAR" \
    -X POST "$FIXTURE_URL/api/acceptance/privacy-account" \
    -H "content-type: application/json" \
    --data '{"causationId":"vs4_privacy_acceptance_root"}'
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

cd "$INGEST_DIR"

PRIVACY_KEY="$PROJECT_PREFIX/privacy/$EVENT_ID.json"
PRIVACY=""

say "Waiting for durable privacy evidence"
for attempt in $(seq 1 20); do
  if PRIVACY="$(
    npx wrangler r2 object get \
      "$ARCHIVE_BUCKET/$PRIVACY_KEY" \
      --remote --pipe 2>/dev/null
  )"; then
    break
  fi

  if [ "$attempt" -eq 20 ]; then
    die "Privacy state did not appear: $PRIVACY_KEY"
  fi

  sleep 1
done

if command -v jq >/dev/null 2>&1; then
  printf '%s\n' "$PRIVACY" | jq
else
  printf '%s\n' "$PRIVACY"
fi

node -e '
  const state = JSON.parse(process.argv[1]);
  const ingest = state.ingestActions || [];
  const delivery = state.deliveryActions || [];

  const ingestOk =
    ingest.length === 1 &&
    ingest[0].attribute === "auth.token" &&
    ingest[0].classification === "secret" &&
    ingest[0].action === "drop";

  const deliveryOk =
    delivery.length === 1 &&
    delivery[0].attribute === "user.email" &&
    delivery[0].classification === "direct_identifier" &&
    delivery[0].action === "drop";

  const ok =
    state.status === "applied" &&
    state.policyVersion === 1 &&
    typeof state.sourceKey === "string" &&
    state.sourceKey.startsWith(`projects/${process.argv[2]}/events/`) &&
    ingestOk &&
    deliveryOk;

  if (!ok) {
    console.error("Unexpected privacy state:", JSON.stringify(state, null, 2));
    process.exit(1);
  }
' "$PRIVACY" "$PROJECT_ID" || die "Privacy evidence did not match VS4 policy."

SOURCE_KEY="$(
  node -e '
    const state = JSON.parse(process.argv[1]);
    process.stdout.write(state.sourceKey);
  ' "$PRIVACY"
)"

say "Reading canonical event"
CANONICAL="$(
  npx wrangler r2 object get \
    "$ARCHIVE_BUCKET/$SOURCE_KEY" \
    --remote --pipe
)" || die "Canonical event is missing: $SOURCE_KEY"

node -e '
  const event = JSON.parse(process.argv[1]);
  const expectedId = process.argv[2];
  const attrs = Object.fromEntries(
    (event.logRecord?.attributes || []).map(({ key, value }) => [
      key,
      value?.stringValue ??
      value?.intValue ??
      value?.boolValue ??
      value?.doubleValue ??
      null,
    ]),
  );

  const canonicalText = JSON.stringify(event);
  const ok =
    event.id === expectedId &&
    event.eventName === "account.created" &&
    attrs["user.email"] === "acceptance@example.test" &&
    !Object.hasOwn(attrs, "auth.token") &&
    !canonicalText.includes("acceptance-secret-do-not-store");

  if (!ok) {
    console.error("Unexpected canonical event:", JSON.stringify(event, null, 2));
    process.exit(1);
  }

  process.stdout.write(JSON.stringify({
    id: event.id,
    eventName: event.eventName,
    userEmailPreserved: true,
    authTokenPresent: false,
    secretLiteralPresent: false,
  }, null, 2) + "\n");
' "$CANONICAL" "$EVENT_ID" ||
  die "Canonical privacy invariants failed."

say "Verifying contract validation remains valid"
VALIDATION="$(
  npx wrangler r2 object get \
    "$ARCHIVE_BUCKET/$PROJECT_PREFIX/validation/$EVENT_ID.json" \
    --remote --pipe
)" || die "Validation state is missing."

node -e '
  const state = JSON.parse(process.argv[1]);
  if (
    state.status !== "valid" ||
    state.contractId !== "account.created@1" ||
    (state.errors || []).length !== 0
  ) {
    console.error("Unexpected validation state:", JSON.stringify(state, null, 2));
    process.exit(1);
  }
' "$VALIDATION" || die "Privacy acceptance event did not remain contract-valid."

if command -v jq >/dev/null 2>&1; then
  printf '%s\n' "$VALIDATION" |
    jq '{eventName,status,schemaVersion,contractId,errors}'
fi

say "Verifying both destinations exported the privacy-sanitized event"
for destination in posthog statsig; do
  DELIVERY="$(
    npx wrangler r2 object get \
      "$ARCHIVE_BUCKET/$PROJECT_PREFIX/deliveries/$destination/$EVENT_ID.json" \
      --remote --pipe
  )" || die "$destination delivery state is missing."

  node -e '
    const state = JSON.parse(process.argv[1]);
    const destination = process.argv[2];
    if (
      state.destination !== destination ||
      state.status !== "exported"
    ) {
      console.error("Unexpected delivery state:", JSON.stringify(state, null, 2));
      process.exit(1);
    }
  ' "$DELIVERY" "$destination" ||
    die "$destination delivery did not export successfully."

  if command -v jq >/dev/null 2>&1; then
    printf '%s\n' "$DELIVERY" |
      jq '{eventName,destination,status,reason}'
  fi
done

say "VS4 privacy acceptance passed"
cat <<EOF
{
  "correlationId": "$CORRELATION_ID",
  "eventId": "$EVENT_ID",
  "sourceKey": "$SOURCE_KEY",
  "canonicalUserEmail": "preserved",
  "canonicalAuthToken": "absent",
  "validation": "valid",
  "privacyPolicyVersion": 1,
  "ingestDrop": "auth.token",
  "deliveryDrop": "user.email",
  "posthogDelivery": "exported",
  "statsigDelivery": "exported"
}
EOF
