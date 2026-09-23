#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INGEST_DIR="$ROOT_DIR/packages/cloudflare-ingest"
WRANGLER_ENV="${ETLAYER_WRANGLER_ENV:-ci}"
INGEST_URL="${ETLAYER_INGEST_URL:-https://etlayer-ingest-ci.sergii-ponomarov.workers.dev}"
RUN_ID="${RUN_ID:-vs11-$(date -u +%Y%m%d-%H%M%S)-$(openssl rand -hex 4)}"
PROJECT_A="${VS11_PROJECT_A:-$RUN_ID-a}"
PROJECT_B="${VS11_PROJECT_B:-$RUN_ID-b}"
PRODUCER_ID="backend-main"
CANARY_SECRET="vs11-shared-plaintext-canary-$RUN_ID"
TMP_PREFIX="/tmp/etlayer-vs11-$$"

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

  curl --silent --show-error     -o "$output"     -w '%{http_code}'     -X "$method" "$INGEST_URL$path"     -H "authorization: Bearer $token"     -H "content-type: application/json"     --data "$body"
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

management_evidence() {
  local key="$1"

  management_json     POST     "/_mgmt/evidence"     "$MANAGEMENT_KEY"     "$(node -e '
      process.stdout.write(
        JSON.stringify({ key: process.argv[1] }),
      );
    ' "$key")"
}

create_project() {
  local project_id="$1"

  management_json     POST     "/_mgmt/projects"     "$MANAGEMENT_KEY"     "$(node -e '
      process.stdout.write(
        JSON.stringify({ id: process.argv[1] }),
      );
    ' "$project_id")"
}

configure_posthog() {
  local project_id="$1"
  local operator_key="$2"

  management_json     PUT     "/_mgmt/projects/$project_id/destinations/posthog"     "$operator_key"     '{"enabled":true}'
}

write_canary_credential() {
  local project_id="$1"
  local operator_key="$2"

  management_json     PUT     "/_mgmt/projects/$project_id/destinations/posthog/credential"     "$operator_key"     "$(node -e '
      process.stdout.write(
        JSON.stringify({ secret: process.argv[1] }),
      );
    ' "$CANARY_SECRET")"
}

bootstrap_runtime_credential() {
  local project_id="$1"

  management_json     POST     "/_mgmt/projects/$project_id/destinations/posthog/credential/bootstrap-runtime-default"     "$MANAGEMENT_KEY"     '{}'
}

create_producer() {
  local project_id="$1"
  local operator_key="$2"

  management_json     POST     "/_mgmt/projects/$project_id/producers"     "$operator_key"     '{"id":"backend-main","profileId":"backend"}'
}

send_account_event_status() {
  local token="$1"
  local event_id="$2"
  local correlation_id="$3"
  local output="$4"

  local body
  body="$(
    node -e '
      const [eventId, correlationId] = process.argv.slice(1);
      const now = (BigInt(Date.now()) * 1000000n).toString();

      process.stdout.write(JSON.stringify({
        resourceLogs: [{
          resource: {
            attributes: [{
              key: "service.name",
              value: { stringValue: "etlayer-vs11-acceptance" },
            }],
          },
          scopeLogs: [{
            scope: {
              name: "etlayer.vs11.acceptance",
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
                    stringValue: "anon_vs11_acceptance",
                  },
                },
                {
                  key: "account.id",
                  value: {
                    stringValue: "account_vs11_acceptance",
                  },
                },
                {
                  key: "correlation.id",
                  value: { stringValue: correlationId },
                },
                {
                  key: "causation.id",
                  value: { stringValue: "vs11-root" },
                },
                {
                  key: "etlayer.producer.kind",
                  value: { stringValue: "backend" },
                },
                {
                  key: "etlayer.authority.kind",
                  value: { stringValue: "business_state" },
                },
              ],
            }],
          }],
        }],
      }));
    ' "$event_id" "$correlation_id"
  )"

  curl --silent --show-error     -o "$output"     -w '%{http_code}'     -X POST "$INGEST_URL/v1/logs"     -H "authorization: Bearer $token"     -H "content-type: application/json"     --data "$body"
}

inspect_status() {
  local project_id="$1"
  local event_id="$2"
  local operator_key="$3"
  local output="$4"

  request_json     POST     "/_ops/inspect"     "$operator_key"     "$(node -e '
      const [projectId, eventId] = process.argv.slice(1);
      process.stdout.write(
        JSON.stringify({ projectId, eventId }),
      );
    ' "$project_id" "$event_id")"     "$output"
}

wait_inspection_status() {
  local project_id="$1"
  local event_id="$2"
  local operator_key="$3"
  local expected_delivery="$4"

  for attempt in $(seq 1 45); do
    local status
    status="$(
      inspect_status         "$project_id"         "$event_id"         "$operator_key"         "$TMP_PREFIX.inspect" || true
    )"

    if [ "$status" != "200" ]; then
      printf 'Inspect failed with HTTP %s\n' "$status" >&2
      cat "$TMP_PREFIX.inspect" >&2 || true
      return 1
    fi

    if node -e '
      const value = JSON.parse(process.argv[1]);
      const expected = process.argv[2];
      const delivery = value.deliveries?.find(
        item => item.destination === "posthog",
      );

      if (
        value.status === "complete" &&
        value.validation?.status === "valid" &&
        value.authority?.status === "allowed" &&
        value.decision?.routeEligible === true &&
        delivery?.status === expected
      ) {
        process.exit(0);
      }

      process.exit(1);
    ' "$(cat "$TMP_PREFIX.inspect")" "$expected_delivery"; then
      cat "$TMP_PREFIX.inspect"
      return 0
    fi

    sleep 1
  done

  printf 'Inspect never reached expected PostHog state %s for %s\n'     "$expected_delivery" "$event_id" >&2
  cat "$TMP_PREFIX.inspect" >&2 || true
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

say "Rotating VS11 management and destination master credentials"
put_secret ETLAYER_MANAGEMENT_KEY "$MANAGEMENT_KEY"
put_secret ETLAYER_DESTINATION_SECRET_KEY_V1 "$DESTINATION_SECRET_KEY"

say "Deploying current Worker"
(
  cd "$INGEST_DIR"
  npx wrangler deploy --env "$WRANGLER_ENV"
)

say "Creating projects A and B"
PROJECT_A_RESPONSE="$(create_project "$PROJECT_A")" ||
  die "Failed to create project A."
PROJECT_B_RESPONSE="$(create_project "$PROJECT_B")" ||
  die "Failed to create project B."

OPERATOR_A="$(json_field "$PROJECT_A_RESPONSE" operatorCredential)" ||
  die "Project A operator credential missing."
OPERATOR_B="$(json_field "$PROJECT_B_RESPONSE" operatorCredential)" ||
  die "Project B operator credential missing."

configure_posthog "$PROJECT_A" "$OPERATOR_A" >/dev/null ||
  die "Failed to enable PostHog for project A."
configure_posthog "$PROJECT_B" "$OPERATOR_B" >/dev/null ||
  die "Failed to enable PostHog for project B."

say "Writing the same known plaintext canary into both project secret stores"
CANARY_A="$(write_canary_credential "$PROJECT_A" "$OPERATOR_A")" ||
  die "Failed to write project A canary credential."
CANARY_B="$(write_canary_credential "$PROJECT_B" "$OPERATOR_B")" ||
  die "Failed to write project B canary credential."

CANARY_ID_A="$(json_field "$CANARY_A" credential.credentialId)" ||
  die "Project A canary credential id missing."
CANARY_ID_B="$(json_field "$CANARY_B" credential.credentialId)" ||
  die "Project B canary credential id missing."

CANARY_KEY_A="registry/destination-credentials/$PROJECT_A/posthog/versions/$CANARY_ID_A.json"
CANARY_KEY_B="registry/destination-credentials/$PROJECT_B/posthog/versions/$CANARY_ID_B.json"

CANARY_RECORD_A="$(management_evidence "$CANARY_KEY_A")" ||
  die "Project A encrypted canary evidence missing."
CANARY_RECORD_B="$(management_evidence "$CANARY_KEY_B")" ||
  die "Project B encrypted canary evidence missing."

printf '%s' "$CANARY_RECORD_A" | grep -Fq "$CANARY_SECRET" &&
  die "Plaintext canary leaked into project A registry evidence."
printf '%s' "$CANARY_RECORD_B" | grep -Fq "$CANARY_SECRET" &&
  die "Plaintext canary leaked into project B registry evidence."

CIPHERTEXT_A="$(json_field "$CANARY_RECORD_A" ciphertext)" ||
  die "Project A ciphertext missing."
CIPHERTEXT_B="$(json_field "$CANARY_RECORD_B" ciphertext)" ||
  die "Project B ciphertext missing."
IV_A="$(json_field "$CANARY_RECORD_A" iv)" ||
  die "Project A IV missing."
IV_B="$(json_field "$CANARY_RECORD_B" iv)" ||
  die "Project B IV missing."

[ "$CIPHERTEXT_A" != "$CIPHERTEXT_B" ] ||
  die "Same plaintext produced identical ciphertext across projects."
[ "$IV_A" != "$IV_B" ] ||
  die "Same plaintext reused IV across projects."

say "Bootstrapping real CI PostHog credential into both encrypted project stores"
RUNTIME_A_1="$(bootstrap_runtime_credential "$PROJECT_A")" ||
  die "Failed to bootstrap project A runtime credential."
RUNTIME_B_1="$(bootstrap_runtime_credential "$PROJECT_B")" ||
  die "Failed to bootstrap project B runtime credential."

RUNTIME_ID_A_1="$(json_field "$RUNTIME_A_1" credential.credentialId)" ||
  die "Project A runtime credential id missing."
RUNTIME_ID_B_1="$(json_field "$RUNTIME_B_1" credential.credentialId)" ||
  die "Project B runtime credential id missing."

[ "$RUNTIME_ID_A_1" != "$CANARY_ID_A" ] ||
  die "Project A runtime bootstrap did not rotate credential."
[ "$RUNTIME_ID_B_1" != "$CANARY_ID_B" ] ||
  die "Project B runtime bootstrap did not rotate credential."

say "Creating backend producers"
PRODUCER_A_RESPONSE="$(create_producer "$PROJECT_A" "$OPERATOR_A")" ||
  die "Failed to create project A producer."
PRODUCER_B_RESPONSE="$(create_producer "$PROJECT_B" "$OPERATOR_B")" ||
  die "Failed to create project B producer."

PRODUCER_A="$(json_field "$PRODUCER_A_RESPONSE" credential)" ||
  die "Project A producer credential missing."
PRODUCER_B="$(json_field "$PRODUCER_B_RESPONSE" credential)" ||
  die "Project B producer credential missing."

say "Delivering one event from each project"
EVENT_A_1="$(uuid)"
EVENT_B_1="$(uuid)"

STATUS_A_1="$(
  send_account_event_status     "$PRODUCER_A"     "$EVENT_A_1"     "$RUN_ID-a-initial"     "$TMP_PREFIX.a1"
)"
STATUS_B_1="$(
  send_account_event_status     "$PRODUCER_B"     "$EVENT_B_1"     "$RUN_ID-b-initial"     "$TMP_PREFIX.b1"
)"

[ "$STATUS_A_1" = "200" ] ||
  die "Project A event failed: HTTP $STATUS_A_1"
[ "$STATUS_B_1" = "200" ] ||
  die "Project B event failed: HTTP $STATUS_B_1"

INSPECT_A_1="$(
  wait_inspection_status     "$PROJECT_A"     "$EVENT_A_1"     "$OPERATOR_A"     "exported"
)" || die "Project A event did not export."

INSPECT_B_1="$(
  wait_inspection_status     "$PROJECT_B"     "$EVENT_B_1"     "$OPERATOR_B"     "exported"
)" || die "Project B event did not export."

say "Rotating project A destination credential using the same runtime secret"
RUNTIME_A_2="$(bootstrap_runtime_credential "$PROJECT_A")" ||
  die "Failed to rotate project A runtime credential."
RUNTIME_ID_A_2="$(json_field "$RUNTIME_A_2" credential.credentialId)" ||
  die "Rotated project A credential id missing."

[ "$RUNTIME_ID_A_2" != "$RUNTIME_ID_A_1" ] ||
  die "Project A destination credential id did not rotate."

RUNTIME_KEY_A_1="registry/destination-credentials/$PROJECT_A/posthog/versions/$RUNTIME_ID_A_1.json"
RUNTIME_KEY_A_2="registry/destination-credentials/$PROJECT_A/posthog/versions/$RUNTIME_ID_A_2.json"

RUNTIME_RECORD_A_1="$(management_evidence "$RUNTIME_KEY_A_1")" ||
  die "Project A old runtime credential evidence missing."
RUNTIME_RECORD_A_2="$(management_evidence "$RUNTIME_KEY_A_2")" ||
  die "Project A new runtime credential evidence missing."

RUNTIME_CIPHERTEXT_A_1="$(json_field "$RUNTIME_RECORD_A_1" ciphertext)" ||
  die "Old project A runtime ciphertext missing."
RUNTIME_CIPHERTEXT_A_2="$(json_field "$RUNTIME_RECORD_A_2" ciphertext)" ||
  die "New project A runtime ciphertext missing."

[ "$RUNTIME_CIPHERTEXT_A_1" != "$RUNTIME_CIPHERTEXT_A_2" ] ||
  die "Runtime credential rotation reused ciphertext."

say "Proving rotated project A credential still exports"
EVENT_A_2="$(uuid)"
STATUS_A_2="$(
  send_account_event_status     "$PRODUCER_A"     "$EVENT_A_2"     "$RUN_ID-a-rotated"     "$TMP_PREFIX.a2"
)"
[ "$STATUS_A_2" = "200" ] ||
  die "Project A rotated event failed: HTTP $STATUS_A_2"

INSPECT_A_2="$(
  wait_inspection_status     "$PROJECT_A"     "$EVENT_A_2"     "$OPERATOR_A"     "exported"
)" || die "Project A rotated event did not export."

say "Disabling project B destination credential"
DISABLE_B="$(
  management_json     POST     "/_mgmt/projects/$PROJECT_B/destinations/posthog/credential/disable"     "$OPERATOR_B"     '{}'
)" || die "Failed to disable project B destination credential."

node -e '
  const value = JSON.parse(process.argv[1]);
  if (
    value.credential?.configured !== false ||
    value.credential?.status !== "disabled"
  ) {
    console.error(JSON.stringify(value, null, 2));
    process.exit(1);
  }
' "$DISABLE_B" ||
  die "Project B credential disable state is incorrect."

say "Proving disabled project B credential no longer exports"
EVENT_B_2="$(uuid)"
STATUS_B_2="$(
  send_account_event_status     "$PRODUCER_B"     "$EVENT_B_2"     "$RUN_ID-b-disabled"     "$TMP_PREFIX.b2"
)"
[ "$STATUS_B_2" = "200" ] ||
  die "Project B disabled-credential event ingest failed: HTTP $STATUS_B_2"

INSPECT_B_2="$(
  wait_inspection_status     "$PROJECT_B"     "$EVENT_B_2"     "$OPERATOR_B"     "skipped"
)" || die "Project B disabled credential did not produce skipped delivery."

node -e '
  const value = JSON.parse(process.argv[1]);
  const delivery = value.deliveries?.find(
    item => item.destination === "posthog",
  );
  if (
    delivery?.status !== "skipped" ||
    delivery?.state?.reason !== "posthog_not_configured"
  ) {
    console.error(JSON.stringify(value, null, 2));
    process.exit(1);
  }
' "$INSPECT_B_2" ||
  die "Project B disabled delivery reason is incorrect."

SOURCE_A_1="$(json_field "$INSPECT_A_1" sourceKey)"
SOURCE_B_1="$(json_field "$INSPECT_B_1" sourceKey)"
SOURCE_A_2="$(json_field "$INSPECT_A_2" sourceKey)"
SOURCE_B_2="$(json_field "$INSPECT_B_2" sourceKey)"

unset MANAGEMENT_KEY
unset DESTINATION_SECRET_KEY
unset OPERATOR_A
unset OPERATOR_B
unset PRODUCER_A
unset PRODUCER_B
unset CANARY_SECRET
unset CIPHERTEXT_A
unset CIPHERTEXT_B
unset RUNTIME_CIPHERTEXT_A_1
unset RUNTIME_CIPHERTEXT_A_2

say "VS11 project-scoped destination credential acceptance passed"
cat <<EOF
{
  "correlationId": "$RUN_ID",
  "projectA": "$PROJECT_A",
  "projectB": "$PROJECT_B",
  "projectAInitialEventId": "$EVENT_A_1",
  "projectBInitialEventId": "$EVENT_B_1",
  "projectARotatedEventId": "$EVENT_A_2",
  "projectBDisabledEventId": "$EVENT_B_2",
  "projectAInitialSourceKey": "$SOURCE_A_1",
  "projectBInitialSourceKey": "$SOURCE_B_1",
  "projectARotatedSourceKey": "$SOURCE_A_2",
  "projectBDisabledSourceKey": "$SOURCE_B_2",
  "samePlaintextDifferentCiphertext": true,
  "samePlaintextDifferentIv": true,
  "plaintextCanaryAbsentFromRegistry": true,
  "projectARuntimeCredentialRotated": true,
  "projectAInitialDelivery": "exported",
  "projectBInitialDelivery": "exported",
  "projectARotatedDelivery": "exported",
  "projectBDisabledDelivery": "skipped",
  "projectBDisabledReason": "posthog_not_configured"
}
EOF
