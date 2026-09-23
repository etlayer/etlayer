#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INGEST_DIR="$ROOT_DIR/packages/cloudflare-ingest"
WRANGLER_ENV="${ETLAYER_WRANGLER_ENV:-ci}"
INGEST_URL="${ETLAYER_INGEST_URL:-https://etlayer-ingest-ci.sergii-ponomarov.workers.dev}"
RUN_ID="${RUN_ID:-vs9-$(date -u +%Y%m%d-%H%M%S)-$(openssl rand -hex 4)}"
PROJECT_ID="${VS9_PROJECT_ID:-$RUN_ID-a}"
SECOND_PROJECT_ID="${VS9_SECOND_PROJECT_ID:-$RUN_ID-b}"
PRODUCER_ID="backend-main"
TMP_PREFIX="/tmp/etlayer-vs9-$$"

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

sha256_hex() {
  printf '%s' "$1" |
    openssl dgst -sha256 -r |
    awk '{print $1}'
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
  local status

  status="$(
    request_json       "$method"       "$path"       "$token"       "$body"       "$TMP_PREFIX.response"
  )"

  if [ "$status" -lt 200 ] || [ "$status" -ge 300 ]; then
    printf 'HTTP %s for %s %s\n' "$status" "$method" "$path" >&2
    cat "$TMP_PREFIX.response" >&2 || true
    printf '\n' >&2
    return 1
  fi

  cat "$TMP_PREFIX.response"
}

management_evidence() {
  local key="$1"

  management_json     POST     "/_mgmt/evidence"     "$MANAGEMENT_KEY"     "$(node -e '
      process.stdout.write(
        JSON.stringify({ key: process.argv[1] }),
      );
    ' "$key")"
}

project_evidence_status() {
  local project_id="$1"
  local operator_key="$2"
  local key="$3"
  local output="$4"

  request_json     POST     "/_ops/evidence"     "$operator_key"     "$(node -e '
      const [projectId, key] = process.argv.slice(1);
      process.stdout.write(
        JSON.stringify({ projectId, key }),
      );
    ' "$project_id" "$key")"     "$output"
}

wait_project_evidence() {
  local project_id="$1"
  local operator_key="$2"
  local key="$3"
  local status=""

  for attempt in $(seq 1 40); do
    status="$(
      project_evidence_status         "$project_id"         "$operator_key"         "$key"         "$TMP_PREFIX.evidence" || true
    )"

    if [ "$status" = "200" ]; then
      cat "$TMP_PREFIX.evidence"
      return 0
    fi

    if [ "$status" != "404" ]; then
      printf 'Evidence read failed for %s with HTTP %s\n' "$key" "$status" >&2
      cat "$TMP_PREFIX.evidence" >&2 || true
      printf '\n' >&2
      return 1
    fi

    sleep 1
  done

  printf 'Evidence not found after retries: %s\n' "$key" >&2
  return 1
}

assert_project_evidence_absent() {
  local project_id="$1"
  local operator_key="$2"
  local key="$3"
  local status

  status="$(
    project_evidence_status       "$project_id"       "$operator_key"       "$key"       "$TMP_PREFIX.absent" || true
  )"

  case "$status" in
    404) return 0 ;;
    200) die "Unexpected project evidence exists: $key" ;;
    *)
      die "Unable to verify absence for $key: HTTP $status"
      ;;
  esac
}

send_account_event_status() {
  local token="$1"
  local event_id="$2"
  local correlation_id="$3"
  local claimed_project="$4"
  local output="$5"

  local body
  body="$(
    node -e '
      const [
        eventId,
        correlationId,
        claimedProject,
      ] = process.argv.slice(1);
      const now = (BigInt(Date.now()) * 1000000n).toString();

      process.stdout.write(JSON.stringify({
        resourceLogs: [{
          resource: {
            attributes: [{
              key: "service.name",
              value: {
                stringValue: "etlayer-vs9-acceptance",
              },
            }],
          },
          scopeLogs: [{
            scope: {
              name: "etlayer.vs9.acceptance",
              version: "0.1.0",
            },
            logRecords: [{
              eventName: "account.created",
              timeUnixNano: now,
              observedTimeUnixNano: now,
              attributes: [
                {
                  key: "etlayer.event.id",
                  value: { stringValue: eventId },
                },
                {
                  key: "etlayer.schema.version",
                  value: { intValue: "1" },
                },
                {
                  key: "actor.anonymous.id",
                  value: {
                    stringValue: "anon_vs9_acceptance",
                  },
                },
                {
                  key: "account.id",
                  value: {
                    stringValue: "account_vs9_acceptance",
                  },
                },
                {
                  key: "correlation.id",
                  value: {
                    stringValue: correlationId,
                  },
                },
                {
                  key: "causation.id",
                  value: { stringValue: "vs9_root" },
                },
                {
                  key: "etlayer.producer.kind",
                  value: { stringValue: "backend" },
                },
                {
                  key: "etlayer.authority.kind",
                  value: {
                    stringValue: "business_state",
                  },
                },
                {
                  key: "etlayer.project.id",
                  value: {
                    stringValue: claimedProject,
                  },
                },
              ],
            }],
          }],
        }],
      }));
    ' "$event_id" "$correlation_id" "$claimed_project"
  )"

  curl --silent --show-error \
    -o "$output" \
    -w '%{http_code}' \
    -X POST "$INGEST_URL/v1/logs" \
    -H "authorization: Bearer $token" \
    -H "content-type: application/json" \
    --data "$body"
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

say "Rotating VS9 management credential"
put_secret ETLAYER_MANAGEMENT_KEY "$MANAGEMENT_KEY"
put_secret ETLAYER_DESTINATION_SECRET_KEY_V1 "$DESTINATION_SECRET_KEY"

say "Deploying current project-aware Worker"
(
  cd "$INGEST_DIR"
  npx wrangler deploy --env "$WRANGLER_ENV"
)

say "Creating dynamic project A"
PROJECT_A_RESPONSE="$(
  management_json     POST     "/_mgmt/projects"     "$MANAGEMENT_KEY"     "$(node -e '
      process.stdout.write(
        JSON.stringify({ id: process.argv[1] }),
      );
    ' "$PROJECT_ID")"
)" || die "Failed to create project A."

OPERATOR_A="$(json_field "$PROJECT_A_RESPONSE" operatorCredential)" ||
  die "Project A operator credential missing."

say "Creating dynamic project B for cross-project denial proof"
PROJECT_B_RESPONSE="$(
  management_json     POST     "/_mgmt/projects"     "$MANAGEMENT_KEY"     "$(node -e '
      process.stdout.write(
        JSON.stringify({ id: process.argv[1] }),
      );
    ' "$SECOND_PROJECT_ID")"
)" || die "Failed to create project B."

OPERATOR_B="$(json_field "$PROJECT_B_RESPONSE" operatorCredential)" ||
  die "Project B operator credential missing."

say "Proving project B operator cannot mutate project A"
CROSS_STATUS="$(
  request_json     POST     "/_mgmt/projects/$PROJECT_ID/producers"     "$OPERATOR_B"     '{"id":"forbidden","profileId":"backend"}'     "$TMP_PREFIX.cross"
)"
[ "$CROSS_STATUS" = "401" ] ||
  die "Cross-project operator was not rejected: HTTP $CROSS_STATUS"

say "Enabling PostHog for dynamic project A"
DESTINATION_RESPONSE="$(
  management_json     PUT     "/_mgmt/projects/$PROJECT_ID/destinations/posthog"     "$OPERATOR_A"     '{"enabled":true}'
)" || die "Failed to enable PostHog."

node -e '
  const value = JSON.parse(process.argv[1]);
  const destinations = value.project?.destinations || [];
  if (
    value.destination !== "posthog" ||
    value.enabled !== true ||
    destinations.length !== 1 ||
    destinations[0] !== "posthog"
  ) {
    console.error(JSON.stringify(value, null, 2));
    process.exit(1);
  }
' "$DESTINATION_RESPONSE" ||
  die "Dynamic destination configuration is incorrect."

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

say "Creating dynamic backend producer"
PRODUCER_RESPONSE="$(
  management_json     POST     "/_mgmt/projects/$PROJECT_ID/producers"     "$OPERATOR_A"     '{"id":"backend-main","profileId":"backend"}'
)" || die "Failed to create producer."

PRODUCER_CREDENTIAL_1="$(json_field "$PRODUCER_RESPONSE" credential)" ||
  die "Producer credential missing."

case "$PRODUCER_CREDENTIAL_1" in
  etl_prod_*) ;;
  *) die "Unexpected producer credential shape." ;;
esac

OPERATOR_FINGERPRINT="$(sha256_hex "$OPERATOR_A")"
PRODUCER_FINGERPRINT_1="$(sha256_hex "$PRODUCER_CREDENTIAL_1")"

say "Verifying registry stores fingerprints rather than plaintext credentials"
PROJECT_RECORD="$(
  management_evidence     "registry/projects/$PROJECT_ID.json"
)" || die "Project registry record missing."
OPERATOR_RECORD="$(
  management_evidence     "registry/operators/$OPERATOR_FINGERPRINT.json"
)" || die "Operator registry record missing."
PRODUCER_RECORD="$(
  management_evidence     "registry/producers/$PROJECT_ID/$PRODUCER_ID.json"
)" || die "Producer registry record missing."
CREDENTIAL_RECORD_1="$(
  management_evidence     "registry/producer-credentials/$PRODUCER_FINGERPRINT_1.json"
)" || die "Producer credential registry record missing."

REGISTRY_EVIDENCE="$PROJECT_RECORD
$OPERATOR_RECORD
$PRODUCER_RECORD
$CREDENTIAL_RECORD_1"

printf '%s' "$REGISTRY_EVIDENCE" | grep -Fq "$OPERATOR_A" &&
  die "Plaintext operator credential leaked into registry."
printf '%s' "$REGISTRY_EVIDENCE" | grep -Fq "$PRODUCER_CREDENTIAL_1" &&
  die "Plaintext producer credential leaked into registry."

say "Sending allowed event with initial dynamic producer credential"
EVENT_ID_1="$(uuid)"
EVENT_STATUS_1="$(
  send_account_event_status     "$PRODUCER_CREDENTIAL_1"     "$EVENT_ID_1"     "$RUN_ID-initial"     "$SECOND_PROJECT_ID"     "$TMP_PREFIX.event1"
)"
[ "$EVENT_STATUS_1" = "200" ] ||
  die "Initial dynamic producer event failed: HTTP $EVENT_STATUS_1"

AUTHORITY_KEY_1="projects/$PROJECT_ID/authority/$EVENT_ID_1.json"
AUTHORITY_1="$(
  wait_project_evidence     "$PROJECT_ID"     "$OPERATOR_A"     "$AUTHORITY_KEY_1"
)" || die "Initial authority evidence missing."

SOURCE_KEY_1="$(json_field "$AUTHORITY_1" sourceKey)" ||
  die "Initial source key missing."

node -e '
  const value = JSON.parse(process.argv[1]);
  const projectId = process.argv[2];
  const ok =
    value.projectId === projectId &&
    value.status === "allowed" &&
    value.profileId === "backend" &&
    value.trustedProducerKind === "backend";
  if (!ok) {
    console.error(JSON.stringify(value, null, 2));
    process.exit(1);
  }
' "$AUTHORITY_1" "$PROJECT_ID" ||
  die "Initial dynamic authority evidence is incorrect."

DELIVERY_1="$(
  wait_project_evidence     "$PROJECT_ID"     "$OPERATOR_A"     "projects/$PROJECT_ID/deliveries/posthog/$EVENT_ID_1.json"
)" || die "Initial PostHog delivery evidence missing."

node -e '
  const value = JSON.parse(process.argv[1]);
  if (
    value.projectId !== process.argv[2] ||
    value.destination !== "posthog" ||
    value.status !== "exported"
  ) {
    console.error(JSON.stringify(value, null, 2));
    process.exit(1);
  }
' "$DELIVERY_1" "$PROJECT_ID" ||
  die "Initial PostHog delivery state is incorrect."

assert_project_evidence_absent   "$PROJECT_ID"   "$OPERATOR_A"   "projects/$PROJECT_ID/deliveries/statsig/$EVENT_ID_1.json"

say "Rotating producer credential"
ROTATE_RESPONSE="$(
  management_json     POST     "/_mgmt/projects/$PROJECT_ID/producers/$PRODUCER_ID/rotate"     "$OPERATOR_A"     '{}'
)" || die "Producer rotation failed."

PRODUCER_CREDENTIAL_2="$(json_field "$ROTATE_RESPONSE" credential)" ||
  die "Rotated producer credential missing."

[ "$PRODUCER_CREDENTIAL_1" != "$PRODUCER_CREDENTIAL_2" ] ||
  die "Rotation returned the same credential."

PRODUCER_FINGERPRINT_2="$(sha256_hex "$PRODUCER_CREDENTIAL_2")"

say "Proving old credential is immediately rejected"
OLD_EVENT_ID="$(uuid)"
OLD_STATUS="$(
  send_account_event_status     "$PRODUCER_CREDENTIAL_1"     "$OLD_EVENT_ID"     "$RUN_ID-old-rejected"     "$PROJECT_ID"     "$TMP_PREFIX.old"
)"
[ "$OLD_STATUS" = "401" ] ||
  die "Old credential remained valid after rotation: HTTP $OLD_STATUS"

say "Proving rotated credential is accepted"
EVENT_ID_2="$(uuid)"
NEW_STATUS="$(
  send_account_event_status     "$PRODUCER_CREDENTIAL_2"     "$EVENT_ID_2"     "$RUN_ID-rotated"     "$SECOND_PROJECT_ID"     "$TMP_PREFIX.event2"
)"
[ "$NEW_STATUS" = "200" ] ||
  die "Rotated credential was rejected: HTTP $NEW_STATUS"

AUTHORITY_2="$(
  wait_project_evidence     "$PROJECT_ID"     "$OPERATOR_A"     "projects/$PROJECT_ID/authority/$EVENT_ID_2.json"
)" || die "Rotated event authority evidence missing."

SOURCE_KEY_2="$(json_field "$AUTHORITY_2" sourceKey)" ||
  die "Rotated event source key missing."

CREDENTIAL_RECORD_OLD="$(
  management_evidence     "registry/producer-credentials/$PRODUCER_FINGERPRINT_1.json"
)" || die "Superseded credential record missing."
CREDENTIAL_RECORD_NEW="$(
  management_evidence     "registry/producer-credentials/$PRODUCER_FINGERPRINT_2.json"
)" || die "Current credential record missing."

node -e '
  const oldRecord = JSON.parse(process.argv[1]);
  const newRecord = JSON.parse(process.argv[2]);
  if (
    oldRecord.status !== "superseded" ||
    newRecord.status !== "active"
  ) {
    console.error(
      JSON.stringify({ oldRecord, newRecord }, null, 2),
    );
    process.exit(1);
  }
' "$CREDENTIAL_RECORD_OLD" "$CREDENTIAL_RECORD_NEW" ||
  die "Credential rotation registry state is incorrect."

say "Disabling producer"
DISABLE_RESPONSE="$(
  management_json     POST     "/_mgmt/projects/$PROJECT_ID/producers/$PRODUCER_ID/disable"     "$OPERATOR_A"     '{}'
)" || die "Producer disable failed."

node -e '
  const value = JSON.parse(process.argv[1]);
  if (value.producer?.status !== "disabled") {
    console.error(JSON.stringify(value, null, 2));
    process.exit(1);
  }
' "$DISABLE_RESPONSE" ||
  die "Producer was not disabled."

say "Proving disabled producer credential is rejected"
DISABLED_EVENT_ID="$(uuid)"
DISABLED_STATUS="$(
  send_account_event_status     "$PRODUCER_CREDENTIAL_2"     "$DISABLED_EVENT_ID"     "$RUN_ID-disabled-rejected"     "$PROJECT_ID"     "$TMP_PREFIX.disabled"
)"
[ "$DISABLED_STATUS" = "401" ] ||
  die "Disabled producer credential remained valid: HTTP $DISABLED_STATUS"

unset MANAGEMENT_KEY
unset DESTINATION_SECRET_KEY
unset DESTINATION_CREDENTIAL_RESPONSE
unset OPERATOR_A
unset OPERATOR_B
unset PRODUCER_CREDENTIAL_1
unset PRODUCER_CREDENTIAL_2

say "VS9 dynamic management acceptance passed"
cat <<EOF
{
  "correlationId": "$RUN_ID",
  "projectId": "$PROJECT_ID",
  "secondProjectId": "$SECOND_PROJECT_ID",
  "producerId": "$PRODUCER_ID",
  "initialEventId": "$EVENT_ID_1",
  "rotatedEventId": "$EVENT_ID_2",
  "initialSourceKey": "$SOURCE_KEY_1",
  "rotatedSourceKey": "$SOURCE_KEY_2",
  "dynamicDestinations": ["posthog"],
  "crossProjectOperatorStatus": 401,
  "oldCredentialStatus": 401,
  "disabledCredentialStatus": 401,
  "registryStoresFingerprintsOnly": true,
  "rotationSupersedesOldCredential": true
}
EOF
