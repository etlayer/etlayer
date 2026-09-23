#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INGEST_DIR="$ROOT_DIR/packages/cloudflare-ingest"
WRANGLER_ENV="${ETLAYER_WRANGLER_ENV:-ci}"
INGEST_URL="${ETLAYER_INGEST_URL:-https://etlayer-ingest-ci.sergii-ponomarov.workers.dev}"
RUN_ID="${RUN_ID:-vs12-$(date -u +%Y%m%d-%H%M%S)-$(openssl rand -hex 4)}"
PROJECT_A="${VS12_PROJECT_A:-$RUN_ID-a}"
PROJECT_B="${VS12_PROJECT_B:-$RUN_ID-b}"
TMP_PREFIX="/tmp/etlayer-vs12-$$"

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

    # Secret propagation can briefly expose the previous credential version.
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

create_project() {
  local project_id="$1"

  management_json \
    POST \
    "/_mgmt/projects" \
    "$MANAGEMENT_KEY" \
    "$(node -e '
      process.stdout.write(
        JSON.stringify({ id: process.argv[1] }),
      );
    ' "$project_id")"
}

configure_posthog() {
  local project_id="$1"
  local operator_key="$2"

  management_json \
    PUT \
    "/_mgmt/projects/$project_id/destinations/posthog" \
    "$operator_key" \
    '{"enabled":true}'
}

bootstrap_posthog_credential() {
  local project_id="$1"

  management_json \
    POST \
    "/_mgmt/projects/$project_id/destinations/posthog/credential/bootstrap-runtime-default" \
    "$MANAGEMENT_KEY" \
    '{}'
}

management_evidence() {
  local key="$1"

  management_json \
    POST \
    "/_mgmt/evidence" \
    "$MANAGEMENT_KEY" \
    "$(node -e '
      process.stdout.write(
        JSON.stringify({ key: process.argv[1] }),
      );
    ' "$key")"
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
IDEMPOTENCY_SECRET_KEY="$(generate_key)"

say "Rotating VS12 CI credentials"
put_secret ETLAYER_MANAGEMENT_KEY "$MANAGEMENT_KEY"
put_secret ETLAYER_DESTINATION_SECRET_KEY_V1 "$DESTINATION_SECRET_KEY"
put_secret ETLAYER_IDEMPOTENCY_SECRET_KEY_V1 "$IDEMPOTENCY_SECRET_KEY"

say "Deploying current Worker"
(
  cd "$INGEST_DIR"
  npx wrangler deploy --env "$WRANGLER_ENV"
)

say "Creating external-consumer projects"
PROJECT_A_RESPONSE="$(create_project "$PROJECT_A")" ||
  die "Failed to create project A."
PROJECT_B_RESPONSE="$(create_project "$PROJECT_B")" ||
  die "Failed to create project B."

OPERATOR_A="$(json_field "$PROJECT_A_RESPONSE" operatorCredential)" ||
  die "Project A operator credential missing."
OPERATOR_B="$(json_field "$PROJECT_B_RESPONSE" operatorCredential)" ||
  die "Project B operator credential missing."

say "Configuring project A PostHog destination"
configure_posthog "$PROJECT_A" "$OPERATOR_A" >/dev/null ||
  die "Failed to enable PostHog for project A."

bootstrap_posthog_credential "$PROJECT_A" >/dev/null ||
  die "Failed to bind project A PostHog credential."

say "Checking external-consumer dependency boundary"
node scripts/check-external-consumer-boundary.mjs

say "Running clean external consumer"
ETLAYER_BASE_URL="$INGEST_URL" \
ETLAYER_PROJECT_ID="$PROJECT_A" \
ETLAYER_OPERATOR_CREDENTIAL="$OPERATOR_A" \
  node examples/external-consumer/run.mjs |
  tee "$TMP_PREFIX.external"

EXTERNAL_JSON="$(cat "$TMP_PREFIX.external")"
EVENT_ID="$(json_field "$EXTERNAL_JSON" eventId)" ||
  die "External consumer event ID missing."
IDEMPOTENCY_FINGERPRINT="$(
  json_field "$EXTERNAL_JSON" idempotencyKeyFingerprint
)" || die "Idempotency fingerprint missing."

say "Proving cross-project public event access is denied"
CROSS_STATUS="$(
  curl --silent --show-error \
    -o "$TMP_PREFIX.cross" \
    -w '%{http_code}' \
    -X GET \
    "$INGEST_URL/api/v1/projects/$PROJECT_A/events/$EVENT_ID" \
    -H "authorization: Bearer $OPERATOR_B"
)"

[ "$CROSS_STATUS" = "401" ] ||
  die "Cross-project event status returned HTTP $CROSS_STATUS"

node -e '
  const value = JSON.parse(process.argv[1]);
  if (value?.error?.code !== "invalid_operator_credential") {
    console.error(JSON.stringify(value, null, 2));
    process.exit(1);
  }
' "$(cat "$TMP_PREFIX.cross")" ||
  die "Cross-project denial did not use stable public error code."

say "Inspecting encrypted idempotency evidence through privileged test setup"
IDEMPOTENCY_KEY="registry/idempotency/$PROJECT_A/onboarding-v1/$IDEMPOTENCY_FINGERPRINT.json"
IDEMPOTENCY_RECORD="$(management_evidence "$IDEMPOTENCY_KEY")" ||
  die "Idempotency evidence missing."

node -e '
  const value = JSON.parse(process.argv[1]);
  const raw = process.argv[1];

  if (
    value.kind !== "public_idempotency" ||
    value.status !== "completed" ||
    value.algorithm !== "AES-256-GCM" ||
    value.keyVersion !== "v1" ||
    typeof value.ciphertext !== "string" ||
    typeof value.iv !== "string" ||
    raw.includes("etl_prod_")
  ) {
    console.error(JSON.stringify(value, null, 2));
    process.exit(1);
  }
' "$IDEMPOTENCY_RECORD" ||
  die "Idempotency evidence is not encrypted/redacted as required."

unset MANAGEMENT_KEY
unset DESTINATION_SECRET_KEY
unset IDEMPOTENCY_SECRET_KEY
unset OPERATOR_A
unset OPERATOR_B

say "VS12 external integration contract acceptance passed"
cat <<EOF
{
  "correlationId": "$RUN_ID",
  "projectA": "$PROJECT_A",
  "projectB": "$PROJECT_B",
  "eventId": "$EVENT_ID",
  "idempotencyKeyFingerprint": "$IDEMPOTENCY_FINGERPRINT",
  "publicOnboarding": true,
  "idempotencyReplay": true,
  "crossProjectStatus": 401,
  "crossProjectErrorCode": "invalid_operator_credential",
  "idempotencyEvidenceEncrypted": true,
  "externalConsumerBoundary": true
}
EOF
