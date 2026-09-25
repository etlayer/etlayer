#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INGEST_DIR="$ROOT_DIR/packages/cloudflare-ingest"
WRANGLER_ENV="${ETLAYER_WRANGLER_ENV:-ci}"
INGEST_URL="${ETLAYER_INGEST_URL:-https://etlayer-ingest-ci.sergii-ponomarov.workers.dev}"
RUN_ID="${RUN_ID:-vs19-$(date -u +%Y%m%d-%H%M%S)-$(openssl rand -hex 4)}"
PROJECT_ID="${VS19_PROJECT_ID:-$RUN_ID}"
TMP_PREFIX="/tmp/etlayer-vs19-$$"

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

request_json_after_deploy() {
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

emit_event() {
  local event_id="$1"
  local include_plan="$2"

  node --input-type=module - \
    "$INGEST_URL/v1/logs" \
    "$PRODUCER_CREDENTIAL" \
    "$event_id" \
    "$RUN_ID" \
    "$include_plan" <<'NODE'
const [
  endpoint,
  credential,
  eventId,
  correlationId,
  includePlan,
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

const attributes = [
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
    "anon_vs19",
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
    "vs19-root",
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

if (includePlan === "yes") {
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
          "etlayer-vs19-acceptance",
        ),
      ],
    },
    scopeLogs: [{
      scope: {
        name: "etlayer.vs19",
        version: "1",
      },
      logRecords: [{
        eventName: "account.created",
        timeUnixNano: now,
        observedTimeUnixNano: now,
        attributes,
      }],
    }],
  }],
};

const response = await fetch(endpoint, {
  method: "POST",
  headers: {
    authorization:
      "Bearer " + credential,
    "content-type":
      "application/json",
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

wait_complete() {
  local event_id="$1"
  local output="$2"

  for attempt in $(seq 1 45); do
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

cd "$ROOT_DIR"

if [ -n "${CLOUDFLARE_API_TOKEN:-}" ] &&
   [ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
  say "Using non-interactive Cloudflare API token"
else
  npx wrangler whoami >/dev/null 2>&1 ||
    die "Wrangler is not authenticated"
fi

MANAGEMENT_KEY="$(generate_key)"

say "Rotating VS19 management credential"
put_secret ETLAYER_MANAGEMENT_KEY "$MANAGEMENT_KEY"

say "Deploying current VS19 Worker"
(
  cd "$INGEST_DIR"
  npx wrangler deploy --env "$WRANGLER_ENV"
)

say "Creating isolated project"
STATUS="$(
  request_json_after_deploy \
    POST \
    "/_mgmt/projects" \
    "$MANAGEMENT_KEY" \
    "$(node -e '
      process.stdout.write(
        JSON.stringify({
          id: process.argv[1],
        }),
      );
    ' "$PROJECT_ID")" \
    "$TMP_PREFIX.project"
)"
[ "$STATUS" = "201" ] ||
  die "Project create failed: HTTP $STATUS"

OPERATOR_KEY="$(
  json_field     "$TMP_PREFIX.project" \
    operatorCredential
)" || die "Operator credential missing."

say "Creating backend producer"
STATUS="$(
  request_json \
    POST \
    "/_mgmt/projects/$PROJECT_ID/producers" \
    "$OPERATOR_KEY" \
    '{"id":"backend-main","profileId":"backend"}' \
    "$TMP_PREFIX.producer"
)"
[ "$STATUS" = "201" ] ||
  die "Producer create failed: HTTP $STATUS"

PRODUCER_CREDENTIAL="$(
  json_field     "$TMP_PREFIX.producer" \
    credential
)" || die "Producer credential missing."

RANGE_FROM="$(
  node -e '
    process.stdout.write(
      new Date(
        Date.now() - 120000,
      ).toISOString(),
    );
  '
)"

ALLOW_ID="$(uuid)"
CHANGE_ID="$(uuid)"

say "Emitting event that stays ALLOW"
emit_event "$ALLOW_ID" yes

say "Emitting event that proposed governance would quarantine"
emit_event "$CHANGE_ID" no

wait_complete   "$ALLOW_ID"   "$TMP_PREFIX.allow-before"
wait_complete   "$CHANGE_ID"   "$TMP_PREFIX.change-before"

BEFORE_DECISION="$(
  json_field     "$TMP_PREFIX.change-before" \
    decision.decisionId
)" || die "Before decision id missing."

node -e '
  const allow = JSON.parse(
    require("fs").readFileSync(
      process.argv[1],
      "utf8",
    ),
  );
  const change = JSON.parse(
    require("fs").readFileSync(
      process.argv[2],
      "utf8",
    ),
  );

  const ok =
    allow.decision?.outcome === "allow" &&
    change.decision?.outcome === "allow" &&
    (allow.deliveries || []).length === 0 &&
    (change.deliveries || []).length === 0;

  if (!ok) {
    console.error(
      JSON.stringify(
        { allow, change },
        null,
        2,
      ),
    );
    process.exit(1);
  }
'   "$TMP_PREFIX.allow-before"   "$TMP_PREFIX.change-before" ||
  die "Baseline governance events are incorrect."

RANGE_TO="$(
  node -e '
    process.stdout.write(
      new Date(
        Date.now() + 120000,
      ).toISOString(),
    );
  '
)"

MANIFEST="$(
  node -e '
    const [
      projectId,
      from,
      to,
    ] = process.argv.slice(1);

    process.stdout.write(
      JSON.stringify({
        apiVersion: "etlayer.dev/v1",
        kind: "ProjectGovernance",
        projectId,
        contracts: [{
          eventName: "account.created",
          currentVersion: 1,
          compatibilityMode:
            "backward",
          proposedContract: {
            id: "account.created@2",
            eventName:
              "account.created",
            version: 2,
            required: {
              "actor.anonymous.id": {
                type: "string",
              },
              "account.id": {
                type: "string",
              },
              "correlation.id": {
                type: "string",
              },
              "causation.id": {
                type: "string",
              },
              "plan.id": {
                type: "string",
              },
              "etlayer.producer.kind": {
                type: "string",
                const: "backend",
              },
              "etlayer.authority.kind": {
                type: "string",
                const:
                  "business_state",
              },
            },
            forbidden: [
              "experiment.variant",
              "experiment.id",
            ],
          },
          from,
          to,
          maxEvents: 500,
          maxExamples: 10,
        }],
      }),
    );
  ' "$PROJECT_ID" "$RANGE_FROM" "$RANGE_TO"
)"

say "Planning governance manifest"
STATUS="$(
  request_json \
    POST \
    "/_ops/plan/governance" \
    "$OPERATOR_KEY" \
    "$MANIFEST" \
    "$TMP_PREFIX.plan-1"
)"
[ "$STATUS" = "200" ] ||
  die "Governance plan failed: HTTP $STATUS"

say "Planning semantically identical governance manifest again"
MANIFEST_REORDERED="$(
  node -e '
    const value =
      JSON.parse(process.argv[1]);
    const change = value.contracts[0];

    process.stdout.write(
      JSON.stringify({
        contracts: [{
          to: change.to,
          proposedContract: {
            forbidden: [
              "experiment.id",
              "experiment.variant",
            ],
            required:
              change.proposedContract
                .required,
            version: 2,
            eventName:
              "account.created",
            id: "account.created@2",
          },
          currentVersion: 1,
          from: change.from,
          maxExamples: 10,
          maxEvents: 500,
          compatibilityMode:
            "backward",
          eventName:
            "account.created",
        }],
        projectId: value.projectId,
        kind: value.kind,
        apiVersion:
          value.apiVersion,
      }),
    );
  ' "$MANIFEST"
)"

STATUS="$(
  request_json \
    POST \
    "/_ops/plan/governance" \
    "$OPERATOR_KEY" \
    "$MANIFEST_REORDERED" \
    "$TMP_PREFIX.plan-2"
)"
[ "$STATUS" = "200" ] ||
  die "Second governance plan failed: HTTP $STATUS"

node -e '
  const first = JSON.parse(
    require("fs").readFileSync(
      process.argv[1],
      "utf8",
    ),
  );
  const second = JSON.parse(
    require("fs").readFileSync(
      process.argv[2],
      "utf8",
    ),
  );
  const affectedEventId =
    process.argv[3];

  const plan =
    first.contracts?.[0];

  const exact =
    /^[0-9a-f]{64}$/.test(
      first.manifestDigest || "",
    ) &&
    first.manifestDigest ===
      second.manifestDigest &&
    JSON.stringify(first) ===
      JSON.stringify(second) &&
    first.projectId ===
      process.argv[4] &&
    first.selected === 2 &&
    first.changed === 1 &&
    first.compatible === false &&
    plan?.transitions
      ?.allow_to_allow === 1 &&
    plan?.transitions
      ?.allow_to_quarantine === 1 &&
    plan?.compatibility
      ?.compatible === false &&
    plan?.examples?.length === 1 &&
    plan.examples[0]?.eventId ===
      affectedEventId;

  if (!exact) {
    console.error(
      JSON.stringify(
        { first, second },
        null,
        2,
      ),
    );
    process.exit(1);
  }
'   "$TMP_PREFIX.plan-1"   "$TMP_PREFIX.plan-2"   "$CHANGE_ID"   "$PROJECT_ID" ||
  die "Governance plan result is not deterministic."

MANIFEST_DIGEST="$(
  json_field     "$TMP_PREFIX.plan-1" \
    manifestDigest
)" || die "Manifest digest missing."

say "Proving governance planning is read-only"
inspect_event   "$CHANGE_ID"   "$TMP_PREFIX.change-after"

AFTER_DECISION="$(
  json_field     "$TMP_PREFIX.change-after" \
    decision.decisionId
)" || die "After decision id missing."

[ "$BEFORE_DECISION" = "$AFTER_DECISION" ] ||
  die "Governance planning mutated decision lineage."

node -e '
  const value = JSON.parse(
    require("fs").readFileSync(
      process.argv[1],
      "utf8",
    ),
  );

  const attempts =
    (value.deliveries || [])
      .flatMap(
        (delivery) =>
          delivery.attempts || [],
      );

  const ok =
    value.decision?.outcome === "allow" &&
    (value.deliveries || []).length === 0 &&
    attempts.length === 0;

  if (!ok) {
    console.error(
      JSON.stringify(value, null, 2),
    );
    process.exit(1);
  }
' "$TMP_PREFIX.change-after" ||
  die "Governance planning changed runtime state."

unset PRODUCER_CREDENTIAL
unset OPERATOR_KEY
unset MANAGEMENT_KEY

say "VS19 Governance-as-Code acceptance passed"
cat <<EOF
{
  "correlationId": "$RUN_ID",
  "projectId": "$PROJECT_ID",
  "manifestDigest": "$MANIFEST_DIGEST",
  "selected": 2,
  "changed": 1,
  "affectedEventId": "$CHANGE_ID",
  "decisionIdBefore": "$BEFORE_DECISION",
  "decisionIdAfter": "$AFTER_DECISION",
  "deterministicPlan": true,
  "decisionLineageMutated": false,
  "deliveryTriggered": false
}
EOF
