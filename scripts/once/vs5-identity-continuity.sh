#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INGEST_DIR="$ROOT_DIR/packages/cloudflare-ingest"
FIXTURE_URL="${ETLAYER_FIXTURE_URL:-https://etlayer-cloudflare-fixture.sergii-ponomarov.workers.dev}"
ARCHIVE_BUCKET="${ETLAYER_ARCHIVE_BUCKET:-etlayer-events-archive}"
PROJECT_ID="${ETLAYER_PROJECT_ID:-etlayer-default}"
PROJECT_PREFIX="projects/$PROJECT_ID"
RUN_ID="${RUN_ID:-vs5-identity-$(date -u +%Y%m%dT%H%M%SZ)-$(openssl rand -hex 4)}"
COOKIE_JAR="/tmp/etlayer-vs5-identity-$$.txt"

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

say "Creating isolated anonymous session with attribution"
printf 'correlation.id: %s\n' "$RUN_ID"

curl --fail --silent --show-error \
  -c "$COOKIE_JAR" \
  "$FIXTURE_URL/?run=$RUN_ID&utm_source=docs&utm_medium=acceptance&utm_campaign=vs5" \
  >/dev/null

say "Emitting anonymous hero event"
HERO_RESPONSE="$(
  curl --fail-with-body --silent --show-error \
    -b "$COOKIE_JAR" \
    -X POST "$FIXTURE_URL/api/browser-event" \
    -H "content-type: application/json" \
    --data '{"eventName":"landing.hero.exposed","attributes":{"page.path":"/identity-acceptance"}}'
)"
printf '%s\n' "$HERO_RESPONSE"

HERO_EVENT_ID="$(
  node -e '
    const value = JSON.parse(process.argv[1]);
    if (!value.eventId) process.exit(1);
    process.stdout.write(value.eventId);
  ' "$HERO_RESPONSE"
)" || die "Hero response did not contain eventId."

say "Linking anonymous identity to user/account and emitting identified account event"
FLOW_RESPONSE="$(
  curl --fail-with-body --silent --show-error \
    -b "$COOKIE_JAR" \
    -X POST "$FIXTURE_URL/api/acceptance/identity-flow" \
    -H "content-type: application/json" \
    --data "$(jq -nc --arg causationId "$HERO_EVENT_ID" '{causationId:$causationId}')"
)"
printf '%s\n' "$FLOW_RESPONSE"

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

ANONYMOUS_ID="$(read_json_field "$FLOW_RESPONSE" anonymousId)" ||
  die "Identity flow response missing anonymousId."
SESSION_ID="$(read_json_field "$FLOW_RESPONSE" sessionId)" ||
  die "Identity flow response missing sessionId."
USER_ID="$(read_json_field "$FLOW_RESPONSE" userId)" ||
  die "Identity flow response missing userId."
ACCOUNT_ID="$(read_json_field "$FLOW_RESPONSE" accountId)" ||
  die "Identity flow response missing accountId."
IDENTITY_EVENT_ID="$(read_json_field "$FLOW_RESPONSE" identityEventId)" ||
  die "Identity flow response missing identityEventId."
ACCOUNT_EVENT_ID="$(read_json_field "$FLOW_RESPONSE" accountEventId)" ||
  die "Identity flow response missing accountEventId."

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

say "Reading durable identity evidence"
HERO_IDENTITY="$(get_r2_json "$PROJECT_PREFIX/identity/$HERO_EVENT_ID.json")" ||
  die "Hero identity state did not appear."
LINK_IDENTITY="$(get_r2_json "$PROJECT_PREFIX/identity/$IDENTITY_EVENT_ID.json")" ||
  die "Identity-link state did not appear."
ACCOUNT_IDENTITY="$(get_r2_json "$PROJECT_PREFIX/identity/$ACCOUNT_EVENT_ID.json")" ||
  die "Account identity state did not appear."

if command -v jq >/dev/null 2>&1; then
  printf '%s\n' "$HERO_IDENTITY" | jq
  printf '%s\n' "$LINK_IDENTITY" | jq
  printf '%s\n' "$ACCOUNT_IDENTITY" | jq
fi

node -e '
  const [hero, link, account] = process.argv.slice(1, 4).map(JSON.parse);
  const [anonId, sessionId, userId, accountId] = process.argv.slice(4);

  const expectedAttribution = {
    source: "docs",
    medium: "acceptance",
    campaign: "vs5",
  };

  const sameAttribution = (value) =>
    JSON.stringify(value) === JSON.stringify(expectedAttribution);

  const heroOk =
    hero.status === "resolved" &&
    hero.subject?.kind === "anonymous" &&
    hero.subject?.id === anonId &&
    hero.anonymousId === anonId &&
    hero.userId === null &&
    hero.sessionId === sessionId &&
    hero.actor?.type === "anonymous" &&
    hero.actor?.id === anonId &&
    Array.isArray(hero.delegation) &&
    hero.delegation.length === 0 &&
    sameAttribution(hero.attribution);

  const linkOk =
    link.status === "resolved" &&
    link.subject?.kind === "user" &&
    link.subject?.id === userId &&
    link.anonymousId === anonId &&
    link.userId === userId &&
    link.accountId === accountId &&
    link.sessionId === sessionId &&
    link.actor?.type === "user" &&
    link.actor?.id === userId &&
    link.transition?.kind === "anonymous_to_user" &&
    link.transition?.from === anonId &&
    link.transition?.to === userId &&
    sameAttribution(link.attribution);

  const accountOk =
    account.status === "resolved" &&
    account.subject?.kind === "user" &&
    account.subject?.id === userId &&
    account.anonymousId === anonId &&
    account.userId === userId &&
    account.accountId === accountId &&
    account.sessionId === sessionId &&
    account.actor?.type === "user" &&
    account.actor?.id === userId &&
    account.transition === null &&
    sameAttribution(account.attribution);

  if (!heroOk || !linkOk || !accountOk) {
    console.error(JSON.stringify({ hero, link, account }, null, 2));
    process.exit(1);
  }
'   "$HERO_IDENTITY"   "$LINK_IDENTITY"   "$ACCOUNT_IDENTITY"   "$ANONYMOUS_ID"   "$SESSION_ID"   "$USER_ID"   "$ACCOUNT_ID" ||
  die "Identity continuity evidence did not match VS5 semantics."

say "Verifying contract validation"
for id in "$HERO_EVENT_ID" "$IDENTITY_EVENT_ID" "$ACCOUNT_EVENT_ID"; do
  VALIDATION="$(get_r2_json "$PROJECT_PREFIX/validation/$id.json")" ||
    die "Validation state missing for $id."

  node -e '
    const state = JSON.parse(process.argv[1]);
    if (state.status !== "valid" || (state.errors || []).length !== 0) {
      console.error(JSON.stringify(state, null, 2));
      process.exit(1);
    }
  ' "$VALIDATION" || die "Event $id was not contract-valid."
done

say "Verifying PostHog and Statsig deliveries"
for id in "$HERO_EVENT_ID" "$IDENTITY_EVENT_ID" "$ACCOUNT_EVENT_ID"; do
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

say "VS5 identity continuity acceptance passed"
cat <<EOF
{
  "correlationId": "$RUN_ID",
  "heroEventId": "$HERO_EVENT_ID",
  "identityEventId": "$IDENTITY_EVENT_ID",
  "accountEventId": "$ACCOUNT_EVENT_ID",
  "anonymousId": "$ANONYMOUS_ID",
  "sessionId": "$SESSION_ID",
  "userId": "$USER_ID",
  "accountId": "$ACCOUNT_ID",
  "attribution": {
    "source": "docs",
    "medium": "acceptance",
    "campaign": "vs5"
  },
  "posthogDelivery": "exported:3",
  "statsigDelivery": "exported:3",
  "identityContinuity": "anonymous_to_user"
}
EOF
