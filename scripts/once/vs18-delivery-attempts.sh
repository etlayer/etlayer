#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INGEST_DIR="$ROOT_DIR/packages/cloudflare-ingest"
WRANGLER_ENV="${ETLAYER_WRANGLER_ENV:-ci}"
INGEST_URL="${ETLAYER_INGEST_URL:-https://etlayer-ingest-ci.sergii-ponomarov.workers.dev}"
RUN_ID="${RUN_ID:-vs18-$(date -u +%Y%m%d-%H%M%S)-$(openssl rand -hex 4)}"
PROJECT_ID="${VS18_PROJECT_ID:-$RUN_ID}"
TMP_PREFIX="/tmp/etlayer-vs18-$$"

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

request_get() {
  local path="$1"
  local token="$2"
  local output="$3"

  curl --silent --show-error \
    -o "$output" \
    -w '%{http_code}' \
    "$INGEST_URL$path" \
    -H "authorization: Bearer $token"
}

management_json() {
  local method="$1"
  local path="$2"
  local token="$3"
  local body="$4"
  local output="$5"
  local status=""

  for attempt in $(seq 1 20); do
    status="$(
      request_json \
        "$method" \
        "$path" \
        "$token" \
        "$body" \
        "$output"
    )"

    if [ "$status" -ge 200 ] && [ "$status" -lt 300 ]; then
      return 0
    fi

    if [ "$status" = "401" ] && [ "$attempt" -lt 20 ]; then
      sleep 1
      continue
    fi

    printf 'HTTP %s for %s %s\n' "$status" "$method" "$path" >&2
    cat "$output" >&2 || true
    printf '\n' >&2
    return 1
  done

  return 1
}

json_field() {
  local file="$1"
  local path="$2"

  node -e '
    const value = JSON.parse(
      require("fs").readFileSync(process.argv[1], "utf8"),
    );
    const path = process.argv[2].split(".");
    let current = value;
    for (const key of path) current = current?.[key];
    if (current == null) process.exit(1);
    process.stdout.write(
      typeof current === "object"
        ? JSON.stringify(current)
        : String(current),
    );
  ' "$file" "$path"
}

create_project() {
  management_json \
    POST \
    "/_mgmt/projects" \
    "$MANAGEMENT_KEY" \
    "$(node -e '
      process.stdout.write(
        JSON.stringify({ id: process.argv[1] }),
      );
    ' "$PROJECT_ID")" \
    "$TMP_PREFIX.project"
}

configure_posthog() {
  management_json \
    PUT \
    "/_mgmt/projects/$PROJECT_ID/destinations/posthog" \
    "$OPERATOR_KEY" \
    '{"enabled":true}' \
    "$TMP_PREFIX.destination"
}

create_producer() {
  management_json \
    POST \
    "/_mgmt/projects/$PROJECT_ID/producers" \
    "$OPERATOR_KEY" \
    '{"id":"backend-main","profileId":"backend"}' \
    "$TMP_PREFIX.producer"
}

bootstrap_posthog_credential() {
  management_json \
    POST \
    "/_mgmt/projects/$PROJECT_ID/destinations/posthog/credential/bootstrap-runtime-default" \
    "$MANAGEMENT_KEY" \
    '{}' \
    "$TMP_PREFIX.credential"
}

emit_event() {
  local event_id="$1"

  node --input-type=module - \
    "$INGEST_URL/v1/logs" \
    "$PRODUCER_CREDENTIAL" \
    "$event_id" \
    "$RUN_ID" <<'NODE'
const [
  endpoint,
  credential,
  eventId,
  correlationId,
] = process.argv.slice(2);

const now =
  (BigInt(Date.now()) * 1_000_000n).toString();

const stringAttribute = (key, value) => ({
  key,
  value: { stringValue: value },
});

const intAttribute = (key, value) => ({
  key,
  value: { intValue: String(value) },
});

const payload = {
  resourceLogs: [{
    resource: {
      attributes: [
        stringAttribute(
          "service.name",
          "etlayer-vs18-acceptance",
        ),
      ],
    },
    scopeLogs: [{
      scope: {
        name: "etlayer.vs18",
        version: "1",
      },
      logRecords: [{
        eventName: "account.created",
        timeUnixNano: now,
        observedTimeUnixNano: now,
        attributes: [
          stringAttribute(
            "etlayer.event.id",
            eventId,
          ),
          intAttribute(
            "etlayer.schema.version",
            1,
          ),
          stringAttribute(
            "actor.anonymous.id",
            "anon_vs18",
          ),
          stringAttribute(
            "account.id",
            "account_vs18",
          ),
          stringAttribute(
            "correlation.id",
            correlationId,
          ),
          stringAttribute(
            "causation.id",
            "vs18-root",
          ),
          stringAttribute(
            "etlayer.producer.kind",
            "backend",
          ),
          stringAttribute(
            "etlayer.authority.kind",
            "business_state",
          ),
        ],
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

inspect_event() {
  local event_id="$1"
  local output="$2"

  request_json \
    POST \
    "/_ops/inspect" \
    "$OPERATOR_KEY" \
    "$(node -e '
      const [projectId, eventId] =
        process.argv.slice(1);
      process.stdout.write(
        JSON.stringify({
          projectId,
          eventId,
        }),
      );
    ' "$PROJECT_ID" "$event_id")" \
    "$output"
}

wait_for_attempt_state() {
  local event_id="$1"
  local expected_count="$2"
  local expected_status="$3"
  local output="$4"

  for attempt in $(seq 1 60); do
    local status
    status="$(
      inspect_event \
        "$event_id" \
        "$output" || true
    )"

    if [ "$status" = "200" ] &&
      node -e '
        const value = JSON.parse(
          require("fs").readFileSync(
            process.argv[1],
            "utf8",
          ),
        );
        const count = Number(process.argv[2]);
        const expectedStatus = process.argv[3];
        const delivery = value.deliveries?.find(
          item => item.destination === "posthog",
        );

        const ok =
          value.status === "complete" &&
          value.validation?.status === "valid" &&
          value.authority?.status === "allowed" &&
          value.decision?.routeEligible === true &&
          delivery?.status === expectedStatus &&
          delivery?.state?.attemptCount === count &&
          delivery?.attempts?.length === count;

        process.exit(ok ? 0 : 1);
      ' "$output" "$expected_count" "$expected_status"; then
      return 0
    fi

    sleep 1
  done

  cat "$output" >&2 || true
  die "Event did not reach expected delivery state."
}

revalidate_event() {
  local source_key="$1"
  local output="$2"

  request_json \
    POST \
    "/_ops/revalidate" \
    "$OPERATOR_KEY" \
    "$(node -e '
      const [projectId, sourceKey] =
        process.argv.slice(1);
      process.stdout.write(
        JSON.stringify({
          projectId,
          sourceKey,
        }),
      );
    ' "$PROJECT_ID" "$source_key")" \
    "$output"
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

say "Rotating VS18 management credential"
put_secret ETLAYER_MANAGEMENT_KEY "$MANAGEMENT_KEY"

say "Deploying current VS18 Worker"
(
  cd "$INGEST_DIR"
  npx wrangler deploy --env "$WRANGLER_ENV"
)

say "Creating isolated project"
create_project ||
  die "Project create failed."

OPERATOR_KEY="$(
  json_field "$TMP_PREFIX.project" operatorCredential
)" || die "Operator credential missing."

say "Enabling PostHog without installing a project credential"
configure_posthog ||
  die "PostHog enablement failed."

say "Creating backend producer"
create_producer ||
  die "Producer creation failed."

PRODUCER_CREDENTIAL="$(
  json_field "$TMP_PREFIX.producer" credential
)" || die "Producer credential missing."

EVENT_ID="$(uuid)"

say "Emitting event with PostHog not configured"
emit_event "$EVENT_ID"

wait_for_attempt_state \
  "$EVENT_ID" \
  1 \
  skipped \
  "$TMP_PREFIX.inspect-1"

node -e '
  const value = JSON.parse(
    require("fs").readFileSync(
      process.argv[1],
      "utf8",
    ),
  );
  const delivery = value.deliveries.find(
    item => item.destination === "posthog",
  );
  const attempt = delivery.attempts[0];

  const ok =
    delivery.state?.version === 3 &&
    delivery.state?.attemptCount === 1 &&
    delivery.state?.latestAttemptId ===
      attempt.attemptId &&
    attempt.attemptNumber === 1 &&
    attempt.mode === "live" &&
    attempt.status === "skipped" &&
    attempt.reason ===
      "posthog_not_configured";

  if (!ok) {
    console.error(
      JSON.stringify(delivery, null, 2),
    );
    process.exit(1);
  }
' "$TMP_PREFIX.inspect-1" ||
  die "Attempt #1 evidence is incorrect."

DELIVERY_ID="$(
  json_field "$TMP_PREFIX.inspect-1" deliveries.0.state.deliveryId
)" || die "Delivery ID missing."

ATTEMPT_1_ID="$(
  json_field "$TMP_PREFIX.inspect-1" deliveries.0.attempts.0.attemptId
)" || die "Attempt #1 ID missing."

SOURCE_KEY="$(
  json_field "$TMP_PREFIX.inspect-1" sourceKey
)" || die "Canonical source key missing."

say "Installing the real project-scoped PostHog credential"
bootstrap_posthog_credential ||
  die "PostHog credential bootstrap failed."

say "Revalidating the preserved event"
STATUS="$(
  revalidate_event \
    "$SOURCE_KEY" \
    "$TMP_PREFIX.revalidate-1"
)"
[ "$STATUS" = "200" ] ||
  die "First revalidation failed: HTTP $STATUS"

wait_for_attempt_state \
  "$EVENT_ID" \
  2 \
  exported \
  "$TMP_PREFIX.inspect-2"

node -e '
  const before = JSON.parse(
    require("fs").readFileSync(
      process.argv[1],
      "utf8",
    ),
  );
  const after = JSON.parse(
    require("fs").readFileSync(
      process.argv[2],
      "utf8",
    ),
  );
  const deliveryId = process.argv[3];
  const attempt1Id = process.argv[4];

  const firstBefore =
    before.deliveries[0].attempts[0];
  const delivery =
    after.deliveries.find(
      item => item.destination === "posthog",
    );
  const [first, second] = delivery.attempts;

  const ok =
    delivery.state.deliveryId === deliveryId &&
    delivery.state.attemptCount === 2 &&
    delivery.state.latestAttemptId ===
      second.attemptId &&
    first.attemptId === attempt1Id &&
    first.attemptId === firstBefore.attemptId &&
    first.status === "skipped" &&
    first.reason ===
      "posthog_not_configured" &&
    first.attemptNumber === 1 &&
    second.attemptNumber === 2 &&
    second.mode === "revalidation" &&
    second.status === "exported";

  if (!ok) {
    console.error(
      JSON.stringify(
        { before, after },
        null,
        2,
      ),
    );
    process.exit(1);
  }
' \
  "$TMP_PREFIX.inspect-1" \
  "$TMP_PREFIX.inspect-2" \
  "$DELIVERY_ID" \
  "$ATTEMPT_1_ID" ||
  die "Attempt #2 or append-only history is incorrect."

ATTEMPT_2_ID="$(
  json_field "$TMP_PREFIX.inspect-2" deliveries.0.attempts.1.attemptId
)" || die "Attempt #2 ID missing."

say "Revalidating again after exported state"
STATUS="$(
  revalidate_event \
    "$SOURCE_KEY" \
    "$TMP_PREFIX.revalidate-2"
)"
[ "$STATUS" = "200" ] ||
  die "Second revalidation failed: HTTP $STATUS"

node -e '
  const value = JSON.parse(
    require("fs").readFileSync(
      process.argv[1],
      "utf8",
    ),
  );
  const delivery = value.deliveries?.find(
    item => item.destination === "posthog",
  );

  if (
    delivery?.status !== "skipped" ||
    delivery?.reason !== "already_exported"
  ) {
    console.error(JSON.stringify(value, null, 2));
    process.exit(1);
  }
' "$TMP_PREFIX.revalidate-2" ||
  die "already_exported short-circuit was not returned."

wait_for_attempt_state \
  "$EVENT_ID" \
  2 \
  exported \
  "$TMP_PREFIX.inspect-3"

node -e '
  const value = JSON.parse(
    require("fs").readFileSync(
      process.argv[1],
      "utf8",
    ),
  );
  const expected1 = process.argv[2];
  const expected2 = process.argv[3];
  const attempts =
    value.deliveries?.[0]?.attempts || [];

  const ok =
    attempts.length === 2 &&
    attempts[0]?.attemptId === expected1 &&
    attempts[1]?.attemptId === expected2;

  if (!ok) {
    console.error(JSON.stringify(value, null, 2));
    process.exit(1);
  }
' \
  "$TMP_PREFIX.inspect-3" \
  "$ATTEMPT_1_ID" \
  "$ATTEMPT_2_ID" ||
  die "already_exported created a forbidden Attempt #3."

say "Proving public event status does not expose attempt history"
PUBLIC_STATUS="$(
  request_get \
    "/api/v1/projects/$PROJECT_ID/events/$EVENT_ID" \
    "$OPERATOR_KEY" \
    "$TMP_PREFIX.public"
)"
[ "$PUBLIC_STATUS" = "200" ] ||
  die "Public event status failed: HTTP $PUBLIC_STATUS"

node -e '
  const value = JSON.parse(
    require("fs").readFileSync(
      process.argv[1],
      "utf8",
    ),
  );
  const serialized = JSON.stringify(value);
  const delivery = value.deliveries?.find(
    item => item.destination === "posthog",
  );

  const ok =
    delivery?.status === "exported" &&
    !("attempts" in delivery) &&
    !serialized.includes(process.argv[2]) &&
    !serialized.includes(process.argv[3]);

  if (!ok) {
    console.error(JSON.stringify(value, null, 2));
    process.exit(1);
  }
' \
  "$TMP_PREFIX.public" \
  "$ATTEMPT_1_ID" \
  "$ATTEMPT_2_ID" ||
  die "Public status leaked delivery attempt internals."

unset PRODUCER_CREDENTIAL
unset OPERATOR_KEY
unset MANAGEMENT_KEY

say "VS18 Delivery + Attempt acceptance passed"
cat <<EOF
{
  "correlationId": "$RUN_ID",
  "projectId": "$PROJECT_ID",
  "eventId": "$EVENT_ID",
  "deliveryId": "$DELIVERY_ID",
  "attemptCount": 2,
  "attempt1": {
    "id": "$ATTEMPT_1_ID",
    "status": "skipped",
    "reason": "posthog_not_configured",
    "mode": "live"
  },
  "attempt2": {
    "id": "$ATTEMPT_2_ID",
    "status": "exported",
    "mode": "revalidation"
  },
  "alreadyExportedCreatedAttempt3": false,
  "publicAttemptHistoryExposed": false
}
EOF
