#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INGEST_DIR="$ROOT_DIR/packages/cloudflare-ingest"
WRANGLER_ENV="${ETLAYER_WRANGLER_ENV:-ci}"
INGEST_URL="${ETLAYER_INGEST_URL:-https://etlayer-ingest-ci.sergii-ponomarov.workers.dev}"
RUN_ID="${RUN_ID:-vs17-$(date -u +%Y%m%d-%H%M%S)-$(openssl rand -hex 4)}"
PROJECT_ID="${VS17_PROJECT_ID:-$RUN_ID}"
TMP_PREFIX="/tmp/etlayer-vs17-$$"

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

json_field() {
  local json="$1"
  local path="$2"

  node -e '
    const value = JSON.parse(process.argv[1]);
    const path = process.argv[2].split(".");
    let current = value;
    for (const key of path) current = current?.[key];
    if (current == null) process.exit(1);
    process.stdout.write(
      typeof current === "object"
        ? JSON.stringify(current)
        : String(current),
    );
  ' "$json" "$path"
}

emit_event() {
  local mode="$1"
  local event_id="$2"

  node --input-type=module -     "$INGEST_URL/v1/logs"     "$PRODUCER_CREDENTIAL"     "$event_id"     "$RUN_ID"     "$mode" <<'NODE'
const [endpoint, credential, eventId, correlationId, mode] =
  process.argv.slice(2);

const nowUnixNano =
  (BigInt(Date.now()) * 1_000_000n).toString();

const stringAttribute = (key, value) => ({
  key,
  value: { stringValue: value },
});
const intAttribute = (key, value) => ({
  key,
  value: { intValue: String(value) },
});

const attributes = [
  stringAttribute("etlayer.event.id", eventId),
  intAttribute("etlayer.schema.version", 1),
  stringAttribute("actor.anonymous.id", "anon_vs17"),
  stringAttribute("correlation.id", correlationId),
  stringAttribute("causation.id", "vs17-root"),
  stringAttribute("etlayer.producer.kind", "backend"),
  stringAttribute(
    "etlayer.authority.kind",
    "business_state",
  ),
];

if (mode !== "current-quarantine") {
  attributes.push(
    stringAttribute(
      "account.id",
      "account_" + eventId,
    ),
  );
}

if (mode !== "future-quarantine") {
  attributes.push(
    stringAttribute("plan.id", "pro"),
  );
}

const payload = {
  resourceLogs: [{
    resource: {
      attributes: [
        stringAttribute(
          "service.name",
          "etlayer-vs17-acceptance",
        ),
      ],
    },
    scopeLogs: [{
      scope: {
        name: "etlayer.vs17",
        version: "1",
      },
      logRecords: [{
        eventName: "account.created",
        timeUnixNano: nowUnixNano,
        observedTimeUnixNano: nowUnixNano,
        attributes,
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
  local status

  status="$(
    request_json       POST       "/_ops/inspect"       "$OPERATOR_KEY"       "$(node -e '
        const [projectId, eventId] = process.argv.slice(1);
        process.stdout.write(
          JSON.stringify({ projectId, eventId }),
        );
      ' "$PROJECT_ID" "$event_id")"       "$output"
  )"

  [ "$status" = "200" ] ||
    die "Inspect failed for $event_id: HTTP $status"
}

wait_complete() {
  local event_id="$1"
  local output="$2"

  for attempt in $(seq 1 45); do
    inspect_event "$event_id" "$output"

    if node -e '
      const value = JSON.parse(process.argv[1]);
      process.exit(
        value?.status === "complete" ? 0 : 1,
      );
    ' "$(cat "$output")"; then
      return 0
    fi

    sleep 1
  done

  cat "$output" >&2 || true
  die "Event did not reach complete: $event_id"
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

say "Rotating VS17 management credential"
put_secret ETLAYER_MANAGEMENT_KEY "$MANAGEMENT_KEY"

say "Deploying current contract-plan Worker"
(
  cd "$INGEST_DIR"
  npx wrangler deploy --env "$WRANGLER_ENV"
)

say "Creating isolated project with no destinations"
STATUS="$(
  request_json     POST     "/_mgmt/projects"     "$MANAGEMENT_KEY"     "$(node -e '
      process.stdout.write(
        JSON.stringify({ id: process.argv[1] }),
      );
    ' "$PROJECT_ID")"     "$TMP_PREFIX.project"
)"
[ "$STATUS" = "201" ] ||
  die "Project create failed: HTTP $STATUS"

PROJECT_RESPONSE="$(cat "$TMP_PREFIX.project")"
OPERATOR_KEY="$(
  json_field "$PROJECT_RESPONSE" operatorCredential
)" || die "Operator credential missing"

say "Creating backend producer"
STATUS="$(
  request_json     POST     "/_mgmt/projects/$PROJECT_ID/producers"     "$OPERATOR_KEY"     '{"id":"backend-main","profileId":"backend"}'     "$TMP_PREFIX.producer"
)"
[ "$STATUS" = "201" ] ||
  die "Producer create failed: HTTP $STATUS"

PRODUCER_CREDENTIAL="$(
  json_field "$(cat "$TMP_PREFIX.producer")" credential
)" || die "Producer credential missing"

RANGE_FROM="$(
  node -e '
    process.stdout.write(
      new Date(Date.now() - 120000).toISOString(),
    );
  '
)"

STILL_ALLOW_ID="$(uuid)"
NEW_QUARANTINE_ID="$(uuid)"
STILL_QUARANTINE_ID="$(uuid)"

say "Emitting historical current-ALLOW / proposed-ALLOW event"
emit_event still-allow "$STILL_ALLOW_ID"

say "Emitting historical current-ALLOW / proposed-QUARANTINE event"
emit_event future-quarantine "$NEW_QUARANTINE_ID"

say "Emitting historical current-QUARANTINE / proposed-QUARANTINE event"
emit_event current-quarantine "$STILL_QUARANTINE_ID"

wait_complete   "$STILL_ALLOW_ID"   "$TMP_PREFIX.still-allow-before"
wait_complete   "$NEW_QUARANTINE_ID"   "$TMP_PREFIX.new-quarantine-before"
wait_complete   "$STILL_QUARANTINE_ID"   "$TMP_PREFIX.still-quarantine-before"

BEFORE_DECISION="$(
  json_field     "$(cat "$TMP_PREFIX.new-quarantine-before")"     decision.decisionId
)" || die "Before-plan decision id missing"

node -e '
  const allow = JSON.parse(process.argv[1]);
  const future = JSON.parse(process.argv[2]);
  const quarantined = JSON.parse(process.argv[3]);

  const ok =
    allow.decision?.outcome === "allow" &&
    future.decision?.outcome === "allow" &&
    quarantined.decision?.outcome ===
      "quarantine" &&
    (allow.deliveries || []).length === 0 &&
    (future.deliveries || []).length === 0 &&
    (quarantined.deliveries || []).length === 0;

  if (!ok) {
    console.error(
      JSON.stringify(
        { allow, future, quarantined },
        null,
        2,
      ),
    );
    process.exit(1);
  }
'   "$(cat "$TMP_PREFIX.still-allow-before")"   "$(cat "$TMP_PREFIX.new-quarantine-before")"   "$(cat "$TMP_PREFIX.still-quarantine-before")" ||
  die "Historical baseline outcomes are incorrect"

RANGE_TO="$(
  node -e '
    process.stdout.write(
      new Date(Date.now() + 120000).toISOString(),
    );
  '
)"

PLAN_BODY="$(
  node -e '
    const [
      projectId,
      from,
      to,
    ] = process.argv.slice(1);

    const proposedContract = {
      id: "account.created@2",
      eventName: "account.created",
      version: 2,
      required: {
        "actor.anonymous.id": { type: "string" },
        "account.id": { type: "string" },
        "correlation.id": { type: "string" },
        "causation.id": { type: "string" },
        "plan.id": { type: "string" },
        "etlayer.producer.kind": {
          type: "string",
          const: "backend",
        },
        "etlayer.authority.kind": {
          type: "string",
          const: "business_state",
        },
      },
      forbidden: [
        "experiment.id",
        "experiment.variant",
      ],
    };

    process.stdout.write(
      JSON.stringify({
        projectId,
        eventName: "account.created",
        currentVersion: 1,
        proposedContract,
        from,
        to,
        compatibilityMode: "backward",
        maxExamples: 10,
      }),
    );
  ' "$PROJECT_ID" "$RANGE_FROM" "$RANGE_TO"
)"

say "Planning proposed account.created@2 against preserved history"
STATUS="$(
  request_json     POST     "/_ops/plan/contract"     "$OPERATOR_KEY"     "$PLAN_BODY"     "$TMP_PREFIX.plan"
)"
[ "$STATUS" = "200" ] ||
  die "Contract plan failed: HTTP $STATUS"

PLAN="$(cat "$TMP_PREFIX.plan")"

node -e '
  const value = JSON.parse(process.argv[1]);
  const changed = value.examples || [];

  const compatibleViolation =
    value.compatibility?.backward?.violations?.some(
      (item) =>
        item.code === "required_attribute_added" &&
        item.attribute === "plan.id",
    );

  const exact =
    value.selected === 3 &&
    value.changed === 1 &&
    value.transitions?.allow_to_allow === 1 &&
    value.transitions?.allow_to_quarantine === 1 &&
    value.transitions?.quarantine_to_quarantine === 1 &&
    value.compatibility?.compatible === false &&
    compatibleViolation === true &&
    changed.length === 1 &&
    changed[0]?.eventId === process.argv[2] &&
    changed[0]?.before === "allow" &&
    changed[0]?.after === "quarantine";

  if (!exact) {
    console.error(JSON.stringify(value, null, 2));
    process.exit(1);
  }
' "$PLAN" "$NEW_QUARANTINE_ID" ||
  die "Historical contract plan result is incorrect"

say "Proving plan did not append decision state"
inspect_event   "$NEW_QUARANTINE_ID"   "$TMP_PREFIX.new-quarantine-after"

AFTER_DECISION="$(
  json_field     "$(cat "$TMP_PREFIX.new-quarantine-after")"     decision.decisionId
)" || die "After-plan decision id missing"

[ "$BEFORE_DECISION" = "$AFTER_DECISION" ] ||
  die "Plan mutated decision lineage"

node -e '
  const value = JSON.parse(process.argv[1]);
  if (
    value.decision?.outcome !== "allow" ||
    (value.deliveries || []).length !== 0
  ) {
    console.error(JSON.stringify(value, null, 2));
    process.exit(1);
  }
' "$(cat "$TMP_PREFIX.new-quarantine-after")" ||
  die "Plan changed runtime event/delivery state"

unset PRODUCER_CREDENTIAL
unset OPERATOR_KEY
unset MANAGEMENT_KEY

say "VS17 historical contract plan acceptance passed"
cat <<EOF
{
  "correlationId": "$RUN_ID",
  "projectId": "$PROJECT_ID",
  "selected": 3,
  "changed": 1,
  "transitions": {
    "allow_to_allow": 1,
    "allow_to_quarantine": 1,
    "quarantine_to_quarantine": 1
  },
  "compatibility": "backward-breaking",
  "affectedEventId": "$NEW_QUARANTINE_ID",
  "decisionIdBefore": "$BEFORE_DECISION",
  "decisionIdAfter": "$AFTER_DECISION",
  "decisionLineageMutated": false,
  "destinationDeliveryTriggered": false
}
EOF
