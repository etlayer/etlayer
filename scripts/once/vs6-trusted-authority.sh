#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INGEST_DIR="$ROOT_DIR/packages/cloudflare-ingest"
FIXTURE_URL="${ETLAYER_FIXTURE_URL:-https://etlayer-cloudflare-fixture.sergii-ponomarov.workers.dev}"
INGEST_URL="${ETLAYER_INGEST_URL:-https://etlayer-ingest.sergii-ponomarov.workers.dev}"
ARCHIVE_BUCKET="${ETLAYER_ARCHIVE_BUCKET:-etlayer-events-archive}"
PROJECT_ID="${ETLAYER_PROJECT_ID:-etlayer-default}"
PROJECT_PREFIX="projects/$PROJECT_ID"
RUN_ID="${RUN_ID:-vs6-authority-$(date -u +%Y%m%dT%H%M%SZ)-$(openssl rand -hex 4)}"
COOKIE_JAR="/tmp/etlayer-vs6-authority-$$.txt"

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
    const field = process.argv[2];
    if (typeof value[field] !== "string" || value[field].length === 0) {
      process.exit(1);
    }
    process.stdout.write(value[field]);
  ' "$1" "$2"
}

cd "$ROOT_DIR"

npx wrangler whoami >/dev/null 2>&1 ||
  die "Wrangler is not authenticated. Run: npx wrangler login"

say "Creating isolated VS6 session"
printf 'correlation.id: %s\n' "$RUN_ID"

curl --fail --silent --show-error \
  -c "$COOKIE_JAR" \
  "$FIXTURE_URL/?run=$RUN_ID&utm_source=docs&utm_medium=acceptance&utm_campaign=vs6-authority" \
  >/dev/null

say "Emitting browser-authoritative interaction"
HERO_RESPONSE="$(
  curl --fail-with-body --silent --show-error \
    -b "$COOKIE_JAR" \
    -X POST "$FIXTURE_URL/api/browser-event" \
    -H "content-type: application/json" \
    --data '{"eventName":"landing.hero.exposed","attributes":{"page.path":"/vs6-authority"}}'
)"
printf '%s\n' "$HERO_RESPONSE"

HERO_EVENT_ID="$(read_json_field "$HERO_RESPONSE" eventId)" ||
  die "Hero response missing eventId."

say "Emitting backend-authoritative identity/account facts"
IDENTITY_RESPONSE="$(
  curl --fail-with-body --silent --show-error \
    -b "$COOKIE_JAR" \
    -X POST "$FIXTURE_URL/api/acceptance/identity-flow" \
    -H "content-type: application/json" \
    --data "$(jq -nc --arg causationId "$HERO_EVENT_ID" '{causationId:$causationId}')"
)"
printf '%s\n' "$IDENTITY_RESPONSE"

USER_ID="$(read_json_field "$IDENTITY_RESPONSE" userId)" ||
  die "Identity response missing userId."
ACCOUNT_ID="$(read_json_field "$IDENTITY_RESPONSE" accountId)" ||
  die "Identity response missing accountId."
IDENTITY_EVENT_ID="$(read_json_field "$IDENTITY_RESPONSE" identityEventId)" ||
  die "Identity response missing identityEventId."
ACCOUNT_EVENT_ID="$(read_json_field "$IDENTITY_RESPONSE" accountEventId)" ||
  die "Identity response missing accountEventId."

say "Emitting agent-runtime-authoritative agent facts"
AGENT_RESPONSE="$(
  curl --fail-with-body --silent --show-error \
    -b "$COOKIE_JAR" \
    -X POST "$FIXTURE_URL/api/acceptance/agent-flow" \
    -H "content-type: application/json" \
    --data "$(jq -nc \
      --arg userId "$USER_ID" \
      --arg accountId "$ACCOUNT_ID" \
      --arg causationId "$ACCOUNT_EVENT_ID" \
      '{userId:$userId,accountId:$accountId,causationId:$causationId}')"
)"
printf '%s\n' "$AGENT_RESPONSE"

DIRECT_EVENT_ID="$(read_json_field "$AGENT_RESPONSE" directEventId)" ||
  die "Agent response missing directEventId."
CHILD_EVENT_ID="$(read_json_field "$AGENT_RESPONSE" childEventId)" ||
  die "Agent response missing childEventId."

say "Sending browser credential with forged backend/business-state claims"
BROWSER_SPOOF="$(
  curl --fail-with-body --silent --show-error \
    -b "$COOKIE_JAR" \
    -X POST "$FIXTURE_URL/api/acceptance/authority-spoof" \
    -H "content-type: application/json" \
    --data "$(jq -nc --arg profile browser --arg causationId "$ACCOUNT_EVENT_ID" '{profile:$profile,causationId:$causationId}')"
)"
printf '%s\n' "$BROWSER_SPOOF"
BROWSER_SPOOF_ID="$(read_json_field "$BROWSER_SPOOF" eventId)" ||
  die "Browser spoof response missing eventId."

say "Sending agent-runtime credential with forged backend/business-state claims"
AGENT_SPOOF="$(
  curl --fail-with-body --silent --show-error \
    -b "$COOKIE_JAR" \
    -X POST "$FIXTURE_URL/api/acceptance/authority-spoof" \
    -H "content-type: application/json" \
    --data "$(jq -nc --arg profile agent-runtime --arg causationId "$DIRECT_EVENT_ID" '{profile:$profile,causationId:$causationId}')"
)"
printf '%s\n' "$AGENT_SPOOF"
AGENT_SPOOF_ID="$(read_json_field "$AGENT_SPOOF" eventId)" ||
  die "Agent spoof response missing eventId."

cd "$INGEST_DIR"

get_r2_json() {
  local key="$1"
  local value=""

  for attempt in $(seq 1 25); do
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
  local key="$PROJECT_PREFIX/deliveries/$destination/$event_id.json"

  if npx wrangler r2 object get \
    "$ARCHIVE_BUCKET/$key" \
    --remote --pipe >/dev/null 2>&1; then
    die "Unexpected $destination delivery state exists for blocked event $event_id"
  fi
}

assert_allowed() {
  local event_id="$1"
  local expected_profile="$2"
  local expected_producer="$3"
  local expected_authority="$4"

  local state
  state="$(get_r2_json "$PROJECT_PREFIX/authority/$event_id.json")" ||
    die "Authority state missing for $event_id"

  node -e '
    const state = JSON.parse(process.argv[1]);
    const [profile, producer, authority] = process.argv.slice(2);

    const ok =
      state.status === "allowed" &&
      state.profileId === profile &&
      state.trustedProducerKind === producer &&
      state.claim?.producerKind === producer &&
      state.claim?.authorityKind === authority &&
      (state.errors || []).length === 0;

    if (!ok) {
      console.error(JSON.stringify(state, null, 2));
      process.exit(1);
    }
  ' "$state" "$expected_profile" "$expected_producer" "$expected_authority" ||
    die "Allowed authority evidence was incorrect for $event_id"
}

assert_blocked_spoof() {
  local event_id="$1"
  local expected_profile="$2"
  local trusted_producer="$3"

  local validation authority identity source_key canonical

  validation="$(get_r2_json "$PROJECT_PREFIX/validation/$event_id.json")" ||
    die "Validation state missing for spoof $event_id"
  authority="$(get_r2_json "$PROJECT_PREFIX/authority/$event_id.json")" ||
    die "Authority state missing for spoof $event_id"
  identity="$(get_r2_json "$PROJECT_PREFIX/identity/$event_id.json")" ||
    die "Identity state missing for spoof $event_id"

  node -e '
    const validation = JSON.parse(process.argv[1]);
    if (
      validation.status !== "valid" ||
      validation.contractId !== "account.created@1" ||
      (validation.errors || []).length !== 0
    ) {
      console.error(JSON.stringify(validation, null, 2));
      process.exit(1);
    }
  ' "$validation" ||
    die "Spoof event was not structurally contract-valid."

  node -e '
    const state = JSON.parse(process.argv[1]);
    const profile = process.argv[2];
    const trusted = process.argv[3];

    const codes = (state.errors || []).map(({ code }) => code);

    const ok =
      state.status === "blocked" &&
      state.profileId === profile &&
      state.trustedProducerKind === trusted &&
      state.claim?.producerKind === "backend" &&
      state.claim?.authorityKind === "business_state" &&
      codes.includes("producer_kind_mismatch") &&
      codes.includes("authority_not_allowed");

    if (!ok) {
      console.error(JSON.stringify(state, null, 2));
      process.exit(1);
    }
  ' "$authority" "$expected_profile" "$trusted_producer" ||
    die "Spoof authority evidence did not contain the expected block reasons."

  source_key="$(
    node -e '
      const state = JSON.parse(process.argv[1]);
      if (!state.sourceKey) process.exit(1);
      process.stdout.write(state.sourceKey);
    ' "$authority"
  )" || die "Spoof authority evidence missing sourceKey."

  canonical="$(get_r2_json "$source_key")" ||
    die "Canonical spoof event is missing."

  node -e '
    const event = JSON.parse(process.argv[1]);
    const profile = process.argv[2];
    const trusted = process.argv[3];

    const attrs = Object.fromEntries(
      (event.logRecord?.attributes || []).map(({ key, value }) => [
        key,
        value?.stringValue ?? value?.intValue ?? null,
      ]),
    );

    const serialized = JSON.stringify(event);

    const ok =
      event.provenance?.version === 2 &&
      event.provenance?.projectId === process.argv[4] &&
      event.provenance?.profileId === profile &&
      event.provenance?.producer?.kind === trusted &&
      attrs["etlayer.producer.kind"] === "backend" &&
      attrs["etlayer.authority.kind"] === "business_state" &&
      !serialized.includes("Bearer ") &&
      !Object.keys(event.provenance).some((key) =>
        /secret|token|credential/i.test(key)
      );

    if (!ok) {
      console.error(JSON.stringify(event, null, 2));
      process.exit(1);
    }
  ' "$canonical" "$expected_profile" "$trusted_producer" "$PROJECT_ID" ||
    die "Canonical trusted provenance invariant failed."

  sleep 2
  assert_delivery_absent posthog "$event_id"
  assert_delivery_absent statsig "$event_id"

  printf '%s' "$source_key"
}

say "Verifying allowed authority decisions"
assert_allowed "$HERO_EVENT_ID" browser browser interaction
assert_allowed "$IDENTITY_EVENT_ID" backend backend business_state
assert_allowed "$ACCOUNT_EVENT_ID" backend backend business_state
assert_allowed "$DIRECT_EVENT_ID" agent-runtime agent_runtime agent_runtime
assert_allowed "$CHILD_EVENT_ID" agent-runtime agent_runtime agent_runtime

say "Verifying browser spoof is preserved but authority-blocked"
BROWSER_SOURCE_KEY="$(assert_blocked_spoof "$BROWSER_SPOOF_ID" browser browser)"
printf 'browser spoof sourceKey: %s\n' "$BROWSER_SOURCE_KEY"

say "Verifying agent-runtime spoof is preserved but authority-blocked"
AGENT_SOURCE_KEY="$(assert_blocked_spoof "$AGENT_SPOOF_ID" agent-runtime agent_runtime)"
printf 'agent spoof sourceKey: %s\n' "$AGENT_SOURCE_KEY"

say "Rotating operator credential for canonical revalidation"
OPERATOR_KEY="$(openssl rand -hex 32)"
printf '%s' "$OPERATOR_KEY" |
  npx wrangler secret put ETLAYER_REPLAY_KEY >/dev/null

say "Deploying current ingest Worker before revalidation"
npx wrangler deploy >/tmp/etlayer-vs6-revalidate-deploy.txt
cat /tmp/etlayer-vs6-revalidate-deploy.txt

say "Revalidating preserved browser spoof without producer re-emission"
REVALIDATION="$(
  curl --fail-with-body --silent --show-error \
    -X POST "$INGEST_URL/_ops/revalidate" \
    -H "authorization: Bearer $OPERATOR_KEY" \
    -H "content-type: application/json" \
    --data "$(jq -nc --arg projectId "$PROJECT_ID" --arg sourceKey "$BROWSER_SOURCE_KEY" '{projectId:$projectId,sourceKey:$sourceKey}')"
)"
printf '%s\n' "$REVALIDATION"

node -e '
  const value = JSON.parse(process.argv[1]);

  const ok =
    value.validation?.status === "valid" &&
    value.authority?.status === "blocked" &&
    Array.isArray(value.deliveries) &&
    value.deliveries.length === 0;

  if (!ok) {
    console.error(JSON.stringify(value, null, 2));
    process.exit(1);
  }
' "$REVALIDATION" ||
  die "Canonical revalidation did not preserve the authority block."

unset OPERATOR_KEY

say "VS6 trusted provenance and authority acceptance passed"
cat <<EOF
{
  "correlationId": "$RUN_ID",
  "allowed": {
    "browserEventId": "$HERO_EVENT_ID",
    "backendIdentityEventId": "$IDENTITY_EVENT_ID",
    "backendAccountEventId": "$ACCOUNT_EVENT_ID",
    "agentEventId": "$DIRECT_EVENT_ID",
    "subagentEventId": "$CHILD_EVENT_ID"
  },
  "blockedSpoofs": {
    "browserEventId": "$BROWSER_SPOOF_ID",
    "agentRuntimeEventId": "$AGENT_SPOOF_ID"
  },
  "browserTrustedProfile": "browser",
  "backendTrustedProfile": "backend",
  "agentTrustedProfile": "agent-runtime",
  "browserSpoof": "contract-valid / authority-blocked / no delivery",
  "agentSpoof": "contract-valid / authority-blocked / no delivery",
  "revalidation": "still blocked",
  "trustedProvenance": "preserved without credential material"
}
EOF
