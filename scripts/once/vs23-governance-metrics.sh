#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INGEST_DIR="$ROOT_DIR/packages/cloudflare-ingest"
WRANGLER_ENV="${ETLAYER_WRANGLER_ENV:-ci}"
INGEST_URL="${ETLAYER_INGEST_URL:-https://etlayer-ingest-ci.sergii-ponomarov.workers.dev}"
RUN_ID="${RUN_ID:-vs23-$(date -u +%Y%m%d-%H%M%S)-$(openssl rand -hex 4)}"
PROJECT_ID="${VS23_PROJECT_ID:-$RUN_ID}"
TMP_PREFIX="/tmp/etlayer-vs23-$$"

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
  local include_account="$2"

  node --input-type=module -     "$INGEST_URL/v1/logs"     "$PRODUCER_CREDENTIAL"     "$event_id"     "$RUN_ID"     "$include_account" <<'NODE'
const [
  endpoint,
  credential,
  eventId,
  correlationId,
  includeAccount,
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
    "anon_vs23",
  ),
  stringAttribute(
    "correlation.id",
    correlationId,
  ),
  stringAttribute(
    "causation.id",
    "vs23-root",
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

if (includeAccount === "yes") {
  attributes.push(
    stringAttribute(
      "account.id",
      "account_" + eventId,
    ),
  );
}

const payload = {
  resourceLogs: [{
    resource: {
      attributes: [
        stringAttribute(
          "service.name",
          "etlayer-vs23-acceptance",
        ),
      ],
    },
    scopeLogs: [{
      scope: {
        name: "etlayer.vs23",
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

  request_json     POST     "/_ops/inspect"     "$OPERATOR_KEY"     "$(node -e '
      const [projectId, eventId] =
        process.argv.slice(1);
      process.stdout.write(
        JSON.stringify({
          projectId,
          eventId,
        }),
      );
    ' "$PROJECT_ID" "$event_id")"     "$output"
}

wait_complete() {
  local event_id="$1"
  local output="$2"

  for attempt in $(seq 1 45); do
    local status
    status="$(
      inspect_event         "$event_id"         "$output" || true
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

say "Rotating VS23 management credential"
put_secret ETLAYER_MANAGEMENT_KEY "$MANAGEMENT_KEY"

say "Deploying current VS23 Worker"
(
  cd "$INGEST_DIR"
  npx wrangler deploy --env "$WRANGLER_ENV"
)

say "Creating isolated project"
STATUS="$(
  request_json_after_deploy     POST     "/_mgmt/projects"     "$MANAGEMENT_KEY"     "$(node -e '
      process.stdout.write(
        JSON.stringify({
          id: process.argv[1],
        }),
      );
    ' "$PROJECT_ID")"     "$TMP_PREFIX.project"
)"
[ "$STATUS" = "201" ] ||
  die "Project create failed: HTTP $STATUS"

OPERATOR_KEY="$(
  json_field     "$TMP_PREFIX.project"     operatorCredential
)" || die "Operator credential missing."

say "Creating backend producer"
STATUS="$(
  request_json     POST     "/_mgmt/projects/$PROJECT_ID/producers"     "$OPERATOR_KEY"     '{"id":"backend-main","profileId":"backend"}'     "$TMP_PREFIX.producer"
)"
[ "$STATUS" = "201" ] ||
  die "Producer create failed: HTTP $STATUS"

PRODUCER_CREDENTIAL="$(
  json_field     "$TMP_PREFIX.producer"     credential
)" || die "Producer credential missing."

say "Configuring current ownership"
STATUS="$(
  request_json     PUT     "/_mgmt/projects/$PROJECT_ID/contracts/account.created/ownership"     "$OPERATOR_KEY"     '{
      "team":"accounts-platform",
      "domain":"accounts",
      "contacts":[
        {"kind":"email","value":"accounts@example.com"}
      ]
    }'     "$TMP_PREFIX.ownership"
)"
[ "$STATUS" = "200" ] ||
  die "Ownership configuration failed: HTTP $STATUS"

RANGE_FROM="$(
  node -e '
    process.stdout.write(
      new Date(
        Date.now() - 120000,
      ).toISOString(),
    );
  '
)"

VALID_EVENT_ID="$(uuid)"
QUARANTINED_EVENT_ID="$(uuid)"

say "Emitting one valid event"
emit_event "$VALID_EVENT_ID" yes

say "Emitting one quarantined event"
emit_event "$QUARANTINED_EVENT_ID" no

wait_complete   "$VALID_EVENT_ID"   "$TMP_PREFIX.valid-before"
wait_complete   "$QUARANTINED_EVENT_ID"   "$TMP_PREFIX.quarantine-before"

VALID_DECISION_ID="$(
  json_field     "$TMP_PREFIX.valid-before"     decision.decisionId
)" || die "Valid decision id missing."

QUARANTINED_DECISION_ID="$(
  json_field     "$TMP_PREFIX.quarantine-before"     decision.decisionId
)" || die "Quarantine decision id missing."

node -e '
  const valid = JSON.parse(
    require("fs").readFileSync(
      process.argv[1],
      "utf8",
    ),
  );
  const quarantined = JSON.parse(
    require("fs").readFileSync(
      process.argv[2],
      "utf8",
    ),
  );

  const missingAccount =
    quarantined.validation?.errors?.some(
      (error) =>
        error.code ===
          "required_attribute_missing" &&
        error.attribute === "account.id",
    );

  const ok =
    valid.validation?.status === "valid" &&
    valid.decision?.outcome === "allow" &&
    (valid.deliveries || []).length === 0 &&
    quarantined.validation?.status ===
      "quarantined" &&
    quarantined.decision?.outcome ===
      "quarantine" &&
    missingAccount === true &&
    (quarantined.deliveries || []).length === 0;

  if (!ok) {
    console.error(
      JSON.stringify(
        { valid, quarantined },
        null,
        2,
      ),
    );
    process.exit(1);
  }
'   "$TMP_PREFIX.valid-before"   "$TMP_PREFIX.quarantine-before" ||
  die "Baseline event evidence is incorrect."

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
                type: "string"
              },
              "account.id": {
                type: "string"
              },
              "correlation.id": {
                type: "string"
              },
              "causation.id": {
                type: "string"
              },
              "plan.id": {
                type: "string"
              },
              "etlayer.producer.kind": {
                type: "string",
                const: "backend"
              },
              "etlayer.authority.kind": {
                type: "string",
                const:
                  "business_state"
              }
            },
            forbidden: [
              "experiment.id",
              "experiment.variant"
            ]
          },
          from,
          to,
          maxEvents: 500,
          maxExamples: 10
        }]
      }),
    );
  ' "$PROJECT_ID" "$RANGE_FROM" "$RANGE_TO"
)"

say "Planning governance manifest"
STATUS="$(
  request_json     POST     "/_ops/plan/governance"     "$OPERATOR_KEY"     "$MANIFEST"     "$TMP_PREFIX.plan"
)"
[ "$STATUS" = "200" ] ||
  die "Governance plan failed: HTTP $STATUS"

MANIFEST_DIGEST="$(
  json_field     "$TMP_PREFIX.plan"     manifestDigest
)" || die "Manifest digest missing."

say "Publishing exact governance manifest"
STATUS="$(
  request_json     POST     "/_mgmt/projects/$PROJECT_ID/governance/publish"     "$OPERATOR_KEY"     "$(node -e '
      const [
        manifest,
        manifestDigest,
      ] = process.argv.slice(1);

      process.stdout.write(
        JSON.stringify({
          manifest:
            JSON.parse(manifest),
          manifestDigest,
          acknowledgeBreaking:
            true,
        }),
      );
    ' "$MANIFEST" "$MANIFEST_DIGEST")"     "$TMP_PREFIX.publish"
)"
[ "$STATUS" = "201" ] ||
  die "Governance publication failed: HTTP $STATUS"

say "Deprecating published v2 contract"
STATUS="$(
  request_json     POST     "/_mgmt/projects/$PROJECT_ID/contracts/account.created/2/deprecate"     "$OPERATOR_KEY"     '{}'     "$TMP_PREFIX.deprecate"
)"
[ "$STATUS" = "200" ] ||
  die "Contract deprecation failed: HTTP $STATUS"

node -e '
  const value = JSON.parse(
    require("fs").readFileSync(
      process.argv[1],
      "utf8",
    ),
  );

  if (
    value.changed !== true ||
    value.contract?.status !==
      "deprecated"
  ) {
    console.error(
      JSON.stringify(value, null, 2),
    );
    process.exit(1);
  }
' "$TMP_PREFIX.deprecate" ||
  die "Unexpected lifecycle state."

METRICS_INPUT="$(
  node -e '
    const [
      projectId,
      from,
      to,
    ] = process.argv.slice(1);

    process.stdout.write(
      JSON.stringify({
        projectId,
        from,
        to,
        maxEvents: 500,
      }),
    );
  ' "$PROJECT_ID" "$RANGE_FROM" "$RANGE_TO"
)"

say "Reading bounded governance metrics"
STATUS="$(
  request_json     POST     "/_ops/governance/metrics"     "$OPERATOR_KEY"     "$METRICS_INPUT"     "$TMP_PREFIX.metrics-1"
)"
[ "$STATUS" = "200" ] ||
  die "Governance metrics failed: HTTP $STATUS"

STATUS="$(
  request_json     POST     "/_ops/governance/metrics"     "$OPERATOR_KEY"     "$METRICS_INPUT"     "$TMP_PREFIX.metrics-2"
)"
[ "$STATUS" = "200" ] ||
  die "Second governance metrics read failed: HTTP $STATUS"

cmp -s   "$TMP_PREFIX.metrics-1"   "$TMP_PREFIX.metrics-2" ||
  die "Governance metrics are not deterministic for unchanged evidence."

node -e '
  const value = JSON.parse(
    require("fs").readFileSync(
      process.argv[1],
      "utf8",
    ),
  );

  const eventWindow =
    value.eventWindow;
  const governance =
    value.currentGovernance;

  const ok =
    value.version === 1 &&
    value.projectId ===
      process.argv[2] &&
    eventWindow?.selected === 2 &&
    eventWindow.validation?.valid === 1 &&
    eventWindow.validation
      ?.quarantined === 1 &&
    eventWindow.validation
      ?.validRate === 0.5 &&
    eventWindow.validation
      ?.quarantineRate === 0.5 &&
    eventWindow.decisions?.allow === 1 &&
    eventWindow.decisions
      ?.quarantine === 1 &&
    eventWindow.decisions
      ?.allowRate === 0.5 &&
    eventWindow.decisions
      ?.quarantineRate === 0.5 &&
    eventWindow.ownership?.owned === 2 &&
    eventWindow.ownership
      ?.unowned === 0 &&
    eventWindow.ownership
      ?.coverageRate === 1 &&
    eventWindow.ownership
      ?.teams?.length === 1 &&
    eventWindow.ownership
      ?.teams?.[0] ===
      "accounts-platform" &&
    eventWindow.delivery
      ?.summaries?.total === 0 &&
    eventWindow.delivery
      ?.summaries?.exportedRate === 0 &&
    eventWindow.delivery
      ?.attempts?.total === 0 &&
    eventWindow.delivery
      ?.attempts?.exportedRate === 0 &&
    governance?.ownership
      ?.resources === 1 &&
    governance?.ownership
      ?.teamCount === 1 &&
    governance?.lifecycle
      ?.total === 1 &&
    governance?.lifecycle
      ?.deprecated === 1 &&
    governance?.lifecycle
      ?.published === 0 &&
    governance?.lifecycle
      ?.retired === 0;

  if (!ok) {
    console.error(
      JSON.stringify(value, null, 2),
    );
    process.exit(1);
  }
'   "$TMP_PREFIX.metrics-1"   "$PROJECT_ID" ||
  die "Governance metrics aggregate is incorrect."

EMPTY_FROM="$(
  node -e '
    process.stdout.write(
      new Date(
        Date.now() + 24 * 60 * 60 * 1000,
      ).toISOString(),
    );
  '
)"
EMPTY_TO="$(
  node -e '
    process.stdout.write(
      new Date(
        Date.now() + 25 * 60 * 60 * 1000,
      ).toISOString(),
    );
  '
)"

say "Proving empty-window rates are finite zeros"
STATUS="$(
  request_json     POST     "/_ops/governance/metrics"     "$OPERATOR_KEY"     "$(node -e '
      const [
        projectId,
        from,
        to,
      ] = process.argv.slice(1);

      process.stdout.write(
        JSON.stringify({
          projectId,
          from,
          to,
          maxEvents: 10,
        }),
      );
    ' "$PROJECT_ID" "$EMPTY_FROM" "$EMPTY_TO")"     "$TMP_PREFIX.metrics-empty"
)"
[ "$STATUS" = "200" ] ||
  die "Empty governance metrics failed: HTTP $STATUS"

node -e '
  const value = JSON.parse(
    require("fs").readFileSync(
      process.argv[1],
      "utf8",
    ),
  );
  const w = value.eventWindow;

  const ok =
    w?.selected === 0 &&
    w.validation?.validRate === 0 &&
    w.validation?.quarantineRate === 0 &&
    w.decisions?.allowRate === 0 &&
    w.decisions?.blockRate === 0 &&
    w.decisions?.quarantineRate === 0 &&
    w.ownership?.coverageRate === 0 &&
    w.delivery?.summaries
      ?.exportedRate === 0 &&
    w.delivery?.attempts
      ?.exportedRate === 0;

  if (!ok) {
    console.error(
      JSON.stringify(value, null, 2),
    );
    process.exit(1);
  }
' "$TMP_PREFIX.metrics-empty" ||
  die "Empty governance metrics rates are incorrect."

say "Proving metrics did not mutate event evidence"
inspect_event   "$VALID_EVENT_ID"   "$TMP_PREFIX.valid-after"
inspect_event   "$QUARANTINED_EVENT_ID"   "$TMP_PREFIX.quarantine-after"

node -e '
  const valid = JSON.parse(
    require("fs").readFileSync(
      process.argv[1],
      "utf8",
    ),
  );
  const quarantined = JSON.parse(
    require("fs").readFileSync(
      process.argv[2],
      "utf8",
    ),
  );

  const ok =
    valid.decision?.decisionId ===
      process.argv[3] &&
    quarantined.decision?.decisionId ===
      process.argv[4] &&
    (valid.deliveries || []).length === 0 &&
    (quarantined.deliveries || []).length === 0;

  if (!ok) {
    console.error(
      JSON.stringify(
        { valid, quarantined },
        null,
        2,
      ),
    );
    process.exit(1);
  }
'   "$TMP_PREFIX.valid-after"   "$TMP_PREFIX.quarantine-after"   "$VALID_DECISION_ID"   "$QUARANTINED_DECISION_ID" ||
  die "Governance metrics mutated event evidence."

say "Proving cross-project metrics isolation"
OTHER_PROJECT="$PROJECT_ID-b"
STATUS="$(
  request_json     POST     "/_mgmt/projects"     "$MANAGEMENT_KEY"     "$(node -e '
      process.stdout.write(
        JSON.stringify({
          id: process.argv[1],
        }),
      );
    ' "$OTHER_PROJECT")"     "$TMP_PREFIX.other-project"
)"
[ "$STATUS" = "201" ] ||
  die "Second project create failed: HTTP $STATUS"

OTHER_OPERATOR="$(
  json_field     "$TMP_PREFIX.other-project"     operatorCredential
)" || die "Second operator credential missing."

STATUS="$(
  request_json     POST     "/_ops/governance/metrics"     "$OTHER_OPERATOR"     "$METRICS_INPUT"     "$TMP_PREFIX.cross-project"
)"
[ "$STATUS" = "401" ] ||
  die "Cross-project metrics query was not denied: HTTP $STATUS"

unset PRODUCER_CREDENTIAL
unset OPERATOR_KEY
unset OTHER_OPERATOR
unset MANAGEMENT_KEY

say "VS23 governance metrics acceptance passed"
cat <<EOF
{
  "correlationId": "$RUN_ID",
  "projectId": "$PROJECT_ID",
  "validEventId": "$VALID_EVENT_ID",
  "quarantinedEventId": "$QUARANTINED_EVENT_ID",
  "manifestDigest": "$MANIFEST_DIGEST",
  "selected": 2,
  "valid": 1,
  "quarantined": 1,
  "allow": 1,
  "quarantine": 1,
  "ownershipCoverageRate": 1,
  "deprecatedContracts": 1,
  "deliverySummaries": 0,
  "deliveryAttempts": 0,
  "deterministicRead": true,
  "emptyWindowRatesFinite": true,
  "eventEvidenceMutated": false,
  "crossProjectIsolation": true
}
EOF
