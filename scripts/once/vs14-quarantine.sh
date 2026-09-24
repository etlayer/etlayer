#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INGEST_DIR="$ROOT_DIR/packages/cloudflare-ingest"
WRANGLER_ENV="${ETLAYER_WRANGLER_ENV:-ci}"
INGEST_URL="${ETLAYER_INGEST_URL:-https://etlayer-ingest-ci.sergii-ponomarov.workers.dev}"
RUN_ID="${RUN_ID:-vs14-$(date -u +%Y%m%d-%H%M%S)-$(openssl rand -hex 4)}"
PROJECT_ID="${VS14_PROJECT_ID:-$RUN_ID}"
TMP_PREFIX="/tmp/etlayer-vs14-$$"

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

  local args=(
    --silent --show-error
    -o "$output"
    -w '%{http_code}'
    -X "$method"
    "$INGEST_URL$path"
    -H "authorization: Bearer $token"
  )

  if [ -n "$body" ]; then
    args+=(
      -H "content-type: application/json"
      --data "$body"
    )
  fi

  curl "${args[@]}"
}

management_json() {
  local method="$1"
  local path="$2"
  local token="$3"
  local body="$4"
  local status=""

  for attempt in $(seq 1 20); do
    status="$(
      request_json         "$method"         "$path"         "$token"         "$body"         "$TMP_PREFIX.response"
    )"

    if [ "$status" -ge 200 ] && [ "$status" -lt 300 ]; then
      cat "$TMP_PREFIX.response"
      return 0
    fi

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

wait_public_status() {
  local event_id="$1"
  local operator_key="$2"
  local status=""

  for attempt in $(seq 1 45); do
    status="$(
      request_json         GET         "/api/v1/projects/$PROJECT_ID/events/$event_id"         "$operator_key"         ""         "$TMP_PREFIX.status"
    )"

    [ "$status" = "200" ] ||
      die "Public event status failed for $event_id: HTTP $status"

    if node -e '
      const value = JSON.parse(process.argv[1]);
      process.exit(value?.status === "complete" ? 0 : 1);
    ' "$(cat "$TMP_PREFIX.status")"; then
      cat "$TMP_PREFIX.status"
      return 0
    fi

    sleep 1
  done

  printf 'Last event status for %s:\n' "$event_id" >&2
  cat "$TMP_PREFIX.status" >&2 || true
  printf '\n' >&2
  die "Event did not reach complete status: $event_id"
}

emit_event() {
  local mode="$1"
  local event_id="$2"

  node --input-type=module -     "$INGEST_URL/v1/logs"     "$PRODUCER_CREDENTIAL"     "$event_id"     "$RUN_ID"     "$mode" <<'NODE'
const [endpoint, credential, eventId, correlationId, mode] =
  process.argv.slice(2);

const nowUnixNano =
  (BigInt(Date.now()) * 1_000_000n).toString();

const stringAttribute = (key, value) => ({
  key,
  value: { stringValue: value },
});

const intAttribute = (key, value) => ({
  key,
  value: { intValue: String(value) },
});

let eventName;
let attributes;

if (mode === "valid") {
  eventName = "account.created";
  attributes = [
    stringAttribute("etlayer.event.id", eventId),
    intAttribute("etlayer.schema.version", 1),
    stringAttribute("actor.anonymous.id", "anon_vs14"),
    stringAttribute("account.id", "account_vs14"),
    stringAttribute("correlation.id", correlationId),
    stringAttribute("causation.id", "vs14-root"),
    stringAttribute("etlayer.producer.kind", "backend"),
    stringAttribute("etlayer.authority.kind", "business_state"),
  ];
} else if (mode === "quarantine") {
  eventName = "account.created";
  attributes = [
    stringAttribute("etlayer.event.id", eventId),
    intAttribute("etlayer.schema.version", 1),
    stringAttribute("actor.anonymous.id", "anon_vs14"),
    stringAttribute("correlation.id", correlationId),
    stringAttribute("causation.id", "vs14-root"),
    stringAttribute("etlayer.producer.kind", "backend"),
    stringAttribute("etlayer.authority.kind", "business_state"),
  ];
} else if (mode === "block") {
  eventName = "landing.hero.exposed";
  attributes = [
    stringAttribute("etlayer.event.id", eventId),
    intAttribute("etlayer.schema.version", 1),
    stringAttribute("actor.anonymous.id", "anon_vs14"),
    stringAttribute("correlation.id", correlationId),
    stringAttribute("etlayer.producer.kind", "browser"),
    stringAttribute("etlayer.authority.kind", "interaction"),
    stringAttribute("experiment.id", "vs14-authority-proof"),
    stringAttribute("experiment.variant", "a"),
  ];
} else {
  throw new Error("unknown VS14 mode: " + mode);
}

const payload = {
  resourceLogs: [{
    resource: {
      attributes: [
        stringAttribute(
          "service.name",
          "etlayer-vs14-acceptance",
        ),
      ],
    },
    scopeLogs: [{
      scope: {
        name: "etlayer.vs14",
        version: "1",
      },
      logRecords: [{
        eventName,
        timeUnixNano: nowUnixNano,
        observedTimeUnixNano: nowUnixNano,
        attributes,
      }],
    }],
  }],
};

const response = await fetch(endpoint, {
  method: "POST",
  headers: {
    authorization: "Bearer " + credential,
    "content-type": "application/json",
  },
  body: JSON.stringify(payload),
});

if (!response.ok) {
  throw new Error(
    "OTLP ingest failed: HTTP " +
      response.status +
      " " +
      await response.text(),
  );
}
NODE
}

cd "$ROOT_DIR"

if [ -n "${CLOUDFLARE_API_TOKEN:-}" ] &&
   [ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
  say "Using non-interactive Cloudflare API token"
else
  npx wrangler whoami >/dev/null 2>&1 ||
    die "Wrangler is not authenticated"
fi

MANAGEMENT_KEY="$(generate_key)"

say "Rotating VS14 management credential without redeploying the V2-active runtime"
put_secret ETLAYER_MANAGEMENT_KEY "$MANAGEMENT_KEY"

say "Creating isolated VS14 project"
PROJECT_RESPONSE="$(
  management_json     POST     "/_mgmt/projects"     "$MANAGEMENT_KEY"     "$(node -e '
      process.stdout.write(
        JSON.stringify({ id: process.argv[1] }),
      );
    ' "$PROJECT_ID")"
)" || die "Failed to create VS14 project"

OPERATOR_KEY="$(json_field "$PROJECT_RESPONSE" operatorCredential)" ||
  die "VS14 operator credential missing"

say "Enabling PostHog for the VS14 project"
management_json   PUT   "/_mgmt/projects/$PROJECT_ID/destinations/posthog"   "$OPERATOR_KEY"   '{"enabled":true}' >/dev/null ||
  die "Failed to enable VS14 PostHog destination"

management_json   POST   "/_mgmt/projects/$PROJECT_ID/destinations/posthog/credential/bootstrap-runtime-default"   "$MANAGEMENT_KEY"   '{}' >/dev/null ||
  die "Failed to bind VS14 PostHog credential"

say "Provisioning backend producer through the public onboarding contract"
IDEMPOTENCY_KEY="$RUN_ID-onboarding"
ONBOARDING_STATUS="$(
  curl --silent --show-error     -o "$TMP_PREFIX.onboarding"     -w '%{http_code}'     -X POST     "$INGEST_URL/api/v1/projects/$PROJECT_ID/onboarding"     -H "authorization: Bearer $OPERATOR_KEY"     -H "content-type: application/json"     -H "idempotency-key: $IDEMPOTENCY_KEY"     --data '{"producerId":"backend-main","destinations":["posthog"]}'
)"

[ "$ONBOARDING_STATUS" = "201" ] ||
  die "VS14 public onboarding failed: HTTP $ONBOARDING_STATUS"

ONBOARDING="$(cat "$TMP_PREFIX.onboarding")"
PRODUCER_CREDENTIAL="$(json_field "$ONBOARDING" credential)" ||
  die "VS14 producer credential missing"

VALID_ID="$(uuid)"
QUARANTINE_ID="$(uuid)"
BLOCK_ID="$(uuid)"

say "Emitting ALLOW control event"
emit_event valid "$VALID_ID"

say "Emitting recoverable contract failure"
emit_event quarantine "$QUARANTINE_ID"

say "Emitting contract-valid but authority-forged event"
emit_event block "$BLOCK_ID"

ALLOW_STATUS="$(wait_public_status "$VALID_ID" "$OPERATOR_KEY")"
QUARANTINE_STATUS="$(wait_public_status "$QUARANTINE_ID" "$OPERATOR_KEY")"
BLOCK_STATUS="$(wait_public_status "$BLOCK_ID" "$OPERATOR_KEY")"

say "Asserting ALLOW"
node -e '
  const value = JSON.parse(process.argv[1]);
  const posthog = value?.deliveries?.find(
    (delivery) => delivery.destination === "posthog",
  );

  const ok =
    value?.validation?.status === "valid" &&
    value?.authority?.status === "allowed" &&
    value?.decision?.outcome === "allow" &&
    value?.decision?.routeEligible === true &&
    posthog?.status === "exported";

  if (!ok) {
    console.error(JSON.stringify(value, null, 2));
    process.exit(1);
  }
' "$ALLOW_STATUS" || die "ALLOW outcome is incorrect"

say "Asserting QUARANTINE"
node -e '
  const value = JSON.parse(process.argv[1]);
  const errors = value?.validation?.errors || [];
  const posthog = value?.deliveries?.find(
    (delivery) => delivery.destination === "posthog",
  );

  const ok =
    value?.validation?.status === "quarantined" &&
    errors.length === 1 &&
    errors[0]?.code === "required_attribute_missing" &&
    errors[0]?.attribute === "account.id" &&
    value?.authority?.status === "allowed" &&
    value?.decision?.outcome === "quarantine" &&
    value?.decision?.routeEligible === false &&
    posthog?.status === "not_routed";

  if (!ok) {
    console.error(JSON.stringify(value, null, 2));
    process.exit(1);
  }
' "$QUARANTINE_STATUS" || die "QUARANTINE outcome is incorrect"

say "Asserting BLOCK precedence"
node -e '
  const value = JSON.parse(process.argv[1]);
  const posthog = value?.deliveries?.find(
    (delivery) => delivery.destination === "posthog",
  );

  const ok =
    value?.validation?.status === "valid" &&
    value?.authority?.status === "blocked" &&
    value?.decision?.outcome === "block" &&
    value?.decision?.routeEligible === false &&
    posthog?.status === "not_routed";

  if (!ok) {
    console.error(JSON.stringify(value, null, 2));
    process.exit(1);
  }
' "$BLOCK_STATUS" || die "BLOCK outcome is incorrect"

say "Inspecting quarantined event for immutable source coordinate"
INSPECT_STATUS="$(
  request_json     POST     "/_ops/inspect"     "$OPERATOR_KEY"     "$(node -e '
      const [projectId, eventId] = process.argv.slice(1);
      process.stdout.write(
        JSON.stringify({ projectId, eventId }),
      );
    ' "$PROJECT_ID" "$QUARANTINE_ID")"     "$TMP_PREFIX.inspect"
)"

[ "$INSPECT_STATUS" = "200" ] ||
  die "Quarantine inspect failed: HTTP $INSPECT_STATUS"

INSPECTION="$(cat "$TMP_PREFIX.inspect")"
SOURCE_KEY="$(json_field "$INSPECTION" sourceKey)" ||
  die "Quarantine sourceKey missing"

say "Revalidating the same preserved claim without producer re-emission"
REVALIDATE_STATUS="$(
  request_json     POST     "/_ops/revalidate"     "$OPERATOR_KEY"     "$(node -e '
      const [projectId, sourceKey] = process.argv.slice(1);
      process.stdout.write(
        JSON.stringify({ projectId, sourceKey }),
      );
    ' "$PROJECT_ID" "$SOURCE_KEY")"     "$TMP_PREFIX.revalidate"
)"

[ "$REVALIDATE_STATUS" = "200" ] ||
  die "Quarantine revalidation failed: HTTP $REVALIDATE_STATUS"

REVALIDATION="$(cat "$TMP_PREFIX.revalidate")"

node -e '
  const value = JSON.parse(process.argv[1]);
  const ok =
    value?.validation?.status === "quarantined" &&
    value?.authority?.status === "allowed" &&
    value?.decision?.outcome === "quarantine" &&
    value?.decision?.routeEligible === false &&
    Array.isArray(value?.deliveries) &&
    value.deliveries.length === 0;

  if (!ok) {
    console.error(JSON.stringify(value, null, 2));
    process.exit(1);
  }
' "$REVALIDATION" ||
  die "Revalidation did not preserve QUARANTINE"

unset PRODUCER_CREDENTIAL
unset OPERATOR_KEY
unset MANAGEMENT_KEY

say "VS14 first-class quarantine acceptance passed"
cat <<EOF
{
  "correlationId": "$RUN_ID",
  "projectId": "$PROJECT_ID",
  "allowEventId": "$VALID_ID",
  "quarantineEventId": "$QUARANTINE_ID",
  "blockEventId": "$BLOCK_ID",
  "allow": {
    "validation": "valid",
    "authority": "allowed",
    "decision": "allow",
    "posthog": "exported"
  },
  "quarantine": {
    "validation": "quarantined",
    "authority": "allowed",
    "decision": "quarantine",
    "posthog": "not_routed",
    "revalidation": "quarantine_without_producer_reemission"
  },
  "block": {
    "validation": "valid",
    "authority": "blocked",
    "decision": "block",
    "posthog": "not_routed"
  }
}
EOF
