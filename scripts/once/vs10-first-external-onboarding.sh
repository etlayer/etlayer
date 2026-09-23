#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INGEST_DIR="$ROOT_DIR/packages/cloudflare-ingest"
WRANGLER_ENV="${ETLAYER_WRANGLER_ENV:-ci}"
INGEST_URL="${ETLAYER_INGEST_URL:-https://etlayer-ingest-ci.sergii-ponomarov.workers.dev}"
RUN_ID="${RUN_ID:-vs10-$(date -u +%Y%m%d-%H%M%S)-$(openssl rand -hex 4)}"
PROJECT_ID="${VS10_PROJECT_ID:-$RUN_ID-a}"
SECOND_PROJECT_ID="${VS10_SECOND_PROJECT_ID:-$RUN_ID-b}"
TMP_PREFIX="/tmp/etlayer-vs10-$$"

say() {
  printf '\n==> %s\n' "$*"
}

die() {
  printf '\nERROR: %s\n' "$*" >&2
  exit 1
}

cleanup() {
  rm -f "$TMP_PREFIX".*
}

trap cleanup EXIT

generate_key() {
  openssl rand -hex 32
}

uuid() {
  python3 - <<'PY'
import uuid
print(uuid.uuid4())
PY
}

put_secret() {
  local name="$1"
  local value="$2"

  (
    cd "$INGEST_DIR"
    printf '%s' "$value" |
      npx wrangler secret put "$name" --env "$WRANGLER_ENV" >/dev/null
  )
}

json_field() {
  local json="$1"
  local path="$2"

  node -e '
    const value = JSON.parse(process.argv[1]);
    const path = process.argv[2].split(".");
    let current = value;
    for (const key of path) current = current?.[key];
    if (current == null) process.exit(1);
    if (typeof current === "object") {
      process.stdout.write(JSON.stringify(current));
    } else {
      process.stdout.write(String(current));
    }
  ' "$json" "$path"
}

request_json() {
  local method="$1"
  local path="$2"
  local token="$3"
  local body="$4"
  local output="$5"

  curl --silent --show-error \
    -o "$output" \
    -w '%{http_code}' \
    -X "$method" "$INGEST_URL$path" \
    -H "authorization: Bearer $token" \
    -H "content-type: application/json" \
    --data "$body"
}

request_json_url() {
  local method="$1"
  local url="$2"
  local token="$3"
  local body="$4"
  local output="$5"

  curl --silent --show-error \
    -o "$output" \
    -w '%{http_code}' \
    -X "$method" "$url" \
    -H "authorization: Bearer $token" \
    -H "content-type: application/json" \
    --data "$body"
}

management_json() {
  local method="$1"
  local path="$2"
  local token="$3"
  local body="$4"
  local status=""

  for attempt in $(seq 1 20); do
    status="$(
      request_json \
        "$method" \
        "$path" \
        "$token" \
        "$body" \
        "$TMP_PREFIX.response"
    )"

    if [ "$status" -ge 200 ] && [ "$status" -lt 300 ]; then
      cat "$TMP_PREFIX.response"
      return 0
    fi

    # Cloudflare Worker secret/deploy propagation can briefly expose
    # the previous secret version at another edge immediately after
    # wrangler secret put + deploy. Retry only expected-success
    # management calls; negative authorization assertions use
    # request_json directly and therefore remain strict.
    if [ "$status" = "401" ] && [ "$attempt" -lt 20 ]; then
      sleep 1
      continue
    fi

    printf 'HTTP %s for %s %s\n' "$status" "$method" "$path" >&2
    cat "$TMP_PREFIX.response" >&2 || true
    printf '\n' >&2
    return 1
  done

  return 1
}

inspect_status() {
  local project_id="$1"
  local event_id="$2"
  local operator_key="$3"
  local inspect_url="$4"
  local output="$5"
  local body

  body="$(
    node -e '
      const [projectId, eventId] = process.argv.slice(1);
      process.stdout.write(
        JSON.stringify({ projectId, eventId }),
      );
    ' "$project_id" "$event_id"
  )"

  request_json_url     POST     "$inspect_url"     "$operator_key"     "$body"     "$output"
}

wait_for_complete_inspection() {
  local project_id="$1"
  local event_id="$2"
  local operator_key="$3"
  local inspect_url="$4"
  local status=""
  local lifecycle=""

  for attempt in $(seq 1 45); do
    status="$(
      inspect_status         "$project_id"         "$event_id"         "$operator_key"         "$inspect_url"         "$TMP_PREFIX.inspect" || true
    )"

    if [ "$status" != "200" ]; then
      printf 'Inspect failed with HTTP %s\n' "$status" >&2
      cat "$TMP_PREFIX.inspect" >&2 || true
      printf '\n' >&2
      return 1
    fi

    lifecycle="$(
      node -e '
        const value = JSON.parse(process.argv[1]);
        process.stdout.write(String(value.status || ""));
      ' "$(cat "$TMP_PREFIX.inspect")"
    )"

    if [ "$lifecycle" = "complete" ]; then
      cat "$TMP_PREFIX.inspect"
      return 0
    fi

    sleep 1
  done

  printf 'Inspect never reached complete for event %s\n' "$event_id" >&2
  cat "$TMP_PREFIX.inspect" >&2 || true
  printf '\n' >&2
  return 1
}

cd "$ROOT_DIR"

if [ -n "${CLOUDFLARE_API_TOKEN:-}" ] &&
   [ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
  say "Using non-interactive Cloudflare API token"
else
  npx wrangler whoami >/dev/null 2>&1 ||
    die "Wrangler is not authenticated. Run: npx wrangler login"
fi

MANAGEMENT_KEY="$(generate_key)"
DESTINATION_SECRET_KEY="$(generate_key)"

say "Rotating VS10 management credential"
put_secret ETLAYER_MANAGEMENT_KEY "$MANAGEMENT_KEY"
put_secret ETLAYER_DESTINATION_SECRET_KEY_V1 "$DESTINATION_SECRET_KEY"

say "Deploying current onboarding-capable Worker"
(
  cd "$INGEST_DIR"
  npx wrangler deploy --env "$WRANGLER_ENV"
)

say "Creating external project"
PROJECT_RESPONSE="$(
  management_json     POST     "/_mgmt/projects"     "$MANAGEMENT_KEY"     "$(node -e '
      process.stdout.write(
        JSON.stringify({ id: process.argv[1] }),
      );
    ' "$PROJECT_ID")"
)" || die "Failed to create external project."

OPERATOR_KEY="$(
  json_field "$PROJECT_RESPONSE" operatorCredential
)" || die "Operator credential missing."

say "Creating second project for inspect-isolation proof"
SECOND_PROJECT_RESPONSE="$(
  management_json     POST     "/_mgmt/projects"     "$MANAGEMENT_KEY"     "$(node -e '
      process.stdout.write(
        JSON.stringify({ id: process.argv[1] }),
      );
    ' "$SECOND_PROJECT_ID")"
)" || die "Failed to create second project."

SECOND_OPERATOR_KEY="$(
  json_field "$SECOND_PROJECT_RESPONSE" operatorCredential
)" || die "Second operator credential missing."

say "Provisioning one-shot external onboarding bundle"
BUNDLE="$(
  management_json     POST     "/_mgmt/projects/$PROJECT_ID/onboarding"     "$OPERATOR_KEY"     '{"producerId":"backend-main","destinations":["posthog"]}'
)" || die "Onboarding bundle provisioning failed."

PRODUCER_CREDENTIAL="$(
  json_field "$BUNDLE" credential
)" || die "Producer credential missing from bundle."
OTLP_ENDPOINT="$(
  json_field "$BUNDLE" connection.endpoint
)" || die "OTLP endpoint missing from bundle."
INSPECT_ENDPOINT="$(
  json_field "$BUNDLE" inspect.endpoint
)" || die "Inspect endpoint missing from bundle."
QUICKSTART_SOURCE="$(
  json_field "$BUNDLE" quickstart.source
)" || die "Quickstart source missing from bundle."

node -e '
  const value = JSON.parse(process.argv[1]);
  const expectedProject = process.argv[2];
  const expectedIngest = process.argv[3];
  const expectedInspect = process.argv[4];

  const ok =
    value.version === 1 &&
    value.projectId === expectedProject &&
    value.producer?.profileId === "backend" &&
    value.producer?.producerKind === "backend" &&
    Array.isArray(value.destinations) &&
    value.destinations.length === 1 &&
    value.destinations[0] === "posthog" &&
    value.connection?.protocol === "otlp/http-json" &&
    value.connection?.endpoint === expectedIngest &&
    value.inspect?.endpoint === expectedInspect &&
    value.inspect?.body?.projectId === expectedProject &&
    value.quickstart?.runtime === "node" &&
    typeof value.quickstart?.source === "string" &&
    value.quickstart.source.includes("account.created") &&
    value.quickstart.source.includes("crypto.randomUUID");

  if (!ok) {
    const safe = structuredClone(value);
    if (safe.credential) safe.credential = "<redacted>";
    if (safe.connection?.headers?.authorization) {
      safe.connection.headers.authorization = "<redacted>";
    }
    if (safe.quickstart?.source) {
      safe.quickstart.source = "<redacted quickstart>";
    }
    console.error(JSON.stringify(safe, null, 2));
    process.exit(1);
  }
'   "$BUNDLE"   "$PROJECT_ID"   "$INGEST_URL/v1/logs"   "$INGEST_URL/_ops/inspect" ||
  die "Onboarding bundle contract is incorrect."

case "$PRODUCER_CREDENTIAL" in
  etl_prod_*) ;;
  *) die "Unexpected producer credential shape." ;;
esac

say "Binding CI PostHog token into encrypted project credential storage"
DESTINATION_CREDENTIAL_RESPONSE="$(
  management_json     POST     "/_mgmt/projects/$PROJECT_ID/destinations/posthog/credential/bootstrap-runtime-default"     "$MANAGEMENT_KEY"     '{}'
)" || die "Failed to bootstrap project PostHog credential."

node -e '
  const value = JSON.parse(process.argv[1]);
  if (
    value.source !== "runtime_default" ||
    value.credential?.configured !== true ||
    value.credential?.status !== "active" ||
    value.credential?.keyVersion !== "v1"
  ) {
    console.error(JSON.stringify(value, null, 2));
    process.exit(1);
  }
' "$DESTINATION_CREDENTIAL_RESPONSE" ||
  die "Project PostHog credential bootstrap is incorrect."

say "Checking inspect state before event exists"
PENDING_EVENT_ID="$(uuid)"
PENDING_STATUS="$(
  inspect_status     "$PROJECT_ID"     "$PENDING_EVENT_ID"     "$OPERATOR_KEY"     "$INSPECT_ENDPOINT"     "$TMP_PREFIX.pending"
)"
[ "$PENDING_STATUS" = "200" ] ||
  die "Pending inspect failed: HTTP $PENDING_STATUS"

node -e '
  const value = JSON.parse(process.argv[1]);
  if (
    value.status !== "pending_or_unknown" ||
    value.known !== false
  ) {
    console.error(JSON.stringify(value, null, 2));
    process.exit(1);
  }
' "$(cat "$TMP_PREFIX.pending")" ||
  die "Unknown event did not return pending_or_unknown."

say "Executing generated first-event quickstart exactly as delivered"
printf '%s\n' "$QUICKSTART_SOURCE" > "$TMP_PREFIX.first-etlayer-event.mjs"
QUICKSTART_OUTPUT="$(
  node "$TMP_PREFIX.first-etlayer-event.mjs"
)" || die "Generated onboarding quickstart failed."

EVENT_ID="$(
  json_field "$QUICKSTART_OUTPUT" eventId
)" || die "Generated quickstart did not print eventId."
OUTPUT_PROJECT_ID="$(
  json_field "$QUICKSTART_OUTPUT" projectId
)" || die "Generated quickstart did not print projectId."
OUTPUT_INSPECT_ENDPOINT="$(
  json_field "$QUICKSTART_OUTPUT" inspect.endpoint
)" || die "Generated quickstart did not print inspect endpoint."

[ "$OUTPUT_PROJECT_ID" = "$PROJECT_ID" ] ||
  die "Quickstart printed wrong project id."
[ "$OUTPUT_INSPECT_ENDPOINT" = "$INSPECT_ENDPOINT" ] ||
  die "Quickstart printed wrong inspect endpoint."

say "Polling product inspect endpoint by eventId only"
INSPECTION="$(
  wait_for_complete_inspection     "$PROJECT_ID"     "$EVENT_ID"     "$OPERATOR_KEY"     "$INSPECT_ENDPOINT"
)" || die "Event inspection did not complete."

SOURCE_KEY="$(
  json_field "$INSPECTION" sourceKey
)" || die "Inspection source key missing."

node -e '
  const value = JSON.parse(process.argv[1]);
  const projectId = process.argv[2];
  const eventId = process.argv[3];

  const deliveries = value.deliveries || [];
  const ok =
    value.version === 1 &&
    value.projectId === projectId &&
    value.eventId === eventId &&
    value.status === "complete" &&
    value.known === true &&
    value.validation?.status === "valid" &&
    value.validation?.contractId === "account.created@1" &&
    value.authority?.status === "allowed" &&
    value.authority?.profileId === "backend" &&
    value.authority?.trustedProducerKind === "backend" &&
    value.privacy != null &&
    value.identity?.status === "resolved" &&
    value.decision?.routeEligible === true &&
    deliveries.length === 1 &&
    deliveries[0]?.destination === "posthog" &&
    deliveries[0]?.status === "exported";

  if (!ok) {
    console.error(JSON.stringify(value, null, 2));
    process.exit(1);
  }
' "$INSPECTION" "$PROJECT_ID" "$EVENT_ID" ||
  die "Completed onboarding inspection is incorrect."

case "$SOURCE_KEY" in
  "projects/$PROJECT_ID/events/"*) ;;
  *) die "Inspection returned cross-project source key: $SOURCE_KEY" ;;
esac

say "Proving another project operator cannot inspect the event"
CROSS_INSPECT_STATUS="$(
  inspect_status     "$PROJECT_ID"     "$EVENT_ID"     "$SECOND_OPERATOR_KEY"     "$INSPECT_ENDPOINT"     "$TMP_PREFIX.cross"
)"
[ "$CROSS_INSPECT_STATUS" = "401" ] ||
  die "Cross-project inspect was not rejected: HTTP $CROSS_INSPECT_STATUS"

unset MANAGEMENT_KEY
unset DESTINATION_SECRET_KEY
unset DESTINATION_CREDENTIAL_RESPONSE
unset OPERATOR_KEY
unset SECOND_OPERATOR_KEY
unset PRODUCER_CREDENTIAL
unset QUICKSTART_SOURCE
unset BUNDLE

say "VS10 first external onboarding acceptance passed"
cat <<EOF
{
  "correlationId": "$RUN_ID",
  "projectId": "$PROJECT_ID",
  "secondProjectId": "$SECOND_PROJECT_ID",
  "producerId": "backend-main",
  "eventId": "$EVENT_ID",
  "sourceKey": "$SOURCE_KEY",
  "otlpEndpoint": "$OTLP_ENDPOINT",
  "inspectEndpoint": "$INSPECT_ENDPOINT",
  "unknownEventStatus": "pending_or_unknown",
  "validation": "valid",
  "authority": "allowed",
  "routeEligible": true,
  "posthogDelivery": "exported",
  "crossProjectInspectStatus": 401,
  "generatedQuickstartExecuted": true
}
EOF
