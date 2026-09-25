#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INGEST_DIR="$ROOT_DIR/packages/cloudflare-ingest"
WRANGLER_ENV="${ETLAYER_WRANGLER_ENV:-ci}"
INGEST_URL="${ETLAYER_INGEST_URL:-https://etlayer-ingest-ci.sergii-ponomarov.workers.dev}"
RUN_ID="${RUN_ID:-vs21-$(date -u +%Y%m%d-%H%M%S)-$(openssl rand -hex 4)}"
PROJECT_ID="${VS21_PROJECT_ID:-$RUN_ID}"
TMP_PREFIX="/tmp/etlayer-vs21-$$"

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

request_json_with_headers() {
  local method="$1"
  local path="$2"
  local token="$3"
  local body="$4"
  local output="$5"
  local headers="$6"

  curl --silent --show-error \
    -D "$headers" \
    -o "$output" \
    -w '%{http_code}' \
    -X "$method" "$INGEST_URL$path" \
    -H "authorization: Bearer $token" \
    -H "content-type: application/json" \
    --data "$body"
}

operation_id() {
  local headers="$1"

  awk '
    BEGIN { IGNORECASE = 1 }
    /^x-etlayer-operation-id:/ {
      sub(/^[^:]+:[[:space:]]*/, "");
      gsub(/\r/, "");
      print;
      exit;
    }
  ' "$headers"
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
    const path =
      process.argv[2].split(".");
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

emit_event() {
  local event_id="$1"
  local schema_version="$2"
  local include_plan="$3"

  node --input-type=module - \
    "$INGEST_URL/v1/logs" \
    "$PRODUCER_CREDENTIAL" \
    "$event_id" \
    "$RUN_ID" \
    "$schema_version" \
    "$include_plan" <<'NODE'
const [
  endpoint,
  credential,
  eventId,
  correlationId,
  schemaVersion,
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
  stringAttribute("etlayer.event.id", eventId),
  intAttribute(
    "etlayer.schema.version",
    Number(schemaVersion),
  ),
  stringAttribute(
    "actor.anonymous.id",
    "anon_vs21",
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
    "vs21-root",
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
    stringAttribute(
      "plan.id",
      "pro",
    ),
  );
}

const payload = {
  resourceLogs: [{
    resource: {
      attributes: [
        stringAttribute(
          "service.name",
          "etlayer-vs21-acceptance",
        ),
      ],
    },
    scopeLogs: [{
      scope: {
        name: "etlayer.vs21",
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

read_audit() {
  local operation="$1"
  local phase="$2"
  local output="$3"

  local key="registry/audit/$operation/$phase.json"

  local status
  status="$(
    request_json \
      POST \
      "/_mgmt/evidence" \
      "$MANAGEMENT_KEY" \
      "$(node -e '
        process.stdout.write(
          JSON.stringify({
            key: process.argv[1],
          }),
        );
      ' "$key")" \
      "$output"
  )"

  [ "$status" = "200" ] ||
    die "Audit evidence missing: $key HTTP $status"
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

say "Rotating VS21 management credential"
put_secret ETLAYER_MANAGEMENT_KEY "$MANAGEMENT_KEY"

say "Deploying current VS21 Worker"
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
  json_field \
    "$TMP_PREFIX.project" \
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
  json_field \
    "$TMP_PREFIX.producer" \
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

V1_EVENT_ID="$(uuid)"

say "Emitting current v1 ALLOW event"
emit_event "$V1_EVENT_ID" 1 no
wait_complete   "$V1_EVENT_ID"   "$TMP_PREFIX.v1-before"

V1_DECISION_BEFORE="$(
  json_field \
    "$TMP_PREFIX.v1-before" \
    decision.decisionId
)" || die "v1 decision id missing."

node -e '
  const value = JSON.parse(
    require("fs").readFileSync(
      process.argv[1],
      "utf8",
    ),
  );

  const ok =
    value.validation?.status === "valid" &&
    value.validation?.contractId ===
      "account.created@1" &&
    value.decision?.outcome === "allow";

  if (!ok) {
    console.error(
      JSON.stringify(value, null, 2),
    );
    process.exit(1);
  }
' "$TMP_PREFIX.v1-before" ||
  die "v1 baseline is incorrect."

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
              "experiment.id",
              "experiment.variant",
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

say "Planning exact governance manifest"
STATUS="$(
  request_json \
    POST \
    "/_ops/plan/governance" \
    "$OPERATOR_KEY" \
    "$MANIFEST" \
    "$TMP_PREFIX.plan"
)"
[ "$STATUS" = "200" ] ||
  die "Governance plan failed: HTTP $STATUS"

MANIFEST_DIGEST="$(
  json_field \
    "$TMP_PREFIX.plan" \
    manifestDigest
)" || die "Manifest digest missing."

node -e '
  const value = JSON.parse(
    require("fs").readFileSync(
      process.argv[1],
      "utf8",
    ),
  );

  const ok =
    value.compatible === false &&
    value.selected === 1 &&
    value.changed === 1 &&
    value.contracts?.[0]
      ?.transitions
      ?.allow_to_quarantine === 1;

  if (!ok) {
    console.error(
      JSON.stringify(value, null, 2),
    );
    process.exit(1);
  }
' "$TMP_PREFIX.plan" ||
  die "Unexpected VS21 governance plan."

say "Publishing exact planned manifest"
STATUS="$(
  request_json_with_headers \
    POST \
    "/_mgmt/projects/$PROJECT_ID/governance/publish" \
    "$OPERATOR_KEY" \
    "$(node -e '
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
    ' "$MANIFEST" "$MANIFEST_DIGEST")" \
    "$TMP_PREFIX.publish" \
    "$TMP_PREFIX.publish.headers"
)"
[ "$STATUS" = "201" ] ||
  die "Governance publication failed: HTTP $STATUS"

PUBLISH_OPERATION="$(
  operation_id     "$TMP_PREFIX.publish.headers"
)"
[ -n "$PUBLISH_OPERATION" ] ||
  die "Governance publication operation id missing."

node -e '
  const value = JSON.parse(
    require("fs").readFileSync(
      process.argv[1],
      "utf8",
    ),
  );

  const ok =
    value.created === true &&
    value.publication
      ?.manifestDigest ===
      process.argv[2] &&
    value.publication
      ?.compatible === false &&
    value.publication
      ?.contracts?.[0]
      ?.contractId ===
      "account.created@2";

  if (!ok) {
    console.error(
      JSON.stringify(value, null, 2),
    );
    process.exit(1);
  }
'   "$TMP_PREFIX.publish"   "$MANIFEST_DIGEST" ||
  die "Unexpected governance publication response."

say "Proving publication audit evidence"
read_audit   "$PUBLISH_OPERATION"   requested   "$TMP_PREFIX.audit-requested"
read_audit   "$PUBLISH_OPERATION"   applied   "$TMP_PREFIX.audit-applied"

node -e '
  const requested = JSON.parse(
    require("fs").readFileSync(
      process.argv[1],
      "utf8",
    ),
  );
  const applied = JSON.parse(
    require("fs").readFileSync(
      process.argv[2],
      "utf8",
    ),
  );

  const ok =
    requested.action ===
      "governance.publish" &&
    requested.actor?.kind ===
      "project_operator" &&
    requested.target
      ?.projectId ===
      process.argv[3] &&
    requested.target
      ?.manifestDigest ===
      process.argv[4] &&
    applied.phase === "applied";

  if (!ok) {
    console.error(
      JSON.stringify(
        { requested, applied },
        null,
        2,
      ),
    );
    process.exit(1);
  }
'   "$TMP_PREFIX.audit-requested"   "$TMP_PREFIX.audit-applied"   "$PROJECT_ID"   "$MANIFEST_DIGEST" ||
  die "Governance publication audit evidence is incorrect."


PUBLISHED_EVENT_ID="$(uuid)"

say "Emitting v2 event under Published lifecycle"
emit_event "$PUBLISHED_EVENT_ID" 2 yes
wait_complete   "$PUBLISHED_EVENT_ID"   "$TMP_PREFIX.v2-published"

node -e '
  const value = JSON.parse(
    require("fs").readFileSync(
      process.argv[1],
      "utf8",
    ),
  );

  const ok =
    value.validation?.status === "valid" &&
    value.validation?.contractId ===
      "account.created@2" &&
    value.validation?.contractStatus ===
      "published" &&
    value.decision?.outcome === "allow";

  if (!ok) {
    console.error(
      JSON.stringify(value, null, 2),
    );
    process.exit(1);
  }
' "$TMP_PREFIX.v2-published" ||
  die "Published contract lifecycle was not enforced."

say "Deprecating account.created@2"
STATUS="$(
  request_json_with_headers     POST     "/_mgmt/projects/$PROJECT_ID/contracts/account.created/2/deprecate"     "$OPERATOR_KEY"     '{}'     "$TMP_PREFIX.deprecate"     "$TMP_PREFIX.deprecate.headers"
)"
[ "$STATUS" = "200" ] ||
  die "Contract deprecation failed: HTTP $STATUS"

DEPRECATE_OPERATION="$(
  operation_id     "$TMP_PREFIX.deprecate.headers"
)"
[ -n "$DEPRECATE_OPERATION" ] ||
  die "Deprecation operation id missing."

node -e '
  const value = JSON.parse(
    require("fs").readFileSync(
      process.argv[1],
      "utf8",
    ),
  );

  if (
    value.changed !== true ||
    value.contract?.status !== "deprecated"
  ) {
    console.error(
      JSON.stringify(value, null, 2),
    );
    process.exit(1);
  }
' "$TMP_PREFIX.deprecate" ||
  die "Unexpected deprecation response."

read_audit   "$DEPRECATE_OPERATION"   requested   "$TMP_PREFIX.deprecate-audit"

node -e '
  const value = JSON.parse(
    require("fs").readFileSync(
      process.argv[1],
      "utf8",
    ),
  );

  const ok =
    value.action === "contract.deprecate" &&
    value.actor?.kind ===
      "project_operator" &&
    value.target?.projectId ===
      process.argv[2] &&
    value.target?.contractId ===
      "account.created@2";

  if (!ok) {
    console.error(
      JSON.stringify(value, null, 2),
    );
    process.exit(1);
  }
'   "$TMP_PREFIX.deprecate-audit"   "$PROJECT_ID" ||
  die "Deprecation audit evidence is incorrect."

DEPRECATED_EVENT_ID="$(uuid)"

say "Emitting v2 event under Deprecated lifecycle"
emit_event "$DEPRECATED_EVENT_ID" 2 yes
wait_complete   "$DEPRECATED_EVENT_ID"   "$TMP_PREFIX.v2-deprecated"

node -e '
  const value = JSON.parse(
    require("fs").readFileSync(
      process.argv[1],
      "utf8",
    ),
  );

  const ok =
    value.validation?.status === "valid" &&
    value.validation?.contractId ===
      "account.created@2" &&
    value.validation?.contractStatus ===
      "deprecated" &&
    value.validation
      ?.governanceManifestDigest ===
      process.argv[2] &&
    value.decision?.outcome === "allow";

  if (!ok) {
    console.error(
      JSON.stringify(value, null, 2),
    );
    process.exit(1);
  }
'   "$TMP_PREFIX.v2-deprecated"   "$MANIFEST_DIGEST" ||
  die "Deprecated contract did not remain valid and inspectable."

say "Retiring account.created@2"
STATUS="$(
  request_json_with_headers     POST     "/_mgmt/projects/$PROJECT_ID/contracts/account.created/2/retire"     "$OPERATOR_KEY"     '{}'     "$TMP_PREFIX.retire"     "$TMP_PREFIX.retire.headers"
)"
[ "$STATUS" = "200" ] ||
  die "Contract retirement failed: HTTP $STATUS"

RETIRE_OPERATION="$(
  operation_id     "$TMP_PREFIX.retire.headers"
)"
[ -n "$RETIRE_OPERATION" ] ||
  die "Retirement operation id missing."

node -e '
  const value = JSON.parse(
    require("fs").readFileSync(
      process.argv[1],
      "utf8",
    ),
  );

  if (
    value.changed !== true ||
    value.contract?.status !== "retired"
  ) {
    console.error(
      JSON.stringify(value, null, 2),
    );
    process.exit(1);
  }
' "$TMP_PREFIX.retire" ||
  die "Unexpected retirement response."

read_audit   "$RETIRE_OPERATION"   requested   "$TMP_PREFIX.retire-audit"

node -e '
  const value = JSON.parse(
    require("fs").readFileSync(
      process.argv[1],
      "utf8",
    ),
  );

  if (
    value.action !== "contract.retire" ||
    value.target?.contractId !==
      "account.created@2"
  ) {
    console.error(
      JSON.stringify(value, null, 2),
    );
    process.exit(1);
  }
' "$TMP_PREFIX.retire-audit" ||
  die "Retirement audit evidence is incorrect."

RETIRED_EVENT_ID="$(uuid)"

say "Emitting otherwise-valid v2 event under Retired lifecycle"
emit_event "$RETIRED_EVENT_ID" 2 yes
wait_complete   "$RETIRED_EVENT_ID"   "$TMP_PREFIX.v2-retired"

node -e '
  const value = JSON.parse(
    require("fs").readFileSync(
      process.argv[1],
      "utf8",
    ),
  );

  const retired =
    value.validation?.errors?.some(
      (error) =>
        error.code ===
          "contract_retired",
    );

  const ok =
    value.validation?.status ===
      "quarantined" &&
    value.validation?.contractId ===
      "account.created@2" &&
    value.validation?.contractStatus ===
      "retired" &&
    retired === true &&
    value.decision?.outcome ===
      "quarantine" &&
    (value.deliveries || []).length === 0;

  if (!ok) {
    console.error(
      JSON.stringify(value, null, 2),
    );
    process.exit(1);
  }
' "$TMP_PREFIX.v2-retired" ||
  die "Retired contract was not quarantined."

say "Proving Retired cannot resurrect to Deprecated"
STATUS="$(
  request_json     POST     "/_mgmt/projects/$PROJECT_ID/contracts/account.created/2/deprecate"     "$OPERATOR_KEY"     '{}'     "$TMP_PREFIX.resurrection"
)"
[ "$STATUS" = "409" ] ||
  die "Retired contract resurrection was not rejected: HTTP $STATUS"

say "Proving repeated retirement is idempotent"
STATUS="$(
  request_json     POST     "/_mgmt/projects/$PROJECT_ID/contracts/account.created/2/retire"     "$OPERATOR_KEY"     '{}'     "$TMP_PREFIX.retire-repeat"
)"
[ "$STATUS" = "200" ] ||
  die "Repeated retirement failed: HTTP $STATUS"

node -e '
  const value = JSON.parse(
    require("fs").readFileSync(
      process.argv[1],
      "utf8",
    ),
  );

  if (
    value.changed !== false ||
    value.contract?.status !== "retired"
  ) {
    console.error(
      JSON.stringify(value, null, 2),
    );
    process.exit(1);
  }
' "$TMP_PREFIX.retire-repeat" ||
  die "Repeated retirement was not idempotent."

say "Proving lifecycle changes did not rewrite historical v1 decision"
inspect_event   "$V1_EVENT_ID"   "$TMP_PREFIX.v1-after"

V1_DECISION_AFTER="$(
  json_field     "$TMP_PREFIX.v1-after"     decision.decisionId
)" || die "v1 decision id after lifecycle changes missing."

[ "$V1_DECISION_BEFORE" = "$V1_DECISION_AFTER" ] ||
  die "Contract lifecycle rewrote historical decision lineage."

unset PRODUCER_CREDENTIAL
unset OPERATOR_KEY
unset MANAGEMENT_KEY

say "VS21 contract lifecycle acceptance passed"
cat <<EOF
{
  "correlationId": "$RUN_ID",
  "projectId": "$PROJECT_ID",
  "manifestDigest": "$MANIFEST_DIGEST",
  "publicationOperationId": "$PUBLISH_OPERATION",
  "deprecateOperationId": "$DEPRECATE_OPERATION",
  "retireOperationId": "$RETIRE_OPERATION",
  "publishedEventId": "$PUBLISHED_EVENT_ID",
  "deprecatedEventId": "$DEPRECATED_EVENT_ID",
  "retiredEventId": "$RETIRED_EVENT_ID",
  "deprecatedStillAllowed": true,
  "retiredQuarantined": true,
  "resurrectionRejected": true,
  "idempotentRetire": true,
  "historicalDecisionLineageMutated": false
}
EOF
