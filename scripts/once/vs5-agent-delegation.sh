#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INGEST_DIR="$ROOT_DIR/packages/cloudflare-ingest"
FIXTURE_URL="${ETLAYER_FIXTURE_URL:-https://etlayer-cloudflare-fixture.sergii-ponomarov.workers.dev}"
ARCHIVE_BUCKET="${ETLAYER_ARCHIVE_BUCKET:-etlayer-events-archive}"
PROJECT_ID="${ETLAYER_PROJECT_ID:-etlayer-default}"
PROJECT_PREFIX="projects/$PROJECT_ID"
RUN_ID="${RUN_ID:-vs5-agent-$(date -u +%Y%m%dT%H%M%SZ)-$(openssl rand -hex 4)}"
COOKIE_JAR="/tmp/etlayer-vs5-agent-$$.txt"

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

say "Creating isolated session with attribution"
printf 'correlation.id: %s\n' "$RUN_ID"

curl --fail --silent --show-error \
  -c "$COOKIE_JAR" \
  "$FIXTURE_URL/?run=$RUN_ID&utm_source=docs&utm_medium=acceptance&utm_campaign=vs5-agent" \
  >/dev/null

say "Emitting anonymous hero event"
HERO_RESPONSE="$(
  curl --fail-with-body --silent --show-error \
    -b "$COOKIE_JAR" \
    -X POST "$FIXTURE_URL/api/browser-event" \
    -H "content-type: application/json" \
    --data '{"eventName":"landing.hero.exposed","attributes":{"page.path":"/agent-acceptance"}}'
)"
printf '%s\n' "$HERO_RESPONSE"

HERO_EVENT_ID="$(read_json_field "$HERO_RESPONSE" eventId)" ||
  die "Hero response did not contain eventId."

say "Establishing anonymous -> user identity continuity"
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
SESSION_ID="$(read_json_field "$IDENTITY_RESPONSE" sessionId)" ||
  die "Identity response missing sessionId."
ACCOUNT_EVENT_ID="$(read_json_field "$IDENTITY_RESPONSE" accountEventId)" ||
  die "Identity response missing accountEventId."

say "Emitting direct-agent and subagent actions"
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
DIRECT_AGENT_ID="$(read_json_field "$AGENT_RESPONSE" directAgentId)" ||
  die "Agent response missing directAgentId."
CHILD_AGENT_ID="$(read_json_field "$AGENT_RESPONSE" childAgentId)" ||
  die "Agent response missing childAgentId."
DIRECT_TURN_ID="$(read_json_field "$AGENT_RESPONSE" directTurnId)" ||
  die "Agent response missing directTurnId."
CHILD_TURN_ID="$(read_json_field "$AGENT_RESPONSE" childTurnId)" ||
  die "Agent response missing childTurnId."
DIRECT_TOOL_CALL_ID="$(read_json_field "$AGENT_RESPONSE" directToolCallId)" ||
  die "Agent response missing directToolCallId."
CHILD_TOOL_CALL_ID="$(read_json_field "$AGENT_RESPONSE" childToolCallId)" ||
  die "Agent response missing childToolCallId."

cd "$INGEST_DIR"

get_r2_json() {
  local key="$1"
  local value=""

  for attempt in $(seq 1 20); do
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

say "Reading durable agent identity evidence"
DIRECT_IDENTITY="$(get_r2_json "$PROJECT_PREFIX/identity/$DIRECT_EVENT_ID.json")" ||
  die "Direct-agent identity state did not appear."
CHILD_IDENTITY="$(get_r2_json "$PROJECT_PREFIX/identity/$CHILD_EVENT_ID.json")" ||
  die "Subagent identity state did not appear."

if command -v jq >/dev/null 2>&1; then
  printf '%s\n' "$DIRECT_IDENTITY" | jq
  printf '%s\n' "$CHILD_IDENTITY" | jq
fi

node -e '
  const direct = JSON.parse(process.argv[1]);
  const child = JSON.parse(process.argv[2]);
  const [
    userId,
    accountId,
    sessionId,
    directAgentId,
    childAgentId,
    directTurnId,
    childTurnId,
    directToolCallId,
    childToolCallId,
  ] = process.argv.slice(3);

  const expectedAttribution = {
    source: "docs",
    medium: "acceptance",
    campaign: "vs5-agent",
  };

  const sameAttribution = (value) =>
    JSON.stringify(value) === JSON.stringify(expectedAttribution);

  const directOk =
    direct.version === 2 &&
    direct.status === "resolved" &&
    direct.subject?.kind === "user" &&
    direct.subject?.id === userId &&
    direct.actor?.type === "agent" &&
    direct.actor?.id === directAgentId &&
    direct.actor?.source === "explicit" &&
    direct.userId === userId &&
    direct.accountId === accountId &&
    direct.sessionId === sessionId &&
    direct.agent?.turnId === directTurnId &&
    direct.agent?.toolCallId === directToolCallId &&
    direct.delegation?.length === 1 &&
    direct.delegation[0]?.relationship === "on_behalf_of" &&
    direct.delegation[0]?.principal?.type === "user" &&
    direct.delegation[0]?.principal?.id === userId &&
    sameAttribution(direct.attribution);

  const childOk =
    child.version === 2 &&
    child.status === "resolved" &&
    child.subject?.kind === "user" &&
    child.subject?.id === userId &&
    child.actor?.type === "agent" &&
    child.actor?.id === childAgentId &&
    child.actor?.source === "explicit" &&
    child.userId === userId &&
    child.accountId === accountId &&
    child.sessionId === sessionId &&
    child.agent?.turnId === childTurnId &&
    child.agent?.toolCallId === childToolCallId &&
    child.delegation?.length === 2 &&
    child.delegation[0]?.relationship === "delegated_by" &&
    child.delegation[0]?.principal?.type === "agent" &&
    child.delegation[0]?.principal?.id === directAgentId &&
    child.delegation[1]?.relationship === "on_behalf_of" &&
    child.delegation[1]?.principal?.type === "user" &&
    child.delegation[1]?.principal?.id === userId &&
    sameAttribution(child.attribution);

  if (!directOk || !childOk) {
    console.error(JSON.stringify({ direct, child }, null, 2));
    process.exit(1);
  }
'   "$DIRECT_IDENTITY"   "$CHILD_IDENTITY"   "$USER_ID"   "$ACCOUNT_ID"   "$SESSION_ID"   "$DIRECT_AGENT_ID"   "$CHILD_AGENT_ID"   "$DIRECT_TURN_ID"   "$CHILD_TURN_ID"   "$DIRECT_TOOL_CALL_ID"   "$CHILD_TOOL_CALL_ID" ||
  die "Agent actor/delegation identity evidence did not match VS5 semantics."

say "Verifying agent contracts"
for id in "$DIRECT_EVENT_ID" "$CHILD_EVENT_ID"; do
  VALIDATION="$(get_r2_json "$PROJECT_PREFIX/validation/$id.json")" ||
    die "Validation state missing for $id."

  node -e '
    const state = JSON.parse(process.argv[1]);
    if (state.status !== "valid" || (state.errors || []).length !== 0) {
      console.error(JSON.stringify(state, null, 2));
      process.exit(1);
    }
  ' "$VALIDATION" || die "Agent event $id was not contract-valid."
done

say "Verifying agent destination deliveries"
for id in "$DIRECT_EVENT_ID" "$CHILD_EVENT_ID"; do
  for destination in posthog statsig; do
    DELIVERY="$(get_r2_json "$PROJECT_PREFIX/deliveries/$destination/$id.json")" ||
      die "$destination delivery missing for $id."

    node -e '
      const state = JSON.parse(process.argv[1]);
      const destination = process.argv[2];
      if (
        state.destination !== destination ||
        state.status !== "exported"
      ) {
        console.error(JSON.stringify(state, null, 2));
        process.exit(1);
      }
    ' "$DELIVERY" "$destination" ||
      die "$destination delivery failed for $id."
  done
done

say "VS5 agent/delegation acceptance passed"
cat <<EOF
{
  "correlationId": "$RUN_ID",
  "userId": "$USER_ID",
  "accountId": "$ACCOUNT_ID",
  "sessionId": "$SESSION_ID",
  "directAgentId": "$DIRECT_AGENT_ID",
  "childAgentId": "$CHILD_AGENT_ID",
  "directEventId": "$DIRECT_EVENT_ID",
  "childEventId": "$CHILD_EVENT_ID",
  "directDelegation": "agent -> user",
  "childDelegation": "child_agent -> parent_agent -> user",
  "posthogDelivery": "exported:2",
  "statsigDelivery": "exported:2",
  "subject": "$USER_ID"
}
EOF
