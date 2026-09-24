#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INGEST_DIR="$ROOT_DIR/packages/cloudflare-ingest"
FIXTURE_DIR="$ROOT_DIR/examples/cloudflare-fixture"
WRANGLER_ENV="${ETLAYER_WRANGLER_ENV:-}"
WRANGLER_ENV_ARGS=()

if [ -n "$WRANGLER_ENV" ]; then
  WRANGLER_ENV_ARGS=(--env "$WRANGLER_ENV")
  DEFAULT_INGEST_URL="https://etlayer-ingest-$WRANGLER_ENV.sergii-ponomarov.workers.dev"
  DEFAULT_ARCHIVE_BUCKET="etlayer-events-archive-$WRANGLER_ENV"
else
  DEFAULT_INGEST_URL="https://etlayer-ingest.sergii-ponomarov.workers.dev"
  DEFAULT_ARCHIVE_BUCKET="etlayer-events-archive"
fi

INGEST_URL="${ETLAYER_INGEST_URL:-$DEFAULT_INGEST_URL}"
ARCHIVE_BUCKET="${ETLAYER_ARCHIVE_BUCKET:-$DEFAULT_ARCHIVE_BUCKET}"
DEFAULT_PROJECT_ID="etlayer-default"
SECONDARY_PROJECT_ID="etlayer-secondary"
RUN_ID="${RUN_ID:-vs8-project-isolation-$(date -u +%Y%m%dT%H%M%SZ)-$(openssl rand -hex 4)}"
TMP_PREFIX="/tmp/etlayer-vs8-$$"

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

read_json_field() {
  node -e '
    const value = JSON.parse(process.argv[1]);
    const path = process.argv[2].split(".");
    let current = value;
    for (const key of path) current = current?.[key];
    if (typeof current !== "string" || current.length === 0) {
      process.exit(1);
    }
    process.stdout.write(current);
  ' "$1" "$2"
}

put_secret() {
  local directory="$1"
  local name="$2"
  local value="$3"

  (
    cd "$directory"
    printf '%s' "$value" |
      npx wrangler secret put "$name" "${WRANGLER_ENV_ARGS[@]}" >/dev/null
  )
}

wait_for_ingest_credential() {
  local token="$1"
  local label="$2"
  local output="$TMP_PREFIX.credential-readiness"

  for attempt in $(seq 1 30); do
    local status
    status="$(
      curl --silent --show-error         -o "$output"         -w '%{http_code}'         -X POST "$INGEST_URL/v1/logs"         -H "authorization: Bearer $token"         -H "content-type: text/plain"         --data '{}' || true
    )"

    # Authentication runs before media-type validation.
    # 415 therefore proves this exact rotated credential reached the Worker.
    if [ "$status" = "415" ]; then
      printf 'credential active: %s\n' "$label"
      return 0
    fi

    sleep 1
  done

  printf 'last readiness response for %s:\n' "$label" >&2
  cat "$output" >&2 || true
  printf '\n' >&2
  die "Rotated ingest credential did not converge: $label"
}

project_operator_for_key() {
  local key="$1"

  case "$key" in
    "projects/$DEFAULT_PROJECT_ID/"*)
      EVIDENCE_PROJECT_ID="$DEFAULT_PROJECT_ID"
      EVIDENCE_OPERATOR_KEY="$DEFAULT_OPERATOR_KEY"
      ;;
    "projects/$SECONDARY_PROJECT_ID/"*)
      EVIDENCE_PROJECT_ID="$SECONDARY_PROJECT_ID"
      EVIDENCE_OPERATOR_KEY="$SECONDARY_OPERATOR_KEY"
      ;;
    *)
      die "Evidence key is outside configured project namespaces: $key"
      ;;
  esac
}

evidence_request_status() {
  local key="$1"
  local output="$2"

  project_operator_for_key "$key"

  local body
  body="$(
    node -e '
      const [projectId, key] = process.argv.slice(1);
      process.stdout.write(JSON.stringify({ projectId, key }));
    ' "$EVIDENCE_PROJECT_ID" "$key"
  )"

  curl --silent --show-error \
    -o "$output" \
    -w '%{http_code}' \
    -X POST "$INGEST_URL/_ops/evidence" \
    -H "authorization: Bearer $EVIDENCE_OPERATOR_KEY" \
    -H "content-type: application/json" \
    --data "$body"
}

get_r2_json() {
  local key="$1"
  local status=""
  local body_file="$TMP_PREFIX.evidence-body"

  for attempt in $(seq 1 35); do
    status="$(
      evidence_request_status "$key" "$body_file" || true
    )"

    if [ "$status" = "200" ]; then
      cat "$body_file"
      return 0
    fi

    if [ "$status" != "404" ]; then
      printf 'Evidence read failed for %s with HTTP %s\n' \
        "$key" "${status:-unknown}" >&2
      if [ -s "$body_file" ]; then
        head -c 1000 "$body_file" >&2
        printf '\n' >&2
      fi
      return 1
    fi

    sleep 1
  done

  printf 'Evidence not found after retries: %s\n' "$key" >&2
  return 1
}

assert_r2_absent() {
  local key="$1"
  local status
  local body_file="$TMP_PREFIX.absent-body"

  status="$(
    evidence_request_status "$key" "$body_file" || true
  )"

  case "$status" in
    404) return 0 ;;
    200) die "Unexpected R2 object exists: $key" ;;
    *)
      die "Unable to verify R2 absence for $key: HTTP $status"
      ;;
  esac
}

assert_delivery_status() {
  local project_id="$1"
  local destination="$2"
  local event_id="$3"
  local expected_status="$4"
  local key="projects/$project_id/deliveries/$destination/$event_id.json"
  local value

  value="$(get_r2_json "$key")" ||
    die "Delivery state missing: $key"

  node -e '
    const state = JSON.parse(process.argv[1]);
    const [projectId, destination, expected] = process.argv.slice(2);
    if (
      state.projectId !== projectId ||
      state.destination !== destination ||
      state.status !== expected
    ) {
      console.error(JSON.stringify(state, null, 2));
      process.exit(1);
    }
  ' "$value" "$project_id" "$destination" "$expected_status" ||
    die "Unexpected delivery state: $key"
}

send_account_event() {
  local token="$1"
  local event_id="$2"
  local correlation_id="$3"
  local account_id="$4"
  local claimed_project="$5"
  local actor_id="$6"

  local body
  body="$(
    node -e '
      const [
        eventId,
        correlationId,
        accountId,
        claimedProject,
        actorId,
      ] = process.argv.slice(1);
      const now = (BigInt(Date.now()) * 1000000n).toString();

      process.stdout.write(JSON.stringify({
        resourceLogs: [{
          resource: {
            attributes: [
              {
                key: "service.name",
                value: { stringValue: "etlayer-vs8-acceptance" },
              },
              {
                key: "deployment.environment.name",
                value: { stringValue: "acceptance" },
              },
            ],
          },
          scopeLogs: [{
            scope: {
              name: "etlayer.vs8.acceptance",
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
                  value: { stringValue: actorId },
                },
                {
                  key: "account.id",
                  value: { stringValue: accountId },
                },
                {
                  key: "correlation.id",
                  value: { stringValue: correlationId },
                },
                {
                  key: "causation.id",
                  value: { stringValue: "vs8_root" },
                },
                {
                  key: "etlayer.producer.kind",
                  value: { stringValue: "backend" },
                },
                {
                  key: "etlayer.authority.kind",
                  value: { stringValue: "business_state" },
                },
                {
                  key: "etlayer.project.id",
                  value: { stringValue: claimedProject },
                },
              ],
            }],
          }],
        }],
      }));
    '       "$event_id"       "$correlation_id"       "$account_id"       "$claimed_project"       "$actor_id"
  )"

  curl --fail-with-body --silent --show-error     -X POST "$INGEST_URL/v1/logs"     -H "authorization: Bearer $token"     -H "content-type: application/json"     --data "$body" >/dev/null
}

operator_request_status() {
  local endpoint="$1"
  local token="$2"
  local body="$3"
  local output="$4"

  curl --silent --show-error     -o "$output"     -w '%{http_code}'     -X POST "$INGEST_URL$endpoint"     -H "authorization: Bearer $token"     -H "content-type: application/json"     --data "$body"
}

cd "$ROOT_DIR"

if [ -n "${CLOUDFLARE_API_TOKEN:-}" ] &&
   [ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
  say "Using non-interactive Cloudflare API token"
else
  npx wrangler whoami >/dev/null 2>&1 ||
    die "Wrangler is not authenticated. Run: npx wrangler login"
fi

DEFAULT_BROWSER_KEY="$(generate_key)"
DEFAULT_BACKEND_KEY="$(generate_key)"
SECONDARY_BACKEND_KEY="$(generate_key)"
DEFAULT_OPERATOR_KEY="$(generate_key)"
SECONDARY_OPERATOR_KEY="$(generate_key)"

say "Rotating project-scoped ingest and operator credentials"
if [ -n "$WRANGLER_ENV" ]; then
  printf 'Wrangler environment: %s\n' "$WRANGLER_ENV"
fi
printf 'Ingest URL: %s\n' "$INGEST_URL"
printf 'Archive bucket: %s\n' "$ARCHIVE_BUCKET"
put_secret "$INGEST_DIR" ETLAYER_BROWSER_INGEST_KEY "$DEFAULT_BROWSER_KEY"
put_secret "$INGEST_DIR" ETLAYER_BACKEND_INGEST_KEY "$DEFAULT_BACKEND_KEY"
put_secret "$INGEST_DIR" ETLAYER_SECONDARY_BACKEND_INGEST_KEY "$SECONDARY_BACKEND_KEY"
put_secret "$INGEST_DIR" ETLAYER_REPLAY_KEY "$DEFAULT_OPERATOR_KEY"
put_secret "$INGEST_DIR" ETLAYER_SECONDARY_REPLAY_KEY "$SECONDARY_OPERATOR_KEY"

say "Deploying project-aware ETLayer Worker"
(
  cd "$INGEST_DIR"
  npx wrangler deploy "${WRANGLER_ENV_ARGS[@]}"
)

say "Waiting for rotated ingest credentials to converge"
wait_for_ingest_credential "$DEFAULT_BROWSER_KEY" "default browser"
wait_for_ingest_credential "$DEFAULT_BACKEND_KEY" "default backend"
wait_for_ingest_credential "$SECONDARY_BACKEND_KEY" "secondary backend"

say "Keeping the default fixture synchronized with rotated default credentials"
put_secret "$FIXTURE_DIR" ETLAYER_BROWSER_INGEST_KEY "$DEFAULT_BROWSER_KEY"
put_secret "$FIXTURE_DIR" ETLAYER_BACKEND_INGEST_KEY "$DEFAULT_BACKEND_KEY"
(
  cd "$FIXTURE_DIR"
  npx wrangler deploy "${WRANGLER_ENV_ARGS[@]}" >/dev/null
)

SHARED_EVENT_ID="$(uuid)"
DEFAULT_ALLOWED_EVENT_ID="$(uuid)"
DEFAULT_BLOCKED_CORRELATION="$RUN_ID-default-blocked"
SECONDARY_CORRELATION="$RUN_ID-secondary"
DEFAULT_ALLOWED_CORRELATION="$RUN_ID-default-allowed"

say "Sending the same logical event id through two project credentials"
printf 'shared event.id: %s\n' "$SHARED_EVENT_ID"

# The default browser credential deliberately claims backend/business authority
# and the secondary project. The contract remains valid, but authority must block.
send_account_event   "$DEFAULT_BROWSER_KEY"   "$SHARED_EVENT_ID"   "$DEFAULT_BLOCKED_CORRELATION"   "account_default_blocked"   "$SECONDARY_PROJECT_ID"   "anon_default_blocked"

# The secondary backend uses the same event id and deliberately claims the
# default project. Trusted provenance must still place it in secondary storage.
send_account_event   "$SECONDARY_BACKEND_KEY"   "$SHARED_EVENT_ID"   "$SECONDARY_CORRELATION"   "account_secondary"   "$DEFAULT_PROJECT_ID"   "anon_secondary"

say "Sending an allowed default-project backend event"
send_account_event   "$DEFAULT_BACKEND_KEY"   "$DEFAULT_ALLOWED_EVENT_ID"   "$DEFAULT_ALLOWED_CORRELATION"   "account_default_allowed"   "$SECONDARY_PROJECT_ID"   "anon_default_allowed"

DEFAULT_AUTHORITY_KEY="projects/$DEFAULT_PROJECT_ID/authority/$SHARED_EVENT_ID.json"
SECONDARY_AUTHORITY_KEY="projects/$SECONDARY_PROJECT_ID/authority/$SHARED_EVENT_ID.json"
DEFAULT_ALLOWED_AUTHORITY_KEY="projects/$DEFAULT_PROJECT_ID/authority/$DEFAULT_ALLOWED_EVENT_ID.json"

say "Waiting for project-scoped authority evidence"
DEFAULT_AUTHORITY="$(get_r2_json "$DEFAULT_AUTHORITY_KEY")" ||
  die "Default blocked authority state missing."
SECONDARY_AUTHORITY="$(get_r2_json "$SECONDARY_AUTHORITY_KEY")" ||
  die "Secondary authority state missing."
DEFAULT_ALLOWED_AUTHORITY="$(get_r2_json "$DEFAULT_ALLOWED_AUTHORITY_KEY")" ||
  die "Default allowed authority state missing."

node -e '
  const [blockedRaw, secondaryRaw, allowedRaw] = process.argv.slice(1);
  const blocked = JSON.parse(blockedRaw);
  const secondary = JSON.parse(secondaryRaw);
  const allowed = JSON.parse(allowedRaw);

  const blockedCodes = (blocked.errors || []).map(({ code }) => code);

  const ok =
    blocked.projectId === "etlayer-default" &&
    blocked.status === "blocked" &&
    blocked.profileId === "browser" &&
    blocked.trustedProducerKind === "browser" &&
    blockedCodes.includes("producer_kind_mismatch") &&
    blockedCodes.includes("authority_not_allowed") &&
    secondary.projectId === "etlayer-secondary" &&
    secondary.status === "allowed" &&
    secondary.profileId === "backend" &&
    secondary.trustedProducerKind === "backend" &&
    allowed.projectId === "etlayer-default" &&
    allowed.status === "allowed" &&
    allowed.profileId === "backend";

  if (!ok) {
    console.error(JSON.stringify({ blocked, secondary, allowed }, null, 2));
    process.exit(1);
  }
'   "$DEFAULT_AUTHORITY"   "$SECONDARY_AUTHORITY"   "$DEFAULT_ALLOWED_AUTHORITY" ||
  die "Project-scoped authority evidence is incorrect."

DEFAULT_SOURCE_KEY="$(read_json_field "$DEFAULT_AUTHORITY" sourceKey)"
SECONDARY_SOURCE_KEY="$(read_json_field "$SECONDARY_AUTHORITY" sourceKey)"
DEFAULT_ALLOWED_SOURCE_KEY="$(read_json_field "$DEFAULT_ALLOWED_AUTHORITY" sourceKey)"

say "Verifying canonical storage is physically project-scoped"
DEFAULT_CANONICAL="$(get_r2_json "$DEFAULT_SOURCE_KEY")" ||
  die "Default canonical event missing."
SECONDARY_CANONICAL="$(get_r2_json "$SECONDARY_SOURCE_KEY")" ||
  die "Secondary canonical event missing."
DEFAULT_ALLOWED_CANONICAL="$(get_r2_json "$DEFAULT_ALLOWED_SOURCE_KEY")" ||
  die "Default allowed canonical event missing."

node -e '
  const [defaultRaw, secondaryRaw, allowedRaw, sharedId, allowedId] =
    process.argv.slice(1);
  const values = [
    JSON.parse(defaultRaw),
    JSON.parse(secondaryRaw),
    JSON.parse(allowedRaw),
  ];

  function attrs(event) {
    return Object.fromEntries(
      (event.logRecord?.attributes || []).map(({ key, value }) => [
        key,
        value?.stringValue ?? value?.intValue ?? null,
      ]),
    );
  }

  const [defaultEvent, secondaryEvent, allowedEvent] = values;
  const defaultAttrs = attrs(defaultEvent);
  const secondaryAttrs = attrs(secondaryEvent);
  const allowedAttrs = attrs(allowedEvent);

  const ok =
    defaultEvent.id === sharedId &&
    secondaryEvent.id === sharedId &&
    allowedEvent.id === allowedId &&
    defaultEvent.provenance?.version === 2 &&
    defaultEvent.provenance?.projectId === "etlayer-default" &&
    secondaryEvent.provenance?.version === 2 &&
    secondaryEvent.provenance?.projectId === "etlayer-secondary" &&
    allowedEvent.provenance?.projectId === "etlayer-default" &&
    defaultAttrs["etlayer.project.id"] === "etlayer-secondary" &&
    secondaryAttrs["etlayer.project.id"] === "etlayer-default" &&
    allowedAttrs["etlayer.project.id"] === "etlayer-secondary";

  if (!ok) {
    console.error(
      JSON.stringify(
        { defaultEvent, secondaryEvent, allowedEvent },
        null,
        2,
      ),
    );
    process.exit(1);
  }
'   "$DEFAULT_CANONICAL"   "$SECONDARY_CANONICAL"   "$DEFAULT_ALLOWED_CANONICAL"   "$SHARED_EVENT_ID"   "$DEFAULT_ALLOWED_EVENT_ID" ||
  die "Trusted project provenance did not override payload project claims."

case "$DEFAULT_SOURCE_KEY" in
  "projects/$DEFAULT_PROJECT_ID/events/"*) ;;
  *) die "Default source key escaped default project namespace." ;;
esac

case "$SECONDARY_SOURCE_KEY" in
  "projects/$SECONDARY_PROJECT_ID/events/"*) ;;
  *) die "Secondary source key escaped secondary project namespace." ;;
esac

say "Verifying project-scoped destination routing"
assert_r2_absent   "projects/$DEFAULT_PROJECT_ID/deliveries/posthog/$SHARED_EVENT_ID.json"
assert_r2_absent   "projects/$DEFAULT_PROJECT_ID/deliveries/statsig/$SHARED_EVENT_ID.json"

assert_delivery_status   "$SECONDARY_PROJECT_ID" posthog "$SHARED_EVENT_ID" exported
assert_r2_absent   "projects/$SECONDARY_PROJECT_ID/deliveries/statsig/$SHARED_EVENT_ID.json"

assert_delivery_status   "$DEFAULT_PROJECT_ID" posthog "$DEFAULT_ALLOWED_EVENT_ID" exported
assert_delivery_status   "$DEFAULT_PROJECT_ID" statsig "$DEFAULT_ALLOWED_EVENT_ID" exported

say "Verifying decision pointers are isolated even for the same event id"
DEFAULT_POINTER="$(
  get_r2_json     "projects/$DEFAULT_PROJECT_ID/decision-latest/$SHARED_EVENT_ID.json"
)" || die "Default decision pointer missing."
SECONDARY_POINTER="$(
  get_r2_json     "projects/$SECONDARY_PROJECT_ID/decision-latest/$SHARED_EVENT_ID.json"
)" || die "Secondary decision pointer missing."

node -e '
  const [defaultRaw, secondaryRaw] = process.argv.slice(1);
  const a = JSON.parse(defaultRaw);
  const b = JSON.parse(secondaryRaw);

  if (
    a.projectId !== "etlayer-default" ||
    b.projectId !== "etlayer-secondary" ||
    a.eventId !== b.eventId ||
    a.key === b.key
  ) {
    console.error(JSON.stringify({ a, b }, null, 2));
    process.exit(1);
  }
' "$DEFAULT_POINTER" "$SECONDARY_POINTER" ||
  die "Decision pointers are not project-isolated."

say "Verifying default operator cannot act as secondary operator"
CROSS_BODY="$(
  node -e '
    const [projectId, sourceKey] = process.argv.slice(1);
    process.stdout.write(JSON.stringify({ projectId, sourceKey }));
  ' "$SECONDARY_PROJECT_ID" "$SECONDARY_SOURCE_KEY"
)"
CROSS_STATUS="$(
  operator_request_status     "/_ops/revalidate"     "$DEFAULT_OPERATOR_KEY"     "$CROSS_BODY"     "$TMP_PREFIX.cross.json"
)"
[ "$CROSS_STATUS" = "401" ] ||
  die "Cross-project operator credential was not rejected: HTTP $CROSS_STATUS"

say "Verifying default operator cannot smuggle a secondary source key"
WRONG_SOURCE_BODY="$(
  node -e '
    const [projectId, sourceKey] = process.argv.slice(1);
    process.stdout.write(JSON.stringify({ projectId, sourceKey }));
  ' "$DEFAULT_PROJECT_ID" "$SECONDARY_SOURCE_KEY"
)"
WRONG_SOURCE_STATUS="$(
  operator_request_status     "/_ops/revalidate"     "$DEFAULT_OPERATOR_KEY"     "$WRONG_SOURCE_BODY"     "$TMP_PREFIX.source.json"
)"
[ "$WRONG_SOURCE_STATUS" = "400" ] ||
  die "Cross-project source key was not rejected: HTTP $WRONG_SOURCE_STATUS"

say "Revalidating the secondary event with the correct secondary operator"
SECONDARY_REVALIDATION="$(
  curl --fail-with-body --silent --show-error     -X POST "$INGEST_URL/_ops/revalidate"     -H "authorization: Bearer $SECONDARY_OPERATOR_KEY"     -H "content-type: application/json"     --data "$CROSS_BODY"
)"

node -e '
  const value = JSON.parse(process.argv[1]);
  const ok =
    value.projectId === "etlayer-secondary" &&
    value.validation?.status === "valid" &&
    value.authority?.status === "allowed" &&
    value.decision?.projectId === "etlayer-secondary" &&
    value.decision?.evaluationKind === "revalidation" &&
    Array.isArray(value.deliveries) &&
    value.deliveries.length === 1 &&
    value.deliveries[0].destination === "posthog";

  if (!ok) {
    console.error(JSON.stringify(value, null, 2));
    process.exit(1);
  }
' "$SECONDARY_REVALIDATION" ||
  die "Secondary project revalidation was incorrect."

say "Verifying secondary project cannot replay disabled Statsig destination"
REPLAY_RANGE="$(
  python3 - <<'PY'
from datetime import datetime, timedelta, timezone
now = datetime.now(timezone.utc)
print((now - timedelta(minutes=5)).isoformat().replace("+00:00", "Z"))
print((now + timedelta(minutes=5)).isoformat().replace("+00:00", "Z"))
PY
)"
REPLAY_FROM="$(printf '%s\n' "$REPLAY_RANGE" | sed -n '1p')"
REPLAY_TO="$(printf '%s\n' "$REPLAY_RANGE" | sed -n '2p')"
REPLAY_BODY="$(
  node -e '
    const [projectId, from, to] = process.argv.slice(1);
    process.stdout.write(JSON.stringify({
      projectId,
      from,
      to,
      replayId: "vs8-secondary-statsig-denied",
    }));
  ' "$SECONDARY_PROJECT_ID" "$REPLAY_FROM" "$REPLAY_TO"
)"
REPLAY_STATUS="$(
  operator_request_status     "/_ops/replay/statsig"     "$SECONDARY_OPERATOR_KEY"     "$REPLAY_BODY"     "$TMP_PREFIX.replay.json"
)"
[ "$REPLAY_STATUS" = "400" ] ||
  die "Secondary Statsig replay was not rejected: HTTP $REPLAY_STATUS"

unset DEFAULT_BROWSER_KEY
unset DEFAULT_BACKEND_KEY
unset SECONDARY_BACKEND_KEY
unset DEFAULT_OPERATOR_KEY
unset SECONDARY_OPERATOR_KEY

say "VS8 project-scoped configuration and isolation acceptance passed"
cat <<EOF
{
  "correlationId": "$RUN_ID",
  "defaultProjectId": "$DEFAULT_PROJECT_ID",
  "secondaryProjectId": "$SECONDARY_PROJECT_ID",
  "sharedEventId": "$SHARED_EVENT_ID",
  "defaultAllowedEventId": "$DEFAULT_ALLOWED_EVENT_ID",
  "defaultBlockedSourceKey": "$DEFAULT_SOURCE_KEY",
  "secondarySourceKey": "$SECONDARY_SOURCE_KEY",
  "defaultAllowedSourceKey": "$DEFAULT_ALLOWED_SOURCE_KEY",
  "sameEventIdAcrossProjects": true,
  "payloadProjectClaimIgnoredForTrust": true,
  "defaultBlocked": true,
  "secondaryAllowed": true,
  "defaultDestinations": ["posthog", "statsig"],
  "secondaryDestinations": ["posthog"],
  "crossProjectOperatorStatus": 401,
  "crossProjectSourceStatus": 400,
  "secondaryStatsigReplayStatus": 400
}
EOF
