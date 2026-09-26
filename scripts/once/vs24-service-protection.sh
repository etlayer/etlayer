#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INGEST_DIR="$ROOT_DIR/packages/cloudflare-ingest"
WRANGLER_ENV="${ETLAYER_WRANGLER_ENV:-ci}"
INGEST_URL="${ETLAYER_INGEST_URL:-https://etlayer-ingest-ci.sergii-ponomarov.workers.dev}"
RUN_ID="${RUN_ID:-vs24-$(date -u +%Y%m%d-%H%M%S)-$(openssl rand -hex 4)}"
PROJECT_A="${VS24_PROJECT_A:-$RUN_ID-a}"
PROJECT_B="${VS24_PROJECT_B:-$RUN_ID-b}"
TMP_PREFIX="/tmp/etlayer-vs24-$$"

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

  curl --silent --show-error     -o "$output"     -w '%{http_code}'     -X "$method" "$INGEST_URL$path"     -H "authorization: Bearer $token"     -H "content-type: application/json"     --data "$body"
}

request_json_after_deploy() {
  local method="$1"
  local path="$2"
  local token="$3"
  local body="$4"
  local output="$5"
  local status=""

  for attempt in $(seq 1 20); do
    status="$(
      request_json         "$method"         "$path"         "$token"         "$body"         "$output"
    )"

    if [ "$status" != "401" ]; then
      printf '%s' "$status"
      return 0
    fi

    if [ "$attempt" -lt 20 ]; then
      sleep 1
    fi
  done

  printf '%s' "$status"
}

json_field() {
  local file="$1"
  local path="$2"

  node -e '
    const value = JSON.parse(
      require("fs").readFileSync(
        process.argv[1],
        "utf8",
      ),
    );
    const path = process.argv[2].split(".");
    let current = value;

    for (const key of path) {
      current = current?.[key];
    }

    if (current == null) {
      process.exit(1);
    }

    process.stdout.write(
      typeof current === "object"
        ? JSON.stringify(current)
        : String(current),
    );
  ' "$file" "$path"
}

create_project() {
  local project_id="$1"
  local output="$2"
  local after_deploy="$3"
  local status=""

  if [ "$after_deploy" = "yes" ]; then
    status="$(
      request_json_after_deploy         POST         "/_mgmt/projects"         "$MANAGEMENT_KEY"         "$(node -e '
          process.stdout.write(
            JSON.stringify({
              id: process.argv[1],
            }),
          );
        ' "$project_id")"         "$output"
    )"
  else
    status="$(
      request_json         POST         "/_mgmt/projects"         "$MANAGEMENT_KEY"         "$(node -e '
          process.stdout.write(
            JSON.stringify({
              id: process.argv[1],
            }),
          );
        ' "$project_id")"         "$output"
    )"
  fi

  [ "$status" = "201" ] ||
    die "Project create failed for $project_id: HTTP $status"
}

create_producer() {
  local project_id="$1"
  local operator="$2"
  local output="$3"

  local status
  status="$(
    request_json       POST       "/_mgmt/projects/$project_id/producers"       "$operator"       '{"id":"backend-main","profileId":"backend"}'       "$output"
  )"

  [ "$status" = "201" ] ||
    die "Producer create failed for $project_id: HTTP $status"
}

make_payload() {
  local output="$1"
  local event_id="$2"
  local event_count="$3"
  local padding_bytes="$4"

  node -     "$event_id"     "$RUN_ID"     "$event_count"     "$padding_bytes" > "$output" <<'NODE'
const [
  eventId,
  correlationId,
  eventCountRaw,
  paddingRaw,
] = process.argv.slice(2);

const eventCount =
  Number(eventCountRaw);
const paddingBytes =
  Number(paddingRaw);

const stringAttribute = (key, value) => ({
  key,
  value: { stringValue: value },
});

const intAttribute = (key, value) => ({
  key,
  value: { intValue: String(value) },
});

const now =
  (BigInt(Date.now()) * 1_000_000n).toString();

const logRecords = [];

for (let index = 0; index < eventCount; index += 1) {
  const id =
    index === 0
      ? eventId
      : eventId + "-" + index;

  const attributes = [
    stringAttribute(
      "etlayer.event.id",
      id,
    ),
    intAttribute(
      "etlayer.schema.version",
      1,
    ),
    stringAttribute(
      "actor.anonymous.id",
      "anon_vs24",
    ),
    stringAttribute(
      "account.id",
      "account_" + id,
    ),
    stringAttribute(
      "correlation.id",
      correlationId,
    ),
    stringAttribute(
      "causation.id",
      "vs24-root",
    ),
    stringAttribute(
      "etlayer.producer.kind",
      "backend",
    ),
    stringAttribute(
      "etlayer.authority.kind",
      "business_state",
    ),
  ];

  if (
    index === 0 &&
    paddingBytes > 0
  ) {
    attributes.push(
      stringAttribute(
        "vs24.padding",
        "x".repeat(paddingBytes),
      ),
    );
  }

  logRecords.push({
    eventName: "account.created",
    timeUnixNano: now,
    observedTimeUnixNano: now,
    attributes,
  });
}

process.stdout.write(
  JSON.stringify({
    resourceLogs: [{
      resource: {
        attributes: [
          stringAttribute(
            "service.name",
            "etlayer-vs24-acceptance",
          ),
        ],
      },
      scopeLogs: [{
        scope: {
          name: "etlayer.vs24",
          version: "1",
        },
        logRecords,
      }],
    }],
  }),
);
NODE
}

ingest_file() {
  local token="$1"
  local payload_file="$2"
  local output="$3"
  local headers="$4"

  curl --silent --show-error     -D "$headers"     -o "$output"     -w '%{http_code}'     -X POST     "$INGEST_URL/v1/logs"     -H "authorization: Bearer $token"     -H "content-type: application/json"     --data-binary "@$payload_file"
}

inspect_event() {
  local project_id="$1"
  local operator="$2"
  local event_id="$3"
  local output="$4"

  request_json     POST     "/_ops/inspect"     "$operator"     "$(node -e '
      const [projectId, eventId] =
        process.argv.slice(1);

      process.stdout.write(
        JSON.stringify({
          projectId,
          eventId,
        }),
      );
    ' "$project_id" "$event_id")"     "$output"
}

wait_complete() {
  local project_id="$1"
  local operator="$2"
  local event_id="$3"
  local output="$4"

  for attempt in $(seq 1 45); do
    local status
    status="$(
      inspect_event         "$project_id"         "$operator"         "$event_id"         "$output" || true
    )"

    if [ "$status" = "200" ] &&
      node -e '
        const value = JSON.parse(
          require("fs").readFileSync(
            process.argv[1],
            "utf8",
          ),
        );

        process.exit(
          value?.status === "complete"
            ? 0
            : 1,
        );
      ' "$output"; then
      return 0
    fi

    sleep 1
  done

  cat "$output" >&2 || true
  die "Event did not reach complete: $event_id"
}

assert_unknown() {
  local project_id="$1"
  local operator="$2"
  local event_id="$3"
  local output="$4"

  sleep 2

  local status
  status="$(
    inspect_event       "$project_id"       "$operator"       "$event_id"       "$output"
  )"

  [ "$status" = "200" ] ||
    die "Rejected event inspect failed: HTTP $status"

  node -e '
    const value = JSON.parse(
      require("fs").readFileSync(
        process.argv[1],
        "utf8",
      ),
    );

    const ok =
      value.known === false &&
      value.status ===
        "pending_or_unknown" &&
      value.decision == null;

    if (!ok) {
      console.error(
        JSON.stringify(value, null, 2),
      );
      process.exit(1);
    }
  ' "$output" ||
    die "Rejected request created event evidence: $event_id"
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

say "Rotating VS24 management credential"
put_secret ETLAYER_MANAGEMENT_KEY "$MANAGEMENT_KEY"

say "Deploying current VS24 Worker"
(
  cd "$INGEST_DIR"
  npx wrangler deploy --env "$WRANGLER_ENV"
)

say "Creating isolated projects"
create_project   "$PROJECT_A"   "$TMP_PREFIX.project-a"   yes
create_project   "$PROJECT_B"   "$TMP_PREFIX.project-b"   no

OPERATOR_A="$(
  json_field     "$TMP_PREFIX.project-a"     operatorCredential
)" || die "Project A operator credential missing."

OPERATOR_B="$(
  json_field     "$TMP_PREFIX.project-b"     operatorCredential
)" || die "Project B operator credential missing."

say "Creating backend producers"
create_producer   "$PROJECT_A"   "$OPERATOR_A"   "$TMP_PREFIX.producer-a"
create_producer   "$PROJECT_B"   "$OPERATOR_B"   "$TMP_PREFIX.producer-b"

PRODUCER_A="$(
  json_field     "$TMP_PREFIX.producer-a"     credential
)" || die "Project A producer credential missing."

PRODUCER_B="$(
  json_field     "$TMP_PREFIX.producer-b"     credential
)" || die "Project B producer credential missing."

BASELINE_A="$(uuid)"
BASELINE_B="$(uuid)"

make_payload   "$TMP_PREFIX.baseline-a.payload"   "$BASELINE_A"   1   0
make_payload   "$TMP_PREFIX.baseline-b.payload"   "$BASELINE_B"   1   0

say "Proving both projects can ingest normally"
STATUS="$(
  ingest_file     "$PRODUCER_A"     "$TMP_PREFIX.baseline-a.payload"     "$TMP_PREFIX.baseline-a.body"     "$TMP_PREFIX.baseline-a.headers"
)"
[ "$STATUS" = "200" ] ||
  die "Project A baseline ingest failed: HTTP $STATUS"

STATUS="$(
  ingest_file     "$PRODUCER_B"     "$TMP_PREFIX.baseline-b.payload"     "$TMP_PREFIX.baseline-b.body"     "$TMP_PREFIX.baseline-b.headers"
)"
[ "$STATUS" = "200" ] ||
  die "Project B baseline ingest failed: HTTP $STATUS"

wait_complete   "$PROJECT_A"   "$OPERATOR_A"   "$BASELINE_A"   "$TMP_PREFIX.baseline-a.inspect"
wait_complete   "$PROJECT_B"   "$OPERATOR_B"   "$BASELINE_B"   "$TMP_PREFIX.baseline-b.inspect"

say "Proving invalid credentials do not consume a trusted project key"
INVALID_PAYLOAD_ID="$(uuid)"
make_payload   "$TMP_PREFIX.invalid.payload"   "$INVALID_PAYLOAD_ID"   1   0

for attempt in $(seq 1 30); do
  STATUS="$(
    ingest_file       "invalid-$attempt"       "$TMP_PREFIX.invalid.payload"       "$TMP_PREFIX.invalid.body"       "$TMP_PREFIX.invalid.headers"
  )"

  [ "$STATUS" = "401" ] ||
    die "Invalid credential returned HTTP $STATUS"
done

AFTER_INVALID_B="$(uuid)"
make_payload   "$TMP_PREFIX.after-invalid-b.payload"   "$AFTER_INVALID_B"   1   0

STATUS="$(
  ingest_file     "$PRODUCER_B"     "$TMP_PREFIX.after-invalid-b.payload"     "$TMP_PREFIX.after-invalid-b.body"     "$TMP_PREFIX.after-invalid-b.headers"
)"
[ "$STATUS" = "200" ] ||
  die "Invalid credentials consumed Project B rate budget: HTTP $STATUS"

say "Driving Project A until project-scoped rate limit is observed"
node --input-type=module - \
  "$INGEST_URL/v1/logs" \
  "$PRODUCER_A" \
  "$RUN_ID" > "$TMP_PREFIX.rate-result" <<'NODE'
const [
  endpoint,
  credential,
  correlationId,
] = process.argv.slice(2);

const stringAttribute = (key, value) => ({
  key,
  value: { stringValue: value },
});

const intAttribute = (key, value) => ({
  key,
  value: { intValue: String(value) },
});

function payload(eventId) {
  const now =
    (BigInt(Date.now()) * 1_000_000n).toString();

  return {
    resourceLogs: [{
      resource: {
        attributes: [
          stringAttribute(
            "service.name",
            "etlayer-vs24-rate-burst",
          ),
        ],
      },
      scopeLogs: [{
        scope: {
          name: "etlayer.vs24",
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
              "anon_vs24",
            ),
            stringAttribute(
              "account.id",
              "account_" + eventId,
            ),
            stringAttribute(
              "correlation.id",
              correlationId,
            ),
            stringAttribute(
              "causation.id",
              "vs24-rate-root",
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
}

let attempted = 0;

for (let wave = 0; wave < 8; wave += 1) {
  const requests = [];

  for (let index = 0; index < 40; index += 1) {
    const eventId = crypto.randomUUID();
    attempted += 1;

    requests.push(
      fetch(endpoint, {
        method: "POST",
        headers: {
          authorization:
            "Bearer " + credential,
          "content-type":
            "application/json",
        },
        body: JSON.stringify(
          payload(eventId),
        ),
      }).then(async (response) => ({
        eventId,
        status: response.status,
        retryAfter:
          response.headers.get(
            "retry-after",
          ),
        body: await response.text(),
        attempt: attempted,
      })),
    );
  }

  const responses =
    await Promise.all(requests);
  const limited =
    responses.find(
      (response) =>
        response.status === 429,
    );

  if (limited) {
    process.stdout.write(
      JSON.stringify(limited),
    );
    process.exit(0);
  }

  const unexpected =
    responses.find(
      (response) =>
        response.status !== 200,
    );

  if (unexpected) {
    console.error(
      JSON.stringify(
        unexpected,
        null,
        2,
      ),
    );
    process.exit(2);
  }

  await new Promise(
    (resolve) =>
      setTimeout(resolve, 150),
  );
}

console.error(
  "rate limit was not observed after " +
    attempted +
    " burst requests",
);
process.exit(3);
NODE

RATE_LIMITED_EVENT_ID="$(
  json_field \
    "$TMP_PREFIX.rate-result" \
    eventId
)" || die "Rate-limited event id missing."

RATE_LIMITED_ATTEMPT="$(
  json_field \
    "$TMP_PREFIX.rate-result" \
    attempt
)" || die "Rate-limited attempt missing."

RETRY_AFTER="$(
  json_field \
    "$TMP_PREFIX.rate-result" \
    retryAfter
)" || die "Rate-limit Retry-After missing."

node -e '
  const value = JSON.parse(
    require("fs").readFileSync(
      process.argv[1],
      "utf8",
    ),
  );
  const body = JSON.parse(
    value.body,
  );

  const ok =
    value.status === 429 &&
    value.retryAfter === "10" &&
    body.code === 8 &&
    body.message ===
      "ingest rate limit exceeded";

  if (!ok) {
    console.error(
      JSON.stringify(value, null, 2),
    );
    process.exit(1);
  }
' "$TMP_PREFIX.rate-result" ||
  die "Rate-limit response is incorrect."

say "Proving Project B remains isolated from Project A exhaustion"
ISOLATED_B="$(uuid)"
make_payload   "$TMP_PREFIX.isolated-b.payload"   "$ISOLATED_B"   1   0

STATUS="$(
  ingest_file     "$PRODUCER_B"     "$TMP_PREFIX.isolated-b.payload"     "$TMP_PREFIX.isolated-b.body"     "$TMP_PREFIX.isolated-b.headers"
)"
[ "$STATUS" = "200" ] ||
  die "Project B was affected by Project A rate limit: HTTP $STATUS"

say "Proving oversized body is rejected before queueing"
OVERSIZED_EVENT_ID="$(uuid)"
make_payload   "$TMP_PREFIX.oversized.payload"   "$OVERSIZED_EVENT_ID"   1   70000

STATUS="$(
  ingest_file     "$PRODUCER_B"     "$TMP_PREFIX.oversized.payload"     "$TMP_PREFIX.oversized.body"     "$TMP_PREFIX.oversized.headers"
)"
[ "$STATUS" = "413" ] ||
  die "Oversized body was not rejected: HTTP $STATUS"

node -e '
  const value = JSON.parse(
    require("fs").readFileSync(
      process.argv[1],
      "utf8",
    ),
  );

  if (
    value.code !== 8 ||
    value.message !==
      "request body exceeds ingest limit"
  ) {
    console.error(
      JSON.stringify(value, null, 2),
    );
    process.exit(1);
  }
' "$TMP_PREFIX.oversized.body" ||
  die "Oversized-body response is incorrect."

say "Proving too many events are rejected before queueing"
TOO_MANY_EVENT_ID="$(uuid)"
make_payload   "$TMP_PREFIX.too-many.payload"   "$TOO_MANY_EVENT_ID"   6   0

STATUS="$(
  ingest_file     "$PRODUCER_B"     "$TMP_PREFIX.too-many.payload"     "$TMP_PREFIX.too-many.body"     "$TMP_PREFIX.too-many.headers"
)"
[ "$STATUS" = "413" ] ||
  die "Event-count limit was not enforced: HTTP $STATUS"

node -e '
  const value = JSON.parse(
    require("fs").readFileSync(
      process.argv[1],
      "utf8",
    ),
  );

  if (
    value.code !== 8 ||
    value.message !==
      "request contains too many events"
  ) {
    console.error(
      JSON.stringify(value, null, 2),
    );
    process.exit(1);
  }
' "$TMP_PREFIX.too-many.body" ||
  die "Event-count response is incorrect."

say "Proving rejected requests created no event evidence"
assert_unknown   "$PROJECT_A"   "$OPERATOR_A"   "$RATE_LIMITED_EVENT_ID"   "$TMP_PREFIX.rate.inspect"
assert_unknown   "$PROJECT_B"   "$OPERATOR_B"   "$OVERSIZED_EVENT_ID"   "$TMP_PREFIX.oversized.inspect"
assert_unknown   "$PROJECT_B"   "$OPERATOR_B"   "$TOO_MANY_EVENT_ID"   "$TMP_PREFIX.too-many.inspect"

unset PRODUCER_A
unset PRODUCER_B
unset OPERATOR_A
unset OPERATOR_B
unset MANAGEMENT_KEY

say "VS24 service protection acceptance passed"
cat <<EOF
{
  "correlationId": "$RUN_ID",
  "projectA": "$PROJECT_A",
  "projectB": "$PROJECT_B",
  "rateLimitedEventId": "$RATE_LIMITED_EVENT_ID",
  "rateLimitedAttempt": $RATE_LIMITED_ATTEMPT,
  "retryAfterSeconds": 10,
  "projectIsolation": true,
  "oversizedBodyRejected": true,
  "tooManyEventsRejected": true,
  "invalidCredentialsConsumedProjectBudget": false,
  "rejectedEventEvidenceCreated": false
}
EOF
