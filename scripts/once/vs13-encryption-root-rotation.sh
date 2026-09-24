#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INGEST_DIR="$ROOT_DIR/packages/cloudflare-ingest"
CONFIG_PATH="$INGEST_DIR/wrangler.jsonc"
WRANGLER_ENV="${ETLAYER_WRANGLER_ENV:-ci}"
INGEST_URL="${ETLAYER_INGEST_URL:-https://etlayer-ingest-ci.sergii-ponomarov.workers.dev}"
RUN_ID="${RUN_ID:-vs13-$(date -u +%Y%m%d-%H%M%S)-$(openssl rand -hex 4)}"
PROJECT_A="$RUN_ID-a"
PROJECT_B="$RUN_ID-b"
TMP_PREFIX="/tmp/etlayer-vs13-$$"
CONFIG_BACKUP="$TMP_PREFIX.wrangler.jsonc"

say() {
  printf '\n==> %s\n' "$*"
}

die() {
  printf '\nERROR: %s\n' "$*" >&2
  exit 1
}

cleanup() {
  if [ -f "$CONFIG_BACKUP" ]; then
    cp "$CONFIG_BACKUP" "$CONFIG_PATH"
  fi
  rm -f "$TMP_PREFIX".*
}

trap cleanup EXIT
cp "$CONFIG_PATH" "$CONFIG_BACKUP"

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

secret_exists() {
  local name="$1"
  local listing

  listing="$(
    cd "$INGEST_DIR"
    npx wrangler secret list \
      --env "$WRANGLER_ENV" \
      --format json 2>/dev/null
  )"

  node -e '
    const secrets = JSON.parse(process.argv[1]);
    const name = process.argv[2];
    process.exit(
      secrets.some((secret) => secret?.name === name)
        ? 0
        : 1,
    );
  ' "$listing" "$name"
}

ensure_v2_root() {
  local name="$1"

  if secret_exists "$name"; then
    printf 'stable CI secret exists: %s\n' "$name"
    return
  fi

  say "Provisioning CI-only $name once"
  local value
  value="$(generate_key)"
  put_secret "$name" "$value"
  unset value
}

set_active_versions() {
  local destination_version="$1"
  local idempotency_version="$2"

  node --input-type=module -e '
    import fs from "node:fs";

    const [path, destinationVersion, idempotencyVersion] =
      process.argv.slice(1);
    const config = JSON.parse(
      fs.readFileSync(path, "utf8"),
    );

    config.env ||= {};
    config.env.ci ||= {};
    config.env.ci.vars ||= {};

    config.env.ci.vars.ETLAYER_DESTINATION_SECRET_ACTIVE_VERSION =
      destinationVersion;
    config.env.ci.vars.ETLAYER_IDEMPOTENCY_SECRET_ACTIVE_VERSION =
      idempotencyVersion;

    fs.writeFileSync(
      path,
      JSON.stringify(config, null, 2) + "\n",
    );
  ' "$CONFIG_PATH" "$destination_version" "$idempotency_version"
}

deploy_worker() {
  (
    cd "$INGEST_DIR"
    npx wrangler deploy --env "$WRANGLER_ENV"
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

json_hash_field() {
  local json="$1"
  local path="$2"

  node -e '
    const crypto = require("node:crypto");
    const value = JSON.parse(process.argv[1]);
    const path = process.argv[2].split(".");
    let current = value;
    for (const key of path) current = current?.[key];
    if (typeof current !== "string") process.exit(1);
    process.stdout.write(
      crypto
        .createHash("sha256")
        .update(current)
        .digest("hex"),
    );
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

management_get() {
  local path="$1"
  local token="$2"
  local output="$3"

  curl --silent --show-error \
    -o "$output" \
    -w '%{http_code}' \
    -X GET "$INGEST_URL$path" \
    -H "authorization: Bearer $token"
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

enable_posthog() {
  local project_id="$1"
  local operator_key="$2"

  management_json \
    PUT \
    "/_mgmt/projects/$project_id/destinations/posthog" \
    "$operator_key" \
    '{"enabled":true}'
}

bootstrap_posthog() {
  local project_id="$1"

  management_json \
    POST \
    "/_mgmt/projects/$project_id/destinations/posthog/credential/bootstrap-runtime-default" \
    "$MANAGEMENT_KEY" \
    '{}'
}

credential_status() {
  local project_id="$1"
  local operator_key="$2"
  local status

  status="$(
    management_get \
      "/_mgmt/projects/$project_id/destinations/posthog/credential" \
      "$operator_key" \
      "$TMP_PREFIX.status"
  )"

  [ "$status" = "200" ] ||
    die "credential status failed: HTTP $status"

  cat "$TMP_PREFIX.status"
}

key_usage() {
  local status

  status="$(
    management_get \
      "/_mgmt/encryption/key-usage" \
      "$MANAGEMENT_KEY" \
      "$TMP_PREFIX.usage"
  )"

  [ "$status" = "200" ] ||
    die "key usage audit failed: HTTP $status"

  cat "$TMP_PREFIX.usage"
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

public_onboarding() {
  local project_id="$1"
  local operator_key="$2"
  local idempotency_key="$3"
  local headers="$4"
  local output="$5"

  curl --silent --show-error \
    -D "$headers" \
    -o "$output" \
    -w '%{http_code}' \
    -X POST \
    "$INGEST_URL/api/v1/projects/$project_id/onboarding" \
    -H "authorization: Bearer $operator_key" \
    -H "content-type: application/json" \
    -H "idempotency-key: $idempotency_key" \
    --data '{"producerId":"backend-main","destinations":["posthog"]}'
}

rewrap_posthog() {
  local project_id="$1"

  management_json \
    POST \
    "/_mgmt/projects/$project_id/destinations/posthog/credential/rewrap" \
    "$MANAGEMENT_KEY" \
    '{"targetKeyVersion":"v2"}'
}

execute_quickstart() {
  local onboarding_json="$1"
  local output="$2"
  local source_file="$TMP_PREFIX.quickstart.mjs"

  node -e '
    const value = JSON.parse(process.argv[1]);
    if (typeof value?.quickstart?.source !== "string") {
      process.exit(1);
    }
    require("node:fs").writeFileSync(
      process.argv[2],
      value.quickstart.source,
      "utf8",
    );
  ' "$onboarding_json" "$source_file" ||
    die "quickstart source missing"

  node "$source_file" >"$output" ||
    die "quickstart execution failed"
}

wait_for_export() {
  local project_id="$1"
  local event_id="$2"
  local operator_key="$3"

  for attempt in $(seq 1 45); do
    local status
    status="$(
      curl --silent --show-error \
        -o "$TMP_PREFIX.event-status" \
        -w '%{http_code}' \
        -X GET \
        "$INGEST_URL/api/v1/projects/$project_id/events/$event_id" \
        -H "authorization: Bearer $operator_key"
    )"

    [ "$status" = "200" ] ||
      die "event status failed: HTTP $status"

    if node -e '
      const value = JSON.parse(process.argv[1]);
      const posthog = value?.deliveries?.find(
        (delivery) => delivery.destination === "posthog",
      );
      process.exit(
        value?.status === "complete" &&
        value?.validation?.status === "valid" &&
        value?.authority?.status === "allowed" &&
        value?.decision?.routeEligible === true &&
        posthog?.status === "exported"
          ? 0
          : 1,
      );
    ' "$(cat "$TMP_PREFIX.event-status")"; then
      cat "$TMP_PREFIX.event-status"
      return 0
    fi

    sleep 1
  done

  die "event did not reach exported complete status"
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

say "Ensuring persistent CI V2 encryption roots exist"
ensure_v2_root ETLAYER_DESTINATION_SECRET_KEY_V2
ensure_v2_root ETLAYER_IDEMPOTENCY_SECRET_KEY_V2

say "Rotating ordinary VS13 management credential"
put_secret ETLAYER_MANAGEMENT_KEY "$MANAGEMENT_KEY"

say "Phase A: deploying with V1 as active write version"
set_active_versions v1 v1
deploy_worker

say "Creating V1 project A"
PROJECT_A_RESPONSE="$(create_project "$PROJECT_A")" ||
  die "Failed to create project A"
OPERATOR_A="$(json_field "$PROJECT_A_RESPONSE" operatorCredential)" ||
  die "Project A operator credential missing"

enable_posthog "$PROJECT_A" "$OPERATOR_A" >/dev/null ||
  die "Failed to enable project A PostHog"
bootstrap_posthog "$PROJECT_A" >/dev/null ||
  die "Failed to bootstrap project A PostHog credential"

STATUS_A_V1="$(credential_status "$PROJECT_A" "$OPERATOR_A")"
[ "$(json_field "$STATUS_A_V1" credential.keyVersion)" = "v1" ] ||
  die "Project A destination credential was not written under V1"
OLD_CREDENTIAL_ID="$(json_field "$STATUS_A_V1" credential.credentialId)"

IDEMPOTENCY_A="$RUN_ID-idempotency-a"

say "Running external consumer against V1 state"
ETLAYER_BASE_URL="$INGEST_URL" \
ETLAYER_PROJECT_ID="$PROJECT_A" \
ETLAYER_OPERATOR_CREDENTIAL="$OPERATOR_A" \
ETLAYER_IDEMPOTENCY_KEY="$IDEMPOTENCY_A" \
  node examples/external-consumer/run.mjs |
  tee "$TMP_PREFIX.consumer-a"

CONSUMER_A="$(cat "$TMP_PREFIX.consumer-a")"
EVENT_A_V1="$(json_field "$CONSUMER_A" eventId)"
IDEMPOTENCY_A_FP="$(
  json_field "$CONSUMER_A" idempotencyKeyFingerprint
)"
PRODUCER_A_FP="$(
  json_field "$CONSUMER_A" producerCredentialFingerprint
)"

IDEMPOTENCY_A_RECORD="$(
  management_evidence \
    "registry/idempotency/$PROJECT_A/onboarding-v1/$IDEMPOTENCY_A_FP.json"
)"
[ "$(json_field "$IDEMPOTENCY_A_RECORD" keyVersion)" = "v1" ] ||
  die "Project A idempotency capsule was not written under V1"

USAGE_BEFORE="$(key_usage)"
DEST_V1_BEFORE="$(
  json_field "$USAGE_BEFORE" usage.destination.versions.v1.activePointers
)"
DEST_V2_BEFORE="$(
  json_field "$USAGE_BEFORE" usage.destination.versions.v2.activePointers
)"
IDEM_V1_BEFORE="$(
  json_field "$USAGE_BEFORE" usage.idempotency.versions.v1.unexpiredCapsules
)"

say "Phase B: switching new writes to V2 while retaining V1 roots"
set_active_versions v2 v2
deploy_worker

say "Proving existing V1 onboarding replay still decrypts under V2-active runtime"
REPLAY_STATUS="$(
  public_onboarding \
    "$PROJECT_A" \
    "$OPERATOR_A" \
    "$IDEMPOTENCY_A" \
    "$TMP_PREFIX.replay-headers" \
    "$TMP_PREFIX.replay-body"
)"
[ "$REPLAY_STATUS" = "201" ] ||
  die "V1 idempotency replay failed: HTTP $REPLAY_STATUS"

grep -qi '^idempotency-replayed: true' "$TMP_PREFIX.replay-headers" ||
  die "V1 replay was not marked idempotency-replayed"

REPLAY_BODY="$(cat "$TMP_PREFIX.replay-body")"
REPLAY_PRODUCER_FP="$(
  json_hash_field "$REPLAY_BODY" credential
)"
[ "$REPLAY_PRODUCER_FP" = "$PRODUCER_A_FP" ] ||
  die "V1 replay did not recover the original producer credential"

STATUS_A_STILL_V1="$(credential_status "$PROJECT_A" "$OPERATOR_A")"
[ "$(json_field "$STATUS_A_STILL_V1" credential.keyVersion)" = "v1" ] ||
  die "Changing active write version unexpectedly rewrote project A destination"

say "Creating fresh V2 project B"
PROJECT_B_RESPONSE="$(create_project "$PROJECT_B")" ||
  die "Failed to create project B"
OPERATOR_B="$(json_field "$PROJECT_B_RESPONSE" operatorCredential)" ||
  die "Project B operator credential missing"

enable_posthog "$PROJECT_B" "$OPERATOR_B" >/dev/null ||
  die "Failed to enable project B PostHog"
bootstrap_posthog "$PROJECT_B" >/dev/null ||
  die "Failed to bootstrap project B PostHog credential"

STATUS_B_V2="$(credential_status "$PROJECT_B" "$OPERATOR_B")"
[ "$(json_field "$STATUS_B_V2" credential.keyVersion)" = "v2" ] ||
  die "Project B destination credential was not written under V2"

IDEMPOTENCY_B="$RUN_ID-idempotency-b"

ETLAYER_BASE_URL="$INGEST_URL" \
ETLAYER_PROJECT_ID="$PROJECT_B" \
ETLAYER_OPERATOR_CREDENTIAL="$OPERATOR_B" \
ETLAYER_IDEMPOTENCY_KEY="$IDEMPOTENCY_B" \
  node examples/external-consumer/run.mjs |
  tee "$TMP_PREFIX.consumer-b"

CONSUMER_B="$(cat "$TMP_PREFIX.consumer-b")"
IDEMPOTENCY_B_FP="$(
  json_field "$CONSUMER_B" idempotencyKeyFingerprint
)"

IDEMPOTENCY_B_RECORD="$(
  management_evidence \
    "registry/idempotency/$PROJECT_B/onboarding-v1/$IDEMPOTENCY_B_FP.json"
)"
[ "$(json_field "$IDEMPOTENCY_B_RECORD" keyVersion)" = "v2" ] ||
  die "Project B idempotency capsule was not written under V2"

say "Phase C: append-only rewrap project A destination V1 -> V2"
REWRAP_A="$(rewrap_posthog "$PROJECT_A")" ||
  die "Project A destination rewrap failed"

[ "$(json_field "$REWRAP_A" rewrapped)" = "true" ] ||
  die "Project A destination rewrap was not performed"
[ "$(json_field "$REWRAP_A" previous.keyVersion)" = "v1" ] ||
  die "Project A rewrap previous version was not V1"
[ "$(json_field "$REWRAP_A" credential.keyVersion)" = "v2" ] ||
  die "Project A rewrap did not advance to V2"

NEW_CREDENTIAL_ID="$(
  json_field "$REWRAP_A" credential.credentialId
)"
[ "$NEW_CREDENTIAL_ID" != "$OLD_CREDENTIAL_ID" ] ||
  die "Rewrap did not append a new credential version"

OLD_RECORD="$(
  management_evidence \
    "registry/destination-credentials/$PROJECT_A/posthog/versions/$OLD_CREDENTIAL_ID.json"
)"
NEW_RECORD="$(
  management_evidence \
    "registry/destination-credentials/$PROJECT_A/posthog/versions/$NEW_CREDENTIAL_ID.json"
)"

[ "$(json_field "$OLD_RECORD" keyVersion)" = "v1" ] ||
  die "Historical V1 credential record disappeared or changed"
[ "$(json_field "$NEW_RECORD" keyVersion)" = "v2" ] ||
  die "Rewrapped credential record is not V2"
[ "$(json_field "$NEW_RECORD" rotationKind)" = "master_key_rewrap" ] ||
  die "Rewrapped record lacks master_key_rewrap lineage"
[ "$(json_field "$NEW_RECORD" supersedesCredentialId)" = "$OLD_CREDENTIAL_ID" ] ||
  die "Rewrapped record does not identify superseded credential"

if printf '%s\n%s\n' "$OLD_RECORD" "$NEW_RECORD" |
   grep -q 'provider-secret'; then
  die "Plaintext provider secret leaked into encrypted evidence"
fi

say "Proving delivery still works after pointer switch"
execute_quickstart "$REPLAY_BODY" "$TMP_PREFIX.after-rewrap-event"
AFTER_REWRAP_EVENT="$(
  json_field "$(cat "$TMP_PREFIX.after-rewrap-event")" eventId
)"
AFTER_STATUS="$(
  wait_for_export \
    "$PROJECT_A" \
    "$AFTER_REWRAP_EVENT" \
    "$OPERATOR_A"
)"

say "Proving destination replay still works after rewrap"
FROM="$(
  node -e '
    console.log(
      new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    );
  '
)"
TO="$(
  node -e '
    console.log(
      new Date(Date.now() + 2 * 60 * 1000).toISOString(),
    );
  '
)"

REPLAY_RESULT="$(
  management_json \
    POST \
    "/_ops/replay/posthog" \
    "$OPERATOR_A" \
    "$(node -e '
      process.stdout.write(
        JSON.stringify({
          projectId: process.argv[1],
          from: process.argv[2],
          to: process.argv[3],
          replayId: process.argv[4],
          maxEvents: 20,
        }),
      );
    ' "$PROJECT_A" "$FROM" "$TO" "$RUN_ID-replay")"
)" || die "PostHog replay after rewrap failed"

node -e '
  const value = JSON.parse(process.argv[1]);
  const deliveries = value?.deliveries || [];
  const safe =
    value?.selected >= 1 &&
    deliveries.length === value.selected &&
    deliveries.every(
      (delivery) =>
        delivery?.status === "exported" ||
        (
          delivery?.status === "skipped" &&
          delivery?.reason === "already_exported"
        ),
    );

  if (!safe) {
    console.error(JSON.stringify(value, null, 2));
    process.exit(1);
  }
' "$REPLAY_RESULT" ||
  die "PostHog replay did not safely resolve project A events after rewrap"

say "Phase D: comparing authoritative key usage"
USAGE_AFTER="$(key_usage)"
DEST_V1_AFTER="$(
  json_field "$USAGE_AFTER" usage.destination.versions.v1.activePointers
)"
DEST_V2_AFTER="$(
  json_field "$USAGE_AFTER" usage.destination.versions.v2.activePointers
)"
IDEM_V1_AFTER="$(
  json_field "$USAGE_AFTER" usage.idempotency.versions.v1.unexpiredCapsules
)"
IDEM_V2_AFTER="$(
  json_field "$USAGE_AFTER" usage.idempotency.versions.v2.unexpiredCapsules
)"

node -e '
  const [
    destV1Before,
    destV1After,
    destV2Before,
    destV2After,
    idemV1Before,
    idemV1After,
    idemV2After,
  ] = process.argv.slice(1).map(Number);

  if (destV1After !== destV1Before - 1) {
    console.error("expected one active V1 destination pointer to migrate");
    process.exit(1);
  }

  if (destV2After < destV2Before + 2) {
    console.error("expected project B + rewrapped project A V2 pointers");
    process.exit(1);
  }

  if (idemV1After < idemV1Before) {
    console.error("unexpired V1 capsule unexpectedly disappeared");
    process.exit(1);
  }

  if (idemV2After < 1) {
    console.error("expected at least one unexpired V2 capsule");
    process.exit(1);
  }
' \
  "$DEST_V1_BEFORE" \
  "$DEST_V1_AFTER" \
  "$DEST_V2_BEFORE" \
  "$DEST_V2_AFTER" \
  "$IDEM_V1_BEFORE" \
  "$IDEM_V1_AFTER" \
  "$IDEM_V2_AFTER" ||
  die "Encryption key usage audit did not reflect the migration"

unset MANAGEMENT_KEY
unset OPERATOR_A
unset OPERATOR_B

say "VS13 versioned encryption root acceptance passed"
cat <<EOF
{
  "correlationId": "$RUN_ID",
  "projectA": "$PROJECT_A",
  "projectB": "$PROJECT_B",
  "v1Event": "$EVENT_A_V1",
  "afterRewrapEvent": "$AFTER_REWRAP_EVENT",
  "oldCredentialId": "$OLD_CREDENTIAL_ID",
  "newCredentialId": "$NEW_CREDENTIAL_ID",
  "historicalV1ReadableUnderV2Active": true,
  "newDestinationWritesV2": true,
  "newIdempotencyWritesV2": true,
  "sameProducerCredentialRecoveredFromV1Capsule": true,
  "destinationRewrap": "v1->v2",
  "appendOnlyHistory": true,
  "deliveryAfterRewrap": "exported",
  "replayAfterRewrapSelected": $(json_field "$REPLAY_RESULT" selected),
  "replayAfterRewrapExported": $(json_field "$REPLAY_RESULT" exported),
  "replayAfterRewrapSkipped": $(json_field "$REPLAY_RESULT" skipped),
  "destinationV1ActivePointersBefore": $DEST_V1_BEFORE,
  "destinationV1ActivePointersAfter": $DEST_V1_AFTER,
  "destinationV2ActivePointersBefore": $DEST_V2_BEFORE,
  "destinationV2ActivePointersAfter": $DEST_V2_AFTER,
  "idempotencyV1UnexpiredBefore": $IDEM_V1_BEFORE,
  "idempotencyV1UnexpiredAfter": $IDEM_V1_AFTER,
  "idempotencyV2UnexpiredAfter": $IDEM_V2_AFTER
}
EOF
